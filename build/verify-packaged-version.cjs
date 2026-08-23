"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const asar = require("@electron/asar");
const { validateAlibabaCloudConfig } = require("../alibaba-config.cjs");
const { createHash } = require("node:crypto");

const REQUIRED_CONCURRENT_RUNTIME = [
  "alibaba-config.cjs",
  "api-failover.cjs",
  "central-sync.cjs",
  "excel-live.cjs",
  "sync-outbox.cjs",
  "workbook-fingerprint.cjs",
  "workbook-location.cjs",
  "workbook-identity-migration.cjs",
  "workbook-migration-transaction.cjs",
  "private-workbook-bootstrap.cjs",
  "private-workbook-bootstrap-main.cjs",
  "packaged-smoke-runtime.cjs",
  "inventory/conflict-resolution.js",
];

const SAFETY_CRITICAL_RUNTIME = [
  "main.cjs",
  "preload.cjs",
  "central-sync.cjs",
  "workbook-identity-migration.cjs",
  "workbook-migration-transaction.cjs",
  "packaged-smoke-runtime.cjs",
  "inventory/excel-delta-core.js",
  "inventory/excel-sync-core.js",
];

function normalizeArchivePath(value) {
  return String(value || "").replace(/^[/\\]+/, "").replace(/\\/g, "/");
}

function forbiddenPackagedStateReason(value) {
  const archivePath = normalizeArchivePath(value);
  const lower = archivePath.toLowerCase();
  const segments = lower.split("/");
  const basename = segments.at(-1) || "";
  if (segments.some((segment) => ["test", "tests", "__tests__"].includes(segment))) return "test file";
  if (/\.(xlsx|xlsm|xls)$/i.test(basename)) return "workbook";
  if (segments.includes("backups") || /\.(bak|backup)(\.|$)/i.test(basename)) return "backup";
  if (basename === "workbook-client.json") return "client identity";
  if (/credential.*\.json$/i.test(basename)) return "credentials";
  if (/token.*\.json$/i.test(basename) || /.*token.*\.json$/i.test(basename)) return "token";
  if (/^outbox(?:[.-].*)?\.json$/i.test(basename)) return "outbox";
  if (segments.includes("photo-cache")) return "photo cache";
  if (/^\.env(?:\.|$)/i.test(basename)) return "environment credentials";
  if (/\.(pem|key|pfx|p12)$/i.test(basename)) return "private key";
  return "";
}

