"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  appendDiagnosticEvent,
  diagnosticsDirectory,
  exportDiagnosticsToFile,
  listDiagnosticFiles,
  registerDiagnosticsIpc,
} = require("../main.cjs");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-diagnostics-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("diagnostics keep only allowlisted operational fields and redact sensitive text", (t) => {
  const userDataPath = temporaryDirectory(t);
  const now = new Date(2026, 6, 20, 12, 30, 0);
  const result = appendDiagnosticEvent({
    stage: "excel.upload token=super-secret email=edwin@example.com +65 9123 4567 data:image/png;base64,AAAA",
    ok: false,
    errorCode: "HTTP_401 password=hunter2",
    revision: 51,
    counts: {
      items: 326,
      created: 1,
      contactCount: 4,
      photoCount: 1,
      negative: -1,
      textValue: "123",
    },
    token: "super-secret",
    password: "hunter2",
    contact: { phone: "+65 9123 4567" },
    inventoryRows: [{ model: "PRIVATE-MODEL" }],
    image: "data:image/png;base64,TOPSECRET",
  }, {
    userDataPath,
    appVersion: "1.5.10",
    now,
  });

  assert.equal(result.ok, true);
  const text = fs.readFileSync(result.path, "utf8");
  for (const forbidden of [
    "super-secret",
    "hunter2",
    "edwin@example.com",
    "9123 4567",
    "AAAA",
    "TOPSECRET",
    "PRIVATE-MODEL",
    "contactCount",
    "photoCount",
  ]) {
    assert.equal(text.includes(forbidden), false, `must redact ${forbidden}`);
  }

  const entry = JSON.parse(text.trim());
  assert.deepEqual(Object.keys(entry), [
    "timestamp",
    "appVersion",
    "stage",
    "ok",
    "errorCode",
    "revision",
    "counts",
  ]);
  assert.equal(entry.appVersion, "1.5.10");
  assert.equal(entry.ok, false);
  assert.equal(entry.revision, 51);
  assert.deepEqual(entry.counts, { items: 326, created: 1 });
});

test("diagnostics retain only a recognized invalid snapshot field", (t) => {
  const userDataPath = temporaryDirectory(t);
  const accepted = appendDiagnosticEvent({
    stage: "excel_sync_ipc",
    ok: false,
    errorCode: "CLOUD_SNAPSHOT_INVALID",
    snapshotField: "items",
  }, { userDataPath, appVersion: "1.5.72", now: new Date(2026, 7, 11) });
  const entry = JSON.parse(fs.readFileSync(accepted.path, "utf8").trim());
  assert.equal(entry.snapshotField, "items");

  const rejected = appendDiagnosticEvent({
    stage: "excel_sync_ipc",
    ok: false,
    errorCode: "CLOUD_SNAPSHOT_INVALID",
    snapshotField: "private-payload-value",
  }, { userDataPath, appVersion: "1.5.72", now: new Date(2026, 7, 12) });
  const rejectedEntry = JSON.parse(fs.readFileSync(rejected.path, "utf8").trim());
  assert.equal(Object.hasOwn(rejectedEntry, "snapshotField"), false);
});

test("diagnostics retain seven daily files and cap every line and daily file", (t) => {
  const userDataPath = temporaryDirectory(t);
  for (let day = 1; day <= 9; day += 1) {
    appendDiagnosticEvent({
      stage: `retention.day.${day}`,
      ok: true,
      revision: day,
      counts: { items: 300 + day },
    }, {
      userDataPath,
      appVersion: "1.5.10",
      now: new Date(2026, 6, day, 12, 0, 0),
      maxFileBytes: 620,
      maxLineBytes: 320,
    });
  }

  const retained = listDiagnosticFiles(userDataPath);
  assert.equal(retained.length, 7);
  assert.match(path.basename(retained[0]), /2026-07-03/);
  assert.match(path.basename(retained[6]), /2026-07-09/);

  for (let index = 0; index < 30; index += 1) {
    appendDiagnosticEvent({
      stage: `excel.sync.${index}`,
      ok: index % 2 === 0,
      errorCode: index % 2 === 0 ? "" : "SYNC_RETRY",
      revision: 100 + index,
      counts: { items: 325, changed: index },
    }, {
      userDataPath,
      appVersion: "1.5.10",
      now: new Date(2026, 6, 9, 13, index, 0),
      maxFileBytes: 620,
      maxLineBytes: 320,
    });
  }

  const currentFile = retained[retained.length - 1];
  const currentText = fs.readFileSync(currentFile, "utf8");
  assert.ok(Buffer.byteLength(currentText) <= 620);
  const lines = currentText.trim().split("\n");
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line) <= 320);
    assert.doesNotThrow(() => JSON.parse(line));
  }
  assert.equal(JSON.parse(lines[lines.length - 1]).stage, "excel.sync.29");
});

test("diagnostic IPC uses fixed safe paths for append, export, and folder opening", async (t) => {
  const userDataPath = temporaryDirectory(t);
  const handlers = new Map();
  const opened = [];
  const exportPath = path.join(userDataPath, "exported-diagnostics.jsonl");
  const ipc = {
    handle(name, handler) {
      handlers.set(name, handler);
    },
  };
  const shellApi = {
    async openPath(target) {
      opened.push(target);
      return "";
    },
  };
  const dialogApi = {
    async showSaveDialog() {
      return { canceled: false, filePath: exportPath };
    },
  };

  registerDiagnosticsIpc({
    ipcMain: ipc,
    shell: shellApi,
    dialog: dialogApi,
    userDataPath,
    documentsPath: userDataPath,
    appVersion: "1.5.10",
    now: () => new Date(2026, 6, 20, 12, 0, 0),
  });

  const append = await handlers.get("tek-stock-diagnostics-append")(null, {
    stage: "app.start",
    ok: true,
    revision: 52,
    counts: { items: 325 },
    password: "must-not-appear",
  });
  assert.equal(append.ok, true);

  const info = await handlers.get("tek-stock-diagnostics-get-path")();
  assert.equal(info.ok, true);
  assert.equal(info.path, diagnosticsDirectory(userDataPath));

  const exported = await handlers.get("tek-stock-diagnostics-export")();
  assert.equal(exported.ok, true);
  assert.equal(exported.path, exportPath);
  assert.equal(fs.readFileSync(exportPath, "utf8").includes("must-not-appear"), false);

  assert.throws(
    () => exportDiagnosticsToFile(
      userDataPath,
      path.join(diagnosticsDirectory(userDataPath), "unsafe-export.jsonl"),
    ),
    (error) => error?.code === "UNSAFE_EXPORT_PATH",
  );

  const openedResult = await handlers.get("tek-stock-diagnostics-open-folder")();
  assert.equal(openedResult.ok, true);
  assert.deepEqual(opened, [diagnosticsDirectory(userDataPath)]);

  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.cjs"), "utf8");
  assert.match(preload, /exposeInMainWorld\("TekStockDiagnostics"/);
  for (const channel of [
    "tek-stock-diagnostics-append",
    "tek-stock-diagnostics-get-path",
    "tek-stock-diagnostics-export",
    "tek-stock-diagnostics-open-folder",
  ]) {
    assert.match(preload, new RegExp(channel));
  }
});
