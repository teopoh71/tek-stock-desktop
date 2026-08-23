"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const test = require("node:test");
const { syncWorkbookWithCentralCloudIpc } = require("../main.cjs");

test("cloud sync IPC converts an escaped main-process error into a cloneable failure", async () => {
  const result = await syncWorkbookWithCentralCloudIpc({
    syncWorkbook: async () => {
      const error = new Error("CLOUD_SNAPSHOT_INVALID");
      error.code = "CLOUD_SNAPSHOT_INVALID";
      error.snapshotField = "items";
      throw error;
    },
    appendDiagnostic: () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "CLOUD_SNAPSHOT_INVALID");
  assert.equal(result.snapshotField, "items");
  assert.match(result.traceId, /^sync-/);
  assert.doesNotThrow(() => structuredClone(result));
});

test("cloud sync IPC preserves an existing structured result", async () => {
  const expected = {
    ok: false,
    errorCode: "WORKBOOK_MERGE_CONFLICT",
    traceId: "sync-20260811000000-12345678",
    workbookAcknowledged: false,
  };

  assert.deepEqual(await syncWorkbookWithCentralCloudIpc({
    syncWorkbook: async () => expected,
  }), expected);
});

test("cloud sync IPC bounds a delete-and-add result before Electron clones it", async () => {
  const result = await syncWorkbookWithCentralCloudIpc({
    syncWorkbook: async () => ({
      ok: true,
      errorCode: "",
      traceId: "sync-20260815000000-88887777",
      revision: 269,
      cloudRevision: 269,
      operations: 2,
      assignments: 1,
      workbookAcknowledged: true,
      workbookReplaced: false,
      message: "Deleted 777 and added 8888",
      // A successful sync receipt must never leak workbook/service internals
      // across Electron IPC, even if an upstream path accidentally adds them.
      workbook: { rows: Array.from({ length: 400 }, () => ({ model: "8888" })) },
      cleanup: () => {},
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    errorCode: "",
    traceId: "sync-20260815000000-88887777",
    revision: 269,
    cloudRevision: 269,
    operations: 2,
    assignments: 1,
    workbookAcknowledged: true,
    workbookReplaced: false,
    message: "Deleted 777 and added 8888",
  });
  assert.doesNotThrow(() => structuredClone(result));
});
