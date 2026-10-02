"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
test("receiver requires ingestion auth, bounds payload, strips untrusted fields and deduplicates IDs", async () => {
  const worker = (await import("../maintenance-worker/worker.mjs")).default;
  const records = new Map();
  const env = { INGEST_TOKEN: "i".repeat(32), MONITOR_TOKEN: "m".repeat(32), DB: {
    prepare: sql => ({ bind: (...args) => ({ sql, args, all: async () => ({ results: [] }) }) }),
    batch: async rows => rows.forEach(row => { if (!records.has(row.args[0])) records.set(row.args[0], row.args); }),
  } };
  const send = (body, token = env.INGEST_TOKEN) => worker.fetch(new Request("https://service.test/v1/diagnostics", {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }), env);
  const event = { id: randomUUID(), timestamp: new Date().toISOString(), appVersion: "1.6.8", stage: "cloud_download", errorCode: "API_NETWORK_UNREACHABLE", password: "private", items: [1,2] };
  assert.equal((await send({ events: [event] }, env.MONITOR_TOKEN)).status, 401);
  assert.equal((await send({ events: [event] })).status, 202);
  await send({ events: [event] }); assert.equal(records.size, 1);
  assert.ok(!JSON.stringify([...records.values()]).includes("private"));
  assert.equal((await send({ events: [event], padding: "x".repeat(17000) })).status, 400);
  assert.equal((await worker.fetch(new Request("https://service.test/v1/incidents", { headers: { authorization: `Bearer ${env.INGEST_TOKEN}` } }), env)).status, 401);
});

test("legacy sync credentials can submit reports but cannot read incidents", async () => {
  const worker = (await import("../maintenance-worker/worker.mjs")).default;
  const env = { SYNC_INGEST_TOKEN: "legacy7", MONITOR_TOKEN: "m".repeat(32), DB: { prepare: () => ({ bind: () => ({}) }), batch: async () => {} } };
  const headers = { authorization: "Bearer legacy7" };
  const event = { id: randomUUID(), appVersion: "1.6.8", stage: "app.error", errorCode: "API_NETWORK_UNREACHABLE" };
  const response = await worker.fetch(new Request("https://service.test/v1/diagnostics", { method: "POST", headers, body: JSON.stringify({ events: [event] }) }), env);
  assert.equal(response.status, 202);
  assert.deepEqual((await response.json()).accepted, [event.id]);
  assert.equal((await worker.fetch(new Request("https://service.test/v1/incidents", { headers }), env)).status, 401);
  assert.equal((await worker.fetch(new Request("https://service.test/v1/diagnostics", { method: "POST", headers: { authorization: "Bearer wrong77" }, body: JSON.stringify({ events: [event] }) }), env)).status, 401);
});

test("independent inventory ingest credential can only submit diagnostics", async () => {
  const worker = (await import("../maintenance-worker/worker.mjs")).default;
  const env = { INVENTORY_INGEST_TOKEN: "v".repeat(24), MONITOR_TOKEN: "m".repeat(32), DB: { prepare: () => ({ bind: () => ({}) }), batch: async () => {} } };
  const event = { id: randomUUID(), appVersion: "1.6.11", stage: "refresh_failed", errorCode: "SYNC_TOKEN_MISSING" };
  const post = token => worker.fetch(new Request("https://service.test/v1/diagnostics", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ events: [event] }) }), env);
  assert.equal((await post(env.INVENTORY_INGEST_TOKEN)).status, 202);
  assert.equal((await post("x".repeat(23))).status, 401);
  assert.equal((await worker.fetch(new Request("https://service.test/v1/incidents", { headers: { authorization: `Bearer ${env.INVENTORY_INGEST_TOKEN}` } }), env)).status, 401);
});

