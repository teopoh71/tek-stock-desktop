"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildResolutionPatch,
  collectConflictResolutions,
  formatConflict,
  handleBackgroundSyncConflict,
} = require("../inventory/conflict-resolution.js");

process.env.TEK_STOCK_TEST = "1";
const {
  listSyncConflicts,
  resolveSyncConflict,
  resolveSyncConflictIpc,
  validatePhotoReplacementPayload,
  validateSyncConflictResolution,
} = require("../main.cjs");

test("conflict IPC returns a concrete safe error instead of Electron's generic rejection", async () => {
  const result = await resolveSyncConflictIpc({ opId: "invalid", resolutions: [] });
  assert.deepEqual(result, { ok: false, errorCode: "SYNC_RESOLUTION_INVALID" });
});

test("same-field conflict shows both values and requires an explicit choice", () => {
  const view = formatConflict({ itemId: "a", field: "stock", base: 1, excel: 2, cloud: 3 });
  assert.deepEqual(view, { itemId: "a", field: "stock", base: "1", excel: "2", cloud: "3" });
  assert.deepEqual(buildResolutionPatch(view, "keep-excel"), { stock: 2 });
  assert.deepEqual(buildResolutionPatch(view, "keep-cloud"), {});
});

test("resolution rejects renderer-controlled fields and choices", () => {
  assert.throws(
    () => formatConflict({ itemId: "a", field: "__proto__", base: 1, excel: 2, cloud: 3 }),
    { code: "CONFLICT_FIELD_INVALID" },
  );
  assert.throws(
    () => buildResolutionPatch({ itemId: "a", field: "stock", excel: "2" }, "open-path"),
    { code: "CONFLICT_CHOICE_INVALID" },
  );
});

test("text conflict keeps literal text and carries the product model for display", () => {
  const view = formatConflict({
    itemId: "chair-a",
    model: "CHAIR A",
    field: "specification",
    base: "Old",
    excel: "Excel text",
    cloud: "Cloud text",
  });
  assert.deepEqual(view, {
    itemId: "chair-a",
    model: "CHAIR A",
    field: "specification",
    base: "Old",
    excel: "Excel text",
    cloud: "Cloud text",
  });
  assert.deepEqual(buildResolutionPatch(view, "keep-excel"), { specification: "Excel text" });
});

test("delete-versus-edit conflict requires the same explicit keep choice", () => {
  const view = formatConflict({
    itemId: "chair-a",
    model: "CHAIR A",
    field: "_deleteProduct",
    base: "保留",
    excel: "删除",
    cloud: "保留（云端已修改）",
  });
  assert.deepEqual(buildResolutionPatch(view, "keep-excel"), { _deleteProduct: true });
  assert.deepEqual(buildResolutionPatch(view, "keep-cloud"), {});
});

