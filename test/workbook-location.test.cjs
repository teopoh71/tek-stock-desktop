"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createWorkbookLocation } = require("../workbook-location.cjs");

function fixture(t, installation, clientId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tek-workbook-location-${installation}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createWorkbookLocation({
    userDataPath: path.join(root, "user-data"),
    localAppDataPath: path.join(root, "local-app-data"),
    documentsPath: path.join(root, "documents"),
    randomUUID: () => clientId,
  });
}

test("three installations never resolve to the same workbook or client identity", (t) => {
  const first = fixture(t, "pc-a", "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");
  const second = fixture(t, "pc-b", "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e");
  const third = fixture(t, "pc-c", "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f");
  assert.equal(new Set([first.clientId, second.clientId, third.clientId]).size, 3);
  assert.equal(new Set([
    first.privateWorkbookPath, second.privateWorkbookPath, third.privateWorkbookPath,
  ]).size, 3);
  assert.match(first.privateWorkbookPath, /workbooks[\\/]a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d[\\/]TEK-STOCK-LIVE\.xlsx$/);
});

test("legacy shared workbook is reported but never moved or deleted", (t) => {
  const location = fixture(t, "pc-a", "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");
  fs.mkdirSync(path.dirname(location.legacyWorkbookPath), { recursive: true });
  fs.writeFileSync(location.legacyWorkbookPath, "legacy");
  location.ensureDirectories();
  assert.equal(fs.readFileSync(location.legacyWorkbookPath, "utf8"), "legacy");
  assert.equal(fs.existsSync(location.privateWorkbookPath), false);
});

test("an existing invalid client ID is rejected instead of changing installations", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-workbook-location-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, "user-data");
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(path.join(userDataPath, "workbook-client.json"), JSON.stringify({ clientId: "client-new" }));

  assert.throws(() => createWorkbookLocation({
    userDataPath,
    localAppDataPath: path.join(root, "local-app-data"),
    documentsPath: path.join(root, "documents"),
    randomUUID: () => "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  }), /INVALID_WORKBOOK_CLIENT_ID/);
});
