[CmdletBinding()]
param(
  [switch]$RunProduction
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-TekStockBaseRoots {
  return @{
    RoamingBase = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
    LocalBase = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    DocumentsBase = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
  }
}

function Get-TekStockProductionRoots {
  $baseRoots = Get-TekStockBaseRoots
  return @{
    Roaming = Join-Path $baseRoots.RoamingBase "samlee-inventory-desktop"
    Local = Join-Path $baseRoots.LocalBase "TEK STOCK"
    LegacyWorkbook = Join-Path $baseRoots.DocumentsBase "TEK STOCK\TEK-STOCK-LIVE.xlsx"
  }
}

function Assert-NoReparsePath {
  param([Parameter(Mandatory)][string]$Path)
  $current = [IO.Path]::GetFullPath($Path)
  while ($true) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Unsafe reparse point in TEK STOCK cleanup target."
      }
    }
    $parent = [IO.Directory]::GetParent($current)
    if ($null -eq $parent -or $parent.FullName -eq $current) { break }
    $current = $parent.FullName
  }
}

function Assert-NoReparseChildren {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $pending = [System.Collections.Generic.Stack[string]]::new()
  $pending.Push($Path)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
      if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Unsafe reparse point in TEK STOCK cleanup target."
      }
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
    }
  }
}

function Assert-ExactCleanPath {
  param([Parameter(Mandatory)][string]$Actual, [Parameter(Mandatory)][string]$Expected)
  $actualFull = [IO.Path]::GetFullPath($Actual).TrimEnd([char[]]"\\/")
  $expectedFull = [IO.Path]::GetFullPath($Expected).TrimEnd([char[]]"\\/")
  if (-not [string]::Equals($actualFull, $expectedFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe TEK STOCK cleanup target."
  }
}

function Assert-CleanRoots {
  param([Parameter(Mandatory)][hashtable]$Roots, [Parameter(Mandatory)][hashtable]$BaseRoots)
  foreach ($key in "RoamingBase", "LocalBase", "DocumentsBase") {
    if (-not $BaseRoots.ContainsKey($key) -or [string]::IsNullOrWhiteSpace([string]$BaseRoots[$key])) {
      throw "Unsafe TEK STOCK cleanup target."
    }
  }
  foreach ($key in "Roaming", "Local", "LegacyWorkbook") {
    if (-not $Roots.ContainsKey($key) -or [string]::IsNullOrWhiteSpace([string]$Roots[$key])) {
      throw "Unsafe TEK STOCK cleanup target."
    }
    Assert-NoReparsePath -Path $Roots[$key]
    Assert-NoReparseChildren -Path $Roots[$key]
  }
  Assert-ExactCleanPath -Actual $Roots.Roaming -Expected (Join-Path $BaseRoots.RoamingBase "samlee-inventory-desktop")
  Assert-ExactCleanPath -Actual $Roots.Local -Expected (Join-Path $BaseRoots.LocalBase "TEK STOCK")
  Assert-ExactCleanPath -Actual $Roots.LegacyWorkbook -Expected (Join-Path $BaseRoots.DocumentsBase "TEK STOCK\TEK-STOCK-LIVE.xlsx")
  if ($Roots.Roaming -eq $Roots.Local -or $Roots.Roaming -eq $Roots.LegacyWorkbook -or $Roots.Local -eq $Roots.LegacyWorkbook) {
    throw "Unsafe TEK STOCK cleanup target."
  }
}

function Assert-TargetWorkbooksUnlocked {
  param([Parameter(Mandatory)][hashtable]$Roots)
  $workbooks = @($Roots.LegacyWorkbook)
  $privateWorkbooks = Join-Path $Roots.Local "workbooks"
  if (Test-Path -LiteralPath $privateWorkbooks) {
    $workbooks += @(Get-ChildItem -LiteralPath $privateWorkbooks -File -Recurse -Filter "*.xlsx" -ErrorAction Stop | ForEach-Object { $_.FullName })
  }
  foreach ($workbook in $workbooks | Select-Object -Unique) {
    if (-not (Test-Path -LiteralPath $workbook)) { continue }
    try {
      $handle = [IO.File]::Open($workbook, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      $handle.Dispose()
    } catch {
      throw "Close TEK STOCK Excel and retry."
    }
  }
}

function Assert-InteractiveOwner {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $explorer = @(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session } | Select-Object -First 1)
  if ($explorer.Count -ne 1) { throw "Clean reinstall must be run by the signed-in desktop user." }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($explorer[0].Id)"
  $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $current) {
    throw "Clean reinstall user does not match the signed-in desktop user."
  }
}

