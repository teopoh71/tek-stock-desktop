"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");
const {
  verifyPackagedArchive,
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
  assert.equal(packagedFiles.has("alibaba-config.cjs"), true);
  assert.equal(packagedFiles.has("api-failover.cjs"), true);
  assert.equal(packagedFiles.has("central-sync.cjs"), true);
  assert.equal(packagedFiles.has("excel-live.cjs"), true);
  assert.equal(packagedFiles.has("sync-outbox.cjs"), true);
  assert.equal(packagedFiles.has("workbook-fingerprint.cjs"), true);
  assert.equal(packagedFiles.has("workbook-location.cjs"), true);
  assert.equal(packagedFiles.has("workbook-identity-migration.cjs"), true);
  assert.equal(packagedFiles.has("workbook-migration-transaction.cjs"), true);
  assert.equal(packagedFiles.has("private-workbook-bootstrap.cjs"), true);
  assert.equal(packagedFiles.has("private-workbook-bootstrap-main.cjs"), true);
  assert.equal(packagedFiles.has("packaged-smoke-runtime.cjs"), true);
});

test("Windows 7 build uses the last supported Electron major and the compatible Sharp runtime", () => {
  const config = require("../build/electron-builder.win7.cjs");
  assert.equal(config.electronVersion, "22.3.27");
  assert.match(config.msi.artifactName, /Windows7/);
  assert.equal(config.files.includes("!node_modules/sharp/**/*"), true);
  assert.equal(config.files.includes("!node_modules/sharp-win7/**/*"), false);
});

test("release preflight accepts the checked-in actual Alibaba endpoints", () => {
  assert.doesNotThrow(() => verifySourceCloudConfig(root));
});

test("packaged app.asar verification rejects a stale embedded app", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-version-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appDirectory = path.join(directory, "app");
  const inventoryDirectory = path.join(appDirectory, "inventory");
  fs.mkdirSync(inventoryDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(appDirectory, "package.json"),
    JSON.stringify({ name: "tek-stock-test", version: "1.5.33" }),
  );
  fs.writeFileSync(
    path.join(inventoryDirectory, "index.html"),
    '<span>App v1.5.33</span><script>appVersion: "1.5.33"</script>',
  );
  fs.writeFileSync(path.join(appDirectory, "api-failover.cjs"), '"use strict";\n');
  fs.writeFileSync(path.join(appDirectory, "central-sync.cjs"), '"use strict";\n');
  fs.writeFileSync(path.join(appDirectory, "sync-outbox.cjs"), '"use strict";\n');
  fs.writeFileSync(path.join(appDirectory, "alibaba-config.cjs"), '"use strict";\n');
  for (const file of [
    "excel-live.cjs",
    "workbook-fingerprint.cjs",
    "workbook-location.cjs",
    "private-workbook-bootstrap.cjs",
    "private-workbook-bootstrap-main.cjs",
    "workbook-identity-migration.cjs",
    "workbook-migration-transaction.cjs",
    "packaged-smoke-runtime.cjs",
    "inventory/conflict-resolution.js",
  ]) fs.writeFileSync(path.join(appDirectory, file), '"use strict";\n');
  const jszipDirectory = path.join(appDirectory, "node_modules", "jszip", "lib");
  fs.mkdirSync(jszipDirectory, { recursive: true });
  fs.writeFileSync(path.join(jszipDirectory, "external.js"), '"use strict";\nmodule.exports = {};\n');
  fs.writeFileSync(path.join(inventoryDirectory, "alibaba-cloud.json"), JSON.stringify({
    apiBaseUrl: "https://stock-api.aliyuncs.com",
    ossPublicBaseUrl: "https://tek-stock-photos.oss-cn-hangzhou.aliyuncs.com",
  }));
  const goodArchive = path.join(directory, "good.asar");
  await asar.createPackage(appDirectory, goodArchive);
  assert.equal(verifyPackagedArchive(goodArchive, "1.5.33"), "1.5.33");

  fs.writeFileSync(
    path.join(inventoryDirectory, "index.html"),
    '<span>App v1.5.32</span><script>appVersion: "1.5.32"</script>',
  );
  const staleArchive = path.join(directory, "stale.asar");
  await asar.createPackage(appDirectory, staleArchive);
  assert.throws(
    () => verifyPackagedArchive(staleArchive, "1.5.33"),
    /badge must match package version 1\.5\.33/,
  );

  fs.writeFileSync(path.join(inventoryDirectory, "index.html"),
    '<span>App v1.5.33</span><script>appVersion: "1.5.33"</script>');
  fs.writeFileSync(path.join(jszipDirectory, "external.js"), '"unterminated');
  const corruptArchive = path.join(directory, "corrupt.asar");
  await asar.createPackage(appDirectory, corruptArchive);
  assert.throws(
    () => verifyPackagedArchive(corruptArchive, "1.5.33"),
    /packaged JavaScript is corrupt or invalid: node_modules\/jszip\/lib\/external\.js/,
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
  assert.ok(show >= 0, "the hidden smoke window must be shown without focus before capture");
  assert.ok(capture > show, "capture must happen after the settled renderer is painted");
  assert.ok(hide > capture, "the evidence window must be hidden again after capture");
});

