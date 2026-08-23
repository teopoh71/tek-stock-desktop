"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");

const project = path.resolve(__dirname, "..");
const packageVersion = require(path.join(project, "package.json")).version;
const archive = path.join(project, "dist-update", "win-unpacked", "resources", "app.asar");
const installer = path.join(project, "dist-update", `TEK-STOCK-Update-${packageVersion}-x64.exe`);
const output = path.join(project, "outputs", `workbook-identity-packaged-${packageVersion}.json`);
const criticalFiles = [
  "main.cjs",
  "preload.cjs",
  "central-sync.cjs",
  "workbook-identity-migration.cjs",
  "workbook-migration-transaction.cjs",
  "inventory/excel-delta-core.js",
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function row(id, model, sourceRow) {
  return { id, model, sourceRow, category: "Chair", specification: "", stock: 1 };
}

async function main() {
  assert.ok(fs.existsSync(archive), `missing packaged archive: ${archive}`);
  assert.ok(fs.existsSync(installer), `missing installer: ${installer}`);
  const hashes = {};
  for (const file of criticalFiles) {
    const source = fs.readFileSync(path.join(project, file));
    const packaged = asar.extractFile(archive, file);
    hashes[file] = { source: sha256(source), packaged: sha256(packaged) };
    assert.equal(hashes[file].packaged, hashes[file].source, `packaged source mismatch: ${file}`);
  }

  const mainSource = asar.extractFile(archive, "main.cjs").toString("utf8");
  const preloadSource = asar.extractFile(archive, "preload.cjs").toString("utf8");
  assert.match(mainSource, /tek-stock-cloud-identity-migration-plan/);
  assert.match(mainSource, /tek-stock-cloud-identity-migration-apply/);
  assert.match(preloadSource, /identityMigrationPlan/);
  assert.match(preloadSource, /applyIdentityMigration/);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-packaged-identity-"));
  try {
    const modulePath = path.join(temporary, "workbook-identity-migration.cjs");
    fs.writeFileSync(modulePath, asar.extractFile(archive, "workbook-identity-migration.cjs"));
    const { planWorkbookIdentityMigration, applyWorkbookIdentityMigration } = require(modulePath);
    const before = { sha256: "isolated-before", items: [row("", "5566-TEST", 5)] };
    const cloud = { revision: 17, items: [row("cloud-5566-test", "5566-TEST", 99)] };
    const plan = planWorkbookIdentityMigration({ workbook: before, cloud });
    assert.equal(plan.ok, true);
    assert.equal(plan.rows.length, 1);
    assert.deepEqual(plan.rows[0].candidates.map((item) => item.id), ["cloud-5566-test"]);
    assert.equal(Object.hasOwn(plan.rows[0], "selectedId"), false);

    const manifest = {
      workbookSha256: plan.workbookSha256,
      cloudRevision: plan.cloudRevision,
      workbookId: plan.workbookId,
      schemaVersion: plan.schemaVersion,
      migrationVersion: plan.migrationVersion,
      planToken: plan.planToken,
      choices: [{ sourceRow: 5, itemId: "cloud-5566-test" }],
    };
    let workbook = structuredClone(before);
    let writes = 0;
    const options = {
      plan,
      manifest,
      getCloudRevision: async () => 17,
      readWorkbook: async () => structuredClone(workbook),
      assignIds: async (assignments) => {
        writes += 1;
        workbook = {
          sha256: "isolated-after",
          items: workbook.items.map((item) => ({
            ...item,
            id: assignments.find((entry) => entry.sourceRow === item.sourceRow)?.id || item.id,
          })),
          sync: {
            workbookId: plan.workbookId,
            schemaVersion: plan.schemaVersion,
            migrationVersion: plan.migrationVersion,
            migrationPlanToken: plan.planToken,
          },
        };
        return { ok: true };
      },
    };
    const applied = await applyWorkbookIdentityMigration(options);
    const restarted = await applyWorkbookIdentityMigration(options);
    assert.equal(applied.ok, true);
    assert.equal(applied.alreadyApplied, false);
    assert.equal(restarted.ok, true);
    assert.equal(restarted.alreadyApplied, true);
    assert.equal(writes, 1);
    assert.deepEqual(workbook.items.map((item) => item.id), ["cloud-5566-test"]);

    const report = {
      ok: true,
      packageVersion,
      installer: { path: installer, bytes: fs.statSync(installer).size,
        sha256: sha256(fs.readFileSync(installer)) },
      archive: { path: archive, bytes: fs.statSync(archive).size,
        sha256: sha256(fs.readFileSync(archive)) },
      sourceHashesMatch: hashes,
      ipc: { plan: true, apply: true, preloadBridges: true },
      isolatedMigration: {
        model: "5566-TEST",
        candidateIds: plan.rows[0].candidates.map((item) => item.id),
        finalIds: workbook.items.map((item) => item.id),
        writes,
        firstApply: applied.alreadyApplied,
        afterRestart: restarted.alreadyApplied,
      },
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
