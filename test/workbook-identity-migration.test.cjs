"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  applyWorkbookIdentityMigration,
  planReviewedLegacyReconciliation,
  planWorkbookIdentityMigration,
  validateManifest,
  verifyReviewedLegacyReconciliationResult,
} = require("../workbook-identity-migration.cjs");

const REVIEWED_RESTORE_ID = "中角桌和其它数量.xlsx::忧闲椅和沙发床::10";
const REVIEWED_RETIRE_ID = "fc55fe56-9a1b-40ea-b377-9db2654e567f";

function row(id, model, sourceRow, extra = {}) {
  return { id, model, sourceRow, category: "Chair", specification: "", stock: 1, ...extra };
}

function manifestFor(plan, choices) {
  return {
    workbookSha256: plan.workbookSha256,
    cloudRevision: plan.cloudRevision,
    workbookId: plan.workbookId,
    schemaVersion: plan.schemaVersion,
    migrationVersion: plan.migrationVersion,
    planToken: plan.planToken,
    choices,
  };
}

function migratedWorkbook(plan, sha256, items) {
  return { sha256, items, sync: {
    workbookId: plan.workbookId,
    schemaVersion: plan.schemaVersion,
    migrationVersion: plan.migrationVersion,
    migrationPlanToken: plan.planToken,
  } };
}

function reviewedFixture() {
  const current = Array.from({ length: 320 }, (_, index) =>
    row(`legacy.xlsx::Sheet1::${index + 5}`, `MODEL-${index + 1}`, index + 5));
  const restore = row(REVIEWED_RESTORE_ID, "5555", 10, { category: "Other" });
  const retire = row(REVIEWED_RETIRE_ID, "121212", 326, { category: "Other" });
  return {
    current,
    baseline: [...structuredClone(current), structuredClone(restore), structuredClone(retire)],
    live: [...structuredClone(current), structuredClone(restore)],
    restore,
    retire,
  };
}

test("reviewed legacy reconciliation preserves live IDs and scopes only 5555 and 121212", () => {
  const fixture = reviewedFixture();
  fixture.baseline[0].image = "photos/common.webp";
  fixture.baseline[0].imageSha256 = "a".repeat(64);
  fixture.live[0].image = "photos/common.webp";
  fixture.live[0].imageSha256 = "a".repeat(64);
  fixture.current[0].image = "";
  const plan = planReviewedLegacyReconciliation({
    workbook: {
      items: fixture.current,
      sync: { revision: 231, itemCount: 322 },
      baseline: { revision: 231, itemCount: 322, records: fixture.baseline },
    },
    cloud: { revision: 232, items: fixture.live },
  });
  assert.equal(plan.matched, true);
  assert.equal(plan.replacementOnly, true);
  assert.deepEqual(plan.restoreIds, [REVIEWED_RESTORE_ID]);
  assert.deepEqual(plan.retireBaselineIds, [REVIEWED_RETIRE_ID]);
  assert.deepEqual(plan.desiredItems, fixture.live);
  assert.deepEqual(plan.cloudOperations, []);
  assert.equal(new Set(plan.desiredItems.map((item) => item.id)).size, 321);
});

test("reviewed legacy reconciliation verifies the replacement read-back exactly", () => {
  const fixture = reviewedFixture();
  const workbook = {
    items: structuredClone(fixture.live),
    sync: { revision: 232, itemCount: 321 },
    baseline: { revision: 232, itemCount: 321, records: structuredClone(fixture.live) },
  };
  assert.equal(verifyReviewedLegacyReconciliationResult({
    workbook,
    cloud: { revision: 232, items: fixture.live },
  }), true);
  workbook.items[0].stock = 99;
  assert.throws(() => verifyReviewedLegacyReconciliationResult({
    workbook,
    cloud: { revision: 232, items: fixture.live },
  }), { code: "WORKBOOK_REVIEWED_LEGACY_VERIFICATION_FAILED" });
});

