"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const config = require("../build/electron-builder.update.cjs");

test("formal Update package preserves user data and does not run repair cleanup", () => {
  assert.equal(config.directories.output, "dist-update");
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.nsis.include, undefined);
  assert.equal(config.nsis.artifactName, "TEK-STOCK-新加坡库存-${version}-${arch}.${ext}");
  assert.equal(config.nsis.createDesktopShortcut, "always");
});
