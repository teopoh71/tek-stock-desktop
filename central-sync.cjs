"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createApiRequester } = require("./api-failover.cjs");
const { createSyncOutbox } = require("./sync-outbox.cjs");
const { buildWorkbookDelta, planBlankIdRows } = require("./inventory/excel-delta-core.js");
const { threeWayWorkbookMerge } = require("./inventory/excel-sync-core.js");
const { planReviewedLegacyReconciliation, verifyReviewedLegacyReconciliationResult }
  = require("./workbook-identity-migration.cjs");

const MAX_PHOTO_BYTES = 15_000_000;
const MAX_CONFIRMED_REVISION_REBASES = 3;
const ITEM_FIELDS = new Set([
  "id", "model", "category", "stock", "stockText", "showroomQuantity",
  "computedTotalSold", "totalSold", "cost", "sellingPrice", "sellingPriceText",
  "specification", "arrival", "showroom", "outbound", "sourceFile",
  "sourceSheet", "image", "imageSha256", "imageVersion",
]);
const WORKBOOK_TEXT_FIELDS = ["model", "category", "specification", "arrival", "showroom", "outbound"];
const WORKBOOK_NUMBER_FIELDS = ["stock", "showroomQuantity", "computedTotalSold", "totalSold", "cost", "sellingPrice"];
const SAFE_PERMANENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
// Transitional IDs already present in older cloud snapshots. They remain
// mutation-read-only except for an exact delete proven safe by the workbook
// three-way merge and revalidated after every cloud revision change.
const LEGACY_RECORD_ID = /^[^:\r\n]{1,160}::[^:\r\n]{1,160}::[1-9]\d{0,8}$/u;

function syncError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function conflictIdentity(details) {
  return JSON.stringify((Array.isArray(details) ? details : []).map((detail) => ({
    itemId: String(detail?.itemId || detail?.id || ""),
    field: String(detail?.field || ""),
    reason: String(detail?.reason || ""),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function atomicJson(file, value, fsApi = fs) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  const descriptor = fsApi.openSync(temporary, "w", 0o600);
  try {
    fsApi.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsApi.fsyncSync(descriptor);
  } finally {
    fsApi.closeSync(descriptor);
  }
  fsApi.renameSync(temporary, file);
}

function safeSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw syncError("CLOUD_SNAPSHOT_INVALID", { snapshotField: "root" });
  }
  if (!Array.isArray(value.items)) {
    throw syncError("CLOUD_SNAPSHOT_INVALID", { snapshotField: "items" });
  }
  if (!Number.isSafeInteger(Number(value.revision)) || Number(value.revision) < 0) {
    throw syncError("CLOUD_SNAPSHOT_INVALID", { snapshotField: "revision" });
  }
  const changeSequence = value.changeSequence == null ? null : Number(value.changeSequence);
  if (changeSequence != null
      && (!Number.isSafeInteger(changeSequence) || changeSequence < 0)) {
    throw syncError("CLOUD_SNAPSHOT_INVALID", { snapshotField: "changeSequence" });
  }
  const ids = new Set();
  let legacyItemCount = 0;
  for (const item of value.items) {
    const id = String(item?.id || "").trim();
    if (!SAFE_PERMANENT_ID.test(id)) {
      if (!LEGACY_RECORD_ID.test(id)) throw syncError("CLOUD_ITEM_ID_INVALID");
      legacyItemCount += 1;
    }
    if (ids.has(id)) throw syncError("CLOUD_ITEM_ID_INVALID");
    ids.add(id);
  }
  return {
    ...value,
    revision: Number(value.revision),
    changeSequence,
    items: sortItemsDeterministically(value.items),
    identityState: legacyItemCount ? "legacy" : "stable",
    legacyItemCount,
  };
}

function compareText(left, right) {
  const a = String(left || "").normalize("NFKC");
  const b = String(right || "").normalize("NFKC");
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortItemsDeterministically(source) {
  return [...(Array.isArray(source) ? source : [])].sort((left, right) => {
    const leftHasRow = Number.isSafeInteger(Number(left?.sourceRow)) && Number(left.sourceRow) > 0;
    const rightHasRow = Number.isSafeInteger(Number(right?.sourceRow)) && Number(right.sourceRow) > 0;
    if (leftHasRow !== rightHasRow) return leftHasRow ? -1 : 1;
    if (!leftHasRow) return compareText(left?.id, right?.id);
    for (const field of ["sourceFile", "sourceSheet"]) {
      const compared = compareText(left?.[field], right?.[field]);
      if (compared) return compared;
    }
    const leftRow = Number(left.sourceRow);
    const rightRow = Number(right.sourceRow);
    if (leftRow !== rightRow) return leftRow - rightRow;
    return compareText(left?.id, right?.id);
  });
}

function cleanItem(source) {
  const item = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (ITEM_FIELDS.has(key) && value !== undefined) item[key] = value;
  }
  item.id = String(item.id || "").trim();
  if (!SAFE_PERMANENT_ID.test(item.id)) throw syncError("PERMANENT_ID_REQUIRED");
  return item;
}

function cleanRemoteItem(source) {
  const item = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (ITEM_FIELDS.has(key) && value !== undefined) item[key] = value;
  }
  item.id = String(item.id || "").trim();
  if (!SAFE_PERMANENT_ID.test(item.id) && !LEGACY_RECORD_ID.test(item.id)) {
    throw syncError("CLOUD_ITEM_ID_INVALID");
  }
  return item;
}

function cleanPatch(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw syncError("SYNC_PATCH_INVALID");
  }
  const patch = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "id" || !ITEM_FIELDS.has(key)) throw syncError("SYNC_PATCH_INVALID");
    if (value !== undefined) patch[key] = value;
  }
  if (!Object.keys(patch).length) throw syncError("SYNC_PATCH_INVALID");
  return patch;
}

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function photoIdentity(source) {
  const digest = String(source?.imageSha256 || source?.sha256 || "").trim().toLowerCase();
  if (digest) return `sha256:${digest}`;
  const version = String(source?.imageVersion || "").trim();
  if (version) return `version:${version}`;
  const objectKey = String(source?.image || source?.objectKey || "").trim();
  return objectKey ? `object:${objectKey}` : "";
}

function samePhotoIdentity(left, right) {
  const leftHash = String(left?.imageSha256 || left?.sha256 || "").trim().toLowerCase();
  const rightHash = String(right?.imageSha256 || right?.sha256 || "").trim().toLowerCase();
  if (leftHash && rightHash) return leftHash === rightHash;
  return photoIdentity(left) === photoIdentity(right);
}

function unsafeRebaseConflicts(entry, existing) {
  const base = entry.baseItem;
  if (!base) return [];
  if (entry.type === "update") {
    return Object.entries(entry.patch || {}).flatMap(([field, wanted]) =>
      sameValue(existing?.[field], base?.[field]) || sameValue(existing?.[field], wanted)
        ? []
        : [{ itemId: entry.itemId, field, reason: "field-modified-both" }]);
  }
  if (entry.type === "delete") {
    const changed = [...ITEM_FIELDS].some((field) =>
      !sameValue(existing?.[field], base?.[field]));
    return changed ? [{ itemId: entry.itemId, reason: "delete-modified-live" }] : [];
  }
  if (entry.type === "image") {
    return samePhotoIdentity(existing, base) || samePhotoIdentity(existing, entry.image)
      ? []
      : [{ itemId: entry.itemId, field: "image", reason: "field-modified-both" }];
  }
  return [];
}

