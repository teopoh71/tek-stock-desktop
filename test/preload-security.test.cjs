"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { bootstrapMessage, openAfterBootstrap } = require("../inventory/excel-bootstrap-core.js");

function loadPreload(excelBootstrapResult = { ok: true, state: "ready" }, invokeOverride = null) {
  const bridges = new Map();
  const calls = [];
  const ipcRenderer = {
    invoke: async (...args) => {
      calls.push(args);
      if (invokeOverride) return invokeOverride(...args);
      if (args[0] === "tek-stock-excel-bootstrap") return excelBootstrapResult;
      if (args[0] === "tek-stock-excel-open") return { ok: true, path: "private.xlsx" };
      return { ok: true };
    },
    on: () => {},
    removeListener: () => {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "preload.cjs"), "utf8"), {
    require: (name) => {
      if (name === "electron") return {
        contextBridge: { exposeInMainWorld: (name, value) => bridges.set(name, value) },
        ipcRenderer,
      };
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  return {
    cloud: bridges.get("TekStockCloud"),
    excel: bridges.get("TekStockExcel"),
    calls,
  };
}

test("preload exposes a no-argument private-workbook bootstrap bridge", async () => {
  const { excel, calls } = loadPreload();
  assert.equal(excel.bootstrap.length, 0);
  await excel.bootstrap("ignored-renderer-data");
  assert.deepEqual(calls, [["tek-stock-excel-bootstrap"]]);
});

test("preload converts an unexpected cloud-sync IPC rejection into a bounded result", async () => {
  const { cloud, calls } = loadPreload(undefined, async (method) => {
    if (method === "tek-stock-cloud-sync-workbook") {
      throw new Error("Error invoking remote method 'tek-stock-cloud-sync-workbook': EXCEL_BINDING_FAILED");
    }
    return { ok: true };
  });
  const result = await cloud.syncWorkbook();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    workbookAcknowledged: false,
    errorCode: "WORKBOOK_SYNC_IPC_FAILED",
    detail: "EXCEL_BINDING_FAILED",
    message: "Excel 云端同步暂时失败，请保存 Excel 后按 Update 重试。",
  });
  assert.deepEqual(calls, [["tek-stock-cloud-sync-workbook"]]);
});

test("preload opens Excel only after a successful private-workbook bootstrap", async () => {
  const { excel, calls } = loadPreload();
  const opened = await excel.open();
  assert.equal(opened.ok, true);
  assert.deepEqual(calls, [
    ["tek-stock-excel-bootstrap"],
    ["tek-stock-excel-open"],
  ]);
});

test("preload does not open Excel after a failed bootstrap", async () => {
  const { excel, calls } = loadPreload({ ok: false, state: "offline-not-initialized" });
  const result = await excel.open();
  assert.equal(result.state, "offline-not-initialized");
  assert.deepEqual(calls, [["tek-stock-excel-bootstrap"]]);
});

test("renderer maps every bootstrap failure state to its exact message", () => {
  assert.equal(bootstrapMessage("bootstrapped"), "本机 Excel 已从云端建立。");
  assert.equal(bootstrapMessage("offline-not-initialized"), "首次建立本机 Excel 需要连接云端；旧 Excel 已保留未改动。");
  assert.equal(bootstrapMessage("invalid-private-workbook"), "本机 Excel 无法验证，未覆盖原文件。");
});

test("preload exposes only narrow conflict-list and conflict-resolution IPC methods", async () => {
  const { cloud, calls } = loadPreload();
  assert.equal(cloud.listSyncConflicts.length, 0);
  await cloud.listSyncConflicts("ignored-renderer-path");
  const payload = {
    opId: "4dc82e0a-b4fc-4df3-909c-9c00eaa2dc30",
    resolutions: [{ itemId: "chair-a", field: "stock", choice: "keep-cloud" }],
  };
  await cloud.resolveSyncConflict(payload);
  assert.deepEqual(calls, [
    ["tek-stock-cloud-list-conflicts"],
    ["tek-stock-cloud-resolve-conflict", payload],
  ]);
  assert.equal(cloud.invoke, undefined);
});

test("preload exposes only narrow workbook identity migration methods", async () => {
  const { cloud, calls } = loadPreload();
  await cloud.identityMigrationPlan("ignored-path");
  const manifest = {
    workbookSha256: "sha",
    cloudRevision: 4,
    choices: [{ sourceRow: 8, itemId: "id-8" }],
  };
  await cloud.applyIdentityMigration(manifest);
  assert.deepEqual(calls, [
    ["tek-stock-cloud-identity-migration-plan"],
    ["tek-stock-cloud-identity-migration-apply", manifest],
  ]);
});

test("preload exposes the cloud-reset-local bridge with an explicit confirmation value", async () => {
  const { excel, calls } = loadPreload();
  await excel.resetLocalFromCloud("TEK-STOCK-CLOUD-RESET-LOCAL-CONFIRMED");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[
    "tek-stock-excel-reset-local",
    { confirmation: "TEK-STOCK-CLOUD-RESET-LOCAL-CONFIRMED" },
  ]]);
  assert.equal(excel.invoke, undefined);
});

test("photo replacement sends only bytes plus canonical baseline identity", async () => {
  const { cloud, calls } = loadPreload();
  const digest = "a".repeat(64);
  await cloud.replacePhoto("chair-a", "data:image/webp;base64,YQ==", {
    imageSha256: digest,
    imageVersion: "sha256-aaaaaaaaaaaaaaaaaaaaaaaa",
    image: "file:///private/cache/photo.webp",
    path: "C:\\private\\photo.webp",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["tek-stock-cloud-replace-photo", {
    itemId: "chair-a",
    dataUrl: "data:image/webp;base64,YQ==",
    imageSha256: digest,
    imageVersion: "sha256-aaaaaaaaaaaaaaaaaaaaaaaa",
  }]]);
});

test("renderer blocks the Excel opener while bootstrap is not ready", async () => {
  let opened = 0;
  const result = await openAfterBootstrap(
    { bootstrap: async () => ({ ok: false, state: "offline-not-initialized" }) },
    async () => { opened += 1; return { ok: true }; },
  );
  assert.equal(opened, 0);
  assert.equal(result.message, "首次建立本机 Excel 需要连接云端；旧 Excel 已保留未改动。");
});
