"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { downloadVerifiedInstaller } = require("../updater-core.cjs");

test("installer downloader blocks a stale lower version before network access", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-downgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let networkCalls = 0;
  const destination = path.join(root, "stale.exe");
  const release = {
    version: "1.5.51",
    url: "https://downloads.test/TEK-STOCK-1.5.51.exe",
    sha256: "0".repeat(64),
    size: 123,
  };

  await assert.rejects(
    downloadVerifiedInstaller(release, destination, {
      userAgent: "TEK-STOCK/1.6.6",
      https: {
        get() {
          networkCalls += 1;
          throw new Error("network must not be touched for a downgrade");
        },
      },
    }),
    { code: "UPDATE_DOWNGRADE_BLOCKED" },
  );
  assert.equal(networkCalls, 0);
  assert.equal(fs.existsSync(destination), false);
});

test("installer downloader still permits same-version repair", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-repair-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("repair-installer");
  const crypto = require("node:crypto");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const { Readable } = require("node:stream");
  const { EventEmitter } = require("node:events");
  const release = {
    version: "1.6.6",
    url: "https://downloads.test/TEK-STOCK-1.6.6.exe",
    sha256,
    size: bytes.length,
  };
  const https = {
    get(_url, _options, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = (error) => request.emit("error", error);
      process.nextTick(() => {
        const response = Readable.from([bytes]);
        response.statusCode = 200;
        response.headers = { "content-length": String(bytes.length) };
        callback(response);
      });
      return request;
    },
  };
  const destination = path.join(root, "repair.exe");
  const result = await downloadVerifiedInstaller(release, destination, {
    userAgent: "TEK-STOCK/1.6.6",
    https,
  });
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(fs.readFileSync(destination), bytes);
});
