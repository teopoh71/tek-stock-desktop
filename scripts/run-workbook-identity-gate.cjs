"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const tests = [
  "test/excel-delta-core.test.cjs",
  "test/excel-duplicate-models.test.cjs",
  "test/excel-three-way-merge.test.cjs",
  "test/excel-acknowledgement.test.cjs",
  "test/workbook-identity-regression.test.cjs",
  "test/workbook-identity-migration.test.cjs",
  "test/workbook-identity-ipc.test.cjs",
  "test/workbook-migration-transaction.test.cjs",
  "test/preload-security.test.cjs",
  "test/central-sync.test.cjs",
  "test/release-package-version.test.cjs",
];
const result = spawnSync(process.execPath, [
  "--test",
  "--test-concurrency=1",
  ...tests,
], { cwd: root, stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
