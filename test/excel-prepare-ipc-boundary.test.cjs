"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const test = require("node:test");
const v8 = require("node:v8");

const main = require("../main.cjs");

test("Excel prepare IPC returns only a bounded cloneable summary", async () => {
  assert.equal(typeof main.prepareCanonicalWorkbookUpdateIpc, "function");

  const result = await main.prepareCanonicalWorkbookUpdateIpc({
    prepareUpdate: async () => ({
      ok: true,
      path: "C:\\isolated\\TEK-STOCK-LIVE.xlsx",
      sha256: "a".repeat(64),
      size: 4_689_659,
      mtimeMs: 1_786_412_927_000,
      items: Array.from({ length: 322 }, () => ({ image: "x".repeat(40_000) })),
      rawItems: Array.from({ length: 322 }, () => ({ embeddedImageDataUrl: "x".repeat(40_000) })),
      baseline: { records: Array.from({ length: 322 }, () => ({ model: "fixture" })) },
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    errorCode: "",
    detail: "",
    path: "C:\\isolated\\TEK-STOCK-LIVE.xlsx",
    sha256: "a".repeat(64),
    size: 4_689_659,
    mtimeMs: 1_786_412_927_000,
  });
  assert.doesNotThrow(() => structuredClone(result));
  assert.ok(v8.serialize(result).length < 1024);
});
