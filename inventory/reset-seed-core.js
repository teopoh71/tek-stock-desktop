"use strict";

const crypto = require("node:crypto");

const RESET_SEED_CONFIRMATION = "TEK-STOCK-RESET-SEED-CONFIRMED";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ResetSeedError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = "ResetSeedError";
    this.code = code;
    Object.assign(this, details);
  }
}

function resetSeedError(code, message, details) {
  return new ResetSeedError(code, message, details);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function requireUuid(value, code) {
  if (!UUID_PATTERN.test(String(value || ""))) throw resetSeedError(code);
  return String(value);
}

function sourceKey(row) {
  const file = String(row?.sourceFile || "").trim();
  const sheet = String(row?.sourceSheet || "").trim();
  const rowNumber = Number(row?.sourceRow);
  if (!file || !sheet || !Number.isInteger(rowNumber) || rowNumber < 1) {
    throw resetSeedError("RESET_SEED_SOURCE_IDENTITY_REQUIRED");
  }
  return `${file}\u0000${sheet}\u0000${rowNumber}`;
}

function inventoryOnlyRow(row) {
  const copy = { ...row };
  delete copy.image;
  delete copy.embeddedImageDataUrl;
  delete copy.embeddedImageHash;
  delete copy.imageChanged;
  delete copy.imageUntracked;
  return copy;
}

function buildSeedPlan({ candidateItems, runId, expectedRevision, createWorkbookId, createItemId, now }) {
  if (!Array.isArray(candidateItems) || candidateItems.length === 0) {
    throw resetSeedError("RESET_SEED_CANDIDATE_EMPTY");
  }
  const workbookId = requireUuid(createWorkbookId({ runId }), "RESET_SEED_WORKBOOK_ID_INVALID");
  const seenSource = new Set();
  const seenIds = new Set();
  const items = candidateItems.map((row) => {
    const key = sourceKey(row);
    if (seenSource.has(key)) throw resetSeedError("RESET_SEED_DUPLICATE_SOURCE_IDENTITY");
    seenSource.add(key);
    const id = requireUuid(createItemId({ runId, sourceKey: key, legacyId: row.id }),
      "RESET_SEED_ITEM_ID_INVALID");
    if (seenIds.has(id)) throw resetSeedError("RESET_SEED_DUPLICATE_ITEM_ID");
    seenIds.add(id);
    const item = inventoryOnlyRow(row);
    delete item._baseline;
    return { ...item, id };
  });
  const baseline = {
    workbookId,
    revision: "pending",
    itemCount: items.length,
    records: clone(items),
  };
  return {
    transactionId: runId,
    workbookId,
    expectedRevision,
    items,
    baseline,
    createdAt: now(),
    requestHash: sha256({ workbookId, items, baseline }),
  };
}

function assertSeedState(items, expectedItems, code) {
  if (!Array.isArray(items) || items.length !== expectedItems.length) {
    throw resetSeedError(code);
  }
  const expected = new Map(expectedItems.map((item) => [item.id, item]));
  const actualIds = new Set();
  for (const item of items) {
    if (!item?.id || actualIds.has(item.id)) throw resetSeedError(code);
    actualIds.add(item.id);
    const wanted = expected.get(item.id);
    if (!wanted || Number(item.stock) !== Number(wanted.stock)) throw resetSeedError(code);
  }
  if (actualIds.size !== expected.size) throw resetSeedError(code);
}

function validateDependencies(deps) {
  const required = [
    "acquireLock", "createBackup", "readAudit", "appendAudit", "readSnapshot",
    "readWorkbook", "writeWorkbook", "restoreWorkbook", "photoManifest",
    "resetAndSeed", "rollbackResetSeed",
  ];
  if (required.some((name) => typeof deps?.[name] !== "function")) {
    throw resetSeedError("RESET_SEED_API_UNAVAILABLE");
  }
}

function createResetSeedRunner(deps = {}) {
  return async function runResetSeed(input = {}) {
    if (input.confirmation !== RESET_SEED_CONFIRMATION) {
      throw resetSeedError("RESET_SEED_CONFIRMATION_REQUIRED");
    }
    validateDependencies(deps);
    const runId = String(input.runId || "").trim();
    if (!runId) throw resetSeedError("RESET_SEED_RUN_ID_REQUIRED");
    const candidateHash = sha256((input.candidateItems || []).map(inventoryOnlyRow));
    const prior = await deps.readAudit(runId);
    if (prior) {
      if (prior.candidateHash !== candidateHash || prior.status !== "succeeded") {
        throw resetSeedError("RESET_SEED_RUN_ID_REUSED");
      }
      return clone(prior.result);
    }

    let release;
    let backup;
    let plan;
    let remoteCommitted = false;
    let remoteResult;
    let localWriteStarted = false;
    try {
      release = await deps.acquireLock({ runId, operation: "reset-seed" });
      if (typeof release !== "function") throw resetSeedError("RESET_SEED_LOCK_INVALID");
      const before = await deps.readSnapshot();
      const expectedRevision = Number(before?.revision);
      if (!Number.isSafeInteger(expectedRevision) || !Array.isArray(before?.items)) {
        throw resetSeedError("RESET_SEED_LIVE_SNAPSHOT_INVALID");
      }
      const photoManifestBefore = await deps.photoManifest();
      plan = buildSeedPlan({
        candidateItems: input.candidateItems,
        runId,
        expectedRevision,
        createWorkbookId: deps.createWorkbookId || (() => crypto.randomUUID()),
        createItemId: deps.createItemId || (() => crypto.randomUUID()),
        now: deps.now || (() => new Date().toISOString()),
      });
      backup = await deps.createBackup({
        runId,
        before: clone(before),
        photoManifest: photoManifestBefore,
        plan: clone(plan),
      });
      if (!backup?.ok) throw resetSeedError("RESET_SEED_BACKUP_FAILED");
      await deps.appendAudit({
        runId,
        status: "prepared",
        candidateHash,
        expectedRevision,
        backupId: backup.id,
        requestHash: plan.requestHash,
      });

      try {
        remoteResult = await deps.resetAndSeed({
          transactionId: runId,
          confirmation: RESET_SEED_CONFIRMATION,
          expectedRevision,
          workbookId: plan.workbookId,
          items: clone(plan.items),
          baseline: clone(plan.baseline),
          photos: "preserve-only",
        });
        remoteCommitted = remoteResult?.committed !== false;
        if (!remoteResult?.ok) throw resetSeedError(remoteResult?.errorCode || "RESET_SEED_FAILED");
        if (!Number.isSafeInteger(Number(remoteResult.revision))) {
          throw resetSeedError("RESET_SEED_REVISION_INVALID");
        }
        assertSeedState(remoteResult.items, plan.items, "RESET_SEED_RESPONSE_MISMATCH");
      } catch (error) {
        // A transport error after the request may have committed remotely.
        // Roll back unless the API explicitly proves that it did not commit.
        remoteCommitted = remoteCommitted || error.committed !== false;
        throw error;
      }

      const workbookPayload = {
        workbookId: plan.workbookId,
        revision: Number(remoteResult.revision),
        items: clone(plan.items),
        baseline: { ...clone(plan.baseline), revision: Number(remoteResult.revision) },
        photos: "preserve-only",
      };
      localWriteStarted = true;
      await deps.writeWorkbook(workbookPayload);
      const after = await deps.readSnapshot();
      const workbook = await deps.readWorkbook();
      const photoManifestAfter = await deps.photoManifest();
      if (photoManifestAfter !== photoManifestBefore) throw resetSeedError("PHOTO_MANIFEST_CHANGED");
      if (Number(after?.revision) !== Number(remoteResult.revision)) {
        throw resetSeedError("RESET_SEED_VERIFICATION_REVISION_MISMATCH");
      }
      assertSeedState(after?.items, plan.items, "RESET_SEED_VERIFICATION_CLOUD_MISMATCH");
      assertSeedState(workbook?.items, plan.items, "RESET_SEED_VERIFICATION_WORKBOOK_MISMATCH");
      if (workbook?.workbookId !== plan.workbookId
        || Number(workbook?.revision) !== Number(remoteResult.revision)) {
        throw resetSeedError("RESET_SEED_VERIFICATION_IDENTITY_MISMATCH");
      }
      const result = {
        ok: true,
        runId,
        workbookId: plan.workbookId,
        revision: Number(remoteResult.revision),
        itemCount: plan.items.length,
        requestHash: plan.requestHash,
        backupId: backup.id,
        photos: "preserved",
      };
      await deps.appendAudit({ runId, status: "succeeded", candidateHash, result });
      return result;
    } catch (error) {
      if (localWriteStarted && backup) {
        try {
          await deps.restoreWorkbook(backup);
        } catch (restoreError) {
          error.restoreErrorCode = restoreError.code || "RESET_SEED_WORKBOOK_RESTORE_FAILED";
        }
      }
      if (remoteCommitted) {
        try {
          await deps.rollbackResetSeed({
            transactionId: runId,
            revision: remoteResult?.revision,
            backupId: backup?.id,
          });
        } catch (rollbackError) {
          error.rollbackErrorCode = rollbackError.code || "RESET_SEED_REMOTE_ROLLBACK_FAILED";
        }
      }
      try {
        await deps.appendAudit({
          runId,
          status: "failed",
          candidateHash,
          errorCode: error.code || "RESET_SEED_FAILED",
          rollbackAttempted: remoteCommitted,
        });
      } catch {
        // Preserve the original failure; the backup remains the recovery authority.
      }
      throw error;
    } finally {
      if (release) await release();
    }
  };
}

module.exports = {
  RESET_SEED_CONFIRMATION,
  ResetSeedError,
  buildSeedPlan,
  createResetSeedRunner,
};
