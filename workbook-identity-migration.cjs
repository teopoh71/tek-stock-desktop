"use strict";

const crypto = require("node:crypto");

const WORKBOOK_SCHEMA_VERSION = "tek-stock-live-v2";
const WORKBOOK_MIGRATION_VERSION = 2;
const SAFE_PERMANENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const LEGACY_RECORD_ID = /^[^:\r\n]{1,160}::[^:\r\n]{1,160}::[1-9]\d{0,8}$/u;
const REVIEWED_RESTORE_ID = "中角桌和其它数量.xlsx::忧闲椅和沙发床::10";
const REVIEWED_RETIRE_ID = "fc55fe56-9a1b-40ea-b377-9db2654e567f";
const REVIEWED_TEXT_FIELDS = ["model", "category", "specification", "arrival", "showroom", "outbound"];
const REVIEWED_NUMBER_FIELDS = [
  "stock", "showroomQuantity", "computedTotalSold", "totalSold", "cost", "sellingPrice",
];
const REVIEWED_CANONICAL_FIELDS = [
  ...REVIEWED_TEXT_FIELDS, ...REVIEWED_NUMBER_FIELDS, "stockText", "sellingPriceText",
  "sourceFile", "sourceSheet", "image", "imageSha256", "imageVersion",
];

function migrationError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function clean(value) {
  return String(value || "").trim();
}

function legacyKey(source) {
  return [source?.category, source?.model, source?.specification]
    .map((value) => clean(value).toLocaleLowerCase())
    .join("\u001f");
}

