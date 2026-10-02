"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { validateSyncToken } = require("../sync-token-validation.cjs");
const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.cjs"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "..", "inventory", "app.js"), "utf8");

function storeHarness() {
  const writes = [], encrypted = [];
  const start = mainSource.indexOf("function storeUploadToken(");
  const end = mainSource.indexOf("function clearStoredUploadToken(", start);
  assert.ok(start >= 0 && end > start);
  const store = Function("safeStorage", "credentialsPath", "fs", "path", "validateSyncToken",
    `return (${mainSource.slice(start, end).trim()});`)(
    { isEncryptionAvailable: () => true, encryptString: value => {
      encrypted.push(value); return Buffer.from("synthetic-encrypted-value");
    } },
    () => path.join("isolated-profile", "sync-credentials.json"),
    { mkdirSync() {}, writeFileSync: (...args) => writes.push(args) }, path, validateSyncToken,
  );
  return { store, writes, encrypted };
}

test("invalid saved keys cannot replace the existing credential or reach encryption", () => {
  for (const token of ["synthetic\u4e2d", "synthetic\r\n", "\nsynthetic", "synthetic\u0000"]) {
    const { store, writes, encrypted } = storeHarness();
    const result = store(token);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "SYNC_TOKEN_INVALID");
    assert.deepEqual(writes, []);
    assert.deepEqual(encrypted, []);
    assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test("ordinary valid keys still encrypt and save with safe whitespace trimming", () => {
  const { store, writes, encrypted } = storeHarness();
  assert.equal(store("  synthetic-token_123  ").ok, true);
  assert.deepEqual(encrypted, ["synthetic-token_123"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].includes("synthetic-token_123"), false);
});

test("credential dialog preserves raw input so the main boundary can reject unsafe trailing characters", async () => {
  const start = appSource.indexOf("function requestDesktopUploadToken(");
  const end = appSource.indexOf("async function ensureDesktopUploadToken(", start);
  assert.ok(start >= 0 && end > start);
  let close;
  const input = { value: "", focus() {} };
  const dialog = { returnValue: "", showModal() {}, addEventListener: (_name, fn) => { close = fn; } };
  const request = Function("document", "setTimeout", `return (${appSource.slice(start, end).trim()});`)(
    { getElementById: id => id === "syncTokenInput" ? input : dialog }, fn => fn(),
  );
  const pending = request();
  input.value = "synthetic-token\r\n";
  dialog.returnValue = "confirm";
  close();
  assert.equal(await pending, "synthetic-token\r\n");
  assert.equal(input.value, "");
});

test("reconnect passes raw input to the save boundary and does not replace runtime credentials on rejection", async () => {
  const start = appSource.indexOf("async function ensureDesktopUploadToken(");
  const end = appSource.indexOf("function isUploadTokenRejection(", start);
  assert.ok(start >= 0 && end > start);
  const remoteConfig = { uploadToken: "previous-synthetic-token" }, saved = [];
  const ensure = Function("window", "remoteConfig", "requestDesktopUploadToken", "toast", "console",
    `let rejectedUploadToken = ""; return (${appSource.slice(start, end).trim()});`)(
    { TekStockRuntime: { saveUploadToken: async token => {
      saved.push(token); return { ok: false, errorCode: "SYNC_TOKEN_INVALID", error: "Invalid key" };
    } } }, remoteConfig, async () => "synthetic-token\r\n", () => {}, { error() {} },
  );
  assert.equal(await ensure({ forcePrompt: true }), false);
  assert.deepEqual(saved, ["synthetic-token\r\n"]);
  assert.equal(remoteConfig.uploadToken, "previous-synthetic-token");
});
