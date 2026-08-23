"use strict";

const fs = require("node:fs");
const { createHash } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const FIND_OPEN_WORKBOOK = String.raw`
function Find-TekWorkbook([string]$target) {
  $targetPath = [IO.Path]::GetFullPath($target)
  try {
    $boundBook = [Runtime.InteropServices.Marshal]::BindToMoniker($targetPath)
    if ($null -ne $boundBook -and [IO.Path]::GetFullPath([string]$boundBook.FullName) -ieq $targetPath) {
      return [pscustomobject]@{ Application = $boundBook.Application; Workbook = $boundBook }
    }
  } catch {}
  $applications = @()
  foreach ($progId in @('Excel.Application', 'Ket.Application')) {
    try {
      $candidate = [Runtime.InteropServices.Marshal]::GetActiveObject($progId)
      if ($null -ne $candidate) { $applications += $candidate }
    } catch {}
  }
  foreach ($application in $applications) {
    foreach ($book in @($application.Workbooks)) {
      try {
        if ([IO.Path]::GetFullPath([string]$book.FullName) -ieq $targetPath) {
          return [pscustomobject]@{ Application = $application; Workbook = $book }
        }
      } catch {}
    }
  }
  throw 'OPEN_WORKBOOK_AUTOMATION_UNAVAILABLE'
}
`;

const FIND_WORKSHEET_BY_NAME = String.raw`
function Find-TekWorksheet($book, [string]$name) {
  for ($index=1; $index -le [int]$book.Worksheets.Count; $index++) {
    try {
      $candidate=$book.Worksheets.Item($index)
      if ([string]$candidate.Name -ieq $name) { return $candidate }
    } catch {}
  }
  throw 'WORKBOOK_SHEET_NOT_FOUND'
}
`;

const SHOW_TEK_INVENTORY = String.raw`
function Show-TekInventory($application, $book) {
  try { [void]($application.UserControl = $true) } catch {}
  try { [void]($application.Interactive = $true) } catch {}
  try { [void]($application.Visible = $true) } catch {}
  try { [void]($application.ScreenUpdating = $true) } catch {}
  try { [void]$book.Activate() } catch {}
  try {
    foreach ($window in @($book.Windows)) {
      try { [void]($window.Visible = $true) } catch {}
      try { [void]$window.Activate() } catch {}
      try { [void]($window.WindowState = -4137) } catch {}
      try { [void]($window.Zoom = 140) } catch {}
    }
  } catch {}
  $sheet = $null
  $names = @()
  if ([string]$env:TEK_STOCK_SHEET) { $names += [string]$env:TEK_STOCK_SHEET }
  $names += @('库存总表','库存')
  foreach ($name in $names) {
    try { $sheet = Find-TekWorksheet $book $name; if ($null -ne $sheet) { break } } catch {}
  }
  if ($null -eq $sheet) {
    for ($index=1; $index -le [int]$book.Worksheets.Count; $index++) {
      try {
        $candidate=$book.Worksheets.Item($index)
        if ([int]$candidate.Visible -eq -1) { $sheet=$candidate; break }
      } catch {}
    }
  }
  if ($null -ne $sheet) {
    try { [void]$sheet.Activate() } catch {}
    try { [void]($sheet.AutoFilterMode = $false) } catch {}
    try { $application.Goto($sheet.Range('A1'), $true) } catch {}
    try { $application.Goto($sheet.Range('A5'), $true) } catch { try { [void]$sheet.Range('A5').Select() } catch {} }
  }
}
`;

const FIND_ALREADY_OPEN_WORKBOOK = String.raw`
function Find-TekAlreadyOpenWorkbook([string]$target) {
  $targetPath = [IO.Path]::GetFullPath($target)
  try {
    $boundBook = [Runtime.InteropServices.Marshal]::BindToMoniker($targetPath)
    if ($null -ne $boundBook -and [IO.Path]::GetFullPath([string]$boundBook.FullName) -ieq $targetPath) {
      return [pscustomobject]@{ Application = $boundBook.Application; Workbook = $boundBook }
    }
  } catch {}
  $applications = @()
  foreach ($progId in @('Excel.Application', 'Ket.Application')) {
    try {
      $candidate = [Runtime.InteropServices.Marshal]::GetActiveObject($progId)
      if ($null -ne $candidate) { $applications += $candidate }
    } catch {}
  }
  foreach ($application in $applications) {
    foreach ($book in @($application.Workbooks)) {
      try {
        if ([IO.Path]::GetFullPath([string]$book.FullName) -ieq $targetPath) {
          return [pscustomobject]@{ Application = $application; Workbook = $book }
        }
      } catch {}
    }
  }
  throw 'OPEN_WORKBOOK_NOT_ALREADY_OPEN'
}
`;


