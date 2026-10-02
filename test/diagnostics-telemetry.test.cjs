"use strict";
process.env.TEK_STOCK_TEST = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { safeEvent } = require("../diagnostic-payload.cjs");
const { createDiagnosticsOutbox } = require("../diagnostics-outbox.cjs");
const { createDiagnosticContext } = require("../main.cjs");
const { appendDiagnosticEvent } = require("../main.cjs");

function temp(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "tek-telemetry-"));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

test("native diagnostic context persists an opaque device id and bounded authority", (t) => {
  const directory = temp(t);
  const first = createDiagnosticContext({ userDataPath: directory, appVersion: "1.6.11", authorityId: "tek-stock-independent-v1" });
  const second = createDiagnosticContext({ userDataPath: directory, appVersion: "untrusted", authorityId: "private token=bad" });
  assert.match(first.deviceId, /^d-[a-f0-9]{32}$/);
  assert.equal(first.deviceId, second.deviceId);
  assert.equal(first.authorityId, "tek-stock-independent-v1");
  assert.equal(second.authorityId, "unknown");
  assert.equal(second.appVersion, "unknown");
  assert.equal(fs.readFileSync(path.join(directory, "diagnostics-device.json"), "utf8").includes("private"), false);
});

test("telemetry retains only native context and safe sync state", () => {
  const safe = safeEvent({
    stage: "refresh_failed", ok: false, errorCode: "CLOUD_UNAVAILABLE", appVersion: "1.6.11",
    deviceId: "d-0123456789abcdef0123456789abcdef", authorityId: "tek-stock-independent-v1",
    revision: 149, pending: 2, message: "A7788 and password=private",
  });
  assert.deepEqual(safe, {
    timestamp: safe.timestamp, appVersion: "1.6.11", stage: "refresh_failed", ok: false,
    errorCode: "CLOUD_UNAVAILABLE", deviceId: "d-0123456789abcdef0123456789abcdef",
    authorityId: "tek-stock-independent-v1", revision: 149, pending: 2,
  });
});

test("sender preserves proven cloud configuration and native Excel sync error codes", () => {
  for (const errorCode of ["SYNC_TOKEN_MISSING", "API_REQUEST_TIMEOUT", "API_RESPONSE_JSON_INVALID", "API_AUTHORITY_MISMATCH", "API_BASE_URL_MISSING", "API_BASE_URL_INVALID", "API_AUTHORITY_ID_MISSING", "API_AUTHORITY_ID_INVALID"]) {
    const event = safeEvent({ stage: "excel_sync", errorCode, deviceId: "d-0123456789abcdef0123456789abcdef", authorityId: "tek-stock-independent-v1" });
    assert.equal(event.stage, "excel_sync");
    assert.equal(event.errorCode, errorCode);
    assert.equal(event.deviceId, "d-0123456789abcdef0123456789abcdef");
  }
  const forged = safeEvent({ stage: "<script>", errorCode: "password=private", appVersion: "999.999.999.999", deviceId: "user-name", authorityId: "token=private", counts: { models: 999 } });
  assert.deepEqual(Object.keys(forged), ["timestamp", "appVersion", "stage", "ok", "errorCode"]);
  assert.equal(forged.errorCode, "UNKNOWN_ERROR");
});

test("recovery is queued once for its prior failed stage without erasing another failure", (t) => {
  const directory = temp(t);
  let clock = 1000;
  const queue = createDiagnosticsOutbox({ directory, now: () => clock, configured: () => true, send: async () => ({ accepted: [] }) });
  queue.enqueue({ stage: "refresh_failed", errorCode: "CLOUD_UNAVAILABLE", appVersion: "1.6.11", deviceId: "d-0123456789abcdef0123456789abcdef" });
  queue.enqueue({ stage: "sync_failed", errorCode: "EXCEL_THREE_WAY_CONFLICT", appVersion: "1.6.11", deviceId: "d-0123456789abcdef0123456789abcdef" });
  clock += 1;
  assert.equal(queue.enqueue({ stage: "refresh_succeeded", ok: true, appVersion: "1.6.11", deviceId: "d-0123456789abcdef0123456789abcdef" }).queued, true);
  assert.equal(queue.enqueue({ stage: "refresh_succeeded", ok: true, appVersion: "1.6.11", deviceId: "d-0123456789abcdef0123456789abcdef" }).queued, false);
  assert.equal(queue.status().pending, 3);
});

