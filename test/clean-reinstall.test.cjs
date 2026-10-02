"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "build", "clean-reinstall.ps1");

function runFixture(t, body) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-clean-reinstall-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const runner = path.join(fixture, "run.ps1");
  fs.writeFileSync(runner, [
    "$ErrorActionPreference = 'Stop'",
    `. '${script.replace(/'/g, "''")}'`,
    body,
  ].join("\r\n"));
  return childProcess.spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner], {
    encoding: "utf8",
  });
}

function fixtureBody(fixture, extra = "") {
  const roaming = path.join(fixture, "Roaming", "samlee-inventory-desktop");
  const local = path.join(fixture, "Local", "TEK STOCK");
  const workbook = path.join(fixture, "Documents", "TEK STOCK", "TEK-STOCK-LIVE.xlsx");
  return [
    `$roots = @{ Roaming = '${roaming.replace(/'/g, "''")}'; Local = '${local.replace(/'/g, "''")}'; LegacyWorkbook = '${workbook.replace(/'/g, "''")}' }`,
    `$baseRoots = @{ RoamingBase = '${path.join(fixture, "Roaming").replace(/'/g, "''")}'; LocalBase = '${path.join(fixture, "Local").replace(/'/g, "''")}'; DocumentsBase = '${path.join(fixture, "Documents").replace(/'/g, "''")}' }`,
    extra,
    "Invoke-TekStockCleanReinstall -Roots $roots -BaseRoots $baseRoots -SkipProcessStop -SkipMsi -SkipUserCheck",
  ].join("\r\n");
}

test("clean reinstall deletes only the authorized local TEK STOCK roots without backups", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-clean-reinstall-data-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const targets = [
    path.join(fixture, "Roaming", "samlee-inventory-desktop", "state.json"),
    path.join(fixture, "Local", "TEK STOCK", "workbooks", "current.xlsx"),
    path.join(fixture, "Documents", "TEK STOCK", "TEK-STOCK-LIVE.xlsx"),
  ];
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "remove");
  }
  const outside = path.join(fixture, "Documents", "TEK STOCK", "keep.txt");
  fs.writeFileSync(outside, "keep");
  const result = runFixture(t, fixtureBody(fixture));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(fixture, "Roaming", "samlee-inventory-desktop")), false);
  assert.equal(fs.existsSync(path.join(fixture, "Local", "TEK STOCK")), false);
  assert.equal(fs.existsSync(targets[2]), false);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  assert.equal(fs.readdirSync(fixture, { recursive: true }).some((entry) => /backup/i.test(entry)), false);
});

test("clean reinstall rejects a reparse target before deleting any authorized root", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-clean-reinstall-reparse-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const roamingParent = path.join(fixture, "Roaming");
  const local = path.join(fixture, "Local", "TEK STOCK", "state.json");
  const workbook = path.join(fixture, "Documents", "TEK STOCK", "TEK-STOCK-LIVE.xlsx");
  const linked = path.join(roamingParent, "samlee-inventory-desktop");
  const source = path.join(fixture, "outside-source");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "must-survive.txt"), "keep");
  fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, "keep-until-rejection");
  fs.mkdirSync(path.dirname(workbook), { recursive: true }); fs.writeFileSync(workbook, "keep-until-rejection");
  fs.mkdirSync(roamingParent, { recursive: true });
  const link = childProcess.spawnSync("cmd.exe", ["/d", "/c", "mklink", "/J", linked, source], { encoding: "utf8" });
  if (link.status !== 0) t.skip(`junction creation unavailable: ${link.stderr || link.stdout}`);
  const result = runFixture(t, fixtureBody(fixture));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reparse|unsafe/i);
  assert.equal(fs.readFileSync(path.join(source, "must-survive.txt"), "utf8"), "keep");
  assert.equal(fs.readFileSync(local, "utf8"), "keep-until-rejection");
  assert.equal(fs.readFileSync(workbook, "utf8"), "keep-until-rejection");
});

test("clean reinstall rejects broad or nested roots before deleting authorized data", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-clean-reinstall-boundary-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const sentinel = path.join(fixture, "Local", "TEK STOCK", "must-survive.txt");
  fs.mkdirSync(path.dirname(sentinel), { recursive: true }); fs.writeFileSync(sentinel, "keep");
  const result = runFixture(t, [
    `$roots = @{ Roaming = '${path.join(fixture, "Roaming").replace(/'/g, "''")}'; Local = '${path.join(fixture, "Local", "TEK STOCK", "nested").replace(/'/g, "''")}'; LegacyWorkbook = '${path.join(fixture, "Documents", "TEK STOCK", "TEK-STOCK-LIVE.xlsx").replace(/'/g, "''")}' }`,
    `$baseRoots = @{ RoamingBase = '${path.join(fixture, "Roaming").replace(/'/g, "''")}'; LocalBase = '${path.join(fixture, "Local").replace(/'/g, "''")}'; DocumentsBase = '${path.join(fixture, "Documents").replace(/'/g, "''")}' }`,
    "Invoke-TekStockCleanReinstall -Roots $roots -BaseRoots $baseRoots -SkipProcessStop -SkipMsi -SkipUserCheck",
  ].join("\r\n"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe/i);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
});

