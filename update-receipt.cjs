"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RECEIPT_NAME = "update-receipt-latest.json";
const OUTCOMES = new Set(["not_requested", "started", "verified", "queued", "failed"]);

function safeCode(value, fallback = "") {
  const text = String(value || "").normalize("NFKC")
    .replace(/[^a-z0-9._:-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return text || fallback;
}

function safeVersion(value) {
  const text = String(value || "").trim();
  return /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(text) ? text.slice(0, 40) : "";
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = safeVersion(value).match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function safeErrorCode(value) {
  const raw = String(value || "");
  if (/token|secret|password|authorization|cookie|email|phone/i.test(raw)) return "UPDATE_FAILED";
  return safeCode(raw);
}

function sanitizeUpdateReceipt(input = {}, now) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const supplied = now instanceof Date ? now : new Date(String(value.timestamp || ""));
  const timestamp = Number.isFinite(supplied.getTime()) ? supplied : new Date();
  const outcome = (name) => OUTCOMES.has(value[name]) ? value[name] : "not_requested";
  const channel = ["windows7", "windows10"].includes(value.channel) ? value.channel : "";
  const source = ["hangzhou", "singapore", "other", "unknown"].includes(value.manifestSource)
    ? value.manifestSource : "";
  const currentVersion = safeVersion(value.currentVersion);
  let availableVersion = safeVersion(value.availableVersion);
  const newerVersionFound = typeof value.newerVersionFound === "boolean"
    ? value.newerVersionFound : null;
  if (newerVersionFound === false
      && currentVersion
      && availableVersion
      && compareVersions(availableVersion, currentVersion) < 0) {
    availableVersion = currentVersion;
  }
  return {
    schemaVersion: 1,
    timestamp: timestamp.toISOString(),
    action: ["check", "user_update", "user_reinstall"].includes(value.action) ? value.action : "check",
    checkRan: value.checkRan === true,
    currentVersion,
    availableVersion,
    newerVersionFound,
    installerFound: value.installerFound === true,
    downloadOutcome: outcome("downloadOutcome"),
    launchOutcome: outcome("launchOutcome"),
    channel,
    manifestSource: source,
    errorCode: safeErrorCode(value.errorCode),
  };
}

function updateReceiptPath(userDataPath) {
  return path.join(path.resolve(userDataPath), RECEIPT_NAME);
}

function writeUpdateReceipt(userDataPath, input, options = {}) {
  const root = path.resolve(String(userDataPath || ""));
  if (!root) throw Object.assign(new Error("UPDATE_RECEIPT_PATH_INVALID"), { code: "UPDATE_RECEIPT_PATH_INVALID" });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = updateReceiptPath(root);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw Object.assign(new Error("UPDATE_RECEIPT_PATH_INVALID"), { code: "UPDATE_RECEIPT_PATH_INVALID" });
  }
  const receipt = sanitizeUpdateReceipt(input, options.now);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  return { ...receipt, path: target };
}

function readUpdateReceipt(userDataPath) {
  const target = updateReceiptPath(userDataPath);
  if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) return null;
  try {
    return { ...sanitizeUpdateReceipt(JSON.parse(fs.readFileSync(target, "utf8"))), path: target };
  } catch {
    return null;
  }
}

module.exports = { readUpdateReceipt, sanitizeUpdateReceipt, updateReceiptPath, writeUpdateReceipt };
