"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { createCentralSync, sha256 } = require("../central-sync.cjs");
const { listSyncConflicts, resolveSyncConflict } = require("../main.cjs");

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-tek-stock-authority-id": "tek-stock-hangzhou-v1",
    },
  });
}

function fakeAlibabaApi(initialItems = []) {
  const state = { revision: 0, updatedAt: null, items: structuredClone(initialItems) };
  const uploads = new Map();
  const changes = [];
  const auditHistory = [];
  const opIds = [];
  const batchRequests = [];
  const batchStatuses = [];
  const idempotentResults = new Map();
  const requests = { snapshots: 0, changes: 0, changeQueries: [] };
  let lastPresign;
  let lastCommit;
  let failBatchOnce = false;
  let dropBatchResponseOnce = false;
  const interposedBatches = [];
  function applyExternalUpsert(item, operator = "other-desktop") {
    const map = new Map(state.items.map((candidate) => [candidate.id, candidate]));
    const before = map.get(item.id);
    map.set(item.id, structuredClone(item));
    state.items = [...map.values()];
    state.revision += 1;
    state.updatedAt = new Date(1_700_000_000_000 + state.revision).toISOString();
    changes.push({ revision: state.revision, sequence: 0, operation: "upsert", itemId: item.id,
      item: structuredClone(item), operator, createdAt: state.updatedAt });
    auditHistory.push({ operator, occurredAt: state.updatedAt, type: "upsert",
      itemId: item.id, before: structuredClone(before ?? null), after: structuredClone(item) });
  }
  return {
    state,
    requests,
    uploads,
    failNextBatch() { failBatchOnce = true; },
    dropNextBatchResponse() { dropBatchResponseOnce = true; },
    interposeNextBatch(item, operator) { interposedBatches.push({ item, operator }); },
    async fetch(url, init = {}) {
      const parsed = new URL(url);
      if (parsed.hostname === "api.test" && parsed.pathname === "/v1/snapshot") {
        requests.snapshots += 1;
        return json({ app: "TEK STOCK", ...structuredClone(state), fingerprint: "f", photoFingerprint: "p" });
      }
      if (parsed.hostname === "api.test" && parsed.pathname === "/v1/changes") {
        requests.changes += 1;
        const after = Number(parsed.searchParams.get("after_revision") || 0);
        const afterSequenceValue = parsed.searchParams.get("after_sequence");
        const afterSequence = afterSequenceValue == null ? null : Number(afterSequenceValue);
        const limit = Number(parsed.searchParams.get("limit") || 500);
        requests.changeQueries.push(Object.fromEntries(parsed.searchParams));
        const matches = changes.filter((event) => event.revision > after
          || (afterSequence != null && event.revision === after && event.sequence > afterSequence));
        const events = matches.slice(0, limit);
        return json({ fromRevision: after, toRevision: events.at(-1)?.revision ?? after,
          fromSequence: afterSequence, toSequence: events.at(-1)?.sequence ?? afterSequence,
          currentRevision: state.revision, hasMore: matches.length > events.length,
          events: structuredClone(events) });
      }
      if (parsed.hostname === "api.test" && parsed.pathname === "/v1/items/batch") {
        const opId = init.headers["idempotency-key"];
        const rawBody = String(init.body || "");
        opIds.push(opId);
        batchRequests.push({ opId, rawBody, body: JSON.parse(rawBody) });
        if (failBatchOnce) {
          failBatchOnce = false;
          throw new Error("network down");
        }
        if (idempotentResults.has(opId)) {
          const prior = idempotentResults.get(opId);
          if (prior.rawBody !== rawBody) {
            batchStatuses.push(409);
            return json({ code: "IDEMPOTENCY_CONFLICT" }, 409);
          }
          batchStatuses.push(200);
          return json(prior.result);
        }
        const body = JSON.parse(rawBody);
        if (interposedBatches.length) {
          const pending = interposedBatches.shift();
          applyExternalUpsert(pending.item, pending.operator);
        }
        if (body.expectedRevision !== state.revision) {
          batchStatuses.push(409);
          return json({ code: "REVISION_CONFLICT", currentRevision: state.revision }, 409);
        }
        const map = new Map(state.items.map((item) => [item.id, item]));
        const nextRevision = state.revision + 1;
        let sequence = 0;
        for (const operation of body.operations) {
          const before = map.get(operation.item?.id || operation.itemId);
          if (operation.type === "upsert") {
            map.set(operation.item.id, operation.item);
            changes.push({ revision: nextRevision, sequence: sequence++, operation: "upsert", itemId: operation.item.id,
              item: operation.item, createdAt: new Date(1_700_000_000_000 + nextRevision).toISOString() });
          } else {
            map.delete(operation.itemId);
            changes.push({ revision: nextRevision, sequence: sequence++, operation: "delete", itemId: operation.itemId,
              item: null, createdAt: new Date(1_700_000_000_000 + nextRevision).toISOString() });
          }
          auditHistory.push({
            operator: decodeURIComponent(init.headers["x-tek-stock-operator"] || ""),
            occurredAt: init.headers["x-tek-stock-occurred-at"],
            type: operation.type,
            itemId: operation.item?.id || operation.itemId,
            before: structuredClone(before ?? null),
            after: structuredClone(operation.item ?? null),
          });
        }
        state.items = [...map.values()];
        state.revision = nextRevision;
        state.updatedAt = new Date(1_700_000_000_000 + state.revision).toISOString();
        const result = { ok: true, revision: state.revision, updatedAt: state.updatedAt };
        idempotentResults.set(opId, { rawBody, result });
        if (dropBatchResponseOnce) {
          dropBatchResponseOnce = false;
          throw new Error("response lost after commit");
        }
        batchStatuses.push(200);
        return json(result);
      }
      if (parsed.hostname === "api.test" && parsed.pathname === "/v1/photos/presign") {
        const body = JSON.parse(init.body);
        lastPresign = body;
        const objectKey = `photos/tek-stock/${body.sha256.slice(0, 2)}/${body.sha256}.webp`;
        return json({ ok: true, objectKey, uploadUrl: `https://oss.test/upload/${body.sha256}`,
          headers: { "content-type": body.mimeType, "content-md5": body.contentMd5,
            "x-oss-forbid-overwrite": "true", "x-oss-meta-sha256": body.sha256 } });
      }
      if (parsed.hostname === "api.test" && parsed.pathname === "/v1/photos/commit") {
        const body = JSON.parse(init.body);
        lastCommit = body;
        const item = state.items.find((candidate) => candidate.id === body.itemId);
        if (!item) return json({ code: "ITEM_NOT_FOUND" }, 404);
        item.image = body.objectKey;
        item.imageSha256 = body.sha256;
        item.imageVersion = body.imageVersion;
        state.revision += 1;
        state.updatedAt = new Date(1_700_000_000_000 + state.revision).toISOString();
        changes.push({ revision: state.revision, sequence: 0, operation: "upsert", itemId: item.id,
          item: structuredClone(item), createdAt: state.updatedAt });
        return json({ ok: true, revision: state.revision, updatedAt: state.updatedAt });
      }
      if (parsed.hostname === "oss.test" && parsed.pathname.startsWith("/upload/")) {
        const digest = parsed.pathname.split("/").at(-1);
        assert.deepEqual(init.headers, {
          "content-type": lastPresign.mimeType,
          "content-md5": lastPresign.contentMd5,
          "x-oss-forbid-overwrite": "true",
          "x-oss-meta-sha256": lastPresign.sha256,
        });
        if (uploads.has(digest)) return new Response(null, { status: 409 });
        uploads.set(digest, Buffer.from(init.body));
        return new Response(null, { status: 200, headers: { etag: "test-etag" } });
      }
      if (parsed.hostname === "oss.test" && parsed.pathname.startsWith("/photos/")) {
        const digest = path.posix.basename(parsed.pathname).split(".")[0];
        const bytes = uploads.get(digest);
        return bytes
          ? new Response(bytes, { status: 200, headers: { "content-type": "image/webp" } })
          : new Response(null, { status: 404 });
      }
      return json({ code: "NOT_FOUND" }, 404);
    },
    get lastPresign() { return lastPresign; },
    get lastCommit() { return lastCommit; },
    auditHistory,
    batchRequests,
    batchStatuses,
    opIds,
  };
}

function service(directory, api, options = {}) {
  return createCentralSync({
    storageDirectory: directory,
    fetchImpl: api.fetch,
    getApiBaseUrl: () => "https://api.test",
    getOssBaseUrl: () => "https://oss.test",
    getToken: () => "write-token",
    ...options,
  });
}

test("read requests time out per endpoint and fail over within one Alibaba authority", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-api-read-failover-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const sync = createCentralSync({
    storageDirectory: directory,
    getApiBaseUrl: () => "https://primary.test",
    getApiFallbackBaseUrls: () => ["https://singapore-proxy.test"],
    getAuthorityId: () => "tek-stock-hangzhou-v1",
    getOssBaseUrl: () => "https://oss.test",
    requestTimeoutMs: 25,
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
      calls.push({ host: parsed.hostname, authority: init.headers["x-tek-stock-authority-id"] });
      if (parsed.hostname === "primary.test") {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      }
      return json({ revision: 7, changeSequence: 0, items: [], updatedAt: "2026-08-03T00:00:00Z" });
    },
  });
  const snapshot = await sync.snapshot(false);
  assert.equal(snapshot.cloudState, "live");
  assert.equal(snapshot.revision, 7);
  assert.deepEqual(calls, [
    { host: "primary.test", authority: "tek-stock-hangzhou-v1" },
    { host: "singapore-proxy.test", authority: "tek-stock-hangzhou-v1" },
  ]);
});

test("workbook bridge failure is not reported as a successful sync", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-bridge-failure-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const api = fakeAlibabaApi([{ id: "5566-test-id", model: "5566-TEST", category: "Chair", stock: 2 }]);
  const sync = service(directory, api);
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "isolated-workbook-sha",
      items: [],
      sync: { revision: 0, itemCount: 0 },
      baseline: { revision: 0, itemCount: 0, records: [] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async () => { throw Object.assign(new Error("binding failed"), { code: "EXCEL_BINDING_FAILED" }); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.workbookAcknowledged, false);
  assert.equal(result.errorCode, "EXCEL_BINDING_FAILED");
});

test("client errors do not cross endpoints", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-api-no-4xx-failover-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let fallbackCalls = 0;
  const sync = createCentralSync({
    storageDirectory: directory,
    getApiBaseUrl: () => "https://primary.test",
    getApiFallbackBaseUrls: () => ["https://singapore-proxy.test"],
    getAuthorityId: () => "tek-stock-hangzhou-v1",
    getOssBaseUrl: () => "https://oss.test",
    fetchImpl: async (url) => {
      if (new URL(url).hostname === "primary.test") return json({ code: "UNAUTHORIZED" }, 401);
      fallbackCalls += 1;
      return json({ revision: 0, items: [] });
    },
  });
  await assert.rejects(sync.snapshot(false), (error) =>
    error.code === "UNAUTHORIZED" && error.status === 401);
  assert.equal(fallbackCalls, 0);
});

test("an idempotent write keeps its key and token when a 5xx fails over", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-api-write-failover-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const state = { revision: 0, items: [], updatedAt: null };
  const batchCalls = [];
  const sync = createCentralSync({
    storageDirectory: directory,
    getApiBaseUrl: () => "https://primary.test",
    getApiFallbackBaseUrls: () => ["https://singapore-proxy.test"],
    getAuthorityId: () => "tek-stock-hangzhou-v1",
    getOssBaseUrl: () => "https://oss.test",
    getToken: () => "write-token",
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/snapshot") {
        return json({ ...structuredClone(state), changeSequence: 0 });
      }
      if (parsed.pathname === "/v1/items/batch") {
        batchCalls.push({ host: parsed.hostname, idempotencyKey: init.headers["idempotency-key"],
          authorization: init.headers.authorization,
          authority: init.headers["x-tek-stock-authority-id"] });
        if (parsed.hostname === "primary.test") return json({ code: "UPSTREAM_UNAVAILABLE" }, 503);
        const body = JSON.parse(init.body);
        state.items = body.operations.map((operation) => structuredClone(operation.item));
        state.revision += 1;
        state.updatedAt = "2026-08-03T00:00:00Z";
        return json({ ok: true, revision: state.revision, updatedAt: state.updatedAt });
      }
      return json({ code: "NOT_FOUND" }, 404);
    },
  });
  const entry = sync.enqueue([{ type: "create", itemId: "failover-id", item: {
    id: "failover-id", model: "FAILOVER", category: "Chair", stock: 1,
  } }])[0];
  await sync.flush();
  assert.equal(state.items[0].id, "failover-id");
  assert.deepEqual(batchCalls, [
    { host: "primary.test", idempotencyKey: entry.opId, authorization: "Bearer write-token",
      authority: "tek-stock-hangzhou-v1" },
    { host: "singapore-proxy.test", idempotencyKey: entry.opId, authorization: "Bearer write-token",
      authority: "tek-stock-hangzhou-v1" },
  ]);
});

