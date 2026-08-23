"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const ExcelJS = require("exceljs");
const { replaceOpenWorkbookFile } = require("../excel-live.cjs");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function writeFixture(file, models) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("库存总表");
  sheet.addRow(["TEK STOCK"]);
  sheet.addRow([]);
  sheet.addRow([]);
  sheet.addRow(["照片", "Item ID", "分类", "型号"]);
  models.forEach((model, index) => sheet.addRow(["", `id-${index + 1}`, "测试", model]));
  workbook.addWorksheet("_TEK_META", { state: "veryHidden" }).addRow(["revision", 1]);
  await workbook.xlsx.writeFile(file);
}

async function waitForFile(file, timeoutMs = 30_000) {
  const expires = Date.now() + timeoutMs;
  while (Date.now() < expires) {
    if (fs.existsSync(file)) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${path.basename(file)}`);
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-open-refresh-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  const replacement = `${file}.tmp.xlsx`;
  const ready = path.join(directory, "ready");
  const done = path.join(directory, "done");
  let child;
  try {
    await writeFixture(file, ["KEEP", "DELETE-ME"]);
    await writeFixture(replacement, ["KEEP"]);
    const controller = [
      "$ErrorActionPreference='Stop'",
      "$app=New-Object -ComObject Ket.Application",
      "$app.Visible=$true",
      "$book=$app.Workbooks.Open($env:TEK_TEST_WORKBOOK)",
      "New-Item -ItemType File -Path $env:TEK_TEST_READY -Force|Out-Null",
      "$limit=(Get-Date).AddSeconds(45)",
      "while(!(Test-Path -LiteralPath $env:TEK_TEST_DONE)){if((Get-Date)-gt $limit){throw 'TEST_TIMEOUT'};Start-Sleep -Milliseconds 200}",
      "foreach($openBook in @($app.Workbooks)){$openBook.Close($false)}",
      "$app.Quit()",
    ].join(";");
    child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", controller,
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TEK_TEST_WORKBOOK: file,
        TEK_TEST_READY: ready,
        TEK_TEST_DONE: done,
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await waitForFile(ready);
    const refreshed = replaceOpenWorkbookFile(file, replacement, { timeout: 30_000 });
    assert.equal(refreshed.reopened, true);
    fs.writeFileSync(done, "done");
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 0, stderr);
    const verified = new ExcelJS.Workbook();
    await verified.xlsx.readFile(file);
    const models = [];
    const sheet = verified.getWorksheet("库存总表");
    for (let row = 5; row <= sheet.rowCount; row += 1) {
      const model = sheet.getRow(row).getCell(4).text.trim();
      if (model) models.push(model);
    }
    assert.deepEqual(models, ["KEEP"]);
    console.log(JSON.stringify({ ok: true, provider: "WPS", reopened: true, deletedRowRemoved: true }));
  } finally {
    if (child && child.exitCode === null) {
      fs.writeFileSync(done, "done");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(5_000),
      ]);
      if (child.exitCode === null) child.kill();
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 9) throw error;
        await delay(300);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
