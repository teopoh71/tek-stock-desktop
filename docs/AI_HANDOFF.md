# External AI handoff

## Scope

This is an Electron / Node.js desktop inventory application. The repository is deliberately free of production inventory and runtime secrets. Use `inventory/alibaba-cloud.example.json` as a configuration shape only; never add a real Cloudflare token, endpoint credential, workbook, or customer data to the repository.

## Current defects

1. Deleting a whole Excel model row and then creating one or two new models in the same row position can trigger a workbook identity migration/sync failure. A new model must receive a new item identity and must never inherit a deleted row's cloud identity because it occupies the same Excel row.
2. The Excel action can report success when WPS only opens its home screen. Success must mean the requested workbook is actually open.
3. The update screen can report an older available version than the installed application. Version/manifest handling needs a safe, testable fix.

## Primary files

- `main.cjs`
- `excel-live.cjs`
- `central-sync.cjs`
- `workbook-identity-migration.cjs`
- `workbook-migration-transaction.cjs`
- `inventory/excel-delta-core.js`
- `inventory/excel-sync-core.js`
- `inventory/excel-open-core.js`
- `updater-core.cjs`

## Required regression coverage

- Delete an entire model row, add one new model in the same visual row, then sync.
- Delete an entire model row, add two new models in the same visual row region, then sync.
- Confirm deleted identities are not reused and production data is never silently deleted or migrated.
- Confirm WPS home screen is not treated as the workbook being open.
- Confirm the updater cannot recommend a lower/stale version as an update.

The synthetic fixture under `test/fixtures` is for local testing only and is not production data.