test("photo presign is explicitly safe to fail over before immutable OSS upload", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-presign-failover-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const api = fakeAlibabaApi([
    { id: "photo-id", model: "PHOTO", category: "Chair", stock: 1 },
  ]);
  const presignHosts = [];
  const sync = createCentralSync({
    storageDirectory: directory,
    getApiBaseUrl: () => "https://primary.test",
    getApiFallbackBaseUrls: () => ["https://singapore-proxy.test"],
    getAuthorityId: () => "tek-stock-hangzhou-v1",
    getOssBaseUrl: () => "https://oss.test",
    getToken: () => "write-token",
    fetchImpl: async (url, init = {}) => {
      const parsed = new URL(url);
      if (["primary.test", "singapore-proxy.test"].includes(parsed.hostname)) {
        if (parsed.pathname === "/v1/photos/presign") {
          presignHosts.push(parsed.hostname);
          if (parsed.hostname === "primary.test") return json({ code: "UPSTREAM_UNAVAILABLE" }, 503);
        }
        parsed.hostname = "api.test";
      }
      return api.fetch(parsed, init);
    },
  });
  const bytes = Buffer.from("safe-presign-failover-photo");
  const result = await sync.replacePhoto("photo-id",
    `data:image/webp;base64,${bytes.toString("base64")}`);
  assert.match(result.imageSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(presignHosts, ["primary.test", "singapore-proxy.test"]);
});

test("central outbox replays the same operation after restart, then updates and deletes by exact ID", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-central-sync-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const api = fakeAlibabaApi();
  const first = service(directory, api);
  const pending = first.enqueue([{ type: "create", itemId: "permanent-1", item: {
    id: "permanent-1", model: "TEST", category: "Chair", stock: 1,
  } }])[0];
  api.failNextBatch();
  await assert.rejects(first.flush(), /network down/);
  const restarted = service(directory, api);
  await restarted.flush();
  assert.equal(api.state.items[0].id, "permanent-1");
  assert.equal(api.opIds[0], pending.opId);
  assert.equal(api.opIds[1], pending.opId);

  restarted.enqueue([{ type: "update", itemId: "permanent-1", patch: { stock: 7 } }]);
  await restarted.flush();
  assert.equal(api.state.items[0].stock, 7);
  restarted.enqueue([{ type: "delete", itemId: "permanent-1" }]);
  await restarted.flush();
  assert.equal(api.state.items.length, 0);
  assert.equal(restarted.outbox.retryable().length, 0);
});

test("photo upload and cache are atomic, SHA-verified, and keyed by product ID plus digest", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-photo-cache-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const api = fakeAlibabaApi([
    { id: "product-a", model: "A", category: "Chair", stock: 1 },
    { id: "product-b", model: "B", category: "Chair", stock: 2 },
  ]);
  const sync = service(directory, api);
  const bytes = Buffer.from("verified-photo-content");
  const dataUrl = `data:image/webp;base64,${bytes.toString("base64")}`;
  const first = await sync.replacePhoto("product-a", dataUrl);
  const replay = await sync.replacePhoto("product-a", dataUrl);
  const second = await sync.replacePhoto("product-b", dataUrl);
  assert.equal(first.imageSha256, sha256(bytes));
  assert.equal(second.imageSha256, first.imageSha256);
  assert.equal(replay.imageSha256, first.imageSha256);
  const expectedMd5 = require("node:crypto").createHash("md5").update(bytes).digest("base64");
  assert.equal(api.lastPresign.contentMd5, expectedMd5);
  assert.equal(api.lastCommit.contentMd5, expectedMd5);
  assert.notEqual(first.image, second.image);
  assert.equal(fs.readFileSync(new URL(first.image)).equals(bytes), true);
  assert.equal(fs.readFileSync(new URL(second.image)).equals(bytes), true);
  const abandoned = fs.readdirSync(path.join(directory, "photo-cache"), { recursive: true })
    .filter((name) => String(name).endsWith(".part"));
  assert.deepEqual(abandoned, []);
  const snapshot = await sync.snapshot(false);
  assert.match(snapshot.items[0].image, /^file:\/\//);
  assert.match(snapshot.items[1].image, /^file:\/\//);
});

test("two stale clients cannot overwrite photos and both explicit resolutions survive restart", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-photo-concurrency-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalBytes = Buffer.from("original-photo");
  const originalHash = sha256(originalBytes);
  const api = fakeAlibabaApi([{
    id: "photo-item",
    model: "PHOTO ITEM",
    category: "Chair",
    stock: 1,
    image: `photos/photo-item/${originalHash}.webp`,
    imageSha256: originalHash,
    imageVersion: `sha256-${originalHash.slice(0, 24)}`,
  }]);
  const makeClient = (name) => service(path.join(root, name), api);
  const photoInput = (value) => {
    const bytes = Buffer.from(value);
    return {
      bytes,
      dataUrl: `data:image/webp;base64,${bytes.toString("base64")}`,
      hash: sha256(bytes),
    };
  };
  const expected = (item) => ({
    imageSha256: String(item.imageSha256 || ""),
    imageVersion: String(item.imageVersion || ""),
  });

  const first = makeClient("first");
  const second = makeClient("second");
  const firstBase = (await first.canonicalSnapshot()).items[0];
  const secondBase = (await second.canonicalSnapshot()).items[0];
  const firstPhoto = photoInput("first-client-photo");
  const secondPhoto = photoInput("second-client-photo");
  await first.replacePhoto("photo-item", firstPhoto.dataUrl, expected(firstBase));
  await assert.rejects(
    second.replacePhoto("photo-item", secondPhoto.dataUrl, expected(secondBase)),
    { code: "CONCURRENT_MODIFICATION" },
  );
  assert.equal(api.state.items[0].imageSha256, firstPhoto.hash);

  const restartedSecond = makeClient("second");
  const keepCloudConflicts = await listSyncConflicts(restartedSecond);
  assert.equal(keepCloudConflicts.length, 1);
  assert.deepEqual(keepCloudConflicts[0].conflicts.map((conflict) => ({
    field: conflict.field,
    base: conflict.base,
    excel: conflict.excel,
    cloud: conflict.cloud,
  })), [{
    field: "image",
    base: originalHash,
    excel: secondPhoto.hash,
    cloud: firstPhoto.hash,
  }]);
  await resolveSyncConflict({
    opId: keepCloudConflicts[0].opId,
    resolutions: [{ itemId: "photo-item", field: "image", choice: "keep-cloud" }],
  }, { service: restartedSecond, replaceWorkbook: async () => ({ ok: true }) });
  assert.equal(api.state.items[0].imageSha256, firstPhoto.hash);

  const third = makeClient("third");
  const fourth = makeClient("fourth");
  const thirdBase = (await third.canonicalSnapshot()).items[0];
  const fourthBase = (await fourth.canonicalSnapshot()).items[0];
  const thirdPhoto = photoInput("third-client-photo");
  const fourthPhoto = photoInput("fourth-client-photo");
  await third.replacePhoto("photo-item", thirdPhoto.dataUrl, expected(thirdBase));
  await assert.rejects(
    fourth.replacePhoto("photo-item", fourthPhoto.dataUrl, expected(fourthBase)),
    { code: "CONCURRENT_MODIFICATION" },
  );
  assert.equal(api.state.items[0].imageSha256, thirdPhoto.hash);

  const restartedFourth = makeClient("fourth");
  const keepExcelConflicts = await listSyncConflicts(restartedFourth);
  assert.equal(keepExcelConflicts.length, 1);
  await resolveSyncConflict({
    opId: keepExcelConflicts[0].opId,
    resolutions: [{ itemId: "photo-item", field: "image", choice: "keep-excel" }],
  }, { service: restartedFourth, replaceWorkbook: async () => ({ ok: true }) });
  assert.equal(api.state.items[0].imageSha256, fourthPhoto.hash);

  const mobile = service(path.join(root, "mobile"), api, { readOnly: true });
  const mobileSnapshot = await mobile.canonicalSnapshot();
  assert.equal(mobileSnapshot.items[0].imageSha256, fourthPhoto.hash);
  assert.equal(mobileSnapshot.items[0].image, api.state.items[0].image);
  await assert.rejects(
    mobile.replacePhoto("photo-item", firstPhoto.dataUrl, expected(mobileSnapshot.items[0])),
    { code: "READ_ONLY_CLIENT" },
  );
});

test("desktop photo replace satisfies the real backend presign, PUT, and commit contract", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-photo-contract-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const backendRoot = path.resolve(__dirname, "..", "..", "aliyun-stock-sync", "src");
  if (!fs.existsSync(path.join(backendRoot, "app.mjs"))) {
    t.skip("legacy Alibaba photo backend is not part of this Cloudflare build");
    return;
  }
  const [{ createApp }, { MemoryRepository }, { productIdSha256 }] = await Promise.all([
    import(pathToFileURL(path.join(backendRoot, "app.mjs"))),
    import(pathToFileURL(path.join(backendRoot, "memory-repository.mjs"))),
    import(pathToFileURL(path.join(backendRoot, "photo-key.mjs"))),
  ]);
  const itemId = "photo-contract-item";
  const bytes = Buffer.from("desktop-to-backend-photo-contract");
  const digest = sha256(bytes);
  const contentMd5 = require("node:crypto").createHash("md5").update(bytes).digest("base64");
  const repository = new MemoryRepository([
    { id: itemId, model: "PHOTO", category: "Chair", stock: 1, image: "" },
  ], { revision: 7 });
  const config = {
    tenantId: "tek-stock", authorityId: "tek-stock-hangzhou-v1",
    uploadToken: "desktop-contract-token",
    corsAllowedOrigins: ["*"], bodyLimitBytes: 1_000_000,
    oss: {
      endpoint: "oss-cn-hangzhou.aliyuncs.com", bucket: "tek-stock-photos",
      publicBaseUrl: "https://photos.test", presignTtlSeconds: 900,
    },
  };
  let uploadedHeaders;
  const backend = createApp({
    repository, config,
    clock: () => new Date("2026-08-01T02:03:04.000Z"),
    ossCredentialProvider: async () => ({
      accessKeyId: "temporary-id", accessKeySecret: "temporary-secret",
      securityToken: "temporary-security-token",
    }),
    fetchImpl: async (_url, init) => {
      assert.equal(init.method, "HEAD");
      return new Response(null, { status: 200, headers: {
        "content-length": String(bytes.length), "content-type": "image/webp",
        "x-oss-meta-sha256": digest,
        "x-oss-meta-product-id-sha256": productIdSha256(itemId),
        etag: `"${Buffer.from(contentMd5, "base64").toString("hex")}"`,
      } });
    },
  });
  const fetchImpl = async (url, init = {}) => {
    if (new URL(url).hostname === "api.test") {
      return backend.handleRequest(new Request(url, init));
    }
    uploadedHeaders = Object.fromEntries(new Headers(init.headers));
    assert.equal(Buffer.from(init.body).equals(bytes), true);
    return new Response(null, { status: 200, headers: {
      etag: `"${Buffer.from(contentMd5, "base64").toString("hex")}"`,
    } });
  };
  const sync = createCentralSync({
    storageDirectory: directory, fetchImpl,
    getApiBaseUrl: () => "https://api.test",
    getAuthorityId: () => "tek-stock-hangzhou-v1",
    getOssBaseUrl: () => "https://photos.test",
    getToken: () => "desktop-contract-token",
  });
  const result = await sync.replacePhoto(itemId,
    `data:image/webp;base64,${bytes.toString("base64")}`);
  assert.equal(result.revision, 8);
  assert.deepEqual(uploadedHeaders, {
    "content-md5": contentMd5,
    "content-type": "image/webp",
    "x-oss-forbid-overwrite": "true",
    "x-oss-meta-product-id-sha256": productIdSha256(itemId),
    "x-oss-meta-sha256": digest,
    "x-oss-security-token": "temporary-security-token",
  });
  const snapshot = await (await backend.handleRequest(
    new Request("https://api.test/v1/snapshot"))).json();
  assert.equal(snapshot.items[0].imageSha256, digest);
  assert.equal(snapshot.items[0].image,
    `photos/tek-stock/products/${productIdSha256(itemId)}/${digest}.webp`);
});

