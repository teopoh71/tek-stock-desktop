const test = require("node:test");
const assert = require("node:assert/strict");

const { openWorkbook } = require("../inventory/excel-open-core.js");

test("Excel button opens an existing workbook immediately without rewriting it", async () => {
  const calls = [];
  const excelApi = {
    info: async () => {
      calls.push("info");
      return { exists: true };
    },
    ensure: async () => {
      calls.push("ensure");
      return { ok: true };
    },
    open: async () => {
      calls.push("open");
      return { ok: true, path: "TEK-STOCK-LIVE.xlsx" };
    },
  };

  const result = await openWorkbook(excelApi, { items: [] });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["info", "open"]);
});

test("Excel button creates a missing workbook once before opening it", async () => {
  const calls = [];
  const payload = { items: [{ model: "123" }] };
  const excelApi = {
    info: async () => {
      calls.push("info");
      return { exists: false };
    },
    ensure: async (received) => {
      calls.push(["ensure", received]);
      return { ok: true };
    },
    open: async () => {
      calls.push("open");
      return { ok: true };
    },
  };

  await openWorkbook(excelApi, payload);

  assert.deepEqual(calls, ["info", ["ensure", payload], "open"]);
});
