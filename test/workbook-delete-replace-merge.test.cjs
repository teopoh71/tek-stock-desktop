"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { planBlankIdRows } = require("../inventory/excel-delta-core.js");
const { threeWayWorkbookMerge } = require("../inventory/excel-sync-core.js");

function item(id, model, stock, extra = {}) {
  return {
    id,
    category: "Chair",
    model,
    stock,
    showroomQuantity: 0,
    computedTotalSold: 0,
    totalSold: 0,
    cost: 50,
    sellingPrice: 100,
    sellingPriceText: "S$ 100",
    specification: "",
    arrival: "",
    showroom: "",
    outbound: "",
    sourceFile: "TEK-STOCK-LIVE.xlsx",
    sourceSheet: "库存总表",
    ...extra,
  };
}

function assignedReplacementRows({ two = false } = {}) {
  const writtenAt = "2026-08-23T05:00:00.000Z";
  const keepA = item("keep-a", "KEEP-A", 2);
  const removed = item("removed-id", "OLD-MODEL", 3, {
    image: "photos/old.webp",
    imageSha256: "a".repeat(64),
    imageVersion: "sha256-aaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const keepB = item("keep-b", "KEEP-B", 4);
  const baseline = [keepA, removed, keepB];
  const live = [
    { ...keepA, stock: 7 },
    {
      ...removed,
      // These are cloud/runtime normalization details, not user edits to the
      // product represented by the deleted Excel row.
      stockText: "3 pcs",
      sellingPriceText: "100",
      sourceFile: "cloud-runtime",
      sourceSheet: "inventory",
      image: "https://cdn.invalid/runtime-photo-url",
    },
    { ...keepB },
    item("cloud-only", "CLOUD-ONLY", 9),
  ];
  const rows = [
    { ...keepA, sourceRow: 5 },
    { model: "NEW-ONE", category: "Table", stock: 5, sourceRow: 6 },
    ...(two ? [{ model: "NEW-TWO", category: "Chair", stock: 6, sourceRow: 7 }] : []),
    { ...keepB, sourceRow: two ? 8 : 7 },
  ];
  const ids = two
    ? ["018f0000-0000-7000-8000-000000000011", "018f0000-0000-7000-8000-000000000012"]
    : ["018f0000-0000-7000-8000-000000000010"];
  const planned = planBlankIdRows(rows, live, {
    dataStartRow: 5,
    acknowledgedItemCount: baseline.length,
    baselineComplete: true,
    baselineItems: baseline,
    workbookWrittenAt: writtenAt,
    workbookMtimeMs: Date.parse(writtenAt) + 5000,
    randomUUID: () => ids.shift(),
  });
  assert.equal(planned.ok, true, JSON.stringify(planned.conflicts));
  const assignedIds = planned.assignments.map((entry) => entry.id);
  const excelRows = planned.rows.map((row) => ({
    ...row,
    _excelGeneratedId: assignedIds.includes(row.id),
  }));
  return { baseline, live, excelRows, assignedIds, removed };
}

function assertSafeDeleteReplace(result, fixture, expectedCreates) {
  assert.equal(result.ok, true, JSON.stringify(result.conflicts));
  assert.deepEqual(result.created, fixture.assignedIds);
  assert.deepEqual(result.deleted, [fixture.removed.id]);
  assert.equal(result.created.length, expectedCreates);
  assert.equal(fixture.assignedIds.includes(fixture.removed.id), false);
  assert.equal(new Set(fixture.assignedIds).size, expectedCreates);

  const byId = new Map(result.items.map((entry) => [entry.id, entry]));
  assert.equal(byId.has(fixture.removed.id), false);
  assert.equal(byId.get("keep-a").stock, 7, "unrelated cloud edit must survive");
  assert.equal(byId.get("cloud-only").stock, 9, "cloud-only item must survive");
  for (const id of fixture.assignedIds) assert.equal(byId.has(id), true);
}

test("delete full model row then add one model at the same visual position merges safely", () => {
  const fixture = assignedReplacementRows();
  const result = threeWayWorkbookMerge({
    baselineItems: fixture.baseline,
    excelRows: fixture.excelRows,
    liveItems: fixture.live,
  });
  assertSafeDeleteReplace(result, fixture, 1);
});

test("delete full model row then add two models in the same visual region merges safely", () => {
  const fixture = assignedReplacementRows({ two: true });
  const result = threeWayWorkbookMerge({
    baselineItems: fixture.baseline,
    excelRows: fixture.excelRows,
    liveItems: fixture.live,
  });
  assertSafeDeleteReplace(result, fixture, 2);
});

test("a genuine cloud edit to the deleted product still blocks deletion atomically", () => {
  const fixture = assignedReplacementRows();
  fixture.live = fixture.live.map((entry) => entry.id === fixture.removed.id
    ? { ...entry, stock: fixture.removed.stock + 1 }
    : entry);
  const result = threeWayWorkbookMerge({
    baselineItems: fixture.baseline,
    excelRows: fixture.excelRows,
    liveItems: fixture.live,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, [{ id: fixture.removed.id, reason: "delete-modified-live" }]);
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.deleted, []);
  assert.equal(result.items.some((entry) => entry.id === fixture.removed.id), true);
});
