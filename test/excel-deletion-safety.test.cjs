"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  canApplyWorkbookDeletions,
  discardLegacyDeletionTombstones,
  sanitizeDeletionTombstones,
} = require("../inventory/excel-sync-core.js");

const appSource = fs.readFileSync(path.join(__dirname, "..", "inventory", "app.js"), "utf8");

test("a newly saved stale workbook reaches guarded deletion instead of returning early", () => {
  assert.match(appSource, /if\s*\(!workbookWasEdited\)\s*\{[\s\S]*?return\s*\{\s*ok:\s*true,\s*changed:\s*0,\s*uploaded:\s*false,\s*stale:\s*true\s*\}/);
  assert.doesNotMatch(appSource, /const snapshotCanDelete\s*=\s*!staleEditedWorkbook/);
  assert.match(appSource, /const snapshotCanDelete\s*=\s*cloudDataState\s*===\s*"live"\s*&&\s*excelSyncCore\.canApplyWorkbookDeletions/);
});

test("a newly saved workbook may delete an item even when acknowledgement metadata is stale", () => {
  assert.equal(canApplyWorkbookDeletions({
    lastRemoteRevision: 55,
    workbookRevision: 53,
    workbookMtimeMs: Date.parse("2026-07-29T06:58:02.192Z"),
    lastRemoteUpdatedAt: Date.parse("2026-07-29T06:55:28.864Z"),
    workbookExpectedItemCount: 325,
    remoteItemCount: 325,
  }), true);
});

test("an untouched stale workbook cannot delete newer cloud items", () => {
  assert.equal(canApplyWorkbookDeletions({
    lastRemoteRevision: 55,
    workbookRevision: 53,
    workbookMtimeMs: Date.parse("2026-07-29T06:50:00.000Z"),
    lastRemoteUpdatedAt: Date.parse("2026-07-29T06:55:28.864Z"),
    workbookExpectedItemCount: 325,
    remoteItemCount: 325,
  }), false);
});

test("matching workbook revision remains authoritative for deletion", () => {
  assert.equal(canApplyWorkbookDeletions({
    lastRemoteRevision: 55,
    workbookRevision: 55,
    workbookMtimeMs: 1,
    lastRemoteUpdatedAt: 2,
    workbookExpectedItemCount: 325,
    remoteItemCount: 325,
  }), true);
});

test("matching revision cannot delete from an incomplete older workbook snapshot", () => {
  assert.equal(canApplyWorkbookDeletions({
    lastRemoteRevision: 88,
    workbookRevision: 88,
    workbookMtimeMs: Date.parse("2026-07-30T02:20:00.000Z"),
    lastRemoteUpdatedAt: Date.parse("2026-07-30T02:18:40.528Z"),
    workbookExpectedItemCount: 318,
    remoteItemCount: 325,
  }), false);
});

test("missing workbook baseline count fails closed", () => {
  assert.equal(canApplyWorkbookDeletions({
    lastRemoteRevision: 88,
    workbookRevision: 88,
    workbookMtimeMs: 3,
    lastRemoteUpdatedAt: 2,
    workbookExpectedItemCount: 0,
    remoteItemCount: 325,
  }), false);
});

test("legacy pending deletion tombstones are discarded without losing normal edits", () => {
  assert.deepEqual(discardLegacyDeletionTombstones({
    "row-93": { stock: 1 },
    "row-94": { _deleteProduct: true },
    "row-95": { model: "TEST", _newProduct: true },
  }), {
    edits: {
      "row-93": { stock: 1 },
      "row-95": { model: "TEST", _newProduct: true },
    },
    removed: 1,
  });
});

test("pending deletion survives only against its exact cloud baseline", () => {
  const source = {
    "row-93": { stock: 1 },
    "row-94": {
      _deleteProduct: true,
      _deleteBaselineRevision: 88,
      _deleteBaselineItemCount: 325,
    },
  };
  assert.deepEqual(sanitizeDeletionTombstones(source, {
    remoteRevision: 88,
    remoteItemCount: 325,
  }), { edits: source, removed: 0 });
  assert.deepEqual(sanitizeDeletionTombstones(source, {
    remoteRevision: 89,
    remoteItemCount: 326,
  }), {
    edits: { "row-93": { stock: 1 } },
    removed: 1,
  });
});