function safeCandidate(source) {
  return {
    id: clean(source?.id),
    model: clean(source?.model),
    category: clean(source?.category),
    specification: clean(source?.specification),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

function planToken(source) {
  return crypto.createHash("sha256").update(JSON.stringify(stableJson(source))).digest("hex");
}

function plannedNewItemId({ workbookSha256, workbookId, sourceRow, legacyId, model }) {
  const seed = [workbookSha256, workbookId, sourceRow, legacyId, model].map(clean).join("\u001f");
  return `new-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 48)}`;
}

function reviewedComparableItem(source, photoFallback) {
  const item = { id: clean(source?.id) };
  for (const field of REVIEWED_TEXT_FIELDS) item[field] = String(source?.[field] || "");
  for (const field of REVIEWED_NUMBER_FIELDS) {
    const value = source?.[field];
    item[field] = value === "" || value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  }
  const photoSource = source?.imageChanged || source?.imageUntracked ? source : (photoFallback || source);
  item.imageIdentity = String(photoSource?.imageSha256 || photoSource?.imageVersion || photoSource?.image || "");
  return item;
}

function reviewedCanonicalItem(source) {
  const item = { id: clean(source?.id) };
  for (const field of REVIEWED_CANONICAL_FIELDS) item[field] = source?.[field] ?? null;
  return stableJson(item);
}

function reviewedIndex(items) {
  const index = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = clean(item?.id);
    if (!id || index.has(id)) throw migrationError("WORKBOOK_REVIEWED_LEGACY_SCOPE_MISMATCH");
    index.set(id, item);
  }
  return index;
}

function reviewedWorkbookSame(current, baseline) {
  return JSON.stringify(reviewedComparableItem(current, baseline))
    === JSON.stringify(reviewedComparableItem(baseline, baseline));
}

function reviewedCanonicalSame(left, right) {
  return JSON.stringify(reviewedCanonicalItem(left)) === JSON.stringify(reviewedCanonicalItem(right));
}

function planReviewedLegacyReconciliation({ workbook, cloud } = {}) {
  const currentItems = Array.isArray(workbook?.items) ? workbook.items : [];
  const baselineItems = Array.isArray(workbook?.baseline?.records) ? workbook.baseline.records : [];
  const liveItems = Array.isArray(cloud?.items) ? cloud.items : [];
  const baselineHasRetiredIdentity = baselineItems.some((item) => clean(item?.id) === REVIEWED_RETIRE_ID);
  if (!baselineHasRetiredIdentity) return { matched: false };

  const invalidEnvelope = currentItems.length !== 320
    || baselineItems.length !== 322
    || liveItems.length !== 321
    || Number(workbook?.sync?.revision) !== 231
    || Number(workbook?.sync?.itemCount) !== 322
    || Number(workbook?.baseline?.revision) !== 231
    || Number(workbook?.baseline?.itemCount) !== 322
    || Number(cloud?.revision) !== 232;
  if (invalidEnvelope) throw migrationError("WORKBOOK_REVIEWED_LEGACY_SCOPE_MISMATCH");

  const current = reviewedIndex(currentItems);
  const baseline = reviewedIndex(baselineItems);
  const live = reviewedIndex(liveItems);
  const currentIds = new Set(current.keys());
  const baselineOnly = [...baseline.keys()].filter((id) => !currentIds.has(id));
  const liveOnly = [...live.keys()].filter((id) => !currentIds.has(id));
  const currentOnlyBaseline = [...current.keys()].filter((id) => !baseline.has(id));
  const currentOnlyLive = [...current.keys()].filter((id) => !live.has(id));
  const baselineOnlyLive = [...baseline.keys()].filter((id) => !live.has(id));
  const exactSets = baselineOnly.length === 2
    && new Set(baselineOnly).has(REVIEWED_RESTORE_ID)
    && new Set(baselineOnly).has(REVIEWED_RETIRE_ID)
    && liveOnly.length === 1 && liveOnly[0] === REVIEWED_RESTORE_ID
    && currentOnlyBaseline.length === 0
    && currentOnlyLive.length === 0
    && baselineOnlyLive.length === 1 && baselineOnlyLive[0] === REVIEWED_RETIRE_ID;
  const restoreBaseline = baseline.get(REVIEWED_RESTORE_ID);
  const restoreLive = live.get(REVIEWED_RESTORE_ID);
  const retireBaseline = baseline.get(REVIEWED_RETIRE_ID);
  const exactReviewedRecords = clean(restoreBaseline?.model) === "5555"
    && clean(restoreLive?.model) === "5555"
    && clean(retireBaseline?.model) === "121212"
    && reviewedCanonicalSame(restoreBaseline, restoreLive);
  const commonRecordsUnchanged = [...current].every(([id, item]) =>
    reviewedWorkbookSame(item, baseline.get(id))
      && reviewedCanonicalSame(baseline.get(id), live.get(id)));
  if (!exactSets || !exactReviewedRecords || !commonRecordsUnchanged) {
    throw migrationError("WORKBOOK_REVIEWED_LEGACY_SCOPE_MISMATCH");
  }
  return {
    matched: true,
    replacementOnly: true,
    restoreIds: [REVIEWED_RESTORE_ID],
    retireBaselineIds: [REVIEWED_RETIRE_ID],
    desiredItems: [...liveItems],
    cloudOperations: [],
  };
}

function verifyReviewedLegacyReconciliationResult({ workbook, cloud } = {}) {
  const currentItems = Array.isArray(workbook?.items) ? workbook.items : [];
  const baselineItems = Array.isArray(workbook?.baseline?.records) ? workbook.baseline.records : [];
  const liveItems = Array.isArray(cloud?.items) ? cloud.items : [];
  const fail = () => { throw migrationError("WORKBOOK_REVIEWED_LEGACY_VERIFICATION_FAILED"); };
  if (currentItems.length !== 321 || baselineItems.length !== 321 || liveItems.length !== 321
      || Number(workbook?.sync?.revision) !== 232 || Number(workbook?.sync?.itemCount) !== 321
      || Number(workbook?.baseline?.revision) !== 232
      || Number(workbook?.baseline?.itemCount) !== 321 || Number(cloud?.revision) !== 232) fail();
  let current;
  let baseline;
  let live;
  try {
    current = reviewedIndex(currentItems);
    baseline = reviewedIndex(baselineItems);
    live = reviewedIndex(liveItems);
  } catch {
    fail();
  }
  const ids = [...live.keys()];
  if (!live.has(REVIEWED_RESTORE_ID) || live.has(REVIEWED_RETIRE_ID)
      || clean(live.get(REVIEWED_RESTORE_ID)?.model) !== "5555"
      || current.size !== live.size || baseline.size !== live.size
      || ids.some((id) => !current.has(id) || !baseline.has(id))) fail();
  if (ids.some((id) => !reviewedWorkbookSame(current.get(id), baseline.get(id))
      || !reviewedCanonicalSame(baseline.get(id), live.get(id)))) fail();
  return true;
}

function workbookIdentity(source, sha256) {
  const workbookId = clean(source?.workbookId || source?.sync?.workbookId)
    || `wb-${clean(sha256).slice(0, 40)}`;
  if (!SAFE_PERMANENT_ID.test(workbookId)) throw migrationError("WORKBOOK_ID_INVALID");
  return {
    workbookId,
    schemaVersion: WORKBOOK_SCHEMA_VERSION,
    migrationVersion: WORKBOOK_MIGRATION_VERSION,
  };
}

function assertWorkbookRows(items, cloudIds) {
  const ids = new Set();
  const rows = new Set();
  for (const item of items) {
    const row = Math.trunc(Number(item?.sourceRow) || 0);
    const id = clean(item?.id);
    if (row < 5 || rows.has(row)) throw migrationError("WORKBOOK_ROW_LOCATOR_INVALID");
    rows.add(row);
    if (!id) continue;
    if (!SAFE_PERMANENT_ID.test(id) && !LEGACY_RECORD_ID.test(id)) {
      throw migrationError("WORKBOOK_RECORD_ID_INVALID");
    }
    if (LEGACY_RECORD_ID.test(id)) continue;
    if (ids.has(id)) throw migrationError("WORKBOOK_DUPLICATE_ID");
    if (cloudIds && !cloudIds.has(id)) throw migrationError("WORKBOOK_UNKNOWN_ID");
    ids.add(id);
  }
  return ids;
}

function isExplicitAppendReview({ workbookItems, acknowledgedItemCount, baselineRecords }) {
  if (!Number.isSafeInteger(acknowledgedItemCount) || acknowledgedItemCount < 0
      || !Array.isArray(baselineRecords)
      || baselineRecords.length !== acknowledgedItemCount
      || workbookItems.length <= acknowledgedItemCount) return false;
  const baselineRows = new Map();
  let lastBaselineRow = 4;
  for (const record of baselineRecords) {
    const id = clean(record?.id);
    const sourceRow = Math.trunc(Number(record?.sourceRow) || 0);
    if (!SAFE_PERMANENT_ID.test(id) || sourceRow < 5 || baselineRows.has(id)) return false;
    baselineRows.set(id, sourceRow);
    lastBaselineRow = Math.max(lastBaselineRow, sourceRow);
  }
  const currentById = new Map();
  for (const item of workbookItems) {
    const id = clean(item?.id);
    if (SAFE_PERMANENT_ID.test(id)) {
      if (currentById.has(id)) return false;
      currentById.set(id, Math.trunc(Number(item?.sourceRow) || 0));
    }
  }
  for (const [id, sourceRow] of baselineRows) {
    if (currentById.get(id) !== sourceRow) return false;
  }
  const appended = workbookItems.filter((item) => !baselineRows.has(clean(item?.id)));
  const appendedIds = new Set();
  return appended.length === workbookItems.length - acknowledgedItemCount
    && appended.every((item) => {
      const id = clean(item?.id);
      const sourceRow = Math.trunc(Number(item?.sourceRow) || 0);
      if (id && (appendedIds.has(id) || !LEGACY_RECORD_ID.test(id))) return false;
      if (id) appendedIds.add(id);
      return sourceRow > lastBaselineRow;
    });
}

function planWorkbookIdentityMigration({ workbook, cloud } = {}) {
  const workbookSha256 = clean(workbook?.sha256);
  const cloudRevision = Number(cloud?.revision);
  if (!workbookSha256) throw migrationError("WORKBOOK_MIGRATION_SHA_REQUIRED");
  if (!Number.isSafeInteger(cloudRevision) || cloudRevision < 0) {
    throw migrationError("WORKBOOK_MIGRATION_REVISION_REQUIRED");
  }
  const workbookItems = Array.isArray(workbook?.items) ? workbook.items : [];
  const cloudItems = Array.isArray(cloud?.items) ? cloud.items : [];
  const acknowledgedItemCount = Number(workbook?.sync?.itemCount ?? workbook?.baseline?.itemCount);
  const baselineRecordCount = Array.isArray(workbook?.baseline?.records)
    ? workbook.baseline.records.length : null;
  const countReview = Number.isSafeInteger(acknowledgedItemCount) && acknowledgedItemCount >= 0
    && (acknowledgedItemCount !== workbookItems.length
      || (baselineRecordCount !== null && baselineRecordCount !== acknowledgedItemCount));
  const explicitAppendReview = countReview && isExplicitAppendReview({
    workbookItems,
    acknowledgedItemCount,
    baselineRecords: workbook?.baseline?.records,
  });
  if (countReview && !explicitAppendReview) {
    return {
      ok: false,
      errorCode: "WORKBOOK_MIGRATION_REVIEW_REQUIRED",
      reviewRequired: true,
      workbookSha256,
      cloudRevision,
      review: {
        currentItemCount: workbookItems.length,
        acknowledgedItemCount,
        baselineRecordCount,
      },
      rows: [],
    };
  }
  const cloudIds = new Set();
  for (const item of cloudItems) {
    const id = clean(item?.id);
    if (!SAFE_PERMANENT_ID.test(id) || cloudIds.has(id)) {
      throw migrationError("WORKBOOK_MIGRATION_CLOUD_ID_INVALID");
    }
    cloudIds.add(id);
  }
  const usedWorkbookIds = assertWorkbookRows(workbookItems, cloudIds);
  const identity = workbookIdentity(workbook, workbookSha256);
  const rows = workbookItems.filter((item) => !SAFE_PERMANENT_ID.test(clean(item?.id))).map((item) => {
    const legacyId = clean(item?.id);
    const sourceRow = Math.trunc(Number(item?.sourceRow) || 0);
    const candidates = cloudItems
      .filter((candidate) => !usedWorkbookIds.has(clean(candidate?.id)))
      .filter((candidate) => legacyKey(candidate) === legacyKey(item))
      .map(safeCandidate);
    return {
      sourceRow,
      ...(LEGACY_RECORD_ID.test(legacyId) ? { legacyId } : {}),
      model: clean(item?.model),
      category: clean(item?.category),
      specification: clean(item?.specification),
      candidates,
      newItemId: plannedNewItemId({ workbookSha256, workbookId: identity.workbookId,
        sourceRow, legacyId, model: item?.model }),
    };
  });
  const result = {
    ok: true,
    workbookSha256,
    cloudRevision,
    ...identity,
    rows,
    existingWorkbookIds: [...usedWorkbookIds],
    cloudItemIds: [...cloudIds],
  };
  result.planToken = planToken(result);
  return result;
}

function exactAssignmentsPersisted(items, assignments) {
  const idsByRow = new Map();
  const allIds = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const row = Math.trunc(Number(item?.sourceRow) || 0);
    const id = clean(item?.id);
    if (!idsByRow.has(row)) idsByRow.set(row, []);
    if (id) {
      if (!SAFE_PERMANENT_ID.test(id) || allIds.has(id)) return false;
      allIds.add(id);
      idsByRow.get(row).push(id);
    }
  }
  return assignments.every(({ sourceRow, id }) => {
    const values = idsByRow.get(sourceRow) || [];
    return values.length === 1 && values[0] === id;
  });
}

