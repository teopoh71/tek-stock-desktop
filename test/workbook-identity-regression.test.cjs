"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCentralSync } = require("../central-sync.cjs");
const { buildWorkbookDelta, planBlankIdRows } = require("../inventory/excel-delta-core.js");

function item(id, model, sourceRow, extra = {}) {
  return { id, model, sourceRow, category: "Chair", stock: 1, specification: "", ...extra };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-tek-stock-authority-id": "test-authority" },
  });
}

function isolatedApi(items = []) {
  const state = { revision: 7, items: structuredClone(items), batches: [], presigns: 0, puts: 0 };
  return {
    state,
    async fetch(url, init = {}) {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/snapshot") {
        return json({ revision: state.revision, items: state.items, fingerprint: "f", photoFingerprint: "p" });
      }
      if (parsed.pathname === "/v1/changes") {
        return json({ fromRevision: state.revision, toRevision: state.revision,
          currentRevision: state.revision, events: [], hasMore: false });
      }
      if (parsed.pathname === "/v1/items/batch") {
        const body = JSON.parse(String(init.body || "{}"));
        state.batches.push(body);
        const byId = new Map(state.items.map((entry) => [entry.id, entry]));
        for (const operation of body.operations || []) {
          if (operation.type === "upsert") byId.set(operation.item.id, structuredClone(operation.item));
          if (operation.type === "delete") byId.delete(operation.itemId);
        }
        state.items = [...byId.values()];
        state.revision += 1;
        return json({ ok: true, revision: state.revision });
      }
      if (parsed.pathname === "/v1/photos/presign") {
        state.presigns += 1;
        return json({ uploadUrl: "https://upload.test/photo", objectKey: "photos/test.webp" });
      }
      if (parsed.hostname === "upload.test") {
        state.puts += 1;
        return new Response("", { status: 200 });
      }
      return json({ code: "NOT_FOUND" }, 404);
    },
  };
}

function service(directory, api) {
  return createCentralSync({
    storageDirectory: directory,
    fetchImpl: api.fetch,
    getApiBaseUrl: () => "https://api.test",
    getOssBaseUrl: () => "https://oss.test",
    getAuthorityId: () => "test-authority",
    getToken: () => "test-token",
  });
}

const REVIEWED_RESTORE_ID = "中角桌和其它数量.xlsx::忧闲椅和沙发床::10";
const REVIEWED_RETIRE_ID = "fc55fe56-9a1b-40ea-b377-9db2654e567f";

function reviewedLegacyFixture() {
  const current = Array.from({ length: 320 }, (_, index) =>
    item(`legacy.xlsx::Sheet1::${index + 5}`, `MODEL-${index + 1}`, index + 5));
  const restore = item(REVIEWED_RESTORE_ID, "5555", 10, { category: "Other" });
  const retire = item(REVIEWED_RETIRE_ID, "121212", 326, { category: "Other" });
  return { current, baseline: [...structuredClone(current), restore, retire],
    live: [...structuredClone(current), structuredClone(restore)] };
}

function repairedWorkbook(fixture, sha256 = "repaired-sha") {
  return {
    ok: true,
    sha256,
    items: structuredClone(fixture.live),
    sync: { revision: 232, itemCount: 321 },
    baseline: { revision: 232, itemCount: 321, records: structuredClone(fixture.live) },
  };
}