test("a lost success response is recognized from authoritative state after restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-lost-response-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const api = fakeAlibabaApi([{ id: "exact-id", model: "A", category: "Chair", stock: 1 }]);
  const first = service(directory, api);
  first.enqueue([{ type: "update", itemId: "exact-id", patch: { stock: 12 } }]);
  api.dropNextBatchResponse();
  await assert.rejects(first.flush(), /response lost after commit/);
  assert.equal(api.state.items[0].stock, 12);
  const restarted = service(directory, api);
  await restarted.flush();
  assert.equal(restarted.outbox.retryable().length, 0);
  assert.equal(api.opIds.length, 1);
});

test("two desktops converge with a read-only mobile after concurrent and offline additions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-isolated-clients-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const api = fakeAlibabaApi();
  const first = service(path.join(directory, "desktop-a"), api, {
    operator: "alice@desktop-a", now: () => "2026-08-05T01:02:03.000Z",
  });
  const second = service(path.join(directory, "desktop-b"), api, {
    operator: "bob@desktop-b", now: () => "2026-08-05T01:02:04.000Z",
  });
  const mobile = service(path.join(directory, "mobile"), api, { readOnly: true });
  await Promise.all([first.snapshot(false), second.snapshot(false), mobile.snapshot(false)]);

  first.enqueue([{ type: "create", itemId: "row-5-z", item: {
    id: "row-5-z", model: "MODEL-Z", category: "Chair", stock: 1, sourceRow: 5,
  } }]);
  second.enqueue([{ type: "create", itemId: "row-5-a", item: {
    id: "row-5-a", model: "MODEL-A", category: "Chair", stock: 2, sourceRow: 5,
  } }]);
  await Promise.all([first.flush(), second.flush()]);

  const concurrent = await mobile.snapshot(false);
  assert.deepEqual(concurrent.items.map((item) => item.id), ["row-5-a", "row-5-z"]);
  assert.deepEqual(concurrent.items.map((item) => item.model), ["MODEL-A", "MODEL-Z"]);
  assert.throws(() => mobile.enqueue([{ type: "delete", itemId: "row-5-a" }]), {
    code: "READ_ONLY_CLIENT",
  });

  let offline = true;
  const recoveryDirectory = path.join(directory, "offline-desktop");
  const offlineClient = service(recoveryDirectory, api, {
    operator: "carol@desktop-c",
    fetchImpl: (...args) => offline ? Promise.reject(new Error("offline")) : api.fetch(...args),
  });
  offlineClient.enqueue([{ type: "create", itemId: "row-5-m", item: {
    id: "row-5-m", model: "MODEL-M", category: "Chair", stock: 3, sourceRow: 5,
  } }]);
  await assert.rejects(offlineClient.flush(), /offline/);
  offline = false;
  const recovered = service(recoveryDirectory, api, { operator: "carol@desktop-c" });
  await recovered.flush();

  const eventual = await mobile.snapshot(false);
  assert.equal(eventual.cloudState, "live");
  assert.deepEqual(eventual.items.map((item) => item.id), ["row-5-a", "row-5-m", "row-5-z"]);
  assert.deepEqual(recovered.history().map((event) => event.lifecycle), ["queued", "sent", "acked"]);
  assert.equal(recovered.history().every((event) => event.operator === "carol@desktop-c"), true);
});

test("same-model concurrent workbook appends receive distinct permanent IDs", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-same-model-appends-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = {
    id: "existing-row", model: "EXISTING", category: "Chair", stock: 1, sourceRow: 5,
  };
  const api = fakeAlibabaApi([original]);
  const first = service(path.join(directory, "first"), api, { operator: "first-desktop" });
  const second = service(path.join(directory, "second"), api, { operator: "second-desktop" });

  function callbacks(label) {
    let assignedId = "";
    return {
      get assignedId() { return assignedId; },
      readWorkbook: async () => ({
        ok: true,
        sha256: `${label}-${assignedId || "blank"}`,
        items: [original, {
          id: assignedId, model: "DUPLICATE-MODEL", category: "Chair", stock: 1, sourceRow: 6,
        }],
        sync: { revision: 0, itemCount: 1 },
        baseline: { revision: 0, itemCount: 1, records: [original] },
      }),
      assignIds: async (plans) => {
        assert.equal(plans.length, 1);
        assignedId = plans[0].id;
        return { ok: true };
      },
      acknowledge: async () => ({ ok: true }),
      replaceWorkbook: async () => ({ ok: true }),
    };
  }

  const firstWorkbook = callbacks("first");
  const secondWorkbook = callbacks("second");
  await Promise.all([
    first.syncWorkbook(firstWorkbook),
    second.syncWorkbook(secondWorkbook),
  ]);
  assert.ok(firstWorkbook.assignedId);
  assert.ok(secondWorkbook.assignedId);
  assert.notEqual(firstWorkbook.assignedId, secondWorkbook.assignedId);

  const mobile = service(path.join(directory, "mobile"), api, { readOnly: true });
  const snapshot = await mobile.snapshot(false);
  const additions = snapshot.items.filter((item) => item.model === "DUPLICATE-MODEL");
  assert.equal(additions.length, 2);
  assert.deepEqual(additions.map((item) => item.id),
    [firstWorkbook.assignedId, secondWorkbook.assignedId].sort());
  assert.equal(additions.every((item) => item.sourceRow === undefined), true,
    "physical Excel row locators must never be persisted as cloud identity");
});

test("a copied appended row gets a new ID without overwriting the original product", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-copied-row-id-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = {
    id: "existing-row", model: "ORIGINAL", category: "Chair", stock: 1,
  };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api, { operator: "singapore-desktop-2" });
  let replacementId = "";
  const workbook = () => ({
    ok: true,
    sha256: replacementId ? "after-safe-id-repair" : "before-safe-id-repair",
    items: [
      { ...original, sourceRow: 5 },
      { id: replacementId || original.id, model: "COPIED-AS-NEW", category: "Table", stock: 2,
        sourceRow: 6 },
    ],
    integrity: {
      itemRowCount: 2,
      itemIdsUnique: Boolean(replacementId),
      itemIdsDuplicateFree: Boolean(replacementId),
    },
    sync: { revision: 0, itemCount: 1, writtenAt: "2026-08-13T02:00:00.000Z" },
    mtimeMs: Date.parse("2026-08-13T02:00:05.000Z"),
    baseline: { revision: 0, itemCount: 1, records: [original] },
  });

  const result = await sync.syncWorkbook({
    readWorkbook: async () => workbook(),
    assignIds: async (plans, expectedSha) => {
      assert.equal(expectedSha, "before-safe-id-repair");
      assert.equal(plans.length, 1);
      assert.equal(plans[0].sourceRow, 6);
      assert.equal(plans[0].expectedId, original.id);
      replacementId = plans[0].id;
      return { ok: true };
    },
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async () => ({ ok: true }),
  });

  assert.equal(result.workbookAcknowledged, true, JSON.stringify(result));
  assert.equal(result.assignments, 1);
  assert.ok(replacementId);
  assert.notEqual(replacementId, original.id);
  assert.deepEqual(api.state.items.map((item) => item.id).sort(),
    [original.id, replacementId].sort());
  assert.equal(api.state.items.find((item) => item.id === original.id).model, "ORIGINAL");
  assert.equal(api.state.items.find((item) => item.id === replacementId).model, "COPIED-AS-NEW");
});

test("two copied unsynced append rows receive separate IDs and both reach every client", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-multi-copied-appends-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "original-id", model: "ORIGINAL", category: "Chair", stock: 1 };
  const missingOld = { id: "missing-old-id", model: "MISSING-OLD", category: "Chair", stock: 1 };
  const api = fakeAlibabaApi([original, missingOld]);
  const sync = service(directory, api, { operator: "singapore-desktop-3" });
  const assigned = new Map();
  const workbook = () => {
    const rawItems = [
      { ...original, sourceRow: 5 },
      { id: assigned.get(6) || "copied-hidden-id", model: "666", category: "Coffee table",
        stock: 1, sourceRow: 6 },
      { id: assigned.get(7) || "copied-hidden-id", model: "777", category: "Dining table",
        stock: 3, sourceRow: 7 },
    ];
    return {
      ok: true,
      sha256: assigned.size ? "after-multi-repair" : "before-multi-repair",
      // The real Excel reader retains both rows in rawItems but normalization
      // collapses a copied duplicate ID to its last visible row.
      rawItems,
      items: assigned.size === 2 ? rawItems : [rawItems[0], rawItems[2]],
      integrity: { itemRowCount: 3, itemIdsUnique: assigned.size === 2,
        itemIdsDuplicateFree: assigned.size === 2 },
      sync: { revision: 0, itemCount: 2 },
      baseline: { revision: 0, itemCount: 2, records: [original, missingOld] },
    };
  };

  const result = await sync.syncWorkbook({
    readWorkbook: async () => workbook(),
    assignIds: async (plans, expectedSha) => {
      assert.equal(expectedSha, "before-multi-repair");
      assert.deepEqual(plans.map((plan) => plan.sourceRow), [6, 7]);
      assert.equal(plans.every((plan) => plan.expectedId === "copied-hidden-id"), true);
      plans.forEach((plan) => assigned.set(plan.sourceRow, plan.id));
      return { ok: true };
    },
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async () => ({ ok: true }),
  });

  assert.equal(result.workbookAcknowledged, true, JSON.stringify(result));
  assert.equal(result.assignments, 2);
  assert.equal(new Set(assigned.values()).size, 2);
  const mobile = service(path.join(directory, "mobile"), api, { readOnly: true });
  const snapshot = await mobile.snapshot(false);
  assert.deepEqual(snapshot.items.filter((item) => ["666", "777"].includes(item.model))
    .map((item) => item.model).sort(), ["666", "777"]);
  assert.equal(snapshot.items.some((item) => item.id === missingOld.id), false);
});

test("one baseline product survives while two copied rows across the boundary sync separately", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-baseline-copy-boundary-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = {
    id: "existing-id", model: "ORIGINAL", category: "Dining chair", stock: 4,
    specification: "BASE",
  };
  const missingOld = { id: "missing-old-id", model: "MISSING-OLD", category: "Chair", stock: 1 };
  const api = fakeAlibabaApi([original, missingOld]);
  const sync = service(directory, api, { operator: "singapore-desktop-4" });
  const assigned = new Map();
  const workbook = () => {
    const rawItems = [
      { ...original, sourceRow: 5 },
      { id: assigned.get(6) || original.id, model: "666", category: "Coffee table",
        stock: 1, sourceRow: 6 },
      { id: assigned.get(7) || original.id, model: "777", category: "Dining table",
        stock: 3, sourceRow: 7 },
    ];
    return {
      ok: true,
      sha256: assigned.size ? "after-baseline-copy-repair" : "before-baseline-copy-repair",
      rawItems,
      items: assigned.size === 2 ? rawItems : [rawItems[2]],
      integrity: { itemRowCount: 3, itemIdsUnique: assigned.size === 2,
        itemIdsDuplicateFree: assigned.size === 2 },
      sync: { revision: 0, itemCount: 2 },
      baseline: { revision: 0, itemCount: 2, records: [original, missingOld] },
    };
  };

  const result = await sync.syncWorkbook({
    readWorkbook: async () => workbook(),
    assignIds: async (plans, expectedSha) => {
      assert.equal(expectedSha, "before-baseline-copy-repair");
      assert.deepEqual(plans.map((plan) => plan.sourceRow), [6, 7]);
      assert.equal(plans.every((plan) => plan.expectedId === original.id), true);
      plans.forEach((plan) => assigned.set(plan.sourceRow, plan.id));
      return { ok: true };
    },
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async () => ({ ok: true }),
  });

  assert.equal(result.workbookAcknowledged, true, JSON.stringify(result));
  assert.equal(result.assignments, 2);
  assert.equal(new Set(assigned.values()).size, 2);
  assert.equal(api.state.items.find((item) => item.id === original.id).model, original.model);
  assert.deepEqual(api.state.items.filter((item) => ["666", "777"].includes(item.model))
    .map((item) => item.model).sort(), ["666", "777"]);
  assert.equal(api.state.items.some((item) => item.id === missingOld.id), false);
});

