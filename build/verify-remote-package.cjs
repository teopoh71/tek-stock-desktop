"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const asar = require("@electron/asar");
const verifyBasePackage = require("./verify-packaged-version.cjs");

async function verifyRemotePackage(context) {
  await verifyBasePackage(context);
  const archiveFile = path.join(context.appOutDir, "resources", "app.asar");
  const files = asar.listPackage(archiveFile).map((entry) => (
    String(entry).replace(/^[/\\]+/, "").replace(/\\/g, "/")
  ));
  assert.equal(
    files.some((entry) => entry === "node_modules/sharp-win7"
      || entry.startsWith("node_modules/sharp-win7/")),
    false,
    "remote installer must not contain the unused Windows 7 Sharp build",
  );
  assert.equal(
    files.some((entry) => entry === "node_modules/sharp"
      || entry.startsWith("node_modules/sharp/")),
    true,
    "remote installer must retain the modern Sharp image runtime",
  );
  assert.equal(
    files.some((entry) => entry === "node_modules/exceljs"
      || entry.startsWith("node_modules/exceljs/")),
    true,
    "remote installer must retain ExcelJS",
  );
  console.log("Verified lightweight remote package runtime and exclusions.");
}

module.exports = verifyRemotePackage;