test("normal sync restores reviewed 5555 and retires stale 121212 without cloud writes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-reviewed-legacy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = reviewedLegacyFixture();
  const api = isolatedApi(fixture.live);
  api.state.revision = 232;
  const sync = service(directory, api);
  let assignments = 0;
  let acknowledgements = 0;
  let replacement;
  let workbook = {
    ok: true,
    sha256: "reviewed-sha",
    items: fixture.current,
    sync: { revision: 231, itemCount: 322 },
    baseline: { revision: 231, itemCount: 322, records: fixture.baseline },
  };
  const result = await sync.syncWorkbook({
    readWorkbook: async () => structuredClone(workbook),
    assignIds: async () => { assignments += 1; return { ok: true }; },
    acknowledge: async () => { acknowledgements += 1; return { ok: true }; },
    replaceWorkbook: async (payload) => {
      replacement = payload;
      workbook = repairedWorkbook(fixture);
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.workbookAcknowledged, true);
  assert.equal(result.workbookReplaced, true);
  assert.equal(result.operations, 0);
  assert.equal(result.photos, 0);
  assert.equal(result.assignments, 0);
  assert.equal(assignments, 0);
  assert.equal(acknowledgements, 0);
  assert.deepEqual(api.state.batches, []);
  assert.equal(replacement.items.length, 321);
  assert.equal(replacement.items.some((entry) => entry.id === REVIEWED_RESTORE_ID), true);
  assert.equal(replacement.items.some((entry) => entry.id === REVIEWED_RETIRE_ID), false);
  assert.deepEqual(new Set(replacement.items.map((entry) => entry.id)),
    new Set(fixture.live.map((entry) => entry.id)));
});

test("post-repair legacy state is idempotent and accepts exactly one new UUID row", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-reviewed-steady-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = reviewedLegacyFixture();
  const api = isolatedApi(fixture.live);
  api.state.revision = 232;
  const sync = service(directory, api);
  let workbook = repairedWorkbook(fixture);
  let assignedId = "";
  const callbacks = {
    readWorkbook: async () => structuredClone(workbook),
    assignIds: async (assignments) => {
      assert.equal(assignments.length, 1);
      assert.equal(assignments[0].sourceRow, 326);
      assert.match(assignments[0].id, /^[a-z0-9][a-z0-9._-]{0,127}$/i);
      assignedId = assignments[0].id;
      workbook.items.at(-1).id = assignments[0].id;
      workbook.sha256 = "assigned-sha";
      return { ok: true };
    },
    acknowledge: async ({ items, sync: metadata }) => {
      workbook = {
        ok: true,
        sha256: "ack-sha",
        items: structuredClone(items),
        sync: { revision: metadata.revision, itemCount: items.length },
        baseline: { revision: metadata.revision, itemCount: items.length,
          records: structuredClone(items) },
      };
      return { ok: true };
    },
    replaceWorkbook: async ({ items, sync: metadata }) => {
      workbook = {
        ok: true,
        sha256: "replacement-sha",
        items: structuredClone(items),
        sync: { revision: metadata.revision, itemCount: items.length },
        baseline: { revision: metadata.revision, itemCount: items.length,
          records: structuredClone(items) },
      };
      return { ok: true };
    },
  };
  const unchanged = await sync.syncWorkbook(callbacks);
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.operations, 0);
  workbook.items.push(item("", "ONE-NEW-MODEL", 326));
  const appended = await sync.syncWorkbook(callbacks);
  assert.equal(appended.ok, true, JSON.stringify(appended));
  assert.equal(appended.operations, 1);
  assert.equal(appended.assignments, 1);
  assert.equal(api.state.items.length, 322);
  assert.equal(api.state.items.some((entry) => entry.id === assignedId), true);
});

test("reviewed replacement rejects a cloud revision drift after workbook write", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-reviewed-drift-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = reviewedLegacyFixture();
  const api = isolatedApi(fixture.live);
  api.state.revision = 232;
  const sync = service(directory, api);
  let workbook = {
    ok: true, sha256: "before", items: fixture.current,
    sync: { revision: 231, itemCount: 322 },
    baseline: { revision: 231, itemCount: 322, records: fixture.baseline },
  };
  await assert.rejects(sync.syncWorkbook({
    readWorkbook: async () => structuredClone(workbook),
    assignIds: async () => { throw new Error("unexpected assignment"); },
    replaceWorkbook: async () => {
      workbook = repairedWorkbook(fixture);
      api.state.revision = 233;
      return { ok: true };
    },
  }), { code: "WORKBOOK_REVIEWED_LEGACY_VERIFICATION_FAILED" });
  assert.deepEqual(api.state.batches, []);
});

test("legacy implicit photo repair blocks before ID assignment or any cloud write", async (t) => {
  for (const withAppend of [false, true]) {
    await t.test(withAppend ? "with UUID append" : "without append", async (nested) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-legacy-photo-gate-"));
      nested.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const fixture = reviewedLegacyFixture();
      const api = isolatedApi(fixture.live);
      api.state.revision = 232;
      const sync = service(directory, api);
      const workbook = repairedWorkbook(fixture);
      workbook.items[0].embeddedImageDataUrl = "data:image/png;base64,iVBORw0KGgo=";
      workbook.items[0].embeddedImageHash = "a".repeat(64);
      if (withAppend) workbook.items.push(item("", "NEW-BLOCKED", 326));
      let writes = 0;
      await assert.rejects(sync.syncWorkbook({
        readWorkbook: async () => structuredClone(workbook),
        assignIds: async () => { writes += 1; return { ok: true }; },
        acknowledge: async () => { writes += 1; return { ok: true }; },
        replaceWorkbook: async () => { writes += 1; return { ok: true }; },
      }), { code: "WORKBOOK_IDENTITY_MIGRATION_REQUIRED" });
      assert.equal(writes, 0);
      assert.deepEqual(api.state.batches, []);
      assert.equal(api.state.presigns, 0);
      assert.equal(api.state.puts, 0);
    });
  }
});