test("photo conflict exposes only canonical hashes and never renderer storage locations", () => {
  const view = formatConflict({
    itemId: "chair-a",
    model: "CHAIR A",
    field: "image",
    base: "a".repeat(64),
    excel: "b".repeat(64),
    cloud: "c".repeat(64),
  });
  assert.deepEqual(buildResolutionPatch(view, "keep-excel"), {
    imageSha256: "b".repeat(64),
  });
  assert.deepEqual(buildResolutionPatch(view, "keep-cloud"), {});
  for (const value of [view.base, view.excel, view.cloud]) {
    assert.match(value, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(value, /(?:file:|https?:|[\\/])/i);
  }
});

test("IPC validation rejects paths, arbitrary keys, invalid product IDs, fields, and choices", () => {
  const valid = {
    opId: "4dc82e0a-b4fc-4df3-909c-9c00eaa2dc30",
    resolutions: [{ itemId: "chair-a", field: "stock", choice: "keep-cloud" }],
  };
  assert.deepEqual(validateSyncConflictResolution(valid), valid);
  for (const payload of [
    { ...valid, path: "C:\\inventory.xlsx" },
    { ...valid, opId: "https://attacker.test/run" },
    { ...valid, opId: "cmd:calc" },
    { ...valid, resolutions: [{ ...valid.resolutions[0], itemId: "../../chair-a" }] },
    { ...valid, resolutions: [{ ...valid.resolutions[0], field: "__proto__" }] },
    { ...valid, resolutions: [{ ...valid.resolutions[0], choice: "run-shell" }] },
  ]) {
    assert.throws(() => validateSyncConflictResolution(payload), { code: "SYNC_RESOLUTION_INVALID" });
  }
});

test("photo IPC accepts only data bytes and canonical hash/version baseline", () => {
  const valid = {
    itemId: "chair-a",
    dataUrl: "data:image/webp;base64,YQ==",
    imageSha256: "a".repeat(64),
    imageVersion: "sha256-aaaaaaaaaaaaaaaaaaaaaaaa",
  };
  assert.deepEqual(validatePhotoReplacementPayload(valid), valid);
  for (const payload of [
    { ...valid, path: "C:\\private\\photo.webp" },
    { ...valid, image: "file:///private/cache/photo.webp" },
    { ...valid, imageSha256: "not-a-hash" },
    { ...valid, imageVersion: "https://attacker.test/photo" },
    { ...valid, itemId: "../../chair-a" },
  ]) {
    assert.throws(() => validatePhotoReplacementPayload(payload), { code: "PHOTO_INPUT_INVALID" });
  }
});

function workbookConflictFixture() {
  const base = {
    id: "chair-a", model: "CHAIR A", category: "Chair", stock: 1, specification: "Old",
  };
  const excel = { ...base, stock: 2, specification: "Excel text" };
  const cloud = { ...base, stock: 3, specification: "Cloud text" };
  const entry = {
    opId: "4dc82e0a-b4fc-4df3-909c-9c00eaa2dc30",
    type: "workbook",
    state: "conflict",
    baseRevision: 7,
    baseItems: [base],
    operations: [{ type: "upsert", item: excel }],
    workbookSha256: "a".repeat(64),
    conflictCode: "CONCURRENT_MODIFICATION",
    conflictDetails: [
      { itemId: "chair-a", field: "stock", reason: "field-modified-both" },
      { itemId: "chair-a", field: "specification", reason: "field-modified-both" },
    ],
  };
  return { base, cloud, entry };
}

test("conflict listing derives the model and both values from the durable transaction", async () => {
  const { cloud, entry } = workbookConflictFixture();
  const service = {
    outbox: { snapshot: () => ({ entries: [entry] }) },
    snapshot: async () => ({ revision: 8, items: [cloud] }),
  };
  assert.deepEqual(await listSyncConflicts(service), [{
    opId: entry.opId,
    conflictCode: "CONCURRENT_MODIFICATION",
    conflicts: [
      {
        itemId: "chair-a", field: "stock", base: "1", excel: "2", cloud: "3", model: "CHAIR A",
      },
      {
        itemId: "chair-a", field: "specification", base: "Old",
        excel: "Excel text", cloud: "Cloud text", model: "CHAIR A",
      },
    ],
  }]);
});

test("complete choices create a fresh latest-revision transaction before replacing Excel", async () => {
  const { cloud, entry } = workbookConflictFixture();
  const events = [];
  let latest = { revision: 8, updatedAt: "latest", items: [cloud] };
  let rebased;
  let entries = [entry];
  const history = [];
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => history,
      rebaseWorkbookTransaction: (opId, transaction) => {
        events.push("rebase");
        rebased = { opId, transaction };
        const fresh = { ...entry, opId: "7b9bcb74-e7bd-4b4d-a5cb-6290d53585c6", state: "pending" };
        entries = [fresh];
        return fresh;
      },
    },
    canonicalSnapshot: async () => latest,
    snapshot: async () => latest,
    flush: async () => {
      events.push("flush");
      latest = { ...latest, revision: 9, items: rebased.transaction.operations.map((op) => op.item) };
      history.push({ opId: entries[0].opId, lifecycle: "acked" });
      entries = [];
      return latest;
    },
  };
  const result = await resolveSyncConflict({
    opId: entry.opId,
    resolutions: [
      { itemId: "chair-a", field: "stock", choice: "keep-excel" },
      { itemId: "chair-a", field: "specification", choice: "keep-cloud" },
    ],
  }, {
    service,
    replaceWorkbook: async (payload) => {
      events.push("replace");
      assert.equal(payload.sync.revision, 9);
      return { ok: true };
    },
  });

  assert.deepEqual(events, ["rebase", "flush", "replace"]);
  assert.equal(rebased.opId, entry.opId);
  assert.equal(rebased.transaction.baseRevision, 8);
  assert.equal(rebased.transaction.operations[0].item.stock, 2);
  assert.equal(rebased.transaction.operations[0].item.specification, "Cloud text");
  assert.equal(result.workbookReplaced, true);
});

