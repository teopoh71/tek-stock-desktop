"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const DATABASE = "53913ca2-64fe-4851-8b6b-b5abdd812167";
const VERIFICATION_DEVICE = "d-00000000000040008000000000000012";
function incidentStage(stage, code) {
  if (/^refresh_|^cloud_download$/.test(stage)) return "cloud_download";
  if (/^sync_|^excel_sync|^excel_import$|^excel_ack$/.test(stage)) return "excel_sync";
  if (stage === "app.error") return /^(CLOUD|API|HTTP_|SYNC_TOKEN|UNAUTHORIZED|AUTH_)/.test(code || "") ? "cloud_download" : /^(EXCEL|WORKBOOK)/.test(code || "") ? "excel_sync" : stage;
  return stage;
}
function summarizeChanges(rows, previous = {}) {
  const state = { ...previous }, changes = [], latest = new Map();
  for (const row of rows) {
    if (!/^d-[a-f0-9]{32}$/.test(row.device_id || "") || row.device_id === VERIFICATION_DEVICE) continue;
    if (/_started$/.test(row.stage)) continue;
    const stage = incidentStage(row.stage, row.error_code);
    if (stage === "unknown" || stage === "daily_health") continue;
    const key = JSON.stringify([row.device_id, row.authority_id, stage]);
    const eventTime = Date.parse(row.occurred_at);
    if (!Number.isFinite(eventTime)) continue;
    const order = Number(row.event_sequence) || eventTime;
    if (!latest.has(key) || order >= latest.get(key).order) latest.set(key, { row, stage, eventTime, order });
  }
  for (const [key, { row, stage, eventTime }] of latest) {
    const old = state[key];
    if (old && (Number(row.event_sequence) > 0 && Number(old.eventSequence) > 0
      ? Number(row.event_sequence) < Number(old.eventSequence) : eventTime < Date.parse(old.occurredAt))) continue;
    const item = {
      deviceId: row.device_id, authorityId: row.authority_id, appVersion: row.app_version,
      stage, state: Number(row.ok) === 1 ? "recovered" : "fault",
      errorCode: Number(row.ok) === 1 ? "" : row.error_code,
      occurredAt: row.occurred_at, receivedAt: row.received_at,
      revision: row.revision ?? null, pending: row.pending_count ?? null, eventSequence: Number(row.event_sequence) || null,
    };
    // A successful cloud read cannot clear another Excel/merge incident family.
    if (item.state === "fault" && (!old || old.state !== "fault" || old.errorCode !== item.errorCode)) changes.push(item);
    if (item.state === "recovered" && Number(row.recovered) === 1 && old?.state === "fault") changes.push(item);
    state[key] = item;
  }
  return { changes, state };
}
const COLUMNS = ["device_id", "authority_id", "app_version", "stage", "error_code", "ok", "recovered", "occurred_at", "received_at", "revision", "pending_count", "event_sequence"];
function cloudflareRows(wrangler, since) {
  const query = `SELECT ${COLUMNS.join(", ")} FROM diagnostic_events WHERE device_id <> 'legacy' AND received_at >= '${since}' ORDER BY received_at ASC, occurred_at ASC LIMIT 5000`;
  const result = JSON.parse(execFileSync(process.execPath, [wrangler, "d1", "execute", DATABASE, "--remote", "--command", query, "--json"], { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 45000, stdio: ["ignore", "pipe", "pipe"] }));
  if (!Array.isArray(result) || !result.length || result.some(x => x.success !== true || Number(x.meta?.rows_written || 0) !== 0)) throw Error("MONITOR_QUERY_FAILED");
  return result.flatMap(x => x.results || []);
}
// Computers on 1.6.17+ report to Alibaba; the monitor token stays in its file and is never printed.
async function alibabaRows(base, tokenFile, since, fetchImpl = fetch) {
  const token = JSON.parse(fs.readFileSync(tokenFile, "utf8")).monitorToken;
  if (typeof token !== "string" || token.length < 32) throw Error("MONITOR_TOKEN_MISSING");
  const response = await fetchImpl(`${base.replace(/\/+$/, "")}/v1/diagnostics/events?since=${encodeURIComponent(since)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw Error("MONITOR_QUERY_FAILED");
  const body = await response.json();
  if (!Array.isArray(body.rows)) throw Error("MONITOR_QUERY_FAILED");
  return body.rows.map(row => Object.fromEntries(COLUMNS.map(column => [column, row[column] ?? null])));
}
async function run(argv = process.argv.slice(2), { fetchImpl = fetch } = {}) {
  const options = Object.fromEntries(argv.map((arg, index) => arg.startsWith("--") ? [arg.slice(2), argv[index + 1]] : null).filter(Boolean));
  if (!options.state || !path.isAbsolute(options.state)) throw Error("MONITOR_ARGUMENTS_REQUIRED");
  if (!options.wrangler && !options.alibaba) throw Error("MONITOR_ARGUMENTS_REQUIRED");
  if (options.wrangler && !path.isAbsolute(options.wrangler)) throw Error("MONITOR_ARGUMENTS_REQUIRED");
  if (options.alibaba && !(options["token-file"] && path.isAbsolute(options["token-file"]) && /^https:\/\//.test(options.alibaba))) throw Error("MONITOR_ARGUMENTS_REQUIRED");
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = [], sources = {};
  // One cloud failing must not hide reports the other one holds; only fail when nothing could be read.
  for (const [name, read] of [
    ["cloudflare", options.wrangler && (() => cloudflareRows(options.wrangler, since))],
    ["alibaba", options.alibaba && (() => alibabaRows(options.alibaba, options["token-file"], since, fetchImpl))],
  ]) {
    if (!read) continue;
    try { const found = await read(); rows.push(...found); sources[name] = found.length; }
    catch (error) { sources[name] = /^MONITOR_[A-Z_]+$/.test(error.message) ? error.message : "MONITOR_CHECK_FAILED"; }
  }
  if (!Object.values(sources).some(value => typeof value === "number")) throw Error(Object.values(sources)[0] || "MONITOR_CHECK_FAILED");
  if (Object.values(sources).some(value => value >= 5000)) throw Error("MONITOR_WINDOW_LIMIT_REACHED");
  rows.sort((x, y) => String(x.received_at).localeCompare(String(y.received_at)) || String(x.occurred_at).localeCompare(String(y.occurred_at)));
  const prior = fs.existsSync(options.state) ? JSON.parse(fs.readFileSync(options.state, "utf8")) : {};
  const summary = summarizeChanges(rows, prior);
  fs.mkdirSync(path.dirname(options.state), { recursive: true });
  const temp = `${options.state}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(summary.state), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, options.state);
  return { ok: true, checkedAt: new Date().toISOString(), sources, observedDevices: new Set(rows.filter(r => /^d-[a-f0-9]{32}$/.test(r.device_id) && r.device_id !== VERIFICATION_DEVICE).map(r => r.device_id)).size, changes: summary.changes };
}
if (require.main === module) {
  run().then(result => console.log(JSON.stringify(result)), error => {
    console.log(JSON.stringify({ ok: false, errorCode: /^MONITOR_[A-Z_]+$/.test(error.message) ? error.message : "MONITOR_CHECK_FAILED" })); process.exitCode = 1;
  });
}
module.exports = { summarizeChanges, run, alibabaRows };