function validateManifest(plan, manifest) {
  if (!plan?.ok || !Array.isArray(plan.rows)) throw migrationError("WORKBOOK_MIGRATION_PLAN_INVALID");
  if (clean(manifest?.workbookSha256) !== clean(plan.workbookSha256)) {
    throw migrationError("WORKBOOK_MIGRATION_MANIFEST_SHA_INVALID");
  }
  if (Number(manifest?.cloudRevision) !== Number(plan.cloudRevision)) {
    throw migrationError("WORKBOOK_MIGRATION_MANIFEST_REVISION_INVALID");
  }
  for (const key of ["workbookId", "schemaVersion", "migrationVersion", "planToken"]) {
    if (String(manifest?.[key] ?? "") !== String(plan[key] ?? "")) {
      throw migrationError(`WORKBOOK_MIGRATION_MANIFEST_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}_INVALID`);
    }
  }
  const choices = Array.isArray(manifest?.choices) ? manifest.choices : [];
  if (choices.length !== plan.rows.length) {
    throw migrationError("WORKBOOK_MIGRATION_MANIFEST_INCOMPLETE");
  }
  const requiredRows = new Set(plan.rows.map((row) => Math.trunc(Number(row.sourceRow) || 0)));
  const usedRows = new Set();
  const usedIds = new Set(Array.isArray(plan.existingWorkbookIds) ? plan.existingWorkbookIds : []);
  const cloudIds = new Set(Array.isArray(plan.cloudItemIds) ? plan.cloudItemIds : []);
  const assignments = [];
  for (const choice of choices) {
    const sourceRow = Math.trunc(Number(choice?.sourceRow) || 0);
    const id = clean(choice?.itemId);
    const action = clean(choice?.action).toLowerCase();
    if (!requiredRows.has(sourceRow) || usedRows.has(sourceRow)) {
      throw migrationError("WORKBOOK_MIGRATION_ROW_INVALID");
    }
    if (!SAFE_PERMANENT_ID.test(id)) {
      throw migrationError("WORKBOOK_MIGRATION_ITEM_INVALID");
    }
    const planRow = plan.rows.find((row) => Math.trunc(Number(row?.sourceRow) || 0) === sourceRow);
    const candidateIds = new Set((Array.isArray(planRow?.candidates) ? planRow.candidates : [])
      .map((candidate) => clean(candidate?.id)));
    const explicitCreate = action === "create" && id === clean(planRow?.newItemId) && !cloudIds.has(id);
    if (!explicitCreate && (!cloudIds.has(id) || !candidateIds.has(id))) {
      throw migrationError(action === "create"
        ? "WORKBOOK_MIGRATION_ITEM_INVALID" : "WORKBOOK_MIGRATION_ITEM_NOT_CANDIDATE");
    }
    if (usedIds.has(id)) throw migrationError("WORKBOOK_MIGRATION_ID_REUSED");
    usedRows.add(sourceRow);
    usedIds.add(id);
    assignments.push({ sourceRow, id, legacyId: clean(planRow?.legacyId),
      ...(explicitCreate ? { createNew: true } : {}) });
  }
  if (usedRows.size !== requiredRows.size) {
    throw migrationError("WORKBOOK_MIGRATION_MANIFEST_INCOMPLETE");
  }
  return assignments;
}

