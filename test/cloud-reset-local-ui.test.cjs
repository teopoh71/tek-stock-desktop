"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "inventory", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "inventory", "app.js"), "utf8");

test("cloud reset local control is separate and explicitly destructive", () => {
  assert.match(html, /id="resetLocalButton"/);
  assert.match(html, /id="resetLocalDialog"/);
  assert.match(html, /当前实时云端快照是唯一标准/);
  assert.match(html, /本机 APP\/Excel 内容、未同步修改、待同步和冲突状态都会在备份后丢弃/);
  assert.match(html, /云端资料和其他电脑不会改变/);
  assert.match(app, /resetLocalFromCloud\(/);
  assert.match(app, /TEK-STOCK-CLOUD-RESET-LOCAL-CONFIRMED/);
  assert.match(app, /window\.location\.reload\(\)/);
});
