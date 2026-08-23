"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const runtimeRoot = process.env.TEK_STOCK_PACKAGED_ROOT
  ? path.resolve(process.env.TEK_STOCK_PACKAGED_ROOT)
  : path.resolve(__dirname, "..");
const { createCentralSync, sha256 } = require(path.join(runtimeRoot, "central-sync.cjs"));
const { workbookSemanticFingerprint } = require(path.join(runtimeRoot, "workbook-fingerprint.cjs"));

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-tek-stock-authority-id": "test" },
  });
}

function cloudFixture(initialItems) {
  const state = { revision: 0, updatedAt: "2026-08-05T00:00:00.000Z", items: structuredClone(initialItems) };
  const uploads = new Map();
  const changes = [];
  let pendingPhotoResponse;
  let releasePhotoResponse;

  function commitChanges(operations) {
    const items = new Map(state.items.map((item) => [item.id, item]));
    const revision = state.revision + 1;
    let sequence = 0;
    for (const operation of operations) {
      if (operation.type === "delete") {
        items.delete(operation.itemId);
        changes.push({ revision, sequence: sequence++, operation: "delete", itemId: operation.itemId,
          createdAt: new Date(1_700_000_000_000 + revision).toISOString() });
      } else {
        items.set(operation.item.id, structuredClone(operation.item));
        changes.push({ revision, sequence: sequence++, operation: "upsert", itemId: operation.item.id,
          item: structuredClone(operation.item), createdAt: new Date(1_700_000_000_000 + revision).toISOString() });
      }
    }
    state.items = [...items.values()];
    state.revision = revision;
    state.updatedAt = new Date(1_700_000_000_000 + revision).toISOString();
  }

  return {
    state,
    holdPhotoDownloads() {
      pendingPhotoResponse = new Promise((resolve) => { releasePhotoResponse = resolve; });
    },
    releasePhotoDownloads() {
      releasePhotoResponse?.();
      pendingPhotoResponse = null;
    },
    async fetch(url, init = {}) {
      const parsed = new URL(url);
      if (parsed.hostname === "api.test" && parsed.pathname === "/v1/snapshot") {
        return json({ ...structuredClone(state), fingerprint: "data", photoFingerprint: "photos" });
      }
      if (parsed.hostname === "api.test" && parsed.pathname === "/v1/changes") {
        const afterRevision = Number(parsed.searchParams.get("after_revision") || 0);
        const afterSequenceText = parsed.searchParams.get("after_sequence");
        const afterSequence = afterSequenceText == null ? -1 : Number(afterSequenceText);
        const events = changes.filter((event) => event.revision > afterRevision
          || (event.revision === afterRevision && event.sequence > afterSequence));
        return json({ events: structuredClone(events), toRevision: events.at(-1)?.revision ?? afterRevision,
          toSequence: events.at(-1)?.sequence ?? (afterSequence < 0 ? null : afterSequence),
          currentRevision: state.revision, hasMore: false });
      }
      if (parsed.hostname === "api.test" && parsed.pathname === "/v1/items/batch") {
        const body = JSON.parse(init.body);
        if (body.expectedRevision !== state.revision) {
          return json({ code: "REVISION_CONFLICT", currentRevision: state.revision }, 409);
        }
        commitChanges(body.operations);
        return json({ ok: true, revision: state.revision, updatedAt: state.updatedAt });
      }
      if (parsed.hostname === "api.test" && parsed.pathname === "/v1/photos/presign") {
        const body = JSON.parse(init.body);
        return json({ objectKey: `photos/${body.itemId}/${body.sha256}.webp`,
          uploadUrl: `https://oss.test/upload/${body.sha256}`, headers: {} });
      }
      if (parsed.hostname === "api.test" && parsed.pathname === "/v1/photos/commit") {
        const body = JSON.parse(init.body);
        const item = state.items.find((candidate) => candidate.id === body.itemId);
        item.image = body.objectKey;
        item.imageSha256 = body.sha256;
        item.imageVersion = body.imageVersion;
        commitChanges([{ type: "upsert", item }]);
        return json({ ok: true, revision: state.revision, updatedAt: state.updatedAt });
      }
      if (parsed.hostname === "oss.test" && parsed.pathname.startsWith("/upload/")) {
        uploads.set(parsed.pathname.split("/").at(-1), Buffer.from(init.body));
        return new Response(null, { status: 200 });
      }
      if (parsed.hostname === "oss.test" && parsed.pathname.startsWith("/photos/")) {
        if (pendingPhotoResponse) await pendingPhotoResponse;
        const digest = path.posix.basename(parsed.pathname).split(".")[0];
        const bytes = uploads.get(digest);
        return bytes ? new Response(bytes, { status: 200, headers: { "content-type": "image/webp" } })
          : new Response(null, { status: 404 });
      }
      return json({ code: "NOT_FOUND" }, 404);
    },
  };
}

