"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  fetchHighestRevision,
  isUnchangedSnapshot,
  readSources,
} = require("../inventory/remote-read-core.js");

function response(payload, ok = true, status = 200) {
  return { ok, status, json: async () => payload };
}

test("general read selects the highest valid revision across Cloudflare and OSS", async () => {
  const requests = [];
  const result = await fetchHighestRevision({
    authoritativeUrl: "https://cloudflare.test/data",
    mirrorUrls: ["https://oss.test/data.json"],
    cacheToken: 123,
    isValidPayload: (payload) => Array.isArray(payload.items),
    fetchImpl: async (url) => {
      requests.push(url);
      return url.startsWith("https://oss.test/")
        ? response({ revision: 52, items: [{ id: "new" }] })
        : response({ revision: 51, items: [{ id: "old" }] });
    },
  });
  assert.equal(result.revision, 52);
  assert.equal(result.url, "https://oss.test/data.json");
  assert.equal(result.authoritative, false);
  assert.deepEqual(requests, [
    "https://cloudflare.test/data?t=123-0",
    "https://oss.test/data.json?t=123-1",
  ]);
});

test("a stale OSS mirror never overrides newer authoritative Cloudflare data", async () => {
  const result = await fetchHighestRevision({
    authoritativeUrl: "https://cloudflare.test/data",
    mirrorUrls: ["https://oss.test/data.json"],
    isValidPayload: (payload) => Array.isArray(payload.items),
    fetchImpl: async (url) => url.startsWith("https://oss.test/")
      ? response({ revision: 49, items: [] })
      : response({ revision: 50, items: [] }),
  });
  assert.equal(result.revision, 50);
  assert.equal(result.authoritative, true);
});

test("equal revisions prefer Cloudflare and invalid or failed sources are ignored", async () => {
  const tied = await fetchHighestRevision({
    authoritativeUrl: "https://cloudflare.test/data",
    mirrorUrls: ["https://oss.test/data.json"],
    isValidPayload: (payload) => payload.safe === true,
    fetchImpl: async () => response({ revision: 60, items: [], safe: true }),
  });
  assert.equal(tied.authoritative, true);

  const fallback = await fetchHighestRevision({
    authoritativeUrl: "https://cloudflare.test/data",
    mirrorUrls: ["https://oss.test/data.json"],
    isValidPayload: (payload) => payload.safe === true,
    fetchImpl: async (url) => url.startsWith("https://cloudflare.test/")
      ? response({ revision: 999, items: [], safe: false })
      : response({ revision: 61, items: [], safe: true }),
  });
  assert.equal(fallback.revision, 61);
  assert.equal(fallback.authoritative, false);
});

test("source list de-duplicates URLs without losing Cloudflare authority", () => {
  assert.deepEqual(readSources("https://cloudflare.test/data", [
    "https://cloudflare.test/data",
    "https://oss.test/data.json",
  ]), [
    { url: "https://cloudflare.test/data", authoritative: true },
    { url: "https://oss.test/data.json", authoritative: false },
  ]);
});

test("same revision and count cannot hide changed remote content", () => {
  const common = {
    skipRender: true,
    cloudState: "live",
    incomingRevision: 70,
    currentRevision: 70,
    incomingItemCount: 329,
    currentItemCount: 329,
    currentFingerprint: "old-content",
    hasPendingEdits: false,
  };
  assert.equal(isUnchangedSnapshot({
    ...common,
    incomingFingerprint: "new-content",
  }), false);
  assert.equal(isUnchangedSnapshot({
    ...common,
    incomingFingerprint: "old-content",
  }), true);
});

test("missing fingerprints fail open to a full refresh", () => {
  assert.equal(isUnchangedSnapshot({
    skipRender: true,
    cloudState: "live",
    incomingRevision: 70,
    currentRevision: 70,
    incomingItemCount: 329,
    currentItemCount: 329,
    incomingFingerprint: "",
    currentFingerprint: "",
    hasPendingEdits: false,
  }), false);
});

test("an unreachable Cloudflare source times out and OSS still loads", async () => {
  const result = await fetchHighestRevision({
    authoritativeUrl: "https://cloudflare.test/data",
    mirrorUrls: ["https://oss.test/data.json"],
    sourceTimeoutMs: 20,
    isValidPayload: (payload) => Array.isArray(payload.items),
    fetchImpl: async (url, options) => {
      if (url.startsWith("https://oss.test/")) {
        return response({ revision: 62, items: [{ id: "oss" }] });
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  assert.equal(result.revision, 62);
  assert.equal(result.authoritative, false);
});

test("a stale reachable mirror cannot downgrade the last confirmed local revision", async () => {
  await assert.rejects(
    fetchHighestRevision({
      authoritativeUrl: "https://cloudflare.test/data",
      mirrorUrls: ["https://oss.test/data.json"],
      minimumRevision: 63,
      sourceTimeoutMs: 20,
      isValidPayload: (payload) => Array.isArray(payload.items),
      fetchImpl: async (url, options) => {
        if (url.startsWith("https://oss.test/")) {
          return response({ revision: 62, items: [{ id: "stale" }] });
        }
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    }),
    /REMOTE_READ_BELOW_MINIMUM_REVISION/,
  );
});

test("a mirror at or above the local revision floor remains usable", async () => {
  const result = await fetchHighestRevision({
    authoritativeUrl: "https://cloudflare.test/data",
    mirrorUrls: ["https://oss.test/data.json"],
    minimumRevision: 63,
    sourceTimeoutMs: 20,
    isValidPayload: (payload) => Array.isArray(payload.items),
    fetchImpl: async (url, options) => {
      if (url.startsWith("https://oss.test/")) {
        return response({ revision: 63, items: [{ id: "current" }] });
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  assert.equal(result.revision, 63);
  assert.equal(result.authoritative, false);
});