test("stock-only resolution preserves the canonical cloud photo key", async () => {
  const { cloud, entry } = workbookConflictFixture();
  cloud.image = "photos/tek-stock/ab/canonical.webp";
  cloud.imageSha256 = "b".repeat(64);
  const decorated = { ...cloud, image: "file:///private/photo-cache/ab/canonical.webp" };
  let entries = [entry];
  const history = [];
  let transaction;
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => history,
      rebaseWorkbookTransaction: (_opId, value) => {
        transaction = value;
        const fresh = { ...entry, opId: "388b18be-681b-4da6-aad9-4d76a8462d68", state: "pending" };
        entries = [fresh];
        return fresh;
      },
    },
    canonicalSnapshot: async () => ({ revision: 8, updatedAt: "latest", items: [cloud] }),
    snapshot: async () => ({ revision: 8, updatedAt: "latest", items: [decorated] }),
    flush: async () => {
      history.push({ opId: entries[0].opId, lifecycle: "acked" });
      entries = [];
      return { revision: 9, items: transaction.operations.map((operation) => operation.item) };
    },
  };
  await resolveSyncConflict({
    opId: entry.opId,
    resolutions: [
      { itemId: "chair-a", field: "stock", choice: "keep-excel" },
      { itemId: "chair-a", field: "specification", choice: "keep-cloud" },
    ],
  }, { service, replaceWorkbook: async () => ({ ok: true }) });

  assert.equal(transaction.operations[0].item.image, "photos/tek-stock/ab/canonical.webp");
});

test("resolution waits through an active-flush race for its exact op acknowledgement", async () => {
  const { cloud, entry } = workbookConflictFixture();
  const events = [];
  const history = [];
  let entries = [entry];
  let transaction;
  let flushes = 0;
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => history,
      rebaseWorkbookTransaction: (_opId, value) => {
        events.push("rebase");
        transaction = value;
        const fresh = { ...entry, opId: "b59e7b2f-015d-4daa-960c-3744c823fcf2", state: "pending" };
        entries = [fresh];
        return fresh;
      },
    },
    canonicalSnapshot: async () => ({ revision: 8, updatedAt: "latest", items: [cloud] }),
    snapshot: async () => ({ revision: 9, updatedAt: "confirmed", items: transaction
      ? transaction.operations.map((operation) => operation.item)
      : [cloud] }),
    flush: async () => {
      flushes += 1;
      events.push(`flush-${flushes}`);
      if (flushes === 2) {
        history.push({ opId: entries[0].opId, lifecycle: "acked" });
        entries = [];
      }
    },
  };
  await resolveSyncConflict({
    opId: entry.opId,
    resolutions: [
      { itemId: "chair-a", field: "stock", choice: "keep-excel" },
      { itemId: "chair-a", field: "specification", choice: "keep-cloud" },
    ],
  }, {
    service,
    replaceWorkbook: async () => { events.push("replace"); return { ok: true }; },
  });

  assert.deepEqual(events, ["rebase", "flush-1", "flush-2", "replace"]);
});

test("resolution never replaces Excel while its exact op remains pending", async () => {
  const { cloud, entry } = workbookConflictFixture();
  let entries = [entry];
  let replacements = 0;
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => [],
      rebaseWorkbookTransaction: () => {
        const fresh = { ...entry, opId: "6f25c4f1-1226-4502-80f1-496cad4b2720", state: "pending" };
        entries = [fresh];
        return fresh;
      },
    },
    canonicalSnapshot: async () => ({ revision: 8, updatedAt: "latest", items: [cloud] }),
    snapshot: async () => ({ revision: 8, updatedAt: "latest", items: [cloud] }),
    flush: async () => {},
  };
  await assert.rejects(resolveSyncConflict({
    opId: entry.opId,
    resolutions: [
      { itemId: "chair-a", field: "stock", choice: "keep-excel" },
      { itemId: "chair-a", field: "specification", choice: "keep-cloud" },
    ],
  }, {
    service,
    replaceWorkbook: async () => { replacements += 1; return { ok: true }; },
  }), { code: "SYNC_RESOLUTION_NOT_ACKNOWLEDGED" });
  assert.equal(replacements, 0);
});

test("resolution accepts acknowledgement of its recorded CAS-rebase successor", async () => {
  const { cloud, entry } = workbookConflictFixture();
  let entries = [entry];
  const history = [];
  let replaced = false;
  const firstOpId = "f999d9f8-16f6-46bd-b503-d5cf4fd7a8c2";
  const successorOpId = "17d07ef6-c669-4729-b1a9-17a2a05d6bb8";
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => history,
      rebaseWorkbookTransaction: () => {
        const fresh = { ...entry, opId: firstOpId, state: "pending" };
        entries = [fresh];
        return fresh;
      },
    },
    canonicalSnapshot: async () => ({ revision: 8, updatedAt: "latest", items: [cloud] }),
    snapshot: async () => ({ revision: 10, updatedAt: "confirmed", items: [cloud] }),
    flush: async () => {
      history.push(
        { opId: firstOpId, lifecycle: "rebased", result: { nextOpId: successorOpId } },
        { opId: successorOpId, lifecycle: "acked" },
      );
      entries = [];
    },
  };
  await resolveSyncConflict({
    opId: entry.opId,
    resolutions: [
      { itemId: "chair-a", field: "stock", choice: "keep-excel" },
      { itemId: "chair-a", field: "specification", choice: "keep-cloud" },
    ],
  }, {
    service,
    replaceWorkbook: async () => { replaced = true; return { ok: true }; },
  });
  assert.equal(replaced, true);
});

