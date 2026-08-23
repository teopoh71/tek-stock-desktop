"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  readUpdateReceipt,
  sanitizeUpdateReceipt,
  updateReceiptPath,
  writeUpdateReceipt,
} = require("../update-receipt.cjs");

test("update receipt records a successful check without installer side effects", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-update-receipt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = writeUpdateReceipt(root, {
    action: "check",
    checkRan: true,
    currentVersion: "1.5.52",
    availableVersion: "1.5.53",
    newerVersionFound: true,
    installerFound: true,
    downloadOutcome: "not_requested",
    launchOutcome: "not_requested",
    channel: "windows10",
    manifestSource: "singapore",
  }, { now: new Date("2026-08-04T01:02:03.000Z") });
  assert.equal(result.path, updateReceiptPath(root));
  assert.deepEqual(readUpdateReceipt(root), result);
  assert.equal(result.downloadOutcome, "not_requested");
  assert.equal(result.launchOutcome, "not_requested");
});

test("update receipt keeps concrete safe errors and removes suspicious text", () => {
  const safe = sanitizeUpdateReceipt({
    action: "check",
    checkRan: true,
    currentVersion: "1.5.52",
    errorCode: "UPDATE_NETWORK_TIMEOUT",
  }, new Date("2026-08-04T01:02:03.000Z"));
  assert.equal(safe.errorCode, "UPDATE_NETWORK_TIMEOUT");
  const suspicious = sanitizeUpdateReceipt({
    errorCode: "HTTP_401 token=do-not-store",
    availableVersion: "not a version",
    manifestSource: "https://user:password@example.test/private",
  });
  assert.equal(suspicious.errorCode, "UPDATE_FAILED");
  assert.equal(suspicious.availableVersion, "");
  assert.equal(JSON.stringify(suspicious).includes("do-not-store"), false);
  assert.equal(JSON.stringify(suspicious).includes("password"), false);
});

test("update receipt preserves the automatic user update action", () => {
  const receipt = sanitizeUpdateReceipt({
    action: "user_update",
    checkRan: true,
    currentVersion: "1.5.58",
    availableVersion: "1.5.59",
    newerVersionFound: true,
    installerFound: true,
    downloadOutcome: "verified",
    launchOutcome: "queued",
  }, new Date("2026-08-05T00:00:00.000Z"));
  assert.equal(receipt.action, "user_update");
  assert.equal(receipt.downloadOutcome, "verified");
  assert.equal(receipt.launchOutcome, "queued");
});
