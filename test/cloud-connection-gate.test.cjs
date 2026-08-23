"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCentralSync } = require("../central-sync.cjs");

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-tek-stock-authority-id": "tek-stock-test" },
  });
}

function makeSync(directory, fetchImpl) {
  return createCentralSync({
    storageDirectory: directory,
    fetchImpl,
    getApiBaseUrl: () => "https://api.test",
    getApiFallbackBaseUrls: () => [],
    getAuthorityId: () => "tek-stock-test",
    getOssBaseUrl: () => "https://oss.test",
  });
}

test("cloud read reports a concrete network error and never produces a live snapshot while offline", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-cloud-gate-offline-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const sync = makeSync(directory, async () => {
    calls += 1;
    throw new TypeError("fetch failed: network is offline");
  });
  await assert.rejects(sync.snapshot(false), (error) => error.code === "API_NETWORK_UNREACHABLE");
  assert.equal(calls, 2, "a transient read is retried once, never looped");
});

test("cloud read reconnects after one transient failure and returns live data", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-cloud-gate-reconnect-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const sync = makeSync(directory, async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed: temporary network error");
    return json({ revision: 202, changeSequence: 0, items: [], updatedAt: "2026-08-07T00:00:00Z" });
  });
  const snapshot = await sync.snapshot(false);
  assert.equal(snapshot.cloudState, "live");
  assert.equal(snapshot.revision, 202);
  assert.equal(calls, 2);
});

test("legacy cloud IDs remain readable for migration, while mutation still fails closed", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-cloud-gate-legacy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacyId = "餐桌椅数量.xlsx::餐椅数量::24";
  const sync = makeSync(directory, async () => json({
    revision: 203,
    changeSequence: 0,
    items: [{ id: legacyId, model: "5566-TEST", category: "Chair", stock: 2 }],
  }));
  const snapshot = await sync.snapshot(false);
  assert.equal(snapshot.cloudState, "live");
  assert.equal(snapshot.identityState, "legacy");
  assert.equal(snapshot.legacyItemCount, 1);
  assert.equal(snapshot.items[0].id, legacyId);
  assert.throws(() => sync.enqueue([{ type: "delete", itemId: legacyId }]), {
    code: "SYNC_OPERATION_INVALID",
  });
});

test("app keeps the Excel read gate and exposes the cloud error code", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "inventory", "app.js"), "utf8");
  assert.match(source, /const explicit = String\(error\?\.code \|\| ""\)/);
  assert.match(source, /cloudLastErrorCode\s*=\s*diagnosticErrorCode\(error,\s*"CLOUD_DOWNLOAD_FAILED"\)/);
  assert.match(source, /云端未连接（\$\{cloudLastErrorCode \|\| "CLOUD_UNAVAILABLE"\}）/);
  assert.match(source, /未读取 Excel，避免覆盖资料/);
});
