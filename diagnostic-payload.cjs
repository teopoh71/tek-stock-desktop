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
]);
const STAGES = new Set(["excel_sync_ipc", "cloud_upload", "cloud_download", "excel_import", "excel_ack", "daily_health",
  "update.manifest", "update.download", "update.backup", "update.launch", "app.error", "app.rejection", "unknown"]);
function safeEvent(input = {}) {
  const date = new Date(input.timestamp);
  const code = String(input.errorCode || "").toUpperCase();
  return {
    timestamp: Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(),
    appVersion: /^\d+\.\d+\.\d+$/.test(String(input.appVersion)) ? String(input.appVersion).slice(0, 32) : "unknown",
    stage: STAGES.has(input.stage) ? input.stage : "unknown",
    ok: input.ok === true,
    errorCode: input.ok === true ? "" : SAFE_CODES.has(code) || /^HTTP_[45]\d\d$/.test(code) ? code : "UNKNOWN_ERROR",
  };
}
module.exports = { safeEvent };
