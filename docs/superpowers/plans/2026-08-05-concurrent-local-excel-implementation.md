# Concurrent Local Excel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let China and Singapore edit independent local Excel workbooks simultaneously while Alibaba Cloud safely merges and distributes the authoritative inventory.

**Architecture:** Replace the shared Documents workbook path with a persistent per-installation workbook under local application storage. Synchronize semantic workbook changes through permanent product IDs, atomic cloud batches, revision compare-and-swap, three-way merge, durable conflicts, and guarded local acknowledgement. Mobile remains read-only.

**Tech Stack:** Electron 37, Node.js CommonJS, ExcelJS, Windows Excel/WPS automation through PowerShell, Alibaba Cloud API/OSS, Node test runner.

## Global Constraints

- Never open or modify the old 255 MB Codex task transcript.
- Never use production inventory, production Excel files, remote computers, or mobile data in automated tests.
- Preserve old shared workbooks unchanged as backups; do not delete or overwrite them.
- Never log, hardcode, display, or commit the synchronization key.
- Alibaba Cloud remains the only shared authority; mobile is read-only.
- Data Update remains separate from application Reinstall.
- A same-field concurrent edit must never be resolved by silent last-writer-wins.
- The project is not currently a Git repository. Do not initialize one without user authorization; use passing test checkpoints instead of commits.

---

### Task 1: Per-installation private workbook location

**Files:**
- Create: `workbook-location.cjs`
- Modify: `main.cjs`
- Test: `test/workbook-location.test.cjs`

**Interfaces:**
- Produces: `createWorkbookLocation(options)` returning `{ clientId, privateWorkbookPath, legacyWorkbookPath, backupDirectory, ensureDirectories(), describe() }`.
- Consumes: `options.userDataPath`, `options.localAppDataPath`, `options.documentsPath`, `options.randomUUID`, and optional filesystem adapter.
- Later tasks consume `privateWorkbookPath` and `legacyWorkbookPath` without recomputing paths.

- [ ] **Step 1: Write the failing location tests**

```js
test("two installations never resolve to the same workbook", (t) => {
  const first = fixture(t, "pc-a", "client-a");
  const second = fixture(t, "pc-b", "client-b");
  assert.notEqual(first.privateWorkbookPath, second.privateWorkbookPath);
  assert.match(first.privateWorkbookPath, /workbooks[\\/]client-a[\\/]TEK-STOCK-LIVE\.xlsx$/);
});

test("legacy shared workbook is reported but never moved or deleted", (t) => {
  const location = fixture(t, "pc-a", "client-a");
  fs.mkdirSync(path.dirname(location.legacyWorkbookPath), { recursive: true });
  fs.writeFileSync(location.legacyWorkbookPath, "legacy");
  location.ensureDirectories();
  assert.equal(fs.readFileSync(location.legacyWorkbookPath, "utf8"), "legacy");
  assert.equal(fs.existsSync(location.privateWorkbookPath), false);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test test/workbook-location.test.cjs`

Expected: FAIL because `workbook-location.cjs` does not exist.

- [ ] **Step 3: Implement the location module**

Implement these exact rules:

```js
function createWorkbookLocation(options = {}) {
  // Persist one UUID in <userDataPath>/workbook-client.json using an atomic temp-file rename.
  // Validate an existing UUID before use; regenerate only when the file is absent.
  // Resolve the private workbook beneath:
  // <localAppDataPath>/TEK STOCK/workbooks/<clientId>/TEK-STOCK-LIVE.xlsx
  // Resolve the legacy workbook beneath:
  // <documentsPath>/TEK STOCK/TEK-STOCK-LIVE.xlsx
  // Never copy, move, rename, truncate, or delete the legacy workbook here.
}
```

Reject client IDs containing anything except lowercase hexadecimal digits and hyphens. Resolve all paths and verify the private workbook remains inside the resolved `TEK STOCK/workbooks` root.

- [ ] **Step 4: Route all workbook access through the location module**

In `main.cjs`, replace the current Documents-based `workbookPath()` implementation with the memoized `createWorkbookLocation()` result. Keep `workbookInfo()`, watchers, ID assignment, acknowledgement, Excel launch, and replacement using `workbookPath()` so they all move together.

- [ ] **Step 5: Run location and existing path-sensitive tests**

Run: `node --test test/workbook-location.test.cjs test/excel-live.test.cjs test/excel-watch.test.cjs`

Expected: all tests PASS and the legacy fixture remains byte-identical.

### Task 2: Cloud bootstrap and non-destructive migration

