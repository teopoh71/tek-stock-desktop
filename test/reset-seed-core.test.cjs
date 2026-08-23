"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RESET_SEED_CONFIRMATION,
  createResetSeedRunner,
} = require("../inventory/reset-seed-core.js");

const UUIDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];

function candidateItems() {
  return [
    {
      id: "legacy-a",
      model: "DUPLICATE-MODEL",
      category: "Chair",
      stock: 2,
      sourceFile: "TEK-STOCK-LIVE.xlsx",
      sourceSheet: "Inventory",
      sourceRow: 5,
      imageSha256: "photo-a",
      imageVersion: "sha256-photo-a",
      embeddedImageDataUrl: "data:image/png;base64,ignored",
    },
    {
      id: "legacy-b",
      model: "DUPLICATE-MODEL",
      category: "Chair",
      stock: 3,
      sourceFile: "TEK-STOCK-LIVE.xlsx",
      sourceSheet: "Inventory",
      sourceRow: 6,
      imageSha256: "photo-b",
      imageVersion: "sha256-photo-b",
      embeddedImageDataUrl: "data:image/png;base64,ignored",
    },
  ];
}

function makeDeps(overrides = {}) {
  const calls = [];
  const audit = new Map();
  const state = {
    snapshot: { revision: 232, items: [{ id: "old", model: "OLD", stock: 9 }] },
    workbook: { items: [{ id: "old", model: "OLD", stock: 9 }] },
    photos: "photos-before",
  };
  let idIndex = 0;
  const deps = {
    acquireLock: async (input) => {
      calls.push(["lock", input]);
      return () => calls.push(["unlock"]);
    },
    createBackup: async (input) => {
      calls.push(["backup", input]);
      return { id: "backup-1", ok: true };
    },
    readAudit: async (runId) => audit.get(runId) || null,
    appendAudit: async (entry) => {
      calls.push(["audit", entry]);
      audit.set(entry.runId, entry);
    },
    readSnapshot: async () => structuredClone(state.snapshot),
    readWorkbook: async () => structuredClone(state.workbook),
    writeWorkbook: async (payload) => {
      calls.push(["workbook-write", payload]);
      state.workbook = structuredClone(payload);
    },
    restoreWorkbook: async (backup) => {
      calls.push(["workbook-restore", backup]);
      state.workbook = structuredClone(backup.workbook);
    },
    photoManifest: async () => state.photos,
    resetAndSeed: async (input) => {
      calls.push(["reset-seed", input]);
      state.snapshot = { revision: 233, items: structuredClone(input.items) };
      return { ok: true, committed: true, revision: 233, items: structuredClone(input.items) };
    },
    rollbackResetSeed: async (input) => {
      calls.push(["remote-rollback", input]);
      state.snapshot = { revision: 232, items: [{ id: "old", model: "OLD", stock: 9 }] };
    },
    createWorkbookId: () => UUIDS[0],
    createItemId: () => UUIDS[++idIndex],
    ...overrides,
  };
  return { deps, calls, audit, state };
}

function runInput(overrides = {}) {
  return {
    runId: "reset-seed-run-1",
    confirmation: RESET_SEED_CONFIRMATION,
    candidateItems: candidateItems(),
    ...overrides,
  };
}

test("reset-seed requires explicit confirmation and the formal API capability", async () => {
  const { deps, calls } = makeDeps({ resetAndSeed: undefined, rollbackResetSeed: undefined });
  const runner = createResetSeedRunner(deps);

  await assert.rejects(
    runner(runInput({ confirmation: "YES" })),
    (error) => error.code === "RESET_SEED_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    runner(runInput()),
    (error) => error.code === "RESET_SEED_API_UNAVAILABLE",
  );
  assert.equal(calls.some(([type]) => type === "backup" || type === "reset-seed"), false);
});

