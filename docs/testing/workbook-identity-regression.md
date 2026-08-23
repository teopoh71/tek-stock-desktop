# Workbook identity release gate

Every supported Windows package command runs this gate first:

```powershell
npm run test:workbook-identity
```

The gate covers:

- duplicate legacy rows fail closed instead of binding by model, row, or fuzzy content;
- duplicate models remain separate records with separate permanent IDs;
- missing IDs require an explicit, one-to-one migration manifest;
- stale workbook SHA or cloud revision stops migration before any write;
- migration verifies exact row-to-ID persistence by rereading the workbook;
- migration followed by repeated sync is idempotent;
- continuous repeated sync does not append duplicates, modify the wrong item, or remove a migrated ID;
- incomplete baselines cannot authorize new rows or deletions.

Packaging must use `npm run dist:msi`, `npm run dist:update`,
`npm run dist:remote`, or `npm run dist:win7`. Running `electron-builder`
directly is unsupported because it bypasses the identity gate.
