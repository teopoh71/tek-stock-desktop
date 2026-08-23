"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const WORKBOOK_FOLDER = "TEK STOCK";
const WORKBOOK_NAME = "TEK-STOCK-LIVE.xlsx";
const CLIENT_ID_FILE = "workbook-client.json";
const CLIENT_ID_PATTERN = /^[0-9a-f-]+$/;

function workbookLocationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function resolveRequiredPath(value, name) {
  if (typeof value !== "string" || !value.trim()) throw workbookLocationError(`MISSING_${name}`);
  return path.resolve(value);
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validateClientId(value) {
  const clientId = String(value || "");
  if (!CLIENT_ID_PATTERN.test(clientId)) throw workbookLocationError("INVALID_WORKBOOK_CLIENT_ID");
  return clientId;
}

function readStoredClientId(clientFile, fsApi) {
  const parsed = JSON.parse(fsApi.readFileSync(clientFile, "utf8"));
  return validateClientId(parsed?.clientId);
}

function writeClientIdAtomically(clientFile, clientId, fsApi) {
  const temporary = `${clientFile}.${clientId}.tmp`;
  fsApi.writeFileSync(temporary, `${JSON.stringify({ clientId })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fsApi.renameSync(temporary, clientFile);
}

function createWorkbookLocation(options = {}) {
  const fsApi = options.fsApi || options.fs || fs;
  const userDataPath = resolveRequiredPath(options.userDataPath, "USER_DATA_PATH");
  const localAppDataPath = resolveRequiredPath(options.localAppDataPath, "LOCAL_APP_DATA_PATH");
  const documentsPath = resolveRequiredPath(options.documentsPath, "DOCUMENTS_PATH");
  const createId = options.randomUUID || randomUUID;
  const clientFile = path.join(userDataPath, CLIENT_ID_FILE);

  let clientId;
  if (fsApi.existsSync(clientFile)) {
    clientId = readStoredClientId(clientFile, fsApi);
  } else {
    clientId = validateClientId(createId());
    fsApi.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    writeClientIdAtomically(clientFile, clientId, fsApi);
  }

  const workbookRoot = path.resolve(localAppDataPath, WORKBOOK_FOLDER, "workbooks");
  const privateWorkbookPath = path.resolve(workbookRoot, clientId, WORKBOOK_NAME);
  if (!isPathInside(workbookRoot, privateWorkbookPath)) {
    throw workbookLocationError("UNSAFE_PRIVATE_WORKBOOK_PATH");
  }
  const backupDirectory = path.resolve(workbookRoot, clientId, "backups");
  if (!isPathInside(workbookRoot, backupDirectory)) {
    throw workbookLocationError("UNSAFE_BACKUP_DIRECTORY");
  }
  const legacyWorkbookPath = path.resolve(documentsPath, WORKBOOK_FOLDER, WORKBOOK_NAME);

  return {
    clientId,
    privateWorkbookPath,
    legacyWorkbookPath,
    backupDirectory,
    ensureDirectories() {
      fsApi.mkdirSync(path.dirname(privateWorkbookPath), { recursive: true, mode: 0o700 });
      fsApi.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    },
    describe() {
      return { clientId, privateWorkbookPath, legacyWorkbookPath, backupDirectory };
    },
  };
}

module.exports = { createWorkbookLocation };
