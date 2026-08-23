# TEK STOCK Concurrent Local Excel Design

## Goal

Allow the China and Singapore desktop installations to open and edit Excel at the same time without file-lock prompts, silent overwrites, duplicated identities, or divergent inventory. Alibaba Cloud remains the authoritative data source. Mobile remains read-only.

## Root Cause

The two computers currently open the same physical `TEK-STOCK-LIVE.xlsx` through a shared or cloud-synchronized path. Excel and WPS place an exclusive editing lock on that file, so the second computer can only open it read-only. No application-level retry or sync key can remove this file-system limitation safely.

## Chosen Architecture

Each desktop installation owns a private workbook stored outside OneDrive, WPS Cloud, network shares, and shared Documents folders:

`%LOCALAPPDATA%\TEK STOCK\workbooks\<desktop-client-id>\TEK-STOCK-LIVE.xlsx`

The existing Excel button always opens this private workbook. The path is derived from the installation's persistent sync client ID, so two computers never resolve to the same file. Alibaba Cloud is the only shared state.

The old shared workbook is preserved as a read-only backup during migration. It is not deleted, moved, or automatically uploaded.

## Identity and Ordering

- Every product has a permanent UUID stored in hidden Excel column B.
- Row numbers are presentation order only and never identify products.
- A genuinely new row receives a new UUID before upload.
- Two computers adding products in the same visible row produce two distinct products.
- Two computers adding the same model also produce two distinct products unless a user explicitly merges them later.
- Normal synchronization never matches products by model, category, specification, or row number.

## Synchronization Flow

1. The app reads a stable local workbook snapshot and its SHA-256 hash.
2. It compares editable inventory fields and image hashes with the hidden local baseline.
3. If there is no semantic change, it does not set `Excel pending` or upload anything.
4. It fetches the latest Alibaba Cloud snapshot and revision.
5. It performs a three-way merge using baseline, local Excel, and live cloud data.
6. A conflict-free workbook change is submitted as one atomic batch with the expected cloud revision and an idempotency key.
7. On HTTP 409, the app fetches the new snapshot and rebases instead of replaying a stale patch blindly.
8. After a successful commit, the app fetches the authoritative snapshot and updates the local workbook and hidden baseline together.
9. The local workbook is replaced only if its hash still matches the snapshot that was merged. If the user saved again meanwhile, the generated replacement is discarded and synchronization restarts from the newer local file.
10. Background polling pulls remote changes so both workbooks converge without requiring app reinstall.

## Merge and Conflict Rules

- Different products changed simultaneously: merge automatically.
- Different fields of the same product changed simultaneously: merge automatically.
- The same field changed to the same value: treat as already merged.
- The same field changed to different values: do not overwrite. Preserve the local workbook and show the product, field, local value, and cloud value for a user choice.
- Delete versus unchanged cloud product: delete.
- Delete versus a product changed remotely after the baseline: conflict; do not delete automatically.
- Simultaneous delete on both computers: treat as already complete.
- New rows are appended in deterministic order using source order and permanent-ID tie-breaking.

## Photos

- Photo objects are stored in Alibaba OSS under the permanent product ID.
- The workbook and sync baseline track the image SHA-256 hash.
- Desktop and mobile keep local photo caches for speed.
- Photo replacement uses the same three-way conflict rule as other fields.
- Data commits do not wait for unrelated cached-photo downloads.

## Offline and Restart Behavior

- Local saves are recorded in a durable outbox with operator, time, client ID, baseline, before/after values, and request identity.
- A failed upload remains pending and retries after connectivity returns.
- Restart never converts an unresolved conflict into a write.
- Mobile reads the latest reachable snapshot and may display its last verified cache while offline; it never uploads inventory edits.

## Migration

1. Release the change through the normal Update mechanism.
2. On first launch, create the private workbook directory and client-specific workbook.
3. Bootstrap that workbook from the authoritative Alibaba Cloud snapshot.
4. Keep any old shared workbook unchanged as a dated backup.
5. Open only the private workbook from the Excel button.
6. Do not import old shared workbook changes automatically. Any intentional recovery from an old workbook must use an explicit reviewed migration.

## Update and Reinstall

The Update button updates application and synchronization logic while preserving the private workbook, credentials, outbox, photo cache, and client ID. Reinstall remains a separate recovery action and is not required for ordinary data synchronization.

## Error Handling

- A lock on another computer's workbook is impossible because workbook paths are private.
- A lock on the same computer reports which local workbook is open and asks the user to save or close it.
- Authentication errors ask for the sync key without altering inventory.
- Conflicts are explicit and durable.
- Diagnostics record only concise non-sensitive status and error codes; credentials are never logged.

## Verification

Automated tests use two isolated desktop storage directories, two independent workbook files, one read-only mobile client, and an isolated API fixture. They cover:

- simultaneous creation in the same logical row;
- simultaneous creation of the same model;
- different-field edits and convergence;
- same-field conflict without overwrite;
- stock change;
- photo replacement and cache refresh;
- delete, delete-versus-edit, and simultaneous delete;
- HTTP 409 rebase;
- dropped responses and idempotent retry;
- offline save and restart recovery;
- workbook hash changes during cloud acknowledgement;
- final equality of cloud data, both desktop workbooks, and mobile data after restart.

No test may use the production workbook or mutate real inventory.

## Acceptance Criteria

- China and Singapore can keep Excel open and edit simultaneously.
- Neither computer sees the other computer's file-lock/read-only dialog.
- Both workbooks converge to the same cloud revision and inventory after synchronization.
- No concurrent edit is silently lost.
- The mobile view matches the authoritative cloud data.
- Ordinary fixes are delivered through Update, not repeated reinstall.
