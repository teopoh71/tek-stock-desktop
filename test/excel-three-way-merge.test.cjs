"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeExcelRows,
  recoverAdditiveWorkbookMerge,
  recoverPureDeletionWorkbookMerge,
  mergeWorkbookSnapshot,
  threeWayWorkbookMerge,
} = require("../inventory/excel-sync-core.js");

function item(id, model, stock, specification = "") {
  return { id, category: "Chair", model, stock, specification };
}

test("blank rows stay unbound until a guarded permanent ID is supplied", () => {
  const [unbound] = normalizeExcelRows([{
    model: "11111",
    stock: "",
    showroomQuantity: null,
    computedTotalSold: undefined,
    totalSold: "",
    sourceRow: 331,
  }]);
  assert.equal(unbound.id, "");
  assert.equal(unbound._excelGeneratedId, false);
  assert.deepEqual(
    [unbound.stock, unbound.showroomQuantity, unbound.computedTotalSold, unbound.totalSold],
    ["", null, undefined, ""],
  );

  const [created] = normalizeExcelRows([{
    id: "generated-row",
    _excelGeneratedId: true,
    model: "11111",
    stock: "",
    showroomQuantity: null,
    computedTotalSold: undefined,
    totalSold: "",
  }]);
  assert.equal(created._excelGeneratedId, true);
  assert.deepEqual(
    [created.stock, created.showroomQuantity, created.computedTotalSold, created.totalSold],
    [0, 0, 0, 0],
  );

  const [existing] = normalizeExcelRows([{ id: "cloud-1", model: "OLD", stock: "" }]);
  const [invalid] = normalizeExcelRows([{ model: "BAD", stock: "abc" }]);
  assert.equal(existing.stock, "");
  assert.equal(invalid.stock, "abc");
});

test("missing WPS baseline recovers a pure addition but rejects existing-row changes", () => {
  const live = [
    { ...item("a", "A", 2), showroomQuantity: 1, computedTotalSold: 3, totalSold: 3, sellingPriceText: "S$ 200" },
    { ...item("b", "B", 4), showroomQuantity: 0, computedTotalSold: 5, totalSold: 5 },
  ];
  const addition = normalizeExcelRows([{
    id: "generated-addition-1",
    _excelGeneratedId: true,
    model: "11111",
    stock: 1,
    showroomQuantity: 1,
    computedTotalSold: 1,
    totalSold: 1,
    sourceRow: 331,
  }])[0];
  const recovered = recoverAdditiveWorkbookMerge({
    workbookRevision: 132,
    workbookExpectedItemCount: 2,
    liveRevision: 132,
    liveItems: live,
    excelRows: [...live, addition],
  });
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.created, [addition.id]);
  assert.deepEqual(recovered.updated, []);
  assert.deepEqual(recovered.deleted, []);

  const changed = recoverAdditiveWorkbookMerge({
    workbookRevision: 132,
    workbookExpectedItemCount: 2,
    liveRevision: 132,
    liveItems: live,
    excelRows: [{ ...live[0], stock: 99 }, live[1], addition],
  });
  assert.equal(changed, null);
});

test("missing WPS baseline idempotently recovers an addition already present in live", () => {
  const liveBefore = [
    { ...item("a", "A", 2), showroomQuantity: 1, computedTotalSold: 3, totalSold: 3 },
    { ...item("b", "B", 4), showroomQuantity: 0, computedTotalSold: 5, totalSold: 5 },
  ];
  const addition = normalizeExcelRows([{
    id: "generated-addition-2",
    _excelGeneratedId: true,
    model: "11111",
    stock: "",
    showroomQuantity: "",
    computedTotalSold: "",
    totalSold: "",
    sourceFile: "TEK-STOCK-LIVE.xlsx",
    sourceSheet: "库存总表",
    sourceRow: 331,
  }])[0];
  const liveAfter = [...liveBefore, { ...addition, _excelGeneratedId: false }];
  const recovered = recoverAdditiveWorkbookMerge({
    workbookRevision: 132,
    workbookExpectedItemCount: 2,
    liveRevision: 133,
    liveItems: liveAfter,
    excelRows: [...liveBefore, addition],
  });

  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.items, liveAfter);
  assert.deepEqual(recovered.created, []);
  assert.deepEqual(recovered.updated, []);
  assert.deepEqual(recovered.deleted, []);

  const mismatched = recoverAdditiveWorkbookMerge({
    workbookRevision: 132,
    workbookExpectedItemCount: 2,
    liveRevision: 133,
    liveItems: [...liveBefore, { ...addition, stock: 9, _excelGeneratedId: false }],
    excelRows: [...liveBefore, addition],
  });
  assert.equal(mismatched, null);
});

