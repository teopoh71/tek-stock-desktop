"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const assert = require("node:assert/strict"), crypto = require("crypto");
(async () => {
  const cli = process.env.WRANGLER_CLI || fs.readFileSync(path.join(os.homedir(), "AgentDock/tek-fix/wrangler-tool-path.txt"), "utf8").trim();
  const { Miniflare } = require(require.resolve("miniflare", { paths: [path.dirname(cli)] }));
  const token = crypto.randomBytes(32).toString("hex"), admin = crypto.randomBytes(32).toString("hex");
  const runtime = new Miniflare({ modules: true, scriptPath: path.resolve(__dirname, "../independent-worker/worker.mjs"),
    compatibilityDate: "2025-08-01", durableObjects: { INVENTORY: { className: "Inventory", useSQLite: true } },
    bindings: { SYNC_TOKEN: token, ADMIN_TOKEN: admin } });
  const request = (route, body, init = {}) => runtime.dispatchFetch("https://local-test.invalid" + route, {
    method: body == null ? "GET" : "POST", ...init,
    headers: { authorization: "Bearer " + token, ...init.headers },
    ...(body == null ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
  });
  try {
    const batch = (rev, operations, headers = {}) => request("/v1/items/batch", { expectedRevision: rev, operations }, { headers });
    assert.equal((await request("/health")).status, 200);
    const item = { id: "runtime-test", model: "RUNTIME TEST", stock: 1 };
    const ops = [{ type: "upsert", item }];
    assert.equal((await batch(0, ops, { authorization: "Bearer invalid" })).status, 401);
    const first = await batch(0, ops, { "idempotency-key": "runtime-create" });
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
    assert.equal((await batch(0, ops, { "idempotency-key": "runtime-create" })).status, 200);
    assert.equal((await batch(0, [{ type: "delete", itemId: item.id }])).status, 409);
    assert.equal((await batch(1, [{ type: "upsert", item: { ...item, stock: 9 } }, null])).status, 400);
    assert.equal((await (await request("/v1/snapshot")).json()).items[0].stock, 1);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZf8AAAAASUVORK5CYII=", "base64");
    // Exercise multiple SQLite blob chunks; bytes must round-trip exactly.
    const bytes = Buffer.concat([png, Buffer.alloc(140000, 173)]);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const signedResult = await request("/v1/photos/presign", { itemId: item.id, sha256, bytes: bytes.length, mimeType: "image/png" });
    assert.equal(signedResult.status, 200);
    const signed = await signedResult.json();
    assert.equal((await request(new URL(signed.uploadUrl).pathname, bytes, { method: "PUT", headers: signed.headers })).status, 200);
    assert.equal((await request("/v1/photos/commit", { itemId: item.id, objectKey: signed.objectKey, sha256, bytes: bytes.length, mimeType: "image/png", expectedRevision: 1 })).status, 200);
    const download = await request("/" + signed.objectKey);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal((await batch(2, [{ type: "delete", itemId: item.id }])).status, 200);
    assert.deepEqual((await (await request("/v1/snapshot")).json()).items, []);
    const changes = await (await request("/v1/changes?after_revision=0")).json();
    assert.deepEqual(changes.events.map(event => event.operation), ["upsert", "upsert", "delete"]);
    console.log(JSON.stringify({ runtime: "workerd-sqlite", authorization: true, addDelete: true, idempotency: true, conflictProtection: true, atomicRollback: true, binaryPhotoRoundTrip: true, changeFeed: true }));
  } finally { await runtime.dispose(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
