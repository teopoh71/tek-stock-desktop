# Conflict Resolution Outbox Starvation Fix

**Goal:** Make an explicit conflict choice complete even when older workbook uploads are stuck, while preserving audit history and preventing an older workbook snapshot from replaying after the chosen final state.

## Root cause to verify

- Normal flush processes workbook transactions by oldest `clientSeq` and aborts on the first error.
- Conflict resolution appends a newer rebased transaction, then calls the normal flush.
- An older failed transaction therefore prevents the selected resolution from reaching the API.
- If the resolution were sent out of order without cleanup, an older workbook transaction could later replay and restore stale data.

## Implementation

1. Add an isolated regression test with an older queued workbook transaction and a newer explicit resolution transaction.
2. Add a targeted `flushOperation(opId)` path that uses the same revision-rebase and idempotency logic but sends only the selected transaction.
3. After the selected transaction is acknowledged, durably mark earlier workbook snapshots as superseded and remove them from the retry queue. Keep their full mutation data in history.
4. Make conflict resolution use the targeted path; keep the current generic flush as a compatibility fallback for test doubles and older service implementations.
5. Verify both delete-conflict choices:
   - Keep Excel: one delete reaches the API, cloud no longer has the item, Excel replacement omits it, restart stays deleted.
   - Keep Cloud: no delete reaches the API, Excel replacement restores the cloud item, restart stays restored.
6. Run the full suite, build a versioned NSIS update, run packaged isolated-profile smoke tests, then install and launch it on this computer without changing real inventory data.

## Safety invariants

- Never discard non-workbook mutations such as photo operations.
- Never supersede earlier workbook transactions until the selected resolution is acknowledged by the API.
- Never change the real workbook or cloud inventory during automated tests.
- Preserve operator, time, operation body, and supersession reason in outbox history.