test("clean reinstall reports a locked workbook without creating a backup", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-clean-reinstall-lock-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const workbook = path.join(fixture, "Documents", "TEK STOCK", "TEK-STOCK-LIVE.xlsx");
  const localState = path.join(fixture, "Local", "TEK STOCK", "must-survive-until-workbook-is-closed.json");
  fs.mkdirSync(path.dirname(workbook), { recursive: true }); fs.writeFileSync(workbook, "locked");
  fs.mkdirSync(path.dirname(localState), { recursive: true }); fs.writeFileSync(localState, "keep");
  const escaped = workbook.replace(/'/g, "''");
  const roots = fixtureBody(fixture).replace(/\r\nInvoke[\s\S]*$/, "");
  const result = runFixture(t, [
    roots,
    `$lock = [System.IO.File]::Open('${escaped}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)`,
    "try {",
    "  try { Invoke-TekStockCleanReinstall -Roots $roots -BaseRoots $baseRoots -SkipProcessStop -SkipMsi -SkipUserCheck; throw 'locked workbook deletion unexpectedly succeeded' }",
    "  catch { if ($_.Exception.Message -notmatch 'close TEK STOCK Excel and retry') { throw }; Write-Output $_.Exception.Message }",
    "} finally { $lock.Dispose() }",
  ].join("\r\n"));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /close TEK STOCK Excel and retry/i);
  assert.equal(fs.existsSync(workbook), true);
  assert.equal(fs.readFileSync(localState, "utf8"), "keep");
  assert.equal(fs.readdirSync(fixture, { recursive: true }).some((entry) => /backup/i.test(entry)), false);
});

test("clean reinstall preflights locked private workbooks before deleting other roots", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-clean-reinstall-private-lock-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const privateWorkbook = path.join(fixture, "Local", "TEK STOCK", "workbooks", "client", "TEK-STOCK-LIVE.xlsx");
  const roaming = path.join(fixture, "Roaming", "samlee-inventory-desktop", "must-survive.json");
  fs.mkdirSync(path.dirname(privateWorkbook), { recursive: true }); fs.writeFileSync(privateWorkbook, "locked");
  fs.mkdirSync(path.dirname(roaming), { recursive: true }); fs.writeFileSync(roaming, "keep");
  const escaped = privateWorkbook.replace(/'/g, "''");
  const body = fixtureBody(fixture).replace(/\r\nInvoke[\s\S]*$/, "");
  const result = runFixture(t, [
    body,
    `$lock = [System.IO.File]::Open('${escaped}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)`,
    "try {",
    "  try { Invoke-TekStockCleanReinstall -Roots $roots -BaseRoots $baseRoots -SkipProcessStop -SkipMsi -SkipUserCheck; throw 'locked private workbook deletion unexpectedly succeeded' }",
    "  catch { if ($_.Exception.Message -notmatch 'close TEK STOCK Excel and retry') { throw }; Write-Output $_.Exception.Message }",
    "} finally { $lock.Dispose() }",
  ].join("\r\n"));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /close TEK STOCK Excel and retry/i);
  assert.equal(fs.readFileSync(privateWorkbook, "utf8"), "locked");
  assert.equal(fs.readFileSync(roaming, "utf8"), "keep");
});

test("clean package configuration is isolated, credential-free, and named as destructive", () => {
  const config = require("../build/electron-builder.clean.cjs");
  assert.equal(config.directories.output, "dist-clean");
  assert.equal(config.win.target[0].target, "nsis");
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.match(config.nsis.artifactName, /Clean-Reinstall/);
  assert.equal(config.nsis.include, "build/clean-reinstall.nsh");
  for (const exclusion of ["!**/*.xlsx", "!**/sync-credentials.json", "!**/outbox.json", "!**/.env*"]) {
    assert.ok(config.files.includes(exclusion), `missing exclusion ${exclusion}`);
  }
});

test("clean reinstall hook runs after per-machine elevation and before installer payload extraction", () => {
  const hook = fs.readFileSync(path.join(root, "build", "clean-reinstall.nsh"), "utf8");
  const installerTemplate = fs.readFileSync(path.join(root, "node_modules", "app-builder-lib", "templates", "nsis", "installer.nsi"), "utf8");
  const sectionTemplate = fs.readFileSync(path.join(root, "node_modules", "app-builder-lib", "templates", "nsis", "installSection.nsh"), "utf8");
  assert.match(hook, /^!macro customInit/m);
  assert.doesNotMatch(hook, /^!macro customInstall/m);
  const admin = installerTemplate.indexOf("RequestExecutionLevel admin");
  const customInit = installerTemplate.indexOf("!ifmacrodef customInit");
  const section = installerTemplate.indexOf('!include "installSection.nsh"');
  const appFiles = sectionTemplate.indexOf("!insertmacro installApplicationFiles");
  const customInstall = sectionTemplate.indexOf("!ifmacrodef customInstall");
  assert.ok(admin >= 0 && admin < customInit, "per-machine installer requests elevation before .onInit");
  assert.ok(customInit >= 0 && customInit < section, "customInit is called before the install section");
  assert.ok(appFiles >= 0 && appFiles < customInstall, "customInstall is after app payload extraction");
});
