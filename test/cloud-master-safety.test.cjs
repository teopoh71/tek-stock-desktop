"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "inventory", "app.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`async function ${name}()`);
  assert.notEqual(start, -1, `${name} must exist`);
  const openingBrace = source.indexOf("{", start);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is incomplete`);
}

function updateInventoryHarness(overrides = {}) {
  const calls = [];
  const dependencies = {
    remoteConfig: { readOnly: false },
    cloudDataState: "live",
    cloudLastErrorCode: "",
    loadRemoteData: async (showToast) => {
      calls.push(`cloud:${showToast}`);
      return true;
    },
    scheduleCloudRetry: () => calls.push("retry"),
    ensureDesktopUploadToken: async () => {
      calls.push("token");
      return true;
    },
    window: {
      TekStockCloud: { syncWorkbook: true },
      TekStockExcel: {
        prepareUpdate: async () => {
          calls.push("excel");
          return { ok: true };
        },
      },
    },
    syncWorkbookWithTokenRetry: async () => {
      calls.push("sync");
      return { revision: 147, workbookAcknowledged: true };
    },
    updateCloudVersionBadge: () => {},
    resolvePendingSyncConflicts: async () => false,
    renderDataSyncFailure: () => {},
    toast: () => {},
    workbookSyncFailureMessage: (error) => error.message,
    console: { error: () => {} },
    ...overrides,
  };
  const names = Object.keys(dependencies);
  const factory = Function(...names, `return (${extractFunction("updateInventory")});`);
  return { calls, run: factory(...Object.values(dependencies)) };
}

test("upload verifies revision and full data/photo fingerprint before clearing edits", () => {
  const verifyCall = source.indexOf("await verifyCloudRoundTrip(uploadPayload.items, uploadedRevision)");
  const clearCall = source.indexOf("clearSyncedLocalEdits(lastRemoteRevision", verifyCall);
  assert.ok(verifyCall > 0);
  assert.ok(clearCall > verifyCall);
  assert.match(source, /fields\s*=\s*\[[\s\S]*?"image"/);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/);
});

test("verified cloud payload becomes the persistent last-known-good cache", () => {
  assert.match(
    source,
    /hasCachedCloudPayload\s*=\s*saveCachedCloudPayload\(verified\.payload\)/,
  );
});

test("Update refreshes cloud before upload credentials and Excel mutation", async () => {
  const { calls, run } = updateInventoryHarness();
  await run();
  assert.deepEqual(calls, ["cloud:true", "token", "excel", "sync", "cloud:false"]);
});

test("Update retries and never touches credentials or Excel when cloud refresh fails", async () => {
  const { calls, run } = updateInventoryHarness({
    loadRemoteData: async (showToast) => {
      calls.push(`cloud:${showToast}`);
      return false;
    },
  });
  await run();
  assert.deepEqual(calls, ["cloud:true", "retry"]);
});

test("Update treats a cached snapshot as offline and never touches credentials or Excel", async () => {
  const { calls, run } = updateInventoryHarness({ cloudDataState: "cached" });
  await run();
  assert.deepEqual(calls, ["cloud:true", "retry"]);
});

test("automatic cloud refresh is not disabled while the app is in the background", () => {
  assert.doesNotMatch(
    source,
    /automaticSyncActive\s*\|\|\s*document\.visibilityState\s*!==\s*"visible"/,
  );
});

test("automatic polling runs central workbook pull with no local pending edits", async () => {
  const calls = [];
  const factory = Function("calls", `
    let automaticSyncActive = false;
    let lastRemoteRevision = 10;
    let excelUploadPending = true;
    const hasPendingEdits = () => false;
    const uploadInventoryData = async () => true;
    const loadRemoteData = async () => true;
    const window = { TekStockExcel: {}, TekStockCloud: { syncWorkbook: true } };
    const syncWorkbookWithTokenRetry = async () => { calls.push("central-sync"); return { retryRequired: true }; };
    const syncExcelFromApp = async () => { calls.push("legacy-write"); };
    const updateCloudVersionBadge = () => calls.push("badge");
    const toast = (message) => calls.push(message);
    return (${extractFunction("synchronizeCloudAutomatically")})();
  `);
  await factory(calls);
  assert.deepEqual(calls, [
    "central-sync",
    "badge",
    "请先保存 Excel，云端更新随后自动合并。",
  ]);
});

test("Excel import cannot claim cloud success when upload was not verified", () => {
  assert.match(source, /toast\(uploaded\s*===\s*true\s*\?/);
  assert.match(source, /Excel 已读取，但云端尚未确认更新，请重试/);
});

test("unconfirmed Excel data never remains visible as if it were cloud data", () => {
  assert.match(source, /function restoreConfirmedCloudViewAfterExcelFailure\(\)/);
  assert.match(source, /baseItems\s*=\s*lastRemoteItems\.map/);
  assert.match(source, /if\s*\(uploaded\s*!==\s*true\)\s*handleUnconfirmedExcelUpload\(\)/);
  assert.match(source, /Excel pending/);
});

test("a failed Excel upload stays pending without an automatic timer retry", () => {
  assert.match(source, /function handleUnconfirmedExcelUpload\(\)[\s\S]*?restoreConfirmedCloudViewAfterExcelFailure\(\)/);
  assert.doesNotMatch(source, /excelImportRetryTimer/);
  assert.doesNotMatch(source, /scheduleExcelImportRetry/);
  assert.doesNotMatch(source, /setTimeout\(\(\)\s*=>\s*(?:syncExcelFromApp|acknowledgeExcelFromApp|syncWorkbookWithTokenRetry)/);
});

test("an edited workbook from an older cloud revision fails closed and is preserved", () => {
  assert.match(
    source,
    /staleEditedWorkbook\s*=\s*!!lastRemoteRevision[\s\S]*?workbookRevision\s*<\s*lastRemoteRevision[\s\S]*?workbookWasEdited/,
  );
  assert.match(source, /errorCode:\s*"EXCEL_STALE_BASELINE_MISSING"/);
  assert.match(source, /preserved:\s*true/);
});

test("Excel updates use the complete workbook baseline and a pure three-way merge", () => {
  assert.match(source, /result\.baseline\?\.records/);
  assert.match(source, /excelSyncCore\.(?:threeWayWorkbookMerge|mergeWorkbookSnapshot)\(\{/);
  assert.match(source, /baselineRecords\s*=\s*result\?\.baseline\?\.records/);
  assert.match(source, /stageExcelWorkbookMerge\(\s*result,\s*lastRemoteItems/);
  assert.match(source, /EXCEL_THREE_WAY_CONFLICT/);
});

test("Excel cloud revision races rebase the unchanged workbook snapshot once", () => {
  assert.match(source, /options\.excelWorkbook/);
  assert.match(source, /stageExcelWorkbookMerge\(/);
  assert.match(
    source,
    /if\s*\(options\.excelSource\)\s*\{\s*if\s*\(allowMergeRetry\s*&&\s*options\.excelWorkbook\)/,
  );
});

test("Excel-source revision mismatch and HTTP 409 rebase at most once", () => {
  assert.match(
    source,
    /Number\(uploadPayload\.baseRevision\)\s*!==\s*currentRevision\)[\s\S]*?stageExcelWorkbookMerge\([\s\S]*?return uploadInventoryData\(false/,
  );
  assert.match(
    source,
    /response\.status\s*===\s*409[\s\S]*?stageExcelWorkbookMerge\([\s\S]*?return uploadInventoryData\(false/,
  );
});
