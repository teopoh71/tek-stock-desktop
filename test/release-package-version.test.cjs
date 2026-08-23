"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");
const {
  verifyPackagedArchive,
  verifyRuntimeConfigTemplate,
  verifySourceCloudConfig,
  verifySourceVersion,
} = require("../build/verify-packaged-version.cjs");

const root = path.resolve(__dirname, "..");

test("source badge and runtime version match package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(verifySourceVersion(root), pkg.version);
  assert.equal(pkg.build.afterPack, "./build/verify-packaged-version.cjs");
});

test("packaged file allowlist includes central sync runtime modules", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const packagedFiles = new Set(pkg.build.files.filter((entry) => typeof entry === "string"));
  for (const file of [
    "alibaba-config.cjs", "api-failover.cjs", "central-sync.cjs", "excel-live.cjs",
    "sync-outbox.cjs", "workbook-fingerprint.cjs", "workbook-location.cjs",
    "workbook-identity-migration.cjs", "workbook-migration-transaction.cjs",
    "private-workbook-bootstrap.cjs", "private-workbook-bootstrap-main.cjs",
    "packaged-smoke-runtime.cjs",
  ]) assert.equal(packagedFiles.has(file), true, `${file} must be packaged`);
});

test("Windows 7 build uses the last supported Electron major and compatible Sharp runtime", () => {
  const config = require("../build/electron-builder.win7.cjs");
  assert.equal(config.electronVersion, "22.3.27");
  assert.match(config.msi.artifactName, /Windows7/);
  assert.equal(config.files.includes("!node_modules/sharp/**/*"), true);
  assert.equal(config.files.includes("!node_modules/sharp-win7/**/*"), false);
});

test("release preflight accepts template-only runtime cloud configuration", () => {
  assert.doesNotThrow(() => verifyRuntimeConfigTemplate(root));
  assert.equal(verifySourceCloudConfig(root), null);
});

async function minimalArchive(directory, options = {}) {
  const appDirectory = path.join(directory, `app-${Math.random().toString(16).slice(2)}`);
  const inventoryDirectory = path.join(appDirectory, "inventory");
  fs.mkdirSync(inventoryDirectory, { recursive: true });
  fs.writeFileSync(path.join(appDirectory, "package.json"),
    JSON.stringify({ name: "tek-stock-test", version: options.version || "1.6.7" }));
  fs.writeFileSync(path.join(inventoryDirectory, "index.html"),
    options.html || '<span>App v1.6.07</span><script>appVersion: "1.6.07"</script>');
  fs.writeFileSync(path.join(inventoryDirectory, "alibaba-cloud.example.json"), JSON.stringify({
    apiBaseUrl: "https://inventory-api.example.com",
    apiFallbackBaseUrls: [],
    authorityId: "runtime-authority",
    ossPublicBaseUrl: "https://assets.example.com",
  }));
  for (const file of [
    "alibaba-config.cjs", "api-failover.cjs", "central-sync.cjs", "excel-live.cjs",
    "sync-outbox.cjs", "workbook-fingerprint.cjs", "workbook-location.cjs",
    "private-workbook-bootstrap.cjs", "private-workbook-bootstrap-main.cjs",
    "workbook-identity-migration.cjs", "workbook-migration-transaction.cjs",
    "packaged-smoke-runtime.cjs", "inventory/conflict-resolution.js",
  ]) {
    const target = path.join(appDirectory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '"use strict";\n');
  }
  const archive = path.join(directory, `${Math.random().toString(16).slice(2)}.asar`);
  await asar.createPackage(appDirectory, archive);
  return { appDirectory, inventoryDirectory, archive };
}

test("packaged app.asar accepts template-only config and rejects stale embedded version", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-version-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const good = await minimalArchive(directory);
  assert.equal(verifyPackagedArchive(good.archive, "1.6.7"), "1.6.7");

  const stale = await minimalArchive(directory, {
    html: '<span>App v1.6.06</span><script>appVersion: "1.6.06"</script>',
  });
  assert.throws(
    () => verifyPackagedArchive(stale.archive, "1.6.7"),
    /badge must match package version 1\.6\.07/,
  );
});

test("desktop main process does not eagerly load ExcelJS or JSZip", () => {
  const mainSource = fs.readFileSync(path.join(root, "main.cjs"), "utf8");
  const electronRequire = mainSource.indexOf('require("electron")');
  const excelRequire = mainSource.indexOf('require("exceljs")');
  const workbookFactory = mainSource.indexOf("function createExcelWorkbook");
  assert.ok(electronRequire >= 0);
  assert.ok(workbookFactory > electronRequire);
  assert.ok(excelRequire > workbookFactory);
});

test("packaged smoke paints the settled renderer before capturing evidence", () => {
  const source = fs.readFileSync(path.join(root, "packaged-smoke-runtime.cjs"), "utf8");
  const show = source.indexOf("window.showInactive()");
  const capture = source.indexOf("window.webContents.capturePage()");
  const hide = source.indexOf("window.hide()", capture);
  assert.ok(show >= 0);
  assert.ok(capture > show);
  assert.ok(hide > capture);
});

test("runtime package audit accepts no embedded production config but rejects an injected secret", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-cloud-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clean = await minimalArchive(directory);
  assert.doesNotThrow(() => verifyPackagedArchive(clean.archive, "1.6.7"));

  fs.writeFileSync(path.join(clean.inventoryDirectory, "alibaba-cloud.json"), JSON.stringify({
    apiBaseUrl: "https://runtime-api.tek-stock.dev",
    ossPublicBaseUrl: "https://runtime-assets.tek-stock.dev",
    uploadToken: "must-not-ship",
  }));
  const secretArchive = path.join(directory, "secret.asar");
  await asar.createPackage(clean.appDirectory, secretArchive);
  assert.throws(() => verifyPackagedArchive(secretArchive, "1.6.7"), /unexpected field.*uploadToken/);
});
