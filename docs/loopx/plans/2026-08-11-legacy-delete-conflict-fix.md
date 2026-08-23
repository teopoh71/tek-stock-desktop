---
source: Codex delegation 019fe99b-40d0-78f0-b569-0e6c140c2bd3
status: done
slices:
  - id: P-001
    status: done
    depends: []
  - id: P-002
    status: done
    depends: [P-001]
---

# Safe Legacy Workbook Deletion Conflict Fix

## Goal And Boundaries

Make a normal deletion of an already-synchronized legacy-ID workbook row converge through the existing central batch API when, and only when, a complete acknowledged baseline plus the latest live cloud snapshot prove that the deleted cloud record is unchanged. The cloud remains the sole authority and the normal revision/idempotency/outbox path remains mandatory.

Do not permit legacy updates, unknown or duplicate identities, deletion of a remotely changed record, direct cloud edits, workbook replacement, lock removal, or local data deletion. Do not modify production workbook/cloud state, and do not commit or push.

## P-001 Pin and implement the narrowly authorized deletion

Add a focused end-to-end regression that reproduces the verified rev245/rev246 shape without using production data: a complete baseline contains a legacy row, the workbook removes exactly that row, and live cloud adds one unrelated permanent-ID row while leaving the deletion target unchanged. The test must fail with the current `WORKBOOK_ID_CONFLICT`, then pass by allowing only the legacy delete IDs returned by the successful three-way merge. Existing legacy updates and unsafe delete-versus-live-change cases remain closed.

> writes: `main.cjs`, `inventory/excel-delta-core.js`, `central-sync.cjs`, `test/excel-delta-core.test.cjs`, `test/central-sync.test.cjs`
> anchors: normal synchronized deletion is safe; cloud remains authoritative; no direct workbook/cloud/lock mutation; true identity and merge conflicts remain fail closed
> verify: `node --test test/excel-delta-core.test.cjs test/central-sync.test.cjs` with a witnessed red failure before implementation and all focused tests passing afterward
> review: canceled by the user's latest instruction; main-agent focused tests cover exact delete capability, arbitrary legacy deletion, legacy update, duplicate IDs, and live revision rebase

## P-002 Verify, package, and inspect the delivered application

Run syntax checks, the workbook identity release gate, the full test suite while preserving any unrelated pre-existing updater failures, and the Windows update package build. Run the packaged isolated smoke path so no production state can be reached. If installation is safe and authorized by the delivery request, install the new package without opening or synchronizing production data, then visibly verify the installed TEK STOCK version and settled UI state without pressing Update, Excel, reset, conflict resolution, or delete controls.

> writes: `dist-update/**`, task output evidence, non-sensitive Obsidian daily review entry
> anchors: provide tests, installer path, and explicit real-UI acceptance status; preserve production workbook/cloud/local data; no commit or push
> verify: fresh focused/full test output, `npm run test:workbook-identity`, `npm run dist:update`, packaged isolated smoke output, installer hash, installed file/version inspection, and visible UI evidence
> review: verify package contents include the changed runtime files and that all acceptance actions are read-only with respect to production inventory state

## Integration And Final Verification

- Re-run the focused tests after independent review fixes, then run syntax checks and the full suite.
- Compare final source changes against pre-edit copies because this source directory has no Git repository.
- Report unrelated baseline failures separately; do not hide or repair them outside this task.
- Confirm no production workbook, cloud snapshot, lock, outbox, or local inventory data was intentionally mutated.

Completed evidence on 2026-08-11:

- Focused deletion/sync tests: 58 passed, 0 failed; workbook identity gate: 155 passed, 0 failed.
- Full suite: 396 tests, 393 passed, with the same three unrelated pre-existing updater expectation failures.
- `npm run dist:update` exited 0; after-pack validation passed, and packaged/source hashes matched for `main.cjs`, `central-sync.cjs`, and `inventory/excel-delta-core.js`.
- Final isolated packaged-app smoke exited 0. Two temporary profiles converged to Cloud v4 with an identical fingerprint, update/reinstall invocation counts of 0, and visible App v1.5.72 screenshots.
- Production live workbook and outbox size, timestamp, and SHA-256 matched the read-only pre-run evidence exactly. Production cloud was not contacted.

## Handoff And Residual Risks

- Blockers: none.
- Residual risks: the two historical `WORKBOOK_MERGE_CONFLICT` details were not persisted; only the subsequent stable `WORKBOOK_ID_CONFLICT` root cause is reproducible from retained state.
- Isolated Office residual: WPS was already running, so a dedicated isolated real COM instance was not claimed; the production Excel-live lock/CAS race harness verified that a newer save remains preserved.
- Resume note: implementation, packaging, and isolated acceptance are complete; no commit or push was performed.