test("reviewed legacy reconciliation rejects every discrepancy outside the approved identities", async (t) => {
  const cases = {
    "third baseline-only identity": (fixture) => fixture.baseline.push(row("extra", "EXTRA", 327)),
    "third live-only identity": (fixture) => fixture.live.push(row("extra", "EXTRA", 327)),
    "current-only identity": (fixture) => fixture.current.push(row("extra", "EXTRA", 327)),
    "missing shared identity": (fixture) => fixture.current.splice(0, 1),
    "restore model changed": (fixture) => { fixture.live.at(-1).model = "NOT-5555"; },
    "retired identity returned to current": (fixture) => fixture.current.push(fixture.retire),
    "retired identity returned to cloud": (fixture) => fixture.live.push(fixture.retire),
    "shared field changed": (fixture) => { fixture.current[0].stock = 2; },
    "duplicate current ID": (fixture) => { fixture.current[1].id = fixture.current[0].id; },
    "cloud revision changed": () => {},
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, () => {
      const fixture = reviewedFixture();
      mutate(fixture);
      assert.throws(() => planReviewedLegacyReconciliation({
        workbook: {
          items: fixture.current,
          sync: { revision: 231, itemCount: 322 },
          baseline: { revision: 231, itemCount: 322, records: fixture.baseline },
        },
        cloud: { revision: name === "cloud revision changed" ? 233 : 232, items: fixture.live },
      }), { code: "WORKBOOK_REVIEWED_LEGACY_SCOPE_MISMATCH" });
    });
  }
});

