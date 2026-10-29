"use strict";
// Overseas links cut long installer downloads off; the updater must continue where it stopped.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { downloadVerifiedInstaller } = require("../updater-core.cjs");

// Electron-style net that drops the connection after `cut[n]` bytes on request n (Infinity = complete).
function flakyNet(bytes, cut, seen, { honorRange = true } = {}) {
  return { request() {
    const request = new EventEmitter();
    const headers = {};
    request.setHeader = (name, value) => { headers[name] = value; };
    request.abort = () => {};
    request.end = () => queueMicrotask(() => {
      const n = seen.ranges.length;
      seen.ranges.push(headers.Range || null);
      const start = honorRange && headers.Range ? Number(/bytes=(\d+)-/.exec(headers.Range)[1]) : 0;
      const body = bytes.subarray(start);
      const limit = cut[n] ?? Infinity;
      const response = new Readable({ read() {} });
      response.statusCode = start ? 206 : 200;
      response.headers = { "content-length": String(body.length), ...(start ? { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}) };
      request.emit("response", response);
      if (limit === 0) return response.destroy(new Error("net::ERR_CONNECTION_RESET"));
      response.push(body.subarray(0, Math.min(limit, body.length)));
      if (limit >= body.length) response.push(null);
      else setTimeout(() => response.destroy(new Error("net::ERR_CONTENT_LENGTH_MISMATCH")), 30);
    });
    return request;
  } };
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-resume-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("0123456789".repeat(1000));
  const release = { url: "https://design.myzolano.vip/tekstock/releases/download/x.exe", size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  return { bytes, release, target: path.join(root, "installer.exe") };
}

test("a download cut off twice resumes from the bytes already saved", async t => {
  const { bytes, release, target } = setup(t);
  const seen = { ranges: [] };
  const result = await downloadVerifiedInstaller(release, target, { electronNet: flakyNet(bytes, [3000, 2500], seen), retryDelayMs: 0 });
  assert.deepEqual(seen.ranges, [null, "bytes=3000-", "bytes=5500-"]);
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test("a server that ignores the resume request sends everything again and the file starts over", async t => {
  const { bytes, release, target } = setup(t);
  const seen = { ranges: [] };
  await downloadVerifiedInstaller(release, target, { electronNet: flakyNet(bytes, [4000], seen, { honorRange: false }), retryDelayMs: 0 });
  assert.deepEqual(seen.ranges, [null, "bytes=4000-"]);
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test("a link that never delivers anything gives up and leaves no partial file", async t => {
  const { bytes, release, target } = setup(t);
  const seen = { ranges: [] };
  await assert.rejects(
    downloadVerifiedInstaller(release, target, { electronNet: flakyNet(bytes, [10, 0, 0, 0, 0, 0, 0], seen), retryDelayMs: 0 }),
    { code: "UPDATE_DOWNLOAD_FAILED" },
  );
  assert.equal(seen.ranges.length, 5); // one try that saved something, then four that saved nothing
  assert.equal(fs.existsSync(target), false);
});

test("a resumed installer with the wrong content is still refused", async t => {
  const { bytes, release, target } = setup(t);
  await assert.rejects(
    downloadVerifiedInstaller({ ...release, sha256: "0".repeat(64) }, target, { electronNet: flakyNet(bytes, [5000], { ranges: [] }), retryDelayMs: 0 }),
    { code: "UPDATE_SHA256_MISMATCH" },
  );
  assert.equal(fs.existsSync(target), false);
});
