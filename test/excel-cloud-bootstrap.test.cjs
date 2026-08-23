"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createPrivateWorkbookBootstrap,
  registerPrivateWorkbookBootstrapIpc,
} = require("../private-workbook-bootstrap-main.cjs");
const { ensurePrivateWorkbook } = require("../private-workbook-bootstrap.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-main-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workbookPath = path.join(root, "private", "TEK-STOCK-LIVE.xlsx");
  const snapshot = {
    cloudState: "live",
    revision: 184,
    updatedAt: "2026-08-05T00:00:00.000Z",
    items: [{ id: "item-1", model: "TEK-1" }],
  };
  const snapshotCalls = [];
  const writtenSnapshots = [];
  const location = {
    privateWorkbookPath: workbookPath,
    legacyWorkbookPath: path.join(root, "legacy.xlsx"),
    ensureDirectories: () => fs.mkdirSync(path.dirname(workbookPath), { recursive: true }),
  };
  const bootstrap = createPrivateWorkbookBootstrap({
    ensurePrivateWorkbook,
    workbookLocation: () => location,
    centralSyncService: () => ({
      snapshot: async (allowCache) => {
        snapshotCalls.push(allowCache);
        return snapshot;
      },
    }),
    writeWorkbook: async (file, received) => {
      writtenSnapshots.push(received);
      fs.writeFileSync(file, JSON.stringify({ revision: received.revision }));
    },
    readWorkbook: async (file) => ({
      ok: true,
      sync: JSON.parse(fs.readFileSync(file, "utf8")),
    }),
    watchWorkbook: () => {},
    now: () => new Date("2026-08-05T00:00:00.000Z"),
  });
  return { bootstrap, snapshot, snapshotCalls, writtenSnapshots };
}

test("main bootstrap handler uses a live no-cache snapshot without a token", async (t) => {
  const subject = fixture(t);
  const result = await subject.bootstrap();
  assert.equal(result.state, "bootstrapped");
  assert.deepEqual(subject.snapshotCalls, [false]);
  assert.deepEqual(subject.writtenSnapshots, [subject.snapshot]);
});

test("both main Excel bootstrap handlers return the real bootstrap result", async (t) => {
  const subject = fixture(t);
  const handlers = new Map();
  registerPrivateWorkbookBootstrapIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
  }, subject.bootstrap);

  const bootstrap = await handlers.get("tek-stock-excel-bootstrap")();
  const ensure = await handlers.get("tek-stock-excel-ensure")();
  assert.equal(bootstrap.state, "bootstrapped");
  assert.equal(bootstrap.created, true);
  assert.equal(ensure.state, "ready");
  assert.equal(ensure.created, false);
});
