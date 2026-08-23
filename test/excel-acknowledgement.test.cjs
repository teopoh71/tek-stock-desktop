"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ExcelJS = require("exceljs");

const {
  acknowledgeWorkbookFile,
  assignWorkbookPermanentIds,
  buildWorkbook,
  mapWithConcurrency,
  readWorkbookFile,
  stableFileSnapshot,
} = require("../main.cjs");
const { normalizeExcelRows } = require("../inventory/excel-sync-core.js");

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6sWQAAAAASUVORK5CYII=",
  "base64",
);

async function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-ack-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("库存总表", {
    views: [{ state: "frozen", ySplit: 4 }],
  });
  sheet.addRow(["TEK STOCK"]);
  sheet.addRow(["Before acknowledgement"]);
  sheet.addRow([]);
  sheet.addRow([
    "照片", "Item ID", "分类", "型号", "目前库存", "展厅数量", "累计已售",
    "成本", "售价", "规格", "来货记录", "Showroom", "Outbound", "Manual Sold", "Image Hash",
  ]);
  sheet.addRow([
    "", "existing-id", "餐椅", "EXISTING", 4, 0, 0, 10, 20, "", "", "", "", 0, "",
  ]);
  const testRow = sheet.addRow([
    "", "", "测试", "1234567", 1, 0, 0, 123, 246,
    "CODEX TEMP PHOTO SYNC TEST - DELETE AFTER VERIFICATION", "", "", "", 0, "",
  ]);
  testRow.height = 82;
  testRow.getCell(4).font = { bold: true, color: { argb: "FF154F4C" } };
  testRow.getCell(5).numFmt = "0";
  testRow.getCell(5).dataValidation = {
    type: "whole",
    operator: "between",
    formulae: [-9999, 999999],
  };
  const imageId = workbook.addImage({ buffer: onePixelPng, extension: "png" });
  sheet.addImage(imageId, {
    tl: { col: 0.08, row: 5.08 },
    ext: { width: 112, height: 76 },
    editAs: "oneCell",
  });
  const meta = workbook.addWorksheet("_TEK_META", { state: "veryHidden" });
  meta.addRow(["schema", "tek-stock-live-v1"]);
  meta.addRow(["writtenAt", "2026-07-29T00:00:00.000Z"]);
  meta.addRow(["itemCount", 1]);
  meta.addRow(["revision", 46]);
  meta.addRow(["updatedAt", "2026-07-29T00:00:00.000Z"]);
  meta.addRow(["imageSetVersion", "test"]);
  await workbook.xlsx.writeFile(file);
  return { directory, file };
}

test("acknowledgement fills the generated ID and exact embedded image hash", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  await assignWorkbookPermanentIds(fixture.file, [{
    sourceRow: 6,
    id: "excel-1234567-test-id",
  }], stableFileSnapshot(fixture.file).sha256);

  const result = await acknowledgeWorkbookFile(fixture.file, {
    items: [
      {
        id: "existing-id",
        category: "餐椅",
        model: "EXISTING",
        specification: "",
        sourceRow: 5,
      },
      {
        id: "excel-1234567-test-id",
        category: "测试",
        model: "1234567",
        specification: "CODEX TEMP PHOTO SYNC TEST - DELETE AFTER VERIFICATION",
        sourceRow: 6,
      },
    ],
    ackPlan: {
      rows: [{
        sourceRow: 6,
        originalId: "",
        assignedId: "excel-1234567-test-id",
        model: "1234567",
        specification: "CODEX TEMP PHOTO SYNC TEST - DELETE AFTER VERIFICATION",
        uploadedImageHash: createHash("sha256").update(onePixelPng).digest("hex"),
      }],
    },
    sync: {
      revision: 50,
      updatedAt: "2026-07-29T05:12:44.826Z",
      imageSetVersion: "test-v2",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.acknowledged, 1);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fixture.file);
  const sheet = workbook.getWorksheet("库存总表");
  const meta = workbook.getWorksheet("_TEK_META");
  assert.equal(sheet.rowCount, 6);
  assert.equal(sheet.getRow(6).getCell(2).text, "excel-1234567-test-id");
  assert.equal(
    sheet.getRow(6).getCell(15).text,
    createHash("sha256").update(onePixelPng).digest("hex"),
  );
  assert.equal(sheet.getRow(6).height, 82);
  assert.equal(sheet.getRow(6).getCell(4).font.bold, true);
  assert.equal(sheet.getRow(6).getCell(5).numFmt, "0");
  assert.equal(sheet.getRow(6).getCell(5).dataValidation.type, "whole");
  assert.equal(sheet.getImages().length, 1);
  assert.equal(workbook.getImage(sheet.getImages()[0].imageId).buffer.length, onePixelPng.length);
  assert.equal(meta.state, "veryHidden");

  const metaValues = Object.fromEntries(
    Array.from({ length: meta.rowCount }, (_, index) => {
      const row = meta.getRow(index + 1);
      return [row.getCell(1).text, row.getCell(2).value];
    }),
  );
  assert.equal(metaValues.itemCount, 2);
  assert.equal(metaValues.revision, 50);
  assert.equal(metaValues.updatedAt, "2026-07-29T05:12:44.826Z");
  assert.equal(metaValues.imageSetVersion, "test-v2");
});

