"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  assignPermanentIds,
  buildWorkbookDelta,
  planBlankIdRows,
} = require("../inventory/excel-delta-core.js");

function item(id, model, stock = 1, extra = {}) {
  return {
    id,
    category: "Chair",
    model,
    stock,
    specification: "",
    ...extra,
  };
}

test("permanent IDs survive row reorder and mutable field changes", () => {
  const rows = [
    { ...item("item-a", "A"), sourceRow: 5 },
    { ...item("item-b", "B"), sourceRow: 6 },
  ];
  const assigned = assignPermanentIds([
    { ...rows[1], model: "B renamed", sourceRow: 20 },
    { ...rows[0], category: "Table", sourceRow: 21 },
  ]);

  assert.equal(assigned.ok, true);
  assert.deepEqual(assigned.rows.map((row) => row.id), ["item-b", "item-a"]);
  assert.deepEqual(assigned.assignments, []);
});

test("blank rows receive one injected UUID and duplicate IDs are rejected", () => {
  const generated = ["018f0000-0000-7000-8000-000000000001"];
  const assigned = assignPermanentIds([
    { model: "NEW", category: "Chair", sourceRow: 99 },
  ], { randomUUID: () => generated.shift() });

  assert.equal(assigned.ok, true);
  assert.equal(assigned.rows[0].id, "018f0000-0000-7000-8000-000000000001");
  assert.deepEqual(assigned.assignments, [{
    id: "018f0000-0000-7000-8000-000000000001",
    sourceRow: 99,
  }]);

  const duplicate = assignPermanentIds([item("same-id", "A"), item("same-id", "B")]);
  assert.equal(duplicate.ok, false);
  assert.deepEqual(duplicate.conflicts, [{ id: "same-id", reason: "duplicate-id" }]);
});

test("blank-ID planning never drops an acknowledged legacy row and preserves only a verified append", () => {
  const writtenAt = "2026-08-04T08:00:00.000Z";
  const stale = planBlankIdRows([
    { model: "2222", category: "未分类", sourceRow: 329 },
  ], Array.from({ length: 324 }, (_, index) => item(`id-${index}`, `M-${index}`)), {
    acknowledgedItemCount: 325,
    workbookWrittenAt: writtenAt,
    workbookMtimeMs: Date.parse(writtenAt) + 5000,
    randomUUID: () => "must-not-be-used",
  });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.assignments, []);
  assert.deepEqual(stale.droppedSourceRows, []);
  assert.deepEqual(stale.conflicts, [{ sourceRow: 329, reason: "legacy-row-ambiguous" }]);

  const appended = planBlankIdRows([
    ...Array.from({ length: 324 }, (_, index) => ({ ...item(`id-${index}`, `M-${index}`), sourceRow: index + 5 })),
    { model: "NEW", category: "Chair", sourceRow: 329 },
  ], Array.from({ length: 324 }, (_, index) => item(`id-${index}`, `M-${index}`)), {
    acknowledgedItemCount: 324,
    baselineComplete: true,
    workbookWrittenAt: writtenAt,
    // A remote Office save may not advance mtime beyond the embedded time.
    workbookMtimeMs: Date.parse(writtenAt),
    randomUUID: () => "new-permanent-id",
  });
  assert.equal(appended.ok, true);
  assert.deepEqual(appended.droppedSourceRows, []);
  assert.deepEqual(appended.assignments, [{ id: "new-permanent-id", sourceRow: 329 }]);

  const missingBaseline = planBlankIdRows([
    { model: "UNSAFE", category: "Chair", sourceRow: 5 },
  ], [], {
    acknowledgedItemCount: 0,
    randomUUID: () => "must-not-be-used",
  });
  assert.equal(missingBaseline.ok, false);
  assert.deepEqual(missingBaseline.conflicts, [{ sourceRow: 5, reason: "legacy-row-ambiguous" }]);
});