test("dispatch recovers rev132/326 workbook with 327 rows and a stale 327-record baseline", () => {
  const live = Array.from({ length: 326 }, (_, index) => ({
    ...item(`id-${index}`, `M-${index}`, index),
    showroomQuantity: 0,
    computedTotalSold: 0,
    totalSold: 0,
  }));
  const staleDeleted = item("stale-deleted", "OLD", 1);
  const addition = normalizeExcelRows([{
    id: "generated-addition-3",
    _excelGeneratedId: true,
    model: "11111",
    stock: "",
    showroomQuantity: "",
    computedTotalSold: "",
    totalSold: "",
    sourceFile: "TEK-STOCK-LIVE.xlsx",
    sourceSheet: "库存总表",
    sourceRow: 331,
  }])[0];
  const merged = mergeWorkbookSnapshot({
    workbookRevision: 132,
    workbookExpectedItemCount: 326,
    baselineRevision: 132,
    baselineItemCount: 327,
    baselineRecords: [...live, staleDeleted],
    liveRevision: 132,
    liveItems: live,
    excelRows: [...live, addition],
  });

  assert.equal(merged.ok, true);
  assert.equal(merged.items.length, 327);
  assert.deepEqual(merged.created, [addition.id]);
  assert.deepEqual(merged.updated, []);
  assert.deepEqual(merged.deleted, []);
  assert.equal(merged.items.at(-1).model, "11111");
  assert.equal(merged.items.at(-1).stock, 0);

  const liveAfterUpload = [...live, { ...addition, _excelGeneratedId: false }];
  const acknowledged = mergeWorkbookSnapshot({
    workbookRevision: 132,
    workbookExpectedItemCount: 326,
    baselineRevision: 132,
    baselineItemCount: 327,
    baselineRecords: [...live, staleDeleted],
    liveRevision: 133,
    liveItems: liveAfterUpload,
    excelRows: [...live, addition],
  });
  assert.equal(acknowledged.ok, true);
  assert.deepEqual(acknowledged.items, liveAfterUpload);
  assert.deepEqual(acknowledged.created, []);
  assert.deepEqual(acknowledged.updated, []);
  assert.deepEqual(acknowledged.deleted, []);
});

test("dispatch recovers a pure deletion with rev133/327 metadata and a repeated malformed baseline", () => {
  const live = Array.from({ length: 327 }, (_, index) => ({
    ...item(index === 126 ? "123456" : `id-${index}`, `M-${index}`, index),
    showroomQuantity: 0,
    computedTotalSold: 0,
    totalSold: 0,
  }));
  const excelRows = live.filter((row) => row.id !== "123456");
  const extraBaseline = [item("stale-a", "OLD-A", 1), item("stale-b", "OLD-B", 1)];
  const uniqueBaseline = [...live, ...extraBaseline];
  const repeatedBaseline = Array.from(
    { length: 1309 },
    (_, index) => uniqueBaseline[index % uniqueBaseline.length],
  );
  assert.equal(new Set(repeatedBaseline.map((row) => row.id)).size, 329);

  const merged = mergeWorkbookSnapshot({
    workbookRevision: 133,
    workbookExpectedItemCount: 327,
    baselineRevision: 133,
    baselineItemCount: 327,
    baselineRecords: repeatedBaseline,
    liveRevision: 133,
    liveItems: live,
    excelRows,
    workbookWasEdited: true,
    excelRowIdsUnique: true,
  });

  assert.equal(merged.ok, true);
  assert.equal(merged.items.length, 326);
  assert.deepEqual(merged.created, []);
  assert.deepEqual(merged.updated, []);
  assert.deepEqual(merged.deleted, ["123456"]);
  assert.equal(merged.items.some((row) => row.id === "123456"), false);
});

