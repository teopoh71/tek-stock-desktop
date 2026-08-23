"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  beginWorkbookMigrationTransaction,
  migrationArtifactPaths,
  recoverWorkbookMigration,
} = require("../workbook-migration-transaction.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-migration-tx-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  fs.writeFileSync(file, "ORIGINAL");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, file };
}

test("migration transaction rollback restores the exact original workbook", async (t) => {
  const { file } = fixture(t);
  const tx = beginWorkbookMigrationTransaction(file, { planToken: "plan-a" });
  fs.writeFileSync(file, "PARTIAL");
  tx.markWorkbookWritten();
  await tx.rollback();
  assert.equal(fs.readFileSync(file, "utf8"), "ORIGINAL");
  const artifacts = migrationArtifactPaths(file);
  assert.equal(fs.existsSync(artifacts.lock), false);
  assert.equal(fs.existsSync(artifacts.journal), false);
  assert.equal(fs.existsSync(artifacts.backup), false);
});

test("startup recovery restores an interrupted workbook transaction", (t) => {
  const { file } = fixture(t);
  const tx = beginWorkbookMigrationTransaction(file, { planToken: "plan-a" });
  fs.writeFileSync(file, "CORRUPT");
  tx.markWorkbookWritten();
  // Simulate a crashed process by making the lock owner impossible.
  const artifacts = migrationArtifactPaths(file);
  fs.writeFileSync(artifacts.lock, JSON.stringify({ pid: 2147483647, createdAt: 1 }));
  const recovered = recoverWorkbookMigration(file);
  assert.equal(recovered.recovered, true);
  assert.equal(fs.readFileSync(file, "utf8"), "ORIGINAL");
  assert.equal(fs.existsSync(artifacts.journal), false);
});

test("startup recovery removes only a dead clean writer lock", (t) => {
  const { file } = fixture(t);
  const artifacts = migrationArtifactPaths(file);
  fs.writeFileSync(artifacts.lock, JSON.stringify({ pid: 101, createdAt: 1 }));
  const recovered = recoverWorkbookMigration(file, {
    processApi: { kill() { throw Object.assign(new Error("dead"), { code: "ESRCH" }); } },
  });
  assert.deepEqual(recovered, { recovered: false, active: false });
  assert.equal(fs.existsSync(artifacts.lock), false);
});

test("startup recovery retains a lock owned by a live process", (t) => {
  const { file } = fixture(t);
  const artifacts = migrationArtifactPaths(file);
  fs.writeFileSync(artifacts.lock, JSON.stringify({ pid: 101, createdAt: 1 }));
  const recovered = recoverWorkbookMigration(file, {
    processApi: { kill() {} },
  });
  assert.equal(recovered.active, true);
  assert.equal(fs.existsSync(artifacts.lock), true);
});

test("startup recovery retains a dead lock when backup evidence remains without a journal", (t) => {
  const { file } = fixture(t);
  const artifacts = migrationArtifactPaths(file);
  fs.writeFileSync(artifacts.lock, JSON.stringify({ pid: 101, createdAt: 1 }));
  fs.copyFileSync(file, artifacts.backup);
  const recovered = recoverWorkbookMigration(file, {
    processApi: { kill() { throw Object.assign(new Error("dead"), { code: "ESRCH" }); } },
  });
  assert.equal(recovered.active, true);
  assert.equal(recovered.reason, "WORKBOOK_MIGRATION_RECOVERY_REQUIRED");
  assert.equal(fs.existsSync(artifacts.lock), true);
  assert.equal(fs.existsSync(artifacts.backup), true);
});

test("a second writer is rejected while the first migration owns the lock", async (t) => {
  const { file } = fixture(t);
  const first = beginWorkbookMigrationTransaction(file, { planToken: "plan-a" });
  assert.throws(() => beginWorkbookMigrationTransaction(file, { planToken: "plan-b" }), {
    code: "WORKBOOK_MIGRATION_IN_PROGRESS",
  });
  await first.rollback();
});

test("finalized transaction keeps the migrated workbook and removes recovery artifacts", async (t) => {
  const { file } = fixture(t);
  const tx = beginWorkbookMigrationTransaction(file, { planToken: "plan-a" });
  fs.writeFileSync(file, "MIGRATED");
  tx.markWorkbookWritten();
  await tx.finalize();
  assert.equal(fs.readFileSync(file, "utf8"), "MIGRATED");
  const artifacts = migrationArtifactPaths(file);
  for (const artifact of Object.values(artifacts)) assert.equal(fs.existsSync(artifact), false);
});