test("reset-seed sends one transactional request with expected revision and never sums duplicate models", async () => {
  const { deps, calls } = makeDeps();
  const runner = createResetSeedRunner(deps);

  const result = await runner(runInput());
  const request = calls.find(([type]) => type === "reset-seed")[1];
  assert.equal(result.ok, true);
  assert.equal(request.expectedRevision, 232);
  assert.equal(request.items.length, 2);
  assert.notEqual(request.items[0].id, "legacy-a");
  assert.notEqual(request.items[0].id, request.items[1].id);
  assert.deepEqual(request.items.map((item) => item.stock), [2, 3]);
  assert.equal(request.items.reduce((sum, item) => sum + item.stock, 0), 5);
  assert.equal(request.items.some((item) => "embeddedImageDataUrl" in item || "image" in item), false);
  assert.equal(calls.some(([type]) => type === "photo-upload"), false);
});

test("repeating the same run is idempotent and does not reset twice", async () => {
  const { deps, calls } = makeDeps();
  const runner = createResetSeedRunner(deps);

  const first = await runner(runInput());
  const resetCallsAfterFirst = calls.filter(([type]) => type === "reset-seed").length;
  const second = await runner(runInput());
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(calls.filter(([type]) => type === "reset-seed").length, resetCallsAfterFirst);
});

test("a held transaction lock blocks a concurrent reset-seed run", async () => {
  const { deps } = makeDeps({
    acquireLock: async () => {
      const error = new Error("lock held");
      error.code = "RESET_SEED_LOCKED";
      throw error;
    },
  });
  const runner = createResetSeedRunner(deps);

  await assert.rejects(runner(runInput()), (error) => error.code === "RESET_SEED_LOCKED");
});

test("a revision conflict does not write the workbook or clear cloud data", async () => {
  const { deps, calls } = makeDeps({
    resetAndSeed: async (input) => {
      calls.push(["reset-seed", input]);
      const error = new Error("revision conflict");
      error.code = "REVISION_CONFLICT";
      error.committed = false;
      throw error;
    },
  });
  const runner = createResetSeedRunner(deps);

  await assert.rejects(runner(runInput()), (error) => error.code === "REVISION_CONFLICT");
  assert.equal(calls.some(([type]) => type === "workbook-write"), false);
  assert.equal(calls.some(([type]) => type === "remote-rollback"), false);
});

test("a committed seed failure rolls the remote transaction back before returning", async () => {
  const { deps, calls } = makeDeps({
    resetAndSeed: async (input) => {
      calls.push(["reset-seed", input]);
      const error = new Error("seed failed after commit");
      error.code = "SEED_FAILED";
      error.committed = true;
      throw error;
    },
  });
  const runner = createResetSeedRunner(deps);

  await assert.rejects(runner(runInput()), (error) => error.code === "SEED_FAILED");
  assert.equal(calls.some(([type]) => type === "remote-rollback"), true);
  assert.equal(calls.some(([type]) => type === "workbook-write"), false);
});

test("an ambiguous seed failure is treated as possibly committed and rolled back", async () => {
  const { deps, calls } = makeDeps({
    resetAndSeed: async (input) => {
      calls.push(["reset-seed", input]);
      throw new Error("connection lost after request");
    },
  });
  const runner = createResetSeedRunner(deps);

  await assert.rejects(runner(runInput()), /connection lost after request/);
  assert.equal(calls.some(([type]) => type === "remote-rollback"), true);
});

test("verification failure restores local and remote state and detects photo changes", async () => {
  const { deps, calls, state } = makeDeps({
    photoManifest: async () => state.photos === "photos-before" ? "photos-before" : "photos-after",
    writeWorkbook: async (payload) => {
      calls.push(["workbook-write", payload]);
      state.workbook = structuredClone(payload);
      state.photos = "photos-after";
    },
  });
  const runner = createResetSeedRunner(deps);

  await assert.rejects(runner(runInput()), (error) => error.code === "PHOTO_MANIFEST_CHANGED");
  assert.equal(calls.some(([type]) => type === "workbook-restore"), true);
  assert.equal(calls.some(([type]) => type === "remote-rollback"), true);
});
