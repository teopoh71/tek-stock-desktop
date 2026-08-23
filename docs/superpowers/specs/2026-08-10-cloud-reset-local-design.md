# `从云端重置本机` / `cloud-reset-local` Design

Status: approved design for review; implementation intentionally not included.

## Goal and scope

Add a one-way desktop recovery control that discards the current machine's local workbook state and rebuilds it from one verified live cloud snapshot. It is not a bidirectional merge tool and must not mutate cloud data or other devices.

The control is deliberately destructive to the local copy, so it must be explicit, backed up, atomic, and restart-safe. The installer continues to ship no inventory workbook; first-launch bootstrap remains cloud-based only when the private workbook is absent.

## Existing source patterns to reuse

- `workbook-location.cjs:createWorkbookLocation()` derives the persistent per-user `workbook-client.json` UUID and private path `%LOCALAPPDATA%\\TEK STOCK\\workbooks\\<clientId>\\TEK-STOCK-LIVE.xlsx`.
- `private-workbook-bootstrap.cjs:ensurePrivateWorkbook()` already requires a live (not cached) snapshot when creating a missing workbook and writes through a temporary file before claiming the final path.
- `main.cjs:readWorkbookFile()` reads `_TEK_META` and `_TEK_BASELINE`, validates revision/count, and computes the workbook fingerprint.
- `excel-live.cjs:replaceOpenWorkbookFile()` provides the guarded open-workbook replacement path: expected SHA-256 check, saved/read-only checks, close, atomic replacement with a backup, reopen, and recovery if reopen fails.
- `central-sync.cjs:createCentralSync()` owns `last-good-snapshot.json` and `outbox.json`; `snapshot(false)` is the no-cache live read, while `mutate()`/`syncWorkbook()` must not be called by this feature.
- Existing UI already has `Update`, `Excel`, identity-migration, and conflict dialogs in `inventory/index.html` and `inventory/app.js`; the new control must be separate from `Update` so users do not mistake it for merge or upload.

## User-facing control and confirmation

Add a desktop-only button labeled `从云端重置本机` with accessible name and tooltip `Discard this computer's local workbook and rebuild it from live cloud data`.

Clicking it opens a modal confirmation containing:

> This will replace this computer's local TEK-STOCK-LIVE.xlsx with the current live cloud inventory. Any unsynced local Excel/app changes on this computer—including pending and conflict state—will be discarded after a backup. Cloud data and other computers will not be changed. Continue only if you want this computer to match cloud.

The destructive action requires an explicit form value such as `CLOUD-RESET-LOCAL-CONFIRMED`; closing, canceling, or any other value is a no-op. The dialog must show the preflight cloud revision/count once fetched and state that the snapshot is live, not cached.

## Controlled operation

1. **Quiesce and preflight.** Disable the button, acquire the existing workbook writer/transaction lock, and require the canonical workbook to be saved and readable. If the workbook is open, use the existing Excel/WPS detection and save/close guard; do not silently discard unsaved changes. Read the current file SHA-256, metadata, item count, and pending outbox count for the confirmation receipt.
2. **Read cloud only.** Call `centralSyncService().snapshot(false)` and require `cloudState === "live"`, a valid authority identity, a safe revision, an array of items, and a deterministic item count. Never call `mutate`, `enqueue`, `syncWorkbook`, or any endpoint that writes data. Abort before touching local files on offline, authorization, timeout, malformed, or cached responses.
3. **Backup first.** Create a timestamped backup directory under the client workbook's existing `backups` directory, for example `cloud-reset-local-<runId>`. Copy the exact pre-reset workbook bytes plus a manifest containing source path, pre-reset SHA-256/mtime, client UUID, workbook metadata, cloud revision observed, and the local sync-state filenames selected for archival. Separately copy `central-sync/outbox.json` and `last-good-snapshot.json` into the same backup when present. Verify every backup hash before continuing.
4. **Build a replacement off to the side.** Use the existing `writeBootstrapWorkbook`/`buildWorkbook` path with the live snapshot. The replacement must contain the canonical cloud items, a new valid `_TEK_META` revision/count/workbook identity, and `_TEK_BASELINE` records exactly equal to those items. Write to a same-directory temporary filename, read it back with `readWorkbookFile()`, and require matching revision, item count, IDs, baseline completeness, and semantic fingerprint.
5. **Atomically replace the local workbook.** Require the original file SHA-256 to still equal the preflight value. If the workbook is open, use `replaceOpenWorkbookFile()` (or an equivalent guarded path) so a saved workbook is closed, the replacement is atomically installed, and it is reopened. A changed hash, unsaved workbook, read-only workbook, lock, or failed reopen aborts and leaves the original intact. Preserve the durable backup; do not delete it automatically.
6. **Reset only stale local sync state.** After the replacement is verified, archive the existing `outbox.json` and `last-good-snapshot.json` into the run backup, then initialize a fresh empty outbox and write the just-read live snapshot as the new local cache. Do not touch upload credentials, photo cache, workbook client UUID, cloud revision, or any other per-user data. The operation must never “ack” or replay discarded outbox mutations.
7. **Reload and verify.** Close/reload the renderer (or relaunch normally if required by the workbook binding), then perform a fresh live read. Show `Cloud v<revision> · <count> items`, workbook revision/count, and `Local reset complete`. Clear stale Excel-pending/conflict UI only after those values match; otherwise show a concrete failure and retain the backup for recovery.

