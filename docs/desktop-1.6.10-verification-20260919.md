# Desktop 1.6.10 verification — 2026-09-19

The Excel button could incorrectly report success after a COM probe activated a hidden workbook. WPS sometimes showed its home screen, and repeating the button could create a second workbook window. The product view also always started with the chair category selected.

## Changes

- Default a new application session to all categories; category selection during that session continues to work.
- Keep the already-open probe from creating a workbook. Require an actual workbook window and lock before reporting WPS open success.
- Focus an existing WPS workbook without requiring COM registration. Cache window identity with process ID and start time so it can be validated after an application restart.

## Verification

- Targeted Excel and filtering tests: 21 passed, zero failed. Updater/version/config checks also passed during the preceding combined run.
- Final installer build and packaging gates passed. Installed version and source content were verified.
- Actual installed application started with all categories selected.
- Actual Excel button opened one real stock workbook window; the second click reused that window. It remained open after a 35-second observation.
- A separate fresh Node process using byte-identical installed source recognized the same workbook without relying on in-memory window state.
- Current inventory records matched the fresh pre-update snapshot. Workbook bytes were unchanged through installation and GUI opening. Cloud status was live with no pending writes.
- Fresh program, profile and workbook backups were taken before replacement. No test products were inserted during this GUI-only fix.

## Artifact

- Windows x64, version 1.6.10.
- Size: 101721214 bytes.
- SHA-256: a4dcc92c8625d62dc29adf35ccce0cfecd9fd89e7c43a05d9787b1d2c7801925.
- No real inventory, photographs or credentials are included in the installer.

## Scope

- Manual prerelease; fleet update manifests are unchanged.
- Singapore first-time connection setup and testing on its physical workstation remain outstanding.
- GUI acceptance was performed with the installed WPS version on the connected Windows computer. This is not a guarantee for every Office version or future failure.