test("keep-cloud remains authoritative without an identical API rewrite when cloud reverted", async () => {
  const { base, entry } = workbookConflictFixture();
  let entries = [entry];
  const history = [];
  let transaction;
  const latest = { revision: 9, updatedAt: "reverted", items: [base] };
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => history,
      rebaseWorkbookTransaction: (_opId, value) => {
        transaction = value;
        const fresh = { ...entry, opId: "4b43f6cb-a38f-4495-8fc9-af320619c5ce", state: "pending" };
        entries = [fresh];
        return fresh;
      },
      acknowledge: () => { entries[0].state = "acked"; },
      pruneAcknowledged: () => { entries = entries.filter((candidate) => candidate.state !== "acked"); },
    },
    canonicalSnapshot: async () => latest,
    snapshot: async () => latest,
    flush: async () => {
      history.push({ opId: entries[0].opId, lifecycle: "acked" });
      entries = [];
    },
  };
  const result = await resolveSyncConflict({
    opId: entry.opId,
    resolutions: [
      { itemId: "chair-a", field: "stock", choice: "keep-cloud" },
      { itemId: "chair-a", field: "specification", choice: "keep-cloud" },
    ],
  }, { service, replaceWorkbook: async () => ({ ok: true }) });

  assert.equal(result.apiWritePerformed, false);
  assert.equal(transaction, undefined);
  assert.equal(entries.length, 0);
});

test("delete-versus-edit resolution can explicitly keep the Excel deletion", async () => {
  const base = { id: "chair-a", model: "CHAIR A", category: "Chair", stock: 1 };
  const cloud = { ...base, stock: 3 };
  const entry = {
    opId: "3399e29f-e3c9-461d-8a47-7ae3f89c802c",
    type: "workbook",
    state: "conflict",
    baseRevision: 7,
    baseItems: [base],
    operations: [{ type: "delete", itemId: "chair-a" }],
    workbookSha256: "c".repeat(64),
    conflictCode: "WORKBOOK_MERGE_CONFLICT",
    conflictDetails: [{ itemId: "chair-a", reason: "delete-modified-live" }],
  };
  let entries = [entry];
  const history = [];
  let transaction;
  let resolved = false;
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => history,
      rebaseWorkbookTransaction: (_opId, value) => {
        transaction = value;
        const fresh = { ...entry, opId: "4d0566e7-eb9c-44fc-82a8-7c1476430dc4", state: "pending" };
        entries = [fresh];
        return fresh;
      },
    },
    canonicalSnapshot: async () => ({ revision: 8, updatedAt: "latest", items: [cloud] }),
    snapshot: async () => ({ revision: resolved ? 9 : 8, updatedAt: "confirmed",
      items: resolved ? [] : [cloud] }),
    flush: async () => {
      history.push({ opId: entries[0].opId, lifecycle: "acked" });
      entries = [];
      resolved = true;
    },
  };
  const listed = await listSyncConflicts(service);
  assert.equal(listed[0].conflicts[0].field, "_deleteProduct");
  await resolveSyncConflict({
    opId: entry.opId,
    resolutions: [{ itemId: "chair-a", field: "_deleteProduct", choice: "keep-excel" }],
  }, { service, replaceWorkbook: async () => ({ ok: true }) });
  assert.deepEqual(transaction.operations, [{ type: "delete", itemId: "chair-a" }]);
});

