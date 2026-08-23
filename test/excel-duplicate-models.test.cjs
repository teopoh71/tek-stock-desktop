"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeExcelRows,
  mergeExcelRows,
} = require("../inventory/excel-sync-core.js");

const duplicate123Rows = [
  {
    category: "TEST",
    model: "123",
    specification: "SYNC TEST - DELETE AFTER VERIFICATION",
    stock: 1,
    cost: 123,
    sellingPrice: 246,
    sourceRow: 329,
  },
  {
    category: "TEST",
    model: "123",
    specification: "SYNC TEST - DELETE AFTER VERIFICATION",
    stock: 1,
    cost: 123,
    sellingPrice: 9999,
    sourceRow: 330,
  },
];

test("blank legacy rows stay unbound and are never assigned identity from sourceRow", () => {
  const rows = normalizeExcelRows(duplicate123Rows);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "");
  assert.equal(rows[1].id, "");
  assert.equal(rows[0]._excelGeneratedId, false);
  assert.equal(rows[1]._excelGeneratedId, false);
  assert.equal(rows[0].sellingPrice, 246);
  assert.equal(rows[1].sellingPrice, 9999);
});

test("duplicate model rows remain distinct after repeated Excel imports", () => {
  const existing = [{
    id: "legacy-123",
    category: "TEST",
    model: "123",
    specification: "SYNC TEST - DELETE AFTER VERIFICATION",
    stock: 7,
    sellingPrice: 246,
  }];

  const once = mergeExcelRows(existing, duplicate123Rows);
  const twice = mergeExcelRows(once, duplicate123Rows);

  assert.equal(once.length, 2);
  assert.equal(twice.length, 2);
  assert.equal(twice.filter((item) => item.model === "123").length, 2);
  assert.deepEqual(
    twice.map((item) => item.sellingPrice).sort((a, b) => a - b),
    [246, 9999],
  );
});