test("pure deletion recovery rejects every unsafe precondition", () => {
  const live = [item("keep", "KEEP", 2), item("delete", "DELETE", 1)];
  const safe = {
    workbookRevision: 7,
    workbookExpectedItemCount: 2,
    liveRevision: 7,
    liveItems: live,
    excelRows: [live[0]],
    workbookWasEdited: true,
    excelRowIdsUnique: true,
  };
  const rejected = [
    { ...safe, workbookRevision: 6 },
    { ...safe, workbookExpectedItemCount: 3 },
    { ...safe, workbookWasEdited: false },
    { ...safe, excelRowIdsUnique: false },
    { ...safe, excelRows: [{ ...live[0], stock: 9 }] },
    { ...safe, excelRows: [{ ...live[0], _excelGeneratedId: true }] },
  ];
  for (const input of rejected) {
    assert.equal(recoverPureDeletionWorkbookMerge(input), null);
  }
});

test("merges Excel and live changes made to different fields", () => {
  const baseline = item("a", "7788", 1, "old");
  const excel = { ...baseline, stock: 2 };
  const live = { ...baseline, specification: "cloud" };
  const merged = threeWayWorkbookMerge({
    baselineItems: new Map([["a", baseline]]),
    excelRows: [excel],
    liveItems: [live],
  });

  assert.equal(merged.ok, true);
  assert.deepEqual(merged.items, [{ ...live, stock: 2 }]);
  assert.deepEqual(merged.updated, ["a"]);
});

test("reports same-field conflicts atomically", () => {
  const baseline = item("a", "7788", 1);
  const live = [{ ...baseline, stock: 3 }, item("cloud", "9000", 4)];
  const merged = threeWayWorkbookMerge({
    baselineItems: { a: baseline },
    excelRows: [{ ...baseline, stock: 2 }],
    liveItems: live,
  });

  assert.equal(merged.ok, false);
  assert.deepEqual(merged.items, live);
  assert.deepEqual(merged.created, []);
  assert.deepEqual(merged.updated, []);
  assert.deepEqual(merged.deleted, []);
  assert.deepEqual(merged.conflicts, [
    { id: "a", field: "stock", reason: "field-modified-both" },
  ]);
});

test("deletes B-E only when live is unchanged and preserves L-B additions", () => {
  const baseline = item("a", "7788", 1);
  const cloudOnly = item("cloud", "9000", 4);
  const merged = threeWayWorkbookMerge({
    baselineItems: new Map([["a", baseline]]),
    excelRows: [],
    liveItems: [baseline, cloudOnly],
  });

  assert.equal(merged.ok, true);
  assert.deepEqual(merged.items, [cloudOnly]);
  assert.deepEqual(merged.deleted, ["a"]);
});

test("conflicts instead of deleting a live item changed since baseline", () => {
  const baseline = item("a", "7788", 1);
  const live = { ...baseline, stock: 2 };
  const merged = threeWayWorkbookMerge({
    baselineItems: { a: baseline },
    excelRows: [],
    liveItems: [live],
  });

  assert.equal(merged.ok, false);
  assert.deepEqual(merged.items, [live]);
  assert.deepEqual(merged.conflicts, [{ id: "a", reason: "delete-modified-live" }]);
});

