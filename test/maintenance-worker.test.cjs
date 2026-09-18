"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
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
