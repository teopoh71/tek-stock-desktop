"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
function updateError(code) { return Object.assign(new Error(code), { code }); }
function assertIdle(state) {
  if (!state || state.known !== true) throw updateError("UPDATE_STATE_UNAVAILABLE");
  if (state.conflicts > 0 || state.pending > 0) throw updateError("UPDATE_PENDING_SYNC");
  if (state.busy || state.unsaved || state.workbookLocked) throw updateError("UPDATE_BUSY");
}
function hash(file) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function createUpdateBackup({ directory, workbook, stateFiles = [], version }) {
  const backup = path.join(directory, "before-update-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID());
  try {
    if (!workbook || !fs.existsSync(workbook)) throw updateError("UPDATE_BACKUP_FAILED");
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    const records = [];
    for (const [index, source] of [workbook, ...stateFiles].entries()) {
      if (index > 0 && !fs.existsSync(source)) continue;
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw updateError("UPDATE_BACKUP_FAILED");
      const expected = hash(source);
      const name = index === 0 ? "workbook.xlsx" : "state-" + index + ".json";
      const target = path.join(backup, name);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (hash(target) !== expected || hash(source) !== expected) throw updateError("UPDATE_BACKUP_FAILED");
      records.push({ name, sha256: expected, bytes: stat.size });
    }
    fs.writeFileSync(path.join(backup, "manifest.json"), JSON.stringify({ version, files: records }, null, 2), { mode: 0o600, flag: "wx" });
    return { ok: true, path: backup, files: records.length, workbookSha256: records[0].sha256 };
  } catch { throw updateError("UPDATE_BACKUP_FAILED"); }
}
module.exports = { assertIdle, createUpdateBackup, updateError };
