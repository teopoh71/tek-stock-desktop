"use strict";

// One-time, guarded migration tool.  It never runs unless --apply is supplied.
// The source workbook is left untouched; the current cloud snapshot is saved first.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

process.env.TEK_STOCK_TEST = "1";
const { readWorkbookFile } = require("../main.cjs");
const { buildWorkbookDelta } = require("../inventory/excel-delta-core.js");
const { createCentralSync } = require("../central-sync.cjs");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MASTER = path.resolve(ROOT,
  "..", "..", "outputs", "verification", "TEK-STOCK-LIVE-before-roundtrip.xlsx");
const AUDIT_ROOT = path.join(ROOT, "outputs", "authoritative-master-migration");
const ITEM_FIELDS = new Set([
  "id", "model", "category", "stock", "stockText", "showroomQuantity",
  "computedTotalSold", "totalSold", "cost", "sellingPrice", "sellingPriceText",
  "specification", "arrival", "showroom", "outbound", "sourceFile",
  "sourceSheet", "sourceRow", "image", "imageSha256", "imageVersion",
]);

function usage() {
  console.error("Usage: node scripts/seed-authoritative-master.cjs [--master <xlsx>] --apply [--photos]");
  process.exit(2);
}

function cleanItem(source) {
  const item = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (ITEM_FIELDS.has(key) && value !== undefined) item[key] = value;
  }
  item.id = String(item.id || "").trim();
  if (!item.id) throw new Error("MASTER_PERMANENT_ID_MISSING");
  return item;
}

function writeAudit(name, value) {
  fs.mkdirSync(AUDIT_ROOT, { recursive: true, mode: 0o700 });
  const target = path.join(AUDIT_ROOT, name);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

function config() {
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, "inventory", "alibaba-cloud.json"), "utf8"));
  return {
    primary: String(source.apiBaseUrl || "").replace(/\/$/, ""),
    authorityId: String(source.authorityId || ""),
    ossPublicBaseUrl: String(source.ossPublicBaseUrl || ""),
  };
}

async function request(url, authorityId, init = {}) {
  const token = String(process.env.TEK_STOCK_UPLOAD_TOKEN || "").trim();
  if (!token) throw new Error("SYNC_TOKEN_MISSING");
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "x-tek-stock-authority-id": authorityId,
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.code || `HTTP_${response.status}`);
    error.status = response.status;
    error.currentRevision = body.currentRevision;
    throw error;
  }
  return body;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const photos = args.includes("--photos");
  const masterIndex = args.indexOf("--master");
  const masterPath = masterIndex >= 0 ? path.resolve(args[masterIndex + 1] || "") : DEFAULT_MASTER;
  if (!fs.existsSync(masterPath) || (masterIndex >= 0 && !args[masterIndex + 1])) usage();

  const master = await readWorkbookFile(masterPath);
  if (!master?.ok || master.items.length !== 324) throw new Error("MASTER_WORKBOOK_INVALID");
  const ids = new Set(master.items.map((item) => String(item.id || "").trim()));
  if (ids.size !== master.items.length || ids.has("")) throw new Error("MASTER_PERMANENT_IDS_INVALID");
  const cloud = config();
  const live = await request(`${cloud.primary}/v1/snapshot`, cloud.authorityId, { method: "GET" });
  const delta = buildWorkbookDelta({ baselineRecords: live.items, currentRows: master.items });
  if (!delta.ok) throw new Error("MASTER_DELTA_CONFLICT");

  const byId = new Map(live.items.map((item) => [String(item.id || ""), item]));
  const operations = [];
  for (const operation of delta.operations) {
    if (operation.type === "delete") {
      operations.push({ type: "delete", itemId: String(operation.itemId || "") });
      continue;
    }
    const patch = { ...(operation.patch || {}) };
    delete patch.image; // Images are committed only through the verified OSS photo flow below.
    if (operation.type === "update" && !Object.keys(patch).length) continue;
    const source = operation.type === "create" ? operation.item : { ...byId.get(operation.itemId), ...patch };
    operations.push({ type: "upsert", item: cleanItem({ ...source, image: byId.get(operation.itemId)?.image || "" }) });
  }
  const summary = {
    masterItems: master.items.length,
    cloudRevision: Number(live.revision),
    cloudItems: live.items.length,
    dataOperations: operations.length,
    photoUploads: master.items.filter((item) => /^data:image\//i.test(item.embeddedImageDataUrl || "")).length,
    apply,
    photos,
  };
  if (!apply) {
    console.log(JSON.stringify(summary));
    return;
  }

  writeAudit(`cloud-before-r${live.revision}.json`, live);
  const idempotencyKey = `master-${crypto.randomUUID()}`;
  const committed = await request(`${cloud.primary}/v1/items/batch`, cloud.authorityId, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey,
      "x-tek-stock-operator": "authoritative-master-migration" },
    body: JSON.stringify({ expectedRevision: Number(live.revision), operations }),
  });
  const afterData = await request(`${cloud.primary}/v1/snapshot`, cloud.authorityId, { method: "GET" });
  if (afterData.items.length !== master.items.length
      || master.items.some((item) => !afterData.items.some((liveItem) => liveItem.id === item.id))) {
    throw new Error("MASTER_DATA_VERIFICATION_FAILED");
  }
  let uploadedPhotos = 0;
  if (photos) {
    const service = createCentralSync({
      root: path.join(AUDIT_ROOT, "photo-outbox"),
      getToken: () => process.env.TEK_STOCK_UPLOAD_TOKEN || "",
      getApiBaseUrl: () => cloud.primary,
      getApiFallbackBaseUrls: () => [],
      getAuthorityId: () => cloud.authorityId,
      getOssBaseUrl: () => cloud.ossPublicBaseUrl,
    });
    for (const item of master.items) {
      if (!/^data:image\//i.test(item.embeddedImageDataUrl || "")) continue;
      await service.replacePhoto(item.id, item.embeddedImageDataUrl);
      uploadedPhotos += 1;
    }
  }
  const verified = await request(`${cloud.primary}/v1/snapshot`, cloud.authorityId, { method: "GET" });
  if (verified.items.length !== master.items.length) throw new Error("MASTER_COUNT_CHANGED_DURING_MIGRATION");
  writeAudit(`migration-result-r${verified.revision}.json`, {
    ...summary, committedRevision: committed.revision, verifiedRevision: verified.revision, uploadedPhotos,
  });
  console.log(JSON.stringify({ ...summary, committedRevision: committed.revision,
    verifiedRevision: verified.revision, uploadedPhotos }));
}

main().catch((error) => {
  console.error(error.code || error.message || "MIGRATION_FAILED");
  process.exit(1);
});
