---
source: delegated Singapore Excel sync failure request and trace sync-20260811063906-9df748da
status: ready
slices:
  - id: P-001
    status: done
    depends: []
  - id: P-002
    status: done
    depends: [P-001]
  - id: P-003
    status: done
    depends: [P-002]
---

# Singapore Snapshot And IPC Sync Repair

## Goal And Boundaries

Make Excel cloud sync tolerate a schema-invalid response from one same-authority read endpoint by validating the complete snapshot before selecting that endpoint, then failing over to the next audited endpoint. Ensure the Electron IPC method always returns a cloneable structured failure if an error escapes the inner sync operation, so the UI never receives a raw remote-method rejection. Preserve all workbook merge, identity, deletion, cloud-write, and outbox safeguards. Production workbooks, outboxes, cloud records, credentials, and user configuration are read-only during investigation and acceptance. No commit or push.

## P-001 Reproduce Both Broken Boundaries

Add behavior tests in which a primary endpoint returns HTTP 200 JSON that violates the snapshot contract while the same-authority fallback returns a complete snapshot. Add an IPC-boundary test in which an error escapes outside the inner sync catch and must become a structured failure instead of a rejected invocation. The tests must fail on the current source for the intended missing behavior.

> writes: `test/api-failover.test.cjs`, `test/central-cloud-ipc.test.cjs`
> anchors: `schema-invalid full snapshot must fail over; tek-stock-cloud-sync-workbook must not reject raw Electron IPC errors`
> verify: `node --test test/api-failover.test.cjs test/central-cloud-ipc.test.cjs`
> review: `tests exercise runtime behavior and prove the old implementation fails for the intended reason`

## P-002 Implement Narrow Failover And IPC Normalization

Move full-snapshot contract validation into the per-endpoint read attempt without weakening authority, HTTP, timeout, write, or identity validation. Add one outer IPC normalization boundary with best-effort diagnostics. Existing structured sync results pass through unchanged; unsafe writes remain blocked.

> writes: `api-failover.cjs`, `central-sync.cjs`, `main.cjs`, `sync-trace.cjs`
> anchors: `same-authority validation-aware read failover; structured and cloneable IPC result; no new retry for writes`
> verify: `node --test test/api-failover.test.cjs test/central-cloud-ipc.test.cjs test/central-sync.test.cjs test/excel-update-flow.test.cjs`
> review: `failover never crosses authority and outer normalization cannot convert a failed sync into success`

## P-003 Package And Isolated Acceptance

Build a named NSIS x64 installer after source, identity, and photo gates pass. Install into isolated paths without touching the production workbook or user data, run packaged smoke plus an Electron IPC rejection scenario, and retain machine-readable evidence, screenshots, hashes, and the installer in the delegated output folder.

> writes: `dist/**`, `C:/Users/edwin/Documents/Codex/2026-08-11/tek-stock-delete-conflict-no-approval/outputs/**`
> anchors: `package path and SHA-256; isolated installed runtime proof; production boundary unchanged`
> verify: `npm test`, `npm run test:workbook-identity`, `npm run dist:update`, isolated installer and packaged smoke commands recorded in evidence
> review: `artifact contains the tested source and acceptance paths are isolated from production user data`

## Integration And Final Verification

- Run the complete test suite and distinguish the three pre-existing updater configuration assertion failures from new regressions.
- Re-sample both read endpoints without mutation and record only status, authority, schema keys, counts, timing, and response hash.
- Verify the final artifact hash, installed executable version, IPC behavior, workbook/outbox hashes or absence in the isolated profile, and no production mutation.

## Handoff And Residual Risks

- Blockers: none.
- Residual risks: the historical malformed response body was not retained, so its exact invalid top-level field cannot be reconstructed; new diagnostics must make a recurrence field-specific.
- Resume note: continue from P-001 RED tests; the current full-suite baseline is 394/397 with three pre-existing updater configuration assertion failures.