test("legacy workbook gaps do not block safe copied-ID repair or create a cloud overwrite", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-legacy-gap-copy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacyId = "TEK-STOCK-LIVE.xlsx::Inventory::324";
  const original = {
    id: legacyId, model: "A5115", category: "Dining chair", stock: -2,
    showroomQuantity: 0, computedTotalSold: 14, totalSold: 14,
    cost: 120, sellingPrice: 240, specification: "DARK GRAY",
    arrival: "", showroom: "", outbound: "",
  };
  const missingOld = { id: "missing-old-id", model: "MISSING-OLD", category: "Chair", stock: 1 };
  const historic = Array.from({ length: 319 }, (_, index) => ({
    id: `historic-${index}`, model: `HISTORIC-${index}`, category: "Chair", stock: 0,
  }));
  const baselineRecords = [...historic, original, missingOld];
  const api = fakeAlibabaApi(baselineRecords);
  const sync = service(directory, api, { operator: "singapore-desktop-gap-test" });
  const assigned = new Map();
  const workbook = () => {
    const rawItems = [
      ...historic.map((item, index) => ({ ...item, sourceRow: index + 5 })),
      // Row 324 is intentionally blank/deleted in this legacy workbook.
      { ...original, sourceRow: 325 },
      { id: assigned.get(326) || legacyId, model: "666", category: "Coffee table",
        stock: 1, showroomQuantity: 2, computedTotalSold: 3, totalSold: 3,
        cost: 88, sellingPrice: 888, specification: "", arrival: "", showroom: "",
        outbound: "", sourceRow: 326 },
      { id: assigned.get(327) || legacyId, model: "777", category: "Dining table",
        stock: 3, showroomQuantity: 2, computedTotalSold: 1, totalSold: 1,
        cost: 77, sellingPrice: 777, specification: "", arrival: "", showroom: "",
        outbound: "", sourceRow: 327 },
    ];
    return {
      ok: true,
      sha256: assigned.size ? "after-legacy-gap-repair" : "before-legacy-gap-repair",
      rawItems,
      items: assigned.size === 2 ? rawItems : rawItems.filter((item) => item.model !== "666"),
      integrity: { itemRowCount: rawItems.length, itemIdsUnique: assigned.size === 2,
        itemIdsDuplicateFree: assigned.size === 2 },
      sync: { revision: 0, itemCount: 321 },
      baseline: { revision: 0, itemCount: 321, records: baselineRecords },
    };
  };
  const result = await sync.syncWorkbook({
    readWorkbook: async () => workbook(),
    assignIds: async (plans, expectedSha) => {
      assert.equal(expectedSha, "before-legacy-gap-repair");
      assert.deepEqual(plans.map((plan) => plan.sourceRow), [326, 327]);
      assert.equal(plans.every((plan) => plan.expectedId === legacyId), true);
      plans.forEach((plan) => assigned.set(plan.sourceRow, plan.id));
      return { ok: true };
    },
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async () => ({ ok: true }),
  });

  assert.equal(result.workbookAcknowledged, true, JSON.stringify(result));
  assert.equal(result.assignments, 2);
  assert.equal(api.state.items.find((item) => item.id === legacyId).model, "A5115");
  assert.deepEqual(api.state.items.filter((item) => ["666", "777"].includes(item.model))
    .map((item) => item.model).sort(), ["666", "777"]);
  assert.equal(api.state.items.some((item) => item.id === missingOld.id), false);
  assert.equal(api.state.items.filter((item) => /^HISTORIC-/.test(item.model)).length, 319);
  assert.equal(api.state.items.length, 322);
});

test("a unique legacy-ID row with a local photo requires explicit migration before any write", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-unique-legacy-append-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacyId = "old-stock.xlsx::Inventory::38";
  const stable = { id: "stable-id", model: "A5115", category: "Dining chair", stock: 1 };
  const legacyCloudItem = {
    id: legacyId, model: "OLD-LEGACY-PRODUCT", category: "Dining chair", stock: 1,
    image: "", imageSha256: "", imageVersion: "",
  };
  const photo = `data:image/png;base64,${Buffer.from("777-photo").toString("base64")}`;
  const api = fakeAlibabaApi([stable, legacyCloudItem]);
  const sync = service(directory, api, { operator: "singapore-boss-unique-legacy" });
  const assigned = new Map();
  const workbook = () => {
    const row777 = {
      id: assigned.get(6) || legacyId,
      model: "777",
      category: "Dining table",
      stock: 3,
      showroomQuantity: 2,
      computedTotalSold: 1,
      totalSold: 1,
      cost: 77,
      sellingPrice: 777,
      image: "",
      embeddedImageDataUrl: photo,
      embeddedImageHash: "777-photo-hash",
      imageChanged: false,
      imageUntracked: false,
      sourceRow: 6,
    };
    const rawItems = [{ ...stable, sourceRow: 5 }, row777];
    return {
      ok: true,
      sha256: assigned.size ? "after-unique-legacy-repair" : "before-unique-legacy-repair",
      rawItems,
      items: rawItems,
      integrity: { itemRowCount: 2, itemIdsUnique: true, itemIdsDuplicateFree: true },
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [stable] },
    };
  };

  await assert.rejects(sync.syncWorkbook({
    readWorkbook: async () => workbook(),
    assignIds: async (plans, expectedSha) => {
      assert.equal(expectedSha, "before-unique-legacy-repair");
      assert.deepEqual(plans.map((plan) => plan.sourceRow), [6]);
      assert.equal(plans[0].expectedId, legacyId);
      assigned.set(6, plans[0].id);
      return { ok: true };
    },
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async () => ({ ok: true }),
  }), { code: "WORKBOOK_IDENTITY_MIGRATION_REQUIRED" });

  assert.equal(assigned.size, 0);
  assert.equal(api.batchRequests.length, 0);
  assert.equal(api.state.items.find((item) => item.id === legacyId).model, "OLD-LEGACY-PRODUCT");
  assert.equal(api.state.items.some((item) => item.model === "777"), false);
  assert.equal(api.uploads.size, 0);
});

test("a photo-mismatched duplicate cannot rebind a permanent ID or write cloud data", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-photo-mismatch-copy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = {
    id: "permanent-product-id", model: "A5115", category: "Dining chair", stock: 1,
    stockText: "1", showroomQuantity: 0, computedTotalSold: 14, totalSold: 14,
    cost: 120, sellingPrice: 240, sellingPriceText: "S$ 240",
    specification: "DARK GRAY", arrival: "", showroom: "", outbound: "",
    sourceFile: "TEK-STOCK-LIVE.xlsx", sourceSheet: "Inventory",
    image: "photos/original.jpg",
    imageSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api, { operator: "photo-mismatch-test" });
  const assigned = new Map();
  const workbook = () => {
    const rawItems = [
      {
        ...original,
        id: assigned.get(325) || original.id,
        stock: 9,
        stockText: "9",
        sourceRow: 325,
      },
      {
        ...original,
        image: "photos/replaced.jpg",
        imageSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sourceRow: 326,
      },
    ];
    return {
      ok: true,
      sha256: assigned.size ? "after-unsafe-photo-rebind" : "before-unsafe-photo-rebind",
      rawItems,
      items: assigned.size ? rawItems : [rawItems[1]],
      integrity: {
        itemRowCount: 2,
        itemIdsUnique: assigned.size === 1,
        itemIdsDuplicateFree: assigned.size === 1,
      },
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    };
  };

  await assert.rejects(sync.syncWorkbook({
    readWorkbook: async () => workbook(),
    assignIds: async (plans) => {
      plans.forEach((plan) => assigned.set(plan.sourceRow, plan.id));
      return { ok: true };
    },
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async () => ({ ok: true }),
  }), { code: "WORKBOOK_IDENTITY_MIGRATION_REQUIRED" });

  assert.equal(assigned.size, 0);
  assert.equal(api.batchRequests.length, 0);
  assert.deepEqual(api.state.items, [original]);
});

test("reader-shaped duplicate photos cannot rebind a permanent ID or write cloud data", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-reader-photo-mismatch-copy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = {
    id: "permanent-product-id", model: "A5115", category: "Dining chair", stock: 1,
    showroomQuantity: 0, computedTotalSold: 14, totalSold: 14,
    cost: 120, sellingPrice: 240, specification: "DARK GRAY",
    arrival: "", showroom: "", outbound: "",
    sourceFile: "TEK-STOCK-LIVE.xlsx", sourceSheet: "Inventory", image: "",
  };
  const baseline = {
    ...original,
    stockText: "",
    sellingPriceText: "",
    imageHash: "original-embedded-hash",
  };
  const originalPhoto = `data:image/png;base64,${Buffer.from("original-photo").toString("base64")}`;
  const copiedPhoto = `data:image/png;base64,${Buffer.from("copied-photo").toString("base64")}`;
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api, { operator: "reader-photo-mismatch-test" });
  const assigned = new Map();
  const workbook = () => {
    const readerRow = (extra) => ({
      ...original,
      image: "",
      imageChanged: false,
      imageUntracked: false,
      ...extra,
    });
    const rawItems = [
      readerRow({
        id: assigned.get(325) || original.id,
        stock: 9,
        embeddedImageDataUrl: originalPhoto,
        embeddedImageHash: baseline.imageHash,
        sourceRow: 325,
      }),
      readerRow({
        embeddedImageDataUrl: copiedPhoto,
        embeddedImageHash: "different-embedded-hash",
        sourceRow: 326,
      }),
    ];
    return {
      ok: true,
      sha256: assigned.size ? "after-reader-photo-rebind" : "before-reader-photo-rebind",
      rawItems,
      items: assigned.size ? rawItems : [rawItems[1]],
      integrity: {
        itemRowCount: 2,
        itemIdsUnique: assigned.size === 1,
        itemIdsDuplicateFree: assigned.size === 1,
      },
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [baseline] },
    };
  };

  await assert.rejects(sync.syncWorkbook({
    readWorkbook: async () => workbook(),
    assignIds: async (plans) => {
      plans.forEach((plan) => assigned.set(plan.sourceRow, plan.id));
      return { ok: true };
    },
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async () => ({ ok: true }),
  }), { code: "WORKBOOK_IDENTITY_MIGRATION_REQUIRED" });

  assert.equal(assigned.size, 0);
  assert.equal(api.batchRequests.length, 0);
  assert.equal(api.uploads.size, 0);
  assert.deepEqual(api.state.items, [original]);
});

test("reader-shaped safe repair preserves baseline-only price text on the permanent item", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-reader-safe-copy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = {
    id: "permanent-product-id", model: "A5115", category: "Dining chair", stock: 1,
    stockText: "1", showroomQuantity: 0, computedTotalSold: 14, totalSold: 14,
    cost: 120, sellingPrice: 240, sellingPriceText: "S$ 240",
    specification: "DARK GRAY", arrival: "", showroom: "", outbound: "",
    sourceFile: "TEK-STOCK-LIVE.xlsx", sourceSheet: "Inventory", image: "",
  };
  const baseline = { ...original, imageHash: "original-embedded-hash" };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api, { operator: "reader-safe-copy-test" });
  const assigned = new Map();
  const readerRow = (extra) => ({
    category: original.category,
    model: original.model,
    stock: original.stock,
    showroomQuantity: original.showroomQuantity,
    computedTotalSold: original.computedTotalSold,
    totalSold: original.totalSold,
    cost: original.cost,
    sellingPrice: original.sellingPrice,
    specification: original.specification,
    arrival: original.arrival,
    showroom: original.showroom,
    outbound: original.outbound,
    sourceFile: original.sourceFile,
    sourceSheet: original.sourceSheet,
    image: "",
    imageChanged: false,
    imageUntracked: false,
    ...extra,
  });
  const workbook = () => {
    const rawItems = [
      readerRow({
        id: original.id,
        embeddedImageHash: baseline.imageHash,
        sourceRow: 325,
      }),
      readerRow({
        id: assigned.get(326) || original.id,
        category: "Coffee table",
        model: "666",
        stock: 2,
        showroomQuantity: 1,
        computedTotalSold: 3,
        totalSold: 3,
        cost: 88,
        sellingPrice: 888,
        embeddedImageHash: "copied-photo-hash",
        sourceRow: 326,
      }),
    ];
    return {
      ok: true,
      sha256: assigned.size ? "after-reader-safe-copy" : "before-reader-safe-copy",
      rawItems,
      items: assigned.size ? rawItems : [rawItems[0]],
      integrity: {
        itemRowCount: 2,
        itemIdsUnique: assigned.size === 1,
        itemIdsDuplicateFree: assigned.size === 1,
      },
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [baseline] },
    };
  };

  const result = await sync.syncWorkbook({
    readWorkbook: async () => workbook(),
    assignIds: async (plans) => {
      plans.forEach((plan) => assigned.set(plan.sourceRow, plan.id));
      return { ok: true };
    },
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async () => ({ ok: true }),
  });

  assert.equal(result.workbookAcknowledged, true, JSON.stringify(result));
  assert.equal(result.assignments, 1);
  assert.equal(result.operations, 1);
  assert.equal(api.state.items.find((item) => item.id === original.id).sellingPriceText, "S$ 240");
  assert.deepEqual(api.batchRequests.flatMap((request) => request.body.operations)
    .map((operation) => operation.item?.model || operation.itemId), ["666"]);
});

