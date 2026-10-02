"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { mount } = require("../inventory/recovery-core.js");

const source = fs.readFileSync(path.join(__dirname, "..", "inventory", "app.js"), "utf8");

function recoveryElement() {
  return { children: [], dataset: {}, listeners: {}, setAttribute() {}, append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; }, addEventListener(name, handler) { this.listeners[name] = handler; } };
}
function createRecoveryUi() {
  return mount({ createElement: recoveryElement, body: recoveryElement() });
}

function extractFunction(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart < 0 ? source.indexOf(`function ${name}(`) : asyncStart;
  assert.notEqual(start, -1, `${name} must exist`);
  const openingBrace = source.indexOf(") {", start) + 2;
  assert.ok(openingBrace > start, `${name} must have a body`);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is incomplete`);
}

function manualUpdateHarness({ errorCode, tokenResult = true, retryResult = true }) {
  const calls = [];
  const factory = Function("calls", "errorCode", "tokenResult", "retryResult", "createRecoveryUi", `
    const remoteConfig = { readOnly: false };
    let cloudDataState = "cached";
    let cloudLastErrorCode = errorCode;
    let refreshes = 0;
    const loadRemoteData = async (showToast) => {
      calls.push(\`refresh:\${showToast}\`);
      refreshes += 1;
      if (refreshes === 1) return false;
      if (retryResult) { cloudDataState = "live"; cloudLastErrorCode = ""; }
      return retryResult;
    };
    ${extractFunction("isUploadTokenRejection")}
    const ensureDesktopUploadToken = async () => { calls.push("credential"); return tokenResult; };
    const scheduleCloudRetry = () => calls.push("retry");
    const recoveryUi = createRecoveryUi();
    ${extractFunction("showRecovery")}
    const toast = (message) => calls.push(\`toast:\${message}\`);
    const window = { TekStockCloud: { syncWorkbook: true }, TekStockExcel: {
      prepareUpdate: async () => { calls.push("excel"); return { ok: true }; },
    } };
    const syncWorkbookWithTokenRetry = async () => { calls.push("sync"); return { workbookAcknowledged: true, revision: 1 }; };
    const updateCloudVersionBadge = () => {};
    const resolveWorkbookIdentityMigration = async () => false;
    const resolvePendingSyncConflicts = async () => false;
    const renderDataSyncFailure = () => {};
    const workbookSyncFailureMessage = (error) => error.message;
    const console = { error: () => {} };
    return (${extractFunction("updateInventory")})();
  `);
  const recoveryUi = createRecoveryUi();
  const run = factory(calls, errorCode, tokenResult, retryResult, () => recoveryUi);
  return { calls, run, recoveryUi };
}

function cachedLoadHarness(offlineError, options = {}) {
  const calls = [];
  const snapshots = [
    { revision: 1, updatedAt: "2026-09-22T00:00:00.000Z", items: [{ id: "live", image: "" }], cloudState: "live" },
    { revision: 1, updatedAt: "2026-09-22T00:00:00.000Z", items: [{ id: "cached", image: "" }], cloudState: "cached", offlineError },
    { revision: 2, updatedAt: "2026-09-22T00:01:00.000Z", items: [{ id: "reconnected", image: "" }], cloudState: "live" },
  ];
  const factory = Function("calls", "snapshots", "createRecoveryUi", "options", `
    let snapshotReadCount = 0;
    const window = { TekStockCloud: { snapshot: async () => { snapshotReadCount += 1; return snapshots.shift(); } } };
    const performance = { now: () => 1 };
    let baseItems = [], lastRemoteRevision = 0, lastRemoteItemCount = 0, lastRemoteFingerprint = "", lastRemoteUpdatedAt = 0;
    let lastRemoteImageSetVersion = "", lastRemoteItems = [], cloudDataState = "offline", cloudLastErrorCode = "";
    let hasCachedCloudPayload = false, cloudRetryTimer = null, localEdits = {}, sessionPendingEdits = false;
    const remoteConfig = { readOnly: false }, syncState = {}, editStorageKey = "test";
    const localStorage = { removeItem: () => {} };
    const excelSyncCore = { mergeInventoryViews: () => ({ ok: true }) };
    const diagnosticErrorCode = (error, fallback) => /^[A-Z][A-Z0-9_]{2,63}$/.test(String(error?.code || "")) ? error.code : fallback;
    const cloudDataFingerprint = async (items) => items.map(item => item.id).join(",");
    const remoteReadCore = { isUnchangedSnapshot: () => snapshotReadCount === options.unchangedOnRead };
    const reportDiagnostic = (stage, value) => calls.push({ stage, value });
    const updateCloudVersionBadge = () => {};
    const approvedImage = (_id, image) => image;
    const saveCachedCloudPayload = () => true;
    const sanitizePendingDeletions = () => {};
    const hasPendingEdits = () => false;
    const clearSyncedLocalEdits = () => {};
    const buildCategories = () => {};
    const render = () => calls.push({ stage: "render" });
    const recoveryUi = createRecoveryUi();
    const showRecovery = (code, options = {}) => {
      calls.push({ stage: "recovery", code });
      recoveryUi.show({ errorCode: String(code), source: options.source || "" });
    };
    const toast = () => {};
    const saveSyncState = () => {};
    const applyLocalEdits = () => {};
    const clearTimeout = () => {};
    const console = { error: () => {} };
    const loadRemoteData = ${extractFunction("loadRemoteData").replace(/^async function loadRemoteData/, "async function")};
    return { run: async (count = 3) => { const results = []; for (let index = 0; index < count; index += 1) results.push(await loadRemoteData()); return results; }, state: () => ({ cloudDataState, cloudLastErrorCode, baseItems, recoveryHidden: recoveryUi.panel.hidden, recoveryCode: recoveryUi.panel.children[2].textContent }) };
  `);
  const recoveryUi = options.recoveryUi || createRecoveryUi();
  return { calls, recoveryUi, harness: factory(calls, snapshots, () => recoveryUi, options) };
}

function cachedBootstrapHarness() {
  const calls = [];
  const factory = Function("calls", `
    const window = {}, remoteConfig = { readOnly: false };
    const console = { error: () => {} };
    const setDetailReadOnly = () => {}, buildCategories = () => {}, render = () => {};
    let cloudDataState = "cached";
    const loadRemoteData = async () => { calls.push("load"); return false; };
    const resolvePendingSyncConflicts = async () => calls.push("conflicts");
    const initializeExcel = async () => calls.push("initialize-excel");
    const scheduleCloudRetry = () => calls.push("retry");
    const uploadDailyDiagnostic = async () => {};
    const synchronizeCloudAutomatically = async () => {};
    const document = { addEventListener: () => {}, visibilityState: "hidden" };
    const setInterval = () => {};
    const bootstrap = ${extractFunction("bootstrap").replace(/^async function bootstrap/, "async function")};
    return bootstrap;
  `);
  return { calls, run: factory(calls) };
}

test("manual Update prompts once for rejected cloud credentials then retries the live refresh", async () => {
  const { calls, run } = manualUpdateHarness({ errorCode: "UNAUTHORIZED" });
  assert.equal(await run, true);
  assert.deepEqual(calls, ["refresh:true", "credential", "refresh:true", "excel", "sync", "refresh:false", "toast:资料和 Excel 已同步（云端版本 1）"]);
});

test("a malformed saved key offers one reconnect and never reads Excel when cancelled", async () => {
  const cancelled = manualUpdateHarness({ errorCode: "SYNC_TOKEN_INVALID", tokenResult: false });
  assert.equal(await cancelled.run, false);
  assert.equal(cancelled.calls.filter(call => call === "credential").length, 1);
  assert.equal(cancelled.calls.includes("excel"), false);
  assert.equal(cancelled.calls.includes("sync"), false);

  const connected = manualUpdateHarness({ errorCode: "SYNC_TOKEN_INVALID" });
  assert.equal(await connected.run, true);
  assert.equal(connected.calls.filter(call => call === "credential").length, 1);
  assert.ok(connected.calls.indexOf("excel") > connected.calls.indexOf("credential"));
});

test("malformed-key upload follows credential recovery without acknowledging pending inventory", async () => {
  const calls = [];
  const factory = Function("calls", `
    const remoteConfig = { readOnly: false };
    const ensureDesktopUploadToken = async () => { calls.push("check-credential"); return true; };
    const centralMutationPlan = () => ({ operations: [{ type: "update", itemId: "synthetic" }], photos: [] });
    const window = { TekStockCloud: { mutate: async () => {
      throw Object.assign(new Error("SYNC_TOKEN_INVALID"), { code: "SYNC_TOKEN_INVALID" });
    } } };
    const clearRejectedDesktopUploadToken = async () => calls.push("clear-rejected-key");
    const clearSyncedLocalEdits = () => calls.push("clear-edits");
    const syncExcelFromApp = async () => calls.push("excel");
    const toast = () => {}, console = { error() {} };
    ${extractFunction("isUploadTokenRejection")}
    ${extractFunction("recoverRejectedUploadToken")}
    ${extractFunction("uploadInventoryData")}
    return uploadInventoryData();
  `);
  assert.equal(await factory(calls), false);
  assert.deepEqual(calls, ["check-credential", "clear-rejected-key"]);
});

test("manual Update leaves cached inventory untouched when credential entry is cancelled or retry fails", async () => {
  for (const fixture of [
    { name: "cancelled", tokenResult: false, retryResult: true },
    { name: "retry failed", tokenResult: true, retryResult: false },
  ]) {
    const { calls, run } = manualUpdateHarness({ errorCode: "SYNC_TOKEN_MISSING", ...fixture });
    assert.equal(await run, false, fixture.name);
    assert.equal(calls.filter((call) => call === "credential").length, 1, fixture.name);
    assert.equal(calls.includes("excel"), false, fixture.name);
    assert.equal(calls.includes("sync"), false, fixture.name);
  }
});

test("failed manual Update cloud read is cleared by a later live refresh", async () => {
  const { run, recoveryUi } = manualUpdateHarness({ errorCode: "API_REQUEST_TIMEOUT", retryResult: false });
  assert.equal(await run, false);
  assert.ok(recoveryUi.captureCloudReadFailure());
  const laterRefresh = cachedLoadHarness(undefined, { recoveryUi });
  assert.deepEqual(await laterRefresh.harness.run(1), [true]);
  assert.equal(recoveryUi.panel.hidden, true);
});

test("cached snapshots preserve their concrete error and never count as a successful live refresh", () => {
  const load = extractFunction("loadRemoteData");
  assert.match(load, /remotePayload\.cloudState\s*===\s*"cached"/);
  assert.match(load, /remotePayload\.offlineError/);
  assert.match(load, /refresh_cached/);
  assert.doesNotMatch(load, /cloudLastErrorCode\s*=\s*""[\s\S]*?cloudDataState\s*=\s*remotePayload\.cloudState\s*===\s*"cached"/);
});

test("automatic sync does not prompt or read Excel when the refresh is cached", () => {
  const automatic = extractFunction("synchronizeCloudAutomatically");
  assert.match(automatic, /if\s*\(!loaded\s*\|\|\s*cloudDataState\s*!==\s*"live"\)\s*return false/);
  assert.doesNotMatch(automatic, /ensureDesktopUploadToken\(/);
});

test("actual cloud loader clears a transient timeout after a later live reconnect", async () => {
  for (const options of [{}, { unchangedOnRead: 3 }]) {
    const offlineError = "API_REQUEST_TIMEOUT";
    const { calls, harness } = cachedLoadHarness(offlineError, options);
    assert.deepEqual(await harness.run(), [true, false, true], String(offlineError));
    assert.equal(harness.state().cloudDataState, "live", String(offlineError));
    assert.equal(harness.state().cloudLastErrorCode, "", String(offlineError));
    assert.equal(harness.state().recoveryHidden, true, String(offlineError));
    const cached = calls.find(entry => entry.stage === "refresh_cached");
    assert.equal(cached.value.errorCode, offlineError || "CLOUD_CACHE_UNAVAILABLE");
    assert.ok(calls.some(entry => entry.stage === "render"));
    assert.equal(calls.some(entry => entry.stage === "refresh_succeeded" && entry.value.revision === 1 && entry.value.itemCount === 1), true);
    if (options.unchangedOnRead === 3) {
      assert.ok(calls.some(entry => entry.stage === "refresh_succeeded" && entry.value.revision === 2 && entry.value.rendered === false));
    }
  }
});

test("cached data never clears a transient recovery card, but a later live read does", async () => {
  const { harness } = cachedLoadHarness("API_REQUEST_TIMEOUT");
  assert.deepEqual(await harness.run(2), [true, false]);
  assert.equal(harness.state().recoveryHidden, false);
  assert.deepEqual(await harness.run(1), [true]);
  assert.equal(harness.state().recoveryHidden, true);
});

test("live reconnect preserves auth, conflict, and unknown cached errors", async () => {
  for (const offlineError of ["UNAUTHORIZED", "WORKBOOK_MERGE_CONFLICT", undefined]) {
    const { harness } = cachedLoadHarness(offlineError);
    assert.deepEqual(await harness.run(), [true, false, true], String(offlineError));
    assert.equal(harness.state().recoveryHidden, false, String(offlineError));
    assert.match(harness.state().recoveryCode, new RegExp(offlineError || "CLOUD_CACHE_UNAVAILABLE"));
  }
});

test("actual bootstrap never initializes Excel from cached cloud data", async () => {
  const { calls, run } = cachedBootstrapHarness();
  await run();
  assert.deepEqual(calls, ["load", "retry"]);
});

test("actual automatic sync initializes Excel after a live reconnect before its workbook sync", async () => {
  const calls = [];
  const factory = Function("calls", `
    let automaticSyncActive = false, cloudDataState = "offline", excelInitialized = false;
    let lastRemoteRevision = 1, excelUploadPending = false;
    const hasPendingEdits = () => false;
    const uploadInventoryData = async () => { calls.push("upload"); return true; };
    const loadRemoteData = async () => { calls.push("refresh"); cloudDataState = "live"; return true; };
    const initializeExcel = async () => { calls.push("initialize"); excelInitialized = true; };
    const window = { TekStockExcel: {}, TekStockCloud: { syncWorkbook: true } };
    const syncWorkbookWithTokenRetry = async () => { calls.push("workbook-sync"); return { workbookAcknowledged: true }; };
    const updateCloudVersionBadge = () => {}, toast = () => {}, syncExcelFromApp = async () => {};
    return (${extractFunction("synchronizeCloudAutomatically")})();
  `);
  assert.equal(await factory(calls), true);
  assert.deepEqual(calls, ["refresh", "initialize", "workbook-sync"]);
});