async function applyWorkbookIdentityMigration(options = {}) {
  const plan = options.plan;
  const assignments = validateManifest(plan, options.manifest);
  if (typeof options.readWorkbook !== "function"
      || typeof options.assignIds !== "function"
      || typeof options.getCloudRevision !== "function") {
    throw migrationError("WORKBOOK_MIGRATION_CALLBACK_REQUIRED");
  }
  let transaction;
  try {
    if (typeof options.beginTransaction === "function") {
      transaction = await options.beginTransaction({ plan, assignments });
    }
    const before = await options.readWorkbook();
    const identityPersisted = clean(before?.sync?.workbookId || before?.workbookId) === plan.workbookId
      && clean(before?.sync?.schemaVersion || before?.schemaVersion) === plan.schemaVersion
      && Number(before?.sync?.migrationVersion || before?.migrationVersion) === plan.migrationVersion
      && clean(before?.sync?.migrationPlanToken || before?.migrationPlanToken) === plan.planToken;
    if (identityPersisted && exactAssignmentsPersisted(before?.items, assignments)) {
      if (typeof transaction?.finalize === "function") await transaction.finalize();
      return { ok: true, alreadyApplied: true, assigned: 0, assignments };
    }
    if (clean(before?.sha256) !== clean(options.plan.workbookSha256)) {
      throw migrationError("WORKBOOK_CONTENT_CHANGED");
    }
    const cloudRevision = Number(await options.getCloudRevision());
    if (cloudRevision !== Number(options.plan.cloudRevision)) {
      throw migrationError("WORKBOOK_MIGRATION_CLOUD_CHANGED");
    }
    const assignmentResult = await options.assignIds(assignments, options.plan.workbookSha256, {
      workbookId: plan.workbookId,
      schemaVersion: plan.schemaVersion,
      migrationVersion: plan.migrationVersion,
      migrationPlanToken: plan.planToken,
    });
    if (!transaction && assignmentResult && (assignmentResult.rollback || assignmentResult.finalize)) {
      transaction = assignmentResult;
    }
    if (typeof transaction?.markWorkbookWritten === "function") transaction.markWorkbookWritten();
    const after = await options.readWorkbook();
    const afterIdentity = workbookIdentity(after, after?.sha256);
    if (!exactAssignmentsPersisted(after?.items, assignments)
        || clean(after?.sync?.workbookId || after?.workbookId) !== afterIdentity.workbookId
        || afterIdentity.workbookId !== plan.workbookId
        || clean(after?.sync?.schemaVersion || after?.schemaVersion) !== plan.schemaVersion
        || Number(after?.sync?.migrationVersion || after?.migrationVersion) !== plan.migrationVersion
        || clean(after?.sync?.migrationPlanToken || after?.migrationPlanToken) !== plan.planToken) {
      throw migrationError("WORKBOOK_ID_ASSIGNMENT_NOT_ACKNOWLEDGED");
    }
    if (Number(await options.getCloudRevision()) !== Number(plan.cloudRevision)) {
      throw migrationError("WORKBOOK_MIGRATION_CLOUD_CHANGED");
    }
    if (typeof transaction?.finalize === "function") await transaction.finalize();
    return { ok: true, alreadyApplied: false, assigned: assignments.length, assignments,
      workbookSha256: clean(after?.sha256), workbookId: plan.workbookId };
  } catch (error) {
    if (typeof transaction?.rollback === "function") await transaction.rollback();
    throw error;
  }
}

module.exports = {
  applyWorkbookIdentityMigration,
  exactAssignmentsPersisted,
  planReviewedLegacyReconciliation,
  planWorkbookIdentityMigration,
  verifyReviewedLegacyReconciliationResult,
  validateManifest,
  SAFE_PERMANENT_ID,
  WORKBOOK_MIGRATION_VERSION,
  WORKBOOK_SCHEMA_VERSION,
  LEGACY_RECORD_ID,
};
