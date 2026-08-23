"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CLOUD_RESET_LOCAL_CONFIRMATION,
  createCloudResetLocalRunner,
  validateLiveSnapshot,
} = require("../cloud-reset-local.cjs");

function makeDeps(overrides = {}) {
  const calls = [];
  const live = {
    cloudState: "live",
    authorityId: "tek-stock-hangzhou-v1",
    revision: 244,
    itemCount: 1,
    items: [{ id: "00000000-0000-4000-8000-000000000001", model: "A" }],
  };
  const deps = {
    expectedAuthorityId: live.authorityId,
    acquireLock: async () => { calls.push(["lock"]); return () => calls.push(["unlock"]); },
    readWorkbook: async () => ({
      ok: true,
      sha256: "before-sha",
      sync: { revision: 243, itemCount: 1 },
      items: [{ id: live.items[0].id, model: "OLD" }],
    }),
    readLiveSnapshot: async () => structuredClone(live),
    backupLocalState: async (input) => {
      calls.push(["backup", input]);
      return { ok: true, path: "backup/run-1" };
    },
    buildReplacement: async ({ live: snapshot }) => {
      calls.push(["build", snapshot.revision]);
      return {
        ok: true,
        path: "TEK-STOCK-LIVE.xlsx.tmp.xlsx",
        workbook: {
          ok: true,
          sync: { revision: snapshot.revision, itemCount: snapshot.items.length },
          items: structuredClone(snapshot.items),
        },
      };
    },
    replaceWorkbook: async (input) => calls.push(["replace", input.expectedSha256]),
    archiveSyncState: async () => calls.push(["archive"]),
    initializeFreshSyncState: async () => calls.push(["init"]),
    verify: async () => ({ ok: true }),
    reload: async () => calls.push(["reload"]),
    now: () => "2026-08-10T00:00:00.000Z",
    randomUUID: () => "run-1",
    ...overrides,
  };
  return { deps, calls, live };
}

test("reset requires explicit confirmation", async () => {
  const { deps, calls } = makeDeps();
  const run = createCloudResetLocalRunner(deps);
  await assert.rejects(run({ confirmation: "yes" }), (error) =>
    error.code === "CLOUD_RESET_CONFIRMATION_REQUIRED");
  assert.deepEqual(calls, []);
});

test("reset reads live cloud, backs up before replacement, and performs no cloud write", async () => {
  const { deps, calls } = makeDeps();
  const run = createCloudResetLocalRunner(deps);
  const result = await run({ confirmation: CLOUD_RESET_LOCAL_CONFIRMATION });
  assert.deepEqual(result, {
    ok: true,
    runId: "run-1",
    backupPath: "backup/run-1",
    workbookPath: "TEK-STOCK-LIVE.xlsx.tmp.xlsx",
    revision: 244,
    itemCount: 1,
    cloudWrites: 0,
  });
  assert.deepEqual(calls.map(([name]) => name), ["lock", "backup", "build", "replace", "archive", "init", "reload", "unlock"]);
});

test("cached or mismatched authority snapshot aborts before backup", async () => {
  for (const override of [
    { readLiveSnapshot: async () => ({ cloudState: "cached", revision: 244, items: [] }) },
    { readLiveSnapshot: async () => ({ cloudState: "live", authorityId: "other", revision: 244, items: [] }) },
  ]) {
    const { deps, calls } = makeDeps(override);
    const run = createCloudResetLocalRunner(deps);
    await assert.rejects(run({ confirmation: CLOUD_RESET_LOCAL_CONFIRMATION }));
    assert.deepEqual(calls.map(([name]) => name), ["lock", "unlock"]);
  }
});

test("post-replacement failure rolls back when available", async () => {
  const { deps, calls } = makeDeps({
    initializeFreshSyncState: async () => { throw new Error("state-init"); },
    rollback: async () => calls.push(["rollback"]),
  });
  const run = createCloudResetLocalRunner(deps);
  await assert.rejects(run({ confirmation: CLOUD_RESET_LOCAL_CONFIRMATION }));
  assert.deepEqual(calls.map(([name]) => name), ["lock", "backup", "build", "replace", "archive", "rollback", "unlock"]);
});

test("replacement identity mismatch is rejected before local replacement and temp is discarded", async () => {
  const { deps, calls } = makeDeps({
    buildReplacement: async () => ({
      ok: true,
      path: "TEK-STOCK-LIVE.xlsx.tmp.xlsx",
      workbook: { ok: true, sync: { revision: 244, itemCount: 1 }, items: [{ id: "wrong", model: "X" }] },
    }),
    discardReplacement: async () => calls.push(["discard"]),
  });
  const run = createCloudResetLocalRunner(deps);
  await assert.rejects(run({ confirmation: CLOUD_RESET_LOCAL_CONFIRMATION }),
    (error) => error.code === "CLOUD_RESET_REPLACEMENT_MISMATCH");
  assert.deepEqual(calls.map(([name]) => name), ["lock", "backup", "discard", "unlock"]);
});

test("live snapshot validation rejects duplicate IDs and bad counts", () => {
  assert.throws(() => validateLiveSnapshot({ cloudState: "live", revision: 1, items: [
    { id: "x" }, { id: "x" },
  ] }), (error) => error.code === "CLOUD_RESET_ITEM_ID_INVALID");
  assert.throws(() => validateLiveSnapshot({ cloudState: "live", revision: 1, itemCount: 2, items: [{ id: "x" }] }),
    (error) => error.code === "CLOUD_RESET_ITEM_COUNT_INVALID");
});