test("blank-ID planning never binds by mutable content even with one live match", () => {
  const bound = planBlankIdRows([
    { model: "A5115", category: "Chair", specification: "LIGHT", sourceRow: 5 },
  ], [item("live-id", "A5115", 2, { specification: "LIGHT" })], {
    acknowledgedItemCount: 1,
  });
  assert.equal(bound.ok, false);
  assert.deepEqual(bound.assignments, []);
  assert.deepEqual(bound.conflicts, [{ sourceRow: 5, reason: "legacy-row-ambiguous" }]);

  const ambiguous = planBlankIdRows([
    { model: "CHANGED", category: "Chair", sourceRow: 5 },
  ], [item("live-id", "ORIGINAL")], { acknowledgedItemCount: 1 });
  assert.equal(ambiguous.ok, false);
  assert.deepEqual(ambiguous.conflicts, [{ sourceRow: 5, reason: "legacy-row-ambiguous" }]);
});

test("one verified deletion plus two blank-ID additions receive independent permanent IDs", () => {
  const writtenAt = "2026-08-18T01:00:00.000Z";
  const keepA = item("keep-a", "KEEP-A", 2);
  const removed = item("removed-id", "OLD-ROW", 3);
  const keepB = item("keep-b", "KEEP-B", 4);
  const generatedIds = ["new-model-id-1", "new-model-id-2"];
  const planned = planBlankIdRows([
    { ...keepA, sourceRow: 5 },
    { model: "NEW-ONE", category: "Table", stock: 5, sourceRow: 6 },
    { model: "NEW-TWO", category: "Chair", stock: 6, sourceRow: 7 },
    { ...keepB, sourceRow: 8 },
  ], [keepA, removed, keepB], {
    dataStartRow: 5,
    acknowledgedItemCount: 3,
    baselineComplete: true,
    baselineItems: [keepA, removed, keepB],
    workbookWrittenAt: writtenAt,
    workbookMtimeMs: Date.parse(writtenAt) + 5000,
    randomUUID: () => generatedIds.shift(),
  });

  assert.equal(planned.ok, true);
  assert.deepEqual(planned.assignments, [
    { id: "new-model-id-1", sourceRow: 6 },
    { id: "new-model-id-2", sourceRow: 7 },
  ]);
  assert.deepEqual(planned.rows.map((row) => row.id), [
    "keep-a", "new-model-id-1", "new-model-id-2", "keep-b",
  ]);
});

test("multi-add recovery stays closed when more than one baseline identity disappeared", () => {
  const writtenAt = "2026-08-18T01:00:00.000Z";
  const keep = item("keep-id", "KEEP", 2);
  const removedA = item("removed-a", "OLD-A", 3);
  const removedB = item("removed-b", "OLD-B", 4);
  const planned = planBlankIdRows([
    { ...keep, sourceRow: 5 },
    { model: "NEW-ONE", category: "Table", stock: 5, sourceRow: 6 },
    { model: "NEW-TWO", category: "Chair", stock: 6, sourceRow: 7 },
  ], [keep, removedA, removedB], {
    dataStartRow: 5,
    acknowledgedItemCount: 3,
    baselineComplete: true,
    baselineItems: [keep, removedA, removedB],
    workbookWrittenAt: writtenAt,
    workbookMtimeMs: Date.parse(writtenAt) + 5000,
    randomUUID: () => "must-not-be-used",
  });

  assert.equal(planned.ok, false);
  assert.deepEqual(planned.assignments, []);
  assert.deepEqual(planned.conflicts, [
    { sourceRow: 6, reason: "legacy-row-ambiguous" },
    { sourceRow: 7, reason: "legacy-row-ambiguous" },
  ]);
});

test("an appended row copied with an existing hidden ID receives a fresh permanent ID", () => {
  const planned = planBlankIdRows([
    { ...item("existing-id", "ORIGINAL"), sourceRow: 5 },
    { ...item("existing-id", "COPIED-AS-NEW"), sourceRow: 6 },
  ], [item("existing-id", "ORIGINAL")], {
    dataStartRow: 5,
    acknowledgedItemCount: 1,
    baselineComplete: true,
    randomUUID: () => "new-copied-row-id",
  });

  assert.equal(planned.ok, true);
  assert.deepEqual(planned.rows.map((row) => row.id), ["existing-id", "new-copied-row-id"]);
  assert.deepEqual(planned.assignments, [{
    id: "new-copied-row-id",
    sourceRow: 6,
    expectedId: "existing-id",
  }]);
});