test("legacy duplicate delete conflicts display once and one keep-Excel choice clears them all", async () => {
  const base = { id: "chair-a", model: "2233", category: "Chair", stock: 1 };
  const cloud = { ...base, stock: 7 };
  const makeEntry = (opId, workbookSha256, updatedAt) => ({
    opId,
    type: "workbook",
    state: "conflict",
    baseRevision: 190,
    baseItems: [base],
    operations: [{ type: "delete", itemId: base.id }],
    workbookSha256,
    conflictCode: "WORKBOOK_MERGE_CONFLICT",
    conflictDetails: [{ itemId: base.id, reason: "delete-modified-live" }],
    updatedAt,
  });
  const oldEntry = makeEntry("0d28a577-0dd4-4ab5-af54-cc84d0442c01", "a".repeat(64), "2026-08-06T08:00:00Z");
  const latestEntry = makeEntry("fa35c0d0-2632-419f-aee4-64f371c61fb3", "b".repeat(64), "2026-08-06T10:00:00Z");
  let entries = [oldEntry, latestEntry];
  const history = [];
  let confirmedItems = [cloud];
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => history,
      rebaseWorkbookTransaction: (opId, value) => {
        const selected = entries.find((entry) => entry.opId === opId);
        const fresh = { ...selected, ...value,
          opId: "de4d69f6-0032-43a4-9ec2-3bfcfeff3f70", state: "pending" };
        entries = entries.filter((entry) => entry.opId !== opId).concat(fresh);
        return fresh;
      },
      acknowledge: (opId) => {
        const selected = entries.find((entry) => entry.opId === opId);
        if (selected) selected.state = "acked";
      },
      pruneAcknowledged: () => { entries = entries.filter((entry) => entry.state !== "acked"); },
    },
    canonicalSnapshot: async () => ({ revision: 190, updatedAt: "latest", items: [cloud] }),
    snapshot: async () => ({ revision: 191, updatedAt: "confirmed", items: confirmedItems }),
    flush: async () => {
      const pending = entries.find((entry) => entry.state === "pending");
      confirmedItems = [];
      history.push({ opId: pending.opId, lifecycle: "acked" });
      entries = entries.filter((entry) => entry.opId !== pending.opId);
    },
  };

  const listed = await listSyncConflicts(service);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].opId, latestEntry.opId);
  await resolveSyncConflict({
    opId: latestEntry.opId,
    resolutions: [{ itemId: base.id, field: "_deleteProduct", choice: "keep-excel" }],
  }, { service, replaceWorkbook: async () => ({ ok: true }) });
  assert.equal(entries.length, 0);
});

test("legacy duplicate delete conflicts display once and one keep-cloud choice clears them all", async () => {
  const base = { id: "chair-a", model: "2233", category: "Chair", stock: 1 };
  const cloud = { ...base, stock: 7 };
  const makeEntry = (opId, workbookSha256, updatedAt) => ({
    opId,
    type: "workbook",
    state: "conflict",
    baseRevision: 190,
    baseItems: [base],
    operations: [{ type: "delete", itemId: base.id }],
    workbookSha256,
    conflictCode: "WORKBOOK_MERGE_CONFLICT",
    conflictDetails: [{ itemId: base.id, reason: "delete-modified-live" }],
    updatedAt,
  });
  const oldEntry = makeEntry("b26567f4-f029-494b-bc88-843a56ccf7a4", "c".repeat(64), "2026-08-06T08:00:00Z");
  const latestEntry = makeEntry("f3674014-3ac3-49fc-a157-dfc37a9f3f9c", "d".repeat(64), "2026-08-06T10:00:00Z");
  let entries = [oldEntry, latestEntry];
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => [],
      acknowledge: (opId) => {
        const selected = entries.find((entry) => entry.opId === opId);
        if (selected) selected.state = "acked";
      },
      pruneAcknowledged: () => { entries = entries.filter((entry) => entry.state !== "acked"); },
    },
    canonicalSnapshot: async () => ({ revision: 190, updatedAt: "latest", items: [cloud] }),
    snapshot: async () => ({ revision: 190, updatedAt: "confirmed", items: [cloud] }),
  };
  let replacedItems;

  const listed = await listSyncConflicts(service);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].opId, latestEntry.opId);
  await resolveSyncConflict({
    opId: latestEntry.opId,
    resolutions: [{ itemId: base.id, field: "_deleteProduct", choice: "keep-cloud" }],
  }, { service, replaceWorkbook: async ({ items }) => {
    replacedItems = items;
    return { ok: true };
  } });
  assert.deepEqual(replacedItems, [cloud]);
  assert.equal(entries.length, 0);
});

test("keep-cloud ignores blank optional text churn in a legacy whole-workbook conflict", async () => {
  const deletedBase = { id: "chair-a", model: "2233", category: "Chair", stock: 1 };
  const unchangedBase = { id: "chair-b", model: "CHAIR B", category: "Chair", stock: 4 };
  const cloudDeleted = { ...deletedBase, stock: 7 };
  const entry = {
    opId: "75ca1f75-9d66-47c4-b3ae-c4caa60417dc",
    type: "workbook",
    state: "conflict",
    baseRevision: 7,
    baseItems: [deletedBase, unchangedBase],
    operations: [
      { type: "delete", itemId: "chair-a" },
      { type: "upsert", item: { ...unchangedBase, stockText: "" } },
    ],
    workbookSha256: "f".repeat(64),
    conflictCode: "WORKBOOK_MERGE_CONFLICT",
    conflictDetails: [{ itemId: "chair-a", reason: "delete-modified-live" }],
  };
  let entries = [entry];
  let rebaseCalls = 0;
  let replacement;
  const latest = { revision: 8, updatedAt: "latest", items: [cloudDeleted, unchangedBase] };
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => [],
      rebaseWorkbookTransaction: () => { rebaseCalls += 1; },
      acknowledge: () => { entries[0].state = "acked"; },
      pruneAcknowledged: () => { entries = entries.filter((candidate) => candidate.state !== "acked"); },
    },
    canonicalSnapshot: async () => latest,
    snapshot: async () => latest,
    flush: async () => { throw new Error("no API write expected"); },
  };

  const result = await resolveSyncConflict({
    opId: entry.opId,
    resolutions: [{ itemId: "chair-a", field: "_deleteProduct", choice: "keep-cloud" }],
  }, {
    service,
    replaceWorkbook: async (payload) => { replacement = payload; return { ok: true }; },
  });

  assert.equal(result.apiWritePerformed, false);
  assert.equal(rebaseCalls, 0);
  assert.equal(entries.length, 0);
  assert.deepEqual(replacement.items, latest.items);
});

