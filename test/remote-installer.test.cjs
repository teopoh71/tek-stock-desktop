"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("remote repair installer is one-click, machine-wide, and preserves user data", () => {
  const config = require("../build/electron-builder.remote.cjs");
  assert.equal(config.compression, "maximum");
  assert.equal(config.directories.output, "dist-remote");
  assert.equal(config.win.target[0].target, "nsis");
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.perMachine, true);
  assert.equal(config.nsis.createDesktopShortcut, "always");
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.match(config.nsis.artifactName, /Remote-Repair/);
  assert.ok(config.files.includes("!node_modules/sharp-win7/**/*"));
});

test("remote repair cleanup is bounded to old program files and known MSI products", () => {
  const script = fs.readFileSync(path.join(root, "build", "remote-repair.nsh"), "utf8");
  for (const productCode of [
    "{3A304031-9F89-44AA-B152-375A08CB9B51}",
    "{4F7AE8D7-B021-4B8B-9222-CCACFC52C44C}",
    "{08A9F778-1D5B-41BC-AFA3-B4C0D2719ACA}",
    "{A0C1C94B-9A8C-40C3-A635-A6307811995C}",
    "{A06205DA-8549-4915-A12A-181FD0B8282C}",
    "{39B92FFE-0D84-4570-960A-6C9A095DDF7A}",
  ]) assert.match(script, new RegExp(productCode.replace(/[{}-]/g, "\\$&")));
  assert.match(script, /RMDir \/r "\$PROGRAMFILES64\\TEK STOCK"/);
  assert.match(script, /SetShellVarContext current[\s\S]*Delete "\$DESKTOP\\TEK STOCK\.lnk"/);
  assert.match(script, /SetShellVarContext all[\s\S]*Delete "\$DESKTOP\\TEK STOCK\.lnk"/);
  assert.doesNotMatch(script, /APPDATA|Documents|TEK-STOCK-LIVE|inventory\/data/i);
});

test("remote repair closes TEK STOCK and removes every 1.6.0 through 1.6.6 MSI before install", () => {
  const script = fs.readFileSync(path.join(root, "build", "remote-repair.nsh"), "utf8");
  assert.match(script, /taskkill\.exe[^\r\n]*TEK STOCK\.exe/i);
  for (const productCode of [
    "{9DD6E437-7ECE-4693-A0FB-D80845BF1770}",
    "{B9531E83-0B96-40C9-A759-65A1DE15DA00}",
    "{EE1CEE15-88E4-4005-AC17-574809A339EE}",
    "{420ECF89-6F61-4538-8677-C3194A3254EA}",
    "{A4065439-2F6D-406D-9AE0-1A1CB6F0DC8C}",
    "{CDA1D955-F8F6-4D02-9774-B3282E7DE1ED}",
  ]) assert.match(script, new RegExp(productCode.replace(/[{}-]/g, "\\$&")));
});