test("receiver stores pseudonymous state and incident reads expose latest active or recovered state", async () => {
  const worker = (await import("../maintenance-worker/worker.mjs")).default;
  const inserted = [];
  const incidents = [{ device_id: "d-0123456789abcdef0123456789abcdef", authority_id: "tek-stock-independent-v1", app_version: "1.6.11", incident_stage: "cloud_download", last_event_stage: "refresh_succeeded", error_code: "", ok: 1, recovered: 1, revision: 149, pending_count: 0, occurrences: 2, first_seen: "2026-09-22T00:00:00.000Z", last_seen: "2026-09-22T00:02:00.000Z" }];
  const env = { INGEST_TOKEN: "i".repeat(32), MONITOR_TOKEN: "m".repeat(32), DB: {
    prepare: sql => ({ bind: (...args) => ({ sql, args, all: async () => ({ results: incidents }) }) }),
    batch: async rows => rows.forEach(row => inserted.push(row.args)),
  } };
  const id = randomUUID();
  const response = await worker.fetch(new Request("https://service.test/v1/diagnostics", {
    method: "POST", headers: { authorization: `Bearer ${env.INGEST_TOKEN}` },
    body: JSON.stringify({ events: [{ id, timestamp: new Date().toISOString(), appVersion: "1.6.11", stage: "refresh_succeeded", ok: true, deviceId: "d-0123456789abcdef0123456789abcdef", authorityId: "tek-stock-independent-v1", revision: 149, pending: 0, recovered: true, message: "private" }] }),
  }), env);
  assert.equal(response.status, 202);
  assert.deepEqual(inserted[0].slice(0, 11), [id, inserted[0][1], inserted[0][2], "1.6.11", "refresh_succeeded", "", "d-0123456789abcdef0123456789abcdef", "tek-stock-independent-v1", 1, 1, 149]);
  const listed = await worker.fetch(new Request("https://service.test/v1/incidents", { headers: { authorization: `Bearer ${env.MONITOR_TOKEN}` } }), env);
  const body = await listed.json();
  assert.equal(body.incidents[0].state, "recovered");
  assert.equal(body.incidents[0].deviceId, "d-0123456789abcdef0123456789abcdef");
  assert.equal(JSON.stringify(body), JSON.stringify(body).replace("private", ""));
});

test("legacy diagnostic rows remain readable without being attributed to a device", async () => {
  const worker = (await import("../maintenance-worker/worker.mjs")).default;
  const env = { MONITOR_TOKEN: "m".repeat(32), DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ device_id: "legacy", authority_id: "unknown", app_version: "1.6.8", incident_stage: "cloud_download", last_event_stage: "cloud_download", error_code: "CLOUD_UNAVAILABLE", ok: 0, recovered: 0, revision: null, pending_count: null, occurrences: 1, first_seen: "2026-09-22T00:00:00.000Z", last_seen: "2026-09-22T00:00:00.000Z" }] }) }) }) } };
  const response = await worker.fetch(new Request("https://service.test/v1/incidents", { headers: { authorization: `Bearer ${env.MONITOR_TOKEN}` } }), env);
  const incident = (await response.json()).incidents[0];
  assert.equal(incident.deviceId, null);
  assert.equal(incident.deviceKnown, false);
  assert.equal(incident.state, "active");
});

test("SQLite incident ordering keeps a same-batch recovery and rejects delayed older failures", async () => {
  const worker = (await import("../maintenance-worker/worker.mjs")).default;
  const database = new DatabaseSync(":memory:");
  database.exec(require("node:fs").readFileSync("maintenance-worker/schema.sql", "utf8"));
  const env = { INGEST_TOKEN: "i".repeat(32), MONITOR_TOKEN: "m".repeat(32), DB: {
    prepare: sql => ({ bind: (...args) => ({ sql, args, all: async () => ({ results: database.prepare(sql).all(...args) }) }) }),
    batch: async rows => rows.forEach(row => database.prepare(row.sql).run(...row.args)),
  } };
  const deviceId = "d-0123456789abcdef0123456789abcdef";
  const headers = { authorization: `Bearer ${env.INGEST_TOKEN}` };
  const send = events => worker.fetch(new Request("https://service.test/v1/diagnostics", { method: "POST", headers, body: JSON.stringify({ events }) }), env);
  await send([
    { id: randomUUID(), timestamp: "2026-09-22T00:00:00.000Z", appVersion: "1.6.11", stage: "refresh_failed", errorCode: "CLOUD_UNAVAILABLE", deviceId, eventSequence: 1 },
    { id: randomUUID(), timestamp: "2026-09-22T00:00:00.000Z", appVersion: "1.6.11", stage: "refresh_succeeded", ok: true, recovered: true, deviceId, eventSequence: 2 },
  ]);
  await send([{ id: randomUUID(), timestamp: "2026-09-21T23:59:00.000Z", appVersion: "1.6.11", stage: "refresh_failed", errorCode: "CLOUD_UNAVAILABLE", deviceId, eventSequence: 99 }]);
  const listed = await worker.fetch(new Request("https://service.test/v1/incidents?since=2026-09-21T00:00:00.000Z", { headers: { authorization: `Bearer ${env.MONITOR_TOKEN}` } }), env);
  const incident = (await listed.json()).incidents.find(value => value.deviceId === deviceId);
  assert.equal(incident.state, "recovered");
  assert.equal(incident.lastEventStage, "refresh_succeeded");
});
