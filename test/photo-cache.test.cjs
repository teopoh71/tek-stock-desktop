"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCentralSync, sha256 } = require("../central-sync.cjs");

test("concurrent photo cache misses share one asynchronous download", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-photo-cache-job-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("one-immutable-photo");
  const digest = sha256(bytes);
  let downloads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sync = createCentralSync({
    storageDirectory: directory,
    getApiBaseUrl: () => "https://api.test",
    getToken: () => "test-token",
    fetchImpl: async (url) => {
      assert.equal(url, "https://oss.test/photo.webp");
      downloads += 1;
      await gate;
      return new Response(bytes, { status: 200, headers: { "content-type": "image/webp" } });
    },
  });
  const item = { id: "permanent-product-id", image: "https://oss.test/photo.webp", imageSha256: digest };
  const first = sync.cachePhoto(item);
  const second = sync.cachePhoto(item);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(downloads, 1);
  release();
  const [firstUrl, secondUrl] = await Promise.all([first, second]);
  assert.equal(firstUrl, secondUrl);
  assert.equal(fs.readFileSync(new URL(firstUrl)).compare(bytes), 0);
});
