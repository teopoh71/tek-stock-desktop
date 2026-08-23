(function initExcelSyncCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TekStockExcelSync = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createExcelSyncCore() {
  "use strict";

  function cleanText(value) {
    return String(value == null ? "" : value)
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ");
  }

  function identityPart(value) {
    return cleanText(value).toLowerCase();
  }

  function itemIdentity(item) {
    return [
      identityPart(item?.category || "未分类"),
      identityPart(item?.model),
      identityPart(item?.specification),
    ].join("\u0000");
  }

  const PERMANENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function explicitSourceIdentity(item) {
    const sourceFile = identityPart(item?.sourceFile);
    const sourceSheet = identityPart(item?.sourceSheet);
    const sourceRow = Number(item?.sourceRow);
    if (!sourceFile || !sourceSheet || !Number.isInteger(sourceRow) || sourceRow <= 0) return "";
    return [sourceFile, sourceSheet, String(sourceRow)].join("\u0000");
  }

  function mergeInventoryViews({ onlineItems, offlineItems } = {}) {
    const online = Array.isArray(onlineItems) ? onlineItems : [];
    const offline = Array.isArray(offlineItems) ? offlineItems : [];
    const duplicateKeys = [];
    const indexes = { online: new Map(), offline: new Map() };
    const addIndex = (side, items) => {
      items.forEach((item, index) => {
        const id = cleanText(item?.id);
        const source = explicitSourceIdentity(item);
        for (const [kind, key] of [
          ["id", id],
          ["sourceIdentity", source],
        ]) {
          if (!key) continue;
          const mapKey = `${kind}\u0000${key}`;
          const indexesForKey = indexes[side].get(mapKey) || [];
          indexesForKey.push(index);
          indexes[side].set(mapKey, indexesForKey);
        }
      });
    };
    addIndex("online", online);
    addIndex("offline", offline);
    for (const side of ["online", "offline"]) {
      for (const [mapKey, indexesForKey] of indexes[side]) {
        if (indexesForKey.length > 1) {
          const separator = mapKey.indexOf("\u0000");
          duplicateKeys.push({
            side,
            kind: mapKey.slice(0, separator),
            key: mapKey.slice(separator + 1),
            count: indexesForKey.length,
          });
        }
      }
    }
    if (duplicateKeys.length) {
      return {
        ok: false,
        items: [],
        matches: [],
        onlyOnline: [],
        onlyOffline: [],
        quantityConflicts: [],
        modelOnlyReview: [],
        duplicateKeys,
      };
    }

    const usedOnline = new Set();
    const usedOffline = new Set();
    const matches = [];
    const matchByKey = (kind, key) => {
      if (!key) return;
      const onlineIndex = indexes.online.get(`${kind}\u0000${key}`)?.[0];
      const offlineIndex = indexes.offline.get(`${kind}\u0000${key}`)?.[0];
      if (onlineIndex == null || offlineIndex == null
          || usedOnline.has(onlineIndex) || usedOffline.has(offlineIndex)) return;
      usedOnline.add(onlineIndex);
      usedOffline.add(offlineIndex);
      const onlineItem = online[onlineIndex];
      const offlineItem = offline[offlineIndex];
      const onlineStock = Number(onlineItem?.stock);
      const offlineStock = Number(offlineItem?.stock);
      const matchKind = kind === "id"
        ? (PERMANENT_ID_PATTERN.test(cleanText(onlineItem?.id)) ? "permanentId" : "legacyId")
        : "sourceIdentity";
      matches.push({
        kind: matchKind,
        key,
        onlineId: cleanText(onlineItem?.id),
        offlineId: cleanText(offlineItem?.id),
        onlineIndex,
        offlineIndex,
        onlineStock,
        offlineStock,
      });
    };

    const idKeys = [...new Set([
      ...indexes.online.keys(),
      ...indexes.offline.keys(),
    ])]
      .filter((key) => key.startsWith("id\u0000"))
      .map((key) => key.slice(3));
    idKeys.forEach((key) => matchByKey("id", key));
    const sourceKeys = [...new Set([
      ...indexes.online.keys(),
      ...indexes.offline.keys(),
    ])]
      .filter((key) => key.startsWith("sourceIdentity\u0000"))
      .map((key) => key.slice("sourceIdentity\u0000".length));
    sourceKeys.forEach((key) => matchByKey("sourceIdentity", key));

    const onlyOnline = online
      .map((item, index) => ({ item, index }))
      .filter(({ index }) => !usedOnline.has(index))
      .map(({ item }) => item);
    const onlyOffline = offline
      .map((item, index) => ({ item, index }))
      .filter(({ index }) => !usedOffline.has(index))
      .map(({ item }) => item);
    const modelOnline = new Map();
    const modelOffline = new Map();
    onlyOnline.forEach((item) => {
      const key = identityPart(item?.model);
      if (key) modelOnline.set(key, [...(modelOnline.get(key) || []), item]);
    });
    onlyOffline.forEach((item) => {
      const key = identityPart(item?.model);
      if (key) modelOffline.set(key, [...(modelOffline.get(key) || []), item]);
    });
    const modelOnlyReview = [...new Set([...modelOnline.keys(), ...modelOffline.keys()])]
      .filter((key) => modelOnline.has(key) && modelOffline.has(key))
      .map((model) => ({
        model,
        onlineIds: modelOnline.get(model).map((item) => cleanText(item?.id)),
        offlineIds: modelOffline.get(model).map((item) => cleanText(item?.id)),
      }));
    const quantityConflicts = matches
      .filter((match) => Number.isFinite(match.onlineStock)
        && Number.isFinite(match.offlineStock)
        && match.onlineStock !== match.offlineStock)
      .map(({ kind, key, onlineStock, offlineStock }) => ({
        kind, key, onlineStock, offlineStock,
      }));
    const items = [
      ...online.filter((_item, index) => usedOnline.has(index)),
      ...onlyOnline,
      ...onlyOffline,
    ];
    return {
      ok: true,
      items,
      matches: matches.map(({ kind, key, onlineId, offlineId }) => ({
        kind, key, onlineId, offlineId,
      })),
      onlyOnline,
      onlyOffline,
      quantityConflicts,
      modelOnlyReview,
      duplicateKeys,
    };
  }

  function hash128(text) {
    let h1 = 1779033703;
    let h2 = 3144134277;
    let h3 = 1013904242;
    let h4 = 2773480762;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    return [h1, h2, h3, h4]
      .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
      .join("");
  }

  function createStableItemId(row) {
    // Row number and mutable product text are locators/content, never identity.
    // Blank legacy rows remain unbound until guarded migration writes a verified ID.
    return cleanText(row?.id);
  }

  function normalizeRow(row) {
    const model = cleanText(row?.model);
    if (!model) return null;
    const suppliedId = cleanText(row?.id);
    const generatedId = Boolean(suppliedId && row?._excelGeneratedId === true);
    const category = cleanText(row?.category) || "未分类";
    const specification = cleanText(row?.specification);
    const blankNewQuantity = (value) => generatedId && cleanText(value) === "" ? 0 : value;
    return {
      ...row,
      id: suppliedId,
      category,
      model,
      specification,
      image: row?.image == null ? "" : cleanText(row.image),
      stock: blankNewQuantity(row?.stock),
      showroomQuantity: blankNewQuantity(row?.showroomQuantity),
      computedTotalSold: blankNewQuantity(row?.computedTotalSold),
      totalSold: blankNewQuantity(row?.totalSold),
      _excelGeneratedId: generatedId,
    };
  }

  function normalizeExcelRows(rows) {
    const output = [];
    const positions = new Map();
    let blankIndex = 0;
    for (const source of Array.isArray(rows) ? rows : []) {
      const row = normalizeRow(source);
      if (!row) continue;
      // Keep every blank row for explicit migration instead of collapsing it.
      const key = row.id ? `id:${row.id}` : `blank:${blankIndex += 1}`;
      const position = positions.get(key);
      if (position == null) {
        positions.set(key, output.length);
        output.push(row);
      } else {
        output[position] = { ...output[position], ...row };
      }
    }
    return output;
  }

  function hasMeaningfulWorkbookChanges(workbook, fallbackMtimeMs) {
    if (typeof workbook?.hasUnacknowledgedChanges === "boolean") {
      return workbook.hasUnacknowledgedChanges;
    }
    const writtenAt = Date.parse(workbook?.sync?.writtenAt || "") || 0;
    const modifiedAt = Number(fallbackMtimeMs ?? workbook?.mtimeMs) || 0;
    return modifiedAt > writtenAt + 2000;
  }

  function mergeExcelRows(existingItems, excelRows) {
    const merged = (Array.isArray(existingItems) ? existingItems : []).map((item) => ({ ...item }));
    const byId = new Map(merged.map((item, index) => [cleanText(item.id), index]));
    const byIdentity = new Map();
    merged.forEach((item, index) => {
      if (!cleanText(item.model)) return;
      const identity = itemIdentity(item);
      const positions = byIdentity.get(identity) || [];
      positions.push(index);
      byIdentity.set(identity, positions);
    });
    const matchedPositions = new Set();

    for (const normalized of normalizeExcelRows(excelRows)) {
      let position = byId.get(cleanText(normalized.id));
      if (position == null && normalized._excelGeneratedId) {
        position = (byIdentity.get(itemIdentity(normalized)) || [])
          .find((candidate) => !matchedPositions.has(candidate));
      }
      const { _excelGeneratedId, ...row } = normalized;
      if (position != null) {
        matchedPositions.add(position);
        const current = merged[position];
        const update = { ...row, id: current.id || row.id };
        if (!row.image) delete update.image;
        merged[position] = { ...current, ...update };
        byId.set(cleanText(merged[position].id), position);
        const identity = itemIdentity(merged[position]);
        const positions = byIdentity.get(identity) || [];
        if (!positions.includes(position)) positions.push(position);
        byIdentity.set(identity, positions);
      } else {
        const created = {
          image: "",
          sourceFile: "TEK-STOCK-LIVE.xlsx",
          sourceSheet: "库存总表",
          sourceRow: Number(row.sourceRow) || 0,
          ...row,
        };
        position = merged.length;
        merged.push(created);
        matchedPositions.add(position);
        byId.set(cleanText(created.id), position);
        const identity = itemIdentity(created);
        const positions = byIdentity.get(identity) || [];
        positions.push(position);
        byIdentity.set(identity, positions);
      }
    }
    return merged;
  }

  function findMissingItemIds(existingItems, excelRows) {
    const existing = Array.isArray(existingItems) ? existingItems : [];
    const byId = new Map(existing.map((item) => [cleanText(item.id), item.id]));
    const byIdentity = new Map();
    existing.forEach((item) => {
      if (!cleanText(item.model)) return;
      const identity = itemIdentity(item);
      const ids = byIdentity.get(identity) || [];
      ids.push(item.id);
      byIdentity.set(identity, ids);
    });
    const presentIds = new Set();
    for (const row of normalizeExcelRows(excelRows)) {
      const matchedId = byId.get(cleanText(row.id))
        || (row._excelGeneratedId
          ? (byIdentity.get(itemIdentity(row)) || []).find((id) => !presentIds.has(id))
          : "");
      presentIds.add(matchedId || row.id);
    }
    return existing
      .map((item) => item.id)
      .filter((id) => id && !presentIds.has(id));
  }

  // An embedded Excel photo is authoritative even if no other cells changed.
  // This prevents an old cloud photo surviving a photo-only Excel edit.
  function shouldImportExcelImage(row) {
    return Boolean(cleanText(row?.image))
      && (row?.imageChanged === true || row?.imageUntracked === true);
  }

  function staleWorkbookPatch(row, baseline) {
    const patch = {};
    const textFields = ["category", "model", "specification", "arrival", "showroom", "outbound"];
    const numericFields = [
      "stock", "showroomQuantity", "computedTotalSold", "cost", "sellingPrice", "totalSold",
    ];
    for (const field of textFields) {
      if (cleanText(row?.[field]) !== cleanText(baseline?.[field])) {
        patch[field] = String(row?.[field] ?? "").trim();
      }
    }
    for (const field of numericFields) {
      const current = row?.[field];
      if (Number.isFinite(current) && Number(current) !== Number(baseline?.[field])) {
        patch[field] = Number(current);
      }
    }
    return patch;
  }

  const THREE_WAY_FIELDS = [
    "category", "model", "stock", "showroomQuantity", "computedTotalSold",
    "cost", "sellingPrice", "sellingPriceText", "specification", "arrival",
    "showroom", "outbound", "totalSold", "image",
  ];
  const NUMERIC_THREE_WAY_FIELDS = new Set([
    "stock", "showroomQuantity", "computedTotalSold", "cost", "sellingPrice", "totalSold",
  ]);
  const CANONICAL_SYNC_FIELDS = [
    "model", "category", "stock", "stockText", "showroomQuantity", "computedTotalSold",
    "totalSold", "cost", "sellingPrice", "sellingPriceText", "specification", "arrival",
    "showroom", "outbound", "sourceFile", "sourceSheet",
  ];
  const NUMERIC_CANONICAL_FIELDS = new Set([...NUMERIC_THREE_WAY_FIELDS]);

  function mergeValue(value) {
    if (value == null) return "";
    if (typeof value === "string") return cleanText(value);
    if (typeof value === "number") return Number.isNaN(value) ? null : value;
    return value;
  }

  function sameMergeValue(left, right) {
    return mergeValue(left) === mergeValue(right);
  }

  function sameFieldMergeValue(field, left, right) {
    if (!NUMERIC_THREE_WAY_FIELDS.has(field)) return sameMergeValue(left, right);
    const numericValue = (value) => {
      if (value == null || value === "") return 0;
      const number = Number(value);
      return Number.isFinite(number) ? number : value;
    };
    return numericValue(left) === numericValue(right);
  }

  function canonicalPhotoIdentity(item) {
    const hash = cleanText(item?.imageSha256).toLowerCase();
    if (hash) return `sha256:${hash}`;
    const version = cleanText(item?.imageVersion);
    if (version) return `version:${version}`;
    const image = cleanText(item?.image);
    return image ? `object:${image}` : "";
  }

  function hasCanonicalPhotoIdentity(item) {
    return Boolean(cleanText(item?.imageSha256) || cleanText(item?.imageVersion));
  }

  function sameCanonicalPhoto(left, right) {
    const leftHash = cleanText(left?.imageSha256).toLowerCase();
    const rightHash = cleanText(right?.imageSha256).toLowerCase();
    if (leftHash && rightHash) return leftHash === rightHash;
    return canonicalPhotoIdentity(left) === canonicalPhotoIdentity(right);
  }

  function sameCanonicalSyncItem(left, right) {
    if (cleanText(left?.id) !== cleanText(right?.id)) return false;
    if (!CANONICAL_SYNC_FIELDS.every((field) => NUMERIC_CANONICAL_FIELDS.has(field)
      ? sameFieldMergeValue(field, left?.[field], right?.[field])
      : sameMergeValue(left?.[field], right?.[field]))) return false;
    return sameCanonicalPhoto(left, right);
  }

  function sameDeletionGuardItem(liveItem, baselineItem) {
    if (cleanText(liveItem?.id) !== cleanText(baselineItem?.id)) return false;
    for (const field of THREE_WAY_FIELDS) {
      if (field === "image" || field === "sellingPriceText") continue;
      if (!sameFieldMergeValue(field, liveItem?.[field], baselineItem?.[field])) return false;
    }
    // Storage URLs and source/provenance text can legitimately change when the
    // runtime/backend changes. Only a canonical photo identity proves a photo
    // mutation strongly enough to block a deletion.
    if (hasCanonicalPhotoIdentity(baselineItem)
        && !sameCanonicalPhoto(liveItem, baselineItem)) return false;
    return true;
  }

  function itemMap(source) {
    if (source instanceof Map) return new Map(source);
    if (Array.isArray(source)) {
      return new Map(source.map((item) => [cleanText(item?.id), item]));
    }
    return new Map(Object.entries(source && typeof source === "object" ? source : {}));
  }

  // Pure, atomic three-way merge:
  // B is the workbook baseline, E is the edited workbook, and L is live cloud data.
  function threeWayWorkbookMerge({ baselineItems, excelRows, liveItems } = {}) {
    const baseline = itemMap(baselineItems);
    const live = itemMap(liveItems);
    const excel = new Map(normalizeExcelRows(excelRows).map((row) => [cleanText(row.id), row]));
    const result = new Map(Array.from(live, ([id, item]) => [id, { ...item }]));
    const conflicts = [];
    const created = [];
    const updated = [];
    const deleted = [];

    for (const [id, baselineItem] of baseline) {
      const excelItem = excel.get(id);
      const liveItem = live.get(id);
      if (!excelItem) {
        if (!liveItem) continue;
        const liveChanged = !sameDeletionGuardItem(liveItem, baselineItem);
        if (liveChanged) {
          conflicts.push({ id, reason: "delete-modified-live" });
        } else {
          result.delete(id);
          deleted.push(id);
        }
        continue;
      }
      if (!liveItem) {
        conflicts.push({ id, reason: "modified-after-live-delete" });
        continue;
      }

      const merged = { ...liveItem };
      let changed = false;
      for (const field of THREE_WAY_FIELDS) {
        // The workbook deliberately leaves row.image blank when its embedded photo
        // is unchanged. Storage URLs can also change when that same photo is
        // published to the cloud, so URL equality is not a valid photo edit signal.
        const excelChanged = field === "image"
          ? shouldImportExcelImage(excelItem)
          : !sameFieldMergeValue(field, excelItem?.[field], baselineItem?.[field]);
        if (!excelChanged) continue;
        const liveChanged = field === "image"
          ? hasCanonicalPhotoIdentity(baselineItem)
            && !sameCanonicalPhoto(liveItem, baselineItem)
          : !sameFieldMergeValue(field, liveItem?.[field], baselineItem?.[field]);
        const alreadyApplied = field === "image"
          ? sameCanonicalPhoto(excelItem, liveItem)
          : sameFieldMergeValue(field, excelItem?.[field], liveItem?.[field]);
        if (alreadyApplied) continue;
        if (liveChanged) {
          conflicts.push({ id, field, reason: "field-modified-both" });
          continue;
        }
        merged[field] = excelItem[field];
        if (field === "image") {
          if (excelItem.imageSha256 !== undefined) merged.imageSha256 = excelItem.imageSha256;
          if (excelItem.imageVersion !== undefined) merged.imageVersion = excelItem.imageVersion;
        }
        changed = true;
      }
      if (changed) {
        result.set(id, merged);
        updated.push(id);
      }
      excel.delete(id);
    }

    for (const [id, row] of excel) {
      if (!row._excelGeneratedId || baseline.has(id)) {
        conflicts.push({ id, reason: "baseline-missing" });
        continue;
      }
      const existing = live.get(id);
      const addition = Object.fromEntries([
        "id", ...THREE_WAY_FIELDS, "sourceFile", "sourceSheet",
      ].map((field) => [field, row[field]]).filter(([, value]) => value !== undefined));
      if (existing) {
        const differs = THREE_WAY_FIELDS.some(
          (field) => !sameFieldMergeValue(field, existing?.[field], addition?.[field]),
        );
        if (differs) conflicts.push({ id, reason: "addition-id-collision" });
        continue;
      }
      result.set(id, addition);
      created.push(id);
    }

    if (conflicts.length) {
      return {
        ok: false,
        items: Array.from(live.values(), (item) => ({ ...item })),
        conflicts,
        created: [],
        updated: [],
        deleted: [],
      };
    }
    return {
      ok: true,
      items: Array.from(result.values()),
      conflicts: [],
      created,
      updated,
      deleted,
    };
  }

  // Recover only pure additions, including an upload that succeeded before Excel acknowledgement.
  function recoverAdditiveWorkbookMerge({
    workbookRevision,
    workbookExpectedItemCount,
    liveRevision,
    liveItems,
    excelRows,
  } = {}) {
    const live = itemMap(liveItems);
    const rows = normalizeExcelRows(excelRows);
    const existing = rows.filter((row) => row._excelGeneratedId !== true);
    const additions = rows.filter((row) => row._excelGeneratedId === true);
    const workbookRev = Number(workbookRevision);
    const liveRev = Number(liveRevision);
    const expectedCount = Number(workbookExpectedItemCount);
    const pendingAdditions = !!liveRev
      && workbookRev === liveRev
      && expectedCount === live.size;
    const additionsAlreadyPresent = !!liveRev
      && liveRev === workbookRev + 1
      && live.size === expectedCount + additions.length;
    if ((!pendingAdditions && !additionsAlreadyPresent)
        || existing.length !== expectedCount
        || additions.length === 0) return null;

    const seen = new Set();
    for (const row of existing) {
      const id = cleanText(row.id);
      const current = live.get(id);
      if (!id || seen.has(id) || !current || shouldImportExcelImage(row)) return null;
      seen.add(id);
      const changed = THREE_WAY_FIELDS.some((field) => field !== "image" && field !== "sellingPriceText"
        && !sameFieldMergeValue(field, row?.[field], current?.[field]));
      if (changed) return null;
    }

    const additionIds = new Set();
    for (const row of additions) {
      const id = cleanText(row.id);
      if (!id || !cleanText(row.model) || !Number.isFinite(row.stock)
          || additionIds.has(id)) return null;
      additionIds.add(id);
      const current = live.get(id);
      if (pendingAdditions && current) return null;
      if (additionsAlreadyPresent) {
        if (!current) return null;
        const fields = [...THREE_WAY_FIELDS, "sourceFile", "sourceSheet"];
        if (fields.some((field) => !sameFieldMergeValue(field, row?.[field], current?.[field]))) {
          return null;
        }
      }
    }

    if (additionsAlreadyPresent) {
      return {
        ok: true,
        items: Array.from(live.values(), (item) => ({ ...item })),
        conflicts: [],
        created: [],
        updated: [],
        deleted: [],
      };
    }

    const mergeRows = rows.map((row) => row._excelGeneratedId === true
      ? row
      : { ...row, sellingPriceText: live.get(cleanText(row.id))?.sellingPriceText });
    const merge = threeWayWorkbookMerge({
      baselineItems: liveItems,
      excelRows: mergeRows,
      liveItems,
    });
    if (!merge.ok
        || merge.created.length !== additions.length
        || merge.updated.length !== 0
        || merge.deleted.length !== 0) return null;
    return merge;
  }

  function recoverPureDeletionWorkbookMerge({
    workbookRevision,
    workbookExpectedItemCount,
    liveRevision,
    liveItems,
    excelRows,
    workbookWasEdited,
    excelRowIdsUnique,
  } = {}) {
    const live = itemMap(liveItems);
    const rows = normalizeExcelRows(excelRows);
    const revision = Number(liveRevision);
    const expectedCount = Number(workbookExpectedItemCount);
    if (workbookWasEdited !== true
        || excelRowIdsUnique !== true
        || !revision
        || Number(workbookRevision) !== revision
        || expectedCount !== live.size
        || rows.length >= live.size
        || rows.some((row) => row._excelGeneratedId === true)) return null;

    const presentIds = new Set();
    for (const row of rows) {
      const id = cleanText(row.id);
      const current = live.get(id);
      if (!id || presentIds.has(id) || !current || shouldImportExcelImage(row)) return null;
      presentIds.add(id);
      const changed = THREE_WAY_FIELDS.some((field) => field !== "image" && field !== "sellingPriceText"
        && !sameFieldMergeValue(field, row?.[field], current?.[field]));
      if (changed) return null;
    }

    const deleted = Array.from(live.keys()).filter((id) => !presentIds.has(id));
    if (!deleted.length || rows.length + deleted.length !== live.size) return null;
    return {
      ok: true,
      items: Array.from(live, ([id, item]) => presentIds.has(id) ? { ...item } : null)
        .filter(Boolean),
      conflicts: [],
      created: [],
      updated: [],
      deleted,
    };
  }

  function mergeWorkbookSnapshot({
    workbookRevision,
    workbookExpectedItemCount,
    baselineRevision,
    baselineItemCount,
    baselineRecords,
    liveRevision,
    liveItems,
    excelRows,
    allowAdditiveRecovery = true,
    allowPureDeletionRecovery = true,
    workbookWasEdited = false,
    excelRowIdsUnique = false,
  } = {}) {
    const completeBaseline = Array.isArray(baselineRecords)
      && Number(baselineRevision) === Number(workbookRevision)
      && Number(baselineItemCount) === Number(workbookExpectedItemCount)
      && baselineRecords.length === Number(workbookExpectedItemCount);
    if (completeBaseline) {
      return threeWayWorkbookMerge({
        baselineItems: baselineRecords,
        excelRows,
        liveItems,
      });
    }
    if (allowAdditiveRecovery) {
      const additive = recoverAdditiveWorkbookMerge({
        workbookRevision,
        workbookExpectedItemCount,
        liveRevision,
        liveItems,
        excelRows,
      });
      if (additive) return additive;
    }
    if (!allowPureDeletionRecovery) return null;
    return recoverPureDeletionWorkbookMerge({
      workbookRevision,
      workbookExpectedItemCount,
      liveRevision,
      liveItems,
      excelRows,
      workbookWasEdited,
      excelRowIdsUnique,
    });
  }

  function canApplyWorkbookDeletions({
    lastRemoteRevision,
    workbookRevision,
    workbookMtimeMs,
    lastRemoteUpdatedAt,
    workbookExpectedItemCount,
    remoteItemCount,
  } = {}) {
    const remoteRevision = Math.max(0, Number(lastRemoteRevision) || 0);
    const excelRevision = Math.max(0, Number(workbookRevision) || 0);
    const expectedCount = Math.max(0, Math.trunc(Number(workbookExpectedItemCount) || 0));
    const currentRemoteCount = Math.max(0, Math.trunc(Number(remoteItemCount) || 0));
    if (!expectedCount || !currentRemoteCount || expectedCount !== currentRemoteCount) return false;
    if (!remoteRevision || excelRevision >= remoteRevision) return true;
    const savedAt = Math.max(0, Number(workbookMtimeMs) || 0);
    const remoteUpdatedAt = Math.max(0, Number(lastRemoteUpdatedAt) || 0);
    return remoteUpdatedAt > 0 && savedAt > remoteUpdatedAt;
  }

  function discardLegacyDeletionTombstones(source) {
    const edits = {};
    let removed = 0;
    for (const [id, patch] of Object.entries(source && typeof source === "object" ? source : {})) {
      if (patch?._deleteProduct) {
        removed += 1;
        continue;
      }
      edits[id] = patch;
    }
    return { edits, removed };
  }

  function sanitizeDeletionTombstones(source, {
    remoteRevision,
    remoteItemCount,
  } = {}) {
    const revision = Math.max(0, Math.trunc(Number(remoteRevision) || 0));
    const itemCount = Math.max(0, Math.trunc(Number(remoteItemCount) || 0));
    const edits = {};
    let removed = 0;
    for (const [id, patch] of Object.entries(source && typeof source === "object" ? source : {})) {
      if (!patch?._deleteProduct) {
        edits[id] = patch;
        continue;
      }
      const baselineRevision = Math.max(0, Math.trunc(Number(patch._deleteBaselineRevision) || 0));
      const baselineItemCount = Math.max(0, Math.trunc(Number(patch._deleteBaselineItemCount) || 0));
      if (revision && itemCount
          && baselineRevision === revision
          && baselineItemCount === itemCount) {
        edits[id] = patch;
      } else {
        removed += 1;
      }
    }
    return { edits, removed };
  }

  return {
    cleanText,
    createStableItemId,
    itemIdentity,
    explicitSourceIdentity,
    mergeInventoryViews,
    hasMeaningfulWorkbookChanges,
    normalizeExcelRows,
    mergeExcelRows,
    findMissingItemIds,
    shouldImportExcelImage,
    staleWorkbookPatch,
    threeWayWorkbookMerge,
    recoverAdditiveWorkbookMerge,
    recoverPureDeletionWorkbookMerge,
    mergeWorkbookSnapshot,
    canApplyWorkbookDeletions,
    discardLegacyDeletionTombstones,
    sanitizeDeletionTombstones,
  };
}));
