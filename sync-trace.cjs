"use strict";

const crypto = require("node:crypto");

const STAGES = ["app", "ipc", "excel-bridge", "workbook"];

function createTraceId() {
  return `sync-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(4).toString("hex")}`;
}

function safeValue(value) {
  if (value == null) return value;
  if (typeof value === "string") return value.slice(0, 240);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(safeValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, entry]) => [key, safeValue(entry)]));
  }
  return String(value).slice(0, 240);
}

function errorCode(error) {
  const detail = String(error?.errorCode || error?.code || error?.message || "SYNC_FAILED");
  if (/EXCEL_BINDING|binding/i.test(detail)) return "EXCEL_BINDING_FAILED";
  if (/WORKBOOK_(?:READ|REPLACE|CONTENT|UNSAVED)|EXCEL_LIVE/i.test(detail)) return "EXCEL_WORKBOOK_FAILED";
  if (/UNAUTHORIZED|401|TOKEN/i.test(detail)) return "UNAUTHORIZED";
  return detail.replace(/[^A-Z0-9_.-]/gi, "_").slice(0, 80) || "SYNC_FAILED";
}

function readableMessage(code) {
  if (code === "EXCEL_BINDING_FAILED") return "Excel bridge failed to write or verify the workbook";
  if (code === "EXCEL_WORKBOOK_FAILED") return "Excel workbook could not be read, saved, or verified";
  if (code === "WORKBOOK_ID_CONFLICT") return "Excel contains duplicate or invalid product IDs; cloud data was not changed";
  if (code === "UNAUTHORIZED") return "Cloud sync authorization was rejected";
  return "Cloud sync failed; use the trace ID to retry or inspect diagnostics";
}

function safeConflicts(conflicts) {
  return Array.isArray(conflicts) ? conflicts.slice(0, 10).map((conflict) => ({
    id: String(conflict?.id || "").slice(0, 128),
    reason: String(conflict?.reason || "unknown").slice(0, 80),
    sourceRows: Array.isArray(conflict?.sourceRows)
      ? conflict.sourceRows.map(Number).filter((row) => Number.isSafeInteger(row) && row > 0).slice(0, 20)
      : [],
  })) : [];
}

function createSyncTrace(model = "") {
  const traceId = createTraceId();
  const stages = [];
  return {
    traceId,
    record(stage, detail = {}) {
      if (!STAGES.includes(stage)) throw new Error(`SYNC_TRACE_STAGE_INVALID:${stage}`);
      stages.push({ stage, at: new Date().toISOString(), ...safeValue(detail) });
    },
    finish(result = {}) {
      const failure = result.ok === false;
      const failedStage = failure
        ? stages.findLast((entry) => entry.errorCode || entry.status === "failed")?.stage || "unknown"
        : "";
      const code = failure ? errorCode(result) : "";
      return {
        ...safeValue(result),
        ok: !failure,
        traceId,
        model: String(model || "").slice(0, 120),
        stages: stages.map(safeValue),
        failedStage,
        errorCode: code,
        message: failure ? readableMessage(code) : String(result.message || "Sync completed"),
      };
    },
  };
}

function normalizeSyncFailure(error, trace) {
  const code = errorCode(error);
  const conflicts = safeConflicts(error?.conflicts);
  const snapshotField = ["root", "items", "revision", "changeSequence"]
    .includes(error?.snapshotField) ? error.snapshotField : undefined;
  const result = trace.finish({
    ok: false,
    errorCode: code,
    detail: String(error?.message || error || "").replace(/Error invoking remote method[^:]*:\s*/i, "").slice(0, 240),
    ...(conflicts.length ? { conflicts } : {}),
    ...(snapshotField ? { snapshotField } : {}),
  });
  return { ...result, message: readableMessage(code) };
}

function sanitizeWorkbookSyncIpcResult(value) {
  const input = value && typeof value === "object" ? value : {};
  const output = {};
  const booleanFields = ["ok", "conflict", "retryRequired", "workbookAcknowledged", "workbookReplaced"];
  const numberFields = ["revision", "cloudRevision", "operations", "photos", "assignments", "droppedLegacyRows"];
  const stringLimits = {
    errorCode: 80,
    traceId: 80,
    model: 120,
    failedStage: 40,
    message: 240,
    detail: 240,
    snapshotField: 40,
  };
  for (const field of booleanFields) {
    if (typeof input[field] === "boolean") output[field] = input[field];
  }
  for (const field of numberFields) {
    if (Number.isFinite(Number(input[field]))) output[field] = Number(input[field]);
  }
  for (const [field, limit] of Object.entries(stringLimits)) {
    if (typeof input[field] === "string") output[field] = input[field].slice(0, limit);
  }
  if (Array.isArray(input.conflicts)) output.conflicts = safeConflicts(input.conflicts);
  return output;
}

module.exports = {
  STAGES,
  createSyncTrace,
  normalizeSyncFailure,
  readableMessage,
  sanitizeWorkbookSyncIpcResult,
};