function workbookComparableItem(source) {
  const item = { id: String(source?.id || "").trim() };
  for (const field of WORKBOOK_TEXT_FIELDS) item[field] = String(source?.[field] || "");
  for (const field of WORKBOOK_NUMBER_FIELDS) {
    const value = source?.[field];
    item[field] = value === "" || value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  }
  item.imageIdentity = String(source?.imageSha256 || source?.imageVersion || source?.image || "");
  return item;
}

function workbookMatchesSnapshot(currentRows, confirmedItems) {
  const current = new Map((currentRows || []).map((item) => [String(item?.id || "").trim(), item]));
  const confirmed = new Map((confirmedItems || []).map((item) => [String(item?.id || "").trim(), item]));
  if (current.size !== confirmed.size || current.has("") || confirmed.has("")) return false;
  for (const [id, item] of current) {
    if (!confirmed.has(id)) return false;
    if (JSON.stringify(workbookComparableItem(item))
        !== JSON.stringify(workbookComparableItem(confirmed.get(id)))) return false;
  }
  return true;
}

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:(image\/(?:webp|png|jpeg));base64,([a-z0-9+/=]+)$/i);
  if (!match) throw syncError("PHOTO_DATA_INVALID");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) throw syncError("PHOTO_SIZE_INVALID");
  return { mimeType: match[1].toLowerCase(), buffer };
}

function extensionFor(mimeType) {
  return mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp";
}

