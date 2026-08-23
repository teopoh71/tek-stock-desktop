"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.join(__dirname, "reproduce-5566-isolated.cjs");
const runs = [];
for (let index = 0; index < 100; index += 1) {
  const child = spawnSync(process.execPath, [script, "--success"], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  const lines = String(child.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  let result = null;
  try { result = JSON.parse(lines.at(-1) || "{}"); } catch {}
  runs.push({
    run: index + 1,
    exitCode: child.status,
    timedOut: child.error?.code === "ETIMEDOUT",
    ok: result?.workbookHas5566 === true && !result?.errorCode,
    traceId: result?.traceId || "",
    errorCode: result?.errorCode || "",
  });
}
const passed = runs.filter((run) => run.ok).length;
const report = {
  total: runs.length,
  passed,
  failed: runs.length - passed,
  successRate: passed / runs.length,
  silentFailures: runs.filter((run) => run.exitCode === 0 && !run.ok).length,
  runs,
};
const outputDir = path.resolve(__dirname, "..", "test-artifacts");
fs.mkdirSync(outputDir, { recursive: true });
const output = path.join(outputDir, "sync-100-isolated-summary.json");
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, total: report.total, passed: report.passed, failed: report.failed, successRate: report.successRate, silentFailures: report.silentFailures }, null, 2)}\n`);
process.exitCode = report.failed === 0 && report.silentFailures === 0 ? 0 : 1;
