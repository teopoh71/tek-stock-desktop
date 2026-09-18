# Recovery and maintenance (1.6.8)

The error panel offers a small set of actions for network, authorization, workbook conflicts, backup, busy, verification, and unknown failures. It is nonmodal, can be dismissed, and can be reopened from Help. A bounded wait returns control to the user without claiming the underlying operation was canceled. Existing inventory and pending operations are retained. Conflicts still require a person to choose.

## Deployment
Copy maintenance.defaults.example.json to maintenance.defaults.json before packaging. Configure the HTTPS diagnostics and manifest endpoints. The packaged defaults can be overridden in the application's userData/maintenance.json or by TEK_STOCK_DIAGNOSTICS_URL and TEK_STOCK_UPDATE_MANIFEST_URL. autoUpdate must be true for background updates.

Copy maintenance-worker/wrangler.example.jsonc to wrangler.jsonc, provision a D1 database, apply schema.sql, and set INGEST_TOKEN, SYNC_INGEST_TOKEN (optional existing sync token), and MONITOR_TOKEN using Wrangler secrets. Never commit token values or production workbook data. Configure RELEASE_MANIFEST and RELEASE_ASSET_URL as Worker variables only after verifying the released installer. The asset proxy accepts only this repository's GitHub release URLs. There is no silent fallback to the old update channel when a configured channel fails.

Diagnostic authorization prefers TEK_STOCK_DIAGNOSTICS_TOKEN, then the existing feedback token, then the stored upload token or upload environment token. A machine needs a matching token to submit reports. Missing authorization retains reports locally and reports that submission failed.

## Data and update safety
Only allowlisted error codes/stages, app version, timestamps, and random event IDs leave the desktop. Messages, paths, inventory, photos, usernames, and passwords are excluded. The local queue is atomic, bounded, deduplicated, and retried with backoff. Cloud retention is seven days.

An update must pass version, HTTPS, size, and SHA-256 checks. Installation also requires a fresh renderer state, no unsaved work, closed Excel, no pending/conflicting workbook changes, and no active cloud/workbook writes. Automatic installation requires two minutes of inactivity. A verified byte-for-byte workbook/state backup is made before launching the installer. Backup or busy failures leave the current version running. This does not constitute executable code signing.

## Monitoring
scripts/check-maintenance.ps1 reads the monitor token from Windows CurrentUser DPAPI storage under APPDATA/TEK-STOCK-maintenance. It outputs only grouped diagnostics and suppresses already seen version/stage/code combinations. The scheduled check requires this Windows computer and AgentDock to be online. It does not make inventory decisions or publish untested fixes.

## Verification
Run npm test, npm run dist:update, and node scripts/run-recovery-package-smoke.cjs. The package smoke uses isolated profiles and synthetic inventory against a local fake cloud service. It exercises the packaged renderer and workbook workflows; it does not exercise replacing an installed production version. The focused UI script requires Playwright and Chrome.

Existing 1.6.7 clients require one initial installation of 1.6.8 to receive the new maintenance channel. This release has a Windows 10+ x64 installer; no Windows 7 build was produced.
