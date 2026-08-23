"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const JSZip = require("jszip");

const {
  buildWorkbook,
  prepareCanonicalWorkbookUpdate,
  stableFileSnapshot,
} = require("../main.cjs");

test("stable snapshot includes the exact disk content fingerprint", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-snapshot-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  fs.writeFileSync(file, "saved workbook bytes");
  const snapshot = stableFileSnapshot(file);
  assert.equal(snapshot.buffer.toString(), "saved workbook bytes");
  assert.equal(snapshot.size, 20);
  assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
});

test("stable snapshot rejects a file changed during the read", () => {
  let statCall = 0;
  const fsApi = {
    statSync: () => ({ size: statCall++ ? 2 : 1, mtimeMs: statCall * 10 }),
    readFileSync: () => Buffer.from("x"),
  };
  assert.throws(
    () => stableFileSnapshot("live.xlsx", fsApi),
    (error) => error.code === "EXCEL_CHANGED_DURING_READ",
  );
});

test("preflight saves and reads the canonical workbook without closing it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-open-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  fs.writeFileSync(file, "workbook");
  fs.writeFileSync(path.join(directory, "~$TEK-STOCK-LIVE.xlsx"), "lock");
  let saved = 0;
  const result = await prepareCanonicalWorkbookUpdate({
    file,
    saveOpenWorkbook: async () => { saved += 1; },
    readWorkbook: async (preparedFile) => ({ ok: true, path: preparedFile, items: [] }),
  });
  assert.equal(result.ok, true);
  assert.equal(saved, 1);
  assert.equal(result.path, file);
});

test("preflight fails closed when an open workbook cannot be saved safely", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-open-fail-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  fs.writeFileSync(file, "workbook");
  fs.writeFileSync(path.join(directory, "~$TEK-STOCK-LIVE.xlsx"), "lock");
  const result = await prepareCanonicalWorkbookUpdate({
    file,
    saveOpenWorkbook: async () => { throw new Error("OPEN_WORKBOOK_READ_ONLY"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "EXCEL_LIVE_SAVE_FAILED");
  assert.match(result.error, /do not need to close Excel/i);
});

test("preflight converts a workbook read exception into a structured result", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-read-error-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  fs.writeFileSync(file, "workbook");
  const result = await prepareCanonicalWorkbookUpdate({
    file,
    excelState: { running: false, ambiguous: false, workbooks: [], titles: [] },
    readWorkbook: async () => { throw new Error("ZIP parse raced WPS save"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "EXCEL_READ_FAILED");
  assert.match(result.error, /保存|读取|重试/);
  assert.equal(result.path, file);
});

test("cloud reset accepts a structurally valid workbook when grid parsing fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-reset-read-fallback-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  const workbook = await buildWorkbook({
    items: [],
    sync: { workbookId: "reset-fallback-fixture", revision: 7 },
  });
  await workbook.xlsx.writeFile(file);
  const result = await prepareCanonicalWorkbookUpdate({
    file,
    excelState: { running: false, ambiguous: false, workbooks: [], titles: [] },
    allowWorkbookReadFallback: true,
    readWorkbook: async () => { throw Object.assign(new Error("grid bridge failed"), { code: "EXCEL_WORKBOOK_READ_FAILED" }); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.resetReadFallback, true);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test("cloud reset keeps failing closed for invalid workbook bytes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-reset-read-invalid-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  fs.writeFileSync(file, "not an xlsx archive");
  const result = await prepareCanonicalWorkbookUpdate({
    file,
    excelState: { running: false, ambiguous: false, workbooks: [], titles: [] },
    allowWorkbookReadFallback: true,
    readWorkbook: async () => { throw new Error("grid bridge failed"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "EXCEL_WORKBOOK_STRUCTURE_INVALID");
});

test("preflight blocks an open same-name copy outside the canonical folder", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-copy-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  fs.writeFileSync(file, "workbook");
  const result = await prepareCanonicalWorkbookUpdate({
    file,
    excelState: {
      running: true,
      ambiguous: false,
      workbooks: [{
        name: "TEK-STOCK-LIVE.xlsx",
        fullName: "C:\\Users\\Edwin\\Downloads\\TEK-STOCK-LIVE.xlsx",
      }],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "EXCEL_WRONG_COPY_OPEN");
  assert.equal(result.path, file);
});

test("preflight reads a workbook whose spreadsheet XML uses a namespace prefix", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-prefixed-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  const workbook = await buildWorkbook({
    items: [{ id: "excel-5555-test-id", category: "测试", model: "5555", specification: "namespace fixture" }],
    sync: { workbookId: "wb-prefixed-fixture", revision: 1 },
  });
  await workbook.xlsx.writeFile(file);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !name.toLowerCase().endsWith(".xml")) continue;
    const xml = await entry.async("string");
    if (!xml.includes("xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"")) continue;
    zip.file(name, xml
      .replace(/xmlns="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/, "xmlns:x=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"")
      .replace(/<([A-Za-z_][\w.-]*)(?=[\s>])/g, "<x:$1")
      .replace(/<\/([A-Za-z_][\w.-]*)>/g, "</x:$1>"));
  }
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));

  const result = await prepareCanonicalWorkbookUpdate({
    file,
    excelState: { running: false, ambiguous: false, workbooks: [], titles: [] },
  });
  assert.equal(result.ok, true);
  assert.equal(result.items[0].model, "5555");
});