test("multiple copied rows appended after the acknowledged region each receive a fresh ID", () => {
  const generatedIds = ["new-appended-id-1", "new-appended-id-2"];
  const planned = planBlankIdRows([
    { ...item("original-id", "ORIGINAL"), sourceRow: 5 },
    { ...item("copied-id", "NEW-666"), sourceRow: 6 },
    { ...item("copied-id", "NEW-777"), sourceRow: 7 },
  ], [item("original-id", "ORIGINAL")], {
    dataStartRow: 5,
    acknowledgedItemCount: 1,
    baselineComplete: true,
    randomUUID: () => generatedIds.shift(),
  });

  assert.equal(planned.ok, true);
  assert.deepEqual(planned.rows.map((row) => row.id), [
    "original-id", "new-appended-id-1", "new-appended-id-2",
  ]);
  assert.deepEqual(planned.assignments, [
    { id: "new-appended-id-1", sourceRow: 6, expectedId: "copied-id" },
    { id: "new-appended-id-2", sourceRow: 7, expectedId: "copied-id" },
  ]);
});

test("copied local IDs absent from a complete baseline are repaired across the acknowledged boundary", () => {
  const stableRows = Array.from({ length: 320 }, (_, index) => ({
    ...item(`stable-${index}`, `STABLE-${index}`), sourceRow: 5 + index,
  }));
  const baselineItems = [
    ...stableRows.map(({ sourceRow, ...row }) => row),
    item("missing-old", "MISSING-OLD"),
  ];
  const generatedIds = ["new-local-id-666", "new-local-id-777"];
  const planned = planBlankIdRows([
    ...stableRows,
    { ...item("copied-local-id", "666"), sourceRow: 325 },
    { ...item("copied-local-id", "777"), sourceRow: 326 },
  ], baselineItems, {
    dataStartRow: 5,
    acknowledgedItemCount: 321,
    baselineComplete: true,
    baselineItems,
    randomUUID: () => generatedIds.shift(),
  });

  assert.equal(planned.ok, true);
  assert.deepEqual(planned.rows.slice(-2).map((row) => row.id), [
    "new-local-id-666", "new-local-id-777",
  ]);
  assert.deepEqual(planned.assignments, [
    { id: "new-local-id-666", sourceRow: 325, expectedId: "copied-local-id" },
    { id: "new-local-id-777", sourceRow: 326, expectedId: "copied-local-id" },
  ]);
});

test("one exact baseline row keeps its ID while copied rows across the boundary receive fresh IDs", () => {
  const original = item("existing-id", "ORIGINAL", 4, {
    category: "Dining chair",
    specification: "BASE",
  });
  const missingOld = item("missing-old-id", "MISSING-OLD");
  const generatedIds = ["new-local-id-666", "new-local-id-777"];
  const planned = planBlankIdRows([
    { ...original, sourceRow: 5 },
    { ...item("existing-id", "666", 1, { category: "Coffee table" }), sourceRow: 6 },
    { ...item("existing-id", "777", 3, { category: "Dining table" }), sourceRow: 7 },
  ], [original, missingOld], {
    dataStartRow: 5,
    acknowledgedItemCount: 2,
    baselineComplete: true,
    baselineItems: [original, missingOld],
    randomUUID: () => generatedIds.shift(),
  });

  assert.equal(planned.ok, true);
  assert.deepEqual(planned.rows.map((row) => row.id), [
    "existing-id", "new-local-id-666", "new-local-id-777",
  ]);
  assert.deepEqual(planned.assignments, [
    { id: "new-local-id-666", sourceRow: 6, expectedId: "existing-id" },
    { id: "new-local-id-777", sourceRow: 7, expectedId: "existing-id" },
  ]);
});