test("migration plan lists candidates but never auto-selects an existing ID", () => {
  const plan = planWorkbookIdentityMigration({
    workbook: { sha256: "sha-before", items: [row("", "A5115", 5)] },
    cloud: { revision: 8, items: [row("cloud-a", "A5115", 9)] },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.workbookSha256, "sha-before");
  assert.equal(plan.cloudRevision, 8);
  const [{ newItemId, ...plannedRow }] = plan.rows;
  assert.match(newItemId, /^new-[a-f0-9]{48}$/);
  assert.deepEqual(plannedRow, {
    sourceRow: 5,
    model: "A5115",
    category: "Chair",
    specification: "",
    candidates: [{ id: "cloud-a", model: "A5115", category: "Chair", specification: "" }],
  });
  assert.equal(Object.hasOwn(plan.rows[0], "selectedId"), false);
});

test("legacy IDs become explicit migration rows without being auto-selected", () => {
  const plan = planWorkbookIdentityMigration({
    workbook: { sha256: "sha-legacy", items: [row("source::A5115::5", "A5115", 5)] },
    cloud: { revision: 8, items: [row("cloud-a", "A5115", 9)] },
  });
  assert.equal(plan.ok, true);
  const [{ newItemId, ...plannedRow }] = plan.rows;
  assert.match(newItemId, /^new-[a-f0-9]{48}$/);
  assert.deepEqual(plannedRow, {
    sourceRow: 5,
    legacyId: "source::A5115::5",
    model: "A5115",
    category: "Chair",
    specification: "",
    candidates: [{ id: "cloud-a", model: "A5115", category: "Chair", specification: "" }],
  });
  assert.equal(Object.hasOwn(plan.rows[0], "selectedId"), false);
});

test("a legacy row can become a new permanent product only after an explicit manifest choice", async () => {
  const plan = planWorkbookIdentityMigration({
    workbook: { sha256: "sha-new-777", items: [row("source::Old::38", "777", 326)] },
    cloud: { revision: 266, items: [row("cloud-a", "A5115", 9)] },
  });
  assert.equal(plan.rows.length, 1);
  assert.deepEqual(plan.rows[0].candidates, []);
  assert.match(plan.rows[0].newItemId, /^new-[a-f0-9]{48}$/);
  let writes = 0;
  let current = { sha256: "sha-new-777", items: [row("source::Old::38", "777", 326)] };
  const result = await applyWorkbookIdentityMigration({
    plan,
    manifest: manifestFor(plan, [{
      sourceRow: 326,
      itemId: plan.rows[0].newItemId,
      action: "create",
    }]),
    readWorkbook: async () => structuredClone(current),
    getCloudRevision: async () => 266,
    assignIds: async (assignments, _sha, identity) => {
      writes += 1;
      current = migratedWorkbook(plan, "sha-after-777", [row(assignments[0].id, "777", 326)]);
      current.sync = { ...current.sync, ...identity };
      return { ok: true };
    },
  });
  assert.equal(writes, 1);
  assert.equal(result.assigned, 1);
  assert.equal(result.assignments[0].id, plan.rows[0].newItemId);
});

test("a caller cannot invent a new product ID outside the signed migration plan", () => {
  const plan = planWorkbookIdentityMigration({
    workbook: { sha256: "sha-new-777", items: [row("source::Old::38", "777", 326)] },
    cloud: { revision: 266, items: [row("cloud-a", "A5115", 9)] },
  });
  assert.throws(() => validateManifest(plan, manifestFor(plan, [{
    sourceRow: 326,
    itemId: "new-attacker-selected-id",
    action: "create",
  }])), { code: "WORKBOOK_MIGRATION_ITEM_INVALID" });
});

test("migration stops for a visible row count mismatch instead of inferring a repair", () => {
  const plan = planWorkbookIdentityMigration({
    workbook: {
      sha256: "sha-review",
      items: [row("source::A5115::5", "A5115", 5)],
      sync: { itemCount: 2 },
      baseline: { itemCount: 2, records: [row("old-a", "A", 5), row("old-b", "B", 6)] },
    },
    cloud: { revision: 8, items: [row("cloud-a", "A5115", 9)] },
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.errorCode, "WORKBOOK_MIGRATION_REVIEW_REQUIRED");
  assert.equal(plan.reviewRequired, true);
  assert.deepEqual(plan.review, {
    currentItemCount: 1,
    acknowledgedItemCount: 2,
    baselineRecordCount: 2,
  });
  assert.deepEqual(plan.rows, []);
});

test("a complete workbook may review only an appended legacy row as an explicit new product", () => {
  const existing = row("cloud-a", "A5115", 325);
  const appended = row("source::Old::38", "777", 326, { category: "Table" });
  const plan = planWorkbookIdentityMigration({
    workbook: {
      sha256: "sha-appended-777",
      items: [existing, appended],
      sync: { itemCount: 1 },
      baseline: { itemCount: 1, records: [structuredClone(existing)] },
    },
    cloud: { revision: 266, items: [structuredClone(existing)] },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].sourceRow, 326);
  assert.equal(plan.rows[0].model, "777");
  assert.deepEqual(plan.rows[0].candidates, []);
});

test("row-count review remains fail-closed when an old row moved or changed identity", () => {
  const baseline = row("cloud-a", "A5115", 325);
  const plan = planWorkbookIdentityMigration({
    workbook: {
      sha256: "sha-not-an-append",
      items: [row("cloud-a", "A5115", 326), row("source::Old::38", "777", 325)],
      sync: { itemCount: 1 },
      baseline: { itemCount: 1, records: [baseline] },
    },
    cloud: { revision: 266, items: [structuredClone(baseline)] },
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.errorCode, "WORKBOOK_MIGRATION_REVIEW_REQUIRED");
  assert.deepEqual(plan.rows, []);
});

test("appended rows with the same legacy ID remain fail-closed", () => {
  const baseline = row("cloud-a", "A5115", 325);
  const duplicateLegacyId = "source::Old::38";
  const plan = planWorkbookIdentityMigration({
    workbook: {
      sha256: "sha-duplicate-append",
      items: [
        baseline,
        row(duplicateLegacyId, "777", 326),
        row(duplicateLegacyId, "778", 327),
      ],
      sync: { itemCount: 1 },
      baseline: { itemCount: 1, records: [structuredClone(baseline)] },
    },
    cloud: { revision: 266, items: [structuredClone(baseline)] },
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.errorCode, "WORKBOOK_MIGRATION_REVIEW_REQUIRED");
  assert.deepEqual(plan.rows, []);
});

test("migration requires a complete one-to-one explicit manifest", async () => {
  const plan = planWorkbookIdentityMigration({
    workbook: { sha256: "sha-before", items: [row("", "SAME", 5), row("", "SAME", 6)] },
    cloud: { revision: 8, items: [row("cloud-a", "SAME", 9), row("cloud-b", "SAME", 10)] },
  });
  const unchanged = async () => ({ sha256: "sha-before", items: [row("", "SAME", 5), row("", "SAME", 6)] });
  await assert.rejects(applyWorkbookIdentityMigration({
    plan,
    manifest: manifestFor(plan, [{ sourceRow: 5, itemId: "cloud-a" }]),
    readWorkbook: unchanged,
    getCloudRevision: async () => 8,
    assignIds: async () => ({ ok: true }),
  }), { code: "WORKBOOK_MIGRATION_MANIFEST_INCOMPLETE" });
  await assert.rejects(applyWorkbookIdentityMigration({
    plan,
    manifest: manifestFor(plan, [
      { sourceRow: 5, itemId: "cloud-a" }, { sourceRow: 6, itemId: "cloud-a" },
    ]),
    readWorkbook: unchanged,
    getCloudRevision: async () => 8,
    assignIds: async () => ({ ok: true }),
  }), { code: "WORKBOOK_MIGRATION_ID_REUSED" });
});

test("migration rejects duplicate, illegal, and unknown workbook IDs before offering choices", () => {
  const cloud = { revision: 8, items: [row("cloud-a", "A", 9), row("cloud-b", "B", 10)] };
  assert.throws(() => planWorkbookIdentityMigration({
    workbook: { sha256: "sha", items: [row("cloud-a", "A", 5), row("cloud-a", "A", 6)] },
    cloud,
  }), { code: "WORKBOOK_DUPLICATE_ID" });
  assert.throws(() => planWorkbookIdentityMigration({
    workbook: { sha256: "sha", items: [row("bad id", "A", 5)] },
    cloud,
  }), { code: "WORKBOOK_RECORD_ID_INVALID" });
  assert.throws(() => planWorkbookIdentityMigration({
    workbook: { sha256: "sha", items: [row("cloud-missing", "A", 5)] },
    cloud,
  }), { code: "WORKBOOK_UNKNOWN_ID" });
});

test("migration rejects swapping candidates between different workbook rows", async () => {
  const plan = planWorkbookIdentityMigration({
    workbook: { sha256: "sha-before", items: [row("", "A", 5), row("", "B", 6)] },
    cloud: { revision: 8, items: [row("cloud-a", "A", 9), row("cloud-b", "B", 10)] },
  });
  await assert.rejects(applyWorkbookIdentityMigration({
    plan,
    manifest: manifestFor(plan, [
      { sourceRow: 5, itemId: "cloud-b" }, { sourceRow: 6, itemId: "cloud-a" },
    ]),
    readWorkbook: async () => ({ sha256: "sha-before", items: [row("", "A", 5), row("", "B", 6)] }),
    getCloudRevision: async () => 8,
    assignIds: async () => ({ ok: true }),
  }), { code: "WORKBOOK_MIGRATION_ITEM_NOT_CANDIDATE" });
});

test("migration rejects stale workbook SHA and cloud revision before writing", async () => {
  const plan = planWorkbookIdentityMigration({
    workbook: { sha256: "sha-before", items: [row("", "A", 5)] },
    cloud: { revision: 8, items: [row("cloud-a", "A", 9)] },
  });
  let writes = 0;
  const base = {
    plan,
    manifest: manifestFor(plan, [{ sourceRow: 5, itemId: "cloud-a" }]),
    assignIds: async () => { writes += 1; return { ok: true }; },
  };
  await assert.rejects(applyWorkbookIdentityMigration({
    ...base,
    readWorkbook: async () => ({ sha256: "different", items: [row("", "A", 5)] }),
    getCloudRevision: async () => 8,
  }), { code: "WORKBOOK_CONTENT_CHANGED" });
  await assert.rejects(applyWorkbookIdentityMigration({
    ...base,
    readWorkbook: async () => ({ sha256: "sha-before", items: [row("", "A", 5)] }),
    getCloudRevision: async () => 9,
  }), { code: "WORKBOOK_MIGRATION_CLOUD_CHANGED" });
  assert.equal(writes, 0);
});

test("migration verifies exact write-back and repeated apply is a no-op", async () => {
  const plan = planWorkbookIdentityMigration({
    workbook: { sha256: "sha-before", items: [row("", "A", 5), row("", "B", 6)] },
    cloud: { revision: 8, items: [row("cloud-a", "A", 9), row("cloud-b", "B", 10)] },
  });
  const manifest = manifestFor(plan, [
    { sourceRow: 5, itemId: "cloud-a" }, { sourceRow: 6, itemId: "cloud-b" },
  ]);
  let workbook = { sha256: "sha-before", items: [row("", "A", 5), row("", "B", 6)] };
  let writes = 0;
  const options = {
    plan,
    manifest,
    readWorkbook: async () => structuredClone(workbook),
    getCloudRevision: async () => 8,
    assignIds: async (assignments, expectedSha256, identity) => {
      writes += 1;
      assert.equal(expectedSha256, "sha-before");
      workbook = migratedWorkbook(plan, "sha-after", workbook.items.map((source) => ({
        ...source,
        id: assignments.find((entry) => entry.sourceRow === source.sourceRow)?.id || source.id,
      })));
      return { ok: true };
    },
  };
  const first = await applyWorkbookIdentityMigration(options);
  const second = await applyWorkbookIdentityMigration(options);
  assert.equal(first.ok, true);
  assert.equal(first.alreadyApplied, false);
  assert.equal(second.ok, true);
  assert.equal(second.alreadyApplied, true);
  assert.equal(writes, 1);
  assert.deepEqual(workbook.items.map((item) => item.id), ["cloud-a", "cloud-b"]);
});

test("partial or moved write-back fails verification", async () => {
  const plan = planWorkbookIdentityMigration({
    workbook: { sha256: "sha-before", items: [row("", "A", 5), row("", "B", 6)] },
    cloud: { revision: 8, items: [row("cloud-a", "A", 9), row("cloud-b", "B", 10)] },
  });
  const manifest = manifestFor(plan, [
    { sourceRow: 5, itemId: "cloud-a" }, { sourceRow: 6, itemId: "cloud-b" },
  ]);
  let reads = 0;
  await assert.rejects(applyWorkbookIdentityMigration({
    plan,
    manifest,
    getCloudRevision: async () => 8,
    readWorkbook: async () => {
      reads += 1;
      return reads === 1
        ? { sha256: "sha-before", items: [row("", "A", 5), row("", "B", 6)] }
        : migratedWorkbook(plan, "sha-after", [row("cloud-a", "A", 6), row("", "B", 5)]);
    },
    assignIds: async () => ({ ok: true }),
  }), { code: "WORKBOOK_ID_ASSIGNMENT_NOT_ACKNOWLEDGED" });
});

test("migration rolls back when cloud changes after workbook assignment", async () => {
  const plan = planWorkbookIdentityMigration({
    workbook: { sha256: "sha-before", items: [row("", "A", 5)] },
    cloud: { revision: 8, items: [row("cloud-a", "A", 9)] },
  });
  let workbook = { sha256: "sha-before", items: [row("", "A", 5)] };
  let revisionReads = 0;
  let rollbacks = 0;
  await assert.rejects(applyWorkbookIdentityMigration({
    plan,
    manifest: manifestFor(plan, [{ sourceRow: 5, itemId: "cloud-a" }]),
    readWorkbook: async () => structuredClone(workbook),
    getCloudRevision: async () => (++revisionReads === 1 ? 8 : 9),
    assignIds: async () => {
      workbook = migratedWorkbook(plan, "sha-after", [row("cloud-a", "A", 5)]);
      return { rollback: async () => { rollbacks += 1; workbook = { sha256: "sha-before", items: [row("", "A", 5)] }; } };
    },
  }), { code: "WORKBOOK_MIGRATION_CLOUD_CHANGED" });
  assert.equal(rollbacks, 1);
  assert.equal(workbook.items[0].id, "");
});