function makeService(directory, cloud, options = {}) {
  return createCentralSync({
    storageDirectory: directory,
    fetchImpl: cloud.fetch,
    getApiBaseUrl: () => "https://api.test",
    getOssBaseUrl: () => "https://oss.test",
    getToken: () => "test-token",
    ...options,
  });
}

function workbookClient(directory, cloud, initialItems) {
  const stateFile = path.join(directory, "private-workbook-state.json");
  let service = makeService(directory, cloud);
  let rows;
  let baseline;
  let revision;
  let serial;
  let currentSha;
  let callbacks;
  function persist() {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${stateFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ rows, baseline, revision, serial, currentSha }));
    fs.renameSync(temporary, stateFile);
  }
  function restore() {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    rows = state.rows;
    baseline = state.baseline;
    revision = state.revision;
    serial = state.serial;
    currentSha = state.currentSha;
  }
  function saveEmbeddedPhoto(row) {
    if (!/^data:image\//i.test(String(row.image || ""))) return;
    const bytes = Buffer.from(row.image.slice(row.image.indexOf(",") + 1), "base64");
    row.embeddedImageDataUrl = row.image;
    row.embeddedImageHash = sha256(bytes);
    row.image = "";
  }
  function createCallbacks() { return {
    readWorkbook: async () => ({
      ok: true,
      sha256: currentSha,
      items: rows.map((row) => ({
        ...row,
        image: row.imageChanged || row.imageUntracked
          ? row.image
          : (baseline.find((item) => item.id === row.id)?.image || ""),
      })),
      sync: { revision, itemCount: baseline.length },
      baseline: { revision, itemCount: baseline.length, records: structuredClone(baseline) },
    }),
    assignIds: async (assignments, expectedSha256) => {
      assert.equal(expectedSha256, currentSha);
      for (const assignment of assignments) {
        rows.find((row) => row.sourceRow === assignment.sourceRow).id = assignment.id;
      }
      currentSha = `workbook-${++serial}`;
      persist();
      return { ok: true };
    },
    acknowledge: async (payload) => {
      assert.equal(payload.ackPlan.expectedSha256, currentSha);
      baseline = structuredClone(payload.items);
      revision = payload.sync.revision;
      rows = rows.filter((row) => baseline.some((item) => item.id === row.id));
      for (const row of rows) {
        saveEmbeddedPhoto(row);
        row.imageChanged = false;
        row.imageUntracked = false;
      }
      currentSha = `workbook-${++serial}`;
      persist();
      return { ok: true };
    },
    replaceWorkbook: async (payload) => {
      assert.equal(payload.ackPlan.expectedSha256, currentSha);
      baseline = payload.items.map((item) => ({ ...item, image: item.canonicalImage || item.image }));
      rows = payload.items.map((item, index) => {
        const row = { ...item, image: "", sourceRow: index + 5,
          embeddedImageDataUrl: "", embeddedImageHash: "" };
        if (/^file:/i.test(String(item.image || ""))) {
          const bytes = fs.readFileSync(new URL(item.image));
          row.embeddedImageDataUrl = `data:image/webp;base64,${bytes.toString("base64")}`;
          row.embeddedImageHash = sha256(bytes);
        }
        return row;
      });
      revision = payload.sync.revision;
      currentSha = `workbook-${++serial}`;
      persist();
      return { ok: true };
    },
  }; }
  if (fs.existsSync(stateFile)) restore();
  else {
    rows = structuredClone(initialItems);
    baseline = structuredClone(initialItems);
    revision = 0;
    serial = 0;
    currentSha = `workbook-${serial}`;
    persist();
  }
  callbacks = createCallbacks();
  return {
    addProduct(item) { rows.push({ ...item, id: "", sourceRow: rows.length + 5,
      image: item.image, imageUntracked: !!item.image }); currentSha = `workbook-${++serial}`; persist(); },
    editProduct(id, patch) { Object.assign(rows.find((item) => item.id === id), patch); currentSha = `workbook-${++serial}`; persist(); },
    deleteProduct(id) { rows = rows.filter((item) => item.id !== id); currentSha = `workbook-${++serial}`; persist(); },
    replacePhoto(id, image) { Object.assign(rows.find((item) => item.id === id),
      { image, imageChanged: true }); currentSha = `workbook-${++serial}`; persist(); },
    restart() {
      service = null;
      callbacks = null;
      rows = null;
      baseline = null;
      currentSha = null;
      restore();
      callbacks = createCallbacks();
      service = makeService(directory, cloud);
    },
    sync() { return service.syncWorkbook(callbacks); },
    async snapshot() { return service.canonicalSnapshot(); },
    get items() { return structuredClone(baseline); },
    get photoHashes() {
      return Object.fromEntries(rows.map((row) => [row.id, String(row.embeddedImageHash || "")]));
    },
    get stateFile() { return stateFile; },
    get storageDirectory() { return directory; },
    get service() { return service; },
  };
}

