"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { safeEvent } = require("./diagnostic-payload.cjs");
const MAX_EVENTS = 500, MAX_AGE = 7 * 86400000;
function createDiagnosticsOutbox(options) {
  const file = path.join(options.directory, "diagnostics-outbox.json");
  const now = options.now || Date.now;
  let entries = [], active = false, nextAt = 0, attempts = 0;
  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("UNSAFE_DIAGNOSTICS_PATH");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    entries = Array.isArray(parsed) ? parsed.filter(e => /^[a-f0-9-]{36}$/.test(e?.id))
      .slice(-MAX_EVENTS).map(e => ({ id: e.id, ...safeEvent(e) })) : [];
  } catch (error) { if (error.code !== "ENOENT") options.onError?.("DIAGNOSTICS_QUEUE_READ_FAILED"); }
  function persist(next) {
    const temp = file + "." + randomUUID() + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(next), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file); entries = next;
  }
  function enqueue(input) {
    const event = safeEvent(input);
    if (event.ok) return { ok: true, queued: false };
    const retained = entries.filter(e => now() - Date.parse(e.timestamp) < MAX_AGE);
    const duplicate = retained.find(e => e.errorCode === event.errorCode && e.stage === event.stage
      && e.appVersion === event.appVersion && Math.abs(Date.parse(e.timestamp) - Date.parse(event.timestamp)) < 60000);
    if (duplicate) return { ok: true, queued: true, id: duplicate.id };
    const entry = { id: randomUUID(), ...event };
    persist([...retained, entry].slice(-MAX_EVENTS));
    return { ok: true, queued: true, id: entry.id };
  }
  async function flush(manual = false) {
    if (!options.configured()) return { ok: false, errorCode: "DIAGNOSTICS_NOT_CONFIGURED", pending: entries.length };
    if (active || (!manual && now() < nextAt)) return { ok: false, errorCode: "DIAGNOSTICS_RETRY_PENDING", pending: entries.length };
    active = true;
    try {
      const batch = entries.filter(e => now() - Date.parse(e.timestamp) < MAX_AGE).slice(0, 20);
      if (!batch.length) { if (entries.length) persist([]); return { ok: true, sent: 0, pending: 0 }; }
      const response = await options.send(batch);
      const ids = new Set(batch.map(e => e.id));
      const accepted = Array.isArray(response?.accepted) ? response.accepted : [];
      if (!accepted.length || accepted.some(id => !ids.has(id))) throw new Error("DIAGNOSTICS_ACK_INVALID");
      const acknowledged = new Set(accepted);
      persist(entries.filter(e => !acknowledged.has(e.id)));
      attempts = 0; nextAt = now() + 15000;
      return { ok: true, sent: accepted.length, pending: entries.length };
    } catch {
      attempts += 1; nextAt = now() + Math.min(1800000, 15000 * 2 ** Math.min(attempts - 1, 7));
      return { ok: false, errorCode: "DIAGNOSTICS_NETWORK_FAILED", pending: entries.length };
    } finally { active = false; }
  }
  return { enqueue, flush, status: () => ({ pending: entries.length, active, nextAt, configured: options.configured() }) };
}
module.exports = { createDiagnosticsOutbox };