test("keep-cloud ignores whole-workbook row shifts after restoring a conflicted deletion", async () => {
  const baseItems = Array.from({ length: 324 }, (_, index) => ({
    id: `id-${index}`,
    model: index === 100 ? "2233" : `MODEL-${index}`,
    category: "Chair",
    stock: 1,
    sourceFile: "TEK-STOCK-LIVE.xlsx",
    sourceSheet: "库存总表",
    sourceRow: index + 5,
  }));
  const target = baseItems[100];
  const latestItems = baseItems.map((item) => item.id === target.id
    ? { ...item, stock: 7 }
    : { ...item });
  const operations = [
    { type: "delete", itemId: target.id },
    ...baseItems.slice(101).map((item) => ({
      type: "upsert",
      item: { ...item, sourceRow: item.sourceRow - 1 },
    })),
  ];
  const entry = {
    opId: "117a0636-39db-4bf8-8e35-acdeba8c0ef1",
    type: "workbook",
    state: "conflict",
    baseRevision: 190,
    baseItems,
    operations,
    workbookSha256: "1".repeat(64),
    conflictCode: "WORKBOOK_MERGE_CONFLICT",
    conflictDetails: [{ itemId: target.id, reason: "delete-modified-live" }],
  };
  let entries = [entry];
  let apiTransaction;
  let replacement;
  const latest = { revision: 190, updatedAt: "latest", items: latestItems };
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => [],
      rebaseWorkbookTransaction: (_opId, value) => { apiTransaction = value; },
      acknowledge: () => { entries[0].state = "acked"; },
      pruneAcknowledged: () => { entries = entries.filter((candidate) => candidate.state !== "acked"); },
    },
    canonicalSnapshot: async () => latest,
    snapshot: async () => latest,
    flush: async () => { throw new Error("no API write expected"); },
  };

  const result = await resolveSyncConflict({
    opId: entry.opId,
    resolutions: [{ itemId: target.id, field: "_deleteProduct", choice: "keep-cloud" }],
  }, {
    service,
    replaceWorkbook: async (payload) => { replacement = payload; return { ok: true }; },
  });

  assert.equal(result.apiWritePerformed, false);
  assert.equal(apiTransaction, undefined);
  assert.equal(entries.length, 0);
  assert.equal(replacement.items.length, 324);
  assert.equal(replacement.items.find((item) => item.id === target.id).stock, 7);
  const rows = replacement.items.map((item) => item.sourceRow);
  assert.equal(new Set(rows).size, rows.length);
  assert.deepEqual(replacement.items, latest.items);
});