function createCentralSync(options = {}) {
  const root = path.resolve(String(options.storageDirectory || ""));
  if (!path.isAbsolute(String(options.storageDirectory || ""))) throw syncError("SYNC_STORAGE_INVALID");
  const fsApi = options.fsApi || fs;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getOssBaseUrl = options.getOssBaseUrl || (() => "");
  const changePageLimit = Math.min(1000, Math.max(1,
    Math.trunc(Number(options.changePageLimit) || 500)));
  const readOnly = options.readOnly === true;
  const outbox = createSyncOutbox({
    file: path.join(root, "outbox.json"),
    fsApi,
    getOperator: options.getOperator,
    operator: options.operator,
    now: options.now,
  });
  const snapshotFile = path.join(root, "last-good-snapshot.json");
  const photoRoot = path.join(root, "photo-cache");
  const verifiedPhotoFiles = new Set();
  const photoCacheJobs = new Map();
  let lastKnownSnapshot;
  const request = createApiRequester({
    fetchImpl,
    getToken: options.getToken,
    getApiBaseUrl: options.getApiBaseUrl,
    getApiFallbackBaseUrls: options.getApiFallbackBaseUrls,
    getAuthorityId: options.getAuthorityId,
    requestTimeoutMs: options.requestTimeoutMs,
    allowHttp: options.allowHttp,
  });

  function photoPath(itemId, digest, mimeType = "image/webp") {
    if (!/^[a-f0-9]{64}$/.test(String(digest || ""))) throw syncError("PHOTO_SHA256_INVALID");
    const productKey = sha256(Buffer.from(String(itemId || ""))).slice(0, 32);
    return path.join(photoRoot, productKey, `${digest}.${extensionFor(mimeType)}`);
  }

  function remotePhotoUrl(item) {
    const image = String(item?.image || "").trim();
    if (/^https:\/\//i.test(image)) return image;
    if (!/^photos\//.test(image)) return "";
    const base = String(getOssBaseUrl() || "").trim().replace(/\/$/, "");
    if (!/^https:\/\//i.test(base)) return "";
    return `${base}/${image.split("/").map(encodeURIComponent).join("/")}`;
  }

  function cachedPhotoUrl(item) {
    const digest = String(item?.imageSha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest)) return "";
    for (const mimeType of ["image/webp", "image/jpeg", "image/png"]) {
      const file = photoPath(item.id, digest, mimeType);
      if (verifiedPhotoFiles.has(file) && fsApi.existsSync(file)) return pathToFileURL(file).href;
    }
    return "";
  }

  async function cachePhotoNow(item) {
    const digest = String(item?.imageSha256 || "").toLowerCase();
    const remoteUrl = remotePhotoUrl(item);
    if (!/^[a-f0-9]{64}$/.test(digest) || !remoteUrl) return "";
    const existing = cachedPhotoUrl(item);
    if (existing) return existing;
    for (const mimeType of ["image/webp", "image/jpeg", "image/png"]) {
      const file = photoPath(item.id, digest, mimeType);
      if (!fsApi.existsSync(file)) continue;
      const bytes = await fsApi.promises.readFile(file);
      if (sha256(bytes) === digest) {
        verifiedPhotoFiles.add(file);
        return pathToFileURL(file).href;
      }
      await fsApi.promises.rm(file, { force: true });
    }
    const response = await fetchImpl(remoteUrl, { cache: "no-store" });
    if (!response.ok) throw syncError(`PHOTO_HTTP_${response.status}`);
    const length = Number(response.headers?.get?.("content-length") || 0);
    if (length > MAX_PHOTO_BYTES) throw syncError("PHOTO_SIZE_INVALID");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_PHOTO_BYTES || sha256(buffer) !== digest) {
      throw syncError("PHOTO_HASH_MISMATCH");
    }
    const mimeType = String(response.headers?.get?.("content-type") || "image/webp").split(";")[0];
    const file = photoPath(item.id, digest, mimeType);
    fsApi.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.part`;
    fsApi.writeFileSync(temporary, buffer, { mode: 0o600 });
    if (sha256(fsApi.readFileSync(temporary)) !== digest) {
      fsApi.rmSync(temporary, { force: true });
      throw syncError("PHOTO_HASH_MISMATCH");
    }
    fsApi.renameSync(temporary, file);
    verifiedPhotoFiles.add(file);
    return pathToFileURL(file).href;
  }

  function cachePhoto(item) {
    const digest = String(item?.imageSha256 || "").toLowerCase();
    const key = `${String(item?.id || "")}\u0000${digest}`;
    if (photoCacheJobs.has(key)) return photoCacheJobs.get(key);
    const job = cachePhotoNow(item).finally(() => photoCacheJobs.delete(key));
    photoCacheJobs.set(key, job);
    return job;
  }

  function decorateSnapshot(snapshot) {
    const items = snapshot.items.map((item) => ({
      ...item,
      image: cachedPhotoUrl(item) || remotePhotoUrl(item) || String(item.image || ""),
    }));
    for (const item of snapshot.items) void cachePhoto(item).catch(() => {});
    return { ...snapshot, items };
  }

  function decorateWorkbookSnapshot(snapshot) {
    const items = snapshot.items.map((item) => {
      const cachedImage = cachedPhotoUrl(item);
      void cachePhoto(item).catch(() => {});
      return {
        ...item,
        canonicalImage: String(item.image || ""),
        image: cachedImage,
        photoCachePending: !cachedImage && !!remotePhotoUrl(item),
      };
    });
    return { ...snapshot, items };
  }

  async function readLiveSnapshot() {
    const live = await request("/v1/snapshot", { validateResponse: safeSnapshot });
    atomicJson(snapshotFile, live, fsApi);
    lastKnownSnapshot = live;
    return live;
  }

  function isTransientCloudError(error) {
    const code = String(error?.code || error?.message || "").toUpperCase();
    return code === "API_NETWORK_UNREACHABLE"
      || code === "API_REQUEST_TIMEOUT"
      || code === "ENETUNREACH"
      || code === "ECONNRESET"
      || code === "ECONNREFUSED"
      || code === "EAI_AGAIN"
      || code === "OFFLINE";
  }

  async function withReadRetry(operation) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === 1 || !isTransientCloudError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw lastError;
  }

  async function readChanges(afterRevision, afterSequence = null, limit = changePageLimit) {
    const revision = Math.max(0, Math.trunc(Number(afterRevision) || 0));
    const query = new URLSearchParams({
      after_revision: String(revision),
      limit: String(Math.min(1000, Math.max(1, Math.trunc(Number(limit) || changePageLimit)))),
    });
    if (afterSequence != null) {
      const sequence = Number(afterSequence);
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw syncError("CHANGE_FEED_INVALID");
      query.set("after_sequence", String(sequence));
    }
    return request(`/v1/changes?${query}`);
  }

  async function refreshFromChanges(cached) {
    let current = JSON.parse(JSON.stringify(cached));
    for (let page = 0; page < 20; page += 1) {
      const result = await readChanges(current.revision, current.changeSequence);
      if (!Array.isArray(result.events)) throw syncError("CHANGE_FEED_INVALID");
      const order = current.items.map((item) => String(item.id));
      const map = new Map(current.items.map((item) => [String(item.id), item]));
      for (const event of result.events) {
        const itemId = String(event?.itemId || "").trim();
        if (!itemId || !["upsert", "delete"].includes(event?.operation)) {
          throw syncError("CHANGE_FEED_INVALID");
        }
        if (event.operation === "delete") {
          map.delete(itemId);
          const index = order.indexOf(itemId);
          if (index >= 0) order.splice(index, 1);
        } else {
          const item = cleanRemoteItem(event.item);
          if (item.id !== itemId) throw syncError("CHANGE_FEED_INVALID");
          if (!map.has(itemId)) order.push(itemId);
          map.set(itemId, item);
        }
      }
      const toRevision = Math.max(current.revision, Math.trunc(Number(result.toRevision) || 0));
      const toSequence = result.toSequence == null ? current.changeSequence : Number(result.toSequence);
      if (toSequence != null && (!Number.isSafeInteger(toSequence) || toSequence < 0)) {
        throw syncError("CHANGE_FEED_INVALID");
      }
      const cursorAdvanced = toRevision > current.revision
        || (toRevision === current.revision && toSequence != null
          && (current.changeSequence == null || toSequence > current.changeSequence));
      if (result.hasMore && !cursorAdvanced) throw syncError("CHANGE_FEED_INVALID");
      current = {
        ...current,
        revision: toRevision,
        changeSequence: toSequence,
        updatedAt: result.events.at(-1)?.createdAt || current.updatedAt,
        items: sortItemsDeterministically(order.filter((id) => map.has(id)).map((id) => map.get(id))),
      };
      if (!result.hasMore) {
        const remoteRevision = Math.trunc(Number(result.currentRevision) || toRevision);
        if (remoteRevision !== toRevision) throw syncError("CHANGE_FEED_INCOMPLETE");
        atomicJson(snapshotFile, current, fsApi);
        lastKnownSnapshot = current;
        return current;
      }
    }
    throw syncError("CHANGE_FEED_TOO_LARGE");
  }

  async function snapshot(allowCache = true) {
    try {
      let live;
      if (fsApi.existsSync(snapshotFile)) {
        const cached = safeSnapshot(JSON.parse(fsApi.readFileSync(snapshotFile, "utf8")));
        try {
          live = await withReadRetry(() => refreshFromChanges(cached));
        } catch (error) {
          if (error.status !== 410 && error.code !== "SNAPSHOT_REQUIRED"
              && error.code !== "CHANGE_FEED_INCOMPLETE") throw error;
          live = await withReadRetry(() => readLiveSnapshot());
        }
      } else {
        live = await withReadRetry(() => readLiveSnapshot());
      }
      return { ...decorateSnapshot(live), cloudState: "live" };
    } catch (error) {
      if (!allowCache || !fsApi.existsSync(snapshotFile)) throw error;
      const cached = safeSnapshot(JSON.parse(fsApi.readFileSync(snapshotFile, "utf8")));
      lastKnownSnapshot = cached;
      return { ...decorateSnapshot(cached), cloudState: "cached", offlineError: error.code || "OFFLINE" };
    }
  }

  function enqueue(operations, workbookSha256 = "", context = {}) {
    if (readOnly) throw syncError("READ_ONLY_CLIENT");
    const baseSnapshot = context.baseSnapshot || lastKnownSnapshot;
    const baseItems = new Map((baseSnapshot?.items || []).map((item) => [String(item.id), item]));
    const entries = [];
    for (const operation of Array.isArray(operations) ? operations : []) {
      const type = String(operation?.type || "");
      const itemId = String(operation?.itemId || operation?.item?.id || "").trim();
      if (!SAFE_PERMANENT_ID.test(itemId) || !["create", "update", "delete"].includes(type)) {
        throw syncError("SYNC_OPERATION_INVALID");
      }
      const baseItem = operation.baseItem || baseItems.get(itemId);
      entries.push(outbox.enqueue({
        type,
        itemId,
        item: operation.item && cleanItem(operation.item),
        patch: operation.patch && cleanPatch(operation.patch),
        baseItem: baseItem && cleanItem(baseItem),
        baseRevision: operation.baseRevision ?? baseSnapshot?.revision,
        workbookSha256,
        operator: operation.operator || context.operator,
        occurredAt: operation.occurredAt || context.occurredAt,
      }));
    }
    return entries;
  }

  function workbookBatchOperations(operations, baseItems) {
    const baseById = new Map((baseItems || []).map((item) => [String(item.id), item]));
    return (Array.isArray(operations) ? operations : []).map((operation) => {
      const type = String(operation?.type || "");
      const itemId = String(operation?.itemId || operation?.item?.id || "").trim();
      if (type === "upsert") return { type, item: cleanItem(operation.item) };
      if (type === "create") return { type: "upsert", item: cleanItem(operation.item) };
      if (type === "update") {
        const existing = baseById.get(itemId);
        if (!existing) throw syncError("ITEM_NOT_FOUND");
        return { type: "upsert", item: cleanItem({ ...existing, ...cleanPatch(operation.patch) }) };
      }
      if (type === "delete" && itemId) return { type, itemId };
      throw syncError("SYNC_OPERATION_INVALID");
    });
  }

  function enqueueWorkbook(operations, workbookSha256 = "", context = {}) {
    if (readOnly) throw syncError("READ_ONLY_CLIENT");
    const baseSnapshot = context.baseSnapshot || lastKnownSnapshot;
    if (!baseSnapshot) throw syncError("CLOUD_SNAPSHOT_REQUIRED");
    const baseItems = (baseSnapshot.items || []).map((item) => cleanRemoteItem(item));
    return outbox.enqueueWorkbookTransaction({
      operations: workbookBatchOperations(operations, baseItems),
      baseRevision: baseSnapshot.revision,
      baseItems,
      workbookSha256,
      operator: context.operator,
      occurredAt: context.occurredAt,
    });
  }

  function requestedWorkbookItems(entry) {
    const baselineIds = new Set(entry.baseItems.map((item) => String(item.id)));
    const order = entry.baseItems.map((item) => String(item.id));
    const map = new Map(entry.baseItems.map((item) => [String(item.id), { ...item }]));
    for (const operation of entry.operations) {
      if (operation.type === "delete") {
        map.delete(String(operation.itemId));
        continue;
      }
      const item = cleanItem(operation.item);
      if (!map.has(item.id)) order.push(item.id);
      map.set(item.id, baselineIds.has(item.id) ? item : { ...item, _excelGeneratedId: true });
    }
    return order.filter((id) => map.has(id)).map((id) => map.get(id));
  }

  function rebaseWorkbookEntry(entry, current) {
    const merged = threeWayWorkbookMerge({
      baselineItems: entry.baseItems,
      excelRows: requestedWorkbookItems(entry),
      liveItems: current.items,
    });
    if (!merged.ok) {
      const conflicts = merged.conflicts.map(({ id, ...conflict }) => ({
        itemId: id,
        ...conflict,
      }));
      throw syncError("CONCURRENT_MODIFICATION", { conflicts });
    }
    const delta = buildWorkbookDelta({
      baselineRecords: current.items,
      currentRows: merged.items,
      allowedLegacyDeleteIds: merged.deleted,
      allowedLegacyIds: current.items
        .map((item) => String(item?.id || "").trim())
        .filter((id) => LEGACY_RECORD_ID.test(id)),
      // IDs created by this durable workbook operation were already assigned
      // through the guarded Excel write-back path.  Preserve that authority
      // across a 409 rebase without allowing arbitrary edited IDs.
      allowedExistingIds: (() => {
        const baselineIds = new Set(entry.baseItems.map((item) => String(item?.id || "")));
        return entry.operations
          .filter((operation) => operation?.type === "upsert"
            && !baselineIds.has(String(operation?.item?.id || "")))
          .map((operation) => String(operation?.item?.id || ""));
      })(),
    });
    if (!delta.ok) throw syncError("CONCURRENT_MODIFICATION", { conflicts: delta.conflicts });
    if (!delta.operations.length) return null;
    const mergedById = new Map(merged.items.map((item) => [String(item.id), item]));
    const rebasedOperations = delta.operations;
    return outbox.rebaseWorkbookTransaction(entry.opId, {
      operations: workbookBatchOperations(rebasedOperations, current.items),
      baseRevision: current.revision,
      baseItems: current.items,
      explicitResolution: entry.explicitResolution === true,
      resolutionOfOpId: entry.resolutionOfOpId,
    });
  }

  async function flushEntry(entry, current) {
    if (entry.type === "workbook") {
      outbox.markSent(entry.opId);
      return request("/v1/items/batch", {
        method: "POST", write: true,
        headers: {
          "content-type": "application/json",
          "idempotency-key": entry.opId,
          "x-tek-stock-client-id": encodeURIComponent(entry.clientId),
          "x-tek-stock-client-seq": String(entry.clientSeq),
          "x-tek-stock-occurred-at": entry.occurredAt,
          "x-tek-stock-operator": encodeURIComponent(entry.operator),
        },
        body: JSON.stringify(entry.requestBody),
      });
    }
    const map = new Map(current.items.map((item) => [String(item.id), item]));
    const existing = map.get(entry.itemId);
    if (["update", "delete", "image"].includes(entry.type) && !existing) {
      if (entry.type === "delete") return { ok: true, revision: current.revision, replayed: true };
      throw syncError("ITEM_NOT_FOUND");
    }
    if (["update", "delete", "image"].includes(entry.type) && entry.baseItem === undefined) {
      entry = outbox.captureBase(entry.opId, { baseItem: existing, baseRevision: current.revision });
    }
    const rebaseConflicts = unsafeRebaseConflicts(entry, existing);
    if (rebaseConflicts.length) {
      throw syncError("CONCURRENT_MODIFICATION", { conflicts: rebaseConflicts });
    }
    let route = "/v1/items/batch";
    let body;
    if (entry.type === "image") {
      if (String(existing.imageSha256 || "") === String(entry.image?.sha256 || "")) {
        return { ok: true, revision: current.revision, replayed: true };
      }
      route = "/v1/photos/commit";
      body = { ...entry.image, itemId: entry.itemId, expectedRevision: current.revision };
    } else if (entry.type === "delete") {
      body = { expectedRevision: current.revision, operations: [{ type: "delete", itemId: entry.itemId }] };
    } else {
      if (entry.type === "create" && existing) {
        const wanted = cleanItem(entry.item);
        const matches = Object.entries(wanted).every(([key, value]) =>
          JSON.stringify(existing[key] ?? null) === JSON.stringify(value ?? null));
        if (matches) return { ok: true, revision: current.revision, replayed: true };
        throw syncError("ITEM_ALREADY_EXISTS");
      }
      if (entry.type === "update"
          && Object.entries(entry.patch || {}).every(([key, value]) =>
            JSON.stringify(existing[key] ?? null) === JSON.stringify(value ?? null))) {
        return { ok: true, revision: current.revision, replayed: true };
      }
      const item = cleanItem(entry.type === "create" ? entry.item : { ...existing, ...(entry.patch || {}) });
      body = { expectedRevision: current.revision, operations: [{ type: "upsert", item }] };
    }
    outbox.markSent(entry.opId);
    return request(route, {
      method: "POST", write: true,
      headers: {
        "content-type": "application/json",
        "idempotency-key": entry.opId,
        "x-tek-stock-client-id": encodeURIComponent(entry.clientId),
        "x-tek-stock-client-seq": String(entry.clientSeq),
        "x-tek-stock-occurred-at": entry.occurredAt,
        "x-tek-stock-operator": encodeURIComponent(entry.operator),
      },
      body: JSON.stringify(body),
    });
  }

  async function flushRetryableEntry(queuedEntry, initialSnapshot) {
    let current = initialSnapshot;
    let entry = queuedEntry;
    let result;
    let confirmedRebases = 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await flushEntry(entry, current);
        break;
      } catch (error) {
        if (error.status === 409 && error.code === "REVISION_CONFLICT") {
          current = await readLiveSnapshot();
          if (entry.type === "workbook") {
            if (confirmedRebases >= MAX_CONFIRMED_REVISION_REBASES) {
              const conflictDetails = [{
                reason: "revision-rebase-exhausted",
                currentRevision: current.revision,
                confirmedRebases,
              }];
              outbox.markConflict(entry.opId, {
                conflictCode: "REVISION_REBASE_EXHAUSTED",
                conflictDetails,
              });
              throw syncError("REVISION_REBASE_EXHAUSTED", { conflicts: conflictDetails });
            }
            try {
              const rebasedEntry = rebaseWorkbookEntry(entry, current);
              if (!rebasedEntry) {
                result = { ok: true, revision: current.revision, replayed: true };
                break;
              }
              entry = rebasedEntry;
              confirmedRebases += 1;
            } catch (rebaseError) {
              outbox.markConflict(entry.opId, {
                conflictCode: rebaseError.code,
                conflictDetails: rebaseError.conflicts,
              });
              throw rebaseError;
            }
          } else if (attempt >= 2) {
            const conflictDetails = [{
              reason: "revision-rebase-exhausted",
              currentRevision: current.revision,
              confirmedRebases: attempt,
            }];
            outbox.markConflict(entry.opId, {
              conflictCode: "REVISION_REBASE_EXHAUSTED",
              conflictDetails,
            });
            throw syncError("REVISION_REBASE_EXHAUSTED", { conflicts: conflictDetails });
          }
          continue;
        }
        if (["ITEM_NOT_FOUND", "ITEM_ALREADY_EXISTS", "IDEMPOTENCY_CONFLICT",
          "CONCURRENT_MODIFICATION"].includes(error.code)) {
          outbox.markConflict(entry.opId, {
            conflictCode: error.code,
            conflictDetails: error.conflicts,
          });
        }
        throw error;
      }
    }
    outbox.acknowledge(entry.opId, { commitRevision: result.revision });
    return { current: await readLiveSnapshot(), entry, result };
  }

  async function runFlush() {
    if (readOnly && outbox.retryable().length) throw syncError("READ_ONLY_CLIENT");
    let current = await readLiveSnapshot();
    const retryable = outbox.retryable();
    const ordered = [
      ...retryable.filter((entry) => entry.explicitResolution === true),
      ...retryable.filter((entry) => entry.explicitResolution !== true),
    ];
    for (const queuedEntry of ordered) {
      const stillQueued = outbox.retryable().find((entry) => entry.opId === queuedEntry.opId);
      if (!stillQueued) continue;
      const completed = await flushRetryableEntry(stillQueued, current);
      current = completed.current;
      if (completed.entry.type === "workbook" && completed.entry.explicitResolution === true) {
        outbox.supersedeEarlierWorkbookTransactions(completed.entry.opId, {
          reason: "explicit-conflict-resolution",
          commitRevision: completed.result.revision,
        });
      }
    }
    outbox.pruneAcknowledged();
    return current;
  }

  async function runTargetedFlush(opId, options = {}) {
    if (readOnly) throw syncError("READ_ONLY_CLIENT");
    let current = await readLiveSnapshot();
    const selected = outbox.retryable().find((entry) => entry.opId === String(opId || ""));
    if (!selected) {
      const existing = (outbox.snapshot().entries || []).find((entry) => entry.opId === String(opId || ""));
      if (existing?.state === "conflict") throw syncError("CONCURRENT_MODIFICATION");
      return current;
    }
    const completed = await flushRetryableEntry(selected, current);
    current = completed.current;
    if (options.supersedeEarlierWorkbooks === true && completed.entry.type === "workbook") {
      outbox.supersedeEarlierWorkbookTransactions(completed.entry.opId, {
        reason: options.supersessionReason || "explicit-conflict-resolution",
        commitRevision: completed.result.revision,
      });
    }
    outbox.pruneAcknowledged();
    return current;
  }

  let flushTail = Promise.resolve();
  function queueFlush(task) {
    const result = flushTail.catch(() => undefined).then(task);
    flushTail = result.catch(() => undefined);
    return result;
  }

  function flush() {
    return queueFlush(runFlush);
  }

  function flushOperation(opId, options = {}) {
    return queueFlush(() => runTargetedFlush(opId, options));
  }

  async function enqueuePhotoMutation(itemId, dataUrl, context = {}) {
    const parsed = parseDataUrl(dataUrl);
    const digest = sha256(parsed.buffer);
    const contentMd5 = crypto.createHash("md5").update(parsed.buffer).digest("base64");
    const file = photoPath(itemId, digest, parsed.mimeType);
    fsApi.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!fsApi.existsSync(file)) {
      const temporary = `${file}.${process.pid}.part`;
      fsApi.writeFileSync(temporary, parsed.buffer, { mode: 0o600 });
      if (sha256(fsApi.readFileSync(temporary)) !== digest) {
        fsApi.rmSync(temporary, { force: true });
        throw syncError("PHOTO_HASH_MISMATCH");
      }
      fsApi.renameSync(temporary, file);
    }
    verifiedPhotoFiles.add(file);
    const signed = await request("/v1/photos/presign", {
      method: "POST", write: true, safePresign: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId, sha256: digest, contentMd5,
        mimeType: parsed.mimeType, bytes: parsed.buffer.length }),
    });
    if (!signed.headers || typeof signed.headers !== "object" || Array.isArray(signed.headers)) {
      throw syncError("PHOTO_PRESIGN_INVALID");
    }
    const uploaded = await fetchImpl(signed.uploadUrl, {
      method: "PUT", headers: signed.headers, body: parsed.buffer,
    });
    // OSS returns 409 when the immutable object already exists. The following
    // commit performs an authenticated HEAD check of its size, hashes, type,
    // and product binding, so reuse is both safe and idempotent.
    if (!uploaded.ok && uploaded.status !== 409) {
      throw syncError(`PHOTO_UPLOAD_HTTP_${uploaded.status}`);
    }
    const entry = outbox.enqueue({
      type: "image", itemId,
      image: {
        objectKey: signed.objectKey, sha256: digest, contentMd5, mimeType: parsed.mimeType,
        bytes: parsed.buffer.length, etag: String(uploaded.headers?.get?.("etag") || ""),
        imageVersion: `sha256-${digest.slice(0, 24)}`,
      },
      baseItem: context.baseItem && cleanItem(context.baseItem),
      baseRevision: context.baseRevision,
      workbookSha256: context.workbookSha256,
    });
    return { entry, file, digest };
  }

  async function replacePhoto(itemId, dataUrl, expectedPhoto = {}) {
    if (readOnly) throw syncError("READ_ONLY_CLIENT");
    const safeItemId = String(itemId || "").trim();
    const expected = expectedPhoto && typeof expectedPhoto === "object" && !Array.isArray(expectedPhoto)
      ? expectedPhoto
      : {};
    const unexpectedKeys = Object.keys(expected)
      .filter((key) => !["imageSha256", "imageVersion"].includes(key));
    const expectedHash = String(expected.imageSha256 || "").trim().toLowerCase();
    const expectedVersion = String(expected.imageVersion || "").trim();
    if (!safeItemId || unexpectedKeys.length
        || (expectedHash && !/^[a-f0-9]{64}$/.test(expectedHash))
        || expectedVersion.length > 128 || /[\\/:]/.test(expectedVersion)) {
      throw syncError("PHOTO_BASE_INVALID");
    }
    const baseSnapshot = await readLiveSnapshot();
    const existing = baseSnapshot.items.find((item) => String(item.id) === safeItemId);
    if (!existing) throw syncError("ITEM_NOT_FOUND");
    const expectedSupplied = Object.hasOwn(expected, "imageSha256")
      || Object.hasOwn(expected, "imageVersion");
    const suppliedIdentity = { imageSha256: expectedHash, imageVersion: expectedVersion };
    const baseItem = !expectedSupplied || samePhotoIdentity(existing, suppliedIdentity)
      ? existing
      : {
        ...existing,
        image: "",
        imageSha256: expectedHash,
        imageVersion: expectedVersion,
      };
    const { entry, file, digest } = await enqueuePhotoMutation(safeItemId, dataUrl, {
      baseItem,
      baseRevision: baseSnapshot.revision,
    });
    const result = await flush();
    return { ok: true, opId: entry.opId, revision: result.revision, image: pathToFileURL(file).href,
      imageSha256: digest, imageVersion: `sha256-${digest.slice(0, 24)}` };
  }

  async function syncWorkbookAttempt(callbacks) {
    const assertNotCancelled = typeof callbacks.assertNotCancelled === "function"
      ? callbacks.assertNotCancelled
      : () => {};
    assertNotCancelled();
    if (readOnly) throw syncError("READ_ONLY_CLIENT");
    let workbook = await callbacks.readWorkbook();
    assertNotCancelled();
    if (!workbook?.ok) throw syncError("WORKBOOK_READ_FAILED");
    const identityRows = Array.isArray(workbook.rawItems) ? workbook.rawItems : (workbook.items || []);
    const visibleIds = identityRows.map((item) => String(item?.id || "").trim()).filter(Boolean);
    if (workbook.integrity?.itemIdsDuplicateFree === false
        && new Set(visibleIds).size === visibleIds.length) {
      throw syncError("WORKBOOK_ID_CONFLICT", {
        conflicts: [{ reason: "duplicate-id-unreadable" }],
      });
    }
    const initialConfirmed = await readLiveSnapshot();
    assertNotCancelled();
    const reviewedReconciliation = planReviewedLegacyReconciliation({
      workbook,
      cloud: initialConfirmed,
    });
    if (reviewedReconciliation.matched) {
      if (typeof callbacks.replaceWorkbook !== "function") {
        throw syncError("WORKBOOK_REPLACEMENT_REQUIRED");
      }
      const workbookSnapshot = decorateWorkbookSnapshot(initialConfirmed);
      const replacement = await callbacks.replaceWorkbook({
        items: workbookSnapshot.items,
        sync: { revision: initialConfirmed.revision, updatedAt: initialConfirmed.updatedAt,
          imageSetVersion: initialConfirmed.imageSetVersion || "" },
        ackPlan: { expectedSha256: workbook.sha256, rows: [] },
      });
      const workbookReplaced = replacement?.ok === true;
      if (!workbookReplaced) throw syncError("WORKBOOK_REPLACEMENT_FAILED");
      const verifiedWorkbook = await callbacks.readWorkbook();
      if (!verifiedWorkbook?.ok) throw syncError("WORKBOOK_READ_FAILED");
      const verifiedCloud = await readLiveSnapshot();
      verifyReviewedLegacyReconciliationResult({ workbook: verifiedWorkbook, cloud: verifiedCloud });
      return {
        ok: true,
        revision: initialConfirmed.revision,
        cloudRevision: initialConfirmed.revision,
        conflict: false,
        retryRequired: false,
        errorCode: "",
        operations: 0,
        photos: 0,
        assignments: 0,
        workbookAcknowledged: true,
        workbookReplaced: true,
        droppedLegacyRows: 0,
      };
    }
    const initialItemsById = new Map(initialConfirmed.items.map((item) => [String(item.id || ""), item]));
    const allowedLegacyIds = initialConfirmed.items
      .map((item) => String(item?.id || "").trim())
      .filter((id) => LEGACY_RECORD_ID.test(id));
    const allowedLegacyIdSet = new Set(allowedLegacyIds);
    const legacyPhotoRepairs = workbook.items.filter((item) => {
      const id = String(item?.id || "").trim();
      if (!allowedLegacyIdSet.has(id)) return false;
      const liveItem = initialItemsById.get(id);
      const cloudPhotoMissing = !String(liveItem?.image || "").trim()
        && !String(liveItem?.imageSha256 || "").trim();
      const hasLocalPhotoMutation = /^data:image\//i.test(String(item?.embeddedImageDataUrl || ""))
        || ((item?.imageChanged || item?.imageUntracked)
          && /^data:image\//i.test(String(item?.image || "")));
      return cloudPhotoMissing && hasLocalPhotoMutation;
    });
    if (legacyPhotoRepairs.length) {
      throw syncError("WORKBOOK_IDENTITY_MIGRATION_REQUIRED", {
        conflicts: legacyPhotoRepairs.map((item) => ({
          id: String(item?.id || "").trim(), reason: "legacy-id-read-only",
        })),
      });
    }
    const baselineRecords = workbook.baseline?.records || [];
    const baselineCorrupt = workbook.baseline?.corrupt === true;
    const hasCompleteBaseline = !baselineCorrupt
      && workbook.baseline?.revision != null
      && workbook.baseline?.itemCount != null
      && workbook.sync?.revision != null
      && workbook.sync?.itemCount != null
      && baselineRecords.length === Number(workbook.baseline?.itemCount)
      && Number(workbook.baseline?.revision) === Number(workbook.sync?.revision)
      && Number(workbook.baseline?.itemCount) === Number(workbook.sync?.itemCount);
    const acknowledgedItemCount = workbook.sync?.itemCount ?? workbook.baseline?.itemCount;
    const planned = planBlankIdRows(identityRows, initialConfirmed.items, {
      dataStartRow: 5,
      acknowledgedItemCount,
      baselineComplete: hasCompleteBaseline,
      baselineItems: baselineRecords,
      workbookWrittenAt: workbook.sync?.writtenAt,
      workbookMtimeMs: workbook.mtimeMs,
      randomUUID: crypto.randomUUID,
      allowedLegacyIds,
    });
    if (!planned.ok) {
      throw syncError("WORKBOOK_IDENTITY_MIGRATION_REQUIRED", { conflicts: planned.conflicts });
    }
    if (planned.assignments.length) {
      assertNotCancelled();
      await callbacks.assignIds(planned.assignments, workbook.sha256);
      workbook = await callbacks.readWorkbook();
      assertNotCancelled();
      if (!workbook?.ok) throw syncError("WORKBOOK_READ_FAILED");
      const idsByRow = new Map();
      for (const row of workbook.items) {
        const sourceRow = Math.trunc(Number(row?.sourceRow) || 0);
        const id = String(row?.id || "").trim();
        if (!idsByRow.has(sourceRow)) idsByRow.set(sourceRow, []);
        if (id) idsByRow.get(sourceRow).push(id);
      }
      const acknowledgedExactly = planned.assignments.every(({ sourceRow, id }) => {
        const persisted = idsByRow.get(Math.trunc(Number(sourceRow) || 0)) || [];
        return persisted.length === 1 && persisted[0] === String(id || "").trim();
      });
      const plannedIds = planned.assignments.map(({ id }) => String(id || "").trim());
      if (!acknowledgedExactly || new Set(plannedIds).size !== plannedIds.length) {
        throw syncError("WORKBOOK_ID_ASSIGNMENT_NOT_ACKNOWLEDGED");
      }
    }
    const droppedSourceRows = new Set();
    const workingItems = workbook.items;
    const unresolvedIds = workingItems.filter((item) => !String(item?.id || "").trim());
    if (unresolvedIds.length) {
      throw syncError("WORKBOOK_IDENTITY_MIGRATION_REQUIRED", {
        conflicts: unresolvedIds.map((item) => ({
          sourceRow: Math.trunc(Number(item?.sourceRow) || 0), reason: "missing-id",
        })),
      });
    }
    const normalizedRows = typeof callbacks.normalizeRows === "function"
      ? callbacks.normalizeRows(workingItems)
      : workingItems;
    const baselineById = new Map(baselineRecords.map((item) => [String(item.id || ""), item]));
    const newlyAssignedIds = new Set(planned.assignments.map((entry) => String(entry.id || "")));
    const currentRows = normalizedRows.map((item) => {
      const baseline = baselineById.get(String(item.id || ""));
      const photoChanged = item.imageChanged || item.imageUntracked;
      const localImageHash = String(item.embeddedImageHash || "").trim().toLowerCase();
      return {
        ...item,
        _excelGeneratedId: item._excelGeneratedId === true
          || (!baseline && newlyAssignedIds.has(String(item.id || ""))),
        stockText: Object.prototype.hasOwnProperty.call(item, "stockText")
          ? item.stockText
          : baseline?.stockText,
        sellingPriceText: Object.prototype.hasOwnProperty.call(item, "sellingPriceText")
          ? item.sellingPriceText
          : baseline?.sellingPriceText,
        image: photoChanged
          ? item.image
          : (baseline ? baseline.image : item.image),
        imageSha256: photoChanged && /^[a-f0-9]{64}$/.test(localImageHash)
          ? localImageHash
          : String(baseline?.imageSha256 || item.imageSha256 || "").toLowerCase(),
        imageVersion: photoChanged && /^[a-f0-9]{64}$/.test(localImageHash)
          ? `sha256-${localImageHash.slice(0, 24)}`
          : String(baseline?.imageVersion || item.imageVersion || ""),
        sourceFile: baseline ? baseline.sourceFile : item.sourceFile,
        sourceSheet: baseline ? baseline.sourceSheet : item.sourceSheet,
      };
    });
    const liveIds = new Set(initialConfirmed.items.map((item) => String(item?.id || "")));
    const baselineByPermanentId = new Map(baselineRecords.map((item) => [String(item?.id || ""), item]));
    const mergeRows = currentRows.filter((item) => {
      const id = String(item?.id || "");
      const baseline = baselineByPermanentId.get(id);
      return liveIds.has(id) || !baseline
        || JSON.stringify(workbookComparableItem(item)) !== JSON.stringify(workbookComparableItem(baseline));
    });
    let desiredRows = mergeRows;
    let allowedLegacyDeleteIds = [];
    if (baselineCorrupt) {
      const liveIdsForRepair = new Set(initialConfirmed.items.map((item) => String(item?.id || "")));
      // A corrupt baseline cannot prove that a visible value for an existing ID
      // is newer than the cloud value. Rebuild existing records from cloud and
      // accept only rows whose permanent IDs exist in neither cloud nor baseline.
      const safeNewRows = currentRows.filter((item) => {
        const id = String(item?.id || "");
        return id
          && item._excelGeneratedId === true
          && newlyAssignedIds.has(id)
          && !liveIdsForRepair.has(id)
          && !baselineByPermanentId.has(id);
      });
      desiredRows = [...initialConfirmed.items, ...safeNewRows];
    } else if (hasCompleteBaseline) {
      const merged = threeWayWorkbookMerge({
        baselineItems: baselineRecords,
        excelRows: mergeRows,
        liveItems: initialConfirmed.items,
      });
      if (!merged.ok) {
        for (const conflict of merged.conflicts.filter((detail) => detail.field === "image")) {
          const itemId = String(conflict.id || "");
          const row = currentRows.find((item) => String(item.id || "") === itemId);
          const baseItem = baselineByPermanentId.get(itemId);
          const digest = String(row?.imageSha256 || "").toLowerCase();
          const existingConflict = outbox.snapshot().entries.find((entry) =>
            entry.type === "image" && entry.state === "conflict"
            && entry.itemId === itemId && entry.workbookSha256 === String(workbook.sha256 || "").toLowerCase()
            && String(entry.image?.sha256 || "").toLowerCase() === digest);
          if (!existingConflict && baseItem && /^[a-f0-9]{64}$/.test(digest)
              && /^data:image\//i.test(String(row?.image || ""))) {
            const prepared = await enqueuePhotoMutation(itemId, row.image, {
              baseItem,
              baseRevision: Number(workbook.baseline.revision) || 0,
              workbookSha256: workbook.sha256,
            });
            outbox.markConflict(prepared.entry.opId, {
              conflictCode: "CONCURRENT_MODIFICATION",
              conflictDetails: [{
                itemId,
                field: "image",
                reason: "field-modified-both",
              }],
            });
          }
        }
        const intendedDelta = buildWorkbookDelta({
          baselineRecords,
          currentRows,
        });
        if (intendedDelta.ok && intendedDelta.operations.length) {
          const desiredById = new Map(currentRows.map((item) => [String(item?.id || ""), item]));
          const durableOperations = intendedDelta.operations.map((operation) => {
            if (operation.item) {
              const desired = desiredById.get(String(operation.item.id || ""));
              return { ...operation, item: { ...operation.item, image: "" } };
            }
            if (operation.patch && /^data:image\//i.test(operation.patch.image || "")) {
              const { image, ...patch } = operation.patch;
              return { ...operation, patch };
            }
            return operation;
          }).filter((operation) => operation.type !== "update"
            || Object.keys(operation.patch || {}).length);
          const conflictDetails = merged.conflicts.map(({ id, ...conflict }) => ({
            itemId: id,
            ...conflict,
          }));
          const identity = conflictIdentity(conflictDetails);
          const existingConflict = outbox.snapshot().entries.find((entry) =>
            entry.type === "workbook" && entry.state === "conflict"
            && conflictIdentity(entry.conflictDetails) === identity);
          if (existingConflict && durableOperations.length
              && typeof outbox.replaceWorkbookConflict === "function") {
            outbox.replaceWorkbookConflict(existingConflict.opId, {
              operations: durableOperations,
              baseRevision: Number(workbook.baseline.revision) || 0,
              baseItems: baselineRecords,
              workbookSha256: workbook.sha256,
            }, {
              conflictCode: "WORKBOOK_MERGE_CONFLICT",
              conflictDetails,
            });
          } else if (!existingConflict && durableOperations.length) {
            const durable = enqueueWorkbook(durableOperations, workbook.sha256, {
              baseSnapshot: {
                revision: Number(workbook.baseline.revision) || 0,
                items: baselineRecords,
              },
            });
            outbox.markConflict(durable.opId, {
              conflictCode: "WORKBOOK_MERGE_CONFLICT",
              conflictDetails,
            });
          }
        }
        throw syncError("WORKBOOK_MERGE_CONFLICT", { conflicts: merged.conflicts });
      }
      desiredRows = merged.items;
      allowedLegacyDeleteIds = merged.deleted;
    }
    const delta = buildWorkbookDelta({
      baselineRecords: hasCompleteBaseline || baselineCorrupt
        ? initialConfirmed.items
        : baselineRecords,
      currentRows: desiredRows,
      allowedLegacyDeleteIds,
      allowedExistingIds: [
        ...initialConfirmed.items.map((item) => String(item?.id || "")),
        ...newlyAssignedIds,
      ],
      allowedLegacyIds,
    });
    if (!delta.ok) {
      const requiresIdentityMigration = delta.conflicts.some((conflict) =>
        String(conflict?.reason || "") === "legacy-id-read-only");
      throw syncError(requiresIdentityMigration
        ? "WORKBOOK_IDENTITY_MIGRATION_REQUIRED" : "WORKBOOK_ID_CONFLICT",
      { conflicts: delta.conflicts });
    }
    const desiredIds = new Set(desiredRows.map((item) => String(item?.id || "")));
    const photoChanges = mergeRows.filter((item) => {
      const id = String(item?.id || "");
      return desiredIds.has(id) && !(baselineCorrupt && liveIds.has(id));
    }).map((item) => {
      const explicitPhoto = (item.imageChanged || item.imageUntracked)
        && /^data:image\//i.test(item.image || "") ? item.image : "";
      const liveItem = initialItemsById.get(String(item.id || ""));
      const cloudPhotoMissing = !liveItem
        || (!String(liveItem.image || "").trim() && !String(liveItem.imageSha256 || "").trim());
      const repairPhoto = cloudPhotoMissing
        && /^data:image\//i.test(item.embeddedImageDataUrl || "")
        ? item.embeddedImageDataUrl : "";
      const photoDataUrl = explicitPhoto || repairPhoto;
      const baseline = baselineByPermanentId.get(String(item.id || ""));
      return photoDataUrl ? {
        ...item,
        photoDataUrl,
        baseImageSha256: String(baseline?.imageSha256 || "").toLowerCase(),
        baseImageVersion: String(baseline?.imageVersion || ""),
      } : null;
    }).filter(Boolean);
    const desiredById = new Map(desiredRows.map((item) => [String(item?.id || ""), item]));
    const operations = delta.operations
      .filter((operation) => operation.type !== "delete"
        || initialItemsById.has(String(operation.itemId || "")))
      .map((operation) => {
      if (operation.item) {
        const desired = desiredById.get(String(operation.item.id || ""));
        return { ...operation, item: { ...operation.item, image: "" } };
      }
      if (operation.patch && /^data:image\//i.test(operation.patch.image || "")) {
        const { image, ...patch } = operation.patch;
        return { ...operation, patch };
      }
      return operation;
      }).filter((operation) => operation.type !== "update" || Object.keys(operation.patch || {}).length);
    if (operations.length) {
      assertNotCancelled();
      enqueueWorkbook(operations, workbook.sha256, { baseSnapshot: initialConfirmed });
    }
    assertNotCancelled();
    if (operations.length) callbacks.onCloudWriteStart?.();
    let confirmed = operations.length ? await flush() : await readLiveSnapshot();
    assertNotCancelled();
    for (const item of photoChanges) {
      assertNotCancelled();
      callbacks.onCloudWriteStart?.();
      await replacePhoto(item.id, item.photoDataUrl, {
        imageSha256: item.baseImageSha256,
        imageVersion: item.baseImageVersion,
      });
      confirmed = await readLiveSnapshot();
      assertNotCancelled();
    }
    const currentRowsById = new Map(currentRows.map((item) => [String(item?.id || ""), item]));
    const cachedPhotoRefreshNeeded = confirmed.items.some((item) => {
      if (!cachedPhotoUrl(item)) return false;
      const row = currentRowsById.get(String(item?.id || ""));
      return !!row && !String(row.embeddedImageDataUrl || row.embeddedImageHash || "").trim()
        && !/^data:image\//i.test(String(row.image || ""));
    });
    const workbookMatches = droppedSourceRows.size === 0
      && !cachedPhotoRefreshNeeded
      && workbookMatchesSnapshot(currentRows, confirmed.items);
    let workbookAcknowledged = false;
    let workbookReplaced = false;
    let retryRequired = false;
    let errorCode = "";
    const baselineAlreadyAcknowledged = hasCompleteBaseline
      && Number(workbook.sync?.revision) === Number(confirmed.revision)
      && Number(workbook.sync?.itemCount) === confirmed.items.length
      && workbookMatchesSnapshot(baselineRecords, confirmed.items);
    if (workbookMatches && baselineAlreadyAcknowledged) {
      workbookAcknowledged = true;
    } else if (workbookMatches) {
      try {
        const acknowledgement = await callbacks.acknowledge({
          items: confirmed.items,
          sync: { revision: confirmed.revision, updatedAt: confirmed.updatedAt,
            imageSetVersion: confirmed.imageSetVersion || "" },
          ackPlan: { expectedSha256: workbook.sha256, rows: [] },
        });
        if (acknowledgement?.conflict
            && acknowledgement.conflicts?.some((entry) => entry?.reason === "workbook-content-changed")) {
          throw syncError("WORKBOOK_CONTENT_CHANGED");
        }
        workbookAcknowledged = acknowledgement?.ok === true;
        retryRequired = !workbookAcknowledged;
      } catch (error) {
        if (/WORKBOOK_CONTENT_CHANGED/i.test(String(error?.code || error?.message || ""))) throw error;
        errorCode = String(error?.code || error?.message || "WORKBOOK_ACKNOWLEDGEMENT_FAILED").slice(0, 80);
        workbookAcknowledged = false;
        retryRequired = true;
      }
    } else if (typeof callbacks.replaceWorkbook === "function") {
      try {
        assertNotCancelled();
        const workbookSnapshot = decorateWorkbookSnapshot(confirmed);
        const replacement = await callbacks.replaceWorkbook({
          items: workbookSnapshot.items,
          sync: { revision: confirmed.revision, updatedAt: confirmed.updatedAt,
            imageSetVersion: confirmed.imageSetVersion || "" },
          ackPlan: { expectedSha256: workbook.sha256, rows: [] },
        });
        workbookReplaced = replacement?.ok === true;
        workbookAcknowledged = workbookReplaced;
        retryRequired = !workbookReplaced;
      } catch (error) {
        if (/WORKBOOK_CONTENT_CHANGED/i.test(String(error?.code || error?.message || ""))) throw error;
        errorCode = String(error?.code || error?.message || "WORKBOOK_REPLACEMENT_FAILED").slice(0, 80);
        workbookReplaced = false;
        workbookAcknowledged = false;
        retryRequired = true;
      }
    }
    retryRequired ||= !workbookAcknowledged;
    return { ok: workbookAcknowledged, revision: confirmed.revision, cloudRevision: confirmed.revision,
      conflict: false, retryRequired, errorCode,
      operations: operations.length,
      photos: photoChanges.length, assignments: planned.assignments.length,
      workbookAcknowledged, workbookReplaced, droppedLegacyRows: droppedSourceRows.size };
  }

  async function syncWorkbook(callbacks) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await syncWorkbookAttempt(callbacks);
      } catch (error) {
        lastError = error;
        if (!/WORKBOOK_(?:CONTENT_CHANGED|ID_ASSIGNMENT_CONFLICT)/i
          .test(String(error?.code || error?.message || ""))) throw error;
      }
    }
    throw lastError;
  }

  return {
    cachePhoto,
    canonicalSnapshot: readLiveSnapshot,
    enqueue,
    enqueueWorkbook,
    flush,
    flushOperation,
    history: () => outbox.history(),
    outbox,
    readChanges,
    replacePhoto,
    snapshot,
    syncWorkbook,
  };
}

module.exports = { atomicJson, cleanItem, createCentralSync, parseDataUrl, safeSnapshot, sha256,
  sortItemsDeterministically, stableValue, workbookComparableItem, workbookMatchesSnapshot };