test("normal sync rejects a third reviewed-legacy discrepancy before any write", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-reviewed-legacy-reject-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = reviewedLegacyFixture();
  fixture.current[0] = { ...fixture.current[0], stock: 9 };
  const api = isolatedApi(fixture.live);
  api.state.revision = 232;
  const sync = service(directory, api);
  let writes = 0;
  await assert.rejects(sync.syncWorkbook({
    readWorkbook: async () => ({
      ok: true,
      sha256: "reviewed-sha",
      items: fixture.current,
      sync: { revision: 231, itemCount: 322 },
      baseline: { revision: 231, itemCount: 322, records: fixture.baseline },
    }),
    assignIds: async () => { writes += 1; return { ok: true }; },
    acknowledge: async () => { writes += 1; return { ok: true }; },
    replaceWorkbook: async () => { writes += 1; return { ok: true }; },
  }), { code: "WORKBOOK_REVIEWED_LEGACY_SCOPE_MISMATCH" });
  assert.equal(writes, 0);
  assert.deepEqual(api.state.batches, []);
});

test("normal sync rejects unbound legacy identity without assignments or API writes", async (t) => {
  const cases = [
    { name: "unique content match", rows: [item("", "SAME", 5)], live: [item("cloud-1", "SAME", 5)] },
    { name: "duplicate models", rows: [item("", "SAME", 5)],
      live: [item("cloud-1", "SAME", 5), item("cloud-2", "SAME", 6)] },
    { name: "acknowledged middle row", rows: [item("", "OLD", 5)], live: [item("cloud-1", "OTHER", 5)] },
    { name: "acknowledged trailing row", rows: [item("cloud-1", "KEEP", 5), item("", "OLD", 6)],
      live: [item("cloud-1", "KEEP", 5)] },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async (nested) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-identity-gate-"));
      nested.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const api = isolatedApi(fixture.live);
      const sync = service(directory, api);
      let assignCalls = 0;
      await assert.rejects(sync.syncWorkbook({
        readWorkbook: async () => ({
          ok: true,
          sha256: "isolated-sha",
          items: fixture.rows,
          sync: { revision: 7, itemCount: fixture.rows.length },
          baseline: { revision: 7, itemCount: fixture.rows.length, records: fixture.live },
        }),
        assignIds: async () => { assignCalls += 1; return { ok: true }; },
        acknowledge: async () => ({ ok: true }),
      }), { code: "WORKBOOK_IDENTITY_MIGRATION_REQUIRED" });
      assert.equal(assignCalls, 0);
      assert.deepEqual(api.state.batches, []);
    });
  }
});

test("missing workbook metadata never means an acknowledged zero-item baseline", () => {
  const result = planBlankIdRows([item("", "LEGACY", 5)], [], {
    acknowledgedItemCount: null,
    baselineComplete: false,
    randomUUID: () => "must-not-be-used",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.assignments, []);
  assert.deepEqual(result.conflicts, [{ sourceRow: 5, reason: "legacy-row-ambiguous" }]);
});

test("migration then repeated delta sync is idempotent for duplicate models", () => {
  const baseline = [
    item("permanent-a", "SAME", 5),
    item("permanent-b", "SAME", 6),
  ];
  const reordered = [
    item("permanent-b", "SAME", 20),
    item("permanent-a", "SAME", 21),
  ];
  const first = buildWorkbookDelta({ baselineRecords: baseline, currentRows: reordered });
  const second = buildWorkbookDelta({ baselineRecords: reordered, currentRows: reordered });
  assert.equal(first.ok, true);
  assert.deepEqual(first.operations, []);
  assert.equal(second.ok, true);
  assert.deepEqual(second.operations, []);
  assert.deepEqual(reordered.map((row) => row.id), ["permanent-b", "permanent-a"]);
});

test("new append is rejected unless the baseline is explicitly complete", () => {
  const live = [item("existing", "KEEP", 5)];
  const unsafe = planBlankIdRows([item("", "NEW", 6)], live, {
    acknowledgedItemCount: 1,
    baselineComplete: false,
    randomUUID: () => "new-id",
  });
  assert.equal(unsafe.ok, false);
  assert.deepEqual(unsafe.assignments, []);

  const safe = planBlankIdRows([item("", "NEW", 6)], live, {
    acknowledgedItemCount: 1,
    baselineComplete: true,
    randomUUID: () => "new-id",
  });
  assert.equal(safe.ok, true);
  assert.deepEqual(safe.assignments, [{ id: "new-id", sourceRow: 6 }]);
});

test("reported ID assignment without exact workbook persistence aborts before API write", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-id-ack-gate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const existing = item("existing", "KEEP", 5);
  const api = isolatedApi([existing]);
  const sync = service(directory, api);
  let reads = 0;
  await assert.rejects(sync.syncWorkbook({
    readWorkbook: async () => {
      reads += 1;
      return {
        ok: true,
        sha256: reads === 1 ? "before" : "after",
        items: [existing, item("", "NEW", 6)],
        sync: { revision: 7, itemCount: 1 },
        baseline: { revision: 7, itemCount: 1, records: [existing] },
      };
    },
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
  }), { code: "WORKBOOK_ID_ASSIGNMENT_NOT_ACKNOWLEDGED" });
  assert.equal(reads, 2);
  assert.deepEqual(api.state.batches, []);
});