test("reader-shaped blank selling price clears both numeric and fallback text values", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-reader-price-clear-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = {
    id: "price-clear-id", model: "PRICE-CLEAR", category: "Chair", stock: 1,
    stockText: "1", showroomQuantity: 0, computedTotalSold: 0, totalSold: 0,
    cost: 120, sellingPrice: 240, sellingPriceText: "S$ 240",
    specification: "", arrival: "", showroom: "", outbound: "",
    sourceFile: "TEK-STOCK-LIVE.xlsx", sourceSheet: "Inventory", image: "",
  };
  const cleared = {
    id: original.id, model: original.model, category: original.category, stock: original.stock,
    showroomQuantity: original.showroomQuantity,
    computedTotalSold: original.computedTotalSold, totalSold: original.totalSold,
    cost: original.cost, sellingPrice: null, sellingPriceText: "",
    specification: original.specification, arrival: original.arrival,
    showroom: original.showroom, outbound: original.outbound,
    sourceFile: original.sourceFile, sourceSheet: original.sourceSheet,
    sourceRow: 325, image: "", imageChanged: false, imageUntracked: false,
  };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api, { operator: "reader-price-clear-test" });
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true, sha256: "reader-price-clear", rawItems: [cleared], items: [cleared],
      integrity: { itemRowCount: 1, itemIdsUnique: true, itemIdsDuplicateFree: true },
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async () => ({ ok: true }),
  });

  assert.equal(result.workbookAcknowledged, true, JSON.stringify(result));
  assert.equal(result.operations, 1);
  assert.equal(api.state.items[0].sellingPrice, null);
  assert.equal(api.state.items[0].sellingPriceText, "");
});

test("409 rebases independent fields but records a conflict before a blind same-field overwrite", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-safe-rebase-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = {
    id: "shared", model: "SHARED", category: "Chair", stock: 1, specification: "OLD",
  };

  const safeApi = fakeAlibabaApi([original]);
  const safe = service(path.join(directory, "safe"), safeApi, {
    operator: "safe-operator", now: () => "2026-08-05T02:03:04.000Z",
  });
  await safe.snapshot(false);
  safe.enqueue([{ type: "update", itemId: "shared", patch: { specification: "NEW" } }]);
  safeApi.interposeNextBatch({ ...original, stock: 7 }, "other-desktop");
  await safe.flush();
  assert.equal(safeApi.state.items[0].stock, 7);
  assert.equal(safeApi.state.items[0].specification, "NEW");
  assert.equal(safe.history().some((event) => event.lifecycle === "conflict"), false);
  const committedAudit = safeApi.auditHistory.find((event) => event.operator === "safe-operator");
  assert.deepEqual(committedAudit.before, { ...original, stock: 7 });
  assert.deepEqual(committedAudit.after, { ...original, stock: 7, specification: "NEW" });
  assert.equal(committedAudit.occurredAt, "2026-08-05T02:03:04.000Z");

  const unsafeApi = fakeAlibabaApi([original]);
  const unsafe = service(path.join(directory, "unsafe"), unsafeApi, {
    operator: "unsafe-operator", now: () => "2026-08-05T03:04:05.000Z",
  });
  await unsafe.snapshot(false);
  unsafe.enqueue([{ type: "update", itemId: "shared", patch: { stock: 9 } }]);
  unsafeApi.interposeNextBatch({ ...original, stock: 7 }, "other-desktop");
  await assert.rejects(unsafe.flush(), { code: "CONCURRENT_MODIFICATION" });
  assert.equal(unsafeApi.state.items[0].stock, 7);
  assert.equal(unsafeApi.opIds.length, 1);
  const conflict = unsafe.history().at(-1);
  assert.equal(conflict.lifecycle, "conflict");
  assert.equal(conflict.operator, "unsafe-operator");
  assert.equal(conflict.occurredAt, "2026-08-05T03:04:05.000Z");
  assert.deepEqual(conflict.mutation.baseItem, original);
  assert.deepEqual(conflict.mutation.patch, { stock: 9 });
  assert.deepEqual(conflict.result.conflictDetails, [
    { itemId: "shared", field: "stock", reason: "field-modified-both" },
  ]);
});

test("workbook sync deletes model 777 and adds model 8888 with a permanent ID", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-central-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const api = fakeAlibabaApi([
    { id: "keep-id", model: "KEEP", category: "Chair", stock: 1 },
    { id: "delete-id", model: "777", category: "Chair", stock: 1 },
  ]);
  const sync = service(directory, api);
  let newId = "";
  let acknowledged;
  const workbook = () => ({
    ok: true,
    sha256: newId ? "sha-after-id" : "sha-before-id",
    items: [
      { id: "keep-id", model: "KEEP", category: "Chair", stock: 1, sourceRow: 5 },
      { id: newId, model: "8888", category: "Table", stock: 3, sourceRow: 7 },
    ],
    integrity: {
      itemRowCount: 2,
      itemIdsUnique: Boolean(newId),
      itemIdsDuplicateFree: true,
    },
    sync: { revision: 0, itemCount: 2, writtenAt: "2026-08-04T08:00:00.000Z" },
    mtimeMs: Date.parse("2026-08-04T08:00:05.000Z"),
    baseline: { revision: 0, itemCount: 2, records: [
      { id: "keep-id", model: "KEEP", category: "Chair", stock: 1 },
      { id: "delete-id", model: "777", category: "Chair", stock: 1 },
    ] },
  });
  const result = await sync.syncWorkbook({
    readWorkbook: async () => workbook(),
    assignIds: async (plans, expectedSha) => {
      assert.equal(expectedSha, "sha-before-id");
      assert.equal(plans.length, 1);
      newId = plans[0].id;
      return { ok: true };
    },
    normalizeRows: (rows) => rows.map((row) => ({
      ...row,
      showroomQuantity: Number(row.showroomQuantity) || 0,
      computedTotalSold: Number(row.computedTotalSold) || 0,
      totalSold: Number(row.totalSold) || 0,
    })),
    acknowledge: async (payload) => {
      acknowledged = payload;
      return { ok: true };
    },
    replaceWorkbook: async (payload) => {
      acknowledged = payload;
      return { ok: true };
    },
  });
  assert.equal(result.assignments, 1);
  assert.equal(result.operations, 2);
  assert.equal(result.workbookAcknowledged, true, JSON.stringify(result));
  assert.deepEqual(api.state.items.map((item) => item.id).sort(), ["keep-id", newId].sort());
  assert.equal(api.state.items.find((item) => item.id === "keep-id").stock, 1);
  assert.equal(api.state.items.find((item) => item.id === newId).model, "8888");
  assert.equal(acknowledged.ackPlan.expectedSha256, "sha-after-id");
  assert.equal(acknowledged.items.some((item) => item.id === "delete-id"), false);
});

test("workbook sync atomically deletes one row and creates two rows at the same position", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-delete-one-add-two-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keepA = { id: "keep-a", model: "KEEP-A", category: "Chair", stock: 1 };
  const removed = { id: "removed-id", model: "OLD-ROW", category: "Table", stock: 2 };
  const keepB = { id: "keep-b", model: "KEEP-B", category: "Chair", stock: 3 };
  const api = fakeAlibabaApi([keepA, removed, keepB]);
  const sync = service(directory, api);
  const assigned = new Map();
  let acknowledged;
  const workbook = () => ({
    ok: true,
    sha256: assigned.size === 2 ? "delete-one-add-two-after" : "delete-one-add-two-before",
    items: [
      { ...keepA, sourceRow: 5 },
      { id: assigned.get(6) || "", model: "8888", category: "Table", stock: 4, sourceRow: 6 },
      { id: assigned.get(7) || "", model: "9999", category: "Chair", stock: 5, sourceRow: 7 },
      { ...keepB, sourceRow: 8 },
    ],
    integrity: {
      itemRowCount: 4,
      itemIdsUnique: assigned.size === 2,
      itemIdsDuplicateFree: true,
    },
    sync: { revision: 0, itemCount: 3, writtenAt: "2026-08-18T01:00:00.000Z" },
    mtimeMs: Date.parse("2026-08-18T01:00:05.000Z"),
    baseline: { revision: 0, itemCount: 3, records: [keepA, removed, keepB] },
  });

  const result = await sync.syncWorkbook({
    readWorkbook: async () => workbook(),
    assignIds: async (plans, expectedSha) => {
      assert.equal(expectedSha, "delete-one-add-two-before");
      assert.deepEqual(plans.map((plan) => plan.sourceRow), [6, 7]);
      plans.forEach((plan) => assigned.set(plan.sourceRow, plan.id));
      return { ok: true };
    },
    normalizeRows: (rows) => rows.map((row) => ({
      ...row,
      showroomQuantity: Number(row.showroomQuantity) || 0,
      computedTotalSold: Number(row.computedTotalSold) || 0,
      totalSold: Number(row.totalSold) || 0,
    })),
    acknowledge: async (payload) => {
      acknowledged = payload;
      return { ok: true };
    },
    replaceWorkbook: async (payload) => {
      acknowledged = payload;
      return { ok: true };
    },
  });

  assert.equal(result.assignments, 2);
  assert.equal(result.operations, 3);
  assert.equal(result.workbookAcknowledged, true, JSON.stringify(result));
  assert.equal(api.batchRequests.length, 1);
  assert.equal(api.state.items.some((item) => item.id === removed.id), false);
  assert.deepEqual(api.state.items.filter((item) => ["8888", "9999"].includes(item.model))
    .map((item) => item.model).sort(), ["8888", "9999"]);
  assert.equal(new Set(assigned.values()).size, 2);
  assert.equal(acknowledged.items.some((item) => item.id === removed.id), false);
});

test("workbook sync replaces a deleted row retyped at the same source row", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-same-row-replace-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const keep = { id: "keep-id", model: "KEEP", category: "Chair", stock: 1, sourceRow: 5 };
  // Production cloud/baseline records do not retain the physical Excel row.
  // Deleting the whole Excel row therefore leaves one missing permanent ID
  // plus one blank-ID replacement, but no baseline sourceRow to compare.
  const removed = { id: "removed-id", model: "4444", category: "Table", stock: 3 };
  const api = fakeAlibabaApi([keep, removed]);
  const sync = service(directory, api);
  let replacementId = "";
  let acknowledged;
  const workbook = () => ({
    ok: true,
    sha256: replacementId ? "same-row-after-id" : "same-row-before-id",
    items: [
      { ...keep },
      { id: replacementId, model: "5555", category: "Table", stock: 3, sourceRow: 6 },
    ],
    integrity: {
      itemRowCount: 2,
      itemIdsUnique: Boolean(replacementId),
      itemIdsDuplicateFree: true,
    },
    sync: { revision: 0, itemCount: 2, writtenAt: "2026-08-16T06:00:00.000Z" },
    mtimeMs: Date.parse("2026-08-16T06:00:05.000Z"),
    baseline: { revision: 0, itemCount: 2, records: [keep, removed] },
  });

  const result = await sync.syncWorkbook({
    readWorkbook: async () => workbook(),
    assignIds: async (plans, expectedSha) => {
      assert.equal(expectedSha, "same-row-before-id");
      assert.equal(plans.length, 1);
      assert.equal(plans[0].sourceRow, 6);
      replacementId = plans[0].id;
      return { ok: true };
    },
    normalizeRows: (rows) => rows.map((row) => ({
      ...row,
      showroomQuantity: Number(row.showroomQuantity) || 0,
      computedTotalSold: Number(row.computedTotalSold) || 0,
      totalSold: Number(row.totalSold) || 0,
    })),
    acknowledge: async (payload) => {
      acknowledged = payload;
      return { ok: true };
    },
    replaceWorkbook: async (payload) => {
      acknowledged = payload;
      return { ok: true };
    },
  });

  assert.equal(result.assignments, 1);
  assert.equal(result.operations, 2);
  assert.equal(result.workbookAcknowledged, true, JSON.stringify(result));
  assert.deepEqual(api.state.items.map((item) => item.id).sort(), ["keep-id", replacementId].sort());
  assert.equal(api.state.items.some((item) => item.id === "removed-id"), false);
  assert.equal(api.state.items.find((item) => item.id === replacementId).model, "5555");
  assert.equal(acknowledged.items.some((item) => item.id === "removed-id"), false);
});

