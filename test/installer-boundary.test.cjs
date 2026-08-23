"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");

const config = require("../build/electron-builder.update.cjs");
const packageJson = require("../package.json");
const {
  forbiddenPackagedStateReason,
  verifyPackagedArchive,
} = require("../build/verify-packaged-version.cjs");

const REQUIRED_RUNTIME = [
  "workbook-location.cjs",
  "private-workbook-bootstrap.cjs",
  "private-workbook-bootstrap-main.cjs",
  "packaged-smoke-runtime.cjs",
  "central-sync.cjs",
  "sync-outbox.cjs",
  "workbook-fingerprint.cjs",
  "workbook-identity-migration.cjs",
  "workbook-migration-transaction.cjs",
  "cloud-reset-local.cjs",
  "workbook-operation-gate.cjs",
  "inventory/conflict-resolution.js",
];

const REQUIRED_EXCLUSIONS = [
  "!test/**/*",
  "!**/*.xlsx",
  "!**/backups/**/*",
  "!**/workbook-client.json",
  "!**/sync-credentials.json",
  "!**/outbox.json",
  "!**/photo-cache/**/*",
];

function writeValidArchiveFixture(t, extraFiles) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-installer-boundary-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appDirectory = path.join(directory, "app");
  fs.mkdirSync(path.join(appDirectory, "inventory"), { recursive: true });
  fs.writeFileSync(path.join(appDirectory, "package.json"), JSON.stringify({
    name: "tek-stock-package-fixture",
    version: "1.5.61",
  }));
  fs.writeFileSync(path.join(appDirectory, "inventory", "index.html"),
    '<span>App v1.5.61</span><script>appVersion: "1.5.61"</script>');
  fs.writeFileSync(path.join(appDirectory, "inventory", "alibaba-cloud.json"), JSON.stringify({
    apiBaseUrl: "https://stock-api.aliyuncs.com",
    ossPublicBaseUrl: "https://tek-stock-photos.oss-cn-hangzhou.aliyuncs.com",
  }));
  for (const runtimeFile of REQUIRED_RUNTIME) {
    const target = path.join(appDirectory, ...runtimeFile.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '"use strict";\n');
  }
  for (const runtimeFile of ["alibaba-config.cjs", "api-failover.cjs", "excel-live.cjs",
    "main.cjs", "preload.cjs"]) {
    fs.writeFileSync(path.join(appDirectory, runtimeFile), '"use strict";\n');
  }
  for (const extraFile of extraFiles) {
    const target = path.join(appDirectory, ...extraFile.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "must not ship");
  }
  const archive = path.join(directory, "app.asar");
  return asar.createPackage(appDirectory, archive).then(() => archive);
}

test("Update installer allowlist includes concurrent workbook runtime and explicit state exclusions", () => {
  const files = new Set(config.files.filter((entry) => typeof entry === "string"));
  for (const runtimeFile of REQUIRED_RUNTIME) {
    assert.equal(files.has(runtimeFile) || files.has("inventory/**/*"), true,
      `missing packaged runtime: ${runtimeFile}`);
  }
  for (const exclusion of REQUIRED_EXCLUSIONS) {
    assert.equal(files.has(exclusion), true, `missing package exclusion: ${exclusion}`);
  }
});

test("local Update build explicitly disables publishing", () => {
  assert.match(packageJson.scripts["dist:update"], /--publish\s+never(?:\s|$)/);
});

const FORBIDDEN_FILES = [
  "TEK-STOCK-LIVE.xlsx",
  "backups/TEK-STOCK-LIVE.backup.xlsx",
  "workbook-client.json",
  "sync-credentials.json",
  "central-sync/outbox.json",
  "central-sync/photo-cache/item-a/photo.webp",
  "test/update-boundary.test.cjs",
];

test("packaged state classifier covers workbooks, backups, identity, credentials, outbox, cache, and tests", () => {
  for (const forbiddenFile of FORBIDDEN_FILES) {
    assert.match(forbiddenPackagedStateReason(forbiddenFile), /\S/,
      `path must be forbidden: ${forbiddenFile}`);
  }
  assert.equal(forbiddenPackagedStateReason("inventory/conflict-resolution.js"), "");
});

test("packaged archive audit rejects forbidden private state", async (t) => {
  const archive = await writeValidArchiveFixture(t, FORBIDDEN_FILES);
  assert.throws(() => verifyPackagedArchive(archive, "1.5.61"), /forbidden packaged state/i);
});
