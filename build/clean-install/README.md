# Private clean installation bundle

This wrapper is for an explicitly authorized reset of Singapore test data.
Routine updates must continue to use the normal preserving installer.

The private builder reads the current user's selected workbook and confirmed
snapshot, refuses pending edits or outbox operations, checks matching item IDs
and revision, and packages only verified cached photos and the pinned app
installer. Payloads, workbook data, images and build receipts stay outside Git.
Never attach this inventory-bearing EXE to a public release.

The wrapper verifies every embedded payload file before changing data. It
requires Excel and TEK STOCK to be closed, archives only the current user's
known TEK STOCK data directories alongside their originals, uninstalls exact
recognized TEK packages, installs the pinned app, and imports a fresh private
workbook plus offline snapshot/photo cache. It generates a new workbook client
ID and does not reuse pending operations. Only the same Windows user's existing
encrypted sync credential may be retained locally; no source credential is
included in the payload. Other Windows users and the maintenance profile are
outside the reset scope.

The program runs as the current user. Installer children use normal Windows
elevation. Source data is never cleared by the builder or tests. The wrapper
does not resolve stock conflicts or migrate legacy record IDs automatically.
A new machine still needs its normal connection authorization.

## Validation

Compile CleanCore.cs, Program.cs and CleanTests.cs with the .NET Framework C#
compiler, UTF-8 codepage, x64, main TekClean.CleanTests, and references to
System.IO.Compression, System.IO.Compression.FileSystem, System.Web.Extensions,
System.Windows.Forms and System.Drawing.

- CleanTests.exe: isolated synthetic backup, import, rollback and integrity checks.
- CleanTests.exe --plan: read-only validation of local uninstall commands.
- CleanTests.exe --bundle <private EXE>: verify the final embedded payload and
  import it into an isolated temporary profile; output its profile/workbook paths.
- node build/clean-install/verify_seed.cjs <test-profile> <test-workbook>:
  read with the native workbook parser and validate all photos without network.

The tests do not uninstall production applications. A first installation on the
destination computer remains necessary to validate its Windows installer/UAC
environment. A timeout leaves backups and installer resources available; retry
is blocked while the child installer remains active. Backup directories remain
recoverable after successful installation.
