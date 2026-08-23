const assert = require("node:assert/strict");
const test = require("node:test");
const { createSyncTrace, normalizeSyncFailure } = require("../sync-trace.cjs");

test("sync trace records four boundaries and preserves a readable bridge failure", () => {
  const trace = createSyncTrace("5566-TEST");
  trace.record("app", { model: "5566-TEST", itemCount: 1 });
  trace.record("ipc", { method: "tek-stock-cloud-sync-workbook", status: "entered" });
  trace.record("excel-bridge", { path: "isolated/TEK-STOCK-5566-TEST.xlsx", sheet: "库存总表", status: "failed", errorCode: "EXCEL_BINDING_FAILED" });
  trace.record("workbook", { expectedModel: "5566-TEST", actualModel: "" });
  const result = trace.finish({ ok: false, errorCode: "EXCEL_BINDING_FAILED" });
  assert.equal(result.ok, false);
  assert.equal(result.traceId, trace.traceId);
  assert.deepEqual(result.failedStage, "excel-bridge");
  assert.equal(result.errorCode, "EXCEL_BINDING_FAILED");
  assert.equal(result.stages.length, 4);
});

test("remote errors become structured failures instead of generic invocation text", () => {
  const trace = createSyncTrace("5566-TEST");
  const failure = normalizeSyncFailure(new Error("Error invoking remote method 'tek-stock-cloud-sync-workbook': Excel binding failed"), trace);
  assert.equal(failure.ok, false);
  assert.equal(failure.traceId, trace.traceId);
  assert.equal(failure.errorCode, "EXCEL_BINDING_FAILED");
  assert.match(failure.message, /Excel/);
});

test("workbook identity failures preserve only bounded conflict evidence", () => {
  const trace = createSyncTrace("COPIED-AS-NEW");
  const error = Object.assign(new Error("WORKBOOK_ID_CONFLICT"), {
    code: "WORKBOOK_ID_CONFLICT",
    conflicts: [{ id: "existing-row", reason: "duplicate-id", sourceRows: [5, 6] }],
  });
  const failure = normalizeSyncFailure(error, trace);
  assert.equal(failure.errorCode, "WORKBOOK_ID_CONFLICT");
  assert.deepEqual(failure.conflicts, [
    { id: "existing-row", reason: "duplicate-id", sourceRows: [5, 6] },
  ]);
  assert.match(failure.message, /duplicate/i);
});