const LAUNCH_TEK_SPREADSHEET = String.raw`
function Launch-TekSpreadsheet([string]$target) {
  $et = @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Kingsoft\WPS Office') -Filter 'et.exe' -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
  if ($et.Count -gt 0) {
    Start-Process -FilePath $et[0].FullName -ArgumentList @($target)
    return
  }
  $excel = Join-Path $env:ProgramFiles 'Microsoft Office\root\Office16\EXCEL.EXE'
  if (Test-Path -LiteralPath $excel) {
    Start-Process -FilePath $excel -ArgumentList @($target)
  }
}
function Wait-TekWorkbook([string]$target) {
  $targetPath = [IO.Path]::GetFullPath($target)
  for ($i=0; $i -lt 20; $i++) {
    try {
      $boundBook = [Runtime.InteropServices.Marshal]::BindToMoniker($targetPath)
      if ($null -ne $boundBook -and [IO.Path]::GetFullPath([string]$boundBook.FullName) -ieq $targetPath) {
        return [pscustomobject]@{ Application = $boundBook.Application; Workbook = $boundBook }
      }
    } catch {}
    Start-Sleep -Milliseconds 400
  }
  throw 'OPEN_WORKBOOK_WAIT_FAILED'
}
`;

function workbookLockPath(file, pathApi = path) {
  return pathApi.join(pathApi.dirname(file), `~$${pathApi.basename(file)}`);
}

function isWorkbookLocked(file, fsApi = fs, pathApi = path) {
  return fsApi.existsSync(workbookLockPath(file, pathApi));
}

function runPowerShell(script, env, options = {}) {
  const run = options.execFileSync || execFileSync;
  const output = run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 20_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const text = String(output || "").replace(/^\uFEFF/, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}\s*$/);
    if (!match) throw new Error("OPEN_WORKBOOK_AUTOMATION_FAILED");
    parsed = JSON.parse(match[0]);
  }
  if (parsed.ok !== true) throw new Error(parsed.error || "OPEN_WORKBOOK_AUTOMATION_FAILED");
  return parsed;
}

function findWpsSpreadsheetExecutable(options = {}) {
  const fsApi = options.fsApi || fs;
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || "";
  const root = path.join(localAppData, "Kingsoft", "WPS Office");
  try {
    return fsApi.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "office6", "et.exe"))
      .find((candidate) => fsApi.existsSync(candidate)) || "";
  } catch {
    return "";
  }
}

function openWorkbookWithPersistentWps(file, options = {}) {
  const target = path.resolve(file);
  const et = findWpsSpreadsheetExecutable(options);
  if (!et) return null;
  const wps = path.join(path.dirname(et), "wps.exe");
  const fsApi = options.fsApi || fs;
  if (!fsApi.existsSync(wps)) return null;
  const execute = options.execFileSync || execFileSync;
  const launcher = String.raw`
$ErrorActionPreference='Stop'
$target=[IO.Path]::GetFullPath($env:TEK_STOCK_WORKBOOK)
$expected=[IO.Path]::GetFileName($target)
$lock=Join-Path ([IO.Path]::GetDirectoryName($target)) ('~$'+$expected)
[void](Start-Process -FilePath $env:TEK_STOCK_WPS_LAUNCHER -ArgumentList @('/prometheus','/et','/n',('"'+$target+'"')))
$deadline=[DateTime]::UtcNow.AddSeconds(25)
$window=$null
while([DateTime]::UtcNow -lt $deadline){
  foreach($candidate in @(Get-Process -Name 'wps' -ErrorAction SilentlyContinue)){
    if($candidate.MainWindowHandle -ne 0 -and [string]$candidate.MainWindowTitle -like ($expected+'*WPS*')){$window=$candidate;break}
  }
  if($null -ne $window -and (Test-Path -LiteralPath $lock)){break}
  $window=$null
  Start-Sleep -Milliseconds 250
}
if(-not (Test-Path -LiteralPath $lock)){throw 'WPS_WORKBOOK_LOCK_NOT_FOUND'}
if($null -eq $window){throw 'WPS_WORKBOOK_WINDOW_NOT_FOUND'}
[Console]::Out.Write(([pscustomobject]@{ok=$true;opened=$true;path=$target;title=[string]$window.MainWindowTitle;windowHandle=[int64]$window.MainWindowHandle;locked=$true}|ConvertTo-Json -Compress))
`;
  const launcherEncoded = Buffer.from(launcher, "utf16le").toString("base64");
  const output = execute("powershell.exe", [
    "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", launcherEncoded,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 30_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      TEK_STOCK_WORKBOOK: target,
      TEK_STOCK_WPS_LAUNCHER: wps,
    },
  });
  const text = String(output || "").replace(/^\uFEFF/, "").trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    const match = text.match(/\{[\s\S]*\}\s*$/);
    if (!match) throw new Error("WPS_OPEN_CONFIRMATION_FAILED");
    parsed = JSON.parse(match[0]);
  }
  if (parsed.ok !== true || parsed.opened !== true) {
    throw new Error(parsed.error || "WPS_OPEN_CONFIRMATION_FAILED");
  }
  return { ...parsed, path: target, persistent: true };
}