test("locked-workbook acknowledgement permits an existing row identity", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.directory, "~$TEK-STOCK-LIVE.xlsx"), "locked");
  let observedMutation;

  const result = await acknowledgeWorkbookFile(fixture.file, {
    items: [{
      id: "existing-id",
      category: "Chair",
      model: "REPLACED",
      sourceRow: 5,
    }],
    ackPlan: {
      rows: [{
        sourceRow: 5,
        originalId: "existing-id",
        assignedId: "existing-id",
        model: "REPLACED",
        uploadedImageHash: "",
      }],
    },
    sync: { revision: 52, updatedAt: "2026-08-17T00:00:00.000Z" },
  }, {
    applyOpenWorkbookMutation: async (_file, mutation) => {
      observedMutation = mutation;
      return { ok: true };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(observedMutation.idCells, [{
    rowNumber: 5,
    id: "existing-id",
    expectedId: "existing-id",
  }]);
});

test("ID assignment safely repairs only a duplicated hidden ID", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fixture.file);
  workbook.worksheets[0].getRow(6).getCell(2).value = "existing-id";
  await workbook.xlsx.writeFile(fixture.file);

  await assignWorkbookPermanentIds(fixture.file, [{
    sourceRow: 6,
    expectedId: "existing-id",
    id: "new-copied-row-id",
  }], stableFileSnapshot(fixture.file).sha256);

  const after = await readWorkbookFile(fixture.file);
  assert.deepEqual(after.rawItems.map((row) => row.id), ["existing-id", "new-copied-row-id"]);
});

test("legacy migration preserves the row locator and rewrites the hidden baseline ID", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-legacy-migration-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacyId = "source::LEGACY-5555::5";
  const workbook = await buildWorkbook({
    items: [{ id: legacyId, model: "LEGACY-5555", category: "Chair", stock: 1 }],
    sync: { revision: 8, updatedAt: "2026-08-01T00:00:00.000Z" },
  });
  await workbook.xlsx.writeFile(file);
  const before = await readWorkbookFile(file);

  await assignWorkbookPermanentIds(file, [{
    sourceRow: 5,
    legacyId,
    id: "cloud-legacy-5555",
  }], before.sha256, {
    identity: {
      workbookId: "wb-legacy-migration",
      schemaVersion: "tek-stock-live-v2",
      migrationVersion: 2,
      migrationPlanToken: "plan-legacy-migration",
    },
  });

  const after = await readWorkbookFile(file);
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].id, "cloud-legacy-5555");
  assert.equal(after.items[0].sourceRow, 5);
  assert.deepEqual(after.baseline.records.map((record) => record.id), ["cloud-legacy-5555"]);
  assert.equal(after.sync.workbookId, "wb-legacy-migration");
  assert.equal(after.sync.schemaVersion, "tek-stock-live-v2");
  assert.equal(after.sync.migrationVersion, 2);
  assert.equal(after.sync.migrationPlanToken, "plan-legacy-migration");
});

test("acknowledgement binds a new blank-ID model by its exact source row", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fixture.file);
  workbook.getWorksheet("库存总表").getRow(6).getCell(4).value = "5555";
  await workbook.xlsx.writeFile(fixture.file);

  const result = await acknowledgeWorkbookFile(fixture.file, {
    items: [{
      id: "excel-5555-test-id",
      category: "测试",
      model: "5555",
      specification: "CODEX TEMP PHOTO SYNC TEST - DELETE AFTER VERIFICATION",
      sourceRow: 6,
    }],
    ackPlan: {
      rows: [{
        sourceRow: 6,
        originalId: "",
        assignedId: "excel-5555-test-id",
        category: "测试",
        model: "5555",
        specification: "CODEX TEMP PHOTO SYNC TEST - DELETE AFTER VERIFICATION",
        uploadedImageHash: "",
      }],
    },
    sync: {
      revision: 50,
      updatedAt: "2026-07-29T05:12:44.826Z",
      imageSetVersion: "test-v2",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.acknowledged, 1);
  const verified = new ExcelJS.Workbook();
  await verified.xlsx.readFile(fixture.file);
  assert.equal(verified.getWorksheet("库存总表").getRow(6).getCell(2).text, "excel-5555-test-id");
});

