# Cloud Reset Local Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-way `从云端重置本机` control that safely replaces only this machine's local workbook and stale sync cache with a verified live cloud snapshot.

**Architecture:** Add a small main-process reset service/IPC operation that performs live snapshot validation, backup, temporary workbook generation/validation, guarded atomic replacement, and local outbox/cache archival. Add a renderer confirmation/progress/result flow that never invokes cloud mutation. Keep the existing client UUID, credentials, and photo cache; do not reuse bidirectional merge or conflict resolution for this action.

**Tech Stack:** Electron main/renderer IPC, Node.js filesystem/crypto, existing `central-sync.cjs`, `private-workbook-bootstrap.cjs`, `excel-live.cjs`, ExcelJS, Node test runner.

## Global Constraints

- The feature must issue zero cloud write requests and must not alter other devices.
- The user must explicitly confirm that unsynced local app/Excel changes and pending/conflict state will be discarded after backup.
- Only the local workbook plus stale local outbox/cache state may change; preserve client UUID, credentials, and photo cache.
- Require a live non-cached canonical snapshot with verified authority, revision, item count, IDs, and baseline.
- Backup and hash-verify the original workbook and selected local sync state before replacement.
- Abort safely on offline/auth/download/backup/lock/unsaved/replacement/reload failures and report rollback status.
- Do not perform the reset on the user's production machine without a separate action-time confirmation.
- Do not commit or push.

---

### Task 1: Add reset service and IPC contract

**Files:**
- Create: `cloud-reset-local.cjs`
- Modify: `main.cjs` (IPC registration and dependency wiring)
- Test: `test/cloud-reset-local.test.cjs`

**Interfaces:**
- `createCloudResetLocalRunner(deps)` produces `run(input)`.
- Input requires `confirmation: "TEK-STOCK-CLOUD-RESET-LOCAL-CONFIRMED"` and an optional `runId`.
- Dependencies provide `readLiveSnapshot`, `readWorkbook`, `writeWorkbookTemp`, `replaceWorkbook`, `backupLocalState`, `archiveSyncState`, `initializeFreshSyncState`, `reload`, and `now`.
- Result returns `{ ok, runId, backupPath, revision, itemCount, workbookPath, cloudWrites: 0 }` or a stable `errorCode` with `rolledBack`/`backupPath` where applicable.

- [ ] **Step 1: Write failing tests** for confirmation gating, live-only snapshot gating, zero cloud writes, backup-before-replacement ordering, metadata/baseline validation, original-hash race detection, and rollback after replacement or state-initialization failure.
- [ ] **Step 2: Run the focused test file** and verify the new tests fail because the runner does not exist.
- [ ] **Step 3: Implement the runner** with an explicit state machine: confirm → live snapshot → backup/hash verification → temp workbook → validation → guarded replacement → archive/reinitialize local sync state → reload → fresh live verification.
- [ ] **Step 4: Add idempotent run-audit protection** so a repeated run ID with different input cannot repeat or partially replay a reset.
- [ ] **Step 5: Run the focused tests** and verify all pass.

### Task 2: Wire filesystem safeguards to existing source patterns

**Files:**
- Modify: `main.cjs`
- Modify: `excel-live.cjs` only if a narrow reusable guard is required
- Modify: `sync-outbox.cjs` only if a narrow archive/reinitialize helper is required
- Test: `test/cloud-reset-local.test.cjs`, `test/excel-live.test.cjs`, `test/sync-outbox.test.cjs`

**Interfaces:**
- Use `workbookPath()`, `readWorkbookFile()`, `writeBootstrapWorkbook()`, `stableFileSnapshot()`, and `replaceOpenWorkbookFile()` rather than introducing a second workbook path or replacement mechanism.
- Archive `central-sync/outbox.json` and `last-good-snapshot.json` into the reset backup; create fresh empty outbox/cache state without changing `workbook-client.json`, credentials, or `photo-cache`.

- [ ] **Step 1: Add a narrow main-process adapter** that constructs the runner dependencies from the existing functions and paths.
- [ ] **Step 2: Implement backup manifest creation** with pre-reset SHA-256/mtime, client ID, workbook metadata, observed live revision, and hashes for archived state files.
- [ ] **Step 3: Generate a same-directory temporary workbook** from the live snapshot and validate with `readWorkbookFile()` for exact revision/count/IDs/baseline/fingerprint equality.
- [ ] **Step 4: Guard replacement** with the preflight workbook hash and existing open-workbook safety checks; retain a durable backup rather than deleting it after success.
- [ ] **Step 5: Archive/reinitialize only stale sync state** and add rollback for any failure after local replacement.
- [ ] **Step 6: Run focused filesystem tests** and verify original files remain byte-identical on all abort paths.

### Task 3: Add renderer control, confirmation, progress, and result state

**Files:**
- Modify: `inventory/index.html`
- Modify: `inventory/app.js`
- Modify: `preload.cjs`
- Test: `test/preload-security.test.cjs`, `test/cloud-reset-local-ui.test.cjs`

**Interfaces:**
- Expose one no-argument bridge, `window.TekStockExcel.resetLocalFromCloud()`, mapped to a dedicated IPC channel.
- Renderer must send the exact confirmation token only after the modal affirmative action; it must not expose filesystem paths or credentials unnecessarily.

- [ ] **Step 1: Add a failing UI/bridge test** asserting the button, warning copy, exact confirmation token, disabled/progress state, and result rendering.
- [ ] **Step 2: Add the button and confirmation dialog** separate from `Update` and `Excel`; copy must explicitly say unsynced local app/Excel changes and pending/conflict state are discarded after backup, cloud/other devices are unchanged.
- [ ] **Step 3: Wire the bridge and renderer state machine** for preflight, running, success (`Cloud v<revision> · <count>`), cancellation, and concrete failure/rollback messages.
- [ ] **Step 4: Reload the renderer only after a verified successful reset** and clear stale pending/conflict display only after fresh live verification.
- [ ] **Step 5: Run focused UI/bridge tests** and verify all pass.

### Task 4: Full verification and independent review

**Files:**
- Modify only tests/docs if verification exposes a defect.

- [ ] **Step 1: Run the full source test suite** with `npm test` from the TEK STOCK source project.
- [ ] **Step 2: Run packaging-boundary/workbook identity tests** without installing or touching production data.
- [ ] **Step 3: Exercise the runner in a disposable temporary profile** with a fake live snapshot and verify backup, replacement, local-state reset, zero cloud writes, and restart persistence.
- [ ] **Step 4: Perform an installed-app UI check** only in a disposable/local test profile; do not invoke the reset on the user's Singapore profile.
- [ ] **Step 5: Have an independent reviewer inspect the exact diff for destructive-scope, rollback, and cloud-write regressions; fix and re-run affected tests.**

