"use strict";
// Shared by the desktop sender and receiver. Never accept free-form log text.
const SAFE_CODES = new Set([
  "UNKNOWN_ERROR", "API_NETWORK_UNREACHABLE", "CLOUD_UNAVAILABLE", "CLOUD_DOWNLOAD_FAILED", "CLOUD_UPLOAD_FAILED",
  "UNAUTHORIZED", "SYNC_FAILED", "SYNC_RESOLUTION_FAILED", "SYNC_RESOLUTION_CONFLICT", "WORKBOOK_SYNC_FAILED",
  "WORKBOOK_SYNC_IPC_FAILED", "WORKBOOK_MIGRATION_REVIEW", "WORKBOOK_ID_CONFLICT", "WORKBOOK_UNSAVED_CHANGES",
  "WORKBOOK_CONTENT_CHANGED", "WORKBOOK_REFRESH_PENDING", "WORKBOOK_MIGRATION_FAILED", "EXCEL_BINDING_FAILED",
  "EXCEL_WORKBOOK_FAILED", "EXCEL_PREPARE_FAILED", "EXCEL_INVALID_STOCK", "EXCEL_THREE_WAY_CONFLICT",
  "UPDATE_FAILED", "UPDATE_NETWORK_TIMEOUT", "UPDATE_NETWORK_FAILED", "UPDATE_MANIFEST_UNAVAILABLE",
  "UPDATE_SHA256_MISMATCH", "UPDATE_SHA256_INVALID", "UPDATE_INSTALLER_FAILED", "UPDATE_INSTALLER_LAUNCH_FAILED",
  "UPDATE_BACKUP_FAILED", "UPDATE_BUSY", "UPDATE_PENDING_SYNC", "UPDATE_DOWNGRADE_BLOCKED", "UPDATE_ALREADY_RUNNING",
  "UPDATE_STATE_UNAVAILABLE", "ENOSPC", "EBUSY", "EPERM", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND",
  "EXCEL_ACK_FAILED", "EXCEL_IMPORT_FAILED", "EXCEL_CHANGED_DURING_READ", "EXCEL_CHANGED_DURING_UPLOAD",
  "EXCEL_STALE_BASELINE_MISSING", "EXCEL_CLOUD_REVISION_CONFLICT", "EXCEL_CLOUD_HTTP_409",
  "EXCEL_CLOUD_HTTP_412", "CLOUD_SNAPSHOT_INVALID", "CLOUD_HTTP_401", "CLOUD_HTTP_403", "CLOUD_HTTP_409",
  "CLOUD_HTTP_429", "CLOUD_HTTP_500", "CLOUD_HTTP_502", "CLOUD_HTTP_503", "CLOUD_HTTP_504",
  "NETWORK_FAILED", "NETWORK_TIMEOUT", "AUTH_REQUIRED", "AUTH_REJECTED", "WORKBOOK_MERGE_CONFLICT",
  "WORKBOOK_MIGRATION_CLOUD_CHANGED",
  "SYNC_TOKEN_MISSING", "SYNC_TOKEN_INVALID", "API_REQUEST_TIMEOUT", "API_RESPONSE_JSON_INVALID", "API_AUTHORITY_MISMATCH",
  "API_BASE_URL_MISSING", "API_BASE_URL_INVALID", "API_FALLBACK_URLS_INVALID", "API_AUTHORITY_ID_MISSING",
  "API_AUTHORITY_ID_INVALID", "API_REQUEST_FAILED", "CLOUD_CACHE_UNAVAILABLE",
]);
const STAGES = new Set(["excel_sync_ipc", "cloud_upload", "cloud_download", "excel_import", "excel_ack", "daily_health",
  "excel_sync",
  "refresh_started", "refresh_succeeded", "refresh_failed", "refresh_cached", "sync_started", "sync_succeeded", "sync_failed",
  "update.manifest", "update.download", "update.backup", "update.launch", "app.error", "app.rejection", "unknown"]);
const DEVICE_ID = /^d-[a-f0-9]{32}$/;
const AUTHORITY_ID = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(number)) : undefined;
}
function safeEvent(input = {}) {
  const date = new Date(input.timestamp);
  const code = String(input.errorCode || "").toUpperCase();
  const event = {
    timestamp: Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(),
    appVersion: /^\d+\.\d+\.\d+$/.test(String(input.appVersion)) ? String(input.appVersion).slice(0, 32) : "unknown",
    stage: STAGES.has(input.stage) ? input.stage : "unknown",
    ok: input.ok === true,
    errorCode: input.ok === true ? "" : SAFE_CODES.has(code) || /^HTTP_[45]\d\d$/.test(code) ? code : "UNKNOWN_ERROR",
  };
  if (DEVICE_ID.test(String(input.deviceId || ""))) event.deviceId = String(input.deviceId);
  if (AUTHORITY_ID.test(String(input.authorityId || ""))) event.authorityId = String(input.authorityId);
  const revision = safeNumber(input.revision); if (revision !== undefined) event.revision = revision;
  const pending = safeNumber(input.pending); if (pending !== undefined) event.pending = pending;
  const eventSequence = safeNumber(input.eventSequence); if (eventSequence !== undefined) event.eventSequence = eventSequence;
  if (input.recovered === true && event.ok) event.recovered = true;
  return event;
}
module.exports = { safeEvent };
