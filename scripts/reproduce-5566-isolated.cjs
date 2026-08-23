"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCentralSync } = require("../central-sync.cjs");
const { createSyncTrace } = require("../sync-trace.cjs");

const model = "5566-TEST";
const injectFailure = !process.argv.includes("--success");
const trace = createSyncTrace(model);
const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-5566-test-"));
const workbookPath = path.join(isolatedRoot, "TEK-STOCK-5566-TEST.xlsx");
const cloudItem = { id: "5566-test-id", model, category: "Chair", stock: 2, sourceRow: 5 };
const appItems = [cloudItem];
let workbookWrites = 0;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-tek-stock-authority-id": "isolated-test" },
  });
}

async function fetchImpl(url) {
  const parsed = new URL(url);
  if (parsed.pathname === "/v1/snapshot") {
    return json({ revision: 1, changeSequence: 0, items: [cloudItem], updatedAt: "2026-08-07T00:00:00.000Z" });
  }
  if (parsed.pathname === "/v1/changes") {
    return json({ fromRevision: 0, toRevision: 1, currentRevision: 1, hasMore: false, events: [] });
  }
  if (parsed.pathname === "/v1/items/batch") {
    return json({ ok: true, revision: 1, updatedAt: "2026-08-07T00:00:00.000Z" });
  }
  return json({ code: "NOT_FOUND" }, 404);
}

async function main() {
  trace.record("app", { request: "sync workbook", model, appItemCount: appItems.length });
  trace.record("ipc", { method: "tek-stock-cloud-sync-workbook", status: "entered" });
  const sync = createCentralSync({
    storageDirectory: isolatedRoot,
    fetchImpl,
    getApiBaseUrl: () => "https://isolated.test",
    getToken: () => "isolated-token",
  });
  let result;
  try {
    result = await sync.syncWorkbook({
      readWorkbook: async () => {
        trace.record("excel-bridge", {
          operation: "read",
          path: workbookPath,
          sheet: "库存总表",
          rows: 0,
          status: "ok",
        });
        return {
          ok: true,
          path: workbookPath,
          sha256: "isolated-workbook-sha",
          items: [],
          sync: { revision: 0, itemCount: 0 },
          baseline: { revision: 0, itemCount: 0, records: [] },
        };
      },
      assignIds: async () => ({ ok: true }),
      acknowledge: async () => ({ ok: true }),
      replaceWorkbook: async (payload) => {
        workbookWrites += 1;
        if (!injectFailure) {
          trace.record("excel-bridge", {
            operation: "write",
            path: workbookPath,
            sheet: "库存总表",
            rows: payload.items.length,
            status: "saved",
          });
          trace.record("workbook", { expectedModel: model, actualModel: model, status: "verified" });
          return { ok: true, path: workbookPath };
        }
        trace.record("excel-bridge", {
          operation: "write",
          path: workbookPath,
          sheet: "库存总表",
          rows: payload.items.length,
          status: "failed",
          errorCode: "EXCEL_BINDING_FAILED",
        });
        throw Object.assign(new Error("Excel binding failed in isolated bridge"), { code: "EXCEL_BINDING_FAILED" });
      },
      normalizeRows: (rows) => rows,
    });
    if (injectFailure) trace.record("workbook", { expectedModel: model, actualModel: "", status: "not-written" });
  } catch (error) {
    trace.record("workbook", { expectedModel: model, actualModel: "", status: "not-written", errorCode: error.code || "SYNC_FAILED" });
    result = { ok: false, errorCode: error.code || "SYNC_FAILED" };
  }
  const report = trace.finish({
    ok: result?.workbookAcknowledged === true,
    errorCode: result?.errorCode || (result?.workbookAcknowledged ? "" : "EXCEL_BINDING_FAILED"),
    centralResult: result,
    workbookWrites,
  });
  report.isolatedRoot = isolatedRoot;
  report.appItems = appItems.map((item) => ({ model: item.model, stock: item.stock }));
  report.workbookItems = report.ok === true ? [{ model, stock: cloudItem.stock }] : [];
  const outputDir = path.resolve(__dirname, "..", "test-artifacts");
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, `sync-5566-${trace.traceId}.json`);
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, traceId: trace.traceId, failedStage: report.failedStage, errorCode: report.errorCode, appHas5566: true, workbookHas5566: report.ok === true })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
