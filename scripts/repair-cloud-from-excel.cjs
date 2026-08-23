"use strict";

process.env.TEK_STOCK_TEST = "1";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { app, net, safeStorage } = require("electron");
const { readWorkbookFile } = require("../main.cjs");
const { isSafeRemotePayload } = require("../inventory/remote-payload-safety.js");

const workbookPath = path.join(process.env.USERPROFILE, "Documents", "TEK STOCK", "TEK-STOCK-LIVE.xlsx");
const credentialsPath = path.join(process.env.APPDATA, "samlee-inventory-desktop", "sync-credentials.json");
const dataUrl = "https://tek-stock-sync.teopoh72.workers.dev/data";
const uploadUrl = "https://tek-stock-sync.teopoh72.workers.dev/upload";
const imageUrl = "https://tek-stock-sync.teopoh72.workers.dev/image";
const commit = process.argv.includes("--commit");
const deleteTests = process.argv.includes("--delete-tests");
const repairPhotos = process.argv.includes("--repair-photos");
const testModels = new Set(["5555", "11111", "12345"]);

async function jsonFetch(url, options = {}) {
  const response = await net.fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}: ${body.error || "request failed"}`);
  return body;
}

function readToken() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable");
  const stored = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  return safeStorage.decryptString(Buffer.from(stored.uploadToken, "base64"));
}

function packagedItems() {
  const sandbox = { window: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "inventory", "inventory-data.js"), "utf8"),
    sandbox,
    { filename: "inventory/inventory-data.js" },
  );
  return Array.isArray(sandbox.window.INVENTORY_PAYLOAD?.items)
    ? sandbox.window.INVENTORY_PAYLOAD.items
    : [];
}

async function run() {
  const workbook = await readWorkbookFile(workbookPath);
  const normalizedIds = (workbook.items || []).map((item) => String(item.id || "").trim());
  if (!workbook.ok || normalizedIds.some((id) => !id)
      || new Set(normalizedIds).size !== normalizedIds.length) {
    throw new Error("Excel integrity check failed");
  }
  const remote = await jsonFetch(`${dataUrl}?repairAudit=${Date.now()}`, { cache: "no-store" });
  const remoteById = new Map(remote.items.map((item) => [String(item.id || "").trim(), item]));
  let items = workbook.items.map((item) => {
    const prior = remoteById.get(String(item.id || "").trim());
    return { ...item, image: item.image || prior?.image || "" };
  });
  const deletedModels = deleteTests
    ? items.filter((item) => testModels.has(String(item.model || "").trim())).map((item) => item.model)
    : [];
  if (deleteTests) items = items.filter((item) => !testModels.has(String(item.model || "").trim()));
  const packagedById = new Map(packagedItems().map((item) => [String(item.id || ""), item]));
  let photoRepairs = 0;
  let packagedPhotoMatches = 0;
  const unmatchedPhotoIds = [];
  if (repairPhotos) {
    items = items.map((item) => {
      const packaged = packagedById.get(String(item.id || ""));
      if (!packaged) {
        unmatchedPhotoIds.push(String(item.id || ""));
        return item;
      }
      const image = String(packaged?.image || "").trim();
      packagedPhotoMatches += 1;
      if (image !== item.image) photoRepairs += 1;
      return { ...item, image };
    });
  }
  const candidate = {
    app: "TEK STOCK",
    version: "1.5.0-cloud-sync",
    baseRevision: Number(remote.revision) || 0,
    imageSetVersion: String(remote.imageSetVersion || ""),
    items,
  };
  const dataImages = candidate.items.filter((item) => /^data:image\//i.test(item.image || ""));
  const missingImages = candidate.items.filter((item) => !item.image).length;
  if (!isSafeRemotePayload(candidate)) throw new Error("Clean Excel payload failed remote safety validation");
  console.log(JSON.stringify({
    mode: commit ? "commit" : "audit",
    cloudRevision: remote.revision,
    workbookRevision: workbook.sync.revision,
    itemCount: candidate.items.length,
    dataImages: dataImages.length,
    missingImages,
    deletedModels,
    packagedPhotoMatches,
    photoRepairs,
    unmatchedPhotoIds: unmatchedPhotoIds.slice(0, 20),
    unmatchedPhotoIdCount: unmatchedPhotoIds.length,
    testsPresent: candidate.items.filter((item) => ["123456", "8888", "2222"].includes(String(item.model).trim())).map((item) => item.model),
    safe: true,
  }));
  if (!commit) return;

  const token = readToken();
  for (const item of dataImages) {
    const result = await jsonFetch(imageUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-upload-token": token },
      body: JSON.stringify({ itemId: item.id, model: item.model, image: item.image }),
    });
    item.image = result.url;
  }
  const result = await jsonFetch(uploadUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-upload-token": token },
    body: JSON.stringify(candidate),
  });
  const verified = await jsonFetch(`${dataUrl}?repairVerify=${Date.now()}`, { cache: "no-store" });
  if (!isSafeRemotePayload(verified)
      || Number(verified.revision) !== Number(result.revision)
      || verified.items.length !== candidate.items.length) {
    throw new Error("Cloud verification failed after upload");
  }
  console.log(JSON.stringify({ committed: true, revision: verified.revision, itemCount: verified.items.length, safe: true }));
}

app.whenReady().then(() => run().then(
  () => app.exit(0),
  (error) => {
    console.error(error?.stack || error);
    app.exit(1);
  },
));