test("acknowledgement refuses to mark a photo that changed after upload", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  await assignWorkbookPermanentIds(fixture.file, [{
    sourceRow: 6,
    id: "excel-1234567-test-id",
  }], stableFileSnapshot(fixture.file).sha256);

  const result = await acknowledgeWorkbookFile(fixture.file, {
    items: [{
      id: "excel-1234567-test-id",
      model: "1234567",
      specification: "CODEX TEMP PHOTO SYNC TEST - DELETE AFTER VERIFICATION",
      sourceRow: 6,
    }],
    ackPlan: {
      rows: [{
        sourceRow: 6,
        originalId: "",
        assignedId: "excel-1234567-test-id",
        model: "1234567",
        specification: "CODEX TEMP PHOTO SYNC TEST - DELETE AFTER VERIFICATION",
        uploadedImageHash: "different-photo-hash",
      }],
    },
    sync: {
      revision: 50,
      updatedAt: "2026-07-29T05:12:44.826Z",
      imageSetVersion: "test-v2",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fixture.file);
  const sheet = workbook.getWorksheet("库存总表");
  const meta = workbook.getWorksheet("_TEK_META");
  assert.equal(sheet.getRow(6).getCell(2).text, "excel-1234567-test-id");
  assert.equal(sheet.getRow(6).getCell(15).text, "");
  assert.equal(Number(meta.getCell("B4").value), 46);
});

test("acknowledgement uses the permanent ID even when the sheet category is blank", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(fixture.file);
  const sheet = workbook.getWorksheet("库存总表");
  sheet.getRow(6).getCell(3).value = "";
  await workbook.xlsx.writeFile(fixture.file);
  await assignWorkbookPermanentIds(fixture.file, [{
    sourceRow: 6,
    id: "excel-1234567-default-category",
  }], stableFileSnapshot(fixture.file).sha256);
  const defaultCategory = normalizeExcelRows([{ model: "probe" }])[0].category;

  const result = await acknowledgeWorkbookFile(fixture.file, {
    items: [{
      id: "excel-1234567-default-category",
      category: defaultCategory,
      model: "1234567",
      specification: "CODEX TEMP PHOTO SYNC TEST - DELETE AFTER VERIFICATION",
      sourceRow: 6,
    }],
    ackPlan: {
      rows: [{
        sourceRow: 6,
        originalId: "",
        assignedId: "excel-1234567-default-category",
        category: defaultCategory,
        model: "1234567",
        specification: "CODEX TEMP PHOTO SYNC TEST - DELETE AFTER VERIFICATION",
        uploadedImageHash: "",
      }],
    },
    sync: {
      revision: 50,
      updatedAt: "2026-07-29T05:12:44.826Z",
      imageSetVersion: "test-v2",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.acknowledged, 1);
  const verified = new ExcelJS.Workbook();
  await verified.xlsx.readFile(fixture.file);
  assert.equal(
    verified.getWorksheet("库存总表").getRow(6).getCell(2).text,
    "excel-1234567-default-category",
  );
});

test("bounded image work preserves input order and never exceeds the limit", async () => {
  let active = 0;
  let peak = 0;
  const values = [40, 5, 30, 10, 20, 1];
  const output = await mapWithConcurrency(values, 3, async (value, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return `${index}:${value}`;
  });

  assert.ok(peak <= 3);
  assert.deepEqual(output, values.map((value, index) => `${index}:${value}`));
});

test("hidden workbook baseline persists complete canonical sync identity", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-canonical-baseline-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  const canonical = {
    id: "canonical-chair",
    model: "CANONICAL",
    category: "Chair",
    stock: 7,
    stockText: "7 pcs",
    sellingPrice: 88,
    sellingPriceText: "S$88",
    sourceFile: "cloud-master.xlsx",
    sourceSheet: "Master",
    sourceRow: 41,
    image: "photos/canonical-chair/original.webp",
    imageSha256: "a".repeat(64),
    imageVersion: "sha256-aaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const workbook = await buildWorkbook({
    items: [canonical],
    sync: { revision: 12, updatedAt: "2026-08-06T00:00:00.000Z" },
  });
  await workbook.xlsx.writeFile(file);

  const read = await readWorkbookFile(file);
  assert.equal(read.ok, true);
  assert.deepEqual(read.baseline.records[0], {
    ...read.baseline.records[0],
    id: canonical.id,
    stockText: canonical.stockText,
    sellingPriceText: canonical.sellingPriceText,
    sourceFile: canonical.sourceFile,
    sourceSheet: canonical.sourceSheet,
    sourceRow: canonical.sourceRow,
    image: canonical.image,
    imageSha256: canonical.imageSha256,
    imageVersion: canonical.imageVersion,
  });
  assert.equal(read.baseline.records[0].imageSha256, canonical.imageSha256);
  assert.equal(read.baseline.records[0].imageVersion, canonical.imageVersion);
  assert.equal(read.baseline.records[0].sourceRow, 41);
});