test("package audit rejects missing, placeholder, or secret-bearing Alibaba config", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-cloud-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appDirectory = path.join(directory, "app");
  const inventoryDirectory = path.join(appDirectory, "inventory");
  fs.mkdirSync(inventoryDirectory, { recursive: true });
  fs.writeFileSync(path.join(appDirectory, "package.json"),
    JSON.stringify({ name: "tek-stock-test", version: "1.5.33" }));
  fs.writeFileSync(path.join(inventoryDirectory, "index.html"),
    '<span>App v1.5.33</span><script>appVersion: "1.5.33"</script>');
  for (const file of [
    "alibaba-config.cjs", "api-failover.cjs", "central-sync.cjs", "excel-live.cjs",
    "sync-outbox.cjs", "workbook-fingerprint.cjs", "workbook-location.cjs",
    "private-workbook-bootstrap.cjs", "private-workbook-bootstrap-main.cjs",
    "workbook-identity-migration.cjs", "workbook-migration-transaction.cjs",
    "packaged-smoke-runtime.cjs",
    "inventory/conflict-resolution.js",
  ]) {
    fs.writeFileSync(path.join(appDirectory, file), '"use strict";\n');
  }
  const missingArchive = path.join(directory, "missing.asar");
  await asar.createPackage(appDirectory, missingArchive);
  assert.throws(() => verifyPackagedArchive(missingArchive, "1.5.33"),
    /missing the actual Alibaba cloud configuration/);

  fs.writeFileSync(path.join(inventoryDirectory, "alibaba-cloud.json"), JSON.stringify({
    apiBaseUrl: "https://stock-api.example.com",
    ossPublicBaseUrl: "https://bucket.oss-cn-hangzhou.aliyuncs.com",
  }));
  const placeholderArchive = path.join(directory, "placeholder.asar");
  await asar.createPackage(appDirectory, placeholderArchive);
  assert.throws(() => verifyPackagedArchive(placeholderArchive, "1.5.33"), /placeholder/);

  fs.writeFileSync(path.join(inventoryDirectory, "alibaba-cloud.json"), JSON.stringify({
    apiBaseUrl: "https://stock-api.aliyuncs.com",
    ossPublicBaseUrl: "https://bucket.oss-cn-hangzhou.aliyuncs.com",
    uploadToken: "must-not-ship",
  }));
  const secretArchive = path.join(directory, "secret.asar");
  await asar.createPackage(appDirectory, secretArchive);
  assert.throws(() => verifyPackagedArchive(secretArchive, "1.5.33"), /unexpected field.*uploadToken/);
});