test("keep-Excel commits the deletion and shifted bindings atomically without duplicates", async () => {
  const baseItems = Array.from({ length: 324 }, (_, index) => ({
    id: `excel-id-${index}`,
    model: index === 100 ? "2233" : `MODEL-${index}`,
    category: "Chair",
    stock: 1,
    sourceFile: "TEK-STOCK-LIVE.xlsx",
    sourceSheet: "库存总表",
    sourceRow: index + 5,
  }));
  const target = baseItems[100];
  const latestItems = baseItems.map((item) => item.id === target.id
    ? { ...item, stock: 7 }
    : { ...item });
  const operations = [
    { type: "delete", itemId: target.id },
    ...baseItems.slice(101).map((item) => ({
      type: "upsert",
      item: { ...item, sourceRow: item.sourceRow - 1 },
    })),
  ];
  const entry = {
    opId: "93d087f2-51e2-43e9-80e4-a1e71117379b",
    type: "workbook",
    state: "conflict",
    baseRevision: 190,
    baseItems,
    operations,
    workbookSha256: "2".repeat(64),
    conflictCode: "WORKBOOK_MERGE_CONFLICT",
    conflictDetails: [{ itemId: target.id, reason: "delete-modified-live" }],
  };
  let entries = [entry];
  const history = [];
  let apiTransaction;
  let confirmedItems = latestItems;
  let replacement;
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => history,
      rebaseWorkbookTransaction: (_opId, value) => {
        apiTransaction = value;
        const pending = { ...entry, opId: "b4c84db8-b27a-47aa-8c46-73d73cbd4749", state: "pending" };
        entries = [pending];
        return pending;
      },
    },
    canonicalSnapshot: async () => ({ revision: 190, updatedAt: "latest", items: latestItems }),
    snapshot: async () => ({ revision: 191, updatedAt: "confirmed", items: confirmedItems }),
    flush: async () => {
      const result = new Map(latestItems.map((item) => [item.id, { ...item }]));
      for (const operation of apiTransaction.operations) {
        if (operation.type === "delete") result.delete(operation.itemId);
        else result.set(operation.item.id, { ...operation.item });
      }
      confirmedItems = [...result.values()];
      history.push({ opId: entries[0].opId, lifecycle: "acked" });
      entries = [];
    },
  };

  const result = await resolveSyncConflict({
    opId: entry.opId,
    resolutions: [{ itemId: target.id, field: "_deleteProduct", choice: "keep-excel" }],
  }, {
    service,
    replaceWorkbook: async (payload) => { replacement = payload; return { ok: true }; },
  });

  assert.equal(result.apiWritePerformed, true);
  assert.equal(apiTransaction.baseRevision, 190);
  assert.equal(apiTransaction.operations.length, 1,
    "deleting one permanent record must not rewrite rows merely because Excel row numbers shifted");
  assert.deepEqual(apiTransaction.operations[0], { type: "delete", itemId: target.id });
  assert.equal(replacement.items.length, 323);
  assert.equal(replacement.items.some((item) => item.id === target.id), false);
  const ids = replacement.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(entries.length, 0);
});

test("unrelated safe deletion survives resolution of a stock conflict", async () => {
  const conflictedBase = { id: "chair-a", model: "CHAIR A", category: "Chair", stock: 1 };
  const deletedBase = { id: "chair-b", model: "CHAIR B", category: "Chair", stock: 4 };
  const latestConflict = { ...conflictedBase, stock: 3 };
  const entry = {
    opId: "25e0dc85-ea87-4e7f-aa28-c9924ef55ad7",
    type: "workbook",
    state: "conflict",
    baseRevision: 7,
    baseItems: [conflictedBase, deletedBase],
    operations: [
      { type: "upsert", item: { ...conflictedBase, stock: 2 } },
      { type: "delete", itemId: "chair-b" },
    ],
    workbookSha256: "d".repeat(64),
    conflictCode: "WORKBOOK_MERGE_CONFLICT",
    conflictDetails: [
      { itemId: "chair-a", field: "stock", reason: "field-modified-both" },
    ],
  };
  let entries = [entry];
  const history = [];
  let transaction;
  const latest = { revision: 8, updatedAt: "latest", items: [latestConflict, deletedBase] };
  const service = {
    outbox: {
      snapshot: () => ({ entries }),
      history: () => history,
      rebaseWorkbookTransaction: (_opId, value) => {
        transaction = value;
        const fresh = { ...entry, opId: "5b876803-73ea-414c-a672-4cce50eea1bb", state: "pending" };
        entries = [fresh];
        return fresh;
      },
    },
    canonicalSnapshot: async () => latest,
    snapshot: async () => ({ revision: 9, updatedAt: "confirmed", items: [{ ...latestConflict, stock: 2 }] }),
    flush: async () => {
      history.push({ opId: entries[0].opId, lifecycle: "acked" });
      entries = [];
    },
  };
  const result = await resolveSyncConflict({
    opId: entry.opId,
    resolutions: [{ itemId: "chair-a", field: "stock", choice: "keep-excel" }],
  }, { service, replaceWorkbook: async () => ({ ok: true }) });

  assert.equal(result.workbookReplaced, true);
  assert.deepEqual(transaction.operations, [
    { type: "upsert", item: { ...latestConflict, stock: 2 } },
    { type: "delete", itemId: "chair-b" },
  ]);
});