test("one exact baseline row repairs copied IDs even when legacy workbook rows contain gaps", () => {
  const legacyId = "TEK-STOCK-LIVE.xlsx::Inventory::324";
  const original = item(legacyId, "A5115", -2, {
    category: "Dining chair",
    showroomQuantity: 0,
    computedTotalSold: 14,
    totalSold: 14,
    cost: 120,
    sellingPrice: 240,
    specification: "DARK GRAY",
  });
  const missingOld = item("missing-old-id", "MISSING-OLD");
  const generatedIds = ["new-local-id-666", "new-local-id-777"];
  const planned = planBlankIdRows([
    { ...original, sourceRow: 324 },
    { ...item(legacyId, "666", 1, {
      category: "Coffee table", showroomQuantity: 2, computedTotalSold: 3,
      totalSold: 3, cost: 88, sellingPrice: 888,
    }), sourceRow: 325 },
    { ...item(legacyId, "777", 3, {
      category: "Dining table", showroomQuantity: 2, computedTotalSold: 1,
      totalSold: 1, cost: 77, sellingPrice: 777,
    }), sourceRow: 326 },
  ], [original, missingOld], {
    dataStartRow: 5,
    acknowledgedItemCount: 321,
    baselineComplete: true,
    baselineItems: [original, missingOld],
    allowedLegacyIds: [legacyId],
    randomUUID: () => generatedIds.shift(),
  });

  assert.equal(planned.ok, true);
  assert.deepEqual(planned.rows.map((row) => row.id), [
    legacyId, "new-local-id-666", "new-local-id-777",
  ]);
  assert.deepEqual(planned.assignments, [
    { id: "new-local-id-666", sourceRow: 325, expectedId: legacyId },
    { id: "new-local-id-777", sourceRow: 326, expectedId: legacyId },
  ]);
});

test("a unique live legacy ID is never automatically replaced from row position or model change", () => {
  const legacyId = "old-stock.xlsx::Inventory::38";
  const baseline = [item("stable-id", "A5115")];
  const live = [
    ...baseline,
    item(legacyId, "OLD-LEGACY-PRODUCT", 1, { category: "Dining chair" }),
  ];
  const planned = planBlankIdRows([
    { ...baseline[0], sourceRow: 5 },
    {
      ...item(legacyId, "777", 3, {
        category: "Dining table",
        showroomQuantity: 2,
        computedTotalSold: 1,
        totalSold: 1,
        cost: 77,
        sellingPrice: 777,
      }),
      sourceRow: 6,
    },
  ], live, {
    dataStartRow: 5,
    acknowledgedItemCount: 1,
    baselineComplete: true,
    baselineItems: baseline,
    allowedLegacyIds: [legacyId],
    randomUUID: () => "fresh-777-id",
  });

  assert.equal(planned.ok, true);
  assert.equal(planned.rows[1].id, legacyId);
  assert.deepEqual(planned.assignments, []);
});

test("an unchanged unique live legacy ID is preserved for explicit migration", () => {
  const legacyId = "old-stock.xlsx::Inventory::38";
  const baseline = [item("stable-id", "A5115")];
  const live = [
    ...baseline,
    item(legacyId, "SAME-MODEL", 1, { category: "Dining chair" }),
  ];
  const planned = planBlankIdRows([
    { ...baseline[0], sourceRow: 5 },
    { ...item(legacyId, "SAME-MODEL", 2, { category: "Dining chair" }), sourceRow: 6 },
  ], live, {
    dataStartRow: 5,
    acknowledgedItemCount: 1,
    baselineComplete: true,
    baselineItems: baseline,
    allowedLegacyIds: [legacyId],
    randomUUID: () => "must-not-be-used",
  });

  assert.equal(planned.ok, true);
  assert.deepEqual(planned.assignments, []);
  assert.deepEqual(planned.conflicts, []);
  assert.equal(planned.rows[1].id, legacyId);
});

