"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createApiRequester } = require("../api-failover.cjs");

const AUTHORITY_ID = "tek-stock-hangzhou-v1";

function json(body, authorityId = AUTHORITY_ID, status = 200) {
  const headers = { "content-type": "application/json" };
  if (authorityId !== null) headers["x-tek-stock-authority-id"] = authorityId;
  return new Response(JSON.stringify(body), { status, headers });
}

function requester(fetchImpl, overrides = {}) {
  return createApiRequester({
    fetchImpl,
    getApiBaseUrl: () => "https://primary.test",
    getApiFallbackBaseUrls: () => [],
    getAuthorityId: () => AUTHORITY_ID,
    ...overrides,
  });
}

test("accepts a response only when it proves the packaged authority", async () => {
  const request = requester(async () => json({ ok: true }));
  assert.deepEqual(await request("/healthz"), { ok: true });
});

test("rejects missing and mismatched response authority headers", async (t) => {
  await t.test("missing", async () => {
    const request = requester(async () => json({ ok: true }, null));
    await assert.rejects(request("/healthz"), (error) =>
      error.code === "API_AUTHORITY_MISMATCH"
      && error.expectedAuthorityId === AUTHORITY_ID
      && error.responseAuthorityId === "");
  });
  await t.test("mismatched", async () => {
    const request = requester(async () => json({ ok: true }, "other-authority"));
    await assert.rejects(request("/healthz"), (error) =>
      error.code === "API_AUTHORITY_MISMATCH"
      && error.responseAuthorityId === "other-authority");
  });
});

test("an untrusted primary cannot become preferred and a trusted fallback succeeds", async () => {
  const calls = [];
  const request = requester(async (url) => {
    const host = new URL(url).hostname;
    calls.push(host);
    return host === "primary.test"
      ? json({ revision: 99 }, "other-authority")
      : json({ revision: 7 });
  }, { getApiFallbackBaseUrls: () => ["https://singapore-proxy.test"] });
  assert.deepEqual(await request("/v1/snapshot"), { revision: 7 });
  assert.deepEqual(await request("/v1/snapshot"), { revision: 7 });
  assert.deepEqual(calls, ["primary.test", "singapore-proxy.test", "singapore-proxy.test"]);
});

test("a malformed successful read fails over within the same authority", async () => {
  const calls = [];
  const request = requester(async (url) => {
    const host = new URL(url).hostname;
    calls.push(host);
    if (host === "primary.test") {
      return new Response('{"revision":248,"items":[', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-tek-stock-authority-id": AUTHORITY_ID,
        },
      });
    }
    return json({ revision: 248, items: [] });
  }, { getApiFallbackBaseUrls: () => ["https://singapore-proxy.test"] });

  assert.deepEqual(await request("/v1/snapshot"), { revision: 248, items: [] });
  assert.deepEqual(calls, ["primary.test", "singapore-proxy.test"]);
});

test("a schema-invalid successful snapshot fails over before selecting the endpoint", async () => {
  const calls = [];
  const request = requester(async (url) => {
    const host = new URL(url).hostname;
    calls.push(host);
    return host === "primary.test"
      ? json({ app: "TEK STOCK", revision: 248 })
      : json({ app: "TEK STOCK", revision: 248, items: [] });
  }, { getApiFallbackBaseUrls: () => ["https://singapore-proxy.test"] });

  const snapshot = await request("/v1/snapshot", {
    validateResponse: (body) => {
      if (!Array.isArray(body?.items) || !Number.isSafeInteger(Number(body?.revision))) {
        const error = new Error("CLOUD_SNAPSHOT_INVALID");
        error.code = "CLOUD_SNAPSHOT_INVALID";
        throw error;
      }
      return body;
    },
  });

  assert.deepEqual(snapshot, { app: "TEK STOCK", revision: 248, items: [] });
  assert.deepEqual(calls, ["primary.test", "singapore-proxy.test"]);
});