test("workbook sync rereads an identity that appeared while assigning a same-row replacement", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-assignment-race-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "rename-id", model: "6666", category: "Table", stock: 3 };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api);
  let workbookRowId = "";
  let assignmentAttempts = 0;
  let acknowledged;
  const workbook = () => ({
    ok: true,
    sha256: workbookRowId ? "rename-visible-id" : "rename-stale-blank-id",
    items: [
      { id: workbookRowId, model: "77777", category: "Table", stock: 3, sourceRow: 5 },
    ],
    integrity: {
      itemRowCount: 1,
      itemIdsUnique: Boolean(workbookRowId),
      itemIdsDuplicateFree: true,
    },
    sync: { revision: 0, itemCount: 1, writtenAt: "2026-08-16T07:00:00.000Z" },
    mtimeMs: Date.parse("2026-08-16T07:00:05.000Z"),
    baseline: { revision: 0, itemCount: 1, records: [original] },
  });

  const result = await sync.syncWorkbook({
    readWorkbook: async () => workbook(),
    assignIds: async () => {
      assignmentAttempts += 1;
      workbookRowId = original.id;
      const error = new Error("WORKBOOK_ID_ASSIGNMENT_CONFLICT");
      error.code = "WORKBOOK_ID_ASSIGNMENT_CONFLICT";
      throw error;
    },
    normalizeRows: (rows) => rows.map((row) => ({
      ...row,
      showroomQuantity: Number(row.showroomQuantity) || 0,
      computedTotalSold: Number(row.computedTotalSold) || 0,
      totalSold: Number(row.totalSold) || 0,
    })),
    acknowledge: async (payload) => {
      acknowledged = payload;
      return { ok: true };
    },
    replaceWorkbook: async (payload) => {
      acknowledged = payload;
      return { ok: true };
    },
  });

  assert.equal(assignmentAttempts, 1);
  assert.equal(result.assignments, 0);
  assert.equal(result.operations, 1);
  assert.equal(result.workbookAcknowledged, true, JSON.stringify(result));
  assert.equal(api.state.items.length, 1);
  assert.equal(api.state.items[0].id, original.id);
  assert.equal(api.state.items[0].model, "77777");
  assert.equal(acknowledged.items[0].id, original.id);
});

test("an unchanged synchronized legacy row deletes safely after an unrelated cloud advance", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-legacy-delete-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacy = {
    id: "legacy.xlsx::Sheet1::5", model: "DELETE", category: "Chair", stock: 1,
  };
  const keep = { id: "keep-id", model: "KEEP", category: "Chair", stock: 2 };
  const cloudOnly = { id: "cloud-only-id", model: "CLOUD", category: "Table", stock: 3 };
  const api = fakeAlibabaApi([legacy, keep]);
  api.interposeNextBatch(cloudOnly, "other-desktop");
  const sync = service(directory, api);
  let replacement;

  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "legacy-delete-workbook-sha",
      items: [keep],
      sync: { revision: 0, itemCount: 2 },
      baseline: { revision: 0, itemCount: 2, records: [legacy, keep] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async (payload) => {
      replacement = payload;
      return { ok: true };
    },
  });

  assert.equal(result.operations, 1);
  assert.equal(result.workbookAcknowledged, true, JSON.stringify(result));
  assert.equal(result.workbookReplaced, true);
  assert.deepEqual(api.state.items.map((item) => item.id).sort(), ["cloud-only-id", "keep-id"]);
  assert.equal(api.batchRequests.length, 2);
  assert.deepEqual(api.batchRequests.map((request) => request.body.expectedRevision), [0, 1]);
  assert.deepEqual(api.batchRequests.map((request) => request.body.operations), [
    [{ type: "delete", itemId: legacy.id }],
    [{ type: "delete", itemId: legacy.id }],
  ]);
  assert.deepEqual(replacement.items.map((item) => item.id).sort(), ["cloud-only-id", "keep-id"]);
});

test("a normalized workbook with duplicate source IDs cannot authorize a legacy deletion", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-duplicate-delete-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacy = {
    id: "legacy.xlsx::Sheet1::5", model: "DELETE", category: "Chair", stock: 1,
  };
  const keep = { id: "keep-id", model: "KEEP", category: "Chair", stock: 2 };
  const api = fakeAlibabaApi([legacy, keep]);
  const sync = service(directory, api);

  await assert.rejects(sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "duplicate-source-workbook-sha",
      items: [keep],
      integrity: { itemRowCount: 2, itemIdsUnique: false, itemIdsDuplicateFree: false },
      sync: { revision: 0, itemCount: 2 },
      baseline: { revision: 0, itemCount: 2, records: [legacy, keep] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  }), { code: "WORKBOOK_ID_CONFLICT" });

  assert.equal(api.batchRequests.length, 0);
  assert.deepEqual(api.state.items.map((item) => item.id).sort(), [legacy.id, keep.id].sort());
});

test("a multi-row workbook save is one atomic API batch", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-atomic-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = [
    { id: "a", model: "A", category: "Chair", stock: 1 },
    { id: "b", model: "B", category: "Chair", stock: 1 },
  ];
  const api = fakeAlibabaApi(original);
  const sync = service(directory, api);
  await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "atomic-workbook-sha",
      items: [{ ...original[0], stock: 2 }],
      sync: { revision: 0, itemCount: 2 },
      baseline: { revision: 0, itemCount: 2, records: original },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  });

  assert.equal(api.batchRequests.length, 1);
  assert.equal(api.batchRequests[0].body.operations.length, 2);
  assert.deepEqual(api.batchRequests[0].body.operations.map((operation) => operation.type),
    ["upsert", "delete"]);
});

test("confirmed workbook 409 rebases different fields with a fresh request identity", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-rebase-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = {
    id: "shared", model: "SHARED", category: "Chair", stock: 1, specification: "OLD",
  };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api);
  api.interposeNextBatch({ ...original, stock: 7 }, "other-desktop");
  await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "rebase-workbook-sha",
      items: [{ ...original, specification: "NEW" }],
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  });

  assert.equal(api.batchRequests.length, 2);
  assert.notEqual(api.batchRequests[0].opId, api.batchRequests[1].opId);
  assert.equal(api.batchRequests[0].body.expectedRevision, 0);
  assert.equal(api.batchRequests[1].body.expectedRevision, 1);
  assert.equal(api.state.items[0].stock, 7);
  assert.equal(api.state.items[0].specification, "NEW");
});

test("confirmed workbook 409 records same-field conflict without a second write", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-409-conflict-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "shared", model: "SHARED", category: "Chair", stock: 1 };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api);
  api.interposeNextBatch({ ...original, stock: 7 }, "other-desktop");
  await assert.rejects(sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "conflicting-workbook-sha",
      items: [{ ...original, stock: 9 }],
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  }), { code: "CONCURRENT_MODIFICATION" });

  assert.equal(api.batchRequests.length, 1);
  assert.equal(api.state.items[0].stock, 7);
  assert.equal(sync.history().at(-1).lifecycle, "conflict");
});

test("three consecutive workbook revision conflicts rebase without resending a stale body", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-three-rebases-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = {
    id: "shared", model: "SHARED", category: "Chair", stock: 1, specification: "OLD",
  };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api);
  for (const stock of [2, 3, 4]) {
    api.interposeNextBatch({ ...original, stock }, "other-desktop");
  }
  await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "three-rebases-workbook-sha",
      items: [{ ...original, specification: "NEW" }],
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  });

  assert.equal(api.batchRequests.length, 4);
  assert.deepEqual(api.batchRequests.map((entry) => entry.body.expectedRevision), [0, 1, 2, 3]);
  assert.equal(new Set(api.batchRequests.map((entry) => entry.opId)).size, 4);
  assert.equal(api.state.items[0].stock, 4);
  assert.equal(api.state.items[0].specification, "NEW");
});

test("bounded workbook rebase exhaustion persists a terminal conflict and never retries stale body", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-rebase-exhausted-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = {
    id: "shared", model: "SHARED", category: "Chair", stock: 1, specification: "OLD",
  };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api);
  for (const stock of [2, 3, 4, 5]) {
    api.interposeNextBatch({ ...original, stock }, "other-desktop");
  }
  sync.enqueueWorkbook([
    { type: "upsert", item: { ...original, specification: "NEW" } },
  ], "exhausted-workbook-sha", {
    baseSnapshot: { revision: 0, items: [original] },
  });

  await assert.rejects(sync.flush(), { code: "REVISION_REBASE_EXHAUSTED" });
  assert.equal(api.batchRequests.length, 4);
  assert.deepEqual(api.batchRequests.map((entry) => entry.body.expectedRevision), [0, 1, 2, 3]);
  assert.equal(new Set(api.batchRequests.map((entry) => entry.opId)).size, 4);
  assert.equal(sync.outbox.retryable().length, 0);
  assert.equal(sync.history().at(-1).lifecycle, "conflict");
  assert.equal(sync.history().at(-1).result.conflictCode, "REVISION_REBASE_EXHAUSTED");

  const restarted = service(directory, api);
  await restarted.flush();
  assert.equal(api.batchRequests.length, 4);
});

test("post-409 workbook rebase blocks delete versus live edit", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-delete-edit-409-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "shared", model: "SHARED", category: "Chair", stock: 1 };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api);
  api.interposeNextBatch({ ...original, stock: 7 }, "other-desktop");
  await assert.rejects(sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "delete-edit-conflict-sha",
      items: [],
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  }), { code: "CONCURRENT_MODIFICATION" });

  assert.equal(api.batchRequests.length, 1);
  assert.equal(api.state.items[0].stock, 7);
  assert.equal(sync.history().at(-1).lifecycle, "conflict");
  assert.deepEqual(sync.history().at(-1).result.conflictDetails, [
    { itemId: "shared", reason: "delete-modified-live" },
  ]);
});

test("confirmed workbook 409 treats an already-applied result as idempotent", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-409-replayed-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "shared", model: "SHARED", category: "Chair", stock: 1 };
  const wanted = { ...original, stock: 9 };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api);
  api.interposeNextBatch(wanted, "other-desktop");
  await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "already-applied-workbook-sha",
      items: [wanted],
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  });

  assert.equal(api.batchRequests.length, 1);
  assert.equal(api.state.revision, 1);
  assert.equal(api.state.items[0].stock, 9);
  assert.equal(sync.outbox.retryable().length, 0);
  assert.equal(sync.history().some((event) => event.lifecycle === "conflict"), false);
});

test("idempotency 409 is not mistaken for a revision rebase", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-idempotency-conflict-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "a", model: "A", category: "Chair", stock: 1 };
  const api = fakeAlibabaApi([original]);
  let rejectedWrites = 0;
  const sync = service(directory, api, {
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname === "/v1/items/batch") {
        rejectedWrites += 1;
        return json({ code: "IDEMPOTENCY_CONFLICT" }, 409);
      }
      return api.fetch(url, init);
    },
  });
  await sync.snapshot(false);
  sync.enqueueWorkbook([
    { type: "upsert", item: { ...original, stock: 2 } },
  ], "idempotency-conflict-sha");

  await assert.rejects(sync.flush(), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(rejectedWrites, 1);
  assert.equal(sync.history().at(-1).lifecycle, "conflict");
});

test("ambiguous workbook failure retries the exact body and idempotency key after restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-exact-retry-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "a", model: "A", category: "Chair", stock: 1 };
  const api = fakeAlibabaApi([original]);
  const first = service(directory, api);
  api.dropNextBatchResponse();
  await assert.rejects(first.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "retry-workbook-sha",
      items: [{ ...original, stock: 2 }],
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  }), /response lost after commit/);

  const restarted = service(directory, api);
  await restarted.flush();
  assert.equal(api.batchRequests.length, 2);
  assert.equal(api.batchRequests[1].opId, api.batchRequests[0].opId);
  assert.equal(api.batchRequests[1].rawBody, api.batchRequests[0].rawBody);
  assert.equal(api.state.revision, 1);
  assert.equal(api.state.items[0].stock, 2);
});

test("two current workbooks merge edits to different fields without losing either computer", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-three-way-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "shared-id", model: "SHARED", category: "Chair", stock: 1, specification: "OLD" };
  const api = fakeAlibabaApi([original]);
  const first = service(path.join(directory, "first"), api);
  const second = service(path.join(directory, "second"), api);
  const callbacks = (items, sha) => ({
    readWorkbook: async () => ({
      ok: true, sha256: sha, items,
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  });
  await first.syncWorkbook(callbacks([{ ...original, stock: 7 }], "first-sha"));
  await second.syncWorkbook(callbacks([{ ...original, specification: "NEW" }], "second-sha"));
  assert.equal(api.state.items[0].stock, 7);
  assert.equal(api.state.items[0].specification, "NEW");
});

