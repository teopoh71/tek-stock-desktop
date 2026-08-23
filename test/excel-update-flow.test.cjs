"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { prepareCanonicalWorkbookUpdateIpc } = require("../main.cjs");

const appSource = fs.readFileSync(
  path.join(__dirname, "..", "inventory", "app.js"),
  "utf8",
);
const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.cjs"), "utf8");

test("Excel-origin upload uses the fast acknowledgement path once", () => {
  assert.match(
    appSource,
    /uploadInventoryData\(true,\s*\{\s*excelSource:\s*true,\s*ackPlan\s*\}\)/,
  );
  assert.match(
    appSource,
    /options\.excelSource\s*\?\s*await acknowledgeExcelFromApp\(false,\s*excelAcknowledgementPayload\)\s*:\s*await syncExcelFromApp\(false\)/,
  );
  assert.doesNotMatch(
    appSource,
    /uploadInventoryData\(true,\s*\{\s*excelSource:\s*true\s*\}\);\s*await syncExcelFromApp/,
  );
});

test("successful Excel acknowledgement clears the pending cloud badge immediately", () => {
  assert.match(
    appSource,
    /if\s*\(!result\?\.ok\)[\s\S]*?excelUploadPending\s*=\s*false;[\s\S]*?updateCloudVersionBadge\(\);[\s\S]*?return true;/,
  );
});

