"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { advice } = require("../inventory/recovery-core.js");
const { safeEvent } = require("../diagnostic-payload.cjs");
const { createDiagnosticsOutbox } = require("../diagnostics-outbox.cjs");
const { assertIdle, createUpdateBackup } = require("../safe-update.cjs");
const { httpsEndpoint, readMaintenanceConfig } = require("../maintenance-config.cjs");
function directory(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), "tek-recovery-")); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
test("each failure provides concrete non-destructive choices including continue", () => {
  const cases = {
    API_NETWORK_UNREACHABLE: ["network", "retry"], UNAUTHORIZED: ["auth", "auth"],
    EXCEL_THREE_WAY_CONFLICT: ["conflict", "conflicts"], WORKBOOK_UNSAVED_CHANGES: ["busy", "excel"],
    UPDATE_SHA256_MISMATCH: ["verification", "update"], UPDATE_BACKUP_FAILED: ["backup", "update"],
  };
  for (const [code, [kind, first]] of Object.entries(cases)) {
    const result = advice(code); assert.equal(result.kind, kind); assert.equal(result.actions[0].id, first);
    assert.ok(result.actions.some(a => a.id === "later")); assert.ok(!JSON.stringify(result.actions).includes("reset"));
  }
});
test("diagnostics omit inventory, identities, credentials, text and unknown codes", () => {
  const result = safeEvent({ errorCode: "my password", stage: "customer jane", appVersion: "1.6.8", token: "secret", items: [{ price: 50 }], message: "secret", traceId: "private", revision: 37 });
  assert.equal(result.errorCode, "UNKNOWN_ERROR"); assert.equal(result.stage, "unknown");
  assert.deepEqual(Object.keys(result), ["timestamp", "appVersion", "stage", "ok", "errorCode"]);
});
test("offline queue survives restart, deduplicates and removes only acknowledged events", async t => {
  const root = directory(t); let connected = false;
  const options = { directory: root, configured: () => true, send: async events => { if (!connected) throw Error("offline"); return { accepted: [events[0].id] }; } };
  let queue = createDiagnosticsOutbox(options);
  queue.enqueue({ errorCode: "API_NETWORK_UNREACHABLE", stage: "cloud_download", appVersion: "1.6.8" });
  queue.enqueue({ errorCode: "API_NETWORK_UNREACHABLE", stage: "cloud_download", appVersion: "1.6.8" });
  queue.enqueue({ errorCode: "UPDATE_BACKUP_FAILED", stage: "update.backup", appVersion: "1.6.8" });
  assert.equal(queue.status().pending, 2); assert.equal((await queue.flush()).ok, false);
  queue = createDiagnosticsOutbox(options); assert.equal(queue.status().pending, 2);
  connected = true; const sent = await queue.flush(true); assert.equal(sent.sent, 1); assert.equal(sent.pending, 1);
});
test("concurrent report and flush cannot lose new events, invalid acknowledgments retain events", async t => {
  const root = directory(t); let accept;
  const queue = createDiagnosticsOutbox({ directory: root, configured: () => true, send: () => new Promise(r => { accept = r; }) });
  const first = queue.enqueue({ errorCode: "UPDATE_BACKUP_FAILED" });
  const flushing = queue.flush(); queue.enqueue({ errorCode: "UNAUTHORIZED" });
  accept({ accepted: [first.id] }); await flushing; assert.equal(queue.status().pending, 1);
  const second = queue.flush(true); accept({ accepted: ["not-an-id"] }); assert.equal((await second).ok, false); assert.equal(queue.status().pending, 1);
});
test("unconfigured diagnostics are explicitly pending instead of falsely sent", async t => {
  const q = createDiagnosticsOutbox({ directory: directory(t), configured: () => false }); q.enqueue({ errorCode: "SYNC_FAILED" });
  const result = await q.flush(true); assert.equal(result.ok, false); assert.equal(result.errorCode, "DIAGNOSTICS_NOT_CONFIGURED"); assert.equal(result.pending, 1);
});
test("updates require known idle state with no pending changes or conflicts", () => {
  for (const state of [{}, { known: true, pending: 1 }, { known: true, conflicts: 1 }, { known: true, unsaved: true }, { known: true, workbookLocked: true }]) assert.throws(() => assertIdle(state));
  assert.doesNotThrow(() => assertIdle({ known: true, pending: 0, conflicts: 0 }));
});
test("backup preserves workbook and outbox bytes; missing workbook blocks installation", t => {
  const root = directory(t), workbook = path.join(root, "live.xlsx"), outbox = path.join(root, "outbox.json");
  fs.writeFileSync(workbook, "original workbook bytes"); fs.writeFileSync(outbox, '{"pending":[]}');
  const result = createUpdateBackup({ directory: path.join(root, "backups"), workbook, stateFiles: [outbox], version: "1.6.8" });
  assert.equal(result.files, 2); assert.equal(fs.readFileSync(path.join(result.path, "workbook.xlsx"), "utf8"), "original workbook bytes");
  assert.equal(fs.readFileSync(outbox, "utf8"), '{"pending":[]}');
  assert.throws(() => createUpdateBackup({ directory: root, workbook: path.join(root, "missing.xlsx") }), { code: "UPDATE_BACKUP_FAILED" });
});
test("maintenance rejects non-HTTPS and credentials in endpoint URLs", t => {
  for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com/?token=private"]) assert.throws(() => httpsEndpoint(url));
  const root = directory(t); fs.writeFileSync(path.join(root, "maintenance.json"), JSON.stringify({ autoUpdate: false }));
  assert.equal(readMaintenanceConfig(root, {}).autoUpdate, false);
});
