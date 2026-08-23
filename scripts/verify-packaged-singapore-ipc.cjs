"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");

const project = path.resolve(__dirname, "..");
process.env.NODE_PATH = path.join(project, "node_modules");
require("node:module").Module._initPaths();
const appAsar = path.join(project, "dist-update", "win-unpacked", "resources", "app.asar");
const output = path.join(project, "outputs", "packaged-singapore-ipc-1.5.76.json");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-packaged-ipc-"));

function json(body, authorityId = "tek-stock-hangzhou-v1") {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-tek-stock-authority-id": authorityId,
    },
  });
}

async function main() {
  assert.equal(fs.existsSync(appAsar), true, appAsar);
  asar.extractAll(appAsar, root);
  const { createApiRequester } = require(path.join(root, "api-failover.cjs"));
  const { safeSnapshot } = require(path.join(root, "central-sync.cjs"));
  const {
    prepareCanonicalWorkbookUpdateIpc,
    syncWorkbookWithCentralCloudIpc,
  } = require(path.join(root, "main.cjs"));
  const calls = [];
  const request = createApiRequester({
    fetchImpl: async (url) => {
      const host = new URL(url).hostname;
      calls.push(host);
      return host === "primary.invalid"
        ? json({ app: "TEK STOCK", revision: 248 })
        : json({ app: "TEK STOCK", revision: 248, items: [] });
    },
    getApiBaseUrl: () => "https://primary.invalid",
    getApiFallbackBaseUrls: () => ["https://singapore.invalid"],
    getAuthorityId: () => "tek-stock-hangzhou-v1",
  });
  const snapshot = await request("/v1/snapshot", { validateResponse: safeSnapshot });
  const ipc = await syncWorkbookWithCentralCloudIpc({
    syncWorkbook: async () => {
      throw Object.assign(new Error("CLOUD_SNAPSHOT_INVALID"), {
        code: "CLOUD_SNAPSHOT_INVALID",
        snapshotField: "items",
      });
    },
    appendDiagnostic: () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
  });
  const prepareIpc = await prepareCanonicalWorkbookUpdateIpc({
    prepareUpdate: async () => ({
      ok: true,
      path: "C:\\isolated\\TEK-STOCK-LIVE.xlsx",
      sha256: "a".repeat(64),
      size: 4_689_659,
      mtimeMs: 1_786_412_927_000,
      items: Array.from({ length: 322 }, () => ({ image: "x".repeat(40_000) })),
      rawItems: Array.from({ length: 322 }, () => ({ embeddedImageDataUrl: "x".repeat(40_000) })),
    }),
  });
  const prepareFailure = await prepareCanonicalWorkbookUpdateIpc({
    prepareUpdate: async () => {
      throw Object.assign(new Error("INVALID_WORKBOOK_CLIENT_ID"), {
        code: "INVALID_WORKBOOK_CLIENT_ID",
      });
    },
  });
  const result = {
    ok: true,
    packageVersion: require(path.join(root, "package.json")).version,
    appAsarSha256: crypto.createHash("sha256").update(fs.readFileSync(appAsar)).digest("hex"),
    calls,
    snapshot: { revision: snapshot.revision, itemCount: snapshot.items.length },
    ipc: {
      ok: ipc.ok,
      errorCode: ipc.errorCode,
      snapshotField: ipc.snapshotField,
      traceIdPattern: /^sync-/.test(ipc.traceId),
      cloneable: Boolean(structuredClone(ipc)),
    },
    prepareIpc: {
      ok: prepareIpc.ok,
      keys: Object.keys(prepareIpc),
      cloneable: Boolean(structuredClone(prepareIpc)),
      jsonBytes: Buffer.byteLength(JSON.stringify(prepareIpc)),
      failureOk: prepareFailure.ok,
      failureErrorCode: prepareFailure.errorCode,
      failureDetail: prepareFailure.detail,
      failureCloneable: Boolean(structuredClone(prepareFailure)),
    },
  };
  assert.equal(result.packageVersion, "1.5.76");
  assert.deepEqual(calls, ["primary.invalid", "singapore.invalid"]);
  assert.deepEqual(result.snapshot, { revision: 248, itemCount: 0 });
  assert.deepEqual(result.ipc, {
    ok: false,
    errorCode: "CLOUD_SNAPSHOT_INVALID",
    snapshotField: "items",
    traceIdPattern: true,
    cloneable: true,
  });
  assert.ok(result.prepareIpc.jsonBytes < 1024);
  assert.deepEqual({ ...result.prepareIpc, jsonBytes: 0 }, {
    ok: true,
    keys: ["ok", "errorCode", "detail", "path", "sha256", "size", "mtimeMs"],
    cloneable: true,
    jsonBytes: 0,
    failureOk: false,
    failureErrorCode: "EXCEL_PREPARE_FAILED",
    failureDetail: "INVALID_WORKBOOK_CLIENT_ID",
    failureCloneable: true,
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
});
