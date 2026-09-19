# Independent service verification — 2026-09-19

Status: version 1.6.9 installed and verified on the connected Windows computer. Independent Cloudflare inventory service deployed and the saved source data and photos migrated with equality/hash checks. Singapore workstation onboarding is still outstanding.

## Changes

- Preserve unchanged product card nodes and images during refresh; changed items, additions, deletions and ordering still update.
- Independent SQLite Durable Object inventory authority with authenticated reads and writes, revision conflicts, idempotency and transactional batches.
- Match the real desktop photo presign contract and validate stored bytes, including WebP RIFF byte offsets.
- Use the maintained update endpoint; fallback reads its release metadata through a Cloudflare service binding, without forwarding client credentials.
- Package physical dependencies and explicitly audit detect-libc, correcting a missing transitive dependency found by standalone application testing.

## Verification

- Worker and actual createCentralSync integration suites: 13 passed, zero failed, covering authorization, retry retention, conflicts, atomicity, photos and second-client add/delete recognition.
- Actual local workerd and SQLite runtime checks passed, including multi-chunk photo round trips and change feeds.
- Existing business fields were compared before and after import; every migrated unique image was downloaded and SHA-256 verified. Private receipts remain outside the repository.
- A temporary product was created, recognized by a second real sync client and deleted on the deployed service. Original records matched afterward and both client queues were empty.
- Actual standalone packaged two-profile Excel workflow passed, including add/edit/delete, photos, workbook fingerprints and pending-workbook guards.
- Updater, release-package and update-config suites: 23 passed, zero failed.
- Final NSIS installer exited successfully and installed 1.6.9.0. Original workbook bytes were unchanged through installer replacement. Previous program, full profile and workbook were backed up first.
- The installed executable was then opened with the existing profile: new service live, workbook synchronized, no pending writes, and Update returned Already up to date for 1.6.9.
- After initial photo cache loading settled, 35 seconds of actual installed UI observation found zero grid mutations, zero image reload events and zero visible broken photos.

- Both deployed manifest endpoints returned HTTP 200 after correcting an unsupported Worker redirect mode. No global manifest promotion was performed.

## Artifact

- Version: 1.6.9 (Windows x64).
- Size: 101720102 bytes.
- SHA-256: fa0d1c813101e37c205bfe543f1bec51883064ada043a846d0ce6150f253072a.
- Installer contains no real inventory, photos or credentials. Existing data is kept; credentials are configured separately and encrypted in the local Windows profile.

## Remaining scope

- This is a manual migration release. Do not promote it to the fleet update manifest until other workstations have the new authority credentials and have been verified.
- Singapore physical-device/network verification and credential provisioning have not been performed.
- The fallback shares the maintenance service; it is not an independent outage-resilient release store.
- Idle observation is bounded and is not a guarantee against every possible flicker or future failure.
- Old service and rollback backups remain available; no automatic choice was made for conflicting business records.