test("Excel write and acknowledgement failures do not schedule timer retries", () => {
  assert.doesNotMatch(appSource, /excelWriteRetryTimer/);
  assert.doesNotMatch(appSource, /excelAckRetryTimer/);
  assert.doesNotMatch(
    appSource,
    /setTimeout\(\(\)\s*=>\s*(?:syncExcelFromApp|acknowledgeExcelFromApp|syncWorkbookWithTokenRetry)/,
  );
});

test("a new Excel model stays explicitly pending when acknowledgement fails", () => {
  assert.match(
    appSource,
    /async function acknowledgeExcelFromApp\([\s\S]*?catch \(error\) \{[\s\S]*?excelUploadPending\s*=\s*true;[\s\S]*?updateCloudVersionBadge\(\);/,
  );
  assert.match(
    appSource,
    /const excelUpdated = options\.excelSource[\s\S]*?acknowledgeExcelFromApp\([\s\S]*?toast\(excelUpdated \? "资料已同步到所有设备" : "云端已同步，Excel 未确认，请按 Update 重试"\)/,
  );
});

test("Update performs one central workbook sync then refreshes cloud", () => {
  const updateBody = appSource.match(
    /async function updateInventory\(\)\s*\{([\s\S]*?)\r?\n  \}\r?\n\r?\n  el\.searchInput/,
  )?.[1] || "";
  assert.equal((updateBody.match(/await syncWorkbookWithTokenRetry\(\)/g) || []).length, 1);
  assert.match(
    updateBody,
    /const synced = await syncWorkbookWithTokenRetry\(\);[\s\S]*?await loadRemoteData\(false\)/,
  );
  assert.doesNotMatch(updateBody, /importExcelData|excelImported/);
});

test("Update reports success only after the workbook matches confirmed cloud data", () => {
  const updateBody = appSource.match(
    /async function updateInventory\(\)\s*\{([\s\S]*?)\r?\n  \}\r?\n\r?\n  el\.searchInput/,
  )?.[1] || "";
  assert.match(updateBody, /if \(synced\.workbookAcknowledged !== true\)/);
  assert.match(updateBody, /WORKBOOK_REFRESH_PENDING/);
  assert.match(
    updateBody,
    /excelUploadPending\s*=\s*false;[\s\S]*?updateCloudVersionBadge\(\);[\s\S]*?toast\(synced\.workbookReplaced/,
  );
});

test("automatic cloud refresh uses guarded central sync while legacy writes remain pending-gated", () => {
  const automaticBody = appSource.match(
    /async function synchronizeCloudAutomatically\(\)\s*\{([\s\S]*?)\r?\n  \}\r?\n\r?\n  async function updateInventory/,
  )?.[1] || "";
  assert.match(
    automaticBody,
    /if\s*\(window\.TekStockCloud\?\.syncWorkbook\)[\s\S]*?await syncWorkbookWithTokenRetry\(\)/,
  );
  assert.match(
    automaticBody,
    /else if\s*\(!excelUploadPending && lastRemoteRevision !== previousRevision\)[\s\S]*?await syncExcelFromApp\(false\)/,
  );
});

test("manual workbook sync replaces a rejected stored token and retries only once", () => {
  const retryBody = appSource.match(
    /async function syncWorkbookWithTokenRetry\(authRetry = false\)\s*\{([\s\S]*?)\n  \}\n\n/,
  )?.[1] || "";
  assert.match(retryBody, /await window\.TekStockCloud\.syncWorkbook\(\)/);
  assert.match(retryBody, /isUploadTokenRejection\(error\)/);
  assert.match(retryBody, /await clearRejectedDesktopUploadToken\(\)/);
  assert.match(retryBody, /if\s*\(authRetry\)\s*\{[\s\S]*?throw friendlyError;/);
  assert.match(
    retryBody,
    /ensureDesktopUploadToken\(\{\s*forcePrompt:\s*true,\s*allowPrompt:\s*true\s*\}\)/,
  );
  assert.equal((retryBody.match(/syncWorkbookWithTokenRetry\(true\)/g) || []).length, 1);
});

test("manual workbook sync hides raw Electron IPC errors behind a friendly message", () => {
  assert.match(
    appSource,
    /function workbookSyncFailureMessage\(error\)[\s\S]*?Error invoking remote method[\s\S]*?Excel \u4e91\u7aef\u540c\u6b65\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5/,
  );
  assert.match(
    appSource,
    /const synced = await syncWorkbookWithTokenRetry\(\);[\s\S]*?toast\(workbookSyncFailureMessage\(error\)\)/,
  );
  assert.match(appSource, /pendingError\.conflicts\s*=\s*Array\.isArray\(synced\.conflicts\)/);
  assert.match(
    appSource,
    /duplicate-id[\s\S]*?Excel.*sourceRows[\s\S]*?云端未修改/,
  );
});

test("prepare-update IPC returns structured failures instead of rejecting raw Excel errors", async () => {
  const result = await prepareCanonicalWorkbookUpdateIpc({
    prepareUpdate: async () => {
      throw Object.assign(new Error("INVALID_WORKBOOK_CLIENT_ID"), {
        code: "INVALID_WORKBOOK_CLIENT_ID",
      });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "EXCEL_PREPARE_FAILED");
  assert.equal(result.detail, "INVALID_WORKBOOK_CLIENT_ID");
  assert.equal(result.path, "");
  assert.doesNotThrow(() => structuredClone(result));
});

test("Update preserves the prepare-update error code for diagnostics", () => {
  assert.match(
    appSource,
    /const prepareError = new Error\(prepared\?\.error[\s\S]*?prepareError\.code = prepared\?\.errorCode \|\| "EXCEL_PREPARE_FAILED"/,
  );
});

test("workbook identity count mismatches remain a visible review block", () => {
  assert.match(appSource, /if\s*\(plan\?\.reviewRequired\)/);
  assert.match(appSource, /WORKBOOK_MIGRATION_REVIEW_REQUIRED/);
  assert.match(appSource, /不会自动补删库存/);
});

test("bootstrap does not rewrite Excel again after initializeExcel decides the path", () => {
  const bootstrapBody = appSource.match(
    /async function bootstrap\(\)\s*\{([\s\S]*?)\n  \}\n\n  bootstrap\(\)/,
  )?.[1] || "";
  assert.match(bootstrapBody, /await initializeExcel\(\)/);
  assert.doesNotMatch(bootstrapBody, /await syncExcelFromApp\(/);
});

test("render closes a detail dialog whose item was deleted", () => {
  assert.match(appSource, /function clearMissingActiveDetail\(\)/);
  assert.match(
    appSource,
    /function render\(\)\s*\{\s*clearMissingActiveDetail\(\)/,
  );
});

test("Excel numeric showroom and sold columns remain visible without text records", () => {
  assert.match(
    appSource,
    /if\s*\(!text\)\s*return Math\.max\(0,\s*Number\(item\.showroomQuantity\)\s*\|\|\s*0\)/,
  );
  assert.match(
    appSource,
    /if\s*\(derived\)\s*return derived;\s*return Math\.max\(0,\s*Number\(item\.computedTotalSold\)\s*\|\|\s*0\)/,
  );
  assert.match(appSource, /showroomQuantity:\s*Number\.isFinite\(row\.showroomQuantity\)/);
  assert.match(appSource, /computedTotalSold:\s*Number\.isFinite\(row\.computedTotalSold\)/);
});
