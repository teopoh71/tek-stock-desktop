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
  - id: P-003
    status: done
    depends: [P-002]
---

# Safe JSON Failover For Excel Cloud Snapshots

## Goal And Boundaries

Prevent the Singapore Excel synchronization path from turning an intermittently truncated or non-JSON successful HTTP snapshot response into `CLOUD_SNAPSHOT_INVALID`. The request layer must treat a response-body JSON parse failure as a concrete endpoint failure, preserve the existing same-authority failover rules, and allow a trusted fallback endpoint to supply the valid snapshot. Authority checks, write/idempotency boundaries, cloud snapshot validation, revision checks, and workbook identity protections remain unchanged.

The investigation and tests must not modify the production workbook, production outbox, credentials, or cloud data. Production endpoints may be read only. Packaging and runtime acceptance must use isolated temporary profiles and local loopback fixtures. No commit or push is authorized; stop only if a real production write becomes necessary.

## P-001 Prove The Request-Parsing Root Cause

Add one focused requester regression that models the observed boundary: a trusted primary returns HTTP 200 with truncated JSON for `/v1/snapshot`, while a same-authority trusted fallback returns a valid snapshot. Before implementation, the test must fail because only the primary is called and its parse failure is silently converted into an empty object. The working authority-mismatch failover test remains the comparison pattern.

> writes: `test/api-failover.test.cjs`
> anchors: locate the exact `safeSnapshot` field failure and compare successful refresh with failed Excel sync; no production data writes; test must demonstrate the current failure before repair
> verify: `node --test test/api-failover.test.cjs` must show the new test fail for the expected missing fallback behavior
> review: verify the fixture uses HTTP 200, the correct authority header, malformed JSON only on the primary, and a valid fallback body

## P-002 Fail Over On Invalid JSON Without Weakening Validation

Make the smallest requester change so a response JSON parse exception becomes a concrete error handled by the existing endpoint loop. Do not replace it with `{}`, do not accept malformed data, do not retry client errors across authorities, and do not change any write/idempotency behavior. The fallback response must still pass the existing authority proof before it can become preferred.

> writes: `api-failover.cjs`
> anchors: malformed successful response is an endpoint failure; same-authority fallback only; `safeSnapshot`, cloud identity, revision, and mutation gates remain fail-closed
> verify: `node --test test/api-failover.test.cjs test/central-sync.test.cjs` passes, including the witnessed RED regression
> review: main-agent exact diff review must confirm no production write path, timeout policy, authority rule, or HTTP status behavior changed

## P-003 Package And Isolate The Delivered Application

Run syntax checks, the workbook identity release gate, and the full suite while reporting the known unrelated updater baseline failures separately. Build the Windows update package, verify that the packaged requester and central sync files match source, and run the packaged Electron smoke with temporary profiles and local loopback network fixtures. The UI and structured smoke evidence must show a settled 1.5.72 application with no sync error, while production workbook and outbox hashes/timestamps remain unchanged from the read-only pre-run evidence.

> writes: `dist-update/**`, task-local verification evidence, `docs/loopx/plans/2026-08-11-snapshot-json-failover-fix.md`, non-sensitive Obsidian daily review entry
> anchors: package and isolated acceptance required; do not contact or mutate production cloud during smoke; no production workbook/outbox writes; no commit or push
> verify: syntax checks, `npm run test:workbook-identity`, `npm test`, `npm run dist:update`, packaged/source hash comparison, isolated packaged smoke exit 0, visible UI screenshots, and production boundary re-hash
> review: distinguish isolated packaged execution from a system-wide install and report any Office/WPS automation limitation precisely

## Integration And Final Verification

- Re-run the focused requester and central sync tests after the implementation, then the full release identity gate.
- Preserve the baseline full-suite result of 393/396 unless this change causes a new failure; the three current failures are stale updater filename/host/source expectations and are outside this task.
- Compare final modified files against the pre-edit SHA-256 evidence because this source directory is not a Git repository.
- Confirm the production workbook and outbox were not intentionally modified and that no production write request was issued.

Completed evidence on 2026-08-11:

- The malformed-primary regression was witnessed RED as `{}` instead of revision 248, then passed after the one-file requester fix.
- Focused requester/central sync tests passed 53/53; the workbook identity gate passed 155/155.
- The full suite passed 394/397, with only the same three unrelated pre-existing updater expectation failures.
- `npm run dist:update` exited 0; after-pack verification passed and packaged/source hashes matched for `api-failover.cjs`, `central-sync.cjs`, and `main.cjs`.
- The packaged requester itself failed over from malformed primary JSON to the same-authority Singapore fallback and returned revision 248.
- Isolated packaged Electron smoke exited 0; two temporary profiles completed all four phases, converged to one fingerprint, displayed App v1.5.72 / Cloud v4 with no sync error, and invoked neither Update nor Reinstall.
- The production workbook size and timestamp and the production outbox size, timestamp, and SHA-256 matched task-start evidence. No cloud write was issued.

## Handoff And Residual Risks

- Blockers: none.
- Residual risks: the historical malformed raw response body was not retained by diagnostics because the requester replaced parse failures with `{}`; the code-level path and exact resulting error were reproduced read only.
- Isolated Office residual: WPS remained open, so a dedicated real COM instance was not claimed; the production Excel-live lock/CAS harness covered the newer-save race.
- Resume note: root cause, TDD repair, release gates, packaging, and isolated acceptance are complete. No commit or push was performed.