test("starts cannot clear a failure, and separate devices retain the same code", (t) => {
  const directory = temp(t); let clock = 1000;
  const queue = createDiagnosticsOutbox({ directory, now: () => clock, configured: () => false });
  const common = { appVersion: "1.6.11", authorityId: "tek-stock-independent-v1", errorCode: "CLOUD_UNAVAILABLE" };
  queue.enqueue({ ...common, stage: "refresh_failed", deviceId: "d-0123456789abcdef0123456789abcdef" });
  queue.enqueue({ ...common, stage: "refresh_started", ok: true, deviceId: "d-0123456789abcdef0123456789abcdef" });
  queue.enqueue({ ...common, stage: "refresh_failed", deviceId: "d-fedcba9876543210fedcba9876543210" });
  assert.equal(queue.status().pending, 2);
  assert.equal(queue.enqueue({ ...common, stage: "refresh_succeeded", ok: true, deviceId: "d-0123456789abcdef0123456789abcdef" }).queued, true);
});

test("a new failure epoch inside one minute still receives its own recovery", (t) => {
  const directory = temp(t); let clock = 1000;
  const queue = createDiagnosticsOutbox({ directory, now: () => clock, configured: () => false });
  const event = { stage: "refresh_failed", errorCode: "CLOUD_UNAVAILABLE", appVersion: "1.6.11", deviceId: "d-0123456789abcdef0123456789abcdef" };
  queue.enqueue(event);
  queue.enqueue({ ...event, stage: "refresh_succeeded", ok: true });
  clock += 1;
  queue.enqueue(event);
  assert.equal(queue.enqueue({ ...event, stage: "refresh_succeeded", ok: true }).queued, true);
  assert.equal(queue.status().pending, 4);
});

test("outbox accepts legacy array entries before persisting recovery state", (t) => {
  const directory = temp(t);
  const id = "01234567-89ab-4cde-8fab-0123456789ab";
  fs.writeFileSync(path.join(directory, "diagnostics-outbox.json"), JSON.stringify([{ id, timestamp: new Date().toISOString(), appVersion: "1.6.11", stage: "cloud_download", errorCode: "CLOUD_UNAVAILABLE" }]));
  const queue = createDiagnosticsOutbox({ directory, configured: () => false });
  assert.equal(queue.status().pending, 1);
  queue.enqueue({ stage: "cloud_upload", errorCode: "CLOUD_UPLOAD_FAILED", appVersion: "1.6.11" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "diagnostics-outbox.json"), "utf8")).version, 3);
});

test("persisted diagnostic and outbound queue share only the native safe identity", (t) => {
  const directory = temp(t);
  appendDiagnosticEvent({ stage: "refresh_failed", errorCode: "CLOUD_UNAVAILABLE", revision: 149, pending: 3, message: "password=private" }, {
    userDataPath: directory, appVersion: "1.6.11", authorityId: "tek-stock-independent-v1", now: new Date("2026-09-22T00:00:00.000Z"),
  });
  const line = JSON.parse(fs.readFileSync(path.join(directory, "diagnostics", "TEK-STOCK-diagnostics-2026-09-22.jsonl"), "utf8"));
  const outbox = JSON.parse(fs.readFileSync(path.join(directory, "diagnostics", "diagnostics-outbox.json"), "utf8")).entries[0];
  for (const key of ["timestamp", "appVersion", "stage", "ok", "errorCode", "deviceId", "authorityId", "revision", "pending"]) {
    assert.equal(line[key], outbox[key], key);
  }
  assert.equal(JSON.stringify(line).includes("private"), false);
});
