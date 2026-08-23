"use strict";

const { createHash } = require("node:crypto");

const TEXT_FIELDS = ["category", "model", "specification", "arrival", "showroom", "outbound"];
const NUMBER_FIELDS = ["stock", "showroomQuantity", "computedTotalSold", "cost", "sellingPrice", "totalSold"];

function semanticNumber(value) {
  return value === "" || value == null || !Number.isFinite(Number(value))
    ? null
    : Number(value);
}

function semanticWorkbookItem(source = {}) {
  const item = { id: String(source.id || "").trim() };
  for (const field of TEXT_FIELDS) item[field] = String(source[field] || "");
  for (const field of NUMBER_FIELDS) item[field] = semanticNumber(source[field]);
  item.imageHash = Object.prototype.hasOwnProperty.call(source, "embeddedImageHash")
    ? String(source.embeddedImageHash || "").trim().toLowerCase()
    : String(source.imageHash || "").trim().toLowerCase();
  return item;
}

function workbookSemanticFingerprint(rows) {
  const records = (Array.isArray(rows) ? rows : [])
    .map((row) => JSON.stringify(semanticWorkbookItem(row)))
    .sort();
  return createHash("sha256")
    .update(`tek-stock-workbook-semantic-v1\n${records.join("\n")}`)
    .digest("hex");
}

function isWorkbookSemanticallyAcknowledged(workbook) {
  const current = String(workbook?.semanticFingerprint || "").trim().toLowerCase();
  const acknowledged = String(workbook?.acknowledgedSemanticFingerprint || "").trim().toLowerCase();
  return !!current && !!acknowledged && current === acknowledged;
}

module.exports = {
  isWorkbookSemanticallyAcknowledged,
  semanticWorkbookItem,
  workbookSemanticFingerprint,
};
