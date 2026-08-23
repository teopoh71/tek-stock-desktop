"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.cjs"), "utf8");
const appSource = fs.readFileSync(path.join(root, "inventory", "app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "inventory", "index.html"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "preload.cjs"), "utf8");

test("desktop preserves a missing workbook baseline count as unknown", () => {
  assert.match(mainSource, /baselineItemCount\s*=\s*meta\.itemCount\s*===\s*undefined\s*\?\s*null\s*:\s*Number\(meta\.itemCount\)/);
  assert.match(mainSource, /itemCount:\s*Number\.isSafeInteger\(baselineItemCount\)\s*\?\s*baselineItemCount\s*:\s*null/);
  assert.doesNotMatch(mainSource, /itemCount:\s*Number\(meta\.itemCount\)\s*\|\|\s*0/);
});

test("Excel deletion checks compare workbook and live cloud item counts", () => {
  assert.match(appSource, /remoteSnapshotItemCount\s*=\s*lastRemoteItemCount\s*\|\|/);
  assert.match(appSource, /lastRemoteItemCount\s*=\s*remotePayload\.items\.length/);
  assert.match(appSource, /snapshotCanDelete\s*=\s*cloudDataState\s*===\s*"live"\s*&&\s*excelSyncCore\.canApplyWorkbookDeletions/);
  assert.match(appSource, /workbookExpectedItemCount:\s*Number\(result\.sync\?\.itemCount\)\s*\|\|\s*0/);
  assert.match(appSource, /remoteItemCount:\s*remoteSnapshotItemCount/);
  assert.match(appSource, /_deleteBaselineRevision:\s*lastRemoteRevision/);
  assert.match(appSource, /_deleteBaselineItemCount:\s*remoteSnapshotItemCount/);
});

test("desktop automatically retries local edits and refreshes remote revisions", () => {
  assert.match(appSource, /if\s*\(hasPendingEdits\(\)\)\s*return uploadInventoryData\(false,\s*\{\s*automatic:\s*true\s*\}\)/);
  assert.match(appSource, /setInterval\(synchronizeCloudAutomatically,\s*15000\)/);
  assert.match(appSource, /document\.addEventListener\("visibilitychange"/);
});

test("manual Update refreshes live cloud then finishes one central workbook sync", () => {
  assert.doesNotMatch(appSource, /Excel 修改尚未上传，请再按一次 Update/);
  const updateStart = appSource.indexOf("async function updateInventory()");
  const updateEnd = appSource.indexOf('el.searchInput.addEventListener("input"', updateStart);
  const updateSource = appSource.slice(updateStart, updateEnd);
  const refresh = updateSource.indexOf("const cloudLoaded = await loadRemoteData(true)");
  const sync = updateSource.indexOf("const synced = await syncWorkbookWithTokenRetry()", refresh);
  assert.ok(refresh >= 0);
  assert.ok(sync > refresh);
  assert.equal((updateSource.match(/const synced = await syncWorkbookWithTokenRetry\(\)/g) || []).length, 1);
});

test("a failed Excel data sync is not masked by the app-version updater", () => {
  assert.match(
    appSource,
    /async function handleUpdateClick\(\)\s*\{\s*const dataSynchronized = await updateInventory\(\);\s*if \(!dataSynchronized\) return false;\s*return applyNewerDesktopUpdate\(\);\s*\}/,
  );
  assert.match(appSource, /function renderDataSyncFailure\(errorCode\)/);
  assert.match(appSource, /Excel sync failed/);
  assert.match(appSource, /renderDataSyncFailure\(error\?\.code \|\| error\?\.message \|\| "WORKBOOK_SYNC_FAILED"\)/);
});

test("background authentication retries stay quiet", () => {
  assert.doesNotMatch(appSource, /options\.automatic\s*===\s*true\)\s*\{\s*toast\(/);
});

test("status messages remain readable", () => {
  assert.match(appSource, /setTimeout\(\(\)\s*=>\s*el\.toast\.classList\.remove\("show"\),\s*6000\)/);
});

test("filtering and sorting only change the displayed copy", () => {
  assert.match(
    appSource,
    /const filtered = filteredItems\(\);\s*const list = state\.sortDirection === "none"\s*\? filtered\s*:\s*filterSortCore\.sortItems\(filtered, state\.sortDirection/,
  );
  assert.match(appSource, /selectedCategories: state\.selectedCategories/);
  assert.doesNotMatch(appSource, /baseItems\s*=\s*filterSortCore\.sortItems/);
});

test("automatic synchronization does not redraw unchanged inventory", () => {
  assert.match(
    appSource,
    /async function synchronizeCloudAutomatically\(\)[\s\S]*?loadRemoteData\(false,\s*\{\s*skipRenderWhenUnchanged:\s*true\s*\}\)/
  );
  assert.match(
    appSource,
    /unchangedRemoteSnapshot[\s\S]*?rendered:\s*false[\s\S]*?return true;/
  );
});

test("an immediately unacknowledged Excel creation can safely recover by exact source row", () => {
  assert.match(appSource, /lastRemoteRevision\s*===\s*workbookRevision\s*\+\s*1/);
  assert.match(
    appSource,
    /remoteSnapshotItemCount\s*===\s*workbookExpectedItemCount\s*\+\s*generatedRowsWithoutBaseline/
  );
  assert.match(appSource, /recoverUnacknowledgedCreation[\s\S]*?sameSourceRow/);
  assert.match(
    appSource,
    /recoverUnacknowledgedCreation\s*\?\s*item\s*:\s*row\._baseline/
  );
});

test("an invalid upload token is replaced securely and retried once", () => {
  assert.match(mainSource, /uploadToken:\s*readStoredUploadToken\(\)\s*\|\|\s*readUserEnvironmentSecret\("TEK_STOCK_UPLOAD_TOKEN"\)/);
  assert.match(
    appSource,
    /async function ensureDesktopUploadToken\(options = \{\}\)[\s\S]*?if\s*\(!forcePrompt && window\.TekStockRuntime\?\.getSecrets\)[\s\S]*?await window\.TekStockRuntime\.getSecrets\(\)[\s\S]*?if\s*\(refreshedToken && refreshedToken !== rejectedUploadToken\)\s*\{[\s\S]*?return true;/,
  );
  assert.match(
    appSource,
    /function requestDesktopUploadToken\(\)[\s\S]*?dialog\.showModal\(\)[\s\S]*?input\.value = "";[\s\S]*?resolve\(token\)/,
  );
  assert.match(appSource, /token\s*=\s*await requestDesktopUploadToken\(\)/);
  assert.doesNotMatch(appSource, /window\.prompt\(/);
  assert.match(appSource, /async function recoverRejectedUploadToken[\s\S]*?options\.authRetry\s*===\s*true[\s\S]*?options\.automatic\s*===\s*true/);
  assert.match(appSource, /ensureDesktopUploadToken\(\{\s*forcePrompt:\s*true,\s*allowPrompt:\s*true\s*\}\)/);
  assert.match(appSource, /uploadInventoryData\(allowMergeRetry,\s*\{\s*\.\.\.options,\s*authRetry:\s*true\s*\}\)/);
  assert.match(appSource, /response\.status\s*===\s*401\)[\s\S]*?recoverRejectedUploadToken\(allowMergeRetry,\s*options\)/);
  assert.match(appSource, /Photo upload HTTP \$\{response\.status\}[\s\S]*?response\.status === 401[\s\S]*?error\.code = "HTTP_401"/);
  assert.match(appSource, /publishLocalImages\([\s\S]*?diagnosticErrorCode\(error\) === "HTTP_401"[\s\S]*?recoverRejectedUploadToken\(allowMergeRetry, options\)/);
  assert.match(mainSource, /function clearStoredUploadToken\(\)[\s\S]*?fs\.rmSync\(credentialsPath\(\),\s*\{\s*force:\s*true\s*\}\)/);
  assert.match(mainSource, /tek-stock-runtime-clear-upload-token/);
  assert.match(preloadSource, /clearUploadToken:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("tek-stock-runtime-clear-upload-token"\)/);
  assert.match(appSource, /rejectedUploadToken\s*=\s*String\(remoteConfig\.uploadToken/);
  assert.match(appSource, /refreshedToken\s*&&\s*refreshedToken\s*!==\s*rejectedUploadToken/);
  assert.match(appSource, /clearUploadToken\(\)/);
  assert.match(appSource, /ensureDesktopUploadToken\(\{\s*allowPrompt:\s*options\.automatic\s*!==\s*true\s*\}\)/);
});

test("an upload revalidates every deletion against the current cloud response", () => {
  assert.match(appSource, /const currentItemCount\s*=\s*Array\.isArray\(currentPayload\.items\)/);
  assert.match(appSource, /Number\(patch\._deleteBaselineRevision\)\s*===\s*currentRevision/);
  assert.match(appSource, /Number\(patch\._deleteBaselineItemCount\)\s*===\s*currentItemCount/);
  assert.match(appSource, /删除基准已过期，已恢复最新云端资料/);
});

test("restart-safe local edits remain pending until the central outbox confirms them", () => {
  assert.match(
    appSource,
    /let\s+sessionPendingEdits\s*=\s*false/,
  );
  assert.match(appSource, /function hasPendingEdits\(\)\s*\{\s*return !!syncState\.dirty/);
  assert.match(appSource, /function saveLocalEdits\(markDirty = true\)[\s\S]*?sessionPendingEdits\s*=\s*true/);
  assert.match(appSource, /function clearSyncedLocalEdits[\s\S]*?sessionPendingEdits\s*=\s*false/);
  assert.doesNotMatch(
    appSource,
    /if\s*\(cloudLoaded\s*&&\s*!remoteConfig\.readOnly\s*&&\s*hasPendingEdits\(\)\)\s*await uploadInventoryData\(\)/,
  );
  assert.doesNotMatch(appSource, /if\s*\(workbookWasEdited\s*\|\|\s*workbookRevision\s*===\s*0\)\s*\{\s*await importExcelData/);
  assert.match(
    appSource,
    /if\s*\(workbookWasEdited\s*\|\|\s*workbookRevision\s*===\s*0\)\s*\{[\s\S]*?excelUploadPending\s*=\s*true;[\s\S]*?updateCloudVersionBadge\(\);/,
  );
  assert.doesNotMatch(appSource, /scheduleExcelImportRetry|excelImportRetryTimer/);
  assert.match(appSource, /if\s*\(!cloudLoaded\)\s*scheduleCloudRetry\(\)/);
});

test("desktop distinguishes live, cached, and offline cloud state", () => {
  assert.match(appSource, /Cloud v\$\{lastRemoteRevision \|\| 0\} cache/);
  assert.match(appSource, /cloudDataState\s*=\s*hasCachedCloudPayload\s*\?\s*"cached"\s*:\s*"offline"/);
});

test("desktop uses the central Alibaba API bridge with no legacy runtime authority", () => {
  assert.match(indexSource, /deploymentNote:\s*"Alibaba Function Compute \+ Tablestore authority; OSS photos and installers"/);
  assert.doesNotMatch(indexSource, /workers\.dev|github/i);
  assert.match(preloadSource, /TekStockCloud/);
  assert.match(appSource, /window\.TekStockCloud\?\.snapshot/);
});
