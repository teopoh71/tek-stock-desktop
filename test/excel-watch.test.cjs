"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildWorkbook,
  isRetryableWorkbookSyncError,
  isSelfWrittenWorkbook,
  processObservedWorkbookChange,
  readWorkbookFile,
  workbookChangeDelay,
} = require("../main.cjs");
const { hasMeaningfulWorkbookChanges } = require("../inventory/excel-sync-core.js");

test("a workbook save during acknowledgement suppression is deferred, not discarded", () => {
  assert.equal(workbookChangeDelay(1_000, 3_500), 2_500);
  assert.equal(workbookChangeDelay(3_500, 3_500), 0);
  assert.equal(workbookChangeDelay(4_000, 3_500), 0);
});

test("a self-written acknowledgement is ignored but a later user save is synchronized", () => {
  assert.equal(isSelfWrittenWorkbook("abc123", "ABC123"), true);
  assert.equal(isSelfWrittenWorkbook("user-edit", "ack-write"), false);
  assert.equal(isSelfWrittenWorkbook("", "ack-write"), false);
});

test("a save observed while Office is still flushing is retried", () => {
  assert.equal(isRetryableWorkbookSyncError({ code: "EXCEL_CHANGED_DURING_READ" }), true);
  assert.equal(isRetryableWorkbookSyncError(new Error("OPEN_WORKBOOK_AUTOMATION_UNAVAILABLE")), true);
  assert.equal(isRetryableWorkbookSyncError({ code: "ETIMEDOUT" }), true);
  assert.equal(isRetryableWorkbookSyncError({ code: "UPDATE_HTTP_503" }), true);
  assert.equal(isRetryableWorkbookSyncError({ code: "WORKBOOK_REFRESH_PENDING" }), true);
  assert.equal(isRetryableWorkbookSyncError({ code: "WORKBOOK_CONTENT_CHANGED" }), true);
  assert.equal(isRetryableWorkbookSyncError({ code: "WORKBOOK_UNSAVED_CHANGES" }), true);
  assert.equal(isRetryableWorkbookSyncError(new Error("UNAUTHORIZED")), false);
});

test("an unchanged Excel open/save rewrite stays acknowledged and does not notify pending", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-semantic-save-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const payload = {
    items: [{ id: "chair-1", category: "Chair", model: "CHAIR ONE", stock: 4 }],
    sync: { revision: 184, updatedAt: "2026-08-05T00:00:00.000Z" },
  };
  const workbook = await buildWorkbook(payload);
  await workbook.xlsx.writeFile(file);
  const before = await readWorkbookFile(file);
  assert.equal(before.hasUnacknowledgedChanges, false);

  const reopened = new (require("exceljs").Workbook)();
  await reopened.xlsx.readFile(file);
  reopened.modified = new Date("2026-08-05T08:00:00.000Z");
  await reopened.xlsx.writeFile(file);
  const after = await readWorkbookFile(file);
  assert.notEqual(after.sha256, before.sha256);
  assert.equal(after.semanticFingerprint, before.semanticFingerprint);
  assert.equal(after.hasUnacknowledgedChanges, false);

  let notifications = 0;
  const observed = await processObservedWorkbookChange(file, after.mtimeMs, {
    selfWrittenSha256: before.sha256,
    onChanged: () => { notifications += 1; },
  });
  assert.equal(observed.ignored, true);
  assert.equal(notifications, 0);
  assert.equal(hasMeaningfulWorkbookChanges(after), false);
});

test("a real inventory cell edit is meaningful and still notifies pending sync", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-semantic-edit-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workbook = await buildWorkbook({
    items: [{ id: "chair-1", category: "Chair", model: "CHAIR ONE", stock: 4 }],
    sync: { revision: 184, updatedAt: "2026-08-05T00:00:00.000Z" },
  });
  await workbook.xlsx.writeFile(file);
  const acknowledged = await readWorkbookFile(file);

  const edited = new (require("exceljs").Workbook)();
  await edited.xlsx.readFile(file);
  edited.getWorksheet("\u5e93\u5b58\u603b\u8868").getCell("E5").value = 9;
  await edited.xlsx.writeFile(file);
  const changed = await readWorkbookFile(file);
  assert.equal(changed.hasUnacknowledgedChanges, true);
  assert.notEqual(changed.semanticFingerprint, acknowledged.semanticFingerprint);

  let notification;
  const observed = await processObservedWorkbookChange(file, changed.mtimeMs, {
    selfWrittenSha256: acknowledged.sha256,
    onChanged: (...args) => { notification = args; },
  });
  assert.equal(observed.ignored, false);
  assert.deepEqual(notification, [file, changed.mtimeMs]);
  assert.equal(hasMeaningfulWorkbookChanges(changed), true);
});

test("older renderer payloads retain the mtime fallback", () => {
  assert.equal(hasMeaningfulWorkbookChanges({
    mtimeMs: 5_000,
    sync: { writtenAt: new Date(1_000).toISOString() },
  }), true);
  assert.equal(hasMeaningfulWorkbookChanges({
    hasUnacknowledgedChanges: false,
    mtimeMs: 5_000,
    sync: { writtenAt: new Date(1_000).toISOString() },
  }), false);
});
