"use strict";

const fs = require("node:fs");
const path = require("node:path");

const [sourceFile, inventoryDirectory] = process.argv.slice(2);
if (!sourceFile || !inventoryDirectory) {
  throw new Error("Usage: apply-cloudflare-seed.cjs seed.json inventory-directory");
}
const seed = JSON.parse(fs.readFileSync(sourceFile, "utf8").replace(/^\uFEFF/, ""));
if (!Array.isArray(seed.items) || seed.items.length !== 326) {
  throw new Error("Expected the verified 326-item Cloudflare seed");
}
const stock = seed.items.reduce((total, item) => total + Number(item.stock || 0), 0);
if (stock !== 1574) throw new Error("Expected 1,574 total stock");

const payload = {
  generatedAt: new Date().toISOString(),
  sourceFiles: ["verified historical snapshot"],
  ...seed,
};
fs.writeFileSync(path.join(inventoryDirectory, "inventory-data.json"), `${JSON.stringify(payload, null, 2)}\n`);
fs.writeFileSync(path.join(inventoryDirectory, "inventory-data.js"), `window.INVENTORY_PAYLOAD = ${JSON.stringify(payload)};\n`);