async function twoWorkbookFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-two-workbooks-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const initial = [
    { id: "existing", model: "EXISTING", category: "Chair", stock: 3, specification: "OLD", sourceRow: 5 },
    { id: "delete-me", model: "DELETE", category: "Table", stock: 1, sourceRow: 6 },
  ];
  const cloud = cloudFixture(initial);
  const desktopA = workbookClient(path.join(directory, "desktop-a"), cloud, initial);
  const desktopB = workbookClient(path.join(directory, "desktop-b"), cloud, initial);
  const mobile = makeService(path.join(directory, "mobile"), cloud, { readOnly: true });
  const photoA = `data:image/png;base64,${Buffer.from("photo-a").toString("base64")}`;
  const photoB = `data:image/png;base64,${Buffer.from("photo-b").toString("base64")}`;
  return {
    cloud, desktopA, desktopB, mobile, photoA, photoB,
    async syncAll() {
      for (let round = 0; round < 3; round += 1) {
        await desktopA.sync();
        await desktopB.sync();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    async restartAll() {
      assert.equal(fs.existsSync(desktopA.stateFile), true);
      assert.equal(fs.existsSync(desktopB.stateFile), true);
      desktopA.restart();
      desktopB.restart();
    },
    assertSameProductDataAcrossCloudAndWorkbooks() {
      const comparable = (items) => items.map(({
        canonicalImage,
        photoCachePending: _pending,
        ...item
      }) => ({ ...item, image: String(canonicalImage ?? item.image ?? "") }))
        .sort((left, right) => left.id.localeCompare(right.id));
      assert.deepEqual(comparable(desktopA.items), comparable(cloud.state.items));
      assert.deepEqual(comparable(desktopB.items), comparable(cloud.state.items));
      const fingerprints = [desktopA.items, desktopB.items, cloud.state.items]
        .map((items) => workbookSemanticFingerprint(comparable(items)));
      assert.equal(new Set(fingerprints).size, 1);
      return fingerprints[0];
    },
    async assertMobileMatchesCloud() {
      const snapshot = await mobile.canonicalSnapshot();
      const byId = (items) => structuredClone(items)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
      assert.deepEqual(byId(snapshot.items), byId(cloud.state.items));
      assert.throws(() => mobile.enqueue([{ type: "delete", itemId: "existing" }]), {
        code: "READ_ONLY_CLIENT",
      });
    },
    async assertPhotoHashesAndCachesMatch() {
      const expected = new Map([
        ["A-NEW", sha256(Buffer.from("photo-a"))],
        ["EXISTING", sha256(Buffer.from("photo-b"))],
      ]);
      for (const item of cloud.state.items) {
        if (!expected.has(item.model)) continue;
        assert.equal(item.imageSha256, expected.get(item.model));
        for (const desktop of [desktopA, desktopB]) {
          assert.equal(desktop.items.find((candidate) => candidate.id === item.id).imageSha256,
            item.imageSha256);
          assert.equal(desktop.photoHashes[item.id], item.imageSha256);
          const productDirectory = path.join(desktop.storageDirectory, "photo-cache",
            sha256(Buffer.from(item.id)).slice(0, 32));
          const cached = fs.readdirSync(productDirectory)
            .find((name) => name.startsWith(`${item.imageSha256}.`));
          assert.ok(cached, `${item.model} cache must exist after automatic synchronization`);
          assert.equal(createHash("sha256").update(fs.readFileSync(path.join(productDirectory, cached))).digest("hex"),
            item.imageSha256);
        }
      }
    },
  };
}

test("two open private workbooks and mobile converge after edits, delete, restart, and photo replacement", async (t) => {
  const fixture = await twoWorkbookFixture(t);
  fixture.desktopA.addProduct({ model: "A-NEW", category: "Chair", stock: 1, image: fixture.photoA });
  fixture.desktopB.addProduct({ model: "B-NEW", category: "Table", stock: 2, image: "" });
  fixture.desktopA.editProduct("existing", { stock: 9 });
  fixture.desktopB.editProduct("existing", { specification: "B EDIT" });
  await fixture.desktopA.sync();
  await fixture.desktopB.sync();
  fixture.desktopB.replacePhoto("existing", fixture.photoB);
  fixture.desktopA.deleteProduct("delete-me");
  await fixture.syncAll();
  await fixture.restartAll();
  await fixture.syncAll();
  const fingerprint = fixture.assertSameProductDataAcrossCloudAndWorkbooks();
  await fixture.assertMobileMatchesCloud();
  await fixture.assertPhotoHashesAndCachesMatch();
  if (process.env.TEK_STOCK_PACKAGED_ROOT) {
    console.log(`PACKAGED_SMOKE revision=${fixture.cloud.state.revision} fingerprint=${fingerprint}`
      + ` ids=${fixture.cloud.state.items.map((item) => item.id).sort().join(",")}`);
  }
});

test("a newer saved workbook is reread and merged after the replacement hash guard fires", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-cas-retry-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const original = { id: "shared", model: "OLD", category: "Chair", stock: 1 };
  const remote = { ...original, model: "REMOTE" };
  const cloud = cloudFixture([remote]);
  const sync = makeService(directory, cloud);
  let workbook = { ...original };
  let sha = "snapshot-one";
  let reads = 0;
  let replacements = 0;
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({ ok: true, sha256: sha, items: [workbook],
      sync: { revision: 0, itemCount: 1 }, baseline: { revision: 0, itemCount: 1, records: [original] } }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async (payload) => {
      reads += 1;
      assert.equal(payload.ackPlan.expectedSha256, sha);
      if (replacements++ === 0) {
        workbook = { ...original, stock: 9 };
        sha = "newer-user-save";
        throw Object.assign(new Error("WORKBOOK_CONTENT_CHANGED"), { code: "WORKBOOK_CONTENT_CHANGED" });
      }
      workbook = structuredClone(payload.items[0]);
      return { ok: true };
    },
  });
  assert.ok(reads >= 2);
  assert.equal(cloud.state.items[0].model, "REMOTE");
  assert.equal(cloud.state.items[0].stock, 9);
  assert.equal(workbook.model, "REMOTE");
  assert.equal(workbook.stock, 9);
  assert.deepEqual({ cloudRevision: result.cloudRevision, conflict: result.conflict,
    retryRequired: result.retryRequired }, { cloudRevision: cloud.state.revision,
    conflict: false, retryRequired: false });
});

