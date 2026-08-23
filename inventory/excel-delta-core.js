((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TekStockExcelDelta = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  "use strict";

  const ITEM_FIELDS = [
    "category", "model", "stock", "showroomQuantity", "computedTotalSold",
    "cost", "sellingPrice", "sellingPriceText", "specification", "arrival",
    "showroom", "outbound", "totalSold", "image", "sourceFile", "sourceSheet",
  ];
  const SAFE_PERMANENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
  const LEGACY_RECORD_ID = /^[^:\r\n]{1,160}::[^:\r\n]{1,160}::[1-9]\d{0,8}$/u;

  function cleanId(value) {
    return String(value || "").trim();
  }

  function conflictError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function defaultRandomUUID() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    throw conflictError("PERMANENT_ID_GENERATOR_UNAVAILABLE");
  }

  function nextUniqueId(randomUUID, usedIds) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = cleanId(randomUUID());
      if (id && !usedIds.has(id)) return id;
    }
    throw conflictError("PERMANENT_ID_GENERATION_FAILED");
  }

  function duplicateConflicts(rows, allowedLegacyIds = []) {
    const rowsById = new Map();
    const invalid = new Set();
    const allowedLegacy = new Set(Array.from(allowedLegacyIds, cleanId));
    for (const row of rows) {
      const id = cleanId(row?.id);
      if (!id) continue;
      if (!SAFE_PERMANENT_ID.test(id)
          && !(LEGACY_RECORD_ID.test(id) && allowedLegacy.has(id))) {
        invalid.add(id);
        continue;
      }
      if (!rowsById.has(id)) rowsById.set(id, []);
      rowsById.get(id).push(Math.trunc(Number(row?.sourceRow) || 0));
    }
    return [
      ...Array.from(invalid, (id) => ({ id, reason: "invalid-id" })),
      ...Array.from(rowsById.entries())
        .filter(([, sourceRows]) => sourceRows.length > 1)
        .map(([id, sourceRows]) => {
          const sortedRows = sourceRows.slice().sort((a, b) => a - b);
          return {
            id,
            reason: "duplicate-id",
            ...(sortedRows.every((sourceRow) => sourceRow > 0) ? { sourceRows: sortedRows } : {}),
          };
        }),
    ];
  }

  function assignPermanentIds(sourceRows, options = {}) {
    const rows = Array.isArray(sourceRows)
      ? sourceRows.map((row) => ({ ...(row || {}) }))
      : [];
    const conflicts = duplicateConflicts(rows);
    if (conflicts.length) return { ok: false, rows, assignments: [], conflicts };

    const usedIds = new Set(rows.map((row) => cleanId(row.id)).filter(Boolean));
    const randomUUID = options.randomUUID || defaultRandomUUID;
    const assignments = [];
    for (const row of rows) {
      const existing = cleanId(row.id);
      if (existing) {
        row.id = existing;
        continue;
      }
      if (!String(row.model || "").trim()) {
        conflicts.push({ sourceRow: Number(row.sourceRow) || 0, reason: "missing-model" });
        continue;
      }
      const id = nextUniqueId(randomUUID, usedIds);
      usedIds.add(id);
      row.id = id;
      assignments.push({ id, sourceRow: Number(row.sourceRow) || 0 });
    }
    return { ok: conflicts.length === 0, rows, assignments, conflicts };
  }

  function planBlankIdRows(sourceRows, liveItems, options = {}) {
    const rows = Array.isArray(sourceRows) ? sourceRows.map((row) => ({ ...(row || {}) })) : [];
    const live = Array.isArray(liveItems) ? liveItems : [];
    const dataStartRow = Math.max(1, Math.trunc(Number(options.dataStartRow) || 5));
    const acknowledgedValue = options.acknowledgedItemCount;
    const acknowledgedCount = Number.isInteger(Number(acknowledgedValue))
      && acknowledgedValue !== null
      && acknowledgedValue !== ""
      && Number(acknowledgedValue) >= 0
      ? Number(acknowledgedValue)
      : null;
    const acknowledgedLastRow = dataStartRow - 1 + acknowledgedCount;
    const randomUUID = options.randomUUID || defaultRandomUUID;
    const assignments = [];
    const droppedSourceRows = [];
    const conflicts = duplicateConflicts(rows, options.allowedLegacyIds)
      .filter((conflict) => conflict.reason !== "duplicate-id");
    const usedIds = new Set([
      ...rows.map((row) => cleanId(row.id)),
      ...live.map((row) => cleanId(row.id)),
    ].filter(Boolean));
    const liveIds = new Set(live.map((row) => cleanId(row.id)).filter(Boolean));
    const hasBaselineItems = Array.isArray(options.baselineItems);
    const baselineById = new Map((hasBaselineItems ? options.baselineItems : [])
      .map((row) => [cleanId(row?.id), row]).filter(([id]) => id));
    const baselineIds = new Set(baselineById.keys());
    const currentIds = new Set(rows.map((row) => cleanId(row?.id)).filter(Boolean));
    const acknowledgedRegionRows = rows
      .filter((row) => Math.trunc(Number(row?.sourceRow) || 0) <= acknowledgedLastRow);
    const blankModelRows = rows.filter((row) => !cleanId(row?.id)
      && String(row?.model || "").trim());
    const missingBaselineRows = [...baselineById.entries()]
      .filter(([id]) => !currentIds.has(id));
    const workbookWrittenAtMs = Date.parse(String(options.workbookWrittenAt || ""));
    const workbookMtimeMs = Number(options.workbookMtimeMs);
    let sameRowReplacement = null;
    const verifiedDeleteAndTwoAddRows = new Set();
    if (options.baselineComplete === true
        && acknowledgedCount !== null
        && baselineById.size === acknowledgedCount
        && rows.length === acknowledgedCount
        && acknowledgedRegionRows.length === acknowledgedCount
        && blankModelRows.length === 1
        && missingBaselineRows.length === 1
        && Number.isFinite(workbookWrittenAtMs)
        && Number.isFinite(workbookMtimeMs)
        && workbookMtimeMs > workbookWrittenAtMs
        && rows.every((row) => !cleanId(row?.id) || baselineIds.has(cleanId(row?.id)))) {
      const blankRow = blankModelRows[0];
      const [, missingBaseline] = missingBaselineRows[0];
      const sourceRow = Math.trunc(Number(blankRow?.sourceRow) || 0);
      const baselineSourceRow = Math.trunc(Number(missingBaseline?.sourceRow) || 0);
      // Identity assignment and delete authorization are deliberately separate.
      // This branch only proves that one baseline identity disappeared while
      // one blank replacement row appeared in the same acknowledged workbook
      // shape. The replacement always receives a fresh ID. Any concurrent
      // cloud edit to the deleted identity is handled later by the three-way
      // merge and can still block deletion atomically.
      if (sourceRow >= dataStartRow
          && (baselineSourceRow === 0 || sourceRow === baselineSourceRow)
          && cleanText(blankRow?.model) !== cleanText(missingBaseline?.model)) {
        sameRowReplacement = blankRow;
      }
    }
    if (options.baselineComplete === true
        && acknowledgedCount !== null
        && baselineById.size === acknowledgedCount
        && rows.length === acknowledgedCount + 1
        && blankModelRows.length === 2
        && missingBaselineRows.length === 1
        && Number.isFinite(workbookWrittenAtMs)
        && Number.isFinite(workbookMtimeMs)
        && workbookMtimeMs > workbookWrittenAtMs
        && rows.every((row) => !cleanId(row?.id) || baselineIds.has(cleanId(row?.id)))) {
      blankModelRows.forEach((row) => verifiedDeleteAndTwoAddRows.add(row));
    }
    for (const duplicate of duplicateConflicts(rows, options.allowedLegacyIds)
      .filter((conflict) => conflict.reason === "duplicate-id")) {
      const acknowledgedRows = duplicate.sourceRows.filter((sourceRow) => sourceRow <= acknowledgedLastRow);
      const appendedRows = duplicate.sourceRows.filter((sourceRow) => sourceRow > acknowledgedLastRow);
      const oneAcknowledgedOriginal = liveIds.has(duplicate.id)
        && acknowledgedRows.length === 1
        && appendedRows.length > 0;
      const allDuplicatesAreNewAppends = acknowledgedRows.length === 0
        && appendedRows.length === duplicate.sourceRows.length
        && appendedRows.length > 1;
      const allDuplicatesAreUnacknowledgedLocal = hasBaselineItems
        && !liveIds.has(duplicate.id)
        && !baselineIds.has(duplicate.id)
        && duplicate.sourceRows.length > 1;
      const duplicateRows = duplicate.sourceRows.map((sourceRow) => rows.find((candidate) =>
        Math.trunc(Number(candidate?.sourceRow) || 0) === sourceRow));
      const baselineMatchingRows = duplicateRows.filter((row) =>
        matchesBaselineRecord(row, baselineById.get(duplicate.id)));
      const oneExactBaselineOriginal = options.baselineComplete === true
        && liveIds.has(duplicate.id)
        && baselineMatchingRows.length === 1
        && duplicateRows.length > 1;
      // A unique full canonical baseline match proves which duplicate is the
      // original even when old workbooks contain blank/deleted rows. The
      // acknowledged row-count boundary is only needed for the weaker append
      // cases where no exact baseline record identifies the original.
      const safelyCopiedAppend = options.baselineComplete === true
        && (oneExactBaselineOriginal
          || (acknowledgedCount !== null
            && acknowledgedRegionRows.length === acknowledgedCount
            && (oneAcknowledgedOriginal || allDuplicatesAreNewAppends
              || allDuplicatesAreUnacknowledgedLocal)));
      if (!safelyCopiedAppend) {
        conflicts.push(duplicate);
        continue;
      }
      const rowsToReidentify = allDuplicatesAreUnacknowledgedLocal
        ? duplicate.sourceRows
        : oneExactBaselineOriginal
          ? duplicate.sourceRows.filter((sourceRow) => sourceRow
            !== Math.trunc(Number(baselineMatchingRows[0]?.sourceRow) || 0))
          : appendedRows;
      for (const sourceRow of rowsToReidentify) {
        const row = rows.find((candidate) => Math.trunc(Number(candidate?.sourceRow) || 0) === sourceRow);
        if (!row || cleanId(row.id) !== duplicate.id || !String(row.model || "").trim()) {
          conflicts.push(duplicate);
          break;
        }
        const id = nextUniqueId(randomUUID, usedIds);
        usedIds.add(id);
        row.id = id;
        assignments.push({ id, sourceRow, expectedId: duplicate.id });
      }
    }

    for (const row of rows) {
      if (cleanId(row.id)) continue;
      const sourceRow = Math.trunc(Number(row.sourceRow) || 0);
      if (!String(row.model || "").trim()) {
        conflicts.push({ sourceRow, reason: "missing-model" });
        continue;
      }
      // Normal sync never infers an existing identity from mutable content or
      // physical position. Only a row beyond a fully verified acknowledged
      // region can receive a new permanent ID.
      if (options.baselineComplete === true
          && acknowledgedCount !== null
          && sourceRow > acknowledgedLastRow) {
        const id = nextUniqueId(randomUUID, usedIds);
        usedIds.add(id);
        row.id = id;
        assignments.push({ id, sourceRow });
        continue;
      }
      if (row === sameRowReplacement) {
        const id = nextUniqueId(randomUUID, usedIds);
        usedIds.add(id);
        row.id = id;
        assignments.push({ id, sourceRow });
        continue;
      }
      if (verifiedDeleteAndTwoAddRows.has(row)) {
        const id = nextUniqueId(randomUUID, usedIds);
        usedIds.add(id);
        row.id = id;
        assignments.push({ id, sourceRow });
        continue;
      }
      conflicts.push({ sourceRow, reason: "legacy-row-ambiguous" });
    }
    return { ok: conflicts.length === 0, rows, assignments, droppedSourceRows, conflicts };
  }

  function sameValue(left, right) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }

  const BASELINE_TEXT_FIELDS = [
    "model", "category", "specification",
    "arrival", "showroom", "outbound", "sourceFile", "sourceSheet",
  ];
  const BASELINE_OPTIONAL_TEXT_FIELDS = ["stockText", "sellingPriceText"];
  const BASELINE_NUMBER_FIELDS = [
    "stock", "showroomQuantity", "computedTotalSold", "totalSold", "cost", "sellingPrice",
  ];

  function cleanText(value) {
    return String(value ?? "").trim();
  }

  function canonicalPhotoIdentity(item) {
    const hash = cleanText(item?.imageSha256).toLowerCase();
    if (hash) return `sha256:${hash}`;
    const version = cleanText(item?.imageVersion);
    if (version) return `version:${version}`;
    const image = cleanText(item?.image);
    return image ? `object:${image}` : "";
  }

  function sameCanonicalPhoto(left, right) {
    const leftEmbeddedHash = cleanText(left?.embeddedImageHash || left?.imageHash).toLowerCase();
    const rightEmbeddedHash = cleanText(right?.embeddedImageHash || right?.imageHash).toLowerCase();
    if (leftEmbeddedHash || rightEmbeddedHash) {
      return !!leftEmbeddedHash && !!rightEmbeddedHash && leftEmbeddedHash === rightEmbeddedHash;
    }
    const leftHash = cleanText(left?.imageSha256).toLowerCase();
    const rightHash = cleanText(right?.imageSha256).toLowerCase();
    if (leftHash && rightHash) return leftHash === rightHash;
    return canonicalPhotoIdentity(left) === canonicalPhotoIdentity(right);
  }

  function matchesBaselineRecord(row, baseline) {
    if (!row || !baseline) return false;
    if (cleanId(row.id) !== cleanId(baseline.id)) return false;
    for (const field of BASELINE_TEXT_FIELDS) {
      if (cleanText(row?.[field]) !== cleanText(baseline?.[field])) return false;
    }
    for (const field of BASELINE_OPTIONAL_TEXT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(row, field)
          && cleanText(row?.[field]) !== cleanText(baseline?.[field])) return false;
    }
    for (const field of BASELINE_NUMBER_FIELDS) {
      const numericValue = (value) => {
        if (value == null || value === "") return 0;
        const number = Number(value);
        return Number.isFinite(number) ? number : value;
      };
      const rowValue = numericValue(row?.[field]);
      const baselineValue = numericValue(baseline?.[field]);
      if (!sameValue(rowValue, baselineValue)) return false;
    }
    return sameCanonicalPhoto(row, baseline);
  }

  function itemRecord(item) {
    return Object.fromEntries([
      ["id", cleanId(item?.id)],
      ...ITEM_FIELDS.map((field) => [field, item?.[field]]),
    ].filter(([, value]) => value !== undefined));
  }

  function indexStrictlyById(rows, missingIdConflicts, allowedLegacyIds = []) {
    const index = new Map();
    const duplicates = new Set();
    const allowedLegacy = new Set(Array.from(allowedLegacyIds, cleanId));
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = cleanId(row?.id);
      if (!id) {
        if (missingIdConflicts) {
          missingIdConflicts.push({
            sourceRow: Number(row?.sourceRow) || 0,
            reason: "missing-id",
          });
        }
        continue;
      }
      if (!SAFE_PERMANENT_ID.test(id)
          && !(LEGACY_RECORD_ID.test(id) && allowedLegacy.has(id))) {
        if (missingIdConflicts) missingIdConflicts.push({ id, reason: "invalid-id" });
        continue;
      }
      if (index.has(id)) duplicates.add(id);
      else index.set(id, row);
    }
    return {
      index,
      conflicts: Array.from(duplicates, (id) => ({ id, reason: "duplicate-id" })),
    };
  }

  function buildWorkbookDelta(options = {}) {
    const conflicts = [];
    const allowedLegacyIds = new Set(Array.from(options.allowedLegacyIds || [], cleanId));
    const allowedLegacyDeleteIds = new Set(
      Array.from(options.allowedLegacyDeleteIds || [], cleanId),
    );
    const baseline = indexStrictlyById(options.baselineRecords, conflicts, allowedLegacyIds);
    const current = indexStrictlyById(options.currentRows, conflicts, allowedLegacyIds);
    conflicts.push(...baseline.conflicts, ...current.conflicts);
    if (!conflicts.length) {
      const allowedExistingIds = new Set(Array.from(options.allowedExistingIds || [], cleanId));
      for (const row of Array.isArray(options.currentRows) ? options.currentRows : []) {
        const id = cleanId(row?.id);
        if (id && !baseline.index.has(id) && row?._excelGeneratedId !== true
            && !allowedExistingIds.has(id)) {
          conflicts.push({ id, reason: "unknown-id" });
        }
      }
    }
    if (conflicts.length) {
      return { ok: false, conflicts, created: [], updated: [], deleted: [], operations: [] };
    }

    const created = [];
    const updated = [];
    const deleted = [];
    for (const row of Array.isArray(options.currentRows) ? options.currentRows : []) {
      const id = cleanId(row.id);
      const before = baseline.index.get(id);
      if (!before) {
        created.push({ type: "create", itemId: id, item: itemRecord(row) });
        continue;
      }
      const patch = {};
      for (const field of ITEM_FIELDS) {
        if (!sameValue(before?.[field], row?.[field])) patch[field] = row?.[field] ?? null;
      }
      if (Object.keys(patch).length) updated.push({ type: "update", itemId: id, patch });
    }
    for (const row of Array.isArray(options.baselineRecords) ? options.baselineRecords : []) {
      const id = cleanId(row.id);
      if (!current.index.has(id)) deleted.push({ type: "delete", itemId: id });
    }
    const legacyMutations = [...updated, ...deleted]
      .filter((operation) => allowedLegacyIds.has(operation.itemId)
        && (operation.type !== "delete" || !allowedLegacyDeleteIds.has(operation.itemId)))
      .map((operation) => ({ id: operation.itemId, reason: "legacy-id-read-only" }));
    if (legacyMutations.length) {
      return { ok: false, conflicts: legacyMutations, created: [], updated: [], deleted: [], operations: [] };
    }
    return {
      ok: true,
      conflicts: [],
      created,
      updated,
      deleted,
      operations: [...created, ...updated, ...deleted],
    };
  }

  return {
    ITEM_FIELDS,
    assignPermanentIds,
    buildWorkbookDelta,
    cleanId,
    planBlankIdRows,
  };
});
