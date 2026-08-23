!macro customInit
  ; Close the desktop app before uninstalling any previous package.
  ExecWait '"$SYSDIR\taskkill.exe" /F /T /IM "TEK STOCK.exe"' $0

  ; Repair mixed MSI installations left by v1.5.49-v1.6.6.  Every command
  ; is silent and best-effort so a missing/corrupt Windows Installer cache
  ; cannot block the fresh NSIS install.
  ExecWait '"$SYSDIR\msiexec.exe" /x {3A304031-9F89-44AA-B152-375A08CB9B51} /qn /norestart' $0
  ExecWait '"$SYSDIR\msiexec.exe" /x {4F7AE8D7-B021-4B8B-9222-CCACFC52C44C} /qn /norestart' $0
  ExecWait '"$SYSDIR\msiexec.exe" /x {08A9F778-1D5B-41BC-AFA3-B4C0D2719ACA} /qn /norestart' $0
  ExecWait '"$SYSDIR\msiexec.exe" /x {A0C1C94B-9A8C-40C3-A635-A6307811995C} /qn /norestart' $0
  ExecWait '"$SYSDIR\msiexec.exe" /x {A06205DA-8549-4915-A12A-181FD0B8282C} /qn /norestart' $0
  ExecWait '"$SYSDIR\msiexec.exe" /x {39B92FFE-0D84-4570-960A-6C9A095DDF7A} /qn /norestart' $0
  ExecWait '"$SYSDIR\msiexec.exe" /x {9DD6E437-7ECE-4693-A0FB-D80845BF1770} /qn /norestart' $0
  ExecWait '"$SYSDIR\msiexec.exe" /x {B9531E83-0B96-40C9-A759-65A1DE15DA00} /qn /norestart' $0
  ExecWait '"$SYSDIR\msiexec.exe" /x {EE1CEE15-88E4-4005-AC17-574809A339EE} /qn /norestart' $0
  ExecWait '"$SYSDIR\msiexec.exe" /x {420ECF89-6F61-4538-8677-C3194A3254EA} /qn /norestart' $0
  ExecWait '"$SYSDIR\msiexec.exe" /x {A4065439-2F6D-406D-9AE0-1A1CB6F0DC8C} /qn /norestart' $0
  ExecWait '"$SYSDIR\msiexec.exe" /x {CDA1D955-F8F6-4D02-9774-B3282E7DE1ED} /qn /norestart' $0

  ; Only old application binaries and shortcuts are removed. Inventory
  ; workbooks, credentials, cloud data, diagnostics, and photo caches live
  ; outside this directory and are deliberately preserved.
  RMDir /r "$PROGRAMFILES64\TEK STOCK"
  SetShellVarContext current
  Delete "$DESKTOP\TEK STOCK.lnk"
  SetShellVarContext all
  Delete "$DESKTOP\TEK STOCK.lnk"
!macroend
