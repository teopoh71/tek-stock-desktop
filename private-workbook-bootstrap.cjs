"use strict";

const fs = require("node:fs");

function isRevision(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

function validWorkbook(result, expectedRevision) {
  const revision = Number(result?.sync?.revision);
  return result?.ok === true
    && isRevision(revision)
    && (expectedRevision === undefined || revision === expectedRevision);
}

function bootstrapResult(state, location, cloudRevision, fsApi) {
  return {
    ok: state === "ready" || state === "bootstrapped",
    state,
    workbookPath: location.privateWorkbookPath,
    cloudRevision: isRevision(cloudRevision) ? Number(cloudRevision) : 0,
    legacyPreserved: fsApi.existsSync(location.legacyWorkbookPath),
  };
}

async function ensurePrivateWorkbook(options = {}) {
  const {
    location,
    fetchSnapshot,
    writeWorkbook,
    readWorkbook,
  } = options;
  const fsApi = options.fsApi || fs;
  if (!location?.privateWorkbookPath || !location?.legacyWorkbookPath
      || typeof location.ensureDirectories !== "function"
      || typeof fetchSnapshot !== "function"
      || typeof writeWorkbook !== "function"
      || typeof readWorkbook !== "function") {
    throw new TypeError("PRIVATE_WORKBOOK_BOOTSTRAP_OPTIONS_INVALID");
  }

  const workbookPath = location.privateWorkbookPath;
  if (fsApi.existsSync(workbookPath)) {
    let existing;
    try {
      existing = await readWorkbook(workbookPath);
    } catch {
      return bootstrapResult("invalid-private-workbook", location, 0, fsApi);
    }
    if (!validWorkbook(existing)) {
      return bootstrapResult("invalid-private-workbook", location, 0, fsApi);
    }
    return bootstrapResult("ready", location, existing.sync.revision, fsApi);
  }

  let snapshot;
  try {
    snapshot = await fetchSnapshot();
  } catch {
    return bootstrapResult("offline-not-initialized", location, 0, fsApi);
  }
  if (snapshot?.cloudState !== "live") {
    return bootstrapResult("offline-not-initialized", location, 0, fsApi);
  }
  if (!Array.isArray(snapshot?.items) || !isRevision(snapshot.revision)) {
    return bootstrapResult("offline-not-initialized", location, 0, fsApi);
  }

  location.ensureDirectories();
  const temporary = `${workbookPath}.bootstrap.xlsx`;
  try {
    await writeWorkbook(temporary, snapshot);
    const written = await readWorkbook(temporary);
    if (!validWorkbook(written, Number(snapshot.revision))) {
      return bootstrapResult("invalid-private-workbook", location, snapshot.revision, fsApi);
    }

    try {
      // linkSync provides an exclusive final-path claim: unlike renameSync it
      // cannot replace a workbook created by another process after our check.
      fsApi.linkSync(temporary, workbookPath);
    } catch (error) {
      if (!fsApi.existsSync(workbookPath)) throw error;
      const winner = await readWorkbook(workbookPath);
      if (!validWorkbook(winner)) {
        return bootstrapResult("invalid-private-workbook", location, 0, fsApi);
      }
      return bootstrapResult("ready", location, winner.sync.revision, fsApi);
    }
    return bootstrapResult("bootstrapped", location, snapshot.revision, fsApi);
  } catch (error) {
    if (error?.code === "EEXIST" && fsApi.existsSync(workbookPath)) {
      const winner = await readWorkbook(workbookPath);
      if (validWorkbook(winner)) {
        return bootstrapResult("ready", location, winner.sync.revision, fsApi);
      }
    }
    return bootstrapResult("invalid-private-workbook", location, snapshot.revision, fsApi);
  } finally {
    fsApi.rmSync(temporary, { force: true });
  }
}

module.exports = { ensurePrivateWorkbook };
