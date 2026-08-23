"use strict";

const crypto = require("node:crypto");

const CLOUD_RESET_LOCAL_CONFIRMATION = "TEK-STOCK-CLOUD-RESET-LOCAL-CONFIRMED";

function resetError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function isRevision(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

function validateLiveSnapshot(snapshot, expectedAuthorityId = "") {
  if (snapshot?.cloudState !== "live") throw resetError("CLOUD_RESET_LIVE_SNAPSHOT_REQUIRED");
  if (!isRevision(snapshot.revision)) throw resetError("CLOUD_RESET_REVISION_INVALID");
  if (!Array.isArray(snapshot.items)) throw resetError("CLOUD_RESET_ITEMS_INVALID");
  if (expectedAuthorityId && snapshot.authorityId !== undefined
      && String(snapshot.authorityId || "") !== expectedAuthorityId) {
    throw resetError("CLOUD_RESET_AUTHORITY_MISMATCH");
  }
  const ids = new Set();
  for (const item of snapshot.items) {
    const id = String(item?.id || "").trim();
    if (!id || ids.has(id)) throw resetError("CLOUD_RESET_ITEM_ID_INVALID");
    ids.add(id);
  }
  if (snapshot.itemCount !== undefined && Number(snapshot.itemCount) !== snapshot.items.length) {
    throw resetError("CLOUD_RESET_ITEM_COUNT_INVALID");
  }
  return snapshot;
}

function createCloudResetLocalRunner(deps = {}) {
  const required = [
    "readLiveSnapshot", "readWorkbook", "backupLocalState", "buildReplacement",
    "replaceWorkbook", "archiveSyncState", "initializeFreshSyncState", "verify", "acquireLock",
  ];
  if (required.some((name) => typeof deps[name] !== "function")) {
    throw new TypeError("CLOUD_RESET_LOCAL_DEPENDENCIES_INVALID");
  }
  const expectedAuthorityId = String(deps.expectedAuthorityId || "").trim();
  const now = deps.now || (() => new Date().toISOString());
  const randomUUID = deps.randomUUID || crypto.randomUUID;
  const reload = typeof deps.reload === "function" ? deps.reload : async () => {};

  return async function run(input = {}) {
    if (input.confirmation !== CLOUD_RESET_LOCAL_CONFIRMATION) {
      throw resetError("CLOUD_RESET_CONFIRMATION_REQUIRED");
    }
    const runId = String(input.runId || randomUUID()).trim();
    if (!runId) throw resetError("CLOUD_RESET_RUN_ID_REQUIRED");

    const release = await deps.acquireLock({ runId });
    if (typeof release !== "function") throw resetError("CLOUD_RESET_LOCK_INVALID");
    try {

    let before;
    try {
      before = await deps.readWorkbook();
    } catch (error) {
      throw resetError("CLOUD_RESET_WORKBOOK_READ_FAILED", { causeCode: String(error?.code || "") });
    }
    if (!before?.ok) throw resetError("CLOUD_RESET_WORKBOOK_READ_FAILED");
    let live;
    try {
      live = validateLiveSnapshot(await deps.readLiveSnapshot(), expectedAuthorityId);
    } catch (error) {
      if (error?.code?.startsWith("CLOUD_RESET_")) throw error;
      throw resetError("CLOUD_RESET_LIVE_SNAPSHOT_FAILED", { causeCode: String(error?.code || "") });
    }
    let backup;
    try {
      backup = await deps.backupLocalState({ runId, before, live, createdAt: now() });
    } catch (error) {
      throw resetError("CLOUD_RESET_BACKUP_FAILED", {
        backupPath: String(error?.backupPath || ""),
        causeCode: String(error?.code || ""),
      });
    }
    if (!backup?.ok) throw resetError("CLOUD_RESET_BACKUP_FAILED", { backupPath: backup?.path || "" });

    let replacement;
    let replaced = false;
    try {
      replacement = await deps.buildReplacement({ runId, live, before, backup });
      if (!replacement?.ok || !replacement.workbook?.ok
          || !Array.isArray(replacement.workbook.items)) {
        throw resetError("CLOUD_RESET_REPLACEMENT_INVALID");
      }
      const replacementIds = replacement.workbook.items.map((item) => String(item.id || "")).sort();
      const liveIds = live.items.map((item) => String(item.id || "")).sort();
      if (JSON.stringify(replacementIds) !== JSON.stringify(liveIds)
          || Number(replacement.workbook.sync?.revision) !== Number(live.revision)
          || Number(replacement.workbook.sync?.itemCount) !== live.items.length
          || replacement.workbook.items.length !== live.items.length) {
        throw resetError("CLOUD_RESET_REPLACEMENT_MISMATCH");
      }
      backup.replacementSha256 = String(replacement.workbook.sha256 || "");
      await deps.replaceWorkbook({
        runId,
        replacement,
        expectedSha256: String(before.sha256 || ""),
        backup,
      });
      replaced = true;
      await deps.archiveSyncState({ runId, backup, live });
      await deps.initializeFreshSyncState({ runId, live, backup });
      const verified = await deps.verify({ runId, live, backup, replacement });
      if (!verified?.ok) throw resetError("CLOUD_RESET_VERIFICATION_FAILED");
      await reload({ runId, revision: Number(live.revision), itemCount: live.items.length });
      return {
        ok: true,
        runId,
        backupPath: backup.path,
        workbookPath: replacement.path,
        revision: Number(live.revision),
        itemCount: live.items.length,
        cloudWrites: 0,
      };
    } catch (error) {
      if (!replaced && replacement?.path && typeof deps.discardReplacement === "function") {
        try { await deps.discardReplacement({ replacement }); } catch {}
      }
      if (replaced && typeof deps.rollback === "function") {
        try {
          await deps.rollback({ runId, backup, replacement, error });
        } catch (rollbackError) {
          error.rollbackErrorCode = rollbackError.code || "CLOUD_RESET_ROLLBACK_FAILED";
        }
      }
      if (error.code) throw error;
      throw resetError("CLOUD_RESET_FAILED", { causeCode: String(error.message || "UNKNOWN") });
    }
    } finally {
      release();
    }
  };
}

module.exports = {
  CLOUD_RESET_LOCAL_CONFIRMATION,
  createCloudResetLocalRunner,
  validateLiveSnapshot,
};