function versionPattern(version) {
  return String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function displayVersion(version) {
  const [major, minor, patch] = String(version).split(".");
  return `${major}.${minor}.${String(Number(patch)).padStart(2, "0")}`;
}

function verifyHtmlVersion(html, expectedVersion, source) {
  const shownVersion = displayVersion(expectedVersion);
  const escaped = versionPattern(shownVersion);
  assert.match(
    html,
    new RegExp(`<span>App v${escaped}</span>`),
    `${source} badge must match package version ${shownVersion}`,
  );
  assert.match(
    html,
    new RegExp(`appVersion:\\s*"${escaped}"`),
    `${source} runtime version must match package version ${shownVersion}`,
  );
}

function verifySourceVersion(projectDir) {
  const packageFile = path.join(projectDir, "package.json");
  const htmlFile = path.join(projectDir, "inventory", "index.html");
  const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const expectedVersion = String(packageJson.version || "");
  assert.match(expectedVersion, /^\d+\.\d+\.\d+$/, "package version must be semantic");
  verifyHtmlVersion(fs.readFileSync(htmlFile, "utf8"), expectedVersion, "inventory/index.html");
  return expectedVersion;
}

function verifyRuntimeConfigTemplate(projectDir) {
  const templateFile = path.join(projectDir, "inventory", "alibaba-cloud.example.json");
  assert.ok(fs.existsSync(templateFile), "runtime cloud configuration template is missing");
  const template = JSON.parse(fs.readFileSync(templateFile, "utf8"));
  const allowed = new Set(["apiBaseUrl", "apiFallbackBaseUrls", "authorityId", "ossPublicBaseUrl"]);
  const unexpected = Object.keys(template).filter((key) => !allowed.has(key));
  assert.deepEqual(unexpected, [], `runtime config template has unexpected fields: ${unexpected.join(", ")}`);
  for (const key of ["apiBaseUrl", "ossPublicBaseUrl"]) {
    assert.equal(typeof template[key], "string", `runtime config template must contain ${key}`);
  }
  return template;
}

function verifySourceCloudConfig(projectDir) {
  verifyRuntimeConfigTemplate(projectDir);
  const configFile = path.join(projectDir, "inventory", "alibaba-cloud.json");
  if (!fs.existsSync(configFile)) return null;
  return validateAlibabaCloudConfig(JSON.parse(fs.readFileSync(configFile, "utf8")));
}

function verifyPackagedArchive(archiveFile, expectedVersion, projectDir = "") {
  assert.ok(fs.existsSync(archiveFile), `packaged app archive is missing: ${archiveFile}`);
  const packagedFiles = new Set(asar.listPackage(archiveFile).map((name) => normalizeArchivePath(name)));
  for (const runtimeFile of REQUIRED_CONCURRENT_RUNTIME) {
    assert.ok(packagedFiles.has(runtimeFile), `packaged app archive is missing concurrent runtime module: ${runtimeFile}`);
  }
  const forbidden = [...packagedFiles]
    .map((archivePath) => ({ archivePath, reason: forbiddenPackagedStateReason(archivePath) }))
    .filter((entry) => entry.reason);
  assert.deepEqual(
    forbidden,
    [],
    `forbidden packaged state: ${forbidden.map((entry) => `${entry.reason} (${entry.archivePath})`).join(", ")}`,
  );
  const packageJson = JSON.parse(asar.extractFile(archiveFile, "package.json").toString("utf8"));
  assert.equal(packageJson.version, expectedVersion, `packaged app.asar version ${packageJson.version} does not match ${expectedVersion}`);
  const html = asar.extractFile(archiveFile, "inventory/index.html").toString("utf8");
  verifyHtmlVersion(html, expectedVersion, "packaged inventory/index.html");

  // Production Cloudflare endpoints and credentials are runtime configuration,
  // not source artifacts. A release may omit the legacy-named packaged config.
  // If a deployment pipeline injects one, it is still strictly validated.
  if (packagedFiles.has("inventory/alibaba-cloud.json")) {
    const cloudConfig = JSON.parse(asar.extractFile(archiveFile, "inventory/alibaba-cloud.json").toString("utf8"));
    validateAlibabaCloudConfig(cloudConfig);
  }
  assert.ok(
    packagedFiles.has("inventory/alibaba-cloud.example.json"),
    "packaged app archive is missing the runtime cloud configuration template",
  );

  if (projectDir) {
    for (const runtimeFile of SAFETY_CRITICAL_RUNTIME) {
      const sourceFile = path.join(projectDir, ...runtimeFile.split("/"));
      assert.ok(fs.existsSync(sourceFile), `safety-critical source file is missing: ${runtimeFile}`);
      const packaged = asar.extractFile(archiveFile, runtimeFile.replace(/\//g, path.sep));
      const source = fs.readFileSync(sourceFile);
      assert.equal(
        createHash("sha256").update(packaged).digest("hex"),
        createHash("sha256").update(source).digest("hex"),
        `packaged safety core differs from tested source: ${runtimeFile}`,
      );
    }
  }
  for (const runtimeFile of ["main.cjs", "preload.cjs", "node_modules/jszip/lib/external.js"]) {
    if (!packagedFiles.has(runtimeFile)) continue;
    const source = asar.extractFile(archiveFile, runtimeFile.replace(/\//g, path.sep)).toString("utf8");
    assert.doesNotThrow(() => new vm.Script(source, { filename: runtimeFile }), `packaged JavaScript is corrupt or invalid: ${runtimeFile}`);
  }
  return expectedVersion;
}

async function verifyAfterPack(context) {
  const projectDir = context?.packager?.projectDir || path.resolve(__dirname, "..");
  const expectedVersion = String(context?.packager?.appInfo?.version || verifySourceVersion(projectDir));
  assert.equal(verifySourceVersion(projectDir), expectedVersion);
  verifySourceCloudConfig(projectDir);
  verifyPackagedArchive(path.join(context.appOutDir, "resources", "app.asar"), expectedVersion, projectDir);
  console.log(`Verified packaged TEK STOCK app.asar version ${expectedVersion}.`);
}

module.exports = verifyAfterPack;
module.exports.verifyHtmlVersion = verifyHtmlVersion;
module.exports.forbiddenPackagedStateReason = forbiddenPackagedStateReason;
module.exports.verifySourceVersion = verifySourceVersion;
module.exports.verifyRuntimeConfigTemplate = verifyRuntimeConfigTemplate;
module.exports.verifySourceCloudConfig = verifySourceCloudConfig;
module.exports.verifyPackagedArchive = verifyPackagedArchive;

if (require.main === module) {
  const projectDir = path.resolve(__dirname, "..");
  const version = verifySourceVersion(projectDir);
  const runtimeConfig = verifySourceCloudConfig(projectDir);
  console.log(`Verified TEK STOCK source version ${version} and ${runtimeConfig ? "injected" : "template-only"} runtime cloud configuration.`);
}
