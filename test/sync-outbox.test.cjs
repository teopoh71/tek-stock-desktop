"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSyncOutbox } = require("../sync-outbox.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-outbox-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "sync-outbox.json");
}

test("outbox survives restart and retries sent operations with the same opId", (t) => {
  const file = fixture(t);
  const ids = ["client-1", "op-1"];
  const first = createSyncOutbox({ file, randomUUID: () => ids.shift(), now: () => "2026-08-01T00:00:00.000Z" });
  const queued = first.enqueue({
    itemId: "item-a",
    type: "update",
    baseItemVersion: 7,
    patch: { stock: 3 },
  });
  first.markSent(queued.opId);

  const restarted = createSyncOutbox({ file });
  assert.equal(restarted.snapshot().clientId, "client-1");
  assert.deepEqual(restarted.retryable().map((entry) => ({ opId: entry.opId, state: entry.state })), [
    { opId: "op-1", state: "sent" },
  ]);
});

test("enqueue is idempotent by opId and rejects payload reuse", (t) => {
  const file = fixture(t);
  const box = createSyncOutbox({ file, randomUUID: () => "client-1" });
  const mutation = { opId: "fixed-op", itemId: "item-a", type: "delete", baseItemVersion: 4 };
  const first = box.enqueue(mutation);
  const repeated = box.enqueue({ ...mutation });
  assert.deepEqual(repeated, first);
  assert.equal(box.snapshot().entries.length, 1);

  assert.throws(
    () => box.enqueue({ ...mutation, itemId: "item-b" }),
    { code: "OUTBOX_IDEMPOTENCY_CONFLICT" },
  );
});

test("acknowledged operations are not retried after restart", (t) => {
  const file = fixture(t);
  const ids = ["client-1", "op-1"];
  const box = createSyncOutbox({ file, randomUUID: () => ids.shift() });
  const queued = box.enqueue({ itemId: "item-a", type: "create", item: { model: "A" } });
  box.acknowledge(queued.opId, { commitRevision: 42, itemVersion: 1 });

  const restarted = createSyncOutbox({ file });
  assert.deepEqual(restarted.retryable(), []);
  assert.equal(restarted.snapshot().entries[0].commitRevision, 42);
  assert.equal(restarted.snapshot().entries[0].itemVersion, 1);
});

test("operator, time, and full mutation history survive acknowledgement pruning and restart", (t) => {
  const file = fixture(t);
  const ids = ["client-history", "op-history"];
  const box = createSyncOutbox({
    file,
    randomUUID: () => ids.shift(),
    operator: "edwin@desktop",
    now: () => "2026-08-05T04:05:06.000Z",
  });
  const before = { id: "item-a", model: "A", stock: 1 };
  const queued = box.enqueue({
    itemId: "item-a",
    type: "update",
    baseRevision: 7,
    baseItem: before,
    patch: { stock: 3 },
  });
  box.markSent(queued.opId);
  box.acknowledge(queued.opId, { commitRevision: 8 });
  assert.equal(box.pruneAcknowledged(), 1);

  const restarted = createSyncOutbox({ file });
  assert.deepEqual(restarted.retryable(), []);
  assert.deepEqual(restarted.history().map((event) => event.lifecycle), ["queued", "sent", "acked"]);
  for (const event of restarted.history()) {
    assert.equal(event.operator, "edwin@desktop");
    assert.equal(event.occurredAt, "2026-08-05T04:05:06.000Z");
    assert.deepEqual(event.mutation.before, before);
    assert.deepEqual(event.mutation.after, { ...before, stock: 3 });
    assert.deepEqual(event.mutation.baseItem, before);
    assert.deepEqual(event.mutation.patch, { stock: 3 });
  }
  assert.equal(restarted.history().at(-1).result.commitRevision, 8);
});

test("version-one outboxes migrate without losing a pending mutation", (t) => {
  const file = fixture(t);
  const timestamp = "2026-08-01T00:00:00.000Z";
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    clientId: "legacy-client",
    nextSeq: 2,
    entries: [{
      opId: "legacy-op",
      itemId: "item-a",
      type: "delete",
      baseItemVersion: 4,
      requestHash: "legacy-hash",
      clientId: "legacy-client",
      clientSeq: 1,
      state: "pending",
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  }), "utf8");

  const migrated = createSyncOutbox({ file, now: () => timestamp });
  const replay = migrated.enqueue({
    opId: "legacy-op", itemId: "item-a", type: "delete", baseItemVersion: 4,
  });
  assert.equal(replay.opId, "legacy-op");
  assert.equal(migrated.snapshot().version, 2);
  assert.equal(migrated.history()[0].lifecycle, "migrated");
  migrated.markSent("legacy-op");

  const restarted = createSyncOutbox({ file });
  assert.equal(restarted.retryable()[0].opId, "legacy-op");
  assert.deepEqual(restarted.history().map((event) => event.lifecycle), ["migrated", "sent"]);
});

test("outbox writes atomically and ignores an abandoned temporary file", (t) => {
  const file = fixture(t);
  const ids = ["client-1", "op-1"];
  const box = createSyncOutbox({ file, randomUUID: () => ids.shift() });
  box.enqueue({ itemId: "item-a", type: "update", patch: { stock: 2 } });
  fs.writeFileSync(`${file}.tmp`, "partial", "utf8");

  const restarted = createSyncOutbox({ file });
  assert.equal(restarted.snapshot().entries.length, 1);
  assert.equal(restarted.snapshot().entries[0].opId, "op-1");
});

test("corrupt committed outbox fails closed instead of dropping mutations", (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, "not-json", "utf8");
  assert.throws(() => createSyncOutbox({ file }), { code: "OUTBOX_CORRUPT" });
});

test("workbook transaction persists one ordered exact request across restart", (t) => {
  const file = fixture(t);
  const ids = ["workbook-client", "workbook-op"];
  const box = createSyncOutbox({
    file,
    randomUUID: () => ids.shift(),
    operator: "excel@desktop-a",
    now: () => "2026-08-05T08:09:10.000Z",
  });
  const baseItems = [
    { id: "a", model: "A", stock: 1 },
    { id: "b", model: "B", stock: 1 },
  ];
  const operations = [
    { type: "upsert", item: { id: "a", model: "A", stock: 2 } },
    { type: "delete", itemId: "b" },
  ];
  const queued = box.enqueueWorkbookTransaction({
    operations,
    baseRevision: 7,
    baseItems,
    workbookSha256: "ABCDEF",
  });
  box.markSent(queued.opId);

  const restarted = createSyncOutbox({ file });
  const [replay] = restarted.retryable();
  assert.equal(replay.type, "workbook");
  assert.equal(replay.opId, "workbook-op");
  assert.deepEqual(replay.requestBody, { expectedRevision: 7, operations });
  assert.deepEqual(replay.baseItems, baseItems);
  assert.equal(replay.workbookSha256, "abcdef");
  assert.equal(replay.operator, "excel@desktop-a");
  assert.equal(replay.occurredAt, "2026-08-05T08:09:10.000Z");
  assert.equal(replay.attempts, 1);
  assert.deepEqual(restarted.history().map((event) => event.lifecycle), ["queued", "sent"]);
  assert.deepEqual(restarted.history()[0].mutation.operations, operations);
});

test("workbook entries can only use the validated transaction interface", (t) => {
  const box = createSyncOutbox({ file: fixture(t), randomUUID: () => "client-1" });
  assert.throws(() => box.enqueue({
    type: "workbook",
    itemId: "fake-row-shaped-workbook",
  }), { code: "OUTBOX_MUTATION_INVALID" });
});
