# Workbook Identity Migration and Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate `WORKBOOK_LEGACY_ROW_AMBIGUOUS` recurrence by making permanent workbook IDs the only normal-sync identity, providing a guarded one-time legacy migration, and enforcing idempotent regression tests before every package build.

**Architecture:** Normal synchronization fails closed when a row lacks a verified permanent ID; it never guesses by model, category, specification, row number, or count arithmetic. A separate explicit migration path binds or creates IDs only through a reviewed manifest tied to an exact workbook SHA-256 and cloud revision, then re-reads the workbook to verify the exact row/ID mapping before any cloud write.

**Tech Stack:** Electron, Node.js CommonJS, ExcelJS, Node test runner, existing central-sync/IPC/workbook bridge.

## Global Constraints

- Do not read from or write to real inventory, the real workbook, or a remote computer during development and automated verification.
- Duplicate legacy rows, duplicate models, missing IDs, migration restart, and repeated sync must be covered by automated regressions.
- Repeated sync must be idempotent: no duplicate creates, no wrong edits, and no loss of a migrated ID.
- Every package command must run the workbook identity regression gate first.
- Do not claim completion without fresh automated results and isolated workbook/app evidence.

---

### Task 1: Freeze the Unsafe Legacy Behavior as Failing Tests

**Files:**
- Modify: `test/excel-delta-core.test.cjs`
- Modify: `test/central-sync.test.cjs`
- Create: `test/workbook-identity-regression.test.cjs`

**Interfaces:**
- Consumes: `planBlankIdRows(sourceRows, liveItems, options)` and `syncWorkbook(options)`.
- Produces: failing assertions that normal sync returns `WORKBOOK_IDENTITY_MIGRATION_REQUIRED` with zero assignments/API writes for unbound legacy rows.

- [ ] Replace the unsafe tests that permit content binding and positional row dropping with fail-closed expectations.
- [ ] Add duplicate legacy row, duplicate model, missing metadata, missing stable ID, and acknowledged-middle/trailing blank-ID cases.
- [ ] Add exact ID-assignment acknowledgement tests: absent, partial, moved, or duplicated write-back must abort before cloud mutation.
- [ ] Run `node --test test/excel-delta-core.test.cjs test/central-sync.test.cjs test/workbook-identity-regression.test.cjs` and record the expected failures caused by the current heuristics.

### Task 2: Make Normal Sync Strictly ID-Only

**Files:**
- Modify: `inventory/excel-delta-core.js`
- Modify: `central-sync.cjs`
- Modify: `main.cjs`
- Modify: `inventory/excel-sync-core.js`

**Interfaces:**
- Consumes: workbook `{items, sha256, sync, baseline}` and cloud `{items, revision}`.
- Produces: `WORKBOOK_IDENTITY_MIGRATION_REQUIRED` with bounded row details, or a strict ID-based delta.

- [ ] Preserve missing metadata as `null` rather than coercing it to zero.
- [ ] Remove normal-sync content inference and silent positional row dropping.
- [ ] Permit a new appended row only when baseline schema/revision/count/ID set and acknowledged physical region are complete and verified.
- [ ] Require each generated UUID to be written to the exact SHA-guarded workbook and re-read as an exact `{sourceRow,id}` bijection before any outbox/API operation.
- [ ] Remove all in-memory-only permanent ID generation from the cloud-write path.
- [ ] Run the Task 1 command and confirm all strict identity tests pass.

### Task 3: Add Guarded One-Time Legacy Migration

**Files:**
- Create: `workbook-identity-migration.cjs`
- Create: `test/workbook-identity-migration.test.cjs`
- Modify: `main.cjs`
- Modify: `preload.cjs`
- Modify: `inventory/app.js`
- Modify: `inventory/index.html`

**Interfaces:**
- Produces: `planWorkbookIdentityMigration({workbook, cloud})` with advisory candidates only.
- Produces: `applyWorkbookIdentityMigration({workbookSha256, cloudRevision, choices})`, where every choice is explicitly `bind-existing` or `create-new` and rows/IDs are one-to-one.

- [ ] Write failing tests for SHA mismatch, revision mismatch, reused existing ID, duplicate chosen ID, incomplete choice set, partial write-back, and repeated manifest no-op.
- [ ] Build a migration plan without auto-selecting candidates, even when content has one match.
- [ ] Validate the complete manifest atomically, write IDs through the existing SHA-guarded bridge, and re-read exact mappings before sync resumes.
- [ ] Expose a narrow IPC API and an explicit user confirmation dialog; never route migration through normal sync.
- [ ] Run `node --test test/workbook-identity-migration.test.cjs` and confirm all migration and idempotency cases pass.

### Task 4: Make Errors Readable and Recoverable

**Files:**
- Modify: `sync-trace.cjs`
- Modify: `inventory/app.js`
- Modify: `inventory/index.html`
- Modify: `inventory/styles.css`
- Modify: `test/sync-trace.test.cjs`

**Interfaces:**
- Consumes: structured identity/migration errors.
- Produces: a bounded message containing stage, reason, affected row/model, and recovery action; no truncated internal-only code.

- [ ] Add failing tests for structured serialization of legacy identity and ID-assignment acknowledgement errors.
- [ ] Preserve safe structured details across IPC while excluding secrets and raw workbook contents.
- [ ] Show `Migration required`, affected row count, and `Review rows` action; keep Excel pending until verified completion.
- [ ] Run `node --test test/sync-trace.test.cjs` and confirm the readable error assertions pass.

### Task 5: Add the Mandatory Pre-Package Regression Gate

**Files:**
- Modify: `package.json`
- Create: `scripts/run-workbook-identity-gate.cjs`
- Create: `docs/testing/workbook-identity-regression.md`

**Interfaces:**
- Produces: `npm run test:workbook-identity` and makes every packaging script depend on it.

- [ ] Add the gate command covering duplicate old rows, duplicate models, missing stable IDs, migration/re-sync, repeated sync, and exact write-back acknowledgement.
- [ ] Prepend the gate to all Windows package scripts without changing installer semantics.
- [ ] Document test names, command, expected result, and failure recovery.
- [ ] Run `npm run test:workbook-identity` twice and verify the second run has no created duplicates or changed IDs.

### Task 6: Isolated End-to-End and Packaged Verification

**Files:**
- Create: `scripts/verify-workbook-identity-isolated.cjs`
- Create: `test-artifacts/workbook-identity/<trace-id>/` at runtime only.

**Interfaces:**
- Consumes: disposable workbook copies and isolated cloud service state.
- Produces: trace evidence for add/edit/delete, App→Excel, Excel→App, close/reopen, migration, and repeated sync.

- [ ] Run the isolated verifier with duplicate-model fixtures plus `1111-TEST` and record APP→IPC→bridge→workbook evidence.
- [ ] Run the full `npm test` suite and require zero failures.
- [ ] Build the Windows artifact only after both gates pass.
- [ ] Launch the packaged build against disposable data, capture a screenshot showing sync completed without `Excel pending`, and prove `1111-TEST` maps to the same permanent ID before/after restart.
- [ ] Report exact commands, test counts, artifact path/size/hash, changed files, and any remaining limitation; do not touch production data.

