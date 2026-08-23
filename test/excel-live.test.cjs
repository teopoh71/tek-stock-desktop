"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyOpenWorkbookMutation,
  focusOpenWorkbook,
  isWorkbookLocked,
  openWorkbookInOffice,
  openWorkbookWithPersistentWps,
  replaceOpenWorkbookFile,
  saveOpenWorkbook,
  workbookLockPath,
} = require("../excel-live.cjs");

test("WPS opens through its registered launcher and verifies a real workbook window", () => {
  let observed;
  const result = openWorkbookWithPersistentWps("C:\\Users\\Edwin\\TEK STOCK\\TEK-STOCK-LIVE.xlsx", {
    localAppData: "C:\\Wps",
    fsApi: {
      readdirSync() { return [{ name: "office", isDirectory: () => true }]; },
      existsSync(candidate) { return candidate.endsWith("et.exe") || candidate.endsWith("wps.exe"); },
    },
    execFileSync(command, args, options) {
      observed = { command, args, options };
      return JSON.stringify({ ok: true, opened: true, path: options.env.TEK_STOCK_WORKBOOK });
    },
  });
  assert.equal(result.persistent, true);
  assert.equal(observed.command, "powershell.exe");
  assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.options.env.TEK_STOCK_WORKBOOK.endsWith("TEK-STOCK-LIVE.xlsx"), true);
  assert.equal(observed.options.env.TEK_STOCK_WPS_LAUNCHER.endsWith("wps.exe"), true);
  const launcher = Buffer.from(observed.args.at(-1), "base64").toString("utf16le");
  assert.match(launcher, /Start-Process/);
  assert.match(launcher, /prometheus/);
  assert.match(launcher, /'\/n'/);
  assert.match(launcher, /MainWindowTitle/);
  assert.match(launcher, /MainWindowHandle/);
  assert.match(launcher, /MainWindowHandle -ne 0 -and/);
  assert.match(launcher, /WPS_WORKBOOK_WINDOW_NOT_FOUND/);
  assert.match(launcher, /WPS_WORKBOOK_LOCK_NOT_FOUND/);
  assert.match(launcher, /Test-Path -LiteralPath \$lock/);
  assert.doesNotMatch(launcher, /Ket\.Application/);
  assert.doesNotMatch(launcher, /Workbooks\.Open/);
  assert.match(launcher, /MainWindowTitle -like/);
});

test("opens and verifies the canonical workbook through Office automation", () => {
  let observed;
  const result = openWorkbookInOffice("C:\\Users\\Edwin\\TEK STOCK\\TEK-STOCK-LIVE.xlsx", {
  execFileSync(command, args, options) {
      observed = { command, script: args.at(-1), options };
      return JSON.stringify({ ok: true, opened: true, path: options.env.TEK_STOCK_WORKBOOK });
    },
    platform: "linux",
  });

  assert.equal(result.opened, true);
  assert.equal(observed.command, "powershell.exe");
  assert.match(observed.script, /Ket\.Application/);
  assert.match(observed.script, /Excel\.Application/);
  assert.match(observed.script, /Workbooks\.Open/);
  assert.match(observed.script, /OPEN_WORKBOOK_PATH_MISMATCH/);
  assert.match(observed.script, /BindToMoniker/);
  assert.match(observed.script, /库存总表/);
  assert.match(observed.script, /Show-TekInventory|Goto|A5/);
  assert.match(observed.script, /Windows/);
  assert.match(observed.script, /Visible/);
  assert.match(observed.script, /WindowState/);
  assert.match(observed.script, /Zoom/);
  assert.match(observed.script, /UserControl/);
  assert.match(observed.script, /et\.exe/);
  assert.match(observed.script, /\[void\]/);
  assert.match(observed.script, /库存/);
  assert.equal(observed.options.env.TEK_STOCK_WORKBOOK,
    "C:\\Users\\Edwin\\TEK STOCK\\TEK-STOCK-LIVE.xlsx");
  assert.equal(observed.options.env.TEK_STOCK_SHEET, "库存总表");
});