test("workbook reader distinguishes unchanged numeric, cleared, and text-only selling prices", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-price-reader-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  const workbook = await buildWorkbook({
    items: [{
      id: "price-reader-chair",
      model: "PRICE-READER",
      category: "Chair",
      stock: 1,
      sellingPrice: 240,
      sellingPriceText: "S$ 240",
    }],
    sync: { revision: 1, updatedAt: "2026-08-14T00:00:00.000Z" },
  });
  await workbook.xlsx.writeFile(file);

  const numeric = await readWorkbookFile(file);
  assert.equal(numeric.items[0].sellingPrice, 240);
  assert.equal(Object.hasOwn(numeric.items[0], "sellingPriceText"), false);

  const edited = new ExcelJS.Workbook();
  await edited.xlsx.readFile(file);
  const inventory = edited.worksheets.find((sheet) => !sheet.name.startsWith("_"));
  inventory.getRow(5).getCell(9).value = "";
  await edited.xlsx.writeFile(file);
  const cleared = await readWorkbookFile(file);
  assert.equal(cleared.items[0].sellingPrice, null);
  assert.equal(Object.hasOwn(cleared.items[0], "sellingPriceText"), true);
  assert.equal(cleared.items[0].sellingPriceText, "");

  const textOnly = new ExcelJS.Workbook();
  await textOnly.xlsx.readFile(file);
  textOnly.worksheets.find((sheet) => !sheet.name.startsWith("_"))
    .getRow(5).getCell(9).value = "POA";
  await textOnly.xlsx.writeFile(file);
  const textPrice = await readWorkbookFile(file);
  assert.equal(textPrice.items[0].sellingPrice, null);
  assert.equal(textPrice.items[0].sellingPriceText, "POA");
});

test("acknowledgement replaces the hidden baseline instead of appending stale records", async (t) => {
  const fixture = await createFixture();
  t.after(() => fs.rmSync(fixture.directory, { recursive: true, force: true }));

  const first = new ExcelJS.Workbook();
  await first.xlsx.readFile(fixture.file);
  const stale = first.addWorksheet("_TEK_BASELINE", { state: "veryHidden" });
  stale.addRow(["id", "baseline"]);
  stale.addRow(["stale-remote-only", JSON.stringify({ id: "stale-remote-only", model: "7137" })]);
  await first.xlsx.writeFile(fixture.file);

  await acknowledgeWorkbookFile(fixture.file, {
    items: [{ id: "existing-id", category: "Chair", model: "EXISTING", sourceRow: 5 }],
    ackPlan: { expectedSha256: stableFileSnapshot(fixture.file).sha256, rows: [] },
    sync: { revision: 51, updatedAt: "2026-08-06T05:00:00.000Z", imageSetVersion: "test-v3" },
  });

  const verified = new ExcelJS.Workbook();
  await verified.xlsx.readFile(fixture.file);
  const baseline = verified.getWorksheet("_TEK_BASELINE");
  const ids = [];
  for (let rowNumber = 2; rowNumber <= baseline.rowCount; rowNumber += 1) {
    const id = String(baseline.getRow(rowNumber).getCell(1).text || "").trim();
    if (id) ids.push(id);
  }
  assert.deepEqual(ids, ["existing-id"]);
  assert.equal(baseline.state, "veryHidden");
});
