"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const defaultResult = path.join(__dirname, "..", "outputs", "task-6-packaged-electron-smoke.json");
const resultPath = process.env.TEK_STOCK_PACKAGED_SMOKE_RESULT
  ? path.resolve(process.env.TEK_STOCK_PACKAGED_SMOKE_RESULT)
  : defaultResult;
const hasPackagedAudit = fs.existsSync(resultPath);

test("extracted old-to-current NSIS update preserves isolated private state without updater or reinstall", {
  skip: hasPackagedAudit ? false : `run scripts/run-packaged-electron-smoke.cjs first (${resultPath})`,
}, () => {
  const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  const boundary = result.updateBoundary;

  assert.equal(result.ok, true);
  assert.equal(result.rootWasTemporary, true);
  assert.ok(boundary, "packaged smoke result must include an update-boundary audit");
  assert.match(boundary.oldProgramHash, /^[a-f0-9]{64}$/);
  assert.match(boundary.currentProgramHash, /^[a-f0-9]{64}$/);
  assert.notEqual(boundary.currentProgramHash, boundary.oldProgramHash);
  assert.deepEqual(boundary.after, boundary.before);
  assert.equal(boundary.updater.updateInvocations, 0);
  assert.equal(boundary.updater.reinstallInvocations, 0);
  assert.equal(boundary.auditDom.preload, true);
  assert.match(boundary.auditDom.marker, /isolated update audit/);

  for (const stateName of ["workbook", "clientId", "outbox", "credentials", "photoCache"]) {
    assert.match(boundary.before[stateName].sha256, /^[a-f0-9]{64}$/);
    assert.ok(boundary.before[stateName].bytes > 0);
  }
});