test("office automation ignores True prefixes leaked by COM assignments", () => {
  const result = openWorkbookInOffice("C:\\Users\\Edwin\\TEK STOCK\\TEK-STOCK-LIVE.xlsx", {
    execFileSync() {
      return 'True {"ok":true,"opened":true}';
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.opened, true);
});

test("focuses an already-open WPS workbook instead of opening a second copy", () => {
  let observed;
  const result = focusOpenWorkbook("C:\\Users\\Edwin\\TEK-STOCK-LIVE.xlsx", {
    execFileSync(command, args, options) {
      observed = { command, script: args.at(-1), options };
      return JSON.stringify({ ok: true, alreadyOpen: true, path: options.env.TEK_STOCK_WORKBOOK });
    },
  });
  assert.deepEqual(result, {
    ok: true,
    alreadyOpen: true,
    path: "C:\\Users\\Edwin\\TEK-STOCK-LIVE.xlsx",
  });
  assert.equal(observed.command, "powershell.exe");
  assert.match(observed.script, /Ket\.Application/);
  assert.match(observed.script, /BindToMoniker/);
  assert.match(observed.script, /Activate\(\)/);
  assert.match(observed.script, /库存总表/);
  assert.match(observed.script, /Show-TekInventory|Goto|A5/);
  assert.match(observed.script, /Windows/);
  assert.match(observed.script, /Visible/);
  assert.match(observed.script, /WindowState/);
  assert.match(observed.script, /Zoom/);
  assert.match(observed.script, /UserControl/);
  assert.doesNotMatch(observed.script, /et\.exe/);
  assert.match(observed.script, /\[void\]/);
  assert.match(observed.script, /库存/);
  assert.equal(observed.options.env.TEK_STOCK_SHEET, "库存总表");
});

test("canonical lock detection uses only the sibling Office lock file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-live-lock-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  fs.writeFileSync(file, "xlsx");
  assert.equal(isWorkbookLocked(file), false);
  fs.writeFileSync(workbookLockPath(file), "lock");
  assert.equal(isWorkbookLocked(file), true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("cloud refresh safely replaces and reopens only the canonical workbook", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-live-reopen-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  const replacement = `${file}.tmp.xlsx`;
  fs.writeFileSync(file, "old");
  fs.writeFileSync(replacement, "new");
  let observed;
  const result = replaceOpenWorkbookFile(file, replacement, {
    execFileSync(command, args, options) {
      observed = { command, script: args.at(-1), env: options.env };
      return JSON.stringify({ ok: true, reopened: true, path: options.env.TEK_STOCK_WORKBOOK });
    },
  });
  assert.equal(result.reopened, true);
  assert.match(observed.script, /OPEN_WORKBOOK_HAS_UNSAVED_CHANGES/);
  assert.match(observed.script, /BindToMoniker/);
  assert.match(observed.script, /\.Close\(\$false\)/);
  assert.match(observed.script, /TEK_STOCK_BACKUP/);
  assert.match(observed.script, /TEK_STOCK_EXPECTED_SHA256/);
  assert.match(observed.script, /Workbooks\.Open/);
  assert.equal(observed.env.TEK_STOCK_REPLACEMENT, replacement);
  assert.equal(observed.env.TEK_STOCK_BACKUP, `${file}.refresh-backup`);
  assert.equal(observed.env.TEK_STOCK_EXPECTED_SHA256, "");
  assert.throws(
    () => replaceOpenWorkbookFile(file, path.join(directory, "other.xlsx")),
    /REPLACEMENT_PATH_INVALID/,
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a stale workbook SHA stops before live replacement automation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-live-cas-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  const replacement = `${file}.tmp.xlsx`;
  fs.writeFileSync(file, "newer-user-save");
  fs.writeFileSync(replacement, "generated-cloud-copy");
  let automationCalls = 0;
  assert.throws(() => replaceOpenWorkbookFile(file, replacement, {
    expectedSha256: createHash("sha256").update("older-snapshot").digest("hex"),
    execFileSync() { automationCalls += 1; return "{}"; },
  }), /WORKBOOK_CONTENT_CHANGED/);
  assert.equal(automationCalls, 0);
  assert.equal(fs.readFileSync(file, "utf8"), "newer-user-save");
  assert.equal(fs.existsSync(replacement), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("explicit cloud reset replacement permits local content drift after confirmation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-live-reset-drift-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  const replacement = `${file}.tmp.xlsx`;
  fs.writeFileSync(file, "newer-user-save");
  fs.writeFileSync(replacement, "generated-cloud-copy");
  let observed;
  const result = replaceOpenWorkbookFile(file, replacement, {
    execFileSync(_command, args, options) {
      observed = { script: args.at(-1), env: options.env };
      return JSON.stringify({ ok: true, reopened: true });
    },
  });
  assert.equal(result.reopened, true);
  assert.equal(observed.env.TEK_STOCK_EXPECTED_SHA256, "");
  assert.match(observed.script, /if\(\[string\]\$env:TEK_STOCK_EXPECTED_SHA256\)/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a save racing after preflight is preserved by the post-close hash guard", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-live-late-save-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  const replacement = `${file}.tmp.xlsx`;
  fs.writeFileSync(file, "snapshot-used-for-merge");
  fs.writeFileSync(replacement, "generated-cloud-copy");
  const expectedSha256 = createHash("sha256").update("snapshot-used-for-merge").digest("hex");
  let script = "";
  assert.throws(() => replaceOpenWorkbookFile(file, replacement, {
    expectedSha256,
    execFileSync(_command, args) {
      script = args.at(-1);
      fs.writeFileSync(file, "newer-user-save");
      throw new Error("PowerShell failed: WORKBOOK_CONTENT_CHANGED");
    },
  }), (error) => error.code === "WORKBOOK_CONTENT_CHANGED");
  const closeIndex = script.indexOf("$book.Close($false)");
  const firstHashIndex = script.indexOf("Get-FileHash");
  const finalHashIndex = script.indexOf("Get-FileHash", closeIndex);
  const replaceIndex = script.indexOf("[IO.File]::Replace", closeIndex);
  assert.ok(closeIndex >= 0);
  assert.ok(firstHashIndex > closeIndex);
  assert.ok(finalHashIndex > closeIndex);
  assert.ok(replaceIndex > finalHashIndex);
  assert.equal(fs.readFileSync(file, "utf8"), "newer-user-save");
  assert.equal(fs.existsSync(replacement), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("cloud-to-Excel refresh uses the reopen path when Office owns the workbook", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "main.cjs"), "utf8");
  const body = source.match(/async function writeWorkbookNow\(payload\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(body, /if\s*\(isWorkbookLocked\(file\)\)[\s\S]*?replaceOpenWorkbookFile\(file, temporary, \{ expectedSha256 \}\)/);
  assert.match(body, /WORKBOOK_CONTENT_CHANGED/);
  assert.match(body, /Save Excel first|请先保存 Excel/);
});

test("live save probes Microsoft Excel and WPS for the exact canonical path", () => {
  let observed;
  const result = saveOpenWorkbook("C:\\Users\\Edwin\\Documents\\TEK STOCK\\TEK-STOCK-LIVE.xlsx", {
    execFileSync(command, args, options) {
      observed = { command, args, options };
      return JSON.stringify({ ok: true, saved: true, path: options.env.TEK_STOCK_WORKBOOK });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(observed.command, "powershell.exe");
  assert.match(observed.args.at(-1), /Excel\.Application/);
  assert.match(observed.args.at(-1), /Ket\.Application/);
  assert.match(observed.args.at(-1), /BindToMoniker/);
  assert.equal(observed.options.env.TEK_STOCK_WORKBOOK.endsWith("TEK-STOCK-LIVE.xlsx"), true);
});

test("live mutation validates the open workbook without rereading its locked file", () => {
  const mutation = {
    sheetName: "库存总表",
    expectedSha256: "abc123",
    idCells: [{ rowNumber: 5, id: "permanent-id" }],
    imageHashes: [{ rowNumber: 5, hash: "photo-hash" }],
    baselineRows: [{ id: "permanent-id", baseline: "{\"model\":\"TEST\"}" }],
    meta: { revision: 10 },
  };
  let captured;
  const result = applyOpenWorkbookMutation("C:\\TEK STOCK\\TEK-STOCK-LIVE.xlsx", mutation, {
    execFileSync(command, args, options) {
      const payloadPath = options.env.TEK_STOCK_MUTATION;
      captured = {
        command,
        script: args.at(-1),
        payload: JSON.parse(fs.readFileSync(payloadPath, "utf8")),
        payloadPath,
      };
      return JSON.stringify({ ok: true, saved: true, path: options.env.TEK_STOCK_WORKBOOK });
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(captured.payload, mutation);
  assert.match(captured.script, /OPEN_WORKBOOK_CHANGED_DURING_SYNC/);
  assert.doesNotMatch(captured.script, /Get-FileHash/);
  assert.match(captured.script, /function Find-TekWorksheet/);
  assert.match(captured.script, /for\s*\(\$index=1;\s*\$index -le \[int\]\$book\.Worksheets\.Count;\s*\$index\+\+\)/);
  assert.match(captured.script, /\$candidate=\$book\.Worksheets\.Item\(\$index\)/);
  assert.doesNotMatch(captured.script, /foreach\s*\(\$candidate in @\(\$book\.Worksheets\)\)/);
  assert.match(captured.script, /Find-TekWorksheet \$book \(\[string\]\$payload\.sheetName\)/);
  assert.doesNotMatch(captured.script, /Worksheets\.Item\(\[string\]\$payload\.sheetName\)/);
  assert.doesNotMatch(captured.script, /Worksheets\.Item\('_TEK_(?:BASELINE|META)'\)/);
  assert.match(captured.script, /\$meta\.Cells\.Item\(\$row,2\)\.Value2=\[string\]\$property\.Value/);
  assert.match(captured.script, /\[void\]\(\$baseline\.Visible=2\)/);
  assert.match(captured.script, /\[void\]\(\$meta\.Visible=2\)/);
  assert.match(captured.script, /\[void\]\(\$baseline\.Cells\.ClearContents\(\)\)/);
  assert.equal(captured.script.includes("permanent-id"), false);
  assert.equal(fs.existsSync(captured.payloadPath), false);
});
