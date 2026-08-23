"use strict";

const fs = require("node:fs");
const { randomUUID } = require("node:crypto");

function transactionError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function migrationArtifactPaths(file) {
  return {
    lock: `${file}.identity-migration.lock`,
    journal: `${file}.identity-migration.journal.json`,
    backup: `${file}.identity-migration.backup.xlsx`,
  };
}

function durableWrite(file, content, fsApi = fs) {
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = fsApi.openSync(temporary, "w", 0o600);
  try {
    fsApi.writeFileSync(descriptor, content);
    fsApi.fsyncSync(descriptor);
  } finally {
    fsApi.closeSync(descriptor);
  }
  fsApi.renameSync(temporary, file);
}

function readJson(file, fsApi = fs) {
  try { return JSON.parse(fsApi.readFileSync(file, "utf8")); } catch { return null; }
}

function pidIsAlive(pid, processApi = process) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { processApi.kill(value, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function cleanupArtifacts(paths, fsApi = fs) {
  fsApi.rmSync(paths.journal, { force: true });
  fsApi.rmSync(paths.backup, { force: true });
  fsApi.rmSync(paths.lock, { force: true });
}

function restoreBackup(file, paths, fsApi = fs) {
  if (!fsApi.existsSync(paths.backup)) throw transactionError("WORKBOOK_MIGRATION_BACKUP_MISSING");
  fsApi.copyFileSync(paths.backup, file);
  const descriptor = fsApi.openSync(file, "r+");
  try { fsApi.fsyncSync(descriptor); } finally { fsApi.closeSync(descriptor); }
}

function recoverWorkbookMigration(file, options = {}) {
  const fsApi = options.fsApi || fs;
  const processApi = options.processApi || process;
  const paths = migrationArtifactPaths(file);
  const lock = readJson(paths.lock, fsApi);
  if (lock && pidIsAlive(lock.pid, processApi)) {
    return { recovered: false, active: true, ownerPid: Number(lock.pid) };
  }
  if (!fsApi.existsSync(paths.journal)) {
    if (lock && fsApi.existsSync(paths.backup)) {
      return {
        recovered: false,
        active: true,
        ownerPid: Number(lock.pid) || 0,
        reason: "WORKBOOK_MIGRATION_RECOVERY_REQUIRED",
      };
    }
    if (lock) fsApi.rmSync(paths.lock, { force: true });
    return { recovered: false, active: false };
  }
  restoreBackup(file, paths, fsApi);
  cleanupArtifacts(paths, fsApi);
  return { recovered: true, active: false };
}

function acquireWorkbookWriterLock(file, options = {}) {
  const fsApi = options.fsApi || fs;
  const processApi = options.processApi || process;
  const paths = migrationArtifactPaths(file);
  const recovered = recoverWorkbookMigration(file, { fsApi, processApi });
  if (recovered.active) throw transactionError("WORKBOOK_MIGRATION_IN_PROGRESS", recovered);
  const token = randomUUID();
  let descriptor;
  try {
    descriptor = fsApi.openSync(paths.lock, "wx", 0o600);
    fsApi.writeFileSync(descriptor, JSON.stringify({ pid: processApi.pid, createdAt: Date.now(), token }));
    fsApi.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) try { fsApi.closeSync(descriptor); } catch {}
    if (error?.code === "EEXIST") throw transactionError("WORKBOOK_MIGRATION_IN_PROGRESS");
    throw error;
  }
  fsApi.closeSync(descriptor);
  let released = false;
  return {
    token,
    release() {
      if (released) return;
      const current = readJson(paths.lock, fsApi);
      if (current?.token === token) fsApi.rmSync(paths.lock, { force: true });
      released = true;
    },
  };
}

function beginWorkbookMigrationTransaction(file, metadata = {}, options = {}) {
  const fsApi = options.fsApi || fs;
  const processApi = options.processApi || process;
  const paths = migrationArtifactPaths(file);
  const writerLock = acquireWorkbookWriterLock(file, { fsApi, processApi });
  try {
    fsApi.copyFileSync(file, paths.backup);
    durableWrite(paths.journal, JSON.stringify({
      state: "prepared",
      pid: processApi.pid,
      createdAt: new Date().toISOString(),
      planToken: String(metadata.planToken || ""),
    }), fsApi);
  } catch (error) {
    fsApi.rmSync(paths.journal, { force: true });
    fsApi.rmSync(paths.backup, { force: true });
    writerLock.release();
    throw error;
  }
  let finished = false;
  const updateJournal = (state) => durableWrite(paths.journal, JSON.stringify({
    state,
    pid: processApi.pid,
    updatedAt: new Date().toISOString(),
    planToken: String(metadata.planToken || ""),
  }), fsApi);
  return {
    paths,
    markWorkbookWritten() { if (!finished) updateJournal("workbook-written"); },
    async rollback() {
      if (finished) return;
      restoreBackup(file, paths, fsApi);
      fsApi.rmSync(paths.journal, { force: true });
      fsApi.rmSync(paths.backup, { force: true });
      writerLock.release();
      finished = true;
    },
    async finalize() {
      if (finished) return;
      updateJournal("verified");
      fsApi.rmSync(paths.journal, { force: true });
      fsApi.rmSync(paths.backup, { force: true });
      writerLock.release();
      finished = true;
    },
  };
}

module.exports = {
  acquireWorkbookWriterLock,
  beginWorkbookMigrationTransaction,
  migrationArtifactPaths,
  recoverWorkbookMigration,
};
