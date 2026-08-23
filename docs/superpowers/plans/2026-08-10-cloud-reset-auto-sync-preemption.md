# Cloud Reset Automatic-Sync Preemption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an explicitly confirmed local cloud reset cancel only a waiting automatic workbook sync, release its local migration lock, and continue with the existing backup/rollback reset transaction without any cloud write.

**Architecture:** Extend the existing workbook operation gate with a cancellable automatic-sync owner. The reset requests cancellation, waits for the automatic operation to settle and its lock-release callback to run, then acquires the reset lock exclusively. Manual/confirmed writes remain non-cancellable. Thread an abort signal through automatic sync checkpoints so cancellation cannot reach enqueue/flush/photo/write stages.

**Tech Stack:** Node.js CommonJS, Electron main process, `node:test`, existing `workbook-operation-gate.cjs`, `central-sync.cjs`, `main.cjs`, and `cloud-reset-local.cjs`.

## Global Constraints

- Reset is user-confirmed and local-only; it must issue zero cloud writes and never alter another device.
- Only automatic local workbook sync may be preempted; manual or confirmed cloud writes must be allowed to finish.
- Active-owner locks and transaction evidence remain fail-closed; no external lock deletion.
- Existing backup, replacement validation, rollback, outbox/cache preservation, and reload behavior remain unchanged.
- Do not run reset against production data during development; package and test in isolation.

### Task 1: Reproduce the waiting automatic-sync collision

**Files:**
- Modify: `test/workbook-operation-gate.test.cjs`

- [ ] Add a test where an automatic sync exposes a cancellation callback, waits indefinitely, and a confirmed reset requests cancellation; assert the callback runs, the sync settles with `CLOUD_RESET_SYNC_CANCELLED`, the reset operation runs, and a manual write is never cancelled.
- [ ] Run `node --test test/workbook-operation-gate.test.cjs`; confirm the new test fails because the gate has no cancellation path.

### Task 2: Add the cancellable automatic-sync gate path

**Files:**
- Modify: `workbook-operation-gate.cjs`
- Test: `test/workbook-operation-gate.test.cjs`

- [ ] Add `scheduleAutomaticSync(operation, { onCancel })` (or equivalent explicit API) that records one active automatic owner and rejects queued post-reset work.
- [ ] Add `runReset(operation, { cancelAutomaticSync: true })` behavior that requests cancellation, waits for the owner chain and lock-release callback, then runs reset; retain timeout/fail-closed behavior if cancellation cannot settle.
- [ ] Keep `scheduleWrite` and normal `scheduleSync` non-cancellable.
- [ ] Run the gate tests and verify cancellation, lock-release ordering, timeout safety, and manual-write preservation.

### Task 3: Thread cancellation through automatic workbook sync

**Files:**
- Modify: `main.cjs`
- Modify: `central-sync.cjs`
- Test: `test/central-sync.test.cjs` or focused gate integration test

- [ ] Create an `AbortController` for automatic sync, register an abort handler that releases only the automatic sync's local writer lock, and pass its signal into `centralSyncService().syncWorkbook` callbacks.
- [ ] Add cancellation checkpoints before identity assignment, outbox enqueue/flush, photo replacement, acknowledgement, and workbook replacement; cancellation must fail before any cloud write or manual commit.
- [ ] Route automatic sync through the new cancellable gate API; call reset with cancellation enabled only after explicit confirmation.
- [ ] Add a regression proving a waiting WPS/read stage is cancelled, the lock is released before reset backup/replacement, and reset rollback still restores the original state on failure.
- [ ] Run focused sync/reset/gate tests.

### Task 4: Package and isolated verification

**Files:**
- Modify: none unless package allowlist requires the already-packaged runtime module

- [ ] Run the full focused suite and `npm run dist:update`.
- [ ] Verify the packaged archive contains the changed runtime modules and no production workbook/cloud state.
- [ ] Validate the isolated package's gate collision path without clicking reset in the production profile.
- [ ] Record any unrelated baseline test failure separately; do not change unrelated branding assertions.

## Self-review

- The plan covers cancellation, lock release ordering, zero-cloud-write checkpoints, manual-write protection, rollback, tests, and packaging.
- No task deletes locks directly or changes endpoints/data.
- The only new public behavior is an explicit reset-triggered cancellation request for automatic sync.