## Failure and recovery rules

- **Offline, cached snapshot, authority mismatch, auth failure, or malformed download:** stop before backup/replacement; keep the current local workbook and state unchanged.
- **Backup failure or hash mismatch:** stop before replacement; report the backup path/error and leave local state untouched.
- **Temporary workbook validation failure:** delete only the temporary candidate; keep the original and archived state untouched.
- **Workbook changed/open-unsaved/read-only or atomic replacement failure:** abort with the existing `EXCEL_CONTENT_CHANGED`/open-workbook safety semantics; do not force-close or overwrite.
- **Sync-state initialization failure after workbook replacement:** restore the original workbook and archived sync files from the verified backup, then report rollback status. If rollback cannot be proven, keep the new workbook but mark the app not ready and point to the backup; never pretend the reset completed.
- **Renderer/relaunch failure:** leave the verified workbook and backup in place, show a recovery-required state, and do not retry cloud writes.

## Explicit non-goals

- No bidirectional merge, automatic conflict choice, cloud delete/upsert, or revision bump.
- No import from another workbook, no preservation of unsynced local edits in the active dataset, and no modification of another device.
- No installer-bundled inventory data and no change to the existing cloud authority/endpoints.

## Tests and visible acceptance

### Focused automated coverage

Add tests for the reset service/UI bridge using temporary directories and a fake cloud service:

1. Confirmation is mandatory; cancel and incorrect confirmation perform no filesystem or network mutation.
2. A cached/offline/invalid snapshot aborts before backup or replacement.
3. Backup is created and hash-verified before any replacement attempt.
4. A valid live snapshot produces a workbook whose metadata, baseline, IDs, count, revision, and semantic fingerprint match the snapshot.
5. A changed original SHA-256, unsaved/open workbook, or replacement failure leaves the original intact and reports rollback.
6. Existing outbox/cache are archived, replaced with fresh local state, and never replayed; credentials/photo cache/client UUID remain unchanged.
7. The fake service observes zero write requests and the result reports the exact live revision/count.

### Installed-app acceptance

On a disposable test profile with an intentionally divergent workbook:

- The button and warning are visible; no action occurs on cancel.
- After confirmation, a backup folder and manifest are visible.
- The app reports the live cloud revision/count, the workbook shows the same revision/count and no stale pending/conflict banner, and a fresh app restart preserves that state.
- API logs show only the read-only snapshot request; the cloud revision and item set are unchanged.
- A second device remains unchanged.
- Simulated offline, auth, backup, unsaved-workbook, and interrupted-replacement cases leave a recoverable original or a clearly reported rollback state.

## Self-review

- **Coverage:** button/copy, destructive confirmation, backup, live snapshot, atomic workbook/baseline rebuild, local-only state reset, reload, verification, failure/rollback, non-goals, tests, and visible acceptance are all specified.
- **Scope:** the design never calls a cloud mutation and does not alter installer-bundled data, endpoints, credentials, photos, or other devices.
- **Ambiguity removed:** “reset” means discard local unsynced changes after backup; “cloud” means a no-cache live snapshot with verified authority; “clear state” means archive then recreate only outbox/cache, not delete broadly.
- **Recovery consistency:** every destructive local step is preceded by a verified backup and guarded by an original-hash check; post-replacement failures have an explicit rollback or not-ready outcome.
