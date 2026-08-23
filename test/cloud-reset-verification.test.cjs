"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { verifyCloudResetLocal } = require("../main.cjs");

test("cloud reset verifies the exact replaced bytes without rereading Office or cloud", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-reset-verify-"));
  const file = path.join(directory, "TEK-STOCK-LIVE.xlsx");
  const bytes = Buffer.from("validated-cloud-workbook");
  fs.writeFileSync(file, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const live = { revision: 244, items: [{ id: "one" }] };
  assert.deepEqual(await verifyCloudResetLocal({
    live,
    replacement: { workbook: { sha256 } },
    workbookFile: file,
  }), { ok: true, revision: 244, itemCount: 1 });
  fs.writeFileSync(file, "different-local-bytes");
  assert.deepEqual(await verifyCloudResetLocal({
    live,
    replacement: { workbook: { sha256 } },
    workbookFile: file,
  }), { ok: false });
  fs.rmSync(directory, { recursive: true, force: true });
});
