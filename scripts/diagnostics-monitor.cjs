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
function run(argv = process.argv.slice(2)) {
  const options = Object.fromEntries(argv.map((arg, index) => arg.startsWith("--") ? [arg.slice(2), argv[index + 1]] : null).filter(Boolean));
  if (!options.wrangler || !options.state || !path.isAbsolute(options.wrangler) || !path.isAbsolute(options.state)) throw Error("MONITOR_ARGUMENTS_REQUIRED");
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const query = `SELECT device_id, authority_id, app_version, stage, error_code, ok, recovered, occurred_at, received_at, revision, pending_count, event_sequence FROM diagnostic_events WHERE device_id <> 'legacy' AND received_at >= '${since}' ORDER BY received_at ASC, occurred_at ASC LIMIT 5000`;
  const result = JSON.parse(execFileSync(process.execPath, [options.wrangler, "d1", "execute", DATABASE, "--remote", "--command", query, "--json"], { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 45000, stdio: ["ignore", "pipe", "pipe"] }));
  if (!Array.isArray(result) || !result.length || result.some(x => x.success !== true || Number(x.meta?.rows_written || 0) !== 0)) throw Error("MONITOR_QUERY_FAILED");
  const rows = result.flatMap(x => x.results || []);
  if (rows.length >= 5000) throw Error("MONITOR_WINDOW_LIMIT_REACHED");
  const prior = fs.existsSync(options.state) ? JSON.parse(fs.readFileSync(options.state, "utf8")) : {};
  const summary = summarizeChanges(rows, prior);
  fs.mkdirSync(path.dirname(options.state), { recursive: true });
  const temp = `${options.state}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(summary.state), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, options.state);
  return { ok: true, checkedAt: new Date().toISOString(), observedDevices: new Set(rows.filter(r => /^d-[a-f0-9]{32}$/.test(r.device_id) && r.device_id !== VERIFICATION_DEVICE).map(r => r.device_id)).size, changes: summary.changes };
}
if (require.main === module) {
  try { console.log(JSON.stringify(run())); }
  catch (error) { console.log(JSON.stringify({ ok: false, errorCode: /^MONITOR_[A-Z_]+$/.test(error.message) ? error.message : "MONITOR_CHECK_FAILED" })); process.exitCode = 1; }
}
module.exports = { summarizeChanges, run };