test("two sequential workbooks persist a same-field conflict across restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-conflict-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "shared-id", model: "SHARED", category: "Chair", stock: 1 };
  const api = fakeAlibabaApi([original]);
  const first = service(path.join(directory, "first"), api);
  const second = service(path.join(directory, "second"), api);
  const callbacks = (stock, sha) => ({
    readWorkbook: async () => ({
      ok: true, sha256: sha, items: [{ ...original, stock }],
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  });
  await first.syncWorkbook(callbacks(7, "first-sha"));
  await assert.rejects(second.syncWorkbook(callbacks(9, "second-sha")), (error) => {
    assert.equal(error.code, "WORKBOOK_MERGE_CONFLICT");
    assert.equal(error.conflicts[0].field, "stock");
    return true;
  });
  assert.equal(api.state.items[0].stock, 7);
  assert.equal(api.state.revision, 1);
  const durable = second.outbox.snapshot().entries.find((entry) => entry.state === "conflict");
  assert.equal(durable.type, "workbook");
  assert.equal(durable.operations[0].item.stock, 9);
  assert.deepEqual(durable.conflictDetails, [
    { itemId: "shared-id", field: "stock", reason: "field-modified-both" },
  ]);
  const restarted = service(path.join(directory, "second"), api);
  assert.equal(restarted.outbox.snapshot().entries[0].opId, durable.opId);
});

test("a stale deletion never removes a product edited by the other computer", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-delete-conflict-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "shared-id", model: "SHARED", category: "Chair", stock: 1 };
  const api = fakeAlibabaApi([original]);
  const first = service(path.join(directory, "first"), api);
  const second = service(path.join(directory, "second"), api);
  const callbacks = (items, sha) => ({
    readWorkbook: async () => ({
      ok: true, sha256: sha, items,
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  });
  await first.syncWorkbook(callbacks([{ ...original, stock: 7 }], "first-sha"));
  await assert.rejects(second.syncWorkbook(callbacks([], "second-sha")), {
    code: "WORKBOOK_MERGE_CONFLICT",
  });
  assert.equal(api.state.items[0].stock, 7);
  const durable = second.outbox.snapshot().entries.find((entry) => entry.state === "conflict");
  assert.deepEqual(durable.operations, [{ type: "delete", itemId: "shared-id" }]);
  assert.deepEqual(durable.conflictDetails, [
    { itemId: "shared-id", reason: "delete-modified-live" },
  ]);
});

async function isolatedDeleteConflict(root, api) {
  const original = { id: "shared-id", model: "2233", category: "Chair", stock: 1 };
  const excelClient = service(path.join(root, "excel-client"), api);
  const cloudClient = service(path.join(root, "cloud-client"), api);
  const workbook = (items, sha256) => ({
    readWorkbook: async () => ({
      ok: true,
      sha256,
      items,
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  });
  await cloudClient.syncWorkbook(workbook([{ ...original, stock: 7 }], "cloud-edit-sha"));
  await assert.rejects(excelClient.syncWorkbook(workbook([], "excel-delete-sha")), {
    code: "WORKBOOK_MERGE_CONFLICT",
  });
  const restarted = service(path.join(root, "excel-client"), api);
  const [conflict] = await listSyncConflicts(restarted);
  assert.equal(conflict.conflicts[0].itemId, "shared-id");
  assert.equal(conflict.conflicts[0].field, "_deleteProduct");
  return { conflict, restarted };
}

test("repeated saves supersede the same durable delete conflict instead of stacking dialogs", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-repeated-delete-conflict-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = { id: "shared-id", model: "2233", category: "Chair", stock: 1 };
  const api = fakeAlibabaApi([original]);
  const excelClient = service(path.join(root, "excel-client"), api);
  const cloudClient = service(path.join(root, "cloud-client"), api);
  const workbook = (sha256, items = []) => ({
    readWorkbook: async () => ({
      ok: true,
      sha256,
      items,
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  });
  await cloudClient.syncWorkbook(workbook("cloud-edit-sha", [{ ...original, stock: 7 }]));
  await assert.rejects(excelClient.syncWorkbook(workbook("excel-delete-sha-1")), {
    code: "WORKBOOK_MERGE_CONFLICT",
  });
  const first = excelClient.outbox.snapshot().entries.filter((entry) => entry.state === "conflict");
  assert.equal(first.length, 1);

  await assert.rejects(excelClient.syncWorkbook(workbook("excel-delete-sha-2")), {
    code: "WORKBOOK_MERGE_CONFLICT",
  });
  const second = excelClient.outbox.snapshot().entries.filter((entry) => entry.state === "conflict");
  assert.equal(second.length, 1);
  assert.equal(second[0].opId, first[0].opId);
  assert.equal(second[0].workbookSha256, "excel-delete-sha-2");
  assert.equal(excelClient.outbox.history().some((event) => event.lifecycle === "superseded"), true);
});

test("delete conflict keep-Excel commits one delete and stays deleted after restart", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-resolve-delete-keep-excel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = fakeAlibabaApi([{ id: "shared-id", model: "2233", category: "Chair", stock: 1 }]);
  const { conflict, restarted } = await isolatedDeleteConflict(root, api);
  const workbookWrites = [];
  const requestsBefore = api.batchRequests.length;

  const result = await resolveSyncConflict({
    opId: conflict.opId,
    resolutions: [{ itemId: "shared-id", field: "_deleteProduct", choice: "keep-excel" }],
  }, {
    service: restarted,
    replaceWorkbook: async (payload) => {
      workbookWrites.push(structuredClone(payload));
      return { ok: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.workbookReplaced, true);
  assert.equal(api.batchRequests.length, requestsBefore + 1);
  assert.deepEqual(api.batchRequests.at(-1).body.operations, [
    { type: "delete", itemId: "shared-id" },
  ]);
  assert.equal(api.batchRequests.at(-1).body.expectedRevision, 1);
  assert.equal(api.batchStatuses.at(-1), 200);
  assert.equal(api.state.revision, 2);
  assert.equal(api.state.items.some((item) => item.id === "shared-id"), false);
  assert.equal(workbookWrites.at(-1).items.some((item) => item.id === "shared-id"), false);
  assert.equal(restarted.outbox.snapshot().entries.length, 0);

  const afterRestart = service(path.join(root, "excel-client"), api);
  assert.equal((await afterRestart.canonicalSnapshot()).items.some((item) => item.id === "shared-id"), false);
  assert.equal(afterRestart.outbox.snapshot().entries.length, 0);
});

test("delete conflict keep-cloud performs no API write and restores Excel after restart", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-resolve-delete-keep-cloud-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = fakeAlibabaApi([{ id: "shared-id", model: "2233", category: "Chair", stock: 1 }]);
  const { conflict, restarted } = await isolatedDeleteConflict(root, api);
  const workbookWrites = [];
  const requestsBefore = api.batchRequests.length;

  const result = await resolveSyncConflict({
    opId: conflict.opId,
    resolutions: [{ itemId: "shared-id", field: "_deleteProduct", choice: "keep-cloud" }],
  }, {
    service: restarted,
    replaceWorkbook: async (payload) => {
      workbookWrites.push(structuredClone(payload));
      return { ok: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.workbookReplaced, true);
  assert.equal(api.batchRequests.length, requestsBefore);
  assert.equal(api.state.revision, 1);
  assert.equal(api.state.items.find((item) => item.id === "shared-id").stock, 7);
  assert.equal(workbookWrites.at(-1).items.find((item) => item.id === "shared-id").stock, 7);
  assert.equal(restarted.outbox.snapshot().entries.length, 0);

  const afterRestart = service(path.join(root, "excel-client"), api);
  assert.equal((await afterRestart.canonicalSnapshot()).items.find((item) => item.id === "shared-id").stock, 7);
  assert.equal(afterRestart.outbox.snapshot().entries.length, 0);
});

test("keep-cloud binding failure is reported and remains durable for retry after restart", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-resolve-delete-binding-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = fakeAlibabaApi([{ id: "shared-id", model: "2233", category: "Chair", stock: 1 }]);
  const { conflict, restarted } = await isolatedDeleteConflict(root, api);
  const requestsBefore = api.batchRequests.length;
  const bindingError = Object.assign(new Error("Excel binding failed"), {
    code: "EXCEL_BINDING_FAILED",
  });

  await assert.rejects(resolveSyncConflict({
    opId: conflict.opId,
    resolutions: [{ itemId: "shared-id", field: "_deleteProduct", choice: "keep-cloud" }],
  }, {
    service: restarted,
    replaceWorkbook: async () => { throw bindingError; },
  }), { code: "EXCEL_BINDING_FAILED" });

  assert.equal(api.batchRequests.length, requestsBefore);
  assert.equal(api.state.revision, 1);
  assert.equal(restarted.outbox.snapshot().entries[0].state, "conflict");
  const afterRestart = service(path.join(root, "excel-client"), api);
  assert.equal((await listSyncConflicts(afterRestart))[0].opId, conflict.opId);
});

test("workbook sync uploads an untracked photo on a newly created permanent-ID row", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-new-photo-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const api = fakeAlibabaApi([]);
  const sync = service(directory, api);
  const image = `data:image/png;base64,${Buffer.from("new-row-photo").toString("base64")}`;
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true, sha256: "new-row-with-photo",
      items: [{ id: "new-photo-id", model: "PHOTO", category: "Chair", stock: 1,
        sourceRow: 5, image, imageChanged: false, imageUntracked: true,
        _excelGeneratedId: true }],
      baseline: { records: [] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  });
  assert.equal(result.operations, 1);
  assert.equal(result.photos, 1);
  assert.match(api.state.items[0].imageSha256, /^[a-f0-9]{64}$/);
});

test("workbook sync keeps an untracked replacement photo on an existing baseline row", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-replacement-photo-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "existing-photo-id", model: "PHOTO", category: "Chair", stock: 1, image: "" };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api);
  const image = `data:image/png;base64,${Buffer.from("replacement-photo").toString("base64")}`;
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true, sha256: "existing-row-with-photo",
      items: [{ ...original, sourceRow: 5, image,
        imageChanged: false, imageUntracked: true }],
      baseline: { records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  });
  assert.equal(result.operations, 0);
  assert.equal(result.photos, 1);
  assert.match(api.state.items[0].imageSha256, /^[a-f0-9]{64}$/);
});

test("workbook sync repairs a cloud-missing photo from unchanged embedded Excel bytes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-photo-repair-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "photo-repair-id", model: "PHOTO REPAIR", category: "Chair", stock: 1, image: "" };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api);
  const embeddedImageDataUrl = `data:image/png;base64,${Buffer.from("excel-photo-that-never-reached-oss").toString("base64")}`;
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true, sha256: "unchanged-photo-hash-workbook",
      items: [{ ...original, sourceRow: 5, image: "",
        embeddedImageDataUrl, embeddedImageHash: "stored-excel-hash",
        imageChanged: false, imageUntracked: false }],
      baseline: { records: [original] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  });
  assert.equal(result.operations, 0);
  assert.equal(result.photos, 1);
  assert.match(api.state.items[0].imageSha256, /^[a-f0-9]{64}$/);
  assert.match(api.state.items[0].image, /^photos\//);
});

test("change pagination keeps revision plus sequence and applies two events in one revision", async (t) => {
  const firstDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-feed-first-"));
  t.after(() => {
    fs.rmSync(firstDirectory, { recursive: true, force: true });
  });
  const api = fakeAlibabaApi([{ id: "same-id", model: "OLD", category: "Chair", stock: 1 }]);
  const first = service(firstDirectory, api, { changePageLimit: 1 });
  await first.snapshot(false);
  const fullSnapshots = api.requests.snapshots;
  await api.fetch("https://api.test/v1/items/batch", { method: "POST", headers: {
    "idempotency-key": "same-revision",
  }, body: JSON.stringify({ expectedRevision: 0, operations: [
    { type: "upsert", item: { id: "same-id", model: "NEW", category: "Chair", stock: 8 } },
    { type: "upsert", item: { id: "new-id", model: "SECOND", category: "Table", stock: 2 } },
  ] }) });
  const refreshed = await first.snapshot(false);
  const refreshedById = new Map(refreshed.items.map((item) => [item.id, item]));
  assert.equal(refreshedById.get("same-id").model, "NEW");
  assert.equal(refreshedById.get("same-id").stock, 8);
  assert.equal(refreshedById.get("new-id").model, "SECOND");
  assert.equal(refreshed.revision, 1);
  assert.equal(refreshed.changeSequence, 1);
  assert.equal(api.requests.snapshots, fullSnapshots);
  assert.equal(api.requests.changes, 2);
  assert.deepEqual(api.requests.changeQueries, [
    { after_revision: "0", limit: "1" },
    { after_revision: "1", limit: "1", after_sequence: "0" },
  ]);
});

