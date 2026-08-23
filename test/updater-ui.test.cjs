"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "inventory", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "inventory", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "inventory", "styles.css"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.cjs"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const [major, minor, patch] = pkg.version.split(".");
const displayedVersion = `${major}.${minor}.${String(Number(patch)).padStart(2, "0")}`;

test("desktop exposes a visible reinstall control matching the package version", () => {
  assert.match(html, /id="reinstallButton"/);
  assert.match(html, />Reinstall<\/button>/);
  assert.match(html, new RegExp(`App v${displayedVersion.replace(/\./g, "\\.")}`));
  assert.match(html, new RegExp(`appVersion:\\s*"${displayedVersion.replace(/\./g, "\\.")}"`));
});

test("Update syncs data then applies only a newer verified app release", () => {
  assert.match(preload, /check: \(\) => ipcRenderer\.invoke\("tek-stock-updater-status"\)/);
  assert.match(preload, /update: \(\) => ipcRenderer\.invoke\("tek-stock-updater-update"\)/);
  assert.match(app, /status\?\.ok === true && status\?\.isMismatch === true/);
  assert.match(app, /uploadButton\?\.classList\.remove\("version-mismatch"\)/);
  assert.match(app, /reinstallButton\?\.classList\.toggle\("version-mismatch", mismatch\)/);
  assert.match(css, /\.update-button\.version-mismatch/);
  assert.match(css, /background: var\(--danger\)/);
  assert.match(html, /id="updateReceipt"/);
  assert.match(preload, /receipt: \(\) => ipcRenderer\.invoke\("tek-stock-updater-receipt"\)/);
  assert.match(app, /async function handleUpdateClick\(\)[\s\S]*?await updateInventory\(\)[\s\S]*?applyNewerDesktopUpdate\(\)/);
  assert.match(app, /await window\.TekStockUpdater\.update\(\)/);
  assert.match(app, /renderUpdateReceipt\(status\?\.receipt, announce\)/);
});

test("reinstall control invokes the verified native updater with busy and failure UX", () => {
  assert.match(app, /window\.TekStockUpdater\?\.reinstall/);
  assert.match(app, /await window\.TekStockUpdater\.reinstall\(\)/);
  assert.match(app, /button\.disabled = true/);
  assert.match(app, /Reinstall failed/);
  assert.match(app, /reinstallButton\.addEventListener\("click", reinstallLatestDesktop\)/);
});
