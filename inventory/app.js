(() => {
  "use strict";

  const payload = window.INVENTORY_PAYLOAD || { items: [] };
  const remoteConfig = window.INVENTORY_REMOTE_CONFIG || {};
  let rejectedUploadToken = "";
  const excelSyncCore = window.TekStockExcelSync;
  const imageDisplayCore = window.TekStockImageDisplay;
  const excelOpenCore = window.TekStockExcelOpen;
  const excelBootstrapCore = window.TekStockExcelBootstrap;
  const remoteReadCore = window.TekStockRemoteRead;
  const conflictResolutionCore = window.TekStockConflictResolution;
  const filterSortCore = window.TekStockFilterSort;
  let baseItems = payload.items || [];
  const originalItems = JSON.parse(JSON.stringify(baseItems));
  const packagedImages = new Map(baseItems.map((item) => [item.id, item.image || ""]));
  const editStorageKey = "tek-stock-local-edits-v1";
  const syncStorageKey = "tek-stock-sync-state-v2";
  const cloudImageStorageKey = "tek-stock-cloud-image-map-v1";
  const cloudSnapshotStorageKey = "tek-stock-cloud-snapshot-v1";
  const deletionSafetyMigrationStorageKey = "tek-stock-deletion-safety-v1";
  const centralAuthorityMigrationStorageKey = "tek-stock-central-authority-migration-v1";
  const diagnosticDailyStorageKey = "tek-stock-diagnostic-daily-v1";
  const imageVersion = "20260726-exact-photo-sync-v3";
  const allCategory = "__ALL__";
  const defaultChairCategory = String.fromCharCode(0x9910, 0x6905);
  const state = {
    query: "",
    stockFilter: "all",
    selectedCategories: new Set([defaultChairCategory]),
    sortDirection: "desc",
    activeId: "",
  };
  const money = new Intl.NumberFormat("en-SG", { maximumFractionDigits: 0 });
  const el = Object.fromEntries([
    "totalStock", "totalModels", "totalSold", "lowModels", "outModels", "searchInput", "clearSearch",
    "stockFilters", "sortControls", "categoryFilters", "resultCount", "inventoryGrid", "loadMoreButton",
    "emptyState", "detailDialog", "dialogClose", "detailImage", "detailCategory", "detailModel",
    "detailStock", "detailSoldNow", "detailTotalSold", "detailCost", "detailPrice", "detailSpec", "cloudVersion", "updateReceipt",
    "detailArrival", "detailShowroom", "detailOutbound", "detailSource", "toast", "exportButton",
    "printButton", "uploadButton", "reinstallButton", "resetLocalButton", "uploadInput", "helpButton", "helpDialog", "helpClose", "helpDataLocation",
    "imagePreviewDialog", "imagePreview", "imagePreviewClose",
    "saveDetailButton", "resetDetailButton", "changePhotoButton", "detailPhotoInput",
    "feedbackButton", "feedbackDialog", "feedbackClose",
    "feedbackModel", "feedbackMessage", "feedbackScreenshot", "feedbackPreview", "feedbackSubmit",
    "syncConflictDialog", "syncConflictProgress", "syncConflictTitle", "syncConflictModel",
    "syncConflictField", "syncConflictExcel", "syncConflictCloud",
    "identityMigrationDialog", "identityMigrationRows", "identityMigrationWarning",
    "identityMigrationApply",
    "resetLocalDialog", "resetLocalLiveState", "resetLocalConfirm",
  ].map((id) => [id, document.getElementById(id)]));

  let localEdits = remoteConfig.readOnly ? {} : loadLocalEdits();
  let syncState = loadSyncState();
  if (window.TekStockCloud && localStorage.getItem(centralAuthorityMigrationStorageKey) !== "1") {
    localEdits = {};
    syncState = { revision: 0, updatedAt: "", dirty: false };
    localStorage.removeItem(editStorageKey);
    localStorage.removeItem(cloudSnapshotStorageKey);
    localStorage.removeItem(cloudImageStorageKey);
    localStorage.setItem(syncStorageKey, JSON.stringify(syncState));
    localStorage.setItem(centralAuthorityMigrationStorageKey, "1");
  }
  if (!remoteConfig.readOnly
      && excelSyncCore?.discardLegacyDeletionTombstones
      && localStorage.getItem(deletionSafetyMigrationStorageKey) !== "1") {
    const migration = excelSyncCore.discardLegacyDeletionTombstones(localEdits);
    localEdits = migration.edits;
    localStorage.setItem(editStorageKey, JSON.stringify(localEdits));
    if (migration.removed && Object.keys(localEdits).length === 0) {
      syncState.dirty = false;
      saveSyncState();
    }
    localStorage.setItem(deletionSafetyMigrationStorageKey, "1");
  }
  let cloudImageMap = loadCloudImageMap();
  let feedbackScreenshotData = "";
  let excelInitialized = false;
  let lastRemoteUpdatedAt = 0;
  let lastRemoteRevision = Number(syncState.revision) || 0;
  let lastRemoteItemCount = 0;
  let lastRemoteItems = [];
  let lastRemoteImageSetVersion = "";
  let lastRemoteFingerprint = "";
  let cloudDataState = "loading";
  let cloudRetryTimer;
  let cloudLastErrorCode = "";
  let excelUploadPending = false;
  let diagnosticsUploadActive = false;
  let sessionPendingEdits = false;
  const cachedCloudPayload = loadCachedCloudPayload();
  let hasCachedCloudPayload = !!cachedCloudPayload;
  if (cachedCloudPayload) {
    lastRemoteUpdatedAt = Date.parse(cachedCloudPayload.updatedAt || "") || 0;
    lastRemoteRevision = Number(cachedCloudPayload.revision) || lastRemoteRevision;
    lastRemoteItemCount = Array.isArray(cachedCloudPayload.items)
      ? cachedCloudPayload.items.length
      : 0;
    lastRemoteItems = Array.isArray(cachedCloudPayload.items)
      ? cachedCloudPayload.items.map((item) => ({ ...item }))
      : [];
    lastRemoteImageSetVersion = String(cachedCloudPayload.imageSetVersion || "");
    baseItems = cachedCloudPayload.items.map((item) => ({
      ...item,
      image: approvedImage(item.id, item.image),
    }));
    cloudDataState = "cached";
  }
  baseItems.forEach((item) => {
    item.image = approvedImage(item.id, item.image);
  });
  document.body.classList.toggle("read-only-mode", !!remoteConfig.readOnly);

  function updateCloudVersionBadge() {
    if (!el.cloudVersion) return;
    const cloudLabel =
      cloudDataState === "live" ? `Cloud v${lastRemoteRevision || 0}` :
      cloudDataState === "cached" ? `Cloud v${lastRemoteRevision || 0} cache` :
      cloudDataState === "offline" ? "Cloud offline" :
      "Cloud loading";
    el.cloudVersion.textContent = excelUploadPending && cloudDataState === "live"
      ? `${cloudLabel} · Excel pending`
      : cloudLabel;
    el.cloudVersion.title = cloudLastErrorCode
      ? `Cloud connection error: ${cloudLastErrorCode}`
      : "";
  }

  updateCloudVersionBadge();

  function diagnosticSource() {
    return window.InventoryAndroid ? "android" : "desktop";
  }

  function diagnosticErrorCode(error, fallback = "UNKNOWN_ERROR") {
    const explicit = String(error?.code || "").trim();
    if (/^[a-z0-9._:-]{3,64}$/i.test(explicit)) return explicit.toUpperCase();
    const message = String(error?.message || "");
    const http = message.match(/\bHTTP\s+(\d{3})\b/i);
    if (http) return `HTTP_${http[1]}`;
    const token = message.match(/\b([A-Z][A-Z0-9._:-]{2,63})\b/);
    if (token) return token[1].toUpperCase();
    return String(error?.name || fallback)
      .normalize("NFKC")
      .replace(/[^a-z0-9._:-]+/gi, "_")
      .slice(0, 64) || fallback;
  }

  function safeDiagnosticFields(fields = {}) {
    const output = {
      source: diagnosticSource(),
      status: String(fields.status || "").slice(0, 24),
      phase: String(fields.phase || "").slice(0, 40),
      errorCode: String(fields.errorCode || "").replace(/[^a-z0-9._:-]+/gi, "_").slice(0, 64),
      revision: Math.max(0, Math.trunc(Number(fields.revision) || 0)),
      itemCount: Math.max(0, Math.trunc(Number(fields.itemCount) || 0)),
      durationMs: Math.max(0, Math.trunc(Number(fields.durationMs) || 0)),
      httpStatus: Math.max(0, Math.trunc(Number(fields.httpStatus) || 0)),
      attempt: Math.max(0, Math.trunc(Number(fields.attempt) || 0)),
      online: navigator.onLine === true,
      visible: document.visibilityState === "visible",
    };
    return Object.fromEntries(Object.entries(output).filter(([, value]) => value !== "" && value !== 0));
  }

  async function reportDiagnostic(event, fields = {}, upload = false) {
    const safeFields = safeDiagnosticFields(fields);
    try {
      if (window.TekStockDiagnostics?.append) {
        const locallyOk = safeFields.status === "ok" || safeFields.status === "started";
        await window.TekStockDiagnostics.append({
          stage: event,
          ok: locallyOk,
          errorCode: safeFields.errorCode || (locallyOk ? "" : "UNKNOWN_ERROR"),
          revision: safeFields.revision,
          counts: {
            itemCount: safeFields.itemCount,
            durationMs: safeFields.durationMs,
            httpStatus: safeFields.httpStatus,
            attempt: safeFields.attempt,
          },
        });
      } else if (window.InventoryAndroid?.logDiagnosticEvent) {
        window.InventoryAndroid.logDiagnosticEvent(event, JSON.stringify(safeFields));
      }
    } catch {
      // Diagnostics must never interrupt inventory work.
    }
    if (!upload || diagnosticsUploadActive || !remoteConfig.feedbackToken) return false;
    const diagnosticsUrl = String(
      remoteConfig.diagnosticsUrl
      || remoteConfig.feedbackUrl?.replace(/\/feedback(?:\?.*)?$/i, "/diagnostics")
      || "",
    );
    if (!diagnosticsUrl) return false;
    diagnosticsUploadActive = true;
    try {
      const response = await fetch(diagnosticsUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-feedback-token": remoteConfig.feedbackToken,
        },
        body: JSON.stringify({
          event,
          appVersion: String(remoteConfig.appVersion || "unknown").slice(0, 32),
          ...safeFields,
        }),
      });
      return response.ok;
    } catch {
      // Local diagnostics remain available and native clients retry uploads.
      return false;
    } finally {
      diagnosticsUploadActive = false;
    }
  }

  async function uploadDailyDiagnostic() {
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(diagnosticDailyStorageKey) === today) return;
    const uploaded = await reportDiagnostic("daily_health", {
      status: "ok",
      phase: "bootstrap",
      revision: lastRemoteRevision,
      itemCount: baseItems.length,
    }, true);
    if (uploaded) localStorage.setItem(diagnosticDailyStorageKey, today);
  }

  function approvedImage(id, candidate) {
    const image = String(candidate || "").trim();
    const packaged = String(packagedImages.get(id) || "").trim();
    if (!image) return packaged;
    if (window.TekStockCloud && (/^file:\/\//i.test(image) || /^https:\/\//i.test(image))) return image;
    if (/^data:image\//i.test(image)) return image;
    if (/^assets\/images\/edited-[a-z0-9_-]+\.(?:webp|png|jpe?g)$/i.test(image)) return image;
    return packaged;
  }

  function versionedImageSource(source, version = imageVersion) {
    if (imageDisplayCore?.versionedImageSource) {
      return imageDisplayCore.versionedImageSource(source, version);
    }
    const image = String(source || "").trim();
    if (!image || /^data:image\//i.test(image)) return image;
    return `${image}${image.includes("?") ? "&" : "?"}v=${encodeURIComponent(String(version || ""))}`;
  }

  function replaceWithImageFallback(image) {
    if (!image?.parentElement) return;
    const fallback = document.createElement("div");
    fallback.className = "image-fallback";
    fallback.setAttribute("aria-label", "No photo");
    fallback.textContent = "HP";
    image.replaceWith(fallback);
  }

  function handleProductImageError(event) {
    const image = event.currentTarget;
    const fallback = String(image.dataset.fallback || "").trim();
    const fallbackUsed = image.dataset.fallbackUsed === "1";
    const action = imageDisplayCore?.nextImageFailure
      ? imageDisplayCore.nextImageFailure(fallback, fallbackUsed, imageVersion)
      : (fallback && !fallbackUsed
        ? { type: "retry", source: versionedImageSource(fallback) }
        : { type: "placeholder" });
    if (action.type === "retry") {
      image.dataset.fallbackUsed = "1";
      image.src = action.source;
      return;
    }
    replaceWithImageFallback(image);
  }

  function hideBrokenDetailImage() {
    if (!el.detailImage) return;
    el.detailImage.hidden = true;
    el.detailImage.removeAttribute("src");
    el.detailImage.alt = "";
  }

  function loadLocalEdits() {
    try {
      return JSON.parse(localStorage.getItem(editStorageKey) || "{}");
    } catch {
      return {};
    }
  }

  function loadSyncState() {
    try {
      const saved = JSON.parse(localStorage.getItem(syncStorageKey) || "{}");
      return {
        revision: Number(saved.revision) || 0,
        updatedAt: String(saved.updatedAt || ""),
        dirty: !!saved.dirty,
      };
    } catch {
      return { revision: 0, updatedAt: "", dirty: false };
    }
  }

  function saveSyncState() {
    localStorage.setItem(syncStorageKey, JSON.stringify(syncState));
  }

  function loadCloudImageMap() {
    try {
      return JSON.parse(localStorage.getItem(cloudImageStorageKey) || "{}");
    } catch {
      return {};
    }
  }

  function saveCloudImageMap() {
    localStorage.setItem(cloudImageStorageKey, JSON.stringify(cloudImageMap));
  }

  function loadCachedCloudPayload() {
    try {
      const cached = JSON.parse(localStorage.getItem(cloudSnapshotStorageKey) || "null");
      return isSafeRemotePayload(cached) ? cached : null;
    } catch {
      return null;
    }
  }

  function saveCachedCloudPayload(remotePayload) {
    try {
      localStorage.setItem(cloudSnapshotStorageKey, JSON.stringify(remotePayload));
      return true;
    } catch (error) {
      console.error(error);
      return false;
    }
  }

  function sanitizePendingDeletions(remoteRevision, remoteItemCount) {
    if (!excelSyncCore?.sanitizeDeletionTombstones) return 0;
    const result = excelSyncCore.sanitizeDeletionTombstones(localEdits, {
      remoteRevision,
      remoteItemCount,
    });
    if (!result.removed) return 0;
    localEdits = result.edits;
    if (Object.keys(localEdits).length) {
      localStorage.setItem(editStorageKey, JSON.stringify(localEdits));
    } else {
      localStorage.removeItem(editStorageKey);
      syncState.dirty = false;
    }
    saveSyncState();
    return result.removed;
  }

  function hasPendingEdits() {
    return !!syncState.dirty
      && Object.keys(localEdits).length > 0;
  }

  function saveLocalEdits(markDirty = true) {
    localStorage.setItem(editStorageKey, JSON.stringify(localEdits));
    if (markDirty) {
      sessionPendingEdits = true;
      syncState.dirty = true;
      saveSyncState();
    }
  }

  function clearSyncedLocalEdits(revision, updatedAt) {
    localEdits = {};
    sessionPendingEdits = false;
    localStorage.removeItem(editStorageKey);
    syncState = {
      revision: Number(revision) || lastRemoteRevision || 0,
      updatedAt: String(updatedAt || ""),
      dirty: false,
    };
    saveSyncState();
  }

  function restoreConfirmedCloudViewAfterExcelFailure() {
    excelUploadPending = true;
    updateCloudVersionBadge();
    if (cloudDataState !== "live" || !Array.isArray(lastRemoteItems) || !lastRemoteItems.length) return;
    localEdits = {};
    sessionPendingEdits = false;
    localStorage.removeItem(editStorageKey);
    syncState = {
      revision: lastRemoteRevision,
      updatedAt: lastRemoteUpdatedAt ? new Date(lastRemoteUpdatedAt).toISOString() : "",
      dirty: false,
    };
    saveSyncState();
    baseItems = lastRemoteItems.map((item) => ({
      ...item,
      image: approvedImage(item.id, item.image),
    }));
    buildCategories();
    render();
  }

  function handleUnconfirmedExcelUpload() {
    restoreConfirmedCloudViewAfterExcelFailure();
  }

  function applyLocalEdits() {
    const deletedIds = new Set(
      Object.entries(localEdits)
        .filter(([, patch]) => patch?._deleteProduct)
        .map(([id]) => id),
    );
    baseItems = baseItems.filter((item) => !deletedIds.has(item.id));
    const knownIds = new Set(baseItems.map((item) => item.id));
    baseItems = baseItems.map((item) => ({ ...item, ...(localEdits[item.id] || {}) }));
    for (const [id, patch] of Object.entries(localEdits)) {
      if (knownIds.has(id) || !patch?._newProduct || !patch.model) continue;
      const { _newProduct, ...created } = patch;
      baseItems.push({ ...created, id });
      knownIds.add(id);
    }
  }

  function itemStock(item) {
    return Number(item.stock) || 0;
  }

  function safeWorkbookText(value, fallback = "") {
    const text = String(value ?? "").trim();
    return text && !text.includes("?") ? text : fallback;
  }

  function manualSold(item) {
    return Math.max(0, Number(item.totalSold) || 0);
  }

  function recordQuantity(text) {
    return [...String(text || "").matchAll(/\(\s*(\d+)\s*PCS?\s*\)/gi)]
      .reduce((sum, match) => sum + Number(match[1]), 0);
  }

  function itemTotalSold(item) {
    const derived = recordQuantity(item.outbound) + manualSold(item);
    if (derived) return derived;
    return Math.max(0, Number(item.computedTotalSold) || 0);
  }

  function showroomQuantity(item) {
    const text = String(item.showroom || "").trim();
    if (!text) return Math.max(0, Number(item.showroomQuantity) || 0);
    return text.split(/\r?\n/).filter((line) => line.trim()).reduce((total, line) => {
      const counted = recordQuantity(line);
      return total + (counted || 1);
    }, 0);
  }

  function excelItems() {
    return baseItems.map((item) => ({
      ...item,
      category: categoryLabel(item.category),
      showroomQuantity: showroomQuantity(item),
      computedTotalSold: itemTotalSold(item),
    }));
  }

  function excelSyncPayload() {
    return {
      items: excelItems(),
      sync: {
        revision: lastRemoteRevision || Number(syncState.revision) || 0,
        updatedAt: syncState.updatedAt || (lastRemoteUpdatedAt ? new Date(lastRemoteUpdatedAt).toISOString() : ""),
        imageSetVersion: imageVersion,
      },
    };
  }

  async function syncExcelFromApp(showToast = false) {
    if (!window.TekStockExcel || remoteConfig.readOnly) return false;
    try {
      const result = await window.TekStockExcel.write(excelSyncPayload());
      if (!result?.ok) throw new Error(result?.error || "Excel sync failed");
      if (showToast) toast("Excel 已同步");
      return true;
    } catch (error) {
      console.error(error);
      if (showToast) toast(error.message || "Excel 同步失败");
      excelUploadPending = true;
      updateCloudVersionBadge();
      return false;
    }
  }

  async function acknowledgeExcelFromApp(showToast = false, payload = excelSyncPayload()) {
    if (!window.TekStockExcel?.acknowledge || remoteConfig.readOnly) return false;
    try {
      const result = await window.TekStockExcel.acknowledge(payload);
      if (result?.conflict) {
        reportDiagnostic("sync_failed", {
          status: "error",
          phase: "excel_ack",
          errorCode: "EXCEL_CHANGED_DURING_UPLOAD",
          revision: lastRemoteRevision,
          itemCount: baseItems.length,
        }, true);
        excelUploadPending = true;
        updateCloudVersionBadge();
        if (showToast) toast("Excel 在上传期间又有修改；云端已保留，请按 Update 重新确认");
        return false;
      }
      if (!result?.ok) throw new Error(result?.error || "Excel acknowledgement failed");
      excelUploadPending = false;
      updateCloudVersionBadge();
      if (showToast) toast("Excel 已确认云端版本");
      return true;
    } catch (error) {
      console.error(error);
      reportDiagnostic("sync_failed", {
        status: "error",
        phase: "excel_ack",
        errorCode: diagnosticErrorCode(error, "EXCEL_ACK_FAILED"),
        revision: lastRemoteRevision,
        itemCount: baseItems.length,
      }, true);
      if (showToast) toast(error.message || "Excel 确认失败");
      excelUploadPending = true;
      updateCloudVersionBadge();
      return false;
    }
  }

  const workbookMergeFields = [
    "category", "model", "stock", "showroomQuantity", "computedTotalSold",
    "cost", "sellingPrice", "sellingPriceText", "specification", "arrival",
    "showroom", "outbound", "totalSold", "image",
  ];

  function excelMergeFailure(errorCode, conflicts = []) {
    reportDiagnostic("sync_failed", {
      status: "conflict",
      phase: "excel_import",
      errorCode,
      revision: lastRemoteRevision,
      itemCount: baseItems.length,
    }, true);
    return {
      ok: false,
      conflict: true,
      preserved: true,
      errorCode,
      conflicts: conflicts.slice(0, 20),
      changed: 0,
      created: 0,
      deleted: 0,
      uploaded: false,
    };
  }

  function excelAcknowledgementPlan(result, rows) {
    return {
      expectedMtimeMs: Number(result.mtimeMs) || 0,
      expectedSha256: String(result.sha256 || ""),
      rows: rows
        .filter((row) => row._excelGeneratedId || excelSyncCore.shouldImportExcelImage(row))
        .map((row) => ({
          sourceRow: Number(row.sourceRow) || 0,
          originalId: row._excelGeneratedId ? "" : String(row.id || ""),
          assignedId: String(row.id || ""),
          category: String(row.category || "").trim(),
          model: String(row.model || "").trim(),
          specification: String(row.specification || "").trim(),
          uploadedImageHash: excelSyncCore.shouldImportExcelImage(row)
            ? String(row.embeddedImageHash || "")
            : "",
        })),
    };
  }

  function stageExcelWorkbookMerge(
    result,
    liveItems = lastRemoteItems,
    liveRevision = lastRemoteRevision,
    liveUpdatedAt = lastRemoteUpdatedAt,
  ) {
    const rows = excelSyncCore.normalizeExcelRows(result?.items);
    if (rows.some((row) => !Number.isFinite(row.stock))) {
      return excelMergeFailure("EXCEL_INVALID_STOCK");
    }
    const identityAudit = excelSyncCore.mergeInventoryViews({
      onlineItems: liveItems,
      offlineItems: rows,
    });
    if (!identityAudit.ok) {
      return excelMergeFailure("EXCEL_IDENTITY_DUPLICATE_REVIEW", identityAudit.duplicateKeys);
    }
    const workbookRevision = Number(result?.sync?.revision) || 0;
    const workbookExpectedItemCount = Number(result?.sync?.itemCount) || 0;
    const workbookWasEdited = excelSyncCore.hasMeaningfulWorkbookChanges(result);
    const baselineRecords = result?.baseline?.records;
    const merge = excelSyncCore.mergeWorkbookSnapshot({
      workbookRevision,
      workbookExpectedItemCount,
      baselineRevision: result?.baseline?.revision,
      baselineItemCount: result?.baseline?.itemCount,
      baselineRecords,
      liveRevision,
      liveItems,
      excelRows: rows,
      allowAdditiveRecovery: cloudDataState === "live",
      allowPureDeletionRecovery: cloudDataState === "live",
      workbookWasEdited,
      excelRowIdsUnique: result?.integrity?.itemIdsUnique === true,
    });
    if (!merge) return excelMergeFailure("EXCEL_STALE_BASELINE_MISSING");
    if (!merge.ok) {
      return excelMergeFailure("EXCEL_THREE_WAY_CONFLICT", merge.conflicts);
    }

    const liveById = new Map(liveItems.map((item) => [String(item.id || ""), item]));
    const mergedById = new Map(merge.items.map((item) => [String(item.id || ""), item]));
    const stagedEdits = {};
    for (const id of merge.created) {
      stagedEdits[id] = { ...mergedById.get(id), _newProduct: true };
    }
    for (const id of merge.updated) {
      const before = liveById.get(id) || {};
      const after = mergedById.get(id) || {};
      const patch = {};
      for (const field of workbookMergeFields) {
        if (JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)) {
          patch[field] = after[field];
        }
      }
      if (Object.keys(patch).length) stagedEdits[id] = patch;
    }
    for (const id of merge.deleted) {
      stagedEdits[id] = {
        _deleteProduct: true,
        _deleteBaselineRevision: Number(liveRevision) || 0,
        _deleteBaselineItemCount: liveItems.length,
      };
    }

    lastRemoteItems = liveItems.map((item) => ({ ...item }));
    lastRemoteRevision = Number(liveRevision) || lastRemoteRevision;
    lastRemoteItemCount = liveItems.length;
    lastRemoteUpdatedAt = Number(liveUpdatedAt) || lastRemoteUpdatedAt;
    baseItems = merge.items.map((item) => ({
      ...item,
      image: approvedImage(item.id, item.image),
    }));
    localEdits = stagedEdits;
    syncState.revision = lastRemoteRevision;
    syncState.updatedAt = lastRemoteUpdatedAt
      ? new Date(lastRemoteUpdatedAt).toISOString()
      : String(result?.sync?.updatedAt || "");
    syncState.dirty = Object.keys(stagedEdits).length > 0;
    if (syncState.dirty) saveLocalEdits();
    else clearSyncedLocalEdits(lastRemoteRevision, syncState.updatedAt);
    buildCategories();
    render();

    return {
      ok: true,
      merge,
      rows,
      identityAudit,
      ackPlan: excelAcknowledgementPlan(result, rows),
      changed: merge.created.length + merge.updated.length + merge.deleted.length,
      created: merge.created.length,
      deleted: merge.deleted.length,
    };
  }

  async function importExcelData(showToast = true, preparedWorkbook = null) {
    if (!window.TekStockExcel || remoteConfig.readOnly) return false;
    try {
      const result = preparedWorkbook || await window.TekStockExcel.read();
      if (!result?.ok || !Array.isArray(result.items)) throw new Error(result?.error || "Excel read failed");
      if (!excelSyncCore) throw new Error("Excel sync module is unavailable");
      const rows = excelSyncCore.normalizeExcelRows(result.items);
      const remoteSnapshotItemCount = lastRemoteItemCount
        || baseItems.filter((item) => !localEdits[item.id]?._newProduct).length;
      const workbookRevision = Number(result.sync?.revision) || 0;
      const workbookExpectedItemCount = Number(result.sync?.itemCount) || 0;
      const workbookWasEdited = excelSyncCore.hasMeaningfulWorkbookChanges(result);
      const staleEditedWorkbook = !!lastRemoteRevision
        && workbookRevision < lastRemoteRevision
        && workbookWasEdited;
      if (Array.isArray(result.baseline?.records)) {
        if (workbookRevision > lastRemoteRevision) {
          return excelMergeFailure("EXCEL_FUTURE_REVISION");
        }
        if (workbookRevision < lastRemoteRevision && !workbookWasEdited) {
          if (showToast) toast("Excel 是旧版本，已保留云端新资料并自动更新 Excel");
          return { ok: true, changed: 0, uploaded: false, stale: true };
        }
        const staged = stageExcelWorkbookMerge(
          result,
          lastRemoteItems,
          lastRemoteRevision,
          lastRemoteUpdatedAt,
        );
        if (!staged.ok) {
          if (showToast) toast("Excel 与云端同时修改了同一资料；文件已保留，未覆盖");
          return staged;
        }
        if (!staged.changed) {
          const acknowledged = staged.ackPlan.rows.length
            ? await acknowledgeExcelFromApp(false, {
              ...excelSyncPayload(),
              ackPlan: staged.ackPlan,
            })
            : workbookRevision !== lastRemoteRevision
              ? await syncExcelFromApp(false)
              : true;
          if (showToast) toast(acknowledged ? "Excel 没有新修改" : "Excel 回写未确认，请按 Update 重试");
          return { ok: true, changed: 0, uploaded: false, acknowledged };
        }
        const uploaded = await uploadInventoryData(true, {
          excelSource: true,
          excelWorkbook: result,
          ackPlan: staged.ackPlan,
        });
        if (uploaded !== true) handleUnconfirmedExcelUpload();
        if (showToast) {
          toast(uploaded === true
            ? `Excel 已新增 ${staged.created} 个、删除 ${staged.deleted} 个、更新 ${staged.changed - staged.created - staged.deleted} 个品项`
            : "Excel 已保留，但云端尚未确认更新，请重试");
        }
        return { ok: true, changed: staged.changed, uploaded: uploaded === true };
      }
      const generatedRowsWithoutBaseline = rows.filter((row) =>
        row?._excelGeneratedId && !row?._baseline
      ).length;
      const canRecoverUnacknowledgedCreations =
        staleEditedWorkbook &&
        lastRemoteRevision === workbookRevision + 1 &&
        remoteSnapshotItemCount === workbookExpectedItemCount + generatedRowsWithoutBaseline;
      if (lastRemoteRevision && workbookRevision < lastRemoteRevision) {
        if (workbookWasEdited && !rows.some((row) => row?._baseline)) {
          reportDiagnostic("sync_failed", {
            status: "conflict",
            phase: "excel_import",
            errorCode: "EXCEL_STALE_BASELINE_MISSING",
            revision: lastRemoteRevision,
            itemCount: baseItems.length,
          }, true);
          if (showToast) toast("Excel 已保留，但云端已有更新；请先处理版本冲突");
          return {
            ok: true,
            changed: 0,
            uploaded: false,
            conflict: true,
            preserved: true,
            errorCode: "EXCEL_STALE_BASELINE_MISSING",
          };
        }
        if (!workbookWasEdited) {
          if (showToast) toast("Excel 是旧版本，已保留云端新资料并自动更新 Excel");
          return { ok: true, changed: 0, uploaded: false, stale: true };
        }
      }
      const byId = new Map(baseItems.map((item) => [item.id, item]));
      const byIdentity = new Map();
      baseItems.forEach((item) => {
        const identity = excelSyncCore.itemIdentity(item);
        const matches = byIdentity.get(identity) || [];
        matches.push(item);
        byIdentity.set(identity, matches);
      });
      const excelItemIds = new Set();
      const ackPlan = {
        expectedMtimeMs: Number(result.mtimeMs) || 0,
        expectedSha256: String(result.sha256 || ""),
        rows: [],
      };
      let changed = 0;
      let created = 0;
      let deleted = 0;
      for (const row of rows) {
        if (!Number.isFinite(row.stock)) {
          reportDiagnostic("sync_failed", {
            status: "error",
            phase: "excel_import",
            errorCode: "EXCEL_INVALID_STOCK",
            revision: lastRemoteRevision,
            itemCount: baseItems.length,
          }, true);
          return {
            ok: true,
            changed: 0,
            uploaded: false,
            conflict: true,
            preserved: true,
            errorCode: "EXCEL_INVALID_STOCK",
          };
        }
        let item = byId.get(row.id);
        if (!item && row._excelGeneratedId) {
          item = (byIdentity.get(excelSyncCore.itemIdentity(row)) || [])
            .find((candidate) => !excelItemIds.has(candidate.id));
        }
        const sameSourceRow =
          item &&
          String(item.sourceFile || "") === String(row.sourceFile || "") &&
          String(item.sourceSheet || "") === String(row.sourceSheet || "") &&
          Number(item.sourceRow || 0) === Number(row.sourceRow || 0);
        const recoverUnacknowledgedCreation =
          canRecoverUnacknowledgedCreations &&
          row._excelGeneratedId &&
          !row._baseline &&
          sameSourceRow;
        if (staleEditedWorkbook && !row._baseline && !recoverUnacknowledgedCreation) {
          reportDiagnostic("sync_failed", {
            status: "conflict",
            phase: "excel_import",
            errorCode: "EXCEL_STALE_BASELINE_MISSING",
            revision: lastRemoteRevision,
            itemCount: baseItems.length,
          }, true);
          return {
            ok: true,
            changed: 0,
            uploaded: false,
            conflict: true,
            preserved: true,
            errorCode: "EXCEL_STALE_BASELINE_MISSING",
          };
        }
        if (!item) {
          const merged = excelSyncCore.mergeExcelRows([], [row]);
          if (!merged.length) continue;
          const newItem = {
            ...merged[0],
            stock: Number(row.stock) || 0,
            cost: Number.isFinite(row.cost) ? row.cost : null,
            sellingPrice: Number.isFinite(row.sellingPrice) ? row.sellingPrice : null,
            sellingPriceText: Number.isFinite(row.sellingPrice) ? String(row.sellingPrice) : "",
            specification: String(row.specification || "").trim(),
            arrival: String(row.arrival || "").trim(),
            showroom: String(row.showroom || "").trim(),
            outbound: String(row.outbound || "").trim(),
            totalSold: Math.max(0, Number(row.totalSold) || 0),
            image: row.imageChanged || row.imageUntracked ? String(row.image || "") : "",
            sourceFile: String(row.sourceFile || "TEK-STOCK-LIVE.xlsx"),
            sourceSheet: String(row.sourceSheet || "库存总表"),
            sourceRow: Number(row.sourceRow) || 0,
          };
          baseItems.push(newItem);
          excelItemIds.add(newItem.id);
          byId.set(newItem.id, newItem);
          const identity = excelSyncCore.itemIdentity(newItem);
          const matches = byIdentity.get(identity) || [];
          matches.push(newItem);
          byIdentity.set(identity, matches);
          localEdits[newItem.id] = { ...newItem, _newProduct: true };
          ackPlan.rows.push({
            sourceRow: Number(row.sourceRow) || 0,
            originalId: row._excelGeneratedId ? "" : String(row.id || ""),
            assignedId: newItem.id,
            category: String(row.category || "").trim(),
            model: String(row.model || "").trim(),
            specification: String(row.specification || "").trim(),
            uploadedImageHash: row.imageChanged || row.imageUntracked
              ? String(row.embeddedImageHash || "")
              : "",
          });
          changed += 1;
          created += 1;
          continue;
        }
        excelItemIds.add(item.id);
        const outbound = String(row.outbound || "").trim();
        const outboundDelta = recordQuantity(outbound) - recordQuantity(item.outbound);
        const excelStock = Number(row.stock);
        const stockWasManuallyEdited = Number.isFinite(excelStock) && excelStock !== itemStock(item);
        let patch = {
          category: safeWorkbookText(row.category, item.category),
          model: safeWorkbookText(row.model, item.model),
          stock: stockWasManuallyEdited ? excelStock : itemStock(item) - outboundDelta,
          cost: Number.isFinite(row.cost) ? row.cost : null,
          sellingPrice: Number.isFinite(row.sellingPrice) ? row.sellingPrice : null,
          sellingPriceText: Number.isFinite(row.sellingPrice) ? String(row.sellingPrice) : "",
          specification: safeWorkbookText(row.specification, item.specification || ""),
          arrival: safeWorkbookText(row.arrival, item.arrival || ""),
          showroom: safeWorkbookText(row.showroom, item.showroom || ""),
          outbound,
          totalSold: Math.max(0, Number(row.totalSold) || 0),
          showroomQuantity: Number.isFinite(row.showroomQuantity)
            ? Math.max(0, Number(row.showroomQuantity))
            : Math.max(0, Number(item.showroomQuantity) || 0),
          computedTotalSold: Number.isFinite(row.computedTotalSold)
            ? Math.max(0, Number(row.computedTotalSold))
            : Math.max(0, Number(item.computedTotalSold) || 0),
        };
        if (staleEditedWorkbook) {
          patch = excelSyncCore.staleWorkbookPatch(
            row,
            recoverUnacknowledgedCreation ? item : row._baseline,
          );
        }
        const shouldImportImage = excelSyncCore.shouldImportExcelImage(row);
        const baselinePhotoChanged = !staleEditedWorkbook
          || String(row.embeddedImageHash || "") !== String(row._baseline?.imageHash || "");
        if (shouldImportImage && baselinePhotoChanged) {
          patch.image = String(row.image || "");
        }
        if (row._excelGeneratedId || (shouldImportImage && baselinePhotoChanged)) {
          ackPlan.rows.push({
            sourceRow: Number(row.sourceRow) || 0,
            originalId: row._excelGeneratedId ? "" : String(row.id || item.id || ""),
            assignedId: item.id,
            category: String(row.category || "").trim(),
            model: String(row.model || "").trim(),
            specification: String(row.specification || "").trim(),
            uploadedImageHash: shouldImportImage && baselinePhotoChanged
              ? String(row.embeddedImageHash || "")
              : "",
          });
        }
        if (JSON.stringify(patch) !== JSON.stringify(Object.fromEntries(Object.keys(patch).map((key) => [key, item[key]])))) {
          changed += 1;
          localEdits[item.id] = { ...(localEdits[item.id] || {}), ...patch };
          Object.assign(item, patch);
        }
      }
      const snapshotCanDelete = cloudDataState === "live"
        && excelSyncCore.canApplyWorkbookDeletions({
        lastRemoteRevision,
        workbookRevision,
        workbookMtimeMs: Number(result.mtimeMs) || 0,
        lastRemoteUpdatedAt,
        workbookExpectedItemCount: Number(result.sync?.itemCount) || 0,
        remoteItemCount: remoteSnapshotItemCount,
        });
      if (snapshotCanDelete) {
        const retained = [];
        for (const item of baseItems) {
          if (excelItemIds.has(item.id)) {
            retained.push(item);
            continue;
          }
          localEdits[item.id] = {
            _deleteProduct: true,
            _deleteBaselineRevision: lastRemoteRevision,
            _deleteBaselineItemCount: remoteSnapshotItemCount,
          };
          changed += 1;
          deleted += 1;
        }
        baseItems = retained;
      }
      if (!changed) {
        if (showToast) toast("Excel 没有新修改");
        return { ok: true, changed: 0, uploaded: false };
      }
      saveLocalEdits();
      buildCategories();
      render();
      const uploaded = await uploadInventoryData(true, { excelSource: true, ackPlan });
      if (uploaded !== true) handleUnconfirmedExcelUpload();
      if (showToast) {
        toast(uploaded === true ? (created
          ? `Excel 已新增 ${created} 个、删除 ${deleted} 个、更新 ${changed - created - deleted} 个品项`
          : deleted
             ? `Excel 已删除 ${deleted} 个、更新 ${changed - deleted} 个品项`
            : `已从 Excel 更新 ${changed} 个品项`)
          : "Excel 已读取，但云端尚未确认更新，请重试");
      }
      return { ok: true, changed, uploaded: uploaded === true };
    } catch (error) {
      console.error(error);
      reportDiagnostic("sync_failed", {
        status: "error",
        phase: "excel_import",
        errorCode: diagnosticErrorCode(error, "EXCEL_IMPORT_FAILED"),
        revision: lastRemoteRevision,
        itemCount: baseItems.length,
      }, true);
      if (showToast) toast(error.message || "Excel 读取失败");
      return { ok: false, changed: 0, uploaded: false, error: error.message || String(error) };
    }
  }

  function excelBootstrapMessage(state) {
    if (excelBootstrapCore?.bootstrapMessage) return excelBootstrapCore.bootstrapMessage(state);
    if (state === "bootstrapped") return "本机 Excel 已从云端建立。";
    if (state === "offline-not-initialized") return "首次建立本机 Excel 需要连接云端；旧 Excel 已保留未改动。";
    if (state === "invalid-private-workbook") return "本机 Excel 无法验证，未覆盖原文件。";
    return "Excel 初始化失败";
  }

  async function initializeExcel() {
    if (!window.TekStockExcel || remoteConfig.readOnly || excelInitialized) return;
    excelInitialized = true;
    try {
      const info = await window.TekStockExcel.ensure();
      if (!info?.ok) {
        toast(excelBootstrapMessage(info?.state));
        return;
      }
      if (el.helpDataLocation) {
        el.helpDataLocation.textContent = `Cloud: ${remoteConfig.dataUrl || remoteConfig.deploymentNote || "Alibaba Central API"}\nExcel: ${info.path}`;
      }
      if (!info.created) {
        const workbook = await window.TekStockExcel.read();
        const workbookRevision = Number(workbook?.sync?.revision) || 0;
        const workbookWasEdited = excelSyncCore.hasMeaningfulWorkbookChanges(
          workbook,
          info.mtimeMs,
        );
        if (workbookWasEdited || workbookRevision === 0) {
          excelUploadPending = true;
          updateCloudVersionBadge();
        } else if (!hasPendingEdits() && lastRemoteRevision > workbookRevision) {
          await syncExcelFromApp(false);
        }
      }
      window.TekStockExcel.onChanged(() => {
        excelUploadPending = true;
        updateCloudVersionBadge();
        if (window.TekStockCloud?.snapshot) {
          setTimeout(() => loadRemoteData(true), 250);
        } else {
          setTimeout(() => importExcelData(true), 700);
        }
      });
      if (window.TekStockCloud?.onSynced) {
        window.TekStockCloud.onSynced(async (sync) => {
          if (sync?.workbookAcknowledged !== true) return;
          excelUploadPending = false;
          updateCloudVersionBadge();
          await loadRemoteData(false);
        });
      }
      if (window.TekStockCloud?.onSyncFailed) {
        window.TekStockCloud.onSyncFailed(async (failure) => {
          excelUploadPending = true;
          updateCloudVersionBadge();
          console.error("Excel central sync failed", failure?.errorCode || "SYNC_FAILED");
          try {
            await conflictResolutionCore?.handleBackgroundSyncConflict?.(
              resolvePendingSyncConflicts,
            );
          } catch (error) {
            console.error(error);
          }
        });
      }
    } catch (error) {
      console.error(error);
      toast(error.message || "Excel 初始化失败");
    }
  }

  async function openLiveExcel() {
    if (!window.TekStockExcel) {
      exportXlsx();
      return;
    }
    const previousText = el.exportButton?.textContent || "Excel";
    try {
      if (el.exportButton) {
        el.exportButton.disabled = true;
        el.exportButton.textContent = "Opening...";
      }
      const openWorkbook = () => (excelOpenCore?.openWorkbook
        ? excelOpenCore.openWorkbook(window.TekStockExcel, excelSyncPayload())
        : window.TekStockExcel.open());
      if (excelBootstrapCore?.openAfterBootstrap && window.TekStockExcel.bootstrap) {
        const gated = await excelBootstrapCore.openAfterBootstrap(window.TekStockExcel, openWorkbook);
        if (!gated.ok) {
          toast(gated.message || excelBootstrapMessage(gated.bootstrap?.state));
          return;
        }
        if (!gated.opened?.ok) throw new Error(gated.opened?.error || "Excel open failed");
        toast(gated.message || "已打开实时 Excel");
        return;
      }
      toast("正在打开实时 Excel...");
      const result = await openWorkbook();
      if (!result?.ok) throw new Error(result?.error || "Excel open failed");
      toast("已打开实时 Excel");
    } catch (error) {
      console.error(error);
      toast(error.message || "无法打开 Excel");
    } finally {
      if (el.exportButton) {
        el.exportButton.disabled = false;
        el.exportButton.textContent = previousText;
      }
    }
  }

  async function openCloudResetLocal() {
    if (!el.resetLocalDialog || !window.TekStockExcel?.resetLocalFromCloud) return;
    el.resetLocalConfirm.disabled = true;
    el.resetLocalLiveState.textContent = "正在读取实时云端版本…";
    try {
      const snapshot = await window.TekStockCloud?.snapshot?.();
      if (snapshot?.cloudState !== "live") {
        el.resetLocalLiveState.textContent = "当前无法确认实时云端；本机未改变。";
        return;
      }
      el.resetLocalLiveState.textContent = `实时云端：v${snapshot.revision} · ${snapshot.items?.length || 0} 项。`;
      el.resetLocalConfirm.disabled = false;
      el.resetLocalDialog.returnValue = "";
      el.resetLocalDialog.showModal();
      const close = async () => {
        if (el.resetLocalDialog.returnValue !== "confirm") return;
        el.resetLocalConfirm.disabled = true;
        el.resetLocalLiveState.textContent = "已确认；正在备份并重置本机…";
        const result = await window.TekStockExcel.resetLocalFromCloud(
          "TEK-STOCK-CLOUD-RESET-LOCAL-CONFIRMED",
        );
        if (!result?.ok) {
          el.resetLocalConfirm.disabled = false;
          el.resetLocalLiveState.textContent = `本机未完成重置：${result?.errorCode || "CLOUD_RESET_FAILED"}`;
          toast(`本机重置失败：${result?.errorCode || "CLOUD_RESET_FAILED"}`);
          return;
        }
        toast(`本机已重置到云端 v${result.revision} · ${result.itemCount} 项`);
        el.resetLocalLiveState.textContent = `完成：Cloud v${result.revision} · ${result.itemCount} 项。正在重新加载…`;
        window.setTimeout(() => window.location.reload(), 350);
      };
      el.resetLocalDialog.addEventListener("close", close, { once: true });
    } catch (error) {
      el.resetLocalConfirm.disabled = true;
      el.resetLocalLiveState.textContent = `无法读取实时云端：${error?.message || "CLOUD_RESET_FAILED"}`;
    }
  }

  async function reinstallLatestDesktop() {
    if (!window.TekStockUpdater?.reinstall || !el.reinstallButton) {
      toast("Reinstall is unavailable in this version");
      return;
    }
    const button = el.reinstallButton;
    const previousText = button.textContent || "Reinstall";
    button.disabled = true;
    button.textContent = "Downloading...";
    toast("Downloading and verifying the latest installer...");
    try {
      const result = await window.TekStockUpdater.reinstall();
      renderUpdateReceipt(result?.receipt, true);
      if (!result?.ok) {
        const error = new Error(result?.errorCode || "UPDATE_FAILED");
        error.code = result?.errorCode || "UPDATE_FAILED";
        throw error;
      }
      button.textContent = "Opening...";
      toast("Installer verified. Reinstall is opening...");
    } catch (error) {
      const code = String(error?.code || error?.message || "UPDATE_FAILED").slice(0, 64);
      button.disabled = false;
      button.textContent = previousText;
      toast(`Reinstall failed (${code}). Please try again.`);
    }
  }

  function updateReceiptMessage(receipt) {
    if (!receipt) return "Update check unavailable";
    const current = String(receipt.currentVersion || remoteConfig.appVersion || "unknown");
    const available = String(receipt.availableVersion || "unknown");
    if (receipt.action === "data_sync" && receipt.errorCode) {
      return `Excel sync failed · ${receipt.errorCode}`;
    }
    if (receipt.errorCode) return `Update check failed · current ${current} · ${receipt.errorCode}`;
    if (receipt.action === "user_reinstall" || receipt.action === "user_update") {
      if (receipt.action === "user_update" && receipt.newerVersionFound === false) {
        return `Already up to date · current ${current}`;
      }
      return `Installer ${receipt.downloadOutcome || "not_requested"} · launch ${receipt.launchOutcome || "not_requested"} · ${current} → ${available}`;
    }
    return receipt.newerVersionFound
      ? `New ${available} available · current ${current}`
      : `Update checked · current ${current} · available ${available}`;
  }

  function renderUpdateReceipt(receipt, announce = false) {
    if (!receipt || !el.updateReceipt) return;
    const message = updateReceiptMessage(receipt).slice(0, 180);
    el.updateReceipt.textContent = message;
    el.updateReceipt.title = `${message}${receipt.manifestSource ? ` · ${receipt.manifestSource}` : ""}`;
    el.updateReceipt.classList.toggle("is-error", !!receipt.errorCode);
    el.updateReceipt.classList.toggle("has-update", receipt.newerVersionFound === true);
    if (announce) toast(message);
  }

  function renderDataSyncFailure(errorCode) {
    renderUpdateReceipt({
      action: "data_sync",
      currentVersion: remoteConfig.appVersion,
      errorCode: String(errorCode || "WORKBOOK_SYNC_FAILED").slice(0, 64),
    });
  }

  async function refreshDesktopUpdateAlert(announce = false) {
    if (!window.TekStockUpdater?.check) return;
    try {
      const status = await window.TekStockUpdater.check();
      renderUpdateReceipt(status?.receipt, announce);
      const mismatch = status?.ok === true && status?.isMismatch === true;
      el.uploadButton?.classList.remove("version-mismatch");
      el.reinstallButton?.classList.toggle("version-mismatch", mismatch);
      const version = String(status?.version || "").slice(0, 40);
      const title = mismatch && version
        ? `Desktop version ${version} is available`
        : "";
      if (el.reinstallButton && title) el.reinstallButton.title = title;
    } catch (error) {
      renderUpdateReceipt({
        action: "check",
        checkRan: true,
        currentVersion: remoteConfig.appVersion,
        errorCode: String(error?.code || "UPDATE_CHECK_FAILED").slice(0, 64),
      }, announce);
    }
  }

  async function applyNewerDesktopUpdate() {
    if (!window.TekStockUpdater?.update) {
      await refreshDesktopUpdateAlert(true);
      return;
    }
    try {
      const result = await window.TekStockUpdater.update();
      renderUpdateReceipt(result?.receipt, true);
      if (!result?.ok) {
        const error = new Error(result?.errorCode || "UPDATE_FAILED");
        error.code = result?.errorCode || "UPDATE_FAILED";
        throw error;
      }
      if (result.updateAvailable === true) toast("New app verified. Restarting to update...");
    } catch (error) {
      const code = String(error?.code || error?.message || "UPDATE_FAILED").slice(0, 64);
      toast(`App update failed (${code}). Data sync was still attempted.`);
    }
  }

  async function handleUpdateClick() {
    const dataSynchronized = await updateInventory();
    if (!dataSynchronized) return false;
    return applyNewerDesktopUpdate();
  }

  function searchable(item) {
    return [item.model, item.category, item.specification, item.arrival, item.showroom, item.outbound, item.sellingPriceText]
      .join(" ").toLocaleLowerCase();
  }

  function filteredItems() {
    return filterSortCore.filterItems(baseItems, {
      selectedCategories: state.selectedCategories,
      query: state.query,
      stockFilter: state.stockFilter,
    }, { categoryLabel, itemStock, searchable });
  }

  function updateSummary() {
    const stocks = baseItems.map(itemStock);
    if (el.totalStock) el.totalStock.textContent = stocks.reduce((sum, stock) => sum + stock, 0).toLocaleString();
    if (el.totalModels) el.totalModels.textContent = baseItems.length.toLocaleString();
    if (el.totalSold) el.totalSold.textContent = baseItems.reduce((sum, item) => sum + itemTotalSold(item), 0).toLocaleString();
    if (el.lowModels) el.lowModels.textContent = stocks.filter((stock) => stock > 0 && stock <= 2).length.toLocaleString();
    if (el.outModels) el.outModels.textContent = stocks.filter((stock) => stock <= 0).length.toLocaleString();
  }

  function priceText(value, fallback) {
    return Number.isFinite(value) ? `S$ ${money.format(value)}` : (fallback || "—");
  }

  function rawPriceText(value, fallback) {
    return Number.isFinite(value) ? String(value) : (fallback || "");
  }

  function stockClass(stock) {
    return stock <= 0 ? "out" : stock <= 2 ? "low" : "";
  }

  function categoryLabel(category) {
    const text = String(category || "");
    const chair = String.fromCharCode(0x9910, 0x6905);
    const table = String.fromCharCode(0x9910, 0x684c);
    const middleTable = String.fromCharCode(0x4e2d, 0x684c);
    const cornerTable = String.fromCharCode(0x89d2, 0x684c);
    const tv = String.fromCharCode(0x7535, 0x89c6);
    const bed = String.fromCharCode(0x5e8a);
    const sofa = String.fromCharCode(0x6c99, 0x53d1);
    const lounge = String.fromCharCode(0x5fe7, 0x95f2);
    if (text.includes(chair)) return String.fromCharCode(0x9910, 0x6905);
    if (text.includes(table)) return String.fromCharCode(0x9910, 0x684c);
    if (text.includes(middleTable) || text.includes(cornerTable)) return String.fromCharCode(0x8336, 0x51e0, 0x002f, 0x4e2d, 0x684c);
    if (text.toUpperCase().includes("BAR")) return String.fromCharCode(0x5427, 0x6905);
    if (text.includes(tv)) return String.fromCharCode(0x7535, 0x89c6, 0x67dc);
    if (text.includes(sofa) || text.includes(lounge)) return String.fromCharCode(0x6c99, 0x53d1, 0x002f, 0x4f11, 0x95f2, 0x6905);
    if (text.includes(bed)) return String.fromCharCode(0x5e8a);
    return text || String.fromCharCode(0x5176, 0x4ed6);
  }

  function categoryRank(category) {
    const label = categoryLabel(category);
    const order = [
      String.fromCharCode(0x9910, 0x6905),
      String.fromCharCode(0x9910, 0x684c),
      String.fromCharCode(0x8336, 0x51e0, 0x002f, 0x4e2d, 0x684c),
      String.fromCharCode(0x5427, 0x6905),
      String.fromCharCode(0x7535, 0x89c6, 0x67dc),
      String.fromCharCode(0x5e8a),
      String.fromCharCode(0x6c99, 0x53d1, 0x002f, 0x4f11, 0x95f2, 0x6905),
    ];
    const index = order.indexOf(label);
    return index >= 0 ? index : 99;
  }

  function zh(...codes) {
    return String.fromCharCode(...codes);
  }

  function modelCount(model) {
    return baseItems.filter((item) => item.model === model).length;
  }

  function variantText(item) {
    if (modelCount(item.model) <= 1) return "";
    const spec = String(item.specification || "").replace(/\s+/g, " ").trim();
    if (spec) return spec.length > 42 ? spec.slice(0, 42) + "…" : spec;
    return `${item.sourceSheet || ""} #${item.sourceRow || ""}`.trim();
  }

  function imageMarkup(item) {
    const fallback = String(packagedImages.get(item.id) || "").trim();
    return item.image
      ? `<img class="product-image" src="${escapeHtml(versionedImageSource(item.image))}" data-fallback="${escapeHtml(fallback)}" alt="${escapeHtml(item.model)}" loading="lazy">`
      : `<div class="image-fallback" aria-label="No photo">HP</div>`;
  }

  function cardMarkup(item, index) {
    const stock = itemStock(item);
    const showroom = showroomQuantity(item);
    const sold = itemTotalSold(item);
    const showroomClass = showroom ? " in-showroom" : "";
    return `
      <article class="inventory-card${showroomClass}" data-id="${escapeHtml(item.id)}" style="animation-delay:${Math.min(index, 12) * 18}ms">
        <div class="product-image-wrap">
          ${imageMarkup(item)}
          <span class="stock-badge ${stockClass(stock)}">${stock}</span>
        </div>
        <div class="card-body">
          <p class="card-category">${escapeHtml(categoryLabel(item.category))}</p>
          <h2 class="card-model">${escapeHtml(item.model)}</h2>
          ${variantText(item) ? `<p class="card-variant">${escapeHtml(variantText(item))}</p>` : ""}
          <div class="card-meta">
            <span>${escapeHtml(priceText(item.sellingPrice, item.sellingPriceText))}</span>
            <span>${zh(0x6210, 0x672c)} ${escapeHtml(priceText(item.cost))}</span>
          </div>
          <div class="stock-readout">
            <span>庫存 ${stock}</span>
            <span class="showroom-text">展廳 ${showroom}</span>
            <span class="sold-text">已售 ${sold}</span>
          </div>
        </div>
      </article>`;
  }

  function clearMissingActiveDetail() {
    if (!state.activeId || baseItems.some((item) => item.id === state.activeId)) return;
    state.activeId = "";
    if (el.detailDialog?.open) el.detailDialog.close();
  }

  function render() {
    clearMissingActiveDetail();
    const filtered = filteredItems();
    const list = state.sortDirection === "none"
      ? filtered
      : filterSortCore.sortItems(filtered, state.sortDirection, { itemStock });
    el.resultCount.textContent = list.length.toLocaleString();
    el.inventoryGrid.innerHTML = list.map(cardMarkup).join("");
    el.inventoryGrid.querySelectorAll("img.product-image").forEach((image) => {
      image.addEventListener("error", handleProductImageError);
    });
    el.loadMoreButton.hidden = true;
    el.emptyState.hidden = list.length !== 0;
    updateSummary();
  }

  function setDetailReadOnly(readOnly) {
    [el.detailCost, el.detailPrice, el.detailSpec, el.detailArrival, el.detailShowroom, el.detailOutbound]
      .filter(Boolean)
      .forEach((field) => {
        field.readOnly = readOnly;
        field.disabled = readOnly;
      });
    if (el.detailStock) {
      el.detailStock.readOnly = true;
      el.detailStock.disabled = false;
    }
    if (el.detailSoldNow) {
      el.detailSoldNow.readOnly = true;
      el.detailSoldNow.disabled = false;
    }
    if (el.saveDetailButton) el.saveDetailButton.hidden = readOnly;
    if (el.resetDetailButton) el.resetDetailButton.hidden = readOnly;
    if (el.changePhotoButton) el.changePhotoButton.hidden = readOnly;
  }

  function openDetail(item) {
    state.activeId = item.id;
    const detailSource = versionedImageSource(item.image);
    if (detailSource) {
      el.detailImage.hidden = false;
      el.detailImage.alt = item.model;
      el.detailImage.src = detailSource;
    } else {
      hideBrokenDetailImage();
    }
    el.detailCategory.textContent = categoryLabel(item.category);
    el.detailModel.textContent = item.model;
    el.detailStock.value = itemStock(item);
    el.detailSoldNow.value = 0;
    el.detailSoldNow.dataset.originalOutbound = String(recordQuantity(item.outbound));
    el.detailTotalSold.textContent = itemTotalSold(item).toLocaleString();
    el.detailCost.value = rawPriceText(item.cost);
    el.detailPrice.value = rawPriceText(item.sellingPrice, item.sellingPriceText);
    el.detailSpec.value = item.specification || "";
    el.detailArrival.value = item.arrival || "";
    el.detailShowroom.value = item.showroom || "";
    el.detailOutbound.value = item.outbound || "";
    el.detailSource.textContent = `${item.sourceFile} / ${item.sourceSheet} / Row ${item.sourceRow}`;
    setDetailReadOnly(!!remoteConfig.readOnly);
    el.detailDialog.showModal();
  }

  function openImagePreview() {
    if (!el.detailImage || el.detailImage.hidden || !el.detailImage.src) return;
    el.imagePreview.src = el.detailImage.src;
    el.imagePreview.alt = el.detailImage.alt || "Product photo";
    el.imagePreviewDialog.showModal();
  }

  function openFeedback() {
    const item = baseItems.find((candidate) => candidate.id === state.activeId);
    if (!item) return;
    el.feedbackModel.textContent = item.model;
    el.feedbackMessage.value = "";
    el.feedbackScreenshot.value = "";
    el.feedbackPreview.hidden = true;
    el.feedbackPreview.removeAttribute("src");
    feedbackScreenshotData = "";
    el.detailDialog.close();
    el.feedbackDialog.showModal();
  }

  function resizeFeedbackScreenshot(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Screenshot read failed"));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error("Screenshot decode failed"));
        image.onload = () => {
          const maxEdge = 1600;
          const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function submitFeedback() {
    const item = baseItems.find((candidate) => candidate.id === state.activeId);
    if (!item || !feedbackScreenshotData) {
      toast("请先上传截图");
      return;
    }
    if (!remoteConfig.feedbackUrl || !remoteConfig.feedbackToken) {
      toast("反馈功能尚未启用");
      return;
    }
    el.feedbackSubmit.disabled = true;
    try {
      const response = await fetch(remoteConfig.feedbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-feedback-token": remoteConfig.feedbackToken },
        body: JSON.stringify({
          itemId: item.id,
          model: item.model,
          message: el.feedbackMessage.value.trim(),
          screenshot: feedbackScreenshotData,
          appVersion: "1.2.0",
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      el.feedbackDialog.close();
      toast("问题已提交");
    } catch (error) {
      console.error(error);
      toast("提交失败，请重试");
    } finally {
      el.feedbackSubmit.disabled = false;
    }
  }

  function parseMoneyInput(value) {
    const cleaned = String(value || "").replace(/RM|SGD|S\$/gi, "").replace(/,/g, "").trim();
    if (!cleaned) return null;
    const number = Number(cleaned);
    return Number.isFinite(number) ? number : null;
  }

  async function saveActiveDetail() {
    if (remoteConfig.readOnly) return;
    const item = baseItems.find((candidate) => candidate.id === state.activeId);
    if (!item) return;
    const currentStock = itemStock(item);
    const oldOutboundQuantity = recordQuantity(item.outbound);
    const newOutbound = el.detailOutbound.value.trim();
    const newOutboundQuantity = recordQuantity(newOutbound);
    const outboundDelta = newOutboundQuantity - oldOutboundQuantity;
    const cost = parseMoneyInput(el.detailCost.value);
    const price = parseMoneyInput(el.detailPrice.value);
    const patch = {
      stock: currentStock - outboundDelta,
      totalSold: manualSold(item),
      cost: cost ?? undefined,
      sellingPrice: price ?? undefined,
      sellingPriceText: price == null ? el.detailPrice.value.trim() : undefined,
      specification: el.detailSpec.value.trim(),
      arrival: el.detailArrival.value.trim(),
      showroom: el.detailShowroom.value.trim(),
      outbound: newOutbound,
    };
    Object.keys(patch).forEach((key) => patch[key] === undefined && delete patch[key]);
    localEdits[item.id] = { ...(localEdits[item.id] || {}), ...patch };
    saveLocalEdits();
    Object.assign(item, patch);
    el.detailStock.value = itemStock(item);
    el.detailSoldNow.value = 0;
    el.detailSoldNow.dataset.originalOutbound = String(newOutboundQuantity);
    el.detailTotalSold.textContent = itemTotalSold(item).toLocaleString();
    render();
    toast(outboundDelta
      ? `出貨變動 ${outboundDelta > 0 ? "+" : ""}${outboundDelta}，庫存 ${itemStock(item)}`
      : "已保存");
    await syncExcelFromApp(false);
    await uploadInventoryData();
  }

  function previewOutboundDelta() {
    const item = baseItems.find((candidate) => candidate.id === state.activeId);
    if (!item) return;
    const originalQuantity = Number(el.detailSoldNow.dataset.originalOutbound) || 0;
    const nextQuantity = recordQuantity(el.detailOutbound.value);
    const delta = nextQuantity - originalQuantity;
    el.detailSoldNow.value = delta;
    el.detailStock.value = itemStock(item) - delta;
    el.detailTotalSold.textContent = (manualSold(item) + nextQuantity).toLocaleString();
  }

  function prepareReplacementPhoto(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Photo read failed"));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error("Photo decode failed"));
        image.onload = () => {
          const canvasSize = 900;
          const productArea = 780;
          const scale = Math.min(
            productArea / Math.max(1, image.naturalWidth),
            productArea / Math.max(1, image.naturalHeight),
          );
          const width = Math.max(1, Math.round(image.naturalWidth * scale));
          const height = Math.max(1, Math.round(image.naturalHeight * scale));
          const canvas = document.createElement("canvas");
          canvas.width = canvasSize;
          canvas.height = canvasSize;
          const context = canvas.getContext("2d");
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvasSize, canvasSize);
          context.drawImage(
            image,
            Math.round((canvasSize - width) / 2),
            Math.round((canvasSize - height) / 2),
            width,
            height,
          );
          resolve(canvas.toDataURL("image/webp", 0.9));
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function replaceActivePhoto(file) {
    if (remoteConfig.readOnly || !file) return;
    const item = baseItems.find((candidate) => candidate.id === state.activeId);
    if (!item) return;
    if (!window.TekStockCloud?.replacePhoto) {
      toast("Alibaba 云端照片服务尚未启用");
      return;
    }
    if (!(await ensureDesktopUploadToken())) return;
    if (el.changePhotoButton) el.changePhotoButton.disabled = true;
    try {
      const image = await prepareReplacementPhoto(file);
      if (window.TekStockCloud?.replacePhoto) {
        const result = await window.TekStockCloud.replacePhoto(item.id, image, {
          imageSha256: item.imageSha256 || "",
          imageVersion: item.imageVersion || "",
        });
        const patch = {
          image: result.image,
          imageSha256: result.imageSha256,
          imageVersion: result.imageVersion,
        };
        Object.assign(item, patch);
        delete localEdits[item.id]?.image;
        if (localEdits[item.id] && Object.keys(localEdits[item.id]).length === 0) delete localEdits[item.id];
        saveLocalEdits(false);
        el.detailImage.src = versionedImageSource(item.image, result.imageVersion);
        el.detailImage.hidden = false;
        render();
        await syncExcelFromApp(false);
        toast("照片已同步到所有设备");
        return;
      }
      throw new Error("CENTRAL_PHOTO_API_REQUIRED");
      const response = await fetch(remoteConfig.imageUploadUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-upload-token": remoteConfig.uploadToken },
        body: JSON.stringify({ itemId: item.id, model: item.model, image }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (!result.url) throw new Error("Missing image URL");
      const patch = { image: result.url, imageVersion: `manual-${Date.now()}` };
      localEdits[item.id] = { ...(localEdits[item.id] || {}), ...patch };
      saveLocalEdits();
      Object.assign(item, patch);
      el.detailImage.src = versionedImageSource(item.image, Date.now());
      el.detailImage.hidden = false;
      render();
      const uploaded = await uploadInventoryData();
      await syncExcelFromApp(false);
      toast(uploaded ? "照片已同步到手機" : "照片已保存，雲端同步失敗");
    } catch (error) {
      console.error(error);
      toast("更換照片失敗，請重試");
    } finally {
      if (el.changePhotoButton) el.changePhotoButton.disabled = false;
      el.detailPhotoInput.value = "";
    }
  }

  function resetActiveDetail() {
    if (remoteConfig.readOnly) return;
    const original = originalItems.find((candidate) => candidate.id === state.activeId);
    if (!original) return;
    delete localEdits[state.activeId];
    saveLocalEdits();
    const index = baseItems.findIndex((candidate) => candidate.id === state.activeId);
    if (index >= 0) baseItems[index] = { ...original };
    render();
    openDetail(baseItems[index]);
    toast("Done");
  }

  function selectFilter(filter) {
    state.stockFilter = filter;
    el.stockFilters.querySelectorAll("[data-filter]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.filter === filter);
    });
    render();
  }

  function selectSort(direction) {
    state.sortDirection = direction;
    el.sortControls?.querySelectorAll("[data-sort]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.sort === direction);
    });
    render();
  }

  function categoryImageSource(item) {
    return approvedImage(item?.id, item?.image);
  }

  function categoryPhotoMarkup(photo) {
    if (!photo?.image) return "";
    return `<img class="category-photo" src="${escapeHtml(versionedImageSource(photo.image))}" data-source-id="${escapeHtml(photo.sourceId)}" alt="" loading="lazy">`;
  }

  function allCategoryPhotoMarkup(photos) {
    const markup = photos.slice(0, 4).map((photo) => categoryPhotoMarkup(photo)).join("");
    return markup ? `<span class="category-montage" aria-hidden="true">${markup}</span>` : "";
  }

  function buildCategories() {
    const grouped = new Map();
    for (const category of baseItems.map((item) => item.category)) {
      const label = categoryLabel(category);
      if (!grouped.has(label)) grouped.set(label, label);
    }
    const photos = filterSortCore.representativePhotos(baseItems, categoryLabel, categoryImageSource);
    const montagePhotos = filterSortCore.montagePhotos(baseItems, categoryLabel, categoryImageSource);
    const categories = [{ label: String.fromCharCode(0x5168, 0x90e8), value: allCategory }, ...[...grouped.entries()]
      .sort((a, b) => categoryRank(a[1]) - categoryRank(b[1]) || a[0].localeCompare(b[0], "en"))
      .map(([label, value]) => ({ label, value }))];
    el.categoryFilters.innerHTML = categories.map((category) =>
      (() => {
        const isAll = category.value === allCategory;
        const photo = isAll ? null : photos.get(category.label);
        const active = isAll ? state.selectedCategories.size === 0 : state.selectedCategories.has(category.label);
        const image = isAll ? allCategoryPhotoMarkup(montagePhotos) : categoryPhotoMarkup(photo);
        const textFallback = image ? "" : escapeHtml(category.label);
        return `<button class="category-button${image ? "" : " is-text"} ${active ? "is-active" : ""}" data-category="${escapeHtml(category.value)}" data-category-label="${escapeHtml(category.label)}" title="${escapeHtml(category.label)}" aria-label="${escapeHtml(category.label)}" type="button">${image || textFallback}</button>`;
      })()
    ).join("");
  }

  function exportXlsx() {
    const rows = [["Category", "Model", "Stock", "Total Sold", "Cost", "Selling Price", "Spec", "Arrival", "Showroom", "Outbound"]];
    for (const item of filteredItems()) {
      rows.push([item.category, item.model, itemStock(item), itemTotalSold(item), item.cost ?? "", item.sellingPrice ?? item.sellingPriceText,
        item.specification, item.arrival, item.showroom, item.outbound]);
    }
    const bytes = buildXlsx(rows, "Furniture Stock");
    const fileName = `TEK-STOCK-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}.xlsx`;
    if (window.InventoryAndroid?.saveFile) {
      const result = window.InventoryAndroid.saveFile(fileName, bytesToBase64(bytes),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      toast(result || "Excel saved");
      return;
    }
    downloadBytes(fileName, bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    toast("Excel exported");
  }

  function printInventory() {
    const list = filteredItems();
    const rows = list.map((item) => `
      <tr>
        <td>${item.image ? `<img src="${escapeHtml(versionedImageSource(item.image))}" alt="">` : ""}</td>
        <td>${escapeHtml(item.category)}</td>
        <td>${escapeHtml(item.model)}</td>
        <td>${itemStock(item)}</td>
        <td>${escapeHtml(priceText(item.sellingPrice, item.sellingPriceText))}</td>
        <td>${escapeHtml(item.specification || "")}</td>
      </tr>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>TEK STOCK Print</title>
      <style>body{font-family:Arial,"Microsoft JhengHei",sans-serif;color:#111;margin:24px}h1{font-size:22px;margin:0 0 4px}.meta{color:#666;margin:0 0 18px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #ddd;padding:7px;text-align:left;vertical-align:middle}th{background:#f3f3f3}img{width:72px;height:54px;object-fit:contain}td:nth-child(4),th:nth-child(4){text-align:center}</style>
      </head><body><h1>TEK STOCK</h1><p class="meta">${new Date().toLocaleString()} / ${list.length} items</p>
      <table><thead><tr><th>Photo</th><th>Category</th><th>Model</th><th>Stock</th><th>Price</th><th>Spec</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    if (window.InventoryAndroid?.printHtml) {
      window.InventoryAndroid.printHtml("TEK-STOCK", html);
      toast("Done");
      return;
    }
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      toast("Done");
      return;
    }
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  function buildXlsx(rows, sheetName) {
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, rowIndex) =>
      `<row r="${rowIndex + 1}">${row.map((value, colIndex) => {
        const ref = columnName(colIndex + 1) + (rowIndex + 1);
        const text = value == null ? "" : String(value);
        return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(text)}</t></is></c>`;
      }).join("")}</row>`).join("")}</sheetData></worksheet>`;
    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    return zipStore({
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": workbookXml,
      "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": sheetXml,
    });
  }

  function zipStore(files) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    Object.entries(files).forEach(([name, text]) => {
      const nameBytes = encoder.encode(name);
      const data = encoder.encode(text);
      const crc = crc32(data);
      const local = concatBytes(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, data);
      parts.push(local);
      central.push(concatBytes(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes));
      offset += local.length;
    });
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    return concatBytes(...parts, ...central, u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(centralSize), u32(offset), u16(0));
  }

  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(value) { return new Uint8Array([value & 255, (value >>> 8) & 255]); }
  function u32(value) { return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]); }

  function concatBytes(...arrays) {
    const out = new Uint8Array(arrays.reduce((sum, item) => sum + item.length, 0));
    let at = 0;
    arrays.forEach((item) => { out.set(item, at); at += item.length; });
    return out;
  }

  function columnName(index) {
    let name = "";
    while (index > 0) {
      index -= 1;
      name = String.fromCharCode(65 + (index % 26)) + name;
      index = Math.floor(index / 26);
    }
    return name;
  }

  function xmlEscape(value) {
    return String(value ?? "").replace(/[<>&'"]/g, (char) => ({
      "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
    }[char]));
  }

  function bytesToBase64(bytes) {
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function downloadBytes(fileName, bytes, mime) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
    }[char]));
  }

  let toastTimer;
  function toast(message) {
    clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.classList.add("show");
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 6000);
  }

  function exportUploadPayload() {
    const cleanItem = (item) => {
      const { _newProduct, _deleteProduct, ...cleaned } = item;
      return cleaned;
    };
    return {
      app: "TEK STOCK",
      version: "1.5.0-cloud-sync",
      baseRevision: Number(syncState.revision) || lastRemoteRevision || 0,
      imageSetVersion: imageVersion,
      exportedAt: new Date().toISOString(),
      items: baseItems.map(cleanItem),
      edits: Object.fromEntries(
        Object.entries(localEdits).map(([id, item]) => [id, cleanItem(item)]),
      ),
    };
  }

  function canonicalCloudData(items) {
    const fields = [
      "id", "category", "model", "stock", "showroomQuantity", "computedTotalSold",
      "cost", "sellingPrice", "specification", "arrival", "showroom", "outbound",
      "totalSold", "image",
    ];
    return JSON.stringify((Array.isArray(items) ? items : [])
      .map((item) => Object.fromEntries(fields.map((field) => [field, item?.[field] ?? null])))
      .sort((left, right) => String(left.id || "").localeCompare(String(right.id || ""))));
  }

  async function cloudDataFingerprint(items) {
    const bytes = new TextEncoder().encode(canonicalCloudData(items));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function verifyCloudRoundTrip(expectedItems, expectedRevision) {
    if (!remoteConfig.dataUrl) throw new Error("Cloud verification URL is unavailable");
    const expectedFingerprint = await cloudDataFingerprint(expectedItems);
    let lastError = new Error("Cloud verification did not complete");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const suffix = remoteConfig.dataUrl.includes("?") ? "&" : "?";
        const response = await fetch(
          `${remoteConfig.dataUrl}${suffix}verify=${Date.now()}-${attempt}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error(`Cloud verification HTTP ${response.status}`);
        const payload = await response.json();
        if (!isSafeRemotePayload(payload)) throw new Error("Cloud verification payload is unsafe");
        const revision = Number(payload.revision) || 0;
        if (revision > expectedRevision) {
          const error = new Error("Cloud changed again during verification");
          error.code = "CLOUD_VERIFY_NEWER_REVISION";
          throw error;
        }
        if (revision !== expectedRevision) throw new Error("Cloud verification revision is stale");
        const actualFingerprint = await cloudDataFingerprint(payload.items);
        if (actualFingerprint !== expectedFingerprint) {
          throw new Error("Cloud verification data or photo fingerprint does not match");
        }
        return { payload, fingerprint: actualFingerprint };
      } catch (error) {
        lastError = error;
        if (error?.code === "CLOUD_VERIFY_NEWER_REVISION") break;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function localImageDataUrl(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onerror = () => reject(new Error(`Photo decode failed: ${source}`));
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, image.naturalWidth);
        canvas.height = Math.max(1, image.naturalHeight);
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0);
        resolve(canvas.toDataURL("image/webp", 0.9));
      };
      image.src = /^data:image\//i.test(source)
        ? source
        : `${source}${source.includes("?") ? "&" : "?"}v=${imageVersion}`;
    });
  }

  async function uploadLocalImage(item, source) {
    const cacheKey = /^data:image\//i.test(source)
      ? `${imageVersion}|excel|${item.id}|${source.length}|${source.slice(-64)}`
      : `${imageVersion}|${source}`;
    if (cloudImageMap[cacheKey]) return cloudImageMap[cacheKey];
    try {
      const image = await localImageDataUrl(source);
      const response = await fetch(remoteConfig.imageUploadUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-upload-token": remoteConfig.uploadToken },
        body: JSON.stringify({ itemId: item.id, model: item.model, image }),
      });
      if (!response.ok) {
        const error = new Error(`Photo upload HTTP ${response.status}`);
        if (response.status === 401) error.code = "HTTP_401";
        throw error;
      }
      const result = await response.json();
      if (!result.url) throw new Error("Missing image URL");
      cloudImageMap[cacheKey] = result.url;
      saveCloudImageMap();
      return result.url;
    } catch (error) {
      reportDiagnostic("sync_failed", {
        status: "error",
        phase: "photo_upload",
        errorCode: diagnosticErrorCode(error, "PHOTO_UPLOAD_FAILED"),
        revision: lastRemoteRevision,
        itemCount: baseItems.length,
      }, true);
      throw error;
    }
  }

  async function publishLocalImages(items, remoteImages, remoteImageSetVersion) {
    if (!remoteConfig.imageUploadUrl || !remoteConfig.uploadToken) return items;
    const localPattern = /^assets\/images\/edited-[a-z0-9_-]+\.(?:webp|png|jpe?g)$/i;
    const dataPattern = /^data:image\//i;
    const cloudPattern = /^https:\/\//i;
    const output = items.map((item) => ({ ...item }));
    const targets = [];
    for (let index = 0; index < output.length; index += 1) {
      const item = output[index];
      const patchedImage = String(localEdits[item.id]?.image || "").trim();
      const remoteImage = String(remoteImages.get(item.id) || "").trim();
      if (cloudPattern.test(patchedImage)) {
        item.image = patchedImage;
      } else if (!patchedImage && remoteImageSetVersion === imageVersion && cloudPattern.test(remoteImage)) {
        item.image = remoteImage;
      } else if (localPattern.test(item.image || "") || dataPattern.test(item.image || "")) {
        targets.push({ index, item, source: item.image });
      }
    }
    let cursor = 0;
    let completed = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor];
        cursor += 1;
        output[target.index].image = await uploadLocalImage(target.item, target.source);
        completed += 1;
        if (completed === targets.length || completed % 12 === 0) {
          toast(`照片上云 ${completed}/${targets.length}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));
    return output;
  }

  const conflictFieldLabels = {
    model: "型号",
    category: "类别",
    stock: "库存",
    showroomQuantity: "展厅数量",
    computedTotalSold: "累计售出",
    totalSold: "累计售出",
    cost: "成本",
    sellingPrice: "售价",
    specification: "规格",
    arrival: "到货",
    showroom: "展厅",
    outbound: "出货",
    image: "照片",
    _deleteProduct: "删除产品",
  };

  function requestSyncConflictChoice(conflict, index, total) {
    const dialog = el.syncConflictDialog;
    if (!dialog || typeof dialog.showModal !== "function") {
      throw new Error("同步冲突窗口无法打开");
    }
    el.syncConflictProgress.textContent = `冲突 ${index + 1} / ${total}`;
    el.syncConflictModel.textContent = conflict.model || conflict.itemId;
    el.syncConflictField.textContent = conflictFieldLabels[conflict.field] || conflict.field;
    el.syncConflictExcel.textContent = conflict.excel;
    el.syncConflictCloud.textContent = conflict.cloud;
    dialog.returnValue = "";
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => {
        const choice = ["keep-excel", "keep-cloud"].includes(dialog.returnValue)
          ? dialog.returnValue
          : null;
        resolve(choice);
      }, { once: true });
    });
  }

  async function resolvePendingSyncConflicts() {
    if (!window.TekStockCloud?.listSyncConflicts
        || !window.TekStockCloud?.resolveSyncConflict
        || !conflictResolutionCore?.collectConflictResolutions) return false;
    const groups = await window.TekStockCloud.listSyncConflicts();
    if (!Array.isArray(groups) || !groups.length) return false;
    for (const group of groups) {
      if (group.unresolvable || !Array.isArray(group.conflicts) || !group.conflicts.length) {
        toast("此同步冲突无法安全自动处理；Excel 与云端均未改动");
        return false;
      }
      const resolutions = await conflictResolutionCore.collectConflictResolutions(
        group.conflicts,
        (conflict, index) => requestSyncConflictChoice(conflict, index, group.conflicts.length),
      );
      if (!resolutions) return false;
      const result = await window.TekStockCloud.resolveSyncConflict({
        opId: group.opId,
        resolutions,
      });
      if (!result?.ok) {
        const code = String(result?.errorCode || "SYNC_RESOLUTION_FAILED");
        throw Object.assign(new Error(code), { code });
      }
      if (!result.workbookReplaced) {
        toast("云端冲突已处理；Excel 已有新改动，因此未覆盖本地文件");
        return false;
      }
    }
    await loadRemoteData(false);
    return true;
  }

  function requestWorkbookIdentityManifest(plan) {
    const dialog = el.identityMigrationDialog;
    if (!dialog || typeof dialog.showModal !== "function") {
      throw new Error("旧 Excel 行连接窗口无法打开");
    }
    el.identityMigrationRows.replaceChildren();
    let unresolved = 0;
    for (const row of plan.rows || []) {
      const wrapper = document.createElement("label");
      wrapper.className = "identity-migration-row";
      const description = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = `Excel 第 ${row.sourceRow} 行 · ${row.model || "未命名"}`;
      const detail = document.createElement("small");
      detail.textContent = [row.category, row.specification].filter(Boolean).join(" · ") || "无分类/规格";
      description.append(title, detail);
      const select = document.createElement("select");
      select.dataset.sourceRow = String(row.sourceRow);
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "请选择安全处理方式";
      select.append(placeholder);
      for (const candidate of row.candidates || []) {
        const option = document.createElement("option");
        option.value = String(candidate.id || "");
        option.dataset.action = "bind";
        option.textContent = [candidate.model, candidate.category, candidate.specification]
          .filter(Boolean).join(" · ");
        select.append(option);
      }
      if (row.newItemId) {
        const createOption = document.createElement("option");
        createOption.value = String(row.newItemId);
        createOption.dataset.action = "create";
        createOption.textContent = `这是新产品：${row.model || "未命名"}（建立新永久 ID）`;
        select.append(createOption);
      } else if (!row.candidates?.length) {
        unresolved += 1;
      }
      wrapper.append(description, select);
      el.identityMigrationRows.append(wrapper);
    }
    el.identityMigrationWarning.hidden = unresolved === 0;
    el.identityMigrationWarning.textContent = unresolved
      ? `${unresolved} 行没有唯一候选；资料保持不变，请先联系管理员处理。`
      : "每个选择都必须由您确认；APP 不会按型号或行号自动猜测。";
    el.identityMigrationApply.disabled = unresolved > 0 || !(plan.rows || []).length;
    dialog.returnValue = "cancel";
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => {
        if (dialog.returnValue !== "apply") return resolve(null);
        const selects = [...el.identityMigrationRows.querySelectorAll("select[data-source-row]")];
        if (selects.some((select) => !select.value)) return resolve(null);
        resolve({
          workbookSha256: plan.workbookSha256,
          cloudRevision: plan.cloudRevision,
          workbookId: plan.workbookId,
          schemaVersion: plan.schemaVersion,
          migrationVersion: plan.migrationVersion,
          planToken: plan.planToken,
          choices: selects.map((select) => {
            const selected = select.options[select.selectedIndex];
            return {
              sourceRow: Number(select.dataset.sourceRow),
              itemId: select.value,
              action: selected?.dataset?.action || "bind",
            };
          }),
        });
      }, { once: true });
    });
  }

  async function resolveWorkbookIdentityMigration(error) {
    if (!/WORKBOOK_IDENTITY_MIGRATION_REQUIRED/i.test(String(error?.code || error?.message || ""))) {
      return false;
    }
    if (!window.TekStockCloud?.identityMigrationPlan
        || !window.TekStockCloud?.applyIdentityMigration) return false;
    const plan = await window.TekStockCloud.identityMigrationPlan();
    if (plan?.reviewRequired) {
      const reviewError = new Error("WORKBOOK_MIGRATION_REVIEW_REQUIRED");
      reviewError.code = "WORKBOOK_MIGRATION_REVIEW_REQUIRED";
      reviewError.currentItemCount = Number(plan.review?.currentItemCount);
      reviewError.acknowledgedItemCount = Number(plan.review?.acknowledgedItemCount);
      reviewError.baselineRecordCount = Number(plan.review?.baselineRecordCount);
      throw reviewError;
    }
    if (!plan?.ok || !Array.isArray(plan.rows) || !plan.rows.length) return false;
    const manifest = await requestWorkbookIdentityManifest(plan);
    if (!manifest) return false;
    const result = await window.TekStockCloud.applyIdentityMigration(manifest);
    if (!result?.ok || result?.sync?.workbookAcknowledged !== true) {
      const code = result?.sync?.errorCode || "WORKBOOK_MIGRATION_SYNC_FAILED";
      throw Object.assign(new Error(code), { code });
    }
    await loadRemoteData(false);
    return true;
  }

  function requestDesktopUploadToken() {
    const dialog = document.getElementById("syncTokenDialog");
    const input = document.getElementById("syncTokenInput");
    if (!dialog || !input || typeof dialog.showModal !== "function") {
      throw new Error("同步密钥窗口无法打开");
    }
    input.value = "";
    dialog.returnValue = "cancel";
    dialog.showModal();
    setTimeout(() => input.focus(), 0);
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => {
        const token = dialog.returnValue === "confirm" ? String(input.value || "").trim() : "";
        input.value = "";
        resolve(token);
      }, { once: true });
    });
  }

  async function ensureDesktopUploadToken(options = {}) {
    const forcePrompt = options.forcePrompt === true;
    const allowPrompt = options.allowPrompt !== false;
    if (!forcePrompt && remoteConfig.uploadToken) return true;
    if (!forcePrompt && window.TekStockRuntime?.getSecrets) {
      try {
        const refreshedSecrets = await window.TekStockRuntime.getSecrets();
        const refreshedToken = String(refreshedSecrets?.uploadToken || "").trim();
        if (refreshedToken && refreshedToken !== rejectedUploadToken) {
          Object.assign(remoteConfig, refreshedSecrets, { uploadToken: refreshedToken });
          return true;
        }
      } catch (error) {
        console.error(error);
      }
    }
    if (!allowPrompt || !window.TekStockRuntime?.saveUploadToken) return false;
    let token = "";
    try {
      token = await requestDesktopUploadToken();
    } catch (error) {
      console.error(error);
      toast("同步密钥暂时无法读取，APP 将自动重试");
      return false;
    }
    if (!String(token || "").trim()) {
      toast("未设置同步密钥，资料只保存在本机");
      return false;
    }
    try {
      const result = await window.TekStockRuntime.saveUploadToken(String(token).trim());
      if (!result?.ok) throw new Error(result?.error || "同步密钥保存失败");
      remoteConfig.uploadToken = String(token).trim();
      rejectedUploadToken = "";
      toast("同步密钥已安全保存");
      return true;
    } catch (error) {
      console.error(error);
      toast(error.message || "同步密钥保存失败");
      return false;
    }
  }

  function isUploadTokenRejection(error) {
    const detail = [error?.code, error?.name, error?.message]
      .filter(Boolean)
      .join(" ");
    return /(?:SYNC_TOKEN_MISSING|UNAUTHORIZED|HTTP(?:_|[ -])?401)/i.test(detail);
  }

  async function clearRejectedDesktopUploadToken() {
    rejectedUploadToken = String(remoteConfig.uploadToken || "").trim() || rejectedUploadToken;
    remoteConfig.uploadToken = "";
    if (!window.TekStockRuntime?.clearUploadToken) return;
    try {
      await window.TekStockRuntime.clearUploadToken();
    } catch (error) {
      console.error(error);
    }
  }

  async function recoverRejectedUploadToken(allowMergeRetry, options = {}) {
    await clearRejectedDesktopUploadToken();
    if (options.authRetry === true) {
      toast("同步密钥仍不正确，请按 Update 重新输入");
      return false;
    }
    if (options.automatic === true) {
      // Background retries must not repeatedly interrupt the user.
      return false;
    }
    toast("同步密钥无效，请重新输入");
    if (await ensureDesktopUploadToken({ forcePrompt: true, allowPrompt: true })) {
      return uploadInventoryData(allowMergeRetry, { ...options, authRetry: true });
    }
    return false;
  }

  async function syncWorkbookWithTokenRetry(authRetry = false) {
    try {
      return await window.TekStockCloud.syncWorkbook();
    } catch (error) {
      if (!isUploadTokenRejection(error)) throw error;
      await clearRejectedDesktopUploadToken();
      if (authRetry) {
        const friendlyError = new Error("同步密钥仍不正确，请重新输入后重试");
        friendlyError.code = "UNAUTHORIZED";
        throw friendlyError;
      }
      toast("同步密钥无效，请重新输入");
      if (!(await ensureDesktopUploadToken({ forcePrompt: true, allowPrompt: true }))) return null;
      return syncWorkbookWithTokenRetry(true);
    }
  }

  function workbookSyncFailureMessage(error) {
    const message = String(error?.code || error?.message || "").trim();
    if (isUploadTokenRejection(error)) return "同步密钥仍不正确，请重新输入后重试";
    if (/WORKBOOK_ID_CONFLICT/i.test(message)) {
      const duplicate = Array.isArray(error?.conflicts)
        ? error.conflicts.find((conflict) => conflict?.reason === "duplicate-id") : null;
      const sourceRows = Array.isArray(duplicate?.sourceRows)
        ? duplicate.sourceRows.filter((row) => Number.isSafeInteger(Number(row)) && Number(row) > 0)
        : [];
      if (sourceRows.length) {
        return `Excel 第 ${sourceRows.join("、")} 行使用了同一个永久产品 ID；云端未修改。请保留原产品行，把新增产品放在资料末尾后重试。`;
      }
      return "Excel 存在重复或无效的永久产品 ID；云端未修改。请不要复制整行，新增产品请放在资料末尾。";
    }
    if (/WORKBOOK_MIGRATION_REVIEW_REQUIRED/i.test(message)) {
      const current = Number(error?.currentItemCount);
      const acknowledged = Number(error?.acknowledgedItemCount);
      const counts = Number.isSafeInteger(current) && Number.isSafeInteger(acknowledged)
        ? `当前 ${current} 行、已确认基线 ${acknowledged} 行；` : "";
      return `Excel 行数与已确认基线不一致，${counts}已暂停迁移。请先审查，不会自动补删库存。`;
    }
    if (/WORKBOOK_IDENTITY_MIGRATION_REQUIRED/i.test(message)) {
      return "Excel 存在需要人工确认的旧身份行；资料尚未写入，请逐行确认对应云端产品。";
    }
    if (/WORKBOOK_ID_ASSIGNMENT_NOT_ACKNOWLEDGED/i.test(message)) {
      return "Excel 永久 ID 写入后无法验证；云端未修改。请保存 Excel 后重试。";
    }
    if (/WORKBOOK_(?:CONTENT_CHANGED|MIGRATION_CLOUD_CHANGED)/i.test(message)) {
      return "确认期间 Excel 或云端已有新修改；未写入，请重新按 Update。";
    }
    if (/WORKBOOK_LEGACY_ROW_AMBIGUOUS/i.test(message)) {
      return "Excel 有无法安全识别的旧行，未上传也未覆盖；请把新产品加在资料末尾后重试";
    }
    if (/EXCEL_IDENTITY_DUPLICATE_REVIEW|CLOUD_IDENTITY_DUPLICATE_REVIEW/i.test(message)) {
      return "线上或线下存在重复身份键，未合并也未相加；请先人工审查。";
    }
    if (/Error invoking remote method/i.test(message)) return "Excel 云端同步失败，请稍后重试";
    if (error?.traceId) return `${message || "Excel 云端同步失败"}（Trace ${error.traceId}）`;
    return message || "Excel 云端同步失败，请稍后重试";
  }

  function centralMutationPlan() {
    const operations = [];
    const photos = [];
    const byId = new Map(baseItems.map((item) => [String(item.id || ""), item]));
    for (const [itemId, source] of Object.entries(localEdits)) {
      const patch = { ...(source || {}) };
      if (!itemId) throw new Error("PERMANENT_ID_REQUIRED");
      if (patch._deleteProduct) {
        operations.push({ type: "delete", itemId });
        continue;
      }
      if (/^data:image\//i.test(patch.image || "")) {
        const baseline = byId.get(itemId) || {};
        photos.push({
          itemId,
          dataUrl: patch.image,
          imageSha256: String(baseline.imageSha256 || ""),
          imageVersion: String(baseline.imageVersion || ""),
        });
      }
      const isNew = patch._newProduct === true;
      Object.keys(patch).forEach((key) => {
        if (key.startsWith("_") || key === "image") delete patch[key];
      });
      if (isNew) {
        const item = { ...(byId.get(itemId) || {}), ...patch, id: itemId };
        if (!/^https:\/\//i.test(item.image || "")) {
          delete item.image;
          delete item.imageSha256;
          delete item.imageVersion;
        }
        operations.push({ type: "create", itemId, item });
      } else if (Object.keys(patch).length) {
        operations.push({ type: "update", itemId, patch });
      }
    }
    return { operations, photos };
  }

  async function uploadInventoryData(allowMergeRetry = true, options = {}) {
    if (remoteConfig.readOnly) {
      await loadRemoteData(true);
      return false;
    }
    if (window.TekStockCloud?.mutate) {
      if (!(await ensureDesktopUploadToken({ allowPrompt: options.automatic !== true }))) return false;
      const plan = centralMutationPlan();
      if (!plan.operations.length && !plan.photos.length) return true;
      try {
        let result = plan.operations.length
          ? await window.TekStockCloud.mutate(plan.operations)
          : await window.TekStockCloud.snapshot();
        for (const photo of plan.photos) {
          await window.TekStockCloud.replacePhoto(photo.itemId, photo.dataUrl, {
            imageSha256: photo.imageSha256,
            imageVersion: photo.imageVersion,
          });
        }
        clearSyncedLocalEdits(result.revision, result.updatedAt);
        await loadRemoteData(false);
        excelUploadPending = false;
        const excelUpdated = options.excelSource
          ? await acknowledgeExcelFromApp(false, {
            ...excelSyncPayload(), ackPlan: options.ackPlan || { rows: [] },
          })
          : await syncExcelFromApp(false);
        toast(excelUpdated ? "资料已同步到所有设备" : "云端已同步，Excel 未确认，请按 Update 重试");
        return true;
      } catch (error) {
        if (/SYNC_TOKEN_MISSING|UNAUTHORIZED/.test(String(error?.message || ""))
            && options.authRetry !== true) {
          return recoverRejectedUploadToken(allowMergeRetry, { ...options, authRetry: true });
        }
        console.error(error);
        toast(options.excelSource
          ? "云端同步失败，Excel 修改已保留，请按 Update 重试"
          : "云端同步失败，修改已保留并会自动重试");
        return false;
      }
    }
    toast("Alibaba 中央资料服务尚未连接");
    return false;
    if (!remoteConfig.uploadUrl) {
      await loadRemoteData(true);
      return false;
    }
    if (!(await ensureDesktopUploadToken({ allowPrompt: options.automatic !== true }))) return false;
    const diagnosticStartedAt = performance.now();
    reportDiagnostic("sync_started", {
      status: "started",
      phase: options.excelSource ? "excel_upload" : "cloud_upload",
      revision: lastRemoteRevision,
      itemCount: baseItems.length,
    });
    const uploadPayload = exportUploadPayload();
    try {
      if (remoteConfig.dataUrl) {
        const suffix = remoteConfig.dataUrl.includes("?") ? "&" : "?";
        const currentResponse = await fetch(
          `${remoteConfig.dataUrl}${suffix}t=${Date.now()}`,
          { cache: "no-store" },
        );
        if (!currentResponse.ok) throw new Error(`HTTP ${currentResponse.status}`);
        const currentPayload = await currentResponse.json();
        const currentRevision = Number(currentPayload.revision) || 0;
        const currentItemCount = Array.isArray(currentPayload.items) ? currentPayload.items.length : 0;
        if (Number(uploadPayload.baseRevision) !== currentRevision) {
          if (options.excelSource) {
            if (allowMergeRetry && options.excelWorkbook) {
              const currentUpdatedAt = Date.parse(currentPayload.updatedAt || "") || Date.now();
              const rebased = stageExcelWorkbookMerge(
                options.excelWorkbook,
                currentPayload.items,
                currentRevision,
                currentUpdatedAt,
              );
              if (rebased.ok) {
                cloudDataState = "live";
                lastRemoteImageSetVersion = String(currentPayload.imageSetVersion || "");
                hasCachedCloudPayload = saveCachedCloudPayload(currentPayload)
                  || hasCachedCloudPayload;
                updateCloudVersionBadge();
                return uploadInventoryData(false, {
                  ...options,
                  ackPlan: rebased.ackPlan,
                });
              }
            }
            reportDiagnostic("sync_failed", {
              status: "conflict",
              phase: "excel_upload",
              errorCode: "EXCEL_CLOUD_REVISION_CONFLICT",
              revision: currentRevision,
              itemCount: baseItems.length,
            }, true);
            await loadRemoteData(false);
            toast("Excel 已保留，但云端在上传前已有更新；请重新核对后再试");
            return false;
          }
          if (allowMergeRetry) {
            await loadRemoteData(false);
            return uploadInventoryData(false, options);
          }
          toast("云端刚有新修改，请再按一次 Update");
          return false;
        }
        const deletionBaselineIsCurrent = Object.values(localEdits).every((patch) =>
          !patch?._deleteProduct
          || (Number(patch._deleteBaselineRevision) === currentRevision
            && Number(patch._deleteBaselineItemCount) === currentItemCount));
        if (!deletionBaselineIsCurrent) {
          await loadRemoteData(false);
          if (allowMergeRetry) return uploadInventoryData(false, options);
          toast("删除基准已过期，已恢复最新云端资料");
          return false;
        }
        const remoteImages = new Map(
          (currentPayload.items || []).map((item) => [item.id, item.image || ""]),
        );
        const remoteImageSetVersion = String(currentPayload.imageSetVersion || "");
        uploadPayload.items = uploadPayload.items.map((item) => ({
          ...item,
          image: approvedImage(
            item.id,
            localEdits[item.id]?.image
              || (remoteImageSetVersion === imageVersion ? remoteImages.get(item.id) : packagedImages.get(item.id))
              || item.image
              || "",
          ),
        }));
        try {
          uploadPayload.items = await publishLocalImages(
            uploadPayload.items,
            remoteImages,
            remoteImageSetVersion,
          );
        } catch (error) {
          if (diagnosticErrorCode(error) === "HTTP_401") {
            return recoverRejectedUploadToken(allowMergeRetry, options);
          }
          throw error;
        }
      }
      const response = await fetch(remoteConfig.uploadUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-upload-token": remoteConfig.uploadToken },
        body: JSON.stringify(uploadPayload),
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        return recoverRejectedUploadToken(allowMergeRetry, options);
      }
      if (response.status === 409) {
        if (options.excelSource) {
          if (allowMergeRetry && options.excelWorkbook) {
            const refreshed = await loadRemoteData(false);
            if (refreshed) {
              const rebased = stageExcelWorkbookMerge(
                options.excelWorkbook,
                lastRemoteItems,
                lastRemoteRevision,
                lastRemoteUpdatedAt,
              );
              if (rebased.ok) {
                return uploadInventoryData(false, {
                  ...options,
                  ackPlan: rebased.ackPlan,
                });
              }
            }
          }
          reportDiagnostic("sync_failed", {
            status: "conflict",
            phase: "excel_upload",
            errorCode: "EXCEL_CLOUD_HTTP_409",
            revision: lastRemoteRevision,
            itemCount: baseItems.length,
          }, true);
          await loadRemoteData(false);
          toast("Excel 已保留，但云端刚被其他电脑更新；本次没有上传");
          return false;
        }
        if (allowMergeRetry) {
          await loadRemoteData(false);
          return uploadInventoryData(false, options);
        }
        toast("云端刚有新修改，请再按一次 Update");
        return false;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const uploadedRevision = Number(result.revision) || 0;
      if (!uploadedRevision || !String(result.updatedAt || "")) {
        throw new Error("Cloud upload response did not include a confirmed revision");
      }
      const verified = await verifyCloudRoundTrip(uploadPayload.items, uploadedRevision);
      excelUploadPending = false;
      lastRemoteRevision = uploadedRevision;
      lastRemoteItemCount = Array.isArray(verified.payload.items)
        ? verified.payload.items.length
        : uploadPayload.items.length;
      updateCloudVersionBadge();
      lastRemoteUpdatedAt = Date.parse(verified.payload.updatedAt || result.updatedAt || "") || Date.now();
      lastRemoteImageSetVersion = String(verified.payload.imageSetVersion || imageVersion);
      lastRemoteFingerprint = verified.fingerprint;
      hasCachedCloudPayload = saveCachedCloudPayload(verified.payload) || hasCachedCloudPayload;
      const excelAcknowledgementPayload = options.excelSource
        ? { ...excelSyncPayload(), ackPlan: options.ackPlan || { rows: [] } }
        : null;
      clearSyncedLocalEdits(lastRemoteRevision, verified.payload.updatedAt || result.updatedAt);
      const excelUpdated = options.excelSource
        ? await acknowledgeExcelFromApp(false, excelAcknowledgementPayload)
        : await syncExcelFromApp(false);
      toast(excelUpdated
        ? "已同步到新加坡电脑和手机"
        : "云端与手机已同步，Excel 回写未确认，请按 Update 重试");
      reportDiagnostic("sync_succeeded", {
        status: "ok",
        phase: options.excelSource ? "excel_upload" : "cloud_upload",
        revision: lastRemoteRevision,
        itemCount: baseItems.length,
        fingerprint: verified.fingerprint,
        durationMs: performance.now() - diagnosticStartedAt,
      });
      return true;
    } catch (error) {
      console.error(error);
      reportDiagnostic("sync_failed", {
        status: "error",
        phase: options.excelSource ? "excel_upload" : "cloud_upload",
        errorCode: diagnosticErrorCode(error, "CLOUD_UPLOAD_FAILED"),
        revision: lastRemoteRevision,
        itemCount: baseItems.length,
        durationMs: performance.now() - diagnosticStartedAt,
      }, true);
      toast("云端同步失败，请重试");
      return false;
    }
  }

  async function importUploadedJson(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.items)) throw new Error("missing items");
      baseItems = data.items;
      localEdits = data.edits || {};
      saveLocalEdits();
      buildCategories();
      render();
      toast("Done");
    } catch (error) {
      console.error(error);
      toast("Done");
    }
  }

  function isSafeRemotePayload(payload) {
    return window.TekStockRemoteSafety?.isSafeRemotePayload(payload) === true;
  }

  async function loadRemoteData(showToast = false, options = {}) {
    if (!window.TekStockCloud?.snapshot) return false;
    const diagnosticStartedAt = performance.now();
    reportDiagnostic("refresh_started", {
      status: "started",
      phase: "cloud_download",
      revision: lastRemoteRevision,
      itemCount: baseItems.length,
    });
    try {
      const remotePayload = await window.TekStockCloud.snapshot();
      if (!remotePayload || !Array.isArray(remotePayload.items)) {
        throw new Error("CLOUD_SNAPSHOT_INVALID");
      }
      const identityAudit = excelSyncCore.mergeInventoryViews({
        onlineItems: remotePayload.items,
        offlineItems: [],
      });
      if (!identityAudit.ok) {
        throw Object.assign(new Error("CLOUD_IDENTITY_DUPLICATE_REVIEW"), {
          code: "CLOUD_IDENTITY_DUPLICATE_REVIEW",
          duplicateKeys: identityAudit.duplicateKeys,
        });
      }
      const incomingRevision = Number(remotePayload.revision) || 0;
      cloudLastErrorCode = "";
      const incomingItemCount = remotePayload.items.length;
      const incomingFingerprint = await cloudDataFingerprint(remotePayload.items);
      const unchangedRemoteSnapshot = remoteReadCore.isUnchangedSnapshot({
        skipRender: options.skipRenderWhenUnchanged === true,
        cloudState: cloudDataState,
        incomingRevision,
        currentRevision: lastRemoteRevision,
        incomingItemCount,
        currentItemCount: lastRemoteItemCount,
        incomingFingerprint,
        currentFingerprint: lastRemoteFingerprint,
        hasPendingEdits: hasPendingEdits(),
      });
      lastRemoteUpdatedAt = Date.parse(remotePayload.updatedAt || "") || 0;
      lastRemoteRevision = incomingRevision;
      lastRemoteItemCount = remotePayload.items.length;
      cloudDataState = remotePayload.cloudState === "cached" ? "cached" : "live";
      updateCloudVersionBadge();
      lastRemoteImageSetVersion = String(remotePayload.imageSetVersion || "");
      const remoteItems = remotePayload.items.map((item) => ({
        ...item,
        image: approvedImage(item.id, item.image),
      }));
      lastRemoteItems = remotePayload.items.map((item) => ({ ...item }));
      lastRemoteFingerprint = incomingFingerprint;
      hasCachedCloudPayload = saveCachedCloudPayload(remotePayload) || hasCachedCloudPayload;
      if (unchangedRemoteSnapshot) {
        reportDiagnostic("refresh_succeeded", {
          status: "ok",
          phase: "cloud_download",
          revision: lastRemoteRevision,
          itemCount: lastRemoteItemCount,
          durationMs: performance.now() - diagnosticStartedAt,
          rendered: false,
        });
        clearTimeout(cloudRetryTimer);
        cloudRetryTimer = null;
        return true;
      }
      sanitizePendingDeletions(lastRemoteRevision, remoteItems.length);
      baseItems = remoteItems;
      if (remoteConfig.readOnly) {
        localEdits = {};
        sessionPendingEdits = false;
        localStorage.removeItem(editStorageKey);
        syncState = {
          revision: lastRemoteRevision,
          updatedAt: String(remotePayload.updatedAt || ""),
          dirty: false,
        };
        saveSyncState();
      } else if (hasPendingEdits()) {
        applyLocalEdits();
        syncState.revision = lastRemoteRevision;
        syncState.updatedAt = String(remotePayload.updatedAt || "");
        syncState.dirty = true;
        saveSyncState();
      } else {
        clearSyncedLocalEdits(lastRemoteRevision, remotePayload.updatedAt);
      }
      baseItems.forEach((item) => {
        item.image = approvedImage(item.id, item.image);
      });
      buildCategories();
      render();
      if (showToast) {
        toast(hasPendingEdits()
          ? "云端已更新，本机尚有未上传修改"
          : `已更新至云端版本 ${lastRemoteRevision}`);
      }
      reportDiagnostic("refresh_succeeded", {
        status: "ok",
        phase: "cloud_download",
        revision: lastRemoteRevision,
        itemCount: baseItems.length,
        durationMs: performance.now() - diagnosticStartedAt,
      });
      clearTimeout(cloudRetryTimer);
      cloudRetryTimer = null;
      return true;
    } catch (error) {
      console.error(error);
      cloudLastErrorCode = diagnosticErrorCode(error, "CLOUD_DOWNLOAD_FAILED");
      cloudDataState = hasCachedCloudPayload ? "cached" : "offline";
      updateCloudVersionBadge();
      reportDiagnostic("refresh_failed", {
        status: "error",
        phase: "cloud_download",
        errorCode: diagnosticErrorCode(error, "CLOUD_DOWNLOAD_FAILED"),
        revision: lastRemoteRevision,
        itemCount: baseItems.length,
        durationMs: performance.now() - diagnosticStartedAt,
      }, true);
      if (showToast) {
        toast(hasCachedCloudPayload
          ? "网络更新失败，正在显示上次完整云端资料"
          : "网络更新失败，正在自动重试");
      }
      return false;
    }
  }

  function scheduleCloudRetry() {
    if (cloudRetryTimer) return;
    cloudRetryTimer = setTimeout(async () => {
      cloudRetryTimer = null;
      const loaded = await loadRemoteData(false, { skipRenderWhenUnchanged: true });
      if (loaded) {
        await initializeExcel();
      } else {
        scheduleCloudRetry();
      }
    }, 15000);
  }

  let automaticSyncActive = false;
  async function synchronizeCloudAutomatically() {
    if (automaticSyncActive) return false;
    automaticSyncActive = true;
    try {
      if (hasPendingEdits()) return uploadInventoryData(false, { automatic: true });
      const previousRevision = lastRemoteRevision;
      const loaded = await loadRemoteData(false, { skipRenderWhenUnchanged: true });
      if (loaded && window.TekStockExcel) {
        if (window.TekStockCloud?.syncWorkbook) {
          const synced = await syncWorkbookWithTokenRetry();
          if (synced?.retryRequired === true) {
            excelUploadPending = true;
            updateCloudVersionBadge();
            toast("请先保存 Excel，云端更新随后自动合并。");
          } else if (synced?.workbookAcknowledged === true) {
            excelUploadPending = false;
            updateCloudVersionBadge();
          }
        } else if (!excelUploadPending && lastRemoteRevision !== previousRevision) {
          await syncExcelFromApp(false);
        }
      }
      return loaded;
    } finally {
      automaticSyncActive = false;
    }
  }

  async function updateInventory() {
    const cloudLoaded = await loadRemoteData(true);
    if (!cloudLoaded || cloudDataState !== "live") {
      scheduleCloudRetry();
      toast(`云端未连接（${cloudLastErrorCode || "CLOUD_UNAVAILABLE"}），未读取 Excel，避免覆盖资料`);
      return false;
    }
    if (remoteConfig.readOnly) return false;
    if (window.TekStockCloud?.syncWorkbook) {
      try {
        if (!(await ensureDesktopUploadToken())) return false;
        if (window.TekStockExcel?.prepareUpdate) {
          const prepared = await window.TekStockExcel.prepareUpdate();
          if (!prepared?.ok) {
            const prepareError = new Error(prepared?.error || "请保存并关闭 Excel 后重试");
            prepareError.code = prepared?.errorCode || "EXCEL_PREPARE_FAILED";
            throw prepareError;
          }
        }
        const synced = await syncWorkbookWithTokenRetry();
        if (!synced) return false;
        await loadRemoteData(false);
        if (synced.workbookAcknowledged !== true) {
          const pendingError = new Error(synced.message || synced.errorCode || "WORKBOOK_REFRESH_PENDING");
          pendingError.code = synced.errorCode || "WORKBOOK_REFRESH_PENDING";
          pendingError.traceId = synced.traceId || "";
          pendingError.conflicts = Array.isArray(synced.conflicts) ? synced.conflicts : [];
          throw pendingError;
        }
        excelUploadPending = false;
        updateCloudVersionBadge();
        toast(synced.workbookReplaced
          ? `云端资料已刷新到 Excel（版本 ${synced.revision}）`
          : `资料和 Excel 已同步（云端版本 ${synced.revision}）`);
        return true;
      } catch (error) {
        console.error(error);
        try {
          if (await resolveWorkbookIdentityMigration(error)) {
            excelUploadPending = false;
            updateCloudVersionBadge();
            toast("旧 Excel 行已安全连接，Excel 与云端已验证同步");
            return true;
          }
        } catch (migrationError) {
          console.error(migrationError);
          renderDataSyncFailure(migrationError?.code || migrationError?.message || "WORKBOOK_MIGRATION_FAILED");
          toast(workbookSyncFailureMessage(migrationError));
          return false;
        }
        try {
          if (await resolvePendingSyncConflicts()) {
            excelUploadPending = false;
            updateCloudVersionBadge();
            toast("同步冲突已处理，Excel 与云端已更新");
            return true;
          }
        } catch (resolutionError) {
          console.error(resolutionError);
        }
        renderDataSyncFailure(error?.code || error?.message || "WORKBOOK_SYNC_FAILED");
        toast(workbookSyncFailureMessage(error));
        return false;
      }
    }
    toast("Alibaba 中央资料服务尚未连接");
    return false;
  }

  el.searchInput.addEventListener("input", () => {
    state.query = el.searchInput.value.trim();
    render();
  });
  el.clearSearch.addEventListener("click", () => {
    el.searchInput.value = "";
    state.query = "";
    render();
    el.searchInput.focus();
  });
  el.stockFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (button) selectFilter(button.dataset.filter);
  });
  el.sortControls?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort]");
    if (button) selectSort(button.dataset.sort);
  });
  document.querySelector(".summary-grid").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (button) selectFilter(button.dataset.filter);
  });
  el.categoryFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    if (button.dataset.category === allCategory) {
      state.selectedCategories = new Set();
    } else {
      state.selectedCategories = filterSortCore.toggleCategorySelection(
        state.selectedCategories,
        button.dataset.categoryLabel || button.dataset.category,
      );
    }
    buildCategories();
    render();
  });
  el.inventoryGrid.addEventListener("click", (event) => {
    const card = event.target.closest(".inventory-card");
    if (!card) return;
    const item = baseItems.find((candidate) => candidate.id === card.dataset.id);
    if (!item) return;
    openDetail(item);
  });
  el.loadMoreButton.hidden = true;
  el.dialogClose.addEventListener("click", () => el.detailDialog.close());
  el.detailDialog.addEventListener("click", (event) => {
    if (event.target === el.detailDialog) el.detailDialog.close();
  });
  if (el.detailImage) {
    el.detailImage.addEventListener("error", hideBrokenDetailImage);
    el.detailImage.addEventListener("click", openImagePreview);
  }
  if (el.imagePreviewClose) el.imagePreviewClose.addEventListener("click", () => el.imagePreviewDialog.close());
  if (el.imagePreviewDialog) el.imagePreviewDialog.addEventListener("click", (event) => {
    if (event.target === el.imagePreviewDialog) el.imagePreviewDialog.close();
  });
  if (el.saveDetailButton) el.saveDetailButton.addEventListener("click", saveActiveDetail);
  if (el.detailOutbound) el.detailOutbound.addEventListener("input", previewOutboundDelta);
  if (el.resetDetailButton) el.resetDetailButton.addEventListener("click", resetActiveDetail);
  if (el.changePhotoButton) el.changePhotoButton.addEventListener("click", () => el.detailPhotoInput.click());
  if (el.detailPhotoInput) el.detailPhotoInput.addEventListener("change", () => {
    const file = el.detailPhotoInput.files?.[0];
    if (file) replaceActivePhoto(file);
  });
  if (el.feedbackButton) el.feedbackButton.addEventListener("click", openFeedback);
  if (el.feedbackClose) el.feedbackClose.addEventListener("click", () => el.feedbackDialog.close());
  if (el.feedbackDialog) el.feedbackDialog.addEventListener("click", (event) => {
    if (event.target === el.feedbackDialog) el.feedbackDialog.close();
  });
  if (el.feedbackScreenshot) el.feedbackScreenshot.addEventListener("change", async () => {
    const file = el.feedbackScreenshot.files?.[0];
    if (!file) return;
    try {
      feedbackScreenshotData = await resizeFeedbackScreenshot(file);
      el.feedbackPreview.src = feedbackScreenshotData;
      el.feedbackPreview.hidden = false;
    } catch (error) {
      console.error(error);
      toast("截图读取失败");
    }
  });
  if (el.feedbackSubmit) el.feedbackSubmit.addEventListener("click", submitFeedback);
  if (el.exportButton) el.exportButton.addEventListener("click", openLiveExcel);
  if (el.resetLocalButton) el.resetLocalButton.addEventListener("click", openCloudResetLocal);
  if (el.reinstallButton) el.reinstallButton.addEventListener("click", reinstallLatestDesktop);
  if (el.uploadButton) el.uploadButton.addEventListener("click", handleUpdateClick);
  el.uploadInput.addEventListener("change", () => {
    const file = el.uploadInput.files?.[0];
    if (file) importUploadedJson(file);
    el.uploadInput.value = "";
  });
  if (el.printButton) el.printButton.addEventListener("click", printInventory);
  el.helpButton.addEventListener("click", () => el.helpDialog.showModal());
  el.helpClose.addEventListener("click", () => el.helpDialog.close());
  el.helpDialog.addEventListener("click", (event) => {
    if (event.target === el.helpDialog) el.helpDialog.close();
  });
  if (remoteConfig.deploymentNote) {
    el.helpDataLocation.textContent = remoteConfig.dataUrl || remoteConfig.deploymentNote;
  }
  void refreshDesktopUpdateAlert();

  async function bootstrap() {
    if (window.InventoryAndroid?.getFeedbackToken) {
      remoteConfig.feedbackToken = window.InventoryAndroid.getFeedbackToken() || remoteConfig.feedbackToken || "";
    }
    if (window.TekStockRuntime?.getSecrets) {
      try {
        Object.assign(remoteConfig, await window.TekStockRuntime.getSecrets());
      } catch (error) {
        console.error(error);
      }
    }
    setDetailReadOnly(!!remoteConfig.readOnly);
    buildCategories();
    render();
    const cloudLoaded = await loadRemoteData();
    if (cloudLoaded) {
      try {
        await resolvePendingSyncConflicts();
      } catch (error) {
        console.error(error);
      }
    }
    if (cloudLoaded || cloudDataState === "cached") await initializeExcel();
    if (!cloudLoaded) scheduleCloudRetry();
    await uploadDailyDiagnostic();
    setInterval(synchronizeCloudAutomatically, 15000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void synchronizeCloudAutomatically();
    });
    setInterval(uploadDailyDiagnostic, 60 * 60 * 1000);
  }

  bootstrap();
})();