**Files:**
- Create: `private-workbook-bootstrap.cjs`
- Modify: `main.cjs`
- Modify: `preload.cjs`
- Modify: `inventory/app.js`
- Test: `test/private-workbook-bootstrap.test.cjs`

**Interfaces:**
- Produces: `ensurePrivateWorkbook({ location, fetchSnapshot, writeWorkbook, readWorkbook, now })` returning `{ ok, state, workbookPath, cloudRevision, legacyPreserved }`.
- `state` is one of `ready`, `bootstrapped`, `offline-not-initialized`, or `invalid-private-workbook`.
- Consumes the authoritative decorated cloud snapshot; never consumes the legacy workbook automatically.

- [ ] **Step 1: Write failing bootstrap tests**

```js
test("first launch creates the private workbook from cloud and preserves legacy bytes", async (t) => {
  const legacy = Buffer.from("legacy-master-backup");
  const fixture = bootstrapFixture(t, { legacy, cloudRevision: 184 });
  const result = await fixture.ensure();
  assert.equal(result.state, "bootstrapped");
  assert.deepEqual(fs.readFileSync(fixture.legacyPath), legacy);
  assert.equal((await fixture.readPrivate()).sync.revision, 184);
});

test("offline first launch does not copy a possibly divergent shared workbook", async (t) => {
  const fixture = bootstrapFixture(t, { legacy: Buffer.from("legacy"), offline: true });
  const result = await fixture.ensure();
  assert.equal(result.state, "offline-not-initialized");
  assert.equal(fs.existsSync(fixture.privatePath), false);
});
```

- [ ] **Step 2: Run the bootstrap tests and verify failure**

Run: `node --test test/private-workbook-bootstrap.test.cjs`

Expected: FAIL because the bootstrap service is not implemented.

- [ ] **Step 3: Implement bootstrap as an atomic create**

Write the cloud workbook to `<privateWorkbookPath>.bootstrap.xlsx`, verify it can be parsed and its revision equals the fetched snapshot, then rename it to the private path only when the private path does not exist. If the final path appeared concurrently, discard only the temporary file and read the winner.

- [ ] **Step 4: Gate the Excel button on bootstrap readiness**

Expose a preload method that invokes bootstrap before opening Excel. In `inventory/app.js`, show these exact non-sensitive outcomes:

- `bootstrapped`: `本机 Excel 已从云端建立。`
- `offline-not-initialized`: `首次建立本机 Excel 需要连接云端；旧 Excel 已保留未改动。`
- `invalid-private-workbook`: `本机 Excel 无法验证，未覆盖原文件。`

Do not ask for the sync key for a read-only snapshot fetch.

- [ ] **Step 5: Run bootstrap and UI contract tests**

Run: `node --test test/private-workbook-bootstrap.test.cjs test/excel-cloud-bootstrap.test.cjs test/preload-security.test.cjs`

Expected: all tests PASS.

### Task 3: Atomic workbook transactions and safe 409 rebase

**Files:**
- Modify: `sync-outbox.cjs`
- Modify: `central-sync.cjs`
- Test: `test/sync-outbox.test.cjs`
- Test: `test/central-sync.test.cjs`

**Interfaces:**
- Add `outbox.enqueueWorkbookTransaction({ operations, baseRevision, baseItems, workbookSha256, operator, occurredAt })`.
- A workbook transaction entry has `type: "workbook"`, one `opId`, ordered `operations`, relevant `baseItems`, and one lifecycle history.
- `central-sync.flushEntry(entry)` sends one `/v1/items/batch` request for the whole transaction.

- [ ] **Step 1: Write failing atomicity and conflict tests**

```js
test("a multi-row workbook save is one atomic API batch", async (t) => {
  const fixture = concurrencyFixture(t);
  fixture.desktopA.enqueueWorkbook([
    { type: "upsert", item: item("a", { stock: 2 }) },
    { type: "delete", itemId: "b" },
  ]);
  await fixture.desktopA.flush();
  assert.equal(fixture.api.batchRequests.length, 1);
  assert.equal(fixture.api.batchRequests[0].operations.length, 2);
});

test("confirmed 409 rebases different fields but blocks same-field overwrite", async (t) => {
  const fixture = concurrencyFixture(t, [item("a", { stock: 1, specification: "OLD" })]);
  fixture.desktopA.edit("a", { stock: 2 });
  fixture.desktopB.edit("a", { specification: "NEW" });
  await fixture.desktopA.flush();
  await fixture.desktopB.flush();
  assert.deepEqual(fixture.cloud("a"), item("a", { stock: 2, specification: "NEW" }));

  fixture.desktopA.edit("a", { stock: 3 });
  fixture.desktopB.edit("a", { stock: 4 });
  await fixture.desktopA.flush();
  await assert.rejects(fixture.desktopB.flush(), { code: "CONCURRENT_MODIFICATION" });
  assert.equal(fixture.cloud("a").stock, 3);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test test/sync-outbox.test.cjs test/central-sync.test.cjs`

