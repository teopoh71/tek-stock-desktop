# Reviewed Legacy Reconciliation Implementation Plan

1. Add failing pure tests in `test/workbook-identity-migration.test.cjs` for the exact 320/322/321 reviewed state and fail-closed variants.
2. Add failing normal-sync integration tests in `test/workbook-identity-regression.test.cjs` proving replacement-only recovery and zero cloud writes.
3. Add a pure reviewed-legacy classifier to `workbook-identity-migration.cjs` and call it in `central-sync.cjs` before generic identity planning.
4. Route only an exact match through the existing SHA-guarded `replaceWorkbook` callback and return zero operations, photos, and assignments.
5. Run targeted tests, the workbook identity gate, and the full test suite; obtain an independent read-only review of the exact diff.
6. Bump the desktop version to 1.5.72, run the MSI build gate, verify the packaged runtime and MSI hash, then install and run isolated smoke verification.
7. Re-verify the existing pre-sync backup, invoke the normal application sync, and confirm workbook/cloud count and identity postconditions plus a fresh backup.
8. Only if local acceptance passes, upload the versioned 1.5.72 MSI, read it back and verify it, then update `releases/latest.json` last while preserving other channels and old objects.