test("a remotely deleted permanent ID is never acknowledged into a stale workbook baseline", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-no-resurrect-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const api = fakeAlibabaApi([]);
  const sync = service(directory, api);
  let acknowledgementCalls = 0;
  let replacement;
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true, sha256: "stale-workbook",
      items: [{ id: "deleted-online", model: "OLD", category: "Chair", stock: 1 }],
      baseline: { records: [{ id: "deleted-online", model: "OLD", category: "Chair", stock: 1 }] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => { acknowledgementCalls += 1; return { ok: true }; },
    replaceWorkbook: async (payload) => { replacement = payload; return { ok: true }; },
  });
  assert.equal(result.operations, 0);
  assert.equal(result.workbookAcknowledged, true);
  assert.equal(result.workbookReplaced, true);
  assert.equal(acknowledgementCalls, 0);
  assert.deepEqual(replacement.items, []);
  assert.equal(api.state.items.length, 0);
});

test("a trailing blank-ID legacy row fails closed instead of being silently removed", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-blank-id-no-resurrect-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const live = Array.from({ length: 2 }, (_, index) => ({
    id: `live-${index}`, model: `LIVE-${index}`, category: "Chair", stock: 1,
  }));
  const api = fakeAlibabaApi(live);
  const sync = service(directory, api);
  let assignCalls = 0;
  let replacementCalls = 0;
  await assert.rejects(sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "legacy-blank-row",
      items: [
        ...live.map((item, index) => ({ ...item, sourceRow: index + 5 })),
        { id: "", model: "2222", category: "未分类", stock: 2, sourceRow: 7 },
      ],
      sync: { itemCount: 3, writtenAt: "2026-08-04T08:00:00.000Z" },
      mtimeMs: Date.parse("2026-08-04T08:00:05.000Z"),
      baseline: { itemCount: 3, records: live },
    }),
    assignIds: async () => { assignCalls += 1; return { ok: true }; },
    acknowledge: async () => { throw new Error("stale blank row must force replacement"); },
    replaceWorkbook: async () => { replacementCalls += 1; return { ok: true }; },
  }), { code: "WORKBOOK_IDENTITY_MIGRATION_REQUIRED" });
  assert.equal(assignCalls, 0);
  assert.equal(replacementCalls, 0);
  assert.equal(api.state.items.length, 2);
});

test("a remote edit replaces an unchanged stale workbook row", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-remote-edit-refresh-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const remote = { id: "same-id", model: "REMOTE", category: "Chair", stock: 8 };
  const stale = { id: "same-id", model: "OLD", category: "Chair", stock: 1 };
  const sync = service(directory, fakeAlibabaApi([remote]));
  let replacement;
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true, sha256: "stale-edit", items: [stale], baseline: { records: [stale] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => { throw new Error("stale workbook must not be acknowledged"); },
    replaceWorkbook: async (payload) => { replacement = payload; return { ok: true }; },
  });
  assert.equal(result.operations, 0);
  assert.equal(result.workbookReplaced, true);
  assert.equal(replacement.items[0].model, "REMOTE");
  assert.equal(replacement.items[0].stock, 8);
});

test("a corrupt appended baseline cannot authorize deletion of cloud-only rows", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-corrupt-baseline-repair-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const visible = { id: "visible", model: "VISIBLE", category: "Chair", stock: 3 };
  const remoteOnly = { id: "remote-only", model: "7137", category: "Table", stock: 2 };
  const api = fakeAlibabaApi([visible, remoteOnly]);
  const sync = service(directory, api);
  let replacement;
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "corrupt-appended-baseline",
      items: [visible],
      sync: { revision: 0, itemCount: 2 },
      baseline: {
        revision: 0,
        itemCount: 2,
        corrupt: true,
        records: [visible, remoteOnly],
      },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => { throw new Error("corrupt baseline must force a safe rebuild"); },
    replaceWorkbook: async (payload) => { replacement = payload; return { ok: true }; },
  });
  assert.equal(result.operations, 0);
  assert.equal(result.workbookReplaced, true);
  assert.deepEqual(api.state.items.map((item) => item.id).sort(), ["remote-only", "visible"]);
  assert.deepEqual(replacement.items.map((item) => item.id).sort(), ["remote-only", "visible"]);
});

test("a corrupt appended baseline cannot overwrite a newer cloud value for the same ID", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-corrupt-baseline-cloud-wins-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const remote = { id: "same", model: "CLOUD-NEW", category: "Chair", stock: 9 };
  const staleVisible = { id: "same", model: "STALE-EXCEL", category: "Chair", stock: 1 };
  const remoteOnly = { id: "remote-only", model: "7137", category: "Table", stock: 2 };
  const api = fakeAlibabaApi([remote, remoteOnly]);
  const sync = service(directory, api);
  let replacement;
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "corrupt-cloud-wins",
      items: [staleVisible],
      sync: { revision: 0, itemCount: 2 },
      baseline: {
        revision: 0,
        itemCount: 2,
        corrupt: true,
        records: [staleVisible, remoteOnly],
      },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => { throw new Error("corrupt baseline must force a safe rebuild"); },
    replaceWorkbook: async (payload) => { replacement = payload; return { ok: true }; },
  });
  assert.equal(result.operations, 0);
  assert.equal(result.workbookReplaced, true);
  assert.deepEqual(
    (({ id, model, category, stock }) => ({ id, model, category, stock }))(
      api.state.items.find((item) => item.id === "same"),
    ),
    remote,
  );
  assert.deepEqual(
    (({ id, model, category, stock }) => ({ id, model, category, stock }))(
      replacement.items.find((item) => item.id === "same"),
    ),
    remote,
  );
});

test("a corrupt baseline cannot resurrect an online-deleted permanent ID", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-corrupt-baseline-no-resurrection-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const deletedOnline = {
    id: "old-permanent-id", model: "DELETED-ONLINE", category: "Chair", stock: 1,
  };
  const api = fakeAlibabaApi([]);
  const sync = service(directory, api);
  let replacement;
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "corrupt-missing-deleted-id",
      items: [deletedOnline],
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, corrupt: true, records: [] },
    }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => { throw new Error("corrupt baseline must force a safe rebuild"); },
    replaceWorkbook: async (payload) => { replacement = payload; return { ok: true }; },
  });
  assert.equal(result.operations, 0);
  assert.deepEqual(api.state.items, []);
  assert.deepEqual(replacement.items, []);
});

test("workbook replacement failure reports its concrete cause", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-replacement-error-report-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const remote = { id: "remote", model: "REMOTE", category: "Chair", stock: 1 };
  const sync = service(directory, fakeAlibabaApi([remote]));
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({ ok: true, sha256: "stale", items: [], baseline: { records: [] } }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async () => {
      throw Object.assign(new Error("WORKBOOK_UNSAVED_CHANGES"), { code: "WORKBOOK_UNSAVED_CHANGES" });
    },
  });
  assert.equal(result.workbookAcknowledged, false);
  assert.equal(result.retryRequired, true);
  assert.equal(result.errorCode, "WORKBOOK_UNSAVED_CHANGES");
});

test("workbook comparison detects a remote photo identity change", () => {
  const { workbookMatchesSnapshot } = require("../central-sync.cjs");
  const workbook = [{ id: "photo-item", model: "A", image: "photos/photo-item/old.webp" }];
  const cloud = [{ id: "photo-item", model: "A", image: "photos/photo-item/new.webp" }];
  assert.equal(workbookMatchesSnapshot(workbook, cloud), false);
});

test("targeted resolution flush bypasses an older workbook and supersedes it after commit", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-targeted-resolution-flush-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "shared-id", model: "2233", category: "Chair", stock: 7 };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api);
  const older = sync.outbox.enqueueWorkbookTransaction({
    baseRevision: 0,
    baseItems: [original],
    operations: [{ type: "upsert", item: { ...original, stock: 3 } }],
    workbookSha256: "a".repeat(64),
  });
  const resolution = sync.outbox.enqueueWorkbookTransaction({
    baseRevision: 0,
    baseItems: [original],
    operations: [{ type: "delete", itemId: original.id }],
    workbookSha256: "b".repeat(64),
  });

  const result = await sync.flushOperation(resolution.opId, {
    supersedeEarlierWorkbooks: true,
    supersessionReason: "explicit-conflict-resolution",
  });

  assert.equal(result.revision, 1);
  assert.deepEqual(api.batchRequests.map((request) => request.opId), [resolution.opId]);
  assert.equal(api.state.items.some((item) => item.id === original.id), false);
  assert.deepEqual(sync.outbox.snapshot().entries, []);
  const superseded = sync.outbox.history().find((event) =>
    event.opId === older.opId && event.lifecycle === "superseded");
  assert.equal(superseded.result.supersededByOpId, resolution.opId);
  assert.equal(superseded.result.reason, "explicit-conflict-resolution");
  assert.equal(superseded.result.commitRevision, 1);

  const restarted = service(directory, api);
  await restarted.flush();
  assert.equal(api.state.items.some((item) => item.id === original.id), false);
  assert.deepEqual(restarted.outbox.snapshot().entries, []);
});

test("restart resumes an explicit resolution before an older blocked workbook", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-restart-resolution-priority-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "shared-id", model: "2233", category: "Chair", stock: 7 };
  const api = fakeAlibabaApi([original]);
  const first = service(directory, api);
  const older = first.outbox.enqueueWorkbookTransaction({
    baseRevision: 0,
    baseItems: [original],
    operations: [{ type: "upsert", item: { ...original, stock: 3 } }],
    workbookSha256: "c".repeat(64),
  });
  const resolution = first.outbox.enqueueWorkbookTransaction({
    baseRevision: 0,
    baseItems: [original],
    operations: [{ type: "delete", itemId: original.id }],
    workbookSha256: "d".repeat(64),
    explicitResolution: true,
    resolutionOfOpId: "original-conflict-op",
  });

  const restarted = service(directory, api);
  await restarted.flush();

  assert.deepEqual(api.batchRequests.map((request) => request.opId), [resolution.opId]);
  assert.equal(api.state.items.some((item) => item.id === original.id), false);
  assert.deepEqual(restarted.outbox.snapshot().entries, []);
  const superseded = restarted.outbox.history().find((event) =>
    event.opId === older.opId && event.lifecycle === "superseded");
  assert.equal(superseded.result.supersededByOpId, resolution.opId);
});

test("seven stale workbook uploads cannot starve a queued explicit delete resolution", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-seven-entry-starvation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "shared-id", model: "2233", category: "Chair", stock: 7 };
  const api = fakeAlibabaApi([original]);
  const sync = service(directory, api);
  const stale = [];
  for (let index = 0; index < 7; index += 1) {
    stale.push(sync.outbox.enqueueWorkbookTransaction({
      baseRevision: 0,
      baseItems: [original],
      operations: [{ type: "upsert", item: { ...original, stock: index } }],
      workbookSha256: String(index + 1).repeat(64),
    }));
  }
  api.failNextBatch();
  await assert.rejects(sync.flush(), /network down/);
  const resolution = sync.outbox.enqueueWorkbookTransaction({
    baseRevision: 0,
    baseItems: [original],
    operations: [{ type: "delete", itemId: original.id }],
    workbookSha256: "f".repeat(64),
    explicitResolution: true,
    resolutionOfOpId: "delete-conflict-op",
  });
  const confirmed = await sync.flushOperation(resolution.opId, {
    supersedeEarlierWorkbooks: true,
    supersessionReason: "explicit-conflict-resolution",
  });

  assert.equal(confirmed.revision, 1);
  assert.deepEqual(api.batchRequests.map((request) => request.opId), [stale[0].opId, resolution.opId]);
  assert.equal(api.state.items.some((item) => item.id === original.id), false);
  assert.deepEqual(sync.outbox.snapshot().entries, []);
  const supersededIds = new Set(sync.outbox.history()
    .filter((event) => event.lifecycle === "superseded"
      && event.result.reason === "explicit-conflict-resolution")
    .map((event) => event.opId));
  assert.deepEqual(supersededIds, new Set(stale.map((entry) => entry.opId)));
});
