"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeChanges } = require("../scripts/diagnostics-monitor.cjs");
const device = "d-22222222222242228222222222222222";
const row = (extra = {}) => ({ device_id: device, authority_id: "tek-stock-independent-v1", app_version: "1.6.12", stage: "cloud_download", error_code: "UNAUTHORIZED", ok: 0, recovered: 0, occurred_at: "2026-09-22T04:00:00.000Z", received_at: "2026-09-22T04:00:02.000Z", ...extra });
test("monitor reports a new fault once and stays quiet for unchanged repeats", () => {
  const first = summarizeChanges([row()], {});
  assert.equal(first.changes[0].state, "fault");
  const next = summarizeChanges([row({ received_at: "2026-09-22T04:01:00.000Z" })], first.state);
  assert.deepEqual(next.changes, []);
});
test("monitor separates devices and stages and only announces observed recovery", () => {
  const first = summarizeChanges([row(), row({ stage: "excel_sync", error_code: "WORKBOOK_MERGE_CONFLICT" })], {});
  const next = summarizeChanges([row({ ok: 1, recovered: 1, error_code: "", occurred_at: "2026-09-22T04:02:00.000Z" })], first.state);
  assert.equal(next.changes.length, 1);
  assert.equal(next.changes[0].state, "recovered");
  assert.equal(Object.values(next.state).filter(x => x.state === "fault").length, 1);
  const other = summarizeChanges([row({ device_id: "d-33333333333343338333333333333333" })], next.state);
  assert.equal(other.changes.length, 1);
});
test("monitor does not promote delayed old faults above recovery or infer recovery from silence", () => {
  const current = summarizeChanges([row({ ok: 1, recovered: 1, error_code: "", occurred_at: "2026-09-22T04:02:00.000Z" })], {});
  assert.deepEqual(current.changes, []);
  const delayed = summarizeChanges([row({ received_at: "2026-09-22T04:03:00.000Z" })], current.state);
  assert.deepEqual(delayed.changes, []);
  assert.deepEqual(summarizeChanges([], current.state).state, current.state);
});
test("monitor ignores legacy unattributed rows and explicit verification fixture", () => {
  const result = summarizeChanges([row({ device_id: "legacy" }), row({ device_id: "d-00000000000040008000000000000012" })], {});
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.state, {});
});
test("generic auth fault recovers with successful cloud stage and started never clears it", () => {
  const first = summarizeChanges([row({ stage: "app.error", event_sequence: 1 })], {});
  const started = summarizeChanges([row({ stage: "refresh_started", ok: 1, event_sequence: 2 })], first.state);
  assert.deepEqual(started.changes, []);
  const recovered = summarizeChanges([row({ stage: "refresh_succeeded", ok: 1, recovered: 1, event_sequence: 3 })], started.state);
  assert.equal(recovered.changes[0].state, "recovered");
  const delayed = summarizeChanges([row({ stage: "app.error", event_sequence: 1, occurred_at: "2026-09-22T04:10:00.000Z" })], recovered.state);
  assert.deepEqual(delayed.changes, []);
});
