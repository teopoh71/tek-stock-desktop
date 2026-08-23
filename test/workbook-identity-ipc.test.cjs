"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyWorkbookIdentityMigrationIpc,
  getWorkbookIdentityMigrationPlan,
} = require("../main.cjs");

function isolatedFixture() {
  let sha256 = "sha-before";
  let items = [{ sourceRow: 8, id: "", model: "5566-TEST", category: "餐椅", specification: "GRAY" }];
  let assignmentCalls = 0;
  let syncCalls = 0;
  let identity = {};
  const cloud = {
    revision: 12,
    items: [{ id: "id-5566", model: "5566-TEST", category: "餐椅", specification: "GRAY" }],
  };
  return {
    service: { snapshot: async () => structuredClone(cloud) },
    readWorkbook: async () => ({ ok: true, sha256, rawItems: structuredClone(items), sync: identity }),
    assignIds: async (assignments, expectedSha256, nextIdentity) => {
      assignmentCalls += 1;
      assert.equal(expectedSha256, "sha-before");
      items = items.map((item) => item.sourceRow === assignments[0].sourceRow
        ? { ...item, id: assignments[0].id }
        : item);
      sha256 = "sha-after";
      identity = { ...nextIdentity };
      return { ok: true };
    },
    syncWorkbook: async () => {
      syncCalls += 1;
      return { ok: true, workbookAcknowledged: true, revision: 12 };
    },
    counts: () => ({ assignmentCalls, syncCalls, items: structuredClone(items) }),
  };
}

test("desktop migration IPC plans without selecting and applies one exact row-to-ID choice", async () => {
  const fixture = isolatedFixture();
  const plan = await getWorkbookIdentityMigrationPlan(fixture);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].selectedId, undefined);
  const manifest = {
    workbookSha256: plan.workbookSha256,
    cloudRevision: plan.cloudRevision,
    workbookId: plan.workbookId,
    schemaVersion: plan.schemaVersion,
    migrationVersion: plan.migrationVersion,
    planToken: plan.planToken,
    choices: [{ sourceRow: 8, itemId: "id-5566" }],
  };
  const result = await applyWorkbookIdentityMigrationIpc(manifest, fixture);
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.counts(), {
    assignmentCalls: 1,
    syncCalls: 1,
    items: [{ sourceRow: 8, id: "id-5566", model: "5566-TEST", category: "餐椅", specification: "GRAY" }],
  });
});

test("repeating the same desktop migration is idempotent and never writes another ID", async () => {
  const fixture = isolatedFixture();
  const plan = await getWorkbookIdentityMigrationPlan(fixture);
  const manifest = {
    workbookSha256: plan.workbookSha256,
    cloudRevision: plan.cloudRevision,
    workbookId: plan.workbookId,
    schemaVersion: plan.schemaVersion,
    migrationVersion: plan.migrationVersion,
    planToken: plan.planToken,
    choices: [{ sourceRow: 8, itemId: "id-5566" }],
  };
  await applyWorkbookIdentityMigrationIpc(manifest, fixture);
  const repeated = await applyWorkbookIdentityMigrationIpc(manifest, fixture);
  assert.equal(repeated.migration.alreadyApplied, true);
  assert.equal(fixture.counts().assignmentCalls, 1);
  assert.equal(fixture.counts().syncCalls, 2);
});

test("desktop migration explicitly creates a fresh identity for a new legacy row", async () => {
  let sha256 = "sha-before-new";
  let items = [{ sourceRow: 326, id: "old.xlsx::Sheet1::38", model: "777", category: "Dining table", specification: "" }];
  let identity = {};
  const fixture = {
    service: { snapshot: async () => ({ revision: 266, items: [] }) },
    readWorkbook: async () => ({ ok: true, sha256, rawItems: structuredClone(items), sync: identity }),
    assignIds: async (assignments, expectedSha256, nextIdentity) => {
      assert.equal(expectedSha256, "sha-before-new");
      items = items.map((item) => ({ ...item, id: assignments[0].id }));
      sha256 = "sha-after-new";
      identity = { ...nextIdentity };
      return { ok: true };
    },
    syncWorkbook: async () => ({ ok: true, workbookAcknowledged: true, revision: 267 }),
  };
  const plan = await getWorkbookIdentityMigrationPlan(fixture);
  assert.match(plan.rows[0].newItemId, /^new-[a-f0-9]{48}$/);
  const result = await applyWorkbookIdentityMigrationIpc({
    workbookSha256: plan.workbookSha256,
    cloudRevision: plan.cloudRevision,
    workbookId: plan.workbookId,
    schemaVersion: plan.schemaVersion,
    migrationVersion: plan.migrationVersion,
    planToken: plan.planToken,
    choices: [{ sourceRow: 326, itemId: plan.rows[0].newItemId, action: "create" }],
  }, fixture);
  assert.equal(result.ok, true);
  assert.equal(items[0].id, plan.rows[0].newItemId);
});