test("deletes when an omitted live numeric zero is equivalent to the baseline zero", () => {
  const baseline = {
    ...item("a", "7788", 1),
    showroomQuantity: 0,
    computedTotalSold: 0,
    totalSold: 0,
  };
  const live = {
    ...baseline,
    totalSold: undefined,
  };
  const merge = threeWayWorkbookMerge({
    baselineItems: { a: baseline },
    excelRows: [],
    liveItems: [live],
  });

  assert.equal(merge.ok, true);
  assert.deepEqual(merge.deleted, ["a"]);
  assert.deepEqual(merge.conflicts, []);
});

test("generated additions keep their generated ID without identity dedupe", () => {
  const existing = item("cloud-id", "7788", 1);
  const addition = {
    ...item("excel-7788-generated", "7788", 2),
    _excelGeneratedId: true,
  };
  const merged = threeWayWorkbookMerge({
    baselineItems: {},
    excelRows: [addition],
    liveItems: [existing],
  });

  assert.equal(merged.ok, true);
  assert.deepEqual(merged.items.map((value) => value.id), ["cloud-id", "excel-7788-generated"]);
  assert.deepEqual(merged.created, ["excel-7788-generated"]);
});

test("an equal pre-existing generated ID is idempotent", () => {
  const addition = {
    ...item("excel-7788-generated", "7788", 2),
    _excelGeneratedId: true,
  };
  const merged = threeWayWorkbookMerge({
    baselineItems: {},
    excelRows: [addition],
    liveItems: [item("excel-7788-generated", "7788", 2)],
  });

  assert.equal(merged.ok, true);
  assert.deepEqual(merged.created, []);
  assert.equal(merged.items.length, 1);
});

test("a generated row with a blank optional number is idempotent with cloud zero", () => {
  const addition = {
    ...item("excel-123456-generated", "123456", 2),
    totalSold: null,
    _excelGeneratedId: true,
  };
  const merged = threeWayWorkbookMerge({
    baselineItems: {},
    excelRows: [addition],
    liveItems: [{ ...addition, totalSold: 0, _excelGeneratedId: false }],
  });

  assert.equal(merged.ok, true);
  assert.deepEqual(merged.created, []);
  assert.equal(merged.items.length, 1);
});

test("an Excel field change already present in live data is idempotent", () => {
  const baseline = item("a", "5555", 1);
  const alreadyApplied = { ...baseline, stock: 2 };
  const merged = threeWayWorkbookMerge({
    baselineItems: { a: baseline },
    excelRows: [alreadyApplied],
    liveItems: [alreadyApplied],
  });

  assert.equal(merged.ok, true);
  assert.deepEqual(merged.updated, []);
  assert.deepEqual(merged.items, [alreadyApplied]);
});

test("an unchanged embedded Excel photo does not conflict with a hosted cloud URL", () => {
  const baseline = {
    ...item("a", "5555", 1),
    image: "assets/images/edited-chair.webp",
    imageHash: "same-photo-hash",
  };
  const excel = {
    ...baseline,
    image: "",
    embeddedImageHash: "same-photo-hash",
    imageChanged: false,
    imageUntracked: false,
  };
  const live = {
    ...baseline,
    image: "https://tek-stock-sync.test/image/chair",
  };
  const merged = threeWayWorkbookMerge({
    baselineItems: { a: baseline },
    excelRows: [excel],
    liveItems: [live],
  });

  assert.equal(merged.ok, true);
  assert.deepEqual(merged.updated, []);
  assert.deepEqual(merged.items, [live]);
});

test("an explicitly replaced Excel photo is applied without comparing storage URLs", () => {
  const baseline = {
    ...item("a", "5555", 1),
    image: "assets/images/edited-chair.webp",
  };
  const excel = {
    ...baseline,
    image: "data:image/webp;base64,changed",
    imageChanged: true,
  };
  const live = {
    ...baseline,
    image: "https://tek-stock-sync.test/image/previous",
  };
  const merged = threeWayWorkbookMerge({
    baselineItems: { a: baseline },
    excelRows: [excel],
    liveItems: [live],
  });

  assert.equal(merged.ok, true);
  assert.deepEqual(merged.updated, ["a"]);
  assert.equal(merged.items[0].image, excel.image);
});