function Stop-TekStockProcesses {
  $allowed = @(
    (Join-Path $env:ProgramFiles "TEK STOCK\TEK STOCK.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "TEK STOCK\TEK STOCK.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\TEK STOCK\TEK STOCK.exe")
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { [IO.Path]::GetFullPath($_) }
  foreach ($process in @(Get-Process -Name "TEK STOCK" -ErrorAction SilentlyContinue)) {
    if ($process.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { continue }
    $ownerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction SilentlyContinue
    if ($null -eq $ownerProcess) { continue }
    $owner = Invoke-CimMethod -InputObject $ownerProcess -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    if ($null -eq $owner -or $owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { continue }
    $processPath = $null
    try { $processPath = [IO.Path]::GetFullPath($process.Path) } catch { continue }
    if ($allowed -notcontains $processPath) { continue }
    [void]$process.CloseMainWindow()
    if (-not $process.WaitForExit(5000)) { Stop-Process -Id $process.Id -Force -ErrorAction Stop }
  }
}

function Remove-KnownTekStockMsi {
  $codes = @(
    "{3A304031-9F89-44AA-B152-375A08CB9B51}", "{4F7AE8D7-B021-4B8B-9222-CCACFC52C44C}",
    "{08A9F778-1D5B-41BC-AFA3-B4C0D2719ACA}", "{A0C1C94B-9A8C-40C3-A635-A6307811995C}",
    "{A06205DA-8549-4915-A12A-181FD0B8282C}", "{39B92FFE-0D84-4570-960A-6C9A095DDF7A}",
    "{9DD6E437-7ECE-4693-A0FB-D80845BF1770}", "{B9531E83-0B96-40C9-A759-65A1DE15DA00}",
    "{EE1CEE15-88E4-4005-AC17-574809A339EE}", "{420ECF89-6F61-4538-8677-C3194A3254EA}",
    "{A4065439-2F6D-406D-9AE0-1A1CB6F0DC8C}", "{CDA1D955-F8F6-4D02-9774-B3282E7DE1ED}"
  )
  foreach ($code in $codes) {
    $key = @("HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$code", "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\$code", "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$code") |
      Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $key) { continue }
    $displayName = (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).DisplayName
    if ($displayName -notmatch "^TEK STOCK(?: Singapore)?$") { continue }
    $child = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList "/x $code /qn /norestart" -Wait -PassThru -WindowStyle Hidden
    if ($child.ExitCode -notin 0, 1605, 1614) { throw "Known TEK STOCK MSI uninstall failed." }
  }
}

function Remove-TekStockData {
  param([Parameter(Mandatory)][hashtable]$Roots)
  foreach ($directory in @($Roots.Roaming, $Roots.Local)) {
    if (Test-Path -LiteralPath $directory) {
      Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction Stop
    }
  }
  if (Test-Path -LiteralPath $Roots.LegacyWorkbook) {
    try { Remove-Item -LiteralPath $Roots.LegacyWorkbook -Force -ErrorAction Stop }
    catch { throw "Close TEK STOCK Excel and retry." }
  }
}

function Invoke-TekStockCleanReinstall {
  param(
    [Parameter(Mandatory)][hashtable]$Roots,
    [Parameter(Mandatory)][hashtable]$BaseRoots,
    [switch]$SkipProcessStop,
    [switch]$SkipMsi,
    [switch]$SkipUserCheck
  )
  Assert-CleanRoots -Roots $Roots -BaseRoots $BaseRoots
  Assert-TargetWorkbooksUnlocked -Roots $Roots
  if (-not $SkipUserCheck) { Assert-InteractiveOwner }
  if (-not $SkipProcessStop) { Stop-TekStockProcesses }
  if (-not $SkipMsi) { Remove-KnownTekStockMsi }
  Remove-TekStockData -Roots $Roots
  Write-Output "CLEAN_REINSTALL_OK"
}

if ($RunProduction) {
  Invoke-TekStockCleanReinstall -Roots (Get-TekStockProductionRoots) -BaseRoots (Get-TekStockBaseRoots)
}