Expected: the atomic workbook transaction test FAILS because current row operations flush separately.

- [ ] **Step 3: Extend the durable outbox format**

Add workbook transactions without breaking version-two row entries. Persist the exact ordered request body, baseline values, workbook SHA, request hash, operator, time, client ID, attempts, and lifecycle. A restart must reproduce the identical request for an ambiguous network failure.

- [ ] **Step 4: Flush one atomic batch and rebase only after confirmed 409**

For a confirmed revision conflict:

1. Fetch the newest snapshot.
2. Re-run `threeWayWorkbookMerge()` using the stored baseline, requested Excel result, and newest cloud data.
3. If conflict-free, create a new rebased request with a new attempt identity and newest expected revision.
4. If same-field or delete-versus-edit conflict exists, persist `conflict` lifecycle and stop without a write.
5. For a dropped response or timeout, retry the exact original body and idempotency key.

- [ ] **Step 5: Run the focused sync tests**

Run: `node --test test/sync-outbox.test.cjs test/central-sync.test.cjs test/excel-three-way-merge.test.cjs`

Expected: all tests PASS.

### Task 4: Durable conflict resolution without reinstall

**Files:**
- Create: `inventory/conflict-resolution.js`
- Modify: `inventory/index.html`
- Modify: `inventory/app.js`
- Modify: `preload.cjs`
- Modify: `main.cjs`
- Test: `test/conflict-resolution.test.cjs`
- Test: `test/preload-security.test.cjs`

**Interfaces:**
- Produces pure functions `formatConflict(conflict)` and `buildResolutionPatch(conflict, choice)` where `choice` is `keep-excel` or `keep-cloud`.
- Exposes secure IPC methods `listSyncConflicts()` and `resolveSyncConflict({ opId, resolutions })`.

- [ ] **Step 1: Write failing conflict-resolution tests**

```js
test("same-field conflict shows both values and requires an explicit choice", () => {
  const view = formatConflict({ itemId: "a", field: "stock", base: 1, excel: 2, cloud: 3 });
  assert.deepEqual(view, { itemId: "a", field: "stock", base: "1", excel: "2", cloud: "3" });
  assert.deepEqual(buildResolutionPatch(view, "keep-excel"), { stock: 2 });
  assert.deepEqual(buildResolutionPatch(view, "keep-cloud"), {});
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test test/conflict-resolution.test.cjs test/preload-security.test.cjs`

Expected: FAIL because the pure module and IPC allowlist do not exist.

- [ ] **Step 3: Implement the pure resolution module and secure IPC**

Validate `opId`, product ID, allowed fields, and choice at the IPC boundary. Never accept a file path, URL, shell command, or arbitrary object key from the renderer. Resolution creates a new compare-and-swap transaction against the latest cloud revision.

- [ ] **Step 4: Add the conflict dialog**

Show the model, field name, Excel value, and cloud value. Provide only `保留 Excel` and `保留云端` actions. Closing the dialog leaves the conflict unresolved and performs no write. Do not replace the local workbook until all conflicts in that transaction are resolved.

- [ ] **Step 5: Run conflict and security tests**

Run: `node --test test/conflict-resolution.test.cjs test/preload-security.test.cjs test/central-sync.test.cjs`

Expected: all tests PASS.

### Task 5: Continuous convergence for two open workbooks

**Files:**
- Modify: `central-sync.cjs`
- Modify: `main.cjs`
- Modify: `excel-live.cjs`
- Modify: `inventory/app.js`
- Test: `test/excel-live.test.cjs`
- Test: `test/excel-watch.test.cjs`
- Test: `test/two-workbook-convergence.test.cjs`

**Interfaces:**
- `syncWorkbook()` returns `{ cloudRevision, workbookAcknowledged, workbookReplaced, conflict, retryRequired }`.
- Workbook acknowledgement always carries `ackPlan.expectedSha256`.
- Polling pulls remote revisions even when the local workbook has no changes.

- [ ] **Step 1: Write the failing two-workbook convergence test**

