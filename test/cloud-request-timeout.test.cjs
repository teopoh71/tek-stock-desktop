"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("desktop cloud client waits long enough for an idle serverless cloud to wake", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "main.cjs"), "utf8");
  const service = source.slice(source.indexOf("function centralSyncService()"), source.indexOf("const SYNC_ITEM_FIELDS"));
  const match = service.match(/requestTimeoutMs:\s*([\d_]+)/);
  assert.ok(match, "centralSyncService must set requestTimeoutMs");
  assert.ok(Number(match[1].replace(/_/g, "")) >= 15_000, "cold starts take up to ~7 s; keep at least 15 s");
});
