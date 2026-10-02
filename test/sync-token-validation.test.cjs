"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createApiRequester } = require("../api-failover.cjs");
const { postDiagnostics } = require("../maintenance-config.cjs");
const { validateSyncToken } = require("../sync-token-validation.cjs");

const AUTHORITY_ID = "tek-stock-hangzhou-v1";

function requester(fetchImpl, getToken) {
  return createApiRequester({
    fetchImpl,
    getToken,
    getApiBaseUrl: () => "https://primary.test",
    getApiFallbackBaseUrls: () => ["https://fallback.test"],
    getAuthorityId: () => AUTHORITY_ID,
  });
}

test("validator preserves transport-valid Latin-1 tokens and outer ordinary whitespace", () => {
  assert.equal(validateSyncToken("  valid-token_123  "), "valid-token_123");
  assert.equal(validateSyncToken(" \t\x80\xfftoken\t "), "\x80\xfftoken");
  assert.throws(() => validateSyncToken("   "), { code: "SYNC_TOKEN_MISSING" });
});

test("validator rejects every Node-invalid header character without exposing the value", () => {
  for (const value of [
    "abc\u4e2ddef", "abc\u0000def", "abc\u0001def", "abc\u001fdef", "abc\u007fdef",
    "\rvalid-token", "valid-token\r", "\nvalid-token", "valid-token\n",
  ]) {
    assert.throws(() => validateSyncToken(value), (error) =>
      error.code === "SYNC_TOKEN_INVALID" && !String(error.message).includes(value));
  }
});

test("independent-authority GET rejects a malformed token before any incident request", async () => {
  const calls = [];
  const request = createApiRequester({
    fetchImpl: async (url) => { calls.push(url); throw new Error("should not fetch"); },
    getToken: () => "bad\u0001token",
    getApiBaseUrl: () => "https://primary.test",
    getApiFallbackBaseUrls: () => ["https://fallback.test"],
    getAuthorityId: () => "tek-stock-independent-v1",
  });

  await assert.rejects(request("/v1/incidents"), { code: "SYNC_TOKEN_INVALID" });
  assert.deepEqual(calls, []);
});

test("requester rejects a malformed token before issuing or failing over a write", async () => {
  const calls = [];
  const request = requester(async (url) => {
    calls.push(url);
    throw new Error("should not fetch");
  }, () => "bad\u4e2dtoken");

  await assert.rejects(request("/v1/snapshot", { method: "POST", write: true }), {
    code: "SYNC_TOKEN_INVALID",
  });
  assert.deepEqual(calls, []);
});

test("requester preserves a server-side authorization rejection for a valid token", async () => {
  const calls = [];
  const request = requester(async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ code: "UNAUTHORIZED" }), {
      status: 401,
      headers: { "x-tek-stock-authority-id": AUTHORITY_ID },
    });
  }, () => "valid-token");

  await assert.rejects(request("/v1/snapshot", { method: "POST", write: true }), {
    code: "UNAUTHORIZED",
  });
  assert.equal(calls.length, 1);
});

test("maintenance diagnostics rejects an invalid token before creating a request", async () => {
  let requests = 0;
  const electronNet = {
    request() {
      requests += 1;
      throw new Error("should not create request");
    },
  };

  await assert.rejects(postDiagnostics("https://maintenance.test/v1/diagnostics", "bad\u4e2dtoken", [], electronNet), {
    code: "SYNC_TOKEN_INVALID",
  });
  assert.equal(requests, 0);
});
