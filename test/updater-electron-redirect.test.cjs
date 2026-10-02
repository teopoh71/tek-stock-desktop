"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { downloadVerifiedInstaller } = require("../updater-core.cjs");
function redirectingNet(destinations, bytes, seen) {
  return { request() {
    const request = new EventEmitter();
    request.setHeader = () => {};
    request.abort = () => { seen.aborted = true; };
    request.end = () => queueMicrotask(() => {
      for (const url of destinations) {
        let followed = false;
        request.followRedirect = () => { followed = true; seen.followed++; };
        request.emit("redirect", 302, "GET", url, {});
        if (seen.aborted) return;
        if (!followed) { request.emit("error", new Error("net::ERR_ABORTED")); return; }
      }
      const response = Readable.from([bytes]);
      response.statusCode = 200;
      response.headers = { "content-length": String(bytes.length) };
      request.emit("response", response);
    });
    return request;
  } };
}
async function download(t, destinations, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-redirect-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("verified redirected installer");
  const seen = { followed: 0 };
  const target = path.join(root, "verified.exe");
  const release = { url: "https://github.com/example/release.exe", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), ...overrides };
  return { seen, target, promise: downloadVerifiedInstaller(release, target, {
    electronNet: redirectingNet(destinations, bytes, seen), timeoutMs: 1000,
  }) };
}
test("Electron manual redirects are followed synchronously before verifying the installer", async t => {
  const run = await download(t, ["https://release-assets.githubusercontent.com/file.exe"]);
  const result = await run.promise;
  assert.equal(run.seen.followed, 1);
  assert.equal(result.bytes, fs.statSync(run.target).size);
});
test("Electron redirects reject an HTTPS downgrade", async t => {
  const run = await download(t, ["http://example.test/file.exe"]);
  await assert.rejects(run.promise, { code: "UPDATE_REDIRECT_INVALID" });
  assert.equal(run.seen.followed, 0);
  assert.equal(run.seen.aborted, true);
});
test("Electron redirect loops stop after three accepted hops", async t => {
  const run = await download(t, Array(4).fill("https://example.test/file.exe"));
  await assert.rejects(run.promise, { code: "UPDATE_TOO_MANY_REDIRECTS" });
  assert.equal(run.seen.followed, 3);
});
test("a redirected installer still requires the exact expected hash", async t => {
  const run = await download(t, ["https://example.test/file.exe"], { sha256: "0".repeat(64) });
  await assert.rejects(run.promise, { code: "UPDATE_SHA256_MISMATCH" });
  assert.equal(fs.existsSync(run.target), false);
});