```js
test("two open private workbooks and mobile converge after edits, delete, restart, and photo replacement", async (t) => {
  const fixture = await twoWorkbookFixture(t);
  await fixture.desktopA.addProduct({ model: "A-NEW", stock: 1, image: fixture.photoA });
  await fixture.desktopB.editProduct("existing", { specification: "B EDIT" });
  await fixture.desktopA.sync();
  await fixture.desktopB.sync();
  await fixture.desktopB.replacePhoto("existing", fixture.photoB);
  await fixture.desktopA.deleteProduct("delete-me");
  await fixture.syncAll();
  await fixture.restartAll();
  await fixture.syncAll();
  fixture.assertSameProductDataAcrossCloudAndWorkbooks();
  fixture.assertMobileMatchesCloud();
  fixture.assertPhotoHashesAndCachesMatch();
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `node --test test/two-workbook-convergence.test.cjs`

Expected: FAIL until private paths, atomic transactions, pull convergence, and photo cache assertions are integrated.

- [ ] **Step 3: Preserve the workbook hash guard through pull acknowledgement**

Before closing or replacing an open workbook, verify the current disk SHA-256 equals the snapshot used for the merge. On `WORKBOOK_CONTENT_CHANGED`, remove only the generated temporary replacement, reread the newer saved workbook, and retry the merge. Never overwrite the user's newer save.

- [ ] **Step 4: Pull remote changes into each private workbook**

When cloud revision advances and no unresolved local conflict exists, update workbook rows, hidden baseline, revision, and image hashes together. If Excel/WPS is open, use the existing live-workbook automation; if it has unsaved edits, defer and show `请先保存 Excel，云端更新随后自动合并。`

- [ ] **Step 5: Keep photo fetch asynchronous and cached**

Commit product data first. Download OSS photos by permanent product ID and image SHA into the existing local cache. A cache miss may show a temporary empty-photo tile but must not block inventory data convergence.

- [ ] **Step 6: Run convergence and regression tests**

Run: `node --test test/two-workbook-convergence.test.cjs test/excel-live.test.cjs test/excel-watch.test.cjs test/photo-cache.test.cjs`

Expected: all tests PASS.

### Task 6: Update migration, full verification, and local artifact

**Files:**
- Modify: `package.json`
- Modify: `build/electron-builder.update.cjs`
- Modify: `build/verify-packaged-version.cjs`
- Test: `test/update-boundary.test.cjs`
- Test: `test/installer-boundary.test.cjs`
- Create: `docs/concurrent-excel-operator-guide.md`

**Interfaces:**
- The Update package preserves application user data and the private workbook path.
- Reinstall is not invoked by synchronization or migration.

- [ ] **Step 1: Write failing update-boundary tests**

```js
test("ordinary update preserves private workbook, client ID, outbox, credentials, and photo cache", async (t) => {
  const fixture = updateFixture(t);
  const before = fixture.snapshotUserState();
  await fixture.applyUpdate();
  assert.deepEqual(fixture.snapshotUserState(), before);
  assert.equal(fixture.reinstallInvocations, 0);
});
```

- [ ] **Step 2: Run update tests and verify failure or missing coverage**

Run: `node --test test/update-boundary.test.cjs test/installer-boundary.test.cjs`

Expected: FAIL until the new private workbook paths are included in preservation assertions.

- [ ] **Step 3: Increment the application version and update packaging boundaries**

Increment the patch version once after all runtime changes are complete. Include new runtime modules and exclude tests, temporary workbooks, legacy backups, credentials, outbox state, and photo cache from the installer. Do not publish.

- [ ] **Step 4: Run the complete automated suite**

Run: `npm test`

Expected: 0 failures.

- [ ] **Step 5: Build and inspect a local Update artifact**

Run: `npm run dist:update`

Verify:

- packaged version matches `package.json`;
- `app.asar` contains the new location, bootstrap, synchronization, and conflict modules;
- no token, credential file, production workbook, backup workbook, outbox, or photo cache is packaged;
- artifact SHA-256 and byte size are recorded;
- no online publishing occurs.

- [ ] **Step 6: Run isolated packaged smoke tests**

Install or unpack the local artifact into two isolated test profiles. Keep both generated Excel workbooks open. Add different products, edit different fields, replace one photo, change stock, delete a test product, restart both applications, and verify both workbook fingerprints, cloud fixture revision, item IDs, fields, and read-only mobile fixture are identical.

- [ ] **Step 7: Write the operator guide**

Document that each computer opens Excel only through its local TEK STOCK app, both computers may edit simultaneously, users must save Excel to publish changes, same-field conflicts require a choice, and Update—not Reinstall—delivers future fixes.

- [ ] **Step 8: Record the final verification checkpoint**

Record exact test counts, artifact path, SHA-256, size, and isolated smoke-test results. Do not claim production readiness or hand over until all required tests pass.