for (const canonicalChange of [
  { name: "sourceFile", field: "sourceFile", latestValue: "replacement.xlsx" },
]) {
  test(`safe deletion fails closed when canonical ${canonicalChange.name} changed`, async () => {
    const conflictedBase = { id: "chair-a", model: "CHAIR A", category: "Chair", stock: 1 };
    const deletedBase = {
      id: "chair-b",
      model: "CHAIR B",
      category: "Chair",
      stock: 4,
      stockText: "4",
      showroomQuantity: 1,
      computedTotalSold: 2,
      totalSold: 2,
      cost: 100,
      sellingPrice: 150,
      sellingPriceText: "150",
      specification: "Oak",
      arrival: "2026-08-01",
      showroom: "A",
      outbound: "",
      sourceFile: "inventory.xlsx",
      sourceSheet: "Stock",
      sourceRow: 5,
      image: "photos/chair-b.webp",
      imageSha256: "b".repeat(64),
      imageVersion: "v1",
    };
    const latestConflict = { ...conflictedBase, stock: 3 };
    const changedDeletedItem = { ...deletedBase, [canonicalChange.field]: canonicalChange.latestValue };
    const entry = {
      opId: "b027190e-e53b-4264-9e7f-ab10bcdba7a1",
      type: "workbook",
      state: "conflict",
      baseRevision: 7,
      baseItems: [conflictedBase, deletedBase],
      operations: [
        { type: "upsert", item: { ...conflictedBase, stock: 2 } },
        { type: "delete", itemId: "chair-b" },
      ],
      workbookSha256: "e".repeat(64),
      conflictCode: "WORKBOOK_MERGE_CONFLICT",
      conflictDetails: [
        { itemId: "chair-a", field: "stock", reason: "field-modified-both" },
      ],
    };
    const latest = {
      revision: 8,
      updatedAt: "latest",
      items: [latestConflict, changedDeletedItem],
    };
    let rebaseCalls = 0;
    let flushCalls = 0;
    let replacementCalls = 0;
    const rebasedOperations = [];
    const service = {
      outbox: {
        snapshot: () => ({ entries: [entry] }),
        history: () => [],
        rebaseWorkbookTransaction: (_opId, value) => {
          rebaseCalls += 1;
          rebasedOperations.push(...value.operations);
          return { ...entry, opId: "7946b2ce-f441-4f8a-b9bc-0969b44e2761", state: "pending" };
        },
      },
      canonicalSnapshot: async () => latest,
      snapshot: async () => latest,
      flush: async () => { flushCalls += 1; },
    };

    await assert.rejects(resolveSyncConflict({
      opId: entry.opId,
      resolutions: [{ itemId: "chair-a", field: "stock", choice: "keep-excel" }],
    }, {
      service,
      replaceWorkbook: async () => {
        replacementCalls += 1;
        return { ok: true };
      },
    }), { code: "SYNC_CONFLICT_UNRESOLVABLE" });

    assert.equal(rebaseCalls, 0);
    assert.equal(flushCalls, 0);
    assert.equal(replacementCalls, 0);
    assert.deepEqual(rebasedOperations, []);
  });
}

test("partial choices perform no transaction and no workbook write", async () => {
  const { cloud, entry } = workbookConflictFixture();
  let writes = 0;
  const service = {
    outbox: {
      snapshot: () => ({ entries: [entry] }),
      rebaseWorkbookTransaction: () => { writes += 1; },
    },
    snapshot: async () => ({ revision: 8, items: [cloud] }),
    flush: async () => { writes += 1; },
  };
  await assert.rejects(resolveSyncConflict({
    opId: entry.opId,
    resolutions: [{ itemId: "chair-a", field: "stock", choice: "keep-excel" }],
  }, {
    service,
    replaceWorkbook: async () => { writes += 1; },
  }), { code: "SYNC_RESOLUTIONS_INCOMPLETE" });
  assert.equal(writes, 0);
});

test("dialog choice collection returns nothing when any conflict is closed", async () => {
  const conflicts = [
    { itemId: "chair-a", field: "stock" },
    { itemId: "chair-a", field: "specification" },
  ];
  let prompts = 0;
  const resolutions = await collectConflictResolutions(conflicts, async () => {
    prompts += 1;
    return prompts === 1 ? "keep-excel" : null;
  });
  assert.equal(resolutions, null);
  assert.equal(prompts, 2);
});

test("dialog choice collection returns one allowlisted choice per conflict", async () => {
  const conflicts = [
    { itemId: "chair-a", field: "stock" },
    { itemId: "chair-a", field: "specification" },
  ];
  const choices = ["keep-excel", "keep-cloud"];
  const resolutions = await collectConflictResolutions(conflicts, async (_conflict, index) =>
    choices[index]);
  assert.deepEqual(resolutions, [
    { itemId: "chair-a", field: "stock", choice: "keep-excel" },
    { itemId: "chair-a", field: "specification", choice: "keep-cloud" },
  ]);
});

test("background sync failure invokes the same conflict-resolution flow", async () => {
  let calls = 0;
  const resolved = await handleBackgroundSyncConflict(async () => {
    calls += 1;
    return true;
  });
  assert.equal(resolved, true);
  assert.equal(calls, 1);
});
