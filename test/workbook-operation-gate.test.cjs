"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createWorkbookOperationGate } = require("../workbook-operation-gate.cjs");

test("cloud reset waits for an already-running workbook sync before taking the writer lock", async () => {
  const gate = createWorkbookOperationGate({ quiesceTimeoutMs: 100 });
  const events = [];
  let releaseSync;
  const sync = gate.scheduleSync(async () => {
    events.push("sync-start");
    await new Promise((resolve) => { releaseSync = resolve; });
    events.push("sync-end");
  });
  const reset = gate.runReset(async () => {
    events.push("reset");
    return "reset-ok";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["sync-start"]);
  releaseSync();
  await assert.doesNotReject(sync);
  assert.equal(await reset, "reset-ok");
  assert.deepEqual(events, ["sync-start", "sync-end", "reset"]);
});

test("cloud reset fails closed when workbook sync cannot quiesce", async () => {
  const gate = createWorkbookOperationGate({ quiesceTimeoutMs: 10 });
  let releaseSync;
  const sync = gate.scheduleSync(() => new Promise((resolve) => { releaseSync = resolve; }));
  let ran = false;
  await assert.rejects(
    gate.runReset(async () => { ran = true; }),
    (error) => error.code === "CLOUD_RESET_SYNC_IN_PROGRESS",
  );
  assert.equal(ran, false);
  assert.equal(gate.isResetPending(), true);

  let postResetRan = false;
  const postReset = gate.scheduleWrite(async () => { postResetRan = true; });
  releaseSync();
  await assert.doesNotReject(sync);
  await assert.rejects(postReset, (error) => error.code === "CLOUD_RESET_IN_PROGRESS");
  assert.equal(postResetRan, false);
  assert.equal(gate.isResetPending(), false);
});

test("confirmed reset cancels only a waiting automatic sync and waits for its lock release", async () => {
  const gate = createWorkbookOperationGate({ quiesceTimeoutMs: 100 });
  const events = [];
  const automatic = gate.scheduleAutomaticSync(async ({ signal }) => {
    events.push("automatic-start");
    await new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    events.push("automatic-end");
  }, {
    onCancel: () => {
      events.push("automatic-cancel");
      events.push("lock-release");
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const reset = gate.runReset(async () => {
    events.push("reset");
    return "reset-ok";
  }, { cancelAutomaticSync: true });
  await assert.doesNotReject(reset);
  await assert.rejects(automatic, (error) => error.code === "CLOUD_RESET_SYNC_CANCELLED");
  assert.deepEqual(events, ["automatic-start", "automatic-cancel", "lock-release", "reset"]);

  let manualRan = false;
  await assert.doesNotReject(gate.scheduleWrite(async () => { manualRan = true; }));
  assert.equal(manualRan, true);
});

test("reset does not preempt an automatic sync after cloud commit has begun", async () => {
  const gate = createWorkbookOperationGate({ quiesceTimeoutMs: 10 });
  let release;
  let resetRan = false;
  const automatic = gate.scheduleAutomaticSync(async () => new Promise((resolve) => {
    release = resolve;
  }), { onCancel: () => false });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    gate.runReset(async () => { resetRan = true; }, { cancelAutomaticSync: true }),
    (error) => error.code === "CLOUD_RESET_SYNC_IN_PROGRESS",
  );
  assert.equal(resetRan, false);
  release();
  await assert.doesNotReject(automatic);
});