test("a visible-field baseline match with a different photo cannot claim the permanent ID", () => {
  const permanentId = "permanent-product-id";
  const original = item(permanentId, "A5115", 1, {
    category: "Dining chair",
    stockText: "",
    showroomQuantity: 0,
    computedTotalSold: 14,
    totalSold: 14,
    cost: 120,
    sellingPrice: 240,
    sellingPriceText: "",
    specification: "DARK GRAY",
    arrival: "",
    showroom: "",
    outbound: "",
    sourceFile: "TEK-STOCK-LIVE.xlsx",
    sourceSheet: "Inventory",
    image: "photos/original.jpg",
    imageSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const planned = planBlankIdRows([
    { ...original, stock: 9, stockText: "9", sourceRow: 325 },
    {
      ...original,
      image: "photos/replaced.jpg",
      imageSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      sourceRow: 326,
    },
  ], [original], {
    dataStartRow: 5,
    acknowledgedItemCount: 321,
    baselineComplete: true,
    baselineItems: [original],
    randomUUID: () => "must-not-be-used",
  });

  assert.equal(planned.ok, false);
  assert.deepEqual(planned.assignments, []);
  assert.deepEqual(planned.conflicts, [{
    id: permanentId,
    reason: "duplicate-id",
    sourceRows: [325, 326],
  }]);
});

test("reader-shaped embedded image hashes identify the one unchanged original", () => {
  const permanentId = "permanent-product-id";
  const baseline = item(permanentId, "A5115", 1, {
    category: "Dining chair",
    stockText: "1",
    showroomQuantity: 0,
    computedTotalSold: 14,
    totalSold: 14,
    cost: 120,
    sellingPrice: 240,
    sellingPriceText: "S$ 240",
    specification: "DARK GRAY",
    arrival: "",
    showroom: "",
    outbound: "",
    sourceFile: "TEK-STOCK-LIVE.xlsx",
    sourceSheet: "Inventory",
    image: "",
    imageHash: "original-embedded-hash",
  });
  const planned = planBlankIdRows([
    {
      id: permanentId,
      category: baseline.category,
      model: baseline.model,
      stock: baseline.stock,
      showroomQuantity: baseline.showroomQuantity,
      computedTotalSold: baseline.computedTotalSold,
      totalSold: baseline.totalSold,
      cost: baseline.cost,
      sellingPrice: baseline.sellingPrice,
      specification: baseline.specification,
      arrival: baseline.arrival,
      showroom: baseline.showroom,
      outbound: baseline.outbound,
      sourceFile: baseline.sourceFile,
      sourceSheet: baseline.sourceSheet,
      image: "",
      embeddedImageHash: baseline.imageHash,
      sourceRow: 325,
    },
    {
      id: permanentId,
      category: "Coffee table",
      model: "666",
      stock: 1,
      showroomQuantity: 2,
      computedTotalSold: 3,
      totalSold: 3,
      cost: 88,
      sellingPrice: 888,
      specification: "",
      arrival: "",
      showroom: "",
      outbound: "",
      sourceFile: baseline.sourceFile,
      sourceSheet: baseline.sourceSheet,
      image: "",
      embeddedImageHash: "copied-photo-hash",
      sourceRow: 326,
    },
  ], [baseline], {
    dataStartRow: 5,
    acknowledgedItemCount: 321,
    baselineComplete: true,
    baselineItems: [baseline],
    randomUUID: () => "new-copy-id",
  });

  assert.equal(planned.ok, true);
  assert.deepEqual(planned.assignments, [{
    id: "new-copy-id",
    sourceRow: 326,
    expectedId: permanentId,
  }]);
});

test("reader-shaped photo mismatch cannot move a permanent ID to a copied row", () => {
  const permanentId = "permanent-product-id";
  const baseline = item(permanentId, "A5115", 1, {
    category: "Dining chair",
    stockText: "",
    showroomQuantity: 0,
    computedTotalSold: 14,
    totalSold: 14,
    cost: 120,
    sellingPrice: 240,
    sellingPriceText: "",
    specification: "DARK GRAY",
    arrival: "",
    showroom: "",
    outbound: "",
    sourceFile: "TEK-STOCK-LIVE.xlsx",
    sourceSheet: "Inventory",
    image: "",
    imageHash: "original-embedded-hash",
  });
  const readerRow = (extra) => ({
    id: permanentId,
    category: baseline.category,
    model: baseline.model,
    stock: baseline.stock,
    showroomQuantity: baseline.showroomQuantity,
    computedTotalSold: baseline.computedTotalSold,
    totalSold: baseline.totalSold,
    cost: baseline.cost,
    sellingPrice: baseline.sellingPrice,
    specification: baseline.specification,
    arrival: baseline.arrival,
    showroom: baseline.showroom,
    outbound: baseline.outbound,
    sourceFile: baseline.sourceFile,
    sourceSheet: baseline.sourceSheet,
    image: "",
    imageChanged: false,
    ...extra,
  });
  const planned = planBlankIdRows([
    readerRow({ stock: 9, embeddedImageHash: baseline.imageHash, sourceRow: 325 }),
    readerRow({ embeddedImageHash: "different-embedded-hash", sourceRow: 326 }),
  ], [baseline], {
    dataStartRow: 5,
    acknowledgedItemCount: 321,
    baselineComplete: true,
    baselineItems: [baseline],
    randomUUID: () => "must-not-be-used",
  });

  assert.equal(planned.ok, false);
  assert.deepEqual(planned.assignments, []);
  assert.deepEqual(planned.conflicts, [{
    id: permanentId,
    reason: "duplicate-id",
    sourceRows: [325, 326],
  }]);
});

test("multiple full canonical baseline matches stay blocked instead of guessing an original", () => {
  const original = item("permanent-product-id", "A5115", 1, {
    image: "photos/original.jpg",
    imageSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const planned = planBlankIdRows([
    { ...original, sourceRow: 325 },
    { ...original, sourceRow: 326 },
  ], [original], {
    dataStartRow: 5,
    acknowledgedItemCount: 321,
    baselineComplete: true,
    baselineItems: [original],
    randomUUID: () => "must-not-be-used",
  });

  assert.equal(planned.ok, false);
  assert.deepEqual(planned.assignments, []);
  assert.deepEqual(planned.conflicts, [{
    id: original.id,
    reason: "duplicate-id",
    sourceRows: [325, 326],
  }]);
});

test("duplicate IDs inside the acknowledged region stay blocked with exact row evidence", () => {
  const planned = planBlankIdRows([
    { ...item("duplicate-id", "A"), sourceRow: 5 },
    { ...item("duplicate-id", "B"), sourceRow: 6 },
  ], [item("duplicate-id", "A")], {
    dataStartRow: 5,
    acknowledgedItemCount: 2,
    baselineComplete: true,
  });

  assert.equal(planned.ok, false);
  assert.deepEqual(planned.assignments, []);
  assert.deepEqual(planned.conflicts, [{
    id: "duplicate-id",
    reason: "duplicate-id",
    sourceRows: [5, 6],
  }]);
});

test("workbook delta detects create update and delete strictly by ID", () => {
  const baseline = [
    item("a", "A", 2, { cost: 10 }),
    item("b", "B", 3),
    item("c", "C", 4),
  ];
  const current = [
    item("c", "C", 4),
    item("a", "A renamed", 5, { cost: 10 }),
    { ...item("d", "D", 1), _excelGeneratedId: true },
  ];
  const delta = buildWorkbookDelta({ baselineRecords: baseline, currentRows: current });

  assert.equal(delta.ok, true);
  assert.deepEqual(delta.created.map((entry) => entry.itemId), ["d"]);
  assert.deepEqual(delta.updated, [{
    type: "update",
    itemId: "a",
    patch: { model: "A renamed", stock: 5 },
  }]);
  assert.deepEqual(delta.deleted, [{ type: "delete", itemId: "b" }]);
});

test("row reorder and duplicate model names never create a delta", () => {
  const baseline = [
    item("light", "A5115", 2, { specification: "LIGHT" }),
    item("dark", "A5115", 1, { specification: "DARK" }),
  ];
  const delta = buildWorkbookDelta({
    baselineRecords: baseline,
    currentRows: [{ ...baseline[1], sourceRow: 50 }, { ...baseline[0], sourceRow: 51 }],
  });

  assert.equal(delta.ok, true);
  assert.deepEqual(delta.operations, []);
});

test("delta refuses blank and duplicate IDs instead of matching by row or content", () => {
  const blank = buildWorkbookDelta({
    baselineRecords: [item("a", "SAME")],
    currentRows: [{ model: "SAME", sourceRow: 5 }],
  });
  assert.equal(blank.ok, false);
  assert.deepEqual(blank.conflicts, [{ sourceRow: 5, reason: "missing-id" }]);

  const duplicate = buildWorkbookDelta({
    baselineRecords: [],
    currentRows: [item("a", "SAME"), item("a", "SAME")],
  });
  assert.equal(duplicate.ok, false);
  assert.deepEqual(duplicate.conflicts, [{ id: "a", reason: "duplicate-id" }]);
});

test("delta blocks a manually changed permanent ID instead of creating and deleting records", () => {
  const baseline = [{ ...item("record-a", "A"), sourceRow: 5 }];
  const changed = buildWorkbookDelta({
    baselineRecords: baseline,
    currentRows: [{ ...baseline[0], id: "record-b", sourceRow: 5 }],
  });
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.conflicts, [{ id: "record-b", reason: "unknown-id" }]);
  assert.deepEqual(changed.operations, []);
});

test("delta accepts only explicitly generated new IDs and rejects illegal IDs", () => {
  const generated = buildWorkbookDelta({
    baselineRecords: [],
    currentRows: [{ ...item("new-safe-id", "NEW"), _excelGeneratedId: true, sourceRow: 5 }],
  });
  assert.equal(generated.ok, true);
  assert.equal(generated.created.length, 1);
  const illegal = buildWorkbookDelta({
    baselineRecords: [],
    currentRows: [{ ...item("bad id", "NEW"), _excelGeneratedId: true, sourceRow: 5 }],
  });
  assert.equal(illegal.ok, false);
  assert.deepEqual(illegal.conflicts, [{ id: "bad id", reason: "invalid-id" }]);
});

test("live legacy IDs are read-only while one appended permanent ID remains writable", () => {
  const legacy = { ...item("legacy.xlsx::Sheet1::5", "KEEP"), sourceRow: 5 };
  const allowedLegacyIds = [legacy.id];
  const planned = planBlankIdRows([legacy, { ...item("", "NEW"), sourceRow: 6 }], [legacy], {
    dataStartRow: 5,
    acknowledgedItemCount: 1,
    baselineComplete: true,
    allowedLegacyIds,
    randomUUID: () => "new-safe-id",
  });
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.assignments, [{ id: "new-safe-id", sourceRow: 6 }]);
  const delta = buildWorkbookDelta({
    baselineRecords: [legacy],
    currentRows: planned.rows,
    allowedExistingIds: [legacy.id, "new-safe-id"],
    allowedLegacyIds,
  });
  assert.equal(delta.ok, true);
  assert.deepEqual(delta.operations, [{
    type: "create",
    itemId: "new-safe-id",
    item: { id: "new-safe-id", category: "Chair", model: "NEW", stock: 1, specification: "" },
  }]);
  for (const currentRows of [[{ ...legacy, stock: 2 }], []]) {
    const unsafe = buildWorkbookDelta({
      baselineRecords: [legacy], currentRows, allowedExistingIds: allowedLegacyIds, allowedLegacyIds,
    });
    assert.equal(unsafe.ok, false);
    assert.deepEqual(unsafe.operations, []);
    assert.equal(unsafe.conflicts.some((entry) => entry.reason === "legacy-id-read-only"), true);
  }
});

test("an explicit legacy delete capability permits only that deletion", () => {
  const first = { ...item("legacy.xlsx::Sheet1::5", "DELETE"), sourceRow: 5 };
  const second = { ...item("legacy.xlsx::Sheet1::6", "KEEP"), sourceRow: 6 };
  const allowedLegacyIds = [first.id, second.id];
  const permitted = buildWorkbookDelta({
    baselineRecords: [first, second],
    currentRows: [second],
    allowedLegacyIds,
    allowedLegacyDeleteIds: [first.id],
  });
  assert.equal(permitted.ok, true);
  assert.deepEqual(permitted.operations, [{ type: "delete", itemId: first.id }]);

  const wrongDeletion = buildWorkbookDelta({
    baselineRecords: [first, second],
    currentRows: [first],
    allowedLegacyIds,
    allowedLegacyDeleteIds: [first.id],
  });
  assert.equal(wrongDeletion.ok, false);
  assert.deepEqual(wrongDeletion.conflicts, [{ id: second.id, reason: "legacy-id-read-only" }]);

  const update = buildWorkbookDelta({
    baselineRecords: [first],
    currentRows: [{ ...first, stock: 2 }],
    allowedLegacyIds,
    allowedLegacyDeleteIds: [first.id],
  });
  assert.equal(update.ok, false);
  assert.deepEqual(update.conflicts, [{ id: first.id, reason: "legacy-id-read-only" }]);
});