test("a photo cache miss does not delay workbook row convergence", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-photo-nonblocking-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("remote-photo");
  const digest = sha256(bytes);
  const remote = { id: "photo", model: "REMOTE", category: "Chair", stock: 1,
    image: `photos/photo/${digest}.webp`, imageSha256: digest };
  const stale = { id: "photo", model: "STALE", category: "Chair", stock: 1, image: "" };
  const cloud = cloudFixture([remote]);
  cloud.state.items = [remote];
  cloud.holdPhotoDownloads();
  cloud.fetch(`https://oss.test/upload/${digest}`, { body: bytes });
  const sync = makeService(directory, cloud);
  let workbookItem = stale;
  let workbookBaseline = stale;
  let workbookRevision = 0;
  const replacements = [];
  const callbacks = {
    readWorkbook: async () => ({ ok: true, sha256: "stale-sha", items: [workbookItem],
      sync: { revision: workbookRevision, itemCount: 1 },
      baseline: { revision: workbookRevision, itemCount: 1, records: [workbookBaseline] } }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => ({ ok: true }),
    replaceWorkbook: async (payload) => {
      replacements.push(payload);
      workbookBaseline = { ...payload.items[0], image: payload.items[0].canonicalImage };
      workbookItem = { ...workbookBaseline, embeddedImageDataUrl: "", embeddedImageHash: "" };
      workbookRevision = payload.sync.revision;
      return { ok: true };
    },
  };
  const result = await sync.syncWorkbook(callbacks);
  assert.equal(result.workbookReplaced, true);
  assert.equal(replacements[0].items[0].model, "REMOTE");
  assert.equal(replacements[0].items[0].image, "");
  assert.equal(replacements[0].items[0].canonicalImage, remote.image);
  cloud.releasePhotoDownloads();
  assert.match(await sync.cachePhoto(remote), /^file:/);
  await sync.syncWorkbook(callbacks);
  assert.equal(replacements.length, 2);
  assert.match(replacements[1].items[0].image, /^file:/);
});

test("polling an already-current workbook acknowledges it without rewriting", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-current-workbook-poll-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const item = { id: "current", model: "CURRENT", category: "Chair", stock: 2 };
  const sync = makeService(directory, cloudFixture([item]));
  let writes = 0;
  const result = await sync.syncWorkbook({
    readWorkbook: async () => ({ ok: true, sha256: "current-sha", items: [item],
      sync: { revision: 0, itemCount: 1 },
      baseline: { revision: 0, itemCount: 1, records: [item] } }),
    assignIds: async () => ({ ok: true }),
    acknowledge: async () => { writes += 1; return { ok: true }; },
    replaceWorkbook: async () => { writes += 1; return { ok: true }; },
  });
  assert.equal(result.workbookAcknowledged, true);
  assert.equal(result.retryRequired, false);
  assert.equal(writes, 0);
});