function saveOpenWorkbook(file, options = {}) {
  const script = [
    "$ErrorActionPreference='Stop'",
    FIND_OPEN_WORKBOOK,
    "$result=Find-TekWorkbook $env:TEK_STOCK_WORKBOOK",
    "if([bool]$result.Workbook.ReadOnly){throw 'OPEN_WORKBOOK_READ_ONLY'}",
    "$result.Workbook.Save()",
    "[Console]::Out.Write(([pscustomobject]@{ok=$true;saved=$true;path=[string]$result.Workbook.FullName}|ConvertTo-Json -Compress))",
  ].join(";");
  return runPowerShell(script, { TEK_STOCK_WORKBOOK: path.resolve(file) }, options);
}

function focusOpenWorkbook(file, options = {}) {
  const target = path.resolve(file);
  const script = [
    "$ErrorActionPreference='Stop'",
    FIND_ALREADY_OPEN_WORKBOOK,
    FIND_WORKSHEET_BY_NAME,
    SHOW_TEK_INVENTORY,
    "try{$result=Find-TekAlreadyOpenWorkbook $env:TEK_STOCK_WORKBOOK}catch{[Console]::Out.Write(([pscustomobject]@{ok=$true;alreadyOpen=$false;path=$env:TEK_STOCK_WORKBOOK}|ConvertTo-Json -Compress));exit}",
    "Show-TekInventory $result.Application $result.Workbook",
    "[Console]::Out.Write(([pscustomobject]@{ok=$true;alreadyOpen=$true;path=[string]$result.Workbook.FullName}|ConvertTo-Json -Compress))",
  ].join(";");
  return runPowerShell(script, { TEK_STOCK_WORKBOOK: target, TEK_STOCK_SHEET: "库存总表" }, options);
}

function openWorkbookInOffice(file, options = {}) {
  const target = path.resolve(file);
  if (options.platform === "win32" || (options.platform === undefined && process.platform === "win32")) {
    const persistent = openWorkbookWithPersistentWps(target, options);
    if (persistent) return persistent;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    FIND_WORKSHEET_BY_NAME,
    SHOW_TEK_INVENTORY,
    LAUNCH_TEK_SPREADSHEET,
    "$target=[IO.Path]::GetFullPath($env:TEK_STOCK_WORKBOOK)",
    "$application=$null",
    "$book=$null",
    "try{$boundBook=[Runtime.InteropServices.Marshal]::BindToMoniker($target);if($null -ne $boundBook -and [IO.Path]::GetFullPath([string]$boundBook.FullName) -ieq $target){$book=$boundBook;$application=$boundBook.Application}}catch{}",
    "if($null -eq $book){Launch-TekSpreadsheet $target;try{$waited=Wait-TekWorkbook $target;$book=$waited.Workbook;$application=$waited.Application}catch{}}",
    "if($null -eq $book){foreach($progId in @('Ket.Application','Excel.Application')){try{$candidate=[Runtime.InteropServices.Marshal]::GetActiveObject($progId);foreach($openBook in @($candidate.Workbooks)){if([IO.Path]::GetFullPath([string]$openBook.FullName) -ieq $target){$application=$candidate;$book=$openBook;break}};if($null -ne $book){break}}catch{}}}",
    "if($null -eq $book){if($null -eq $application){foreach($progId in @('Ket.Application','Excel.Application')){try{$application=New-Object -ComObject $progId;try{[void]($application.UserControl=$true)}catch{};try{[void]($application.Visible=$true)}catch{};break}catch{}}};if($null -eq $application){throw 'OFFICE_AUTOMATION_UNAVAILABLE'};$book=$application.Workbooks.Open($target)}",
    "if([IO.Path]::GetFullPath([string]$book.FullName) -ine $target){throw 'OPEN_WORKBOOK_PATH_MISMATCH'}",
    "Show-TekInventory $application $book",
    "[Console]::Out.Write(([pscustomobject]@{ok=$true;opened=$true;path=[string]$book.FullName}|ConvertTo-Json -Compress))",
  ].join(";");
  return runPowerShell(script, { TEK_STOCK_WORKBOOK: target, TEK_STOCK_SHEET: "库存总表" }, {
    ...options,
    timeout: options.timeout || 30_000,
  });
}

