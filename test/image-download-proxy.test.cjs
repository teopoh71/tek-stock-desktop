const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const sharp = require("sharp");

process.env.TEK_STOCK_TEST = "1";

const { downloadBuffer, imageBufferForItem } = require("../main.cjs");

test("image download prefers Electron networking so Windows proxy settings are honored", async () => {
  let electronRequests = 0;
  let directRequests = 0;
  const electronNet = {
    request(options) {
      electronRequests += 1;
      assert.equal(options.url, "https://example.test/photo.webp");
      const request = new EventEmitter();
      request.abort = () => {};
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { "content-type": "image/webp" };
        queueMicrotask(() => {
          request.emit("response", response);
          response.emit("data", Buffer.from("photo"));
          response.emit("end");
        });
      };
      return request;
    },
  };
  const httpsModule = {
    get() {
      directRequests += 1;
      throw new Error("direct HTTPS must not be used when Electron networking is available");
    },
  };

  const result = await downloadBuffer(
    "https://example.test/photo.webp",
    4,
    { electronNet, httpsModule, timeoutMs: 1000 },
  );

  assert.equal(result.toString(), "photo");
  assert.equal(electronRequests, 1);
  assert.equal(directRequests, 0);
});

test("a temporary remote failure preserves the photo already embedded in Excel", async () => {
  const cachedImage = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 21, g: 79, b: 76, alpha: 1 },
    },
  }).png().toBuffer();
  const httpsModule = {
    get(_url, callback) {
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = () => {};
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 503;
        response.headers = {};
        response.resume = () => {};
        callback(response);
      });
      return request;
    },
  };

  const result = await imageBufferForItem(
    { id: "chair-1", image: "https://example.test/photo.webp" },
    false,
    {
      existingImageBuffer: cachedImage,
      transports: { electronNet: null, httpsModule, timeoutMs: 1000 },
    },
  );

  assert.ok(result.length > 100);
  assert.deepEqual([...result.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
