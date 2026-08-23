"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ensurePrivateWorkbook } = require("../private-workbook-bootstrap.cjs");

function bootstrapFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-private-workbook-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyPath = path.join(root, "Documents", "TEK STOCK", "TEK-STOCK-LIVE.xlsx");
  const privatePath = path.join(root, "Local", "TEK STOCK", "workbooks", "client", "TEK-STOCK-LIVE.xlsx");
  if (options.legacy) {
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, options.legacy);
  }
  const cloudRevision = Number(options.cloudRevision || 184);
  const snapshot = {
    cloudState: options.cloudState === undefined ? "live" : options.cloudState,
    revision: cloudRevision,
    updatedAt: "2026-08-05T00:00:00.000Z",
    items: [{ id: "item-1", model: "TEK-1" }],
  };
  if (options.missingCloudState) delete snapshot.cloudState;
  const readWorkbook = async (file) => {
    if (options.throwRead && file === privatePath) throw new Error("PARSER_FAILURE");
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      return { ok: true, sync: { revision: saved.revision } };
    } catch {
      return { ok: false };
    }
  };
  const writeWorkbook = async (file, received) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ revision: received.revision }));
    if (options.concurrentWinner) {
      fs.writeFileSync(privatePath, JSON.stringify({ revision: options.concurrentWinner }));
    }
  };
  const location = {
    legacyWorkbookPath: legacyPath,
    privateWorkbookPath: privatePath,
    ensureDirectories: () => fs.mkdirSync(path.dirname(privatePath), { recursive: true }),
  };
  return {
    legacyPath,
    privatePath,
    readPrivate: () => readWorkbook(privatePath),
    ensure: () => ensurePrivateWorkbook({
      location,
      fetchSnapshot: async () => {
        if (options.offline) throw new Error("OFFLINE");
        return snapshot;
      },
      writeWorkbook,
      readWorkbook,
      now: () => new Date("2026-08-05T00:00:00.000Z"),
    }),
  };
}

test("first launch creates the private workbook from cloud and preserves legacy bytes", async (t) => {
  const legacy = Buffer.from("legacy-master-backup");
  const fixture = bootstrapFixture(t, { legacy, cloudRevision: 184 });
  const result = await fixture.ensure();
  assert.equal(result.state, "bootstrapped");
  assert.deepEqual(fs.readFileSync(fixture.legacyPath), legacy);
  assert.equal((await fixture.readPrivate()).sync.revision, 184);
});

test("offline first launch does not copy a possibly divergent shared workbook", async (t) => {
  const fixture = bootstrapFixture(t, { legacy: Buffer.from("legacy"), offline: true });
  const result = await fixture.ensure();
  assert.equal(result.state, "offline-not-initialized");
  assert.equal(fs.existsSync(fixture.privatePath), false);
});

test("an invalid existing private workbook is never replaced", async (t) => {
  const fixture = bootstrapFixture(t, { cloudRevision: 184 });
  fs.mkdirSync(path.dirname(fixture.privatePath), { recursive: true });
  fs.writeFileSync(fixture.privatePath, "not-a-workbook");
  const result = await fixture.ensure();
  assert.equal(result.state, "invalid-private-workbook");
  assert.equal(fs.readFileSync(fixture.privatePath, "utf8"), "not-a-workbook");
});

test("a parser exception for an existing private workbook leaves its bytes intact", async (t) => {
  const fixture = bootstrapFixture(t, { throwRead: true });
  fs.mkdirSync(path.dirname(fixture.privatePath), { recursive: true });
  fs.writeFileSync(fixture.privatePath, "unparseable-private-bytes");
  const result = await fixture.ensure();
  assert.equal(result.state, "invalid-private-workbook");
  assert.equal(fs.readFileSync(fixture.privatePath, "utf8"), "unparseable-private-bytes");
});

test("a cached cloud snapshot cannot initialize a private workbook", async (t) => {
  const fixture = bootstrapFixture(t, { cloudState: "cached" });
  const result = await fixture.ensure();
  assert.equal(result.state, "offline-not-initialized");
  assert.equal(fs.existsSync(fixture.privatePath), false);
});

test("a snapshot without an explicit live state cannot initialize a private workbook", async (t) => {
  const fixture = bootstrapFixture(t, { missingCloudState: true });
  const result = await fixture.ensure();
  assert.equal(result.state, "offline-not-initialized");
  assert.equal(fs.existsSync(fixture.privatePath), false);
});

test("a concurrent private-workbook winner is read instead of overwritten", async (t) => {
  const fixture = bootstrapFixture(t, { cloudRevision: 184, concurrentWinner: 185 });
  const result = await fixture.ensure();
  assert.equal(result.state, "ready");
  assert.equal(result.cloudRevision, 185);
  assert.equal((await fixture.readPrivate()).sync.revision, 185);
});
