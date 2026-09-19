# Independent service verification — 2026-09-19

Status: tested candidate, not released. Production endpoints, installed app, and real inventory were not changed by these tests.

## Fixes

- Preserve unchanged product card DOM nodes and images during renderer refresh. Update only changed cards; retain working add/delete/reorder behavior.
- Accept the existing desktop client's photo presign fields (`mimeType`, `bytes`). Validate committed photo metadata against stored bytes.
- Return the final change sequence for a full snapshot, preventing replay of already included events.
- Reject malformed bodies and operations before committing partial writes.

## Verified

- `node --test independent-worker/worker.test.mjs independent-worker/client-integration.test.mjs`: 11 passed, 0 failed on the connected Windows machine.
- Real desktop `createCentralSync` code against isolated service storage: create, second-client recognition, photo upload/download and delete passed.
- Unauthorized writes retain retryable client work; corrected test credentials permit retry. Concurrent stock edits remain conflicts rather than overwriting another client's changes.
- `node scripts/test-grid-stability.cjs`: unchanged cards/images survive 20 render calls; changed stock, add, delete and reorder all passed in headless Chrome.
- `node scripts/test-worker-runtime.cjs`: actual local workerd + Durable Object SQLite engine passed authentication, CRUD, idempotency, revision conflicts, atomic rollback, multi-chunk binary photo round-trip and change-feed checks.

## Release gates still outstanding

- Complete and verify photo migration coverage against the saved source snapshot.
- Configure and deploy an isolated new service, verify authentication and network access from both locations.
- Cut over a canary desktop with rollback preserved; verify full Excel-to-app-to-second-device workflows.
- Build and verify a new installer and safe update path, then deliver it. No new installer is claimed ready by this report.
- Repeat the idle UI observation on the installed candidate; the renderer regression test is not a complete end-user session test.

All test inventory and credentials were synthetic. Temporary test stores were disposed after execution. No stock records, photos, identities or real credentials are included here.