function applyOpenWorkbookMutation(file, payload, options = {}) {
  const fsApi = options.fsApi || fs;
  const temporaryDirectory = fsApi.mkdtempSync(path.join(os.tmpdir(), "tek-stock-live-"));
  const payloadPath = path.join(temporaryDirectory, "mutation.json");
  try {
    fsApi.writeFileSync(payloadPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    const script = [
      "$ErrorActionPreference='Stop'",
      FIND_OPEN_WORKBOOK,
      FIND_WORKSHEET_BY_NAME,
      "$payload=Get-Content -LiteralPath $env:TEK_STOCK_MUTATION -Raw -Encoding UTF8|ConvertFrom-Json",
      "$result=Find-TekWorkbook $env:TEK_STOCK_WORKBOOK",
      "$book=$result.Workbook",
      "if([bool]$book.ReadOnly){throw 'OPEN_WORKBOOK_READ_ONLY'}",
      "if(-not [bool]$book.Saved){throw 'OPEN_WORKBOOK_CHANGED_DURING_SYNC'}",
      "$sheet=Find-TekWorksheet $book ([string]$payload.sheetName)",
      "foreach($entry in @($payload.idCells)){if([int]$entry.rowNumber -ge 5){$cell=$sheet.Cells.Item([int]$entry.rowNumber,2);$current=[string]$cell.Value2;$hasExpected=$null -ne $entry.PSObject.Properties['expectedId'];if($hasExpected){if($current -ne [string]$entry.expectedId){throw 'WORKBOOK_ID_ASSIGNMENT_CONFLICT'}}elseif($current){throw 'WORKBOOK_ID_ASSIGNMENT_CONFLICT'};$cell.Value2=[string]$entry.id}}",
      "foreach($entry in @($payload.imageHashes)){if([int]$entry.rowNumber -ge 5){$sheet.Cells.Item([int]$entry.rowNumber,15).Value2=[string]$entry.hash}}",
      "if($null -ne $payload.baselineRows){try{$baseline=Find-TekWorksheet $book '_TEK_BASELINE'}catch{$baseline=$book.Worksheets.Add();$baseline.Name='_TEK_BASELINE'};[void]($baseline.Cells.ClearContents());$baseline.Cells.Item(1,1).Value2='id';$baseline.Cells.Item(1,2).Value2='baseline';$index=2;foreach($entry in @($payload.baselineRows)){$baseline.Cells.Item($index,1).Value2=[string]$entry.id;$baseline.Cells.Item($index,2).Value2=[string]$entry.baseline;$index++};[void]($baseline.Visible=2)}",
      "if($null -ne $payload.meta){try{$meta=Find-TekWorksheet $book '_TEK_META'}catch{$meta=$book.Worksheets.Add();$meta.Name='_TEK_META'};$rows=@{};$used=[Math]::Max(1,[int]$meta.UsedRange.Rows.Count);for($i=1;$i -le $used;$i++){$key=[string]$meta.Cells.Item($i,1).Text;if($key){$rows[$key]=$i}};foreach($property in $payload.meta.psobject.Properties){$key=[string]$property.Name;if($rows.ContainsKey($key)){$row=[int]$rows[$key]}else{$row=[int]$meta.UsedRange.Rows.Count+1;$rows[$key]=$row};$meta.Cells.Item($row,1).Value2=$key;$meta.Cells.Item($row,2).Value2=[string]$property.Value};[void]($meta.Visible=2)}",
      "$book.Save()",
      "[Console]::Out.Write(([pscustomobject]@{ok=$true;saved=$true;path=[string]$book.FullName}|ConvertTo-Json -Compress))",
    ].join(";");
    return runPowerShell(script, {
      TEK_STOCK_WORKBOOK: path.resolve(file),
      TEK_STOCK_MUTATION: payloadPath,
    }, options);
  } finally {
    fsApi.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function replaceOpenWorkbookFile(file, replacement, options = {}) {
  const target = path.resolve(file);
  const candidate = path.resolve(replacement);
  const backup = `${target}.refresh-backup`;
  if (path.dirname(candidate).toLowerCase() !== path.dirname(target).toLowerCase()
      || path.basename(candidate).toLowerCase() !== `${path.basename(target).toLowerCase()}.tmp.xlsx`) {
    throw new Error("OPEN_WORKBOOK_REPLACEMENT_PATH_INVALID");
  }
  const expectedSha256 = String(options.expectedSha256 || "").trim().toLowerCase();
  if (expectedSha256) {
    const actualSha256 = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    if (actualSha256 !== expectedSha256) {
      fs.rmSync(candidate, { force: true });
      const changed = new Error("WORKBOOK_CONTENT_CHANGED");
      changed.code = "WORKBOOK_CONTENT_CHANGED";
      throw changed;
    }
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    FIND_OPEN_WORKBOOK,
    "$result=Find-TekWorkbook $env:TEK_STOCK_WORKBOOK",
    "$book=$result.Workbook",
    "$application=$result.Application",
    "if([bool]$book.ReadOnly){throw 'OPEN_WORKBOOK_READ_ONLY'}",
    "if(-not [bool]$book.Saved){throw 'OPEN_WORKBOOK_HAS_UNSAVED_CHANGES'}",
    "$book.Close($false)",
    "if([string]$env:TEK_STOCK_EXPECTED_SHA256){$diskHash=(Get-FileHash -LiteralPath $env:TEK_STOCK_WORKBOOK -Algorithm SHA256).Hash.ToLowerInvariant();if($diskHash -ne ([string]$env:TEK_STOCK_EXPECTED_SHA256).ToLowerInvariant()){try{$null=$application.Workbooks.Open($env:TEK_STOCK_WORKBOOK)}catch{};throw 'WORKBOOK_CONTENT_CHANGED'}}",
    "try{if(Test-Path -LiteralPath $env:TEK_STOCK_WORKBOOK){if(Test-Path -LiteralPath $env:TEK_STOCK_BACKUP){Remove-Item -LiteralPath $env:TEK_STOCK_BACKUP -Force};[IO.File]::Replace($env:TEK_STOCK_REPLACEMENT,$env:TEK_STOCK_WORKBOOK,$env:TEK_STOCK_BACKUP,$true)}else{[IO.File]::Move($env:TEK_STOCK_REPLACEMENT,$env:TEK_STOCK_WORKBOOK)}}catch{try{$null=$application.Workbooks.Open($env:TEK_STOCK_WORKBOOK)}catch{};throw}",
    "try{$reopened=$application.Workbooks.Open($env:TEK_STOCK_WORKBOOK)}catch{if(Test-Path -LiteralPath $env:TEK_STOCK_BACKUP){[IO.File]::Copy($env:TEK_STOCK_BACKUP,$env:TEK_STOCK_WORKBOOK,$true);try{$null=$application.Workbooks.Open($env:TEK_STOCK_WORKBOOK)}catch{}};throw}",
    "if(Test-Path -LiteralPath $env:TEK_STOCK_BACKUP){Remove-Item -LiteralPath $env:TEK_STOCK_BACKUP -Force -ErrorAction SilentlyContinue}",
    "[Console]::Out.Write(([pscustomobject]@{ok=$true;reopened=$true;path=[string]$reopened.FullName}|ConvertTo-Json -Compress))",
  ].join(";");
  try {
    return runPowerShell(script, {
      TEK_STOCK_WORKBOOK: target,
      TEK_STOCK_REPLACEMENT: candidate,
      TEK_STOCK_BACKUP: backup,
      TEK_STOCK_EXPECTED_SHA256: expectedSha256,
    }, { ...options, timeout: options.timeout || 30_000 });
  } catch (error) {
    if (/WORKBOOK_CONTENT_CHANGED/i.test(String(error?.code || error?.message || ""))) {
      fs.rmSync(candidate, { force: true });
      const changed = new Error("WORKBOOK_CONTENT_CHANGED");
      changed.code = "WORKBOOK_CONTENT_CHANGED";
      throw changed;
    }
    throw error;
  }
}

module.exports = {
  applyOpenWorkbookMutation,
  focusOpenWorkbook,
  isWorkbookLocked,
  openWorkbookInOffice,
  openWorkbookWithPersistentWps,
  replaceOpenWorkbookFile,
  saveOpenWorkbook,
  workbookLockPath,
};