test("independent Excel and cloud photo replacements conflict by canonical hash", () => {
  const baseline = {
    ...item("a", "5555", 1),
    image: "photos/a/original.webp",
    imageSha256: "a".repeat(64),
    imageVersion: "sha256-aaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const excel = {
    ...baseline,
    image: "data:image/webp;base64,excel-photo",
    imageSha256: "b".repeat(64),
    imageVersion: "sha256-bbbbbbbbbbbbbbbbbbbbbbbb",
    imageChanged: true,
  };
  const live = {
    ...baseline,
    image: "photos/a/cloud.webp",
    imageSha256: "c".repeat(64),
    imageVersion: "sha256-cccccccccccccccccccccccc",
  };

  const merged = threeWayWorkbookMerge({
    baselineItems: { a: baseline },
    excelRows: [excel],
    liveItems: [live],
  });

  assert.equal(merged.ok, false);
  assert.deepEqual(merged.conflicts, [
    { id: "a", field: "image", reason: "field-modified-both" },
  ]);
  assert.deepEqual(merged.items, [live]);
});

test("the same canonical photo hash is idempotent despite different storage keys", () => {
  const baseline = {
    ...item("a", "5555", 1),
    image: "photos/a/original.webp",
    imageSha256: "a".repeat(64),
    imageVersion: "sha256-aaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const excel = {
    ...baseline,
    image: "data:image/webp;base64,same-photo",
    imageSha256: "b".repeat(64),
    imageVersion: "sha256-bbbbbbbbbbbbbbbbbbbbbbbb",
    imageChanged: true,
  };
  const live = {
    ...baseline,
    image: "photos/a/another-object-key.webp",
    imageSha256: "b".repeat(64),
    imageVersion: "server-version-does-not-matter-when-hash-matches",
  };

  const merged = threeWayWorkbookMerge({
    baselineItems: { a: baseline },
    excelRows: [excel],
    liveItems: [live],
  });

  assert.equal(merged.ok, true);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.items, [live]);
});

test("delete ignores source-row locator drift because row numbers are not identity", () => {
  const baseline = { ...item("a", "5555", 1), sourceRow: 5 };
  const live = { ...baseline, sourceRow: 9 };

  const merged = threeWayWorkbookMerge({
    baselineItems: { a: baseline },
    excelRows: [],
    liveItems: [live],
  });

  assert.equal(merged.ok, true);
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.items, []);
});

test("delete fails closed when canonical cloud photo metadata changed remotely", () => {
  const baseline = {
    ...item("a", "5555", 1),
    image: "photos/a/original.webp",
    imageSha256: "a".repeat(64),
    imageVersion: "sha256-aaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const live = {
    ...baseline,
    image: "photos/a/replacement.webp",
    imageSha256: "b".repeat(64),
    imageVersion: "sha256-bbbbbbbbbbbbbbbbbbbbbbbb",
  };

  const merged = threeWayWorkbookMerge({
    baselineItems: { a: baseline },
    excelRows: [],
    liveItems: [live],
  });

  assert.equal(merged.ok, false);
  assert.deepEqual(merged.conflicts, [{ id: "a", reason: "delete-modified-live" }]);
  assert.deepEqual(merged.items, [live]);
});

test("a different pre-existing generated ID is an atomic conflict", () => {
  const addition = {
    ...item("excel-7788-generated", "7788", 2),
    _excelGeneratedId: true,
  };
  const live = [item("excel-7788-generated", "7788", 9), item("cloud", "9000", 1)];
  const merged = threeWayWorkbookMerge({
    baselineItems: {},
    excelRows: [addition],
    liveItems: live,
  });

  assert.equal(merged.ok, false);
  assert.deepEqual(merged.items, live);
  assert.deepEqual(merged.conflicts, [
    { id: "excel-7788-generated", reason: "addition-id-collision" },
  ]);
});
