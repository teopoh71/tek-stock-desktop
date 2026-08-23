const {
  app,
  BrowserWindow,
  dialog,
  shell,
  ipcMain,
  safeStorage,
  net: electronNet,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { fileURLToPath } = require("node:url");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");
const https = require("node:https");
const {
  DEFAULT_MANIFEST_URL,
  FALLBACK_MANIFEST_URL,
  downloadVerifiedInstaller,
  fetchReleaseManifest,
  isVersionNewer,
  selectWindowsChannel,
} = require("./updater-core.cjs");
// Electron 22 is the last desktop runtime that supports Windows 7. It embeds
// Node 16, so use the compatible Sharp build there while keeping the current
// Sharp release for Windows 10/11.
const sharp = Number(process.versions.node.split(".")[0]) < 18
  ? require("sharp-win7")
  : require("sharp");
const { normalizeExcelRows } = require("./inventory/excel-sync-core.js");
const {
  ALLOWED_CHOICES: SYNC_CONFLICT_CHOICES,
  ALLOWED_FIELDS: SYNC_CONFLICT_FIELDS,
  DELETE_FIELD: SYNC_DELETE_CONFLICT_FIELD,
  formatConflict,
} = require("./inventory/conflict-resolution.js");
const {
  isWorkbookSemanticallyAcknowledged,
  workbookSemanticFingerprint,
} = require("./workbook-fingerprint.cjs");
const { createCentralSync } = require("./central-sync.cjs");
const {
  createSyncTrace,
  normalizeSyncFailure,
  sanitizeWorkbookSyncIpcResult,
} = require("./sync-trace.cjs");
const { readAlibabaCloudConfigFiles } = require("./alibaba-config.cjs");
const { readUpdateReceipt, writeUpdateReceipt } = require("./update-receipt.cjs");
const {
  applyOpenWorkbookMutation,
  focusOpenWorkbook,
  isWorkbookLocked,
  openWorkbookInOffice,
  replaceOpenWorkbookFile,
  saveOpenWorkbook,
} = require("./excel-live.cjs");
const { createWorkbookLocation } = require("./workbook-location.cjs");
const { ensurePrivateWorkbook } = require("./private-workbook-bootstrap.cjs");
const {
  applyWorkbookIdentityMigration,
  exactAssignmentsPersisted,
  planWorkbookIdentityMigration,
  WORKBOOK_MIGRATION_VERSION,
  WORKBOOK_SCHEMA_VERSION,
} = require("./workbook-identity-migration.cjs");
const {
  acquireWorkbookWriterLock,
  beginWorkbookMigrationTransaction,
  recoverWorkbookMigration,
} = require("./workbook-migration-transaction.cjs");
const {
  createPrivateWorkbookBootstrap,
  registerPrivateWorkbookBootstrapIpc,
} = require("./private-workbook-bootstrap-main.cjs");
const {
  configureSmokeAppPaths,
  createSmokeFetch,
  loadIsolatedSmokeRequest,
  registerSmokeUpdaterIpc,
  runPackagedSmokeRuntime,
} = require("./packaged-smoke-runtime.cjs");
const {
  CLOUD_RESET_LOCAL_CONFIRMATION,
  createCloudResetLocalRunner,
} = require("./cloud-reset-local.cjs");
const { createWorkbookOperationGate } = require("./workbook-operation-gate.cjs");

const WORKBOOK_NAME = "TEK-STOCK-LIVE.xlsx";
const CREDENTIALS_NAME = "sync-credentials.json";
const PACKAGED_IMAGE_SET_VERSION = "20260726-exact-photo-sync-v3";
const SHEET_NAME = "库存总表";
let mainWindow;
let watchedWorkbook = "";
let suppressWatchUntil = 0;
let suppressedWorkbookSha256 = "";
let workbookChangeTimer;
let workbookRetryTimer;
let workbookRetryAttempt = 0;
let workbookSyncRunning = false;
let pendingWorkbookChange;
let writeQueue = Promise.resolve();
let packagedImageMap;
let updaterActive = false;
let centralSync;
const workbookOperationGate = createWorkbookOperationGate();
let ExcelJS;
let cachedWorkbookLocation;
let isolatedSmokeRequest;
let isolatedSmokeLoadError;

try {
  isolatedSmokeRequest = loadIsolatedSmokeRequest();
  if (isolatedSmokeRequest) {
    configureSmokeAppPaths(app, isolatedSmokeRequest);
    process.env.LOCALAPPDATA = isolatedSmokeRequest.localAppDataPath;
  }
} catch (error) {
  isolatedSmokeLoadError = error;
}

function createExcelWorkbook() {
  // ExcelJS pulls in JSZip. Loading it only when Excel is actually used keeps
  // the desktop UI and Reinstall recovery path available if that optional
  // dependency was damaged on one machine.
  ExcelJS ||= require("exceljs");
  return new ExcelJS.Workbook();
}

let JSZip;
const SPREADSHEETML_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function normalizePrefixedSpreadsheetXml(xml) {
  if (!xml.includes(`xmlns:x="${SPREADSHEETML_NAMESPACE}"`) || !/<x:[A-Za-z_]/.test(xml)) {
    return null;
  }
  return xml
    .replace(/<x:([A-Za-z_][\w.-]*)/g, "<$1")
    .replace(/<\/x:([A-Za-z_][\w.-]*)>/g, "</$1>")
    .replace(`xmlns:x="${SPREADSHEETML_NAMESPACE}"`, `xmlns="${SPREADSHEETML_NAMESPACE}"`);
}

async function loadExcelWorkbook(workbook, buffer) {
  try {
    await workbook.xlsx.load(buffer);
    return;
  } catch (initialError) {
    JSZip ||= require("jszip");
    const zip = await JSZip.loadAsync(buffer);
    let normalized = false;
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir || !name.toLowerCase().endsWith(".xml")) continue;
      const xml = await entry.async("string");
      const normalizedXml = normalizePrefixedSpreadsheetXml(xml);
      if (normalizedXml) {
        zip.file(name, normalizedXml);
        normalized = true;
      }
    }
    if (!normalized) throw initialError;
    await workbook.xlsx.load(await zip.generateAsync({ type: "nodebuffer" }));
  }
}

const DIAGNOSTICS_FOLDER = "diagnostics";
const DIAGNOSTIC_FILE_PATTERN = /^TEK-STOCK-diagnostics-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_DIAGNOSTIC_DAILY_FILES = 7;
const MAX_DIAGNOSTIC_LINE_BYTES = 2048;
const MAX_DIAGNOSTIC_FILE_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_COUNTS = 20;
const SAFE_SNAPSHOT_FIELDS = new Set(["root", "items", "revision", "changeSequence"]);
const SENSITIVE_DIAGNOSTIC_KEY = /token|secret|password|passcode|authorization|cookie|email|phone|mobile|contact|address|customer|name|photo|image|data|row/i;

function diagnosticsError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function diagnosticsDirectory(userDataPath = app.getPath("userData")) {
  return path.join(userDataPath, DIAGNOSTICS_FOLDER);
}

function ensureDiagnosticsDirectory(userDataPath) {
  const directory = diagnosticsDirectory(userDataPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw diagnosticsError("UNSAFE_DIAGNOSTICS_PATH");
  }
  return directory;
}

function localDateStamp(value) {
  const date = value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function redactDiagnosticText(value) {
  return String(value == null ? "" : value)
    .slice(0, 4096)
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[REDACTED]")
    .replace(/\bBearer\s+[a-z0-9._~+/=-]+/gi, "[REDACTED]")
    .replace(
      /\b(token|secret|password|passcode|api[-_]?key|authorization|cookie|email|phone|mobile|contact|address|customer(?:name)?|name)\s*[:=]\s*[^,\s;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, "[REDACTED]")
    .replace(/\+?\d[\d ()-]{7,}\d/g, "[REDACTED]");
}

function diagnosticCode(value, fallback, maxLength) {
  const normalized = redactDiagnosticText(value)
    .replace(/\[REDACTED\]/g, "REDACTED")
    .normalize("NFKC")
    .replace(/[^a-z0-9._:-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
  return normalized || fallback;
}

function diagnosticNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function sanitizeDiagnosticEvent(input, options = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const suppliedNow = options.now instanceof Date ? options.now : new Date();
  const now = Number.isFinite(suppliedNow.getTime()) ? suppliedNow : new Date();
  const ok = source.ok === true;
  const entry = {
    timestamp: now.toISOString(),
    appVersion: diagnosticCode(options.appVersion, "unknown", 32),
    stage: diagnosticCode(source.stage, "unknown", 96),
    ok,
    errorCode: ok ? "" : diagnosticCode(source.errorCode, "UNKNOWN_ERROR", 64),
  };
  const traceId = String(source.traceId || "").match(/^sync-[a-z0-9-]{8,80}$/i)?.[0];
  if (traceId) entry.traceId = traceId;
  if (SAFE_SNAPSHOT_FIELDS.has(source.snapshotField)) {
    entry.snapshotField = source.snapshotField;
  }
  const revision = diagnosticNumber(source.revision);
  if (revision != null) entry.revision = revision;

  const counts = {};
  if (source.counts && typeof source.counts === "object" && !Array.isArray(source.counts)) {
    for (const [rawKey, rawValue] of Object.entries(source.counts)) {
      if (Object.keys(counts).length >= MAX_DIAGNOSTIC_COUNTS) break;
      if (SENSITIVE_DIAGNOSTIC_KEY.test(rawKey)) continue;
      const key = String(rawKey).match(/^[a-z][a-z0-9_]{0,39}$/i)?.[0];
      const value = diagnosticNumber(rawValue);
      if (key && value != null) counts[key] = value;
    }
  }
  if (Object.keys(counts).length) entry.counts = counts;
  return entry;
}

function serializeDiagnosticEvent(entry, maxLineBytes) {
  const candidate = {
    ...entry,
    ...(entry.counts ? { counts: { ...entry.counts } } : {}),
  };
  let line = JSON.stringify(candidate);
  while (Buffer.byteLength(line) > maxLineBytes && candidate.counts) {
    const keys = Object.keys(candidate.counts);
    if (!keys.length) {
      delete candidate.counts;
      break;
    }
    delete candidate.counts[keys[keys.length - 1]];
    if (!Object.keys(candidate.counts).length) delete candidate.counts;
    line = JSON.stringify(candidate);
  }
  if (Buffer.byteLength(line) <= maxLineBytes) return line;

  const fallback = JSON.stringify({
    timestamp: entry.timestamp,
    appVersion: entry.appVersion,
    stage: "diagnostics.entry",
    ok: false,
    errorCode: "ENTRY_TRUNCATED",
  });
  if (Buffer.byteLength(fallback) > maxLineBytes) {
    throw diagnosticsError("DIAGNOSTIC_LINE_LIMIT_TOO_SMALL");
  }
  return fallback;
}

function safeDiagnosticFiles(userDataPath) {
  const directory = ensureDiagnosticsDirectory(userDataPath);
  return fs.readdirSync(directory)
    .filter((name) => DIAGNOSTIC_FILE_PATTERN.test(name))
    .map((name) => path.join(directory, name))
    .filter((file) => {
      const stat = fs.lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink();
    })
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

function listDiagnosticFiles(userDataPath) {
  return safeDiagnosticFiles(userDataPath);
}

function pruneDiagnosticFiles(userDataPath, maxFiles = MAX_DIAGNOSTIC_DAILY_FILES) {
  const files = safeDiagnosticFiles(userDataPath);
  const keep = Math.max(1, Math.trunc(Number(maxFiles) || MAX_DIAGNOSTIC_DAILY_FILES));
  for (const file of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(file, { force: true });
  }
}

function readDiagnosticTail(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw diagnosticsError("UNSAFE_DIAGNOSTICS_PATH");
  const length = Math.min(stat.size, maxBytes);
  if (!length) return "";
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(file, "r");
  try {
    fs.readSync(descriptor, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(descriptor);
  }
  let text = buffer.toString("utf8");
  if (stat.size > length) {
    const newline = text.indexOf("\n");
    text = newline >= 0 ? text.slice(newline + 1) : "";
  }
  return text;
}

function appendCappedDiagnosticLine(file, line, maxFileBytes) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    throw diagnosticsError("UNSAFE_DIAGNOSTICS_PATH");
  }
  const newLineBytes = Buffer.byteLength(`${line}\n`);
  if (newLineBytes > maxFileBytes) throw diagnosticsError("DIAGNOSTIC_FILE_LIMIT_TOO_SMALL");

  const lines = fs.existsSync(file)
    ? readDiagnosticTail(file, maxFileBytes).split(/\r?\n/).filter(Boolean)
    : [];
  lines.push(line);
  while (lines.length > 1 && Buffer.byteLength(`${lines.join("\n")}\n`) > maxFileBytes) {
    lines.shift();
  }
  const output = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(output) > maxFileBytes) {
    throw diagnosticsError("DIAGNOSTIC_FILE_LIMIT_TOO_SMALL");
  }
  fs.writeFileSync(file, output, { encoding: "utf8", mode: 0o600 });
  return Buffer.byteLength(output);
}

function appendDiagnosticEvent(input, options = {}) {
  const userDataPath = options.userDataPath || app.getPath("userData");
  const now = options.now instanceof Date ? options.now : new Date();
  const maxLineBytes = Math.max(160, Math.trunc(Number(options.maxLineBytes) || MAX_DIAGNOSTIC_LINE_BYTES));
  const maxFileBytes = Math.max(
    maxLineBytes + 1,
    Math.trunc(Number(options.maxFileBytes) || MAX_DIAGNOSTIC_FILE_BYTES),
  );
  const directory = ensureDiagnosticsDirectory(userDataPath);
  const entry = sanitizeDiagnosticEvent(input, {
    appVersion: options.appVersion || app.getVersion(),
    now,
  });
  const line = serializeDiagnosticEvent(entry, maxLineBytes);
  const file = path.join(directory, `TEK-STOCK-diagnostics-${localDateStamp(now)}.jsonl`);
  const bytes = appendCappedDiagnosticLine(file, line, maxFileBytes);
  pruneDiagnosticFiles(userDataPath, options.maxFiles);
  return { ok: true, path: file, bytes };
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function exportDiagnosticsToFile(userDataPath, destinationPath, options = {}) {
  const directory = ensureDiagnosticsDirectory(userDataPath);
  const destination = path.resolve(String(destinationPath || ""));
  if (!destination || path.extname(destination).toLowerCase() !== ".jsonl"
      || isPathInside(directory, destination)) {
    throw diagnosticsError("UNSAFE_EXPORT_PATH");
  }
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
    throw diagnosticsError("UNSAFE_EXPORT_PATH");
  }

  const maxLineBytes = Math.max(160, Math.trunc(Number(options.maxLineBytes) || MAX_DIAGNOSTIC_LINE_BYTES));
  const maxFileBytes = Math.max(
    maxLineBytes + 1,
    Math.trunc(Number(options.maxFileBytes) || MAX_DIAGNOSTIC_FILE_BYTES),
  );
  const exportedLines = [];
  const files = safeDiagnosticFiles(userDataPath).slice(-MAX_DIAGNOSTIC_DAILY_FILES);
  for (const file of files) {
    for (const line of readDiagnosticTail(file, maxFileBytes).split(/\r?\n/).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        const timestamp = new Date(parsed.timestamp);
        const sanitized = sanitizeDiagnosticEvent(parsed, {
          appVersion: parsed.appVersion,
          now: Number.isFinite(timestamp.getTime()) ? timestamp : new Date(),
        });
        exportedLines.push(serializeDiagnosticEvent(sanitized, maxLineBytes));
      } catch {
        // Ignore malformed or manually modified lines instead of exporting unsafe text.
      }
    }
  }
  if (!exportedLines.length) throw diagnosticsError("NO_DIAGNOSTICS");
  fs.writeFileSync(destination, `${exportedLines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    ok: true,
    path: destination,
    fileCount: files.length,
    bytes: fs.statSync(destination).size,
  };
}

function diagnosticFailure(error, fallback = "DIAGNOSTICS_FAILED") {
  return {
    ok: false,
    errorCode: diagnosticCode(error?.code, fallback, 64),
  };
}

function workbookLocation() {
  cachedWorkbookLocation ||= createWorkbookLocation({
    userDataPath: app.getPath("userData"),
    localAppDataPath: process.env.LOCALAPPDATA
      || path.join(app.getPath("home"), "AppData", "Local"),
    documentsPath: app.getPath("documents"),
  });
  return cachedWorkbookLocation;
}

function workbookPath() {
  const location = workbookLocation();
  location.ensureDirectories();
  return location.privateWorkbookPath;
}

function recoverWorkbookMigrationAtStartup() {
  try {
    return recoverWorkbookMigration(workbookPath());
  } catch (error) {
    console.error("Unable to recover workbook migration at startup", error);
    return {
      recovered: false,
      active: true,
      reason: String(error?.code || "WORKBOOK_MIGRATION_RECOVERY_FAILED"),
    };
  }
}

function workbookInfo() {
  const file = workbookPath();
  const stat = fs.existsSync(file) ? fs.statSync(file) : null;
  return { path: file, exists: !!stat, mtimeMs: stat?.mtimeMs || 0 };
}

function stableFileSnapshot(file, fsApi = fs) {
  const before = fsApi.statSync(file);
  const buffer = fsApi.readFileSync(file);
  const after = fsApi.statSync(file);
  if (before.size !== after.size || Math.abs(before.mtimeMs - after.mtimeMs) > 1) {
    const error = new Error("Excel changed while it was being read. Save and close it, then try Update again.");
    error.code = "EXCEL_CHANGED_DURING_READ";
    throw error;
  }
  return {
    buffer,
    size: after.size,
    mtimeMs: after.mtimeMs,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

function cloudResetRunId(value) {
  const runId = String(value || randomUUID()).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId)) {
    const error = new Error("CLOUD_RESET_RUN_ID_INVALID");
    error.code = "CLOUD_RESET_RUN_ID_INVALID";
    throw error;
  }
  return runId;
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeJsonAtomically(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

async function createCloudResetBackup({ runId, before, live }) {
  const location = workbookLocation();
  const root = path.join(location.backupDirectory, `cloud-reset-local-${runId}`);
  const stateRoot = path.join(root, "sync-state");
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const workbookFile = workbookPath();
  const workbookBackup = path.join(root, WORKBOOK_NAME);
  fs.copyFileSync(workbookFile, workbookBackup);
  if (sha256File(workbookFile) !== String(before.sha256 || "")) {
    throw Object.assign(new Error("CLOUD_RESET_WORKBOOK_CHANGED"), {
      code: "CLOUD_RESET_WORKBOOK_CHANGED",
    });
  }
  const storage = path.join(app.getPath("userData"), "central-sync");
  const archived = [];
  let outboxClientId = "";
  for (const name of ["outbox.json", "last-good-snapshot.json"]) {
    const source = path.join(storage, name);
    if (!fs.existsSync(source)) continue;
    const target = path.join(stateRoot, name);
    const sourceBefore = sha256File(source);
    fs.copyFileSync(source, target);
    const sourceAfter = sha256File(source);
    if (sourceBefore !== sourceAfter || sha256File(target) !== sourceBefore) {
      throw Object.assign(new Error("CLOUD_RESET_SYNC_STATE_CHANGED"), {
        code: "CLOUD_RESET_SYNC_STATE_CHANGED",
      });
    }
    if (name === "outbox.json") {
      try { outboxClientId = String(JSON.parse(fs.readFileSync(source, "utf8")).clientId || ""); } catch {}
    }
    archived.push({ name, path: target, sha256: sha256File(target) });
  }
  const manifest = {
    runId,
    createdAt: new Date().toISOString(),
    workbookPath: workbookFile,
    workbookSha256: sha256File(workbookBackup),
    workbookMtimeMs: Number(before.mtimeMs) || 0,
    clientId: location.clientId,
    preResetRevision: Number(before.sync?.revision) || null,
    preResetItemCount: Number(before.sync?.itemCount) || null,
    cloudRevision: Number(live.revision),
    cloudItemCount: live.items.length,
    outboxClientId,
    workbookMetadata: before.sync || {},
    baselineFingerprint: String(before.acknowledgedSemanticFingerprint || ""),
    archived,
  };
  writeJsonAtomically(path.join(root, "manifest.json"), manifest);
  return { ok: true, path: root, manifest, workbookBackup, stateRoot };
}

async function buildCloudResetReplacement({ runId, live }) {
  const file = workbookPath();
  const temporary = `${file}.tmp.xlsx`;
  fs.rmSync(temporary, { force: true });
  await writeBootstrapWorkbook(temporary, live);
  const workbook = await readWorkbookFile(temporary);
  return { ok: true, path: temporary, runId, workbook };
}

async function archiveCloudResetSyncState({ backup }) {
  const storage = path.join(app.getPath("userData"), "central-sync");
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  for (const name of ["outbox.json", "last-good-snapshot.json"]) {
    const source = path.join(storage, name);
    if (!fs.existsSync(source)) continue;
    const expected = backup.manifest?.archived?.find((entry) => entry.name === name)?.sha256;
    if (expected && sha256File(source) !== expected) {
      throw Object.assign(new Error("CLOUD_RESET_SYNC_STATE_CHANGED"), {
        code: "CLOUD_RESET_SYNC_STATE_CHANGED",
      });
    }
    const target = path.join(backup.stateRoot, `${name}.archived`);
    fs.renameSync(source, target);
  }
}

async function initializeCloudResetSyncState({ live, backup }) {
  const storage = path.join(app.getPath("userData"), "central-sync");
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  writeJsonAtomically(path.join(storage, "outbox.json"), {
    version: 2,
    clientId: String(backup?.manifest?.outboxClientId || randomUUID()),
    nextSeq: 1,
    nextHistorySeq: 1,
    entries: [],
    history: [],
  });
  writeJsonAtomically(path.join(storage, "last-good-snapshot.json"), live);
  centralSync = undefined;
}

async function verifyCloudResetLocal({ live, replacement, workbookFile }) {
  const expectedSha256 = String(replacement?.workbook?.sha256 || "").toLowerCase();
  const file = workbookFile || workbookPath();
  if (!expectedSha256 || !fs.existsSync(file)) return { ok: false };
  let actualSha256 = "";
  try {
    actualSha256 = sha256File(file).toLowerCase();
  } catch {
    return { ok: false };
  }
  if (actualSha256 !== expectedSha256) return { ok: false };
  return { ok: true, revision: Number(live.revision), itemCount: live.items.length };
}

async function rollbackCloudResetLocal({ backup }) {
  const file = workbookPath();
  const current = fs.existsSync(file) ? sha256File(file) : "";
  const temporary = `${file}.tmp.xlsx`;
  fs.copyFileSync(backup.workbookBackup, temporary);
  try {
    const expectedReplacement = String(backup.replacementSha256 || "");
    if (expectedReplacement && current !== expectedReplacement) {
      throw Object.assign(new Error("CLOUD_RESET_ROLLBACK_CONTENT_CHANGED"), {
        code: "CLOUD_RESET_ROLLBACK_CONTENT_CHANGED",
      });
    }
    replaceOpenWorkbookFile(file, temporary, { expectedSha256: current });
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    const latest = fs.existsSync(file) ? sha256File(file) : "";
    if (latest !== current) throw error;
    fs.copyFileSync(backup.workbookBackup, file);
  }
  const storage = path.join(app.getPath("userData"), "central-sync");
  for (const name of ["outbox.json", "last-good-snapshot.json"]) {
    const original = path.join(backup.stateRoot, name);
    const target = path.join(storage, name);
    fs.rmSync(target, { force: true });
    if (fs.existsSync(original)) fs.copyFileSync(original, target);
  }
  centralSync = undefined;
}

async function runCloudResetLocal(input = {}) {
  return workbookOperationGate.runReset(async () => {
    await writeQueue.catch(() => {});
    pendingWorkbookChange = null;
    if (workbookChangeTimer) clearTimeout(workbookChangeTimer);
    if (workbookRetryTimer) clearTimeout(workbookRetryTimer);
    suppressWatchUntil = Date.now() + 60_000;
    const runner = createCloudResetLocalRunner({
    expectedAuthorityId: readAlibabaCloudConfig().authorityId,
    readLiveSnapshot: () => centralSyncService().snapshot(false),
    readWorkbook: async () => {
      const prepared = await prepareCanonicalWorkbookUpdate({ allowWorkbookReadFallback: true });
      if (!prepared.ok) {
        throw Object.assign(new Error(prepared.errorCode || "CLOUD_RESET_WORKBOOK_PREPARE_FAILED"), {
          code: prepared.errorCode || "CLOUD_RESET_WORKBOOK_PREPARE_FAILED",
        });
      }
      return prepared;
    },
    acquireLock: () => {
      const lock = acquireWorkbookWriterLock(workbookPath());
      return () => lock.release();
    },
    backupLocalState: createCloudResetBackup,
    buildReplacement: buildCloudResetReplacement,
    discardReplacement: ({ replacement }) => fs.rmSync(replacement.path, { force: true }),
    replaceWorkbook: ({ replacement }) =>
      replaceOpenWorkbookFile(workbookPath(), replacement.path),
    archiveSyncState: archiveCloudResetSyncState,
      initializeFreshSyncState: initializeCloudResetSyncState,
      verify: verifyCloudResetLocal,
      rollback: rollbackCloudResetLocal,
      reload: async () => {},
    });
    return runner({ ...input, runId: cloudResetRunId(input.runId) });
  }, { cancelAutomaticSync: true });
}

function openExcelWorkbooks(options = {}) {
  if ((options.platform || process.platform) !== "win32") {
    return { running: false, ambiguous: false, workbooks: [] };
  }
  const run = options.execFileSync || execFileSync;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$processes=@(Get-Process EXCEL -ErrorAction SilentlyContinue)",
    "if($processes.Count -eq 0){[Console]::Out.Write('{\"running\":false,\"ambiguous\":false,\"workbooks\":[]}');exit}",
    "try{",
    "$excel=[Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')",
    "$books=@($excel.Workbooks|ForEach-Object{[pscustomobject]@{name=$_.Name;fullName=$_.FullName;saved=[bool]$_.Saved;readOnly=[bool]$_.ReadOnly}})",
    "[Console]::Out.Write(([pscustomobject]@{running=$true;ambiguous=$false;workbooks=$books}|ConvertTo-Json -Compress -Depth 4))",
    "}catch{",
    "$titles=@($processes|ForEach-Object{$_.MainWindowTitle})",
    "[Console]::Out.Write(([pscustomobject]@{running=$true;ambiguous=$true;workbooks=@();titles=$titles}|ConvertTo-Json -Compress -Depth 4))",
    "}",
  ].join(";");
  try {
    const output = run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command", script,
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    const parsed = JSON.parse(String(output || "{}").replace(/^\uFEFF/, ""));
    return {
      running: parsed.running === true,
      ambiguous: parsed.ambiguous === true,
      workbooks: Array.isArray(parsed.workbooks) ? parsed.workbooks : [],
      titles: Array.isArray(parsed.titles) ? parsed.titles : [],
    };
  } catch {
    return { running: true, ambiguous: true, workbooks: [], titles: [] };
  }
}

async function prepareCanonicalWorkbookUpdate(options = {}) {
  const file = options.file || workbookPath();
  const fsApi = options.fsApi || fs;
  const readPreparedWorkbook = options.readWorkbook || readWorkbookFile;
  if (!fsApi.existsSync(file)) {
    return { ok: false, errorCode: "EXCEL_CANONICAL_MISSING", error: `Excel file does not exist: ${file}`, path: file };
  }
  const excelState = options.excelState || openExcelWorkbooks(options);
  const sameName = excelState.workbooks.filter(
    (book) => String(book?.name || "").toLowerCase() === path.basename(file).toLowerCase(),
  );
  const canonical = path.resolve(file).toLowerCase();
  const wrongCopy = sameName.find(
    (book) => path.resolve(String(book?.fullName || "")).toLowerCase() !== canonical,
  );
  if (wrongCopy) {
    return {
      ok: false,
      errorCode: "EXCEL_WRONG_COPY_OPEN",
      error: `A different ${path.basename(file)} is open. Close it and open the live file from TEK STOCK.`,
      path: file,
      openPath: String(wrongCopy.fullName || ""),
    };
  }
  const canonicalOpen = sameName.some(
    (book) => path.resolve(String(book?.fullName || "")).toLowerCase() === canonical,
  );
  const ambiguousCanonical = excelState.ambiguous && (excelState.titles || []).some(
    (title) => String(title || "").toLowerCase().includes(path.basename(file).toLowerCase()),
  );
  if (isWorkbookLocked(file, fsApi) || canonicalOpen || ambiguousCanonical) {
    try {
      const saveLive = options.saveOpenWorkbook || saveOpenWorkbook;
      await saveLive(file, options);
    } catch (error) {
      return {
        ok: false,
        errorCode: "EXCEL_LIVE_SAVE_FAILED",
        error: "Save the live Excel file, then press Update again. You do not need to close Excel.",
        detail: String(error?.message || "OPEN_WORKBOOK_AUTOMATION_FAILED").slice(0, 120),
        path: file,
      };
    }
  }
  try {
    const prepared = await readPreparedWorkbook(file);
    if (prepared?.ok || options.allowWorkbookReadFallback !== true) return prepared;
    return await readWorkbookStructureForReset(file, { fsApi });
  } catch (error) {
    if (options.allowWorkbookReadFallback === true) {
      return readWorkbookStructureForReset(file, { fsApi });
    }
    return {
      ok: false,
      errorCode: "EXCEL_READ_FAILED",
      error: "Excel 文件暂时无法读取；请先保存 WPS/Excel 后按 Update 重试。",
      detail: String(error?.code || error?.message || "WORKBOOK_READ_FAILED").slice(0, 120),
      path: file,
    };
  }
}

async function prepareCanonicalWorkbookUpdateIpc(options = {}) {
  const prepareUpdate = options.prepareUpdate || prepareCanonicalWorkbookUpdate;
  try {
    const prepared = await prepareUpdate();
    if (prepared?.ok !== true) {
      return {
        ok: false,
        errorCode: String(prepared?.errorCode || "EXCEL_PREPARE_FAILED").slice(0, 80),
        error: String(prepared?.error || "Excel preparation failed; save WPS/Excel and press Update again.").slice(0, 240),
        detail: String(prepared?.detail || "").slice(0, 120),
        path: String(prepared?.path || "").slice(0, 520),
      };
    }
    return {
      ok: true,
      errorCode: "",
      detail: "",
      path: String(prepared.path || "").slice(0, 520),
      sha256: String(prepared.sha256 || "").slice(0, 64),
      size: Number.isFinite(Number(prepared.size)) ? Number(prepared.size) : 0,
      mtimeMs: Number.isFinite(Number(prepared.mtimeMs)) ? Number(prepared.mtimeMs) : 0,
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: "EXCEL_PREPARE_FAILED",
      error: "Excel preparation failed; save WPS/Excel and press Update again.",
      detail: String(error?.code || error?.message || "EXCEL_PREPARE_FAILED").slice(0, 120),
      path: "",
    };
  }
}

async function readWorkbookStructureForReset(file, options = {}) {
  const fsApi = options.fsApi || fs;
  try {
    const snapshot = stableFileSnapshot(file, fsApi);
    JSZip ||= require("jszip");
    const zip = await JSZip.loadAsync(snapshot.buffer);
    const required = ["[Content_Types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"];
    if (required.some((name) => !zip.file(name))) throw new Error("XLSX_STRUCTURE_MISSING");
    const workbookXml = await zip.file("xl/workbook.xml").async("string");
    if (!workbookXml.includes(`name="${SHEET_NAME}"`)) throw new Error("XLSX_CANONICAL_SHEET_MISSING");
    return {
      ok: true,
      path: file,
      sha256: snapshot.sha256,
      size: snapshot.size,
      mtimeMs: snapshot.mtimeMs,
      items: [],
      rawItems: [],
      sync: {},
      baseline: { records: [] },
      resetReadFallback: true,
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: "EXCEL_WORKBOOK_STRUCTURE_INVALID",
      error: "The canonical workbook is not a valid TEK STOCK workbook.",
      detail: String(error?.code || error?.message || "XLSX_STRUCTURE_INVALID").slice(0, 120),
      path: file,
    };
  }
}

function readUserEnvironmentSecret(name) {
  if (process.env[name]) return process.env[name];
  try {
    const output = execFileSync(
      "reg.exe",
      ["query", "HKCU\\Environment", "/v", name],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const match = output.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)$`, "mi"));
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

function credentialsPath() {
  return path.join(app.getPath("userData"), CREDENTIALS_NAME);
}

function readStoredUploadToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return "";
    const file = credentialsPath();
    if (!fs.existsSync(file)) return "";
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!payload?.uploadToken) return "";
    return safeStorage.decryptString(Buffer.from(payload.uploadToken, "base64"));
  } catch {
    return "";
  }
}

function storeUploadToken(token) {
  const normalized = String(token || "").trim();
  if (!normalized) return { ok: false, error: "同步密钥不能为空" };
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: "此电脑无法安全保存同步密钥" };
  }
  const file = credentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const encrypted = safeStorage.encryptString(normalized).toString("base64");
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, uploadToken: encrypted }, null, 2)}\n`, "utf8");
  return { ok: true };
}

function clearStoredUploadToken() {
  try {
    fs.rmSync(credentialsPath(), { force: true });
    return { ok: true };
  } catch {
    return { ok: false, error: "同步密钥无法清除" };
  }
}

function readAlibabaCloudConfig(options = {}) {
  return readAlibabaCloudConfigFiles({
    fsApi: options.fsApi || fs,
    userDataPath: options.userDataPath || app.getPath("userData"),
    packagedConfigPath: options.packagedConfigPath
      || path.join(__dirname, "inventory", "alibaba-cloud.json"),
    env: options.env || process.env,
  });
}

function centralSyncService() {
  if (centralSync) return centralSync;
  const storageDirectory = path.join(app.getPath("userData"), "central-sync");
  centralSync = createCentralSync({
    storageDirectory,
    getApiBaseUrl: () => readAlibabaCloudConfig().apiBaseUrl,
    getApiFallbackBaseUrls: () => readAlibabaCloudConfig().apiFallbackBaseUrls,
    getAuthorityId: () => readAlibabaCloudConfig().authorityId,
    getOssBaseUrl: () => readAlibabaCloudConfig().ossPublicBaseUrl,
    getToken: () => readStoredUploadToken() || readUserEnvironmentSecret("TEK_STOCK_UPLOAD_TOKEN"),
  });
  return centralSync;
}

const SYNC_ITEM_FIELDS = new Set([
  "model", "category", "stock", "stockText", "showroomQuantity",
  "computedTotalSold", "totalSold", "cost", "sellingPrice", "sellingPriceText",
  "specification", "arrival", "showroom", "outbound", "sourceFile", "sourceSheet",
  "image", "imageSha256", "imageVersion",
]);
const SYNC_BINDING_FIELDS = new Set(["sourceFile", "sourceSheet"]);
const SAFE_SYNC_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const SAFE_SYNC_OP_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function syncResolutionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && expected.every((key, index) => actual[index] === key);
}

function validateSyncConflictResolution(payload) {
  if (!hasExactKeys(payload, ["opId", "resolutions"])) {
    throw syncResolutionError("SYNC_RESOLUTION_INVALID");
  }
  const opId = String(payload.opId || "").trim();
  if (!SAFE_SYNC_OP_ID.test(opId) || !Array.isArray(payload.resolutions)
      || payload.resolutions.length < 1 || payload.resolutions.length > 100) {
    throw syncResolutionError("SYNC_RESOLUTION_INVALID");
  }
  const seen = new Set();
  const resolutions = payload.resolutions.map((resolution) => {
    if (!hasExactKeys(resolution, ["choice", "field", "itemId"])) {
      throw syncResolutionError("SYNC_RESOLUTION_INVALID");
    }
    const itemId = String(resolution.itemId || "").trim();
    const field = String(resolution.field || "").trim();
    const choice = String(resolution.choice || "").trim();
    const key = `${itemId}\u0000${field}`;
    if (!SAFE_SYNC_ID.test(itemId) || !SYNC_CONFLICT_FIELDS.has(field)
        || !SYNC_CONFLICT_CHOICES.has(choice) || seen.has(key)) {
      throw syncResolutionError("SYNC_RESOLUTION_INVALID");
    }
    seen.add(key);
    return { itemId, field, choice };
  });
  return { opId, resolutions };
}

function validatePhotoReplacementPayload(payload) {
  if (!hasExactKeys(payload, ["dataUrl", "imageSha256", "imageVersion", "itemId"])) {
    throw syncResolutionError("PHOTO_INPUT_INVALID");
  }
  const itemId = String(payload.itemId || "").trim();
  const dataUrl = String(payload.dataUrl || "");
  const imageSha256 = String(payload.imageSha256 || "").trim().toLowerCase();
  const imageVersion = String(payload.imageVersion || "").trim();
  if (!SAFE_SYNC_ID.test(itemId) || dataUrl.length > 22_000_000
      || !/^data:image\/(?:webp|png|jpeg);base64,[a-z0-9+/=]+$/i.test(dataUrl)
      || (imageSha256 && !/^[a-f0-9]{64}$/.test(imageSha256))
      || imageVersion.length > 128 || /[\\/:]/.test(imageVersion)) {
    throw syncResolutionError("PHOTO_INPUT_INVALID");
  }
  return { itemId, dataUrl, imageSha256, imageVersion };
}

function sameSyncValue(left, right) {
  const canonical = (value) => value == null || value === "" ? null : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sameCanonicalSyncItem(left, right) {
  return sameSyncValue(left?.id, right?.id)
    && [...SYNC_ITEM_FIELDS].every((field) => sameSyncValue(left?.[field], right?.[field]));
}

function requestedWorkbookItems(entry) {
  const order = (entry.baseItems || []).map((item) => String(item.id));
  const items = new Map((entry.baseItems || []).map((item) => [String(item.id), { ...item }]));
  for (const operation of entry.operations || []) {
    if (operation.type === "delete") {
      items.delete(String(operation.itemId));
      continue;
    }
    const item = operation.item && { ...operation.item };
    const itemId = String(item?.id || "");
    if (!itemId) continue;
    if (!items.has(itemId)) order.push(itemId);
    items.set(itemId, item);
  }
  return { items, order };
}

function rawConflictEntries(service) {
  return (service.outbox.snapshot().entries || []).filter((entry) =>
    entry?.state === "conflict" && ["workbook", "image"].includes(entry?.type));
}

function durableConflictIdentity(entry) {
  if (entry?.type === "image") return `image\u0000${String(entry.itemId || "")}`;
  const details = (Array.isArray(entry?.conflictDetails) ? entry.conflictDetails : [])
    .map((detail) => ({
      itemId: String(detail?.itemId || ""),
      field: String(detail?.field || ""),
      reason: String(detail?.reason || ""),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return `workbook\u0000${JSON.stringify(details)}`;
}

function conflictEntries(service) {
  const newest = new Map();
  for (const entry of rawConflictEntries(service)) {
    const key = durableConflictIdentity(entry);
    const prior = newest.get(key);
    const entryTime = Date.parse(entry.updatedAt || entry.createdAt || "") || 0;
    const priorTime = Date.parse(prior?.updatedAt || prior?.createdAt || "") || 0;
    if (!prior || entryTime >= priorTime) newest.set(key, entry);
  }
  return [...newest.values()];
}

function acknowledgeWorkbookConflictFamily(service, resolvedEntry, commitRevision) {
  const identity = durableConflictIdentity(resolvedEntry);
  for (const candidate of rawConflictEntries(service)) {
    if (candidate.type === "workbook" && durableConflictIdentity(candidate) === identity) {
      service.outbox.acknowledge(candidate.opId, { commitRevision });
    }
  }
  if (typeof service.outbox.pruneAcknowledged === "function") {
    service.outbox.pruneAcknowledged();
  }
}

function canonicalPhotoHash(source) {
  const digest = String(source?.imageSha256 || source?.sha256 || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(digest) ? digest : "";
}

function formatDurableConflictEntry(entry, latest) {
  if (entry.type === "image") {
    const cloudItem = (latest.items || []).find((item) => String(item.id) === String(entry.itemId));
    const baseHash = canonicalPhotoHash(entry.baseItem);
    const excelHash = canonicalPhotoHash(entry.image);
    const cloudHash = canonicalPhotoHash(cloudItem);
    const formatted = {
      opId: entry.opId,
      conflictCode: String(entry.conflictCode || "CONCURRENT_MODIFICATION"),
      conflicts: [],
    };
    if (!cloudItem || !excelHash) {
      formatted.unresolvable = 1;
      return formatted;
    }
    formatted.conflicts.push(formatConflict({
      itemId: String(entry.itemId),
      model: cloudItem.model || entry.baseItem?.model,
      field: "image",
      base: baseHash,
      excel: excelHash,
      cloud: cloudHash,
    }));
    return formatted;
  }
  const base = new Map((entry.baseItems || []).map((item) => [String(item.id), item]));
  const desired = requestedWorkbookItems(entry).items;
  const cloud = new Map((latest.items || []).map((item) => [String(item.id), item]));
  const conflicts = [];
  let unresolvable = 0;
  for (const detail of entry.conflictDetails || []) {
    const itemId = String(detail?.itemId || "").trim();
    const field = String(detail?.field || "").trim();
    const deleteConflict = !field && detail?.reason === "delete-modified-live";
    if (deleteConflict && SAFE_SYNC_ID.test(itemId)) {
      const baseItem = base.get(itemId);
      const cloudItem = cloud.get(itemId);
      if (!baseItem || !cloudItem || desired.has(itemId)) {
        unresolvable += 1;
        continue;
      }
      conflicts.push(formatConflict({
        itemId,
        model: cloudItem.model || baseItem.model,
        field: SYNC_DELETE_CONFLICT_FIELD,
        base: "保留",
        excel: "删除",
        cloud: "保留（云端已修改）",
      }));
      continue;
    }
    if (!SAFE_SYNC_ID.test(itemId) || !SYNC_CONFLICT_FIELDS.has(field)) {
      unresolvable += 1;
      continue;
    }
    const baseItem = base.get(itemId);
    const desiredItem = desired.get(itemId);
    const cloudItem = cloud.get(itemId);
    if (!baseItem || !desiredItem || !cloudItem) {
      unresolvable += 1;
      continue;
    }
    conflicts.push(formatConflict({
      itemId,
      model: cloudItem.model || desiredItem.model || baseItem.model,
      field,
      base: baseItem[field],
      excel: desiredItem[field],
      cloud: cloudItem[field],
    }));
  }
  const formatted = {
    opId: entry.opId,
    conflictCode: String(entry.conflictCode || "CONCURRENT_MODIFICATION"),
    conflicts,
  };
  if (unresolvable) formatted.unresolvable = unresolvable;
  return formatted;
}

async function listSyncConflicts(service = centralSyncService()) {
  const entries = conflictEntries(service);
  if (!entries.length) return [];
  const latest = await service.snapshot(false);
  return entries.map((entry) => formatDurableConflictEntry(entry, latest));
}

function resolvedWorkbookOperations(entry, latest, resolutions) {
  const base = new Map((entry.baseItems || []).map((item) => [String(item.id), item]));
  const desired = requestedWorkbookItems(entry);
  const cloudOrder = (latest.items || []).map((item) => String(item.id));
  const cloud = new Map((latest.items || []).map((item) => [String(item.id), { ...item }]));
  const result = new Map((latest.items || []).map((item) => [String(item.id), { ...item }]));
  const choices = new Map(resolutions.map((resolution) =>
    [`${resolution.itemId}\u0000${resolution.field}`, resolution.choice]));
  const requiredChoices = new Set((entry.conflictDetails || []).flatMap((detail) => {
    const itemId = String(detail?.itemId || "");
    if (detail?.field) return [`${itemId}\u0000${detail.field}`];
    return detail?.reason === "delete-modified-live"
      ? [`${itemId}\u0000${SYNC_DELETE_CONFLICT_FIELD}`]
      : [];
  }));
  const restoresCloudDeletion = (entry.conflictDetails || []).some((detail) => {
    if (detail?.reason !== "delete-modified-live") return false;
    const itemId = String(detail?.itemId || "");
    return choices.get(`${itemId}\u0000${SYNC_DELETE_CONFLICT_FIELD}`) === "keep-cloud";
  });

  for (const operation of entry.operations || []) {
    if (operation.type === "delete") {
      const itemId = String(operation.itemId || "");
      const cloudItem = cloud.get(itemId);
      if (!cloudItem) continue;
      const choiceKey = `${itemId}\u0000${SYNC_DELETE_CONFLICT_FIELD}`;
      if (requiredChoices.has(choiceKey)) {
        const choice = choices.get(choiceKey);
        if (choice === "keep-cloud") continue;
        if (choice !== "keep-excel") throw syncResolutionError("SYNC_RESOLUTIONS_INCOMPLETE");
      } else {
        const baseItem = base.get(itemId);
        if (!baseItem || !sameCanonicalSyncItem(baseItem, cloudItem)) {
          throw syncResolutionError("SYNC_CONFLICT_UNRESOLVABLE");
        }
      }
      result.delete(itemId);
      continue;
    }
    const wanted = desired.items.get(String(operation.item?.id || ""));
    const itemId = String(wanted?.id || "");
    const baseItem = base.get(itemId);
    const cloudItem = cloud.get(itemId);
    if (!baseItem) {
      if (!cloudItem) {
        const newItem = { ...wanted };
        result.set(itemId, newItem);
        cloudOrder.push(itemId);
      } else if (!sameSyncValue(cloudItem, wanted)) {
        throw syncResolutionError("SYNC_CONFLICT_UNRESOLVABLE");
      }
      continue;
    }
    if (!cloudItem) throw syncResolutionError("SYNC_CONFLICT_UNRESOLVABLE");
    const merged = { ...cloudItem };
    for (const field of SYNC_ITEM_FIELDS) {
      if (restoresCloudDeletion && SYNC_BINDING_FIELDS.has(field)) continue;
      if (sameSyncValue(wanted[field], baseItem[field])) continue;
      const explicitChoice = choices.get(`${itemId}\u0000${field}`);
      if (explicitChoice === "keep-cloud") continue;
      if (explicitChoice === "keep-excel") {
        if (wanted[field] === undefined) delete merged[field];
        else merged[field] = wanted[field];
        continue;
      }
      const cloudAlsoChanged = !sameSyncValue(cloudItem[field], baseItem[field])
        && !sameSyncValue(cloudItem[field], wanted[field]);
      if (cloudAlsoChanged) {
        throw syncResolutionError("SYNC_RESOLUTIONS_INCOMPLETE");
      }
      if (wanted[field] === undefined) delete merged[field];
      else merged[field] = wanted[field];
    }
    result.set(itemId, merged);
  }

  const operations = [];
  for (const itemId of cloudOrder) {
    const before = cloud.get(itemId);
    const after = result.get(itemId);
    if (before && !after) operations.push({ type: "delete", itemId });
    else if (after && !sameSyncValue(before, after)) operations.push({ type: "upsert", item: after });
  }
  for (const [itemId, item] of result) {
    if (!cloud.has(itemId)) operations.push({ type: "upsert", item });
  }
  return operations;
}

async function replaceResolvedWorkbook(replaceWorkbook, snapshot, entry) {
  const result = await replaceWorkbook({
    items: snapshot.items,
    sync: {
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      imageSetVersion: snapshot.imageSetVersion || "",
    },
    ackPlan: { expectedSha256: entry.workbookSha256, rows: [] },
  });
  if (result?.ok !== true) {
    throw syncResolutionError("WORKBOOK_REPLACEMENT_NOT_ACKNOWLEDGED");
  }
  return true;
}

function resolutionOperationState(service, opId) {
  const entries = service.outbox.snapshot().entries || [];
  const history = typeof service.outbox.history === "function"
    ? service.outbox.history()
    : (typeof service.history === "function" ? service.history() : []);
  const visited = new Set();
  let currentOpId = opId;
  while (currentOpId && !visited.has(currentOpId) && visited.size < 10) {
    visited.add(currentOpId);
    const entry = entries.find((candidate) => candidate.opId === currentOpId);
    if (entry) return entry.state;
    if (history.some((event) => event.opId === currentOpId && event.lifecycle === "acked")) {
      return "acked";
    }
    const rebased = [...history].reverse().find((event) =>
      event.opId === currentOpId && event.lifecycle === "rebased"
      && event.result?.nextOpId);
    currentOpId = String(rebased?.result?.nextOpId || "");
  }
  return "missing";
}

async function flushResolutionOperation(service, opId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (typeof service.flushOperation === "function") {
      await service.flushOperation(opId, {
        supersedeEarlierWorkbooks: true,
        supersessionReason: "explicit-conflict-resolution",
      });
    } else {
      await service.flush();
    }
    const state = resolutionOperationState(service, opId);
    if (state === "acked") return;
    if (state === "conflict") throw syncResolutionError("SYNC_RESOLUTION_CONFLICT");
    if (!["pending", "sent"].includes(state)) {
      throw syncResolutionError("SYNC_RESOLUTION_NOT_ACKNOWLEDGED");
    }
  }
  throw syncResolutionError("SYNC_RESOLUTION_NOT_ACKNOWLEDGED");
}

async function resolveSyncConflict(payload, options = {}) {
  const request = validateSyncConflictResolution(payload);
  const service = options.service || centralSyncService();
  const entry = conflictEntries(service).find((candidate) => candidate.opId === request.opId);
  if (!entry) throw syncResolutionError("SYNC_CONFLICT_NOT_FOUND");
  const latest = typeof service.canonicalSnapshot === "function"
    ? await service.canonicalSnapshot()
    : await service.snapshot(false);
  const formatted = formatDurableConflictEntry(entry, latest);
  if (formatted.unresolvable || !formatted.conflicts.length) {
    throw syncResolutionError("SYNC_CONFLICT_UNRESOLVABLE");
  }
  const required = new Set(formatted.conflicts.map((conflict) =>
    `${conflict.itemId}\u0000${conflict.field}`));
  const supplied = new Set(request.resolutions.map((resolution) =>
    `${resolution.itemId}\u0000${resolution.field}`));
  if (required.size !== supplied.size || [...required].some((key) => !supplied.has(key))) {
    throw syncResolutionError("SYNC_RESOLUTIONS_INCOMPLETE");
  }
  if (entry.type === "image") {
    const resolution = request.resolutions[0];
    if (resolution.choice === "keep-excel") {
      const latestItem = latest.items.find((item) => String(item.id) === String(entry.itemId));
      if (!latestItem || typeof service.outbox.rebaseImageMutation !== "function") {
        throw syncResolutionError("SYNC_CONFLICT_UNRESOLVABLE");
      }
      const rebased = service.outbox.rebaseImageMutation(entry.opId, {
        baseItem: latestItem,
        baseRevision: latest.revision,
      });
      await flushResolutionOperation(service, rebased.opId);
    } else if (resolution.choice === "keep-cloud") {
      service.outbox.acknowledge(entry.opId, { commitRevision: latest.revision });
      service.outbox.pruneAcknowledged();
    } else {
      throw syncResolutionError("SYNC_RESOLUTION_INVALID");
    }
    const confirmed = await service.snapshot(false);
    const replaceWorkbook = options.replaceWorkbook || queueWorkbookWrite;
    let workbookReplaced = false;
    try {
      const result = await replaceWorkbook({
        items: confirmed.items,
        sync: {
          revision: confirmed.revision,
          updatedAt: confirmed.updatedAt,
          imageSetVersion: confirmed.imageSetVersion || "",
        },
        ackPlan: { expectedSha256: entry.workbookSha256, rows: [] },
      });
      workbookReplaced = result?.ok === true;
    } catch {
      workbookReplaced = false;
    }
    return { ok: true, revision: confirmed.revision, workbookReplaced };
  }
  const operations = resolvedWorkbookOperations(entry, latest, request.resolutions);
  const replaceWorkbook = options.replaceWorkbook || queueWorkbookWrite;
  if (!operations.length) {
    // Choosing cloud can be a pure local reconciliation. Rewrite Excel first so
    // a binding failure cannot discard the only durable conflict or manufacture
    // a meaningless upsert/revision bump.
    await replaceResolvedWorkbook(replaceWorkbook, latest, entry);
    acknowledgeWorkbookConflictFamily(service, entry, latest.revision);
    return {
      ok: true,
      revision: latest.revision,
      workbookReplaced: true,
      apiWritePerformed: false,
      resolvedItemIds: [...new Set(request.resolutions.map((resolution) => resolution.itemId))],
    };
  }
  const rebased = service.outbox.rebaseWorkbookTransaction(entry.opId, {
    operations,
    baseRevision: latest.revision,
    baseItems: latest.items,
    explicitResolution: true,
    resolutionOfOpId: entry.opId,
  });
  await flushResolutionOperation(service, rebased.opId);
  const confirmed = await service.snapshot(false);
  await replaceResolvedWorkbook(replaceWorkbook, confirmed, entry);
  acknowledgeWorkbookConflictFamily(service, entry, confirmed.revision);
  return {
    ok: true,
    revision: confirmed.revision,
    workbookReplaced: true,
    apiWritePerformed: true,
    resolvedItemIds: [...new Set(request.resolutions.map((resolution) => resolution.itemId))],
  };
}

async function resolveSyncConflictIpc(payload, options = {}) {
  try {
    return await resolveSyncConflict(payload, options);
  } catch (error) {
    const candidate = String(error?.code || "SYNC_RESOLUTION_FAILED").trim();
    return {
      ok: false,
      errorCode: /^[A-Z0-9_]{1,80}$/.test(candidate)
        ? candidate
        : "SYNC_RESOLUTION_FAILED",
    };
  }
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(String(value).replace(/S\$|SGD|RM|,/gi, "").trim());
  return Number.isFinite(number) ? number : null;
}

function numericCellValue(cell) {
  const value = cell?.value;
  if (value && typeof value === "object" && value.result != null) {
    return asNumber(value.result);
  }
  return asNumber(value);
}

function cellText(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
    if (value.result != null) return String(value.result);
  }
  return String(value);
}

function packagedImageForItem(itemId) {
  if (!packagedImageMap) {
    try {
      const lockPath = path.join(__dirname, "inventory", "photo-lock.json");
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      packagedImageMap = new Map(
        Object.entries(lock.items || {}).map(([id, value]) => [id, String(value?.image || "")]),
      );
    } catch {
      packagedImageMap = new Map();
    }
  }
  return packagedImageMap.get(itemId) || "";
}

function downloadBuffer(url, redirectsLeft = 4, transports = {}) {
  const preferredElectronNet = transports.electronNet === undefined
    ? electronNet
    : transports.electronNet;
  const httpsModule = transports.httpsModule || https;
  const timeoutMs = Number(transports.timeoutMs) || 20000;

  if (preferredElectronNet && typeof preferredElectronNet.request === "function") {
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = preferredElectronNet.request({ method: "GET", url });
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        try {
          request.abort();
        } catch {
          // Ignore an abort race after the request has already closed.
        }
        finish(reject, new Error("Image download timed out"));
      }, timeoutMs);

      request.on("response", (response) => {
        const status = Number(response.statusCode || 0);
        if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
          response.resume?.();
          finish(
            resolve,
            downloadBuffer(
              new URL(response.headers.location, url).toString(),
              redirectsLeft - 1,
              transports,
            ),
          );
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume?.();
          finish(reject, new Error(`Image download failed with HTTP ${status}`));
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => finish(resolve, Buffer.concat(chunks)));
        response.on("error", (error) => finish(reject, error));
      });
      request.on("error", (error) => finish(reject, error));
      request.end();
    });
  }

  return new Promise((resolve, reject) => {
    const request = httpsModule.get(url, (response) => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
        response.resume();
        resolve(downloadBuffer(
          new URL(response.headers.location, url).toString(),
          redirectsLeft - 1,
          transports,
        ));
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Image download failed with HTTP ${status}`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Image download timed out")));
    request.on("error", reject);
  });
}

async function normalizeImageToPng(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(224, 152, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

async function imageBufferForItem(item, usePackagedImages = false, options = {}) {
  const packagedImage = usePackagedImages ? packagedImageForItem(item.id) : "";
  const candidates = [...new Set(
    [String(item.image || ""), packagedImage].filter(Boolean),
  )];
  for (const image of candidates) {
    try {
      let buffer;
      if (/^https?:\/\//i.test(image)) {
        buffer = await downloadBuffer(image, 4, options.transports || {});
      } else if (/^file:\/\//i.test(image)) {
        const local = path.resolve(fileURLToPath(new URL(image)));
        const cacheRoot = path.resolve(app.getPath("userData"), "central-sync", "photo-cache");
        const relative = path.relative(cacheRoot, local);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(local)) continue;
        buffer = fs.readFileSync(local);
      } else if (/^data:image\//i.test(image)) {
        buffer = Buffer.from(image.slice(image.indexOf(",") + 1), "base64");
      } else {
        const local = path.join(__dirname, "inventory", image.replaceAll("/", path.sep));
        if (!fs.existsSync(local)) continue;
        buffer = fs.readFileSync(local);
      }
      return await normalizeImageToPng(buffer);
    } catch {
      // Try the packaged copy, then the photo already embedded in Excel.
    }
  }
  if (!options.existingImageBuffer) return null;
  try {
    return await normalizeImageToPng(Buffer.from(options.existingImageBuffer));
  } catch {
    return null;
  }
}

async function mapWithConcurrency(values, limit, mapper) {
  const items = Array.from(values || []);
  if (!items.length) return [];
  const output = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  };
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return output;
}

function styleHeader(row) {
  row.height = 30;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF146C68" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD9DED9" } },
      left: { style: "thin", color: { argb: "FFD9DED9" } },
      bottom: { style: "thin", color: { argb: "FFD9DED9" } },
      right: { style: "thin", color: { argb: "FFD9DED9" } },
    };
  });
}

function normalizeWorkbookPayload(payload) {
  if (Array.isArray(payload)) return { items: payload, sync: {} };
  return {
    items: Array.isArray(payload?.items) ? payload.items : [],
    sync: payload?.sync && typeof payload.sync === "object" ? payload.sync : {},
  };
}

function workbookBaselineRecord(item, imageHash = "") {
  return {
    category: String(item?.category || ""),
    model: String(item?.model || ""),
    stock: Number.isFinite(Number(item?.stock)) ? Number(item.stock) : null,
    stockText: String(item?.stockText || ""),
    showroomQuantity: Number.isFinite(Number(item?.showroomQuantity)) ? Number(item.showroomQuantity) : null,
    computedTotalSold: Number.isFinite(Number(item?.computedTotalSold)) ? Number(item.computedTotalSold) : null,
    cost: item?.cost == null || item.cost === "" ? null : Number(item.cost),
    sellingPrice: item?.sellingPrice == null || item.sellingPrice === "" ? null : Number(item.sellingPrice),
    sellingPriceText: String(item?.sellingPriceText || ""),
    specification: String(item?.specification || ""),
    arrival: String(item?.arrival || ""),
    showroom: String(item?.showroom || ""),
    outbound: String(item?.outbound || ""),
    totalSold: Number.isFinite(Number(item?.totalSold)) ? Number(item.totalSold) : null,
    sourceFile: String(item?.sourceFile || ""),
    sourceSheet: String(item?.sourceSheet || ""),
    sourceRow: Number.isFinite(Number(item?.sourceRow)) ? Number(item.sourceRow) : null,
    image: String(item?.canonicalImage ?? item?.image ?? ""),
    imageSha256: String(item?.imageSha256 || "").toLowerCase(),
    imageVersion: String(item?.imageVersion || ""),
    imageHash: String(imageHash || ""),
  };
}

async function buildWorkbook(payload, options = {}) {
  const { items, sync } = normalizeWorkbookPayload(payload);
  const workbookId = String(sync.workbookId || options.workbookId || `wb-${randomUUID()}`).trim();
  const usePackagedImages = String(sync.imageSetVersion || "") === PACKAGED_IMAGE_SET_VERSION;
  const existingImagesById = options.existingImagesById instanceof Map
    ? options.existingImagesById
    : new Map();
  const workbook = createExcelWorkbook();
  workbook.creator = "TEK STOCK";
  workbook.company = "HP SOFA";
  workbook.subject = "Singapore live inventory";
  workbook.created = new Date();
  workbook.modified = new Date();

  const sheet = workbook.addWorksheet(SHEET_NAME, {
    views: [{ state: "frozen", xSplit: 0, ySplit: 4 }],
    properties: { defaultRowHeight: 20 },
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.mergeCells("A1:O1");
  sheet.getCell("A1").value = "TEK STOCK 新加坡库存总表";
  sheet.getCell("A1").font = { bold: true, size: 20, color: { argb: "FF0E5754" } };
  sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 34;
  sheet.mergeCells("A2:O2");
  sheet.getCell("A2").value = `实时工作簿 · APP 与 Excel 双向同步 · ${new Date().toLocaleString("zh-SG")}`;
  sheet.getCell("A2").font = { size: 10, color: { argb: "FF6F7774" } };
  sheet.getRow(2).height = 22;

  const headers = [
    "照片", "Item ID", "分类", "型号", "目前库存", "展厅数量", "累计已售",
    "成本 (S$)", "售价 (S$)", "规格", "来货记录", "Showroom", "Outbound", "Manual Sold",
    "Image Hash",
  ];
  sheet.addRow([]);
  const header = sheet.addRow(headers);
  styleHeader(header);
  sheet.columns = [
    { width: 18 }, { width: 20, hidden: true }, { width: 16 }, { width: 28 },
    { width: 11 }, { width: 11 }, { width: 11 }, { width: 12 }, { width: 12 },
    { width: 28 }, { width: 34 }, { width: 42 }, { width: 54 }, { width: 12, hidden: true },
    { width: 20, hidden: true },
  ];
  sheet.autoFilter = { from: "A4", to: "O4" };

  const imageBuffers = await mapWithConcurrency(
    items,
    8,
    (item) => imageBufferForItem(item, usePackagedImages, {
      existingImageBuffer: item?.photoCachePending
        ? undefined
        : existingImagesById.get(String(item.id || "")),
    }),
  );
  const baseline = workbook.addWorksheet("_TEK_BASELINE", { state: "veryHidden" });
  baseline.addRow(["id", "baseline"]);

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const rowNumber = index + 5;
    const row = sheet.addRow([
      "", item.id || "", item.category || "", item.model || "", Number(item.stock) || 0,
      Number(item.showroomQuantity) || 0, Number(item.computedTotalSold) || 0,
      item.cost ?? "", item.sellingPrice ?? item.sellingPriceText ?? "",
      item.specification || "", item.arrival || "", item.showroom || "", item.outbound || "",
      Number(item.totalSold) || 0, "",
    ]);
    row.height = 82;
    row.eachCell((cell, column) => {
      cell.alignment = {
        vertical: "middle",
        horizontal: [5, 6, 7, 8, 9, 14].includes(column) ? "center" : "left",
        wrapText: true,
      };
      cell.border = {
        top: { style: "hair", color: { argb: "FFE1E5E1" } },
        left: { style: "hair", color: { argb: "FFE1E5E1" } },
        bottom: { style: "hair", color: { argb: "FFE1E5E1" } },
        right: { style: "hair", color: { argb: "FFE1E5E1" } },
      };
      if (index % 2 === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF7F9F8" } };
      }
    });
    row.getCell(5).font = { bold: true, color: { argb: (Number(item.stock) || 0) <= 0 ? "FFD64545" : "FF154F4C" } };
    row.getCell(6).font = { bold: true, color: { argb: "FF2F80ED" } };
    row.getCell(7).font = { bold: true, color: { argb: "FFD64545" } };
    row.getCell(8).numFmt = '"S$" #,##0';
    row.getCell(9).numFmt = '"S$" #,##0';
    row.getCell(5).dataValidation = { type: "whole", operator: "between", formulae: [-9999, 999999] };

    const imageBuffer = imageBuffers[index];
    const imageHash = imageBuffer
      ? createHash("sha256").update(imageBuffer).digest("hex")
      : "";
    if (imageBuffer) {
      row.getCell(15).value = imageHash;
      const imageId = workbook.addImage({ buffer: imageBuffer, extension: "png" });
      sheet.addImage(imageId, {
        tl: { col: 0.08, row: rowNumber - 1 + 0.08 },
        ext: { width: 112, height: 76 },
        editAs: "oneCell",
      });
    }
    baseline.addRow([
      String(item.id || ""),
      JSON.stringify(workbookBaselineRecord(item, imageHash)),
    ]);
  }

  const meta = workbook.addWorksheet("_TEK_META", { state: "veryHidden" });
  meta.addRow(["schema", WORKBOOK_SCHEMA_VERSION]);
  meta.addRow(["workbookId", workbookId]);
  meta.addRow(["migrationVersion", WORKBOOK_MIGRATION_VERSION]);
  meta.addRow(["writtenAt", new Date().toISOString()]);
  meta.addRow(["itemCount", items.length]);
  meta.addRow(["revision", Number(sync.revision) || 0]);
  meta.addRow(["updatedAt", String(sync.updatedAt || "")]);
  meta.addRow(["imageSetVersion", String(sync.imageSetVersion || "")]);
  return workbook;
}

async function readExistingWorkbookImages(file) {
  const imagesById = new Map();
  if (!fs.existsSync(file)) return imagesById;
  try {
    const workbook = createExcelWorkbook();
    await loadExcelWorkbook(workbook, stableFileSnapshot(file).buffer);
    const sheet = workbook.getWorksheet(SHEET_NAME);
    if (!sheet) return imagesById;
    for (const placement of sheet.getImages()) {
      const rowNumber = Number(placement.range?.tl?.nativeRow) + 1;
      const itemId = cellText(sheet.getRow(rowNumber).getCell(2)).trim();
      const media = workbook.getImage(placement.imageId);
      if (itemId && media?.buffer?.length) {
        imagesById.set(itemId, Buffer.from(media.buffer));
      }
    }
  } catch {
    // A locked or damaged previous workbook must not block a clean rebuild.
  }
  return imagesById;
}

async function writeWorkbookNow(payload) {
  const file = workbookPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const initialSnapshot = stableFileSnapshot(file);
  const expectedSha256 = String(payload?.ackPlan?.expectedSha256 || initialSnapshot.sha256 || "")
    .trim()
    .toLowerCase();
  const existingImagesById = await readExistingWorkbookImages(file);
  let existingWorkbookId = "";
  if (fs.existsSync(file)) {
    try {
      const existing = await readWorkbookFile(file);
      existingWorkbookId = String(existing?.sync?.workbookId || "");
    } catch {}
  }
  const workbook = await buildWorkbook(payload, { existingImagesById, workbookId: existingWorkbookId });
  const temporary = `${file}.tmp.xlsx`;
  await workbook.xlsx.writeFile(temporary);
  try {
    if (expectedSha256 && stableFileSnapshot(file).sha256 !== expectedSha256) {
      throw new Error("WORKBOOK_CONTENT_CHANGED");
    }
    if (isWorkbookLocked(file)) {
      suppressWatchUntil = Date.now() + 5000;
      replaceOpenWorkbookFile(file, temporary, { expectedSha256 });
    } else {
      fs.renameSync(temporary, file);
    }
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    if (/OPEN_WORKBOOK_(?:HAS_UNSAVED_CHANGES|CHANGED_DURING_SYNC)/i
        .test(String(error?.code || error?.message || ""))) {
      const deferred = new Error("请先保存 Excel，云端更新随后自动合并。");
      deferred.code = "WORKBOOK_UNSAVED_CHANGES";
      throw deferred;
    }
    if (error.code === "EPERM" || error.code === "EBUSY"
        || /OPEN_WORKBOOK_/i.test(String(error?.message || ""))) {
      throw new Error("请先保存 Excel；TEK STOCK 会自动刷新并重新打开，不需要手动关闭。");
    }
    throw error;
  }
  suppressWatchUntil = Date.now() + 3000;
  suppressedWorkbookSha256 = stableFileSnapshot(file).sha256;
  watchWorkbook();
  return { ok: true, ...workbookInfo() };
}

function queueWorkbookWriteNow(payload) {
  writeQueue = writeQueue.catch(() => {}).then(() => writeWorkbookNow(payload));
  return writeQueue;
}

function queueWorkbookWrite(payload) {
  return workbookOperationGate.scheduleWrite(() => queueWorkbookWriteNow(payload));
}

async function readWorkbookFile(file) {
  const stat = fs.existsSync(file) ? fs.statSync(file) : null;
  const info = { path: file, exists: !!stat, mtimeMs: stat?.mtimeMs || 0 };
  if (!info.exists) return { ok: false, error: "Excel 文件不存在", ...info };
  const snapshot = stableFileSnapshot(file);
  const workbook = createExcelWorkbook();
  await loadExcelWorkbook(workbook, snapshot.buffer);
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) return { ok: false, error: `找不到工作表：${SHEET_NAME}`, ...info };
  const metaSheet = workbook.getWorksheet("_TEK_META");
  const baselineSheet = workbook.getWorksheet("_TEK_BASELINE");
  const baselinesById = new Map();
  let baselineRecordRows = 0;
  let baselineMalformed = false;
  let baselineDuplicateId = false;
  if (baselineSheet) {
    const maximumBaselineRecords = 10_000;
    for (let rowNumber = 2;
      rowNumber <= baselineSheet.rowCount && baselinesById.size < maximumBaselineRecords;
      rowNumber += 1) {
      const row = baselineSheet.getRow(rowNumber);
      const id = cellText(row.getCell(1)).trim();
      if (!id) continue;
      baselineRecordRows += 1;
      if (baselinesById.has(id)) baselineDuplicateId = true;
      try {
        const parsed = JSON.parse(cellText(row.getCell(2)));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          baselineMalformed = true;
          continue;
        }
        baselinesById.set(id, workbookBaselineRecord(parsed, parsed.imageHash));
      } catch {
        baselineMalformed = true;
        // A malformed baseline is treated as unavailable and therefore cannot authorize a stale merge.
      }
    }
  }
  const imagesByRow = new Map();
  for (const placement of sheet.getImages()) {
    const rowNumber = Number(placement.range?.tl?.nativeRow) + 1;
    const media = workbook.getImage(placement.imageId);
    if (!rowNumber || !media?.buffer) continue;
    const extension = String(media.extension || "png").toLowerCase();
    const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg"
      : extension === "webp" ? "image/webp" : "image/png";
    const buffer = Buffer.from(media.buffer);
    imagesByRow.set(rowNumber, {
      hash: createHash("sha256").update(buffer).digest("hex"),
      dataUrl: `data:${mime};base64,${buffer.toString("base64")}`,
    });
  }
  const meta = {};
  if (metaSheet) {
    for (let rowNumber = 1; rowNumber <= metaSheet.rowCount; rowNumber += 1) {
      const row = metaSheet.getRow(rowNumber);
      const key = cellText(row.getCell(1)).trim();
      if (key) meta[key] = cellText(row.getCell(2)).trim();
    }
  }
  const items = [];
  for (let rowNumber = 5; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const id = cellText(row.getCell(2)).trim();
    const model = cellText(row.getCell(4)).trim();
    if (!model) continue;
    const embeddedImage = imagesByRow.get(rowNumber);
    const storedImageHash = cellText(row.getCell(15)).trim();
    const imageUntracked = !!embeddedImage && !storedImageHash;
    const imageChanged = !!embeddedImage
      && ((!id && !storedImageHash)
        || (!!storedImageHash && embeddedImage.hash !== storedImageHash));
    const sellingPrice = numericCellValue(row.getCell(9));
    items.push({
      id,
      category: cellText(row.getCell(3)).trim(),
      model,
      stock: numericCellValue(row.getCell(5)),
      showroomQuantity: numericCellValue(row.getCell(6)),
      computedTotalSold: numericCellValue(row.getCell(7)),
      cost: numericCellValue(row.getCell(8)),
      sellingPrice,
      ...(sellingPrice == null ? { sellingPriceText: cellText(row.getCell(9)).trim() } : {}),
      specification: cellText(row.getCell(10)),
      arrival: cellText(row.getCell(11)),
      showroom: cellText(row.getCell(12)),
      outbound: cellText(row.getCell(13)),
      totalSold: numericCellValue(row.getCell(14)),
      image: imageChanged || imageUntracked ? embeddedImage.dataUrl : "",
      // Keep the embedded bytes available for cloud repair even when the
      // workbook hash says the picture itself has not changed. A previous
      // upload may have saved the Excel hash before OSS received the photo.
      embeddedImageDataUrl: embeddedImage?.dataUrl || "",
      embeddedImageHash: embeddedImage?.hash || "",
      imageChanged,
      imageUntracked,
      sourceFile: WORKBOOK_NAME,
      sourceSheet: SHEET_NAME,
      sourceRow: rowNumber,
      _baseline: baselinesById.get(id) || null,
    });
  }
  const rawItemIds = items.map((item) => String(item.id || "").trim());
  const nonBlankItemIds = rawItemIds.filter(Boolean);
  const itemIdsDuplicateFree = new Set(nonBlankItemIds).size === nonBlankItemIds.length;
  const itemIdsUnique = nonBlankItemIds.length === rawItemIds.length && itemIdsDuplicateFree;
  const baselineItemCount = meta.itemCount === undefined ? null : Number(meta.itemCount);
  const metaRevision = meta.revision === undefined || String(meta.revision).trim() === ""
    ? null
    : Number(meta.revision);
  const baselineCorrupt = !!baselineSheet && (
    baselineMalformed
    || baselineDuplicateId
    || baselineRecordRows !== baselinesById.size
    || (Number.isSafeInteger(baselineItemCount) && baselineRecordRows !== baselineItemCount)
  );
  const baselineComplete = !!baselineSheet
    && !baselineCorrupt
    && Number.isSafeInteger(baselineItemCount)
    && baselineItemCount >= 0
    && baselinesById.size === baselineItemCount;
  const semanticFingerprint = workbookSemanticFingerprint(items);
  const acknowledgedSemanticFingerprint = baselineComplete
    ? workbookSemanticFingerprint(Array.from(baselinesById, ([id, record]) => ({ id, ...record })))
    : "";
  return {
    ok: true,
    items: normalizeExcelRows(items),
    rawItems: items,
    integrity: {
      itemRowCount: items.length,
      itemIdsUnique,
      itemIdsDuplicateFree,
    },
    sync: {
      workbookId: meta.workbookId || "",
      schemaVersion: meta.schema || "",
      migrationVersion: Number.isSafeInteger(Number(meta.migrationVersion))
        ? Number(meta.migrationVersion) : null,
      migrationPlanToken: meta.migrationPlanToken || "",
      revision: Number.isSafeInteger(metaRevision) ? metaRevision : null,
      updatedAt: meta.updatedAt || "",
      imageSetVersion: meta.imageSetVersion || "",
      writtenAt: meta.writtenAt || "",
      itemCount: Number.isSafeInteger(baselineItemCount) ? baselineItemCount : null,
    },
    baseline: {
      revision: Number.isSafeInteger(metaRevision) ? metaRevision : null,
      itemCount: Number.isSafeInteger(baselineItemCount) ? baselineItemCount : null,
      corrupt: baselineCorrupt,
      records: Array.from(baselinesById, ([id, record]) => ({ id, ...record })),
    },
    semanticFingerprint,
    acknowledgedSemanticFingerprint,
    hasUnacknowledgedChanges: !baselineComplete
      || semanticFingerprint !== acknowledgedSemanticFingerprint,
    ...info,
    mtimeMs: snapshot.mtimeMs,
    size: snapshot.size,
    sha256: snapshot.sha256,
  };
}

async function writeBootstrapWorkbook(file, snapshot) {
  const workbook = await buildWorkbook({
    items: snapshot.items.map((item) => ({
      ...item,
      canonicalImage: String(item.image || ""),
      image: /^file:\/\//i.test(String(item.image || "")) ? item.image : "",
      photoCachePending: !/^file:\/\//i.test(String(item.image || "")) && !!item.image,
    })),
    sync: {
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      imageSetVersion: snapshot.imageSetVersion,
    },
  });
  await workbook.xlsx.writeFile(file);
}

function bootstrapPrivateWorkbook() {
  return createPrivateWorkbookBootstrap({
    ensurePrivateWorkbook,
    workbookLocation,
    centralSyncService,
    writeWorkbook: writeBootstrapWorkbook,
    readWorkbook: readWorkbookFile,
    watchWorkbook,
    now: () => new Date(),
  })();
}

async function acknowledgeWorkbookFile(file, payload, options = {}) {
  const { items, sync } = normalizeWorkbookPayload(payload);
  const workbook = createExcelWorkbook();
  await loadExcelWorkbook(workbook, stableFileSnapshot(file).buffer);
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) throw new Error(`Missing worksheet: ${SHEET_NAME}`);
  const metaSheet = workbook.getWorksheet("_TEK_META");
  if (!metaSheet) throw new Error("Missing worksheet: _TEK_META");

  const originalRowCount = sheet.rowCount;
  const originalImageCount = sheet.getImages().length;
  const itemsById = new Map(items.map((item) => [String(item.id || ""), item]));

  const imagesByRow = new Map();
  for (const placement of sheet.getImages()) {
    const rowNumber = Number(placement.range?.tl?.nativeRow) + 1;
    const media = workbook.getImage(placement.imageId);
    if (!rowNumber || !media?.buffer) continue;
    imagesByRow.set(rowNumber, Buffer.from(media.buffer));
  }

  const acknowledgedRows = [];
  const planRows = Array.isArray(payload?.ackPlan?.rows) ? payload.ackPlan.rows : [];
  const expectedMtimeMs = Number(payload?.ackPlan?.expectedMtimeMs) || 0;
  const expectedSha256 = String(payload?.ackPlan?.expectedSha256 || "").trim().toLowerCase();
  if (expectedSha256) {
    const currentSha256 = stableFileSnapshot(file).sha256;
    if (currentSha256 !== expectedSha256) {
      return {
        ok: false,
        conflict: true,
        conflicts: [{ reason: "workbook-content-changed" }],
        path: file,
        exists: true,
        mtimeMs: fs.statSync(file).mtimeMs,
      };
    }
  }
  if (expectedMtimeMs) {
    const currentMtimeMs = fs.statSync(file).mtimeMs;
    if (Math.abs(currentMtimeMs - expectedMtimeMs) > 1) {
      return {
        ok: false,
        conflict: true,
        conflicts: [{ reason: "workbook-changed" }],
        path: file,
        exists: true,
        mtimeMs: currentMtimeMs,
      };
    }
  }

  if (planRows.length) {
    const prepared = [];
    const conflicts = [];
    for (const plan of planRows) {
      const assignedId = String(plan.assignedId || "").trim();
      const originalId = String(plan.originalId || "").trim();
      const sourceRow = Math.max(0, Math.trunc(Number(plan.sourceRow) || 0));
      let candidateRows = [];
      for (let rowNumber = 5; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        const rowId = cellText(row.getCell(2)).trim();
        if (assignedId && rowId === assignedId) candidateRows.push(rowNumber);
      }
      if (!candidateRows.length && originalId) {
        for (let rowNumber = 5; rowNumber <= sheet.rowCount; rowNumber += 1) {
          if (cellText(sheet.getRow(rowNumber).getCell(2)).trim() === originalId) {
            candidateRows.push(rowNumber);
          }
        }
      }
      if (!candidateRows.length && !originalId && sourceRow >= 5 && sourceRow <= sheet.rowCount) {
        const sourceRowCell = sheet.getRow(sourceRow);
        const sourceRowId = cellText(sourceRowCell.getCell(2)).trim();
        const sourceRowModel = cellText(sourceRowCell.getCell(4)).trim();
        const plannedModel = String(plan.model || "").trim();
        if (!sourceRowId && plannedModel && sourceRowModel === plannedModel) {
          candidateRows.push(sourceRow);
        }
      }
      candidateRows = [...new Set(candidateRows)];
      if (candidateRows.length !== 1) {
        conflicts.push({ assignedId, sourceRow, reason: "row-match" });
        continue;
      }
      const rowNumber = candidateRows[0];
      const imageBuffer = imagesByRow.get(rowNumber);
      const currentImageHash = imageBuffer
        ? createHash("sha256").update(imageBuffer).digest("hex")
        : "";
      const uploadedImageHash = String(plan.uploadedImageHash || "").trim();
      if (uploadedImageHash && currentImageHash !== uploadedImageHash) {
        conflicts.push({ assignedId, sourceRow, reason: "photo-changed" });
        continue;
      }
      prepared.push({
        rowNumber,
        assignedId,
        uploadedImageHash,
        expectedId: cellText(sheet.getRow(rowNumber).getCell(2)).trim(),
      });
    }
    if (conflicts.length) {
      return {
        ok: false,
        conflict: true,
        conflicts,
        path: file,
        exists: true,
        mtimeMs: fs.statSync(file).mtimeMs,
      };
    }
    for (const preparedRow of prepared) {
      const row = sheet.getRow(preparedRow.rowNumber);
      if (preparedRow.assignedId) row.getCell(2).value = preparedRow.assignedId;
      if (preparedRow.uploadedImageHash) row.getCell(15).value = preparedRow.uploadedImageHash;
      acknowledgedRows.push({
        rowNumber: preparedRow.rowNumber,
        id: preparedRow.assignedId,
        expectedId: preparedRow.expectedId,
      });
    }
  } else {
    for (let rowNumber = 5; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const model = cellText(row.getCell(4)).trim();
      if (!model) continue;
      const existingId = cellText(row.getCell(2)).trim();
      const item = existingId ? itemsById.get(existingId) : null;
      if (!item?.id) continue;
      acknowledgedRows.push({ rowNumber, id: String(item.id), expectedId: existingId });
    }
  }

  const existingBaselineSheet = workbook.getWorksheet("_TEK_BASELINE");
  if (existingBaselineSheet) workbook.removeWorksheet(existingBaselineSheet.id);
  const baselineSheet = workbook.addWorksheet("_TEK_BASELINE", { state: "veryHidden" });
  baselineSheet.addRow(["id", "baseline"]);
  const liveBaselineRows = [];
  const liveImageHashes = [];
  for (let rowNumber = 5; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const id = cellText(sheet.getRow(rowNumber).getCell(2)).trim();
    const item = itemsById.get(id);
    if (!id || !item) continue;
    const imageBuffer = imagesByRow.get(rowNumber);
    const imageHash = imageBuffer
      ? createHash("sha256").update(imageBuffer).digest("hex")
      : "";
    const baseline = JSON.stringify(workbookBaselineRecord(item, imageHash));
    baselineSheet.addRow([id, baseline]);
    liveBaselineRows.push({ id, baseline });
    liveImageHashes.push({ rowNumber, hash: imageHash });
  }

  const metaRows = new Map();
  for (let rowNumber = 1; rowNumber <= metaSheet.rowCount; rowNumber += 1) {
    const key = cellText(metaSheet.getRow(rowNumber).getCell(1)).trim();
    if (key) metaRows.set(key, rowNumber);
  }
  const setMeta = (key, value) => {
    const rowNumber = metaRows.get(key) || metaSheet.rowCount + 1;
    const row = metaSheet.getRow(rowNumber);
    row.getCell(1).value = key;
    row.getCell(2).value = value;
    metaRows.set(key, rowNumber);
  };
  setMeta("writtenAt", new Date().toISOString());
  setMeta("itemCount", items.length);
  setMeta("revision", Number(sync.revision) || 0);
  setMeta("updatedAt", String(sync.updatedAt || ""));
  setMeta("imageSetVersion", String(sync.imageSetVersion || ""));

  if (isWorkbookLocked(file, options.fsApi || fs)) {
    const mutateLive = options.applyOpenWorkbookMutation || applyOpenWorkbookMutation;
    await mutateLive(file, {
      sheetName: SHEET_NAME,
      expectedSha256,
      idCells: acknowledgedRows,
      imageHashes: liveImageHashes,
      baselineRows: liveBaselineRows,
      meta: {
        writtenAt: new Date().toISOString(),
        itemCount: items.length,
        revision: Number(sync.revision) || 0,
        updatedAt: String(sync.updatedAt || ""),
        imageSetVersion: String(sync.imageSetVersion || ""),
      },
    }, options);
    suppressWatchUntil = Date.now() + 3000;
    const snapshot = stableFileSnapshot(file);
    suppressedWorkbookSha256 = snapshot.sha256;
    return {
      ok: true,
      acknowledged: acknowledgedRows.length,
      live: true,
      path: file,
      exists: true,
      mtimeMs: snapshot.mtimeMs,
    };
  }

  const temporary = `${file}.ack.tmp.xlsx`;
  await workbook.xlsx.writeFile(temporary);
  const validation = createExcelWorkbook();
  await loadExcelWorkbook(validation, stableFileSnapshot(temporary).buffer);
  const validationSheet = validation.getWorksheet(SHEET_NAME);
  const validationMeta = validation.getWorksheet("_TEK_META");
  const validatedRevision = Number(
    Array.from({ length: validationMeta.rowCount }, (_, index) => validationMeta.getRow(index + 1))
      .find((row) => cellText(row.getCell(1)).trim() === "revision")
      ?.getCell(2).value,
  ) || 0;
  if (
    validationSheet.rowCount !== originalRowCount
    || validationSheet.getImages().length !== originalImageCount
    || validatedRevision !== (Number(sync.revision) || 0)
  ) {
    fs.rmSync(temporary, { force: true });
    throw new Error("Excel acknowledgement validation failed");
  }
  for (const acknowledged of acknowledgedRows) {
    if (cellText(validationSheet.getRow(acknowledged.rowNumber).getCell(2)).trim() !== acknowledged.id) {
      fs.rmSync(temporary, { force: true });
      throw new Error(`Excel acknowledgement ID mismatch at row ${acknowledged.rowNumber}`);
    }
  }
  if (expectedSha256 && stableFileSnapshot(file).sha256 !== expectedSha256) {
    fs.rmSync(temporary, { force: true });
    const changed = new Error("WORKBOOK_CONTENT_CHANGED");
    changed.code = "WORKBOOK_CONTENT_CHANGED";
    throw changed;
  }
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    if (error.code === "EPERM" || error.code === "EBUSY") {
      throw new Error("Excel file is open. Save and close Excel before updating.");
    }
    throw error;
  }
  suppressWatchUntil = Date.now() + 3000;
  if (process.env.TEK_STOCK_TEST !== "1") watchWorkbook();
  const stat = fs.statSync(file);
  suppressedWorkbookSha256 = stableFileSnapshot(file).sha256;
  return {
    ok: true,
    acknowledged: acknowledgedRows.length,
    path: file,
    exists: true,
    mtimeMs: stat.mtimeMs,
  };
}

async function readWorkbook() {
  return readWorkbookFile(workbookPath());
}

async function assignWorkbookPermanentIds(file, assignments, expectedSha256, options = {}) {
  const plans = Array.isArray(assignments) ? assignments : [];
  if (!plans.length) return { ok: true, assigned: 0, sha256: stableFileSnapshot(file).sha256 };
  const before = stableFileSnapshot(file);
  if (String(expectedSha256 || "").toLowerCase() !== before.sha256) {
    throw new Error("WORKBOOK_CONTENT_CHANGED");
  }
  const workbook = createExcelWorkbook();
  await loadExcelWorkbook(workbook, before.buffer);
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) throw new Error(`Missing worksheet: ${SHEET_NAME}`);
  const existingIds = new Set();
  const existingIdRows = new Map();
  for (let rowNumber = 5; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const id = cellText(sheet.getRow(rowNumber).getCell(2)).trim();
    if (id) {
      existingIds.add(id);
      if (!existingIdRows.has(id)) existingIdRows.set(id, []);
      existingIdRows.get(id).push(rowNumber);
    }
  }
  for (const [id, rowNumbers] of existingIdRows) {
    if (rowNumbers.length < 2) continue;
    const repairRows = plans
      .filter((plan) => String(plan?.expectedId || "").trim() === id)
      .map((plan) => Math.trunc(Number(plan?.sourceRow) || 0));
    if (repairRows.length !== rowNumbers.length - 1
        || repairRows.some((rowNumber) => !rowNumbers.includes(rowNumber))) {
      throw new Error("WORKBOOK_DUPLICATE_ID");
    }
  }
  const plannedRows = new Set();
  for (const plan of plans) {
    const rowNumber = Math.trunc(Number(plan?.sourceRow) || 0);
    const id = String(plan?.id || "").trim();
    const legacyId = String(plan?.legacyId || "").trim();
    const expectedId = Object.hasOwn(plan || {}, "expectedId")
      ? String(plan?.expectedId || "").trim() : legacyId;
    if (rowNumber < 5 || !id || plannedRows.has(rowNumber) || existingIds.has(id)) {
      throw new Error("WORKBOOK_ID_ASSIGNMENT_INVALID");
    }
    const row = sheet.getRow(rowNumber);
    const currentId = cellText(row.getCell(2)).trim();
    if ((expectedId ? currentId !== expectedId : !!currentId) || !cellText(row.getCell(4)).trim()) {
      throw new Error("WORKBOOK_ID_ASSIGNMENT_CONFLICT");
    }
    plannedRows.add(rowNumber);
    existingIds.add(id);
    row.getCell(2).value = id;
  }
  const baseline = workbook.getWorksheet("_TEK_BASELINE");
  const legacyAssignments = new Map(plans
    .filter((plan) => String(plan?.legacyId || "").trim())
    .map((plan) => [String(plan.legacyId).trim(), String(plan.id).trim()]));
  if (legacyAssignments.size) {
    const migratedBaselineIds = new Set();
    for (let rowNumber = 2; rowNumber <= (baseline?.rowCount || 0); rowNumber += 1) {
      const row = baseline.getRow(rowNumber);
      const currentId = cellText(row.getCell(1)).trim();
      const replacement = legacyAssignments.get(currentId);
      if (!replacement) continue;
      row.getCell(1).value = replacement;
      migratedBaselineIds.add(currentId);
    }
    if (migratedBaselineIds.size !== legacyAssignments.size) {
      throw new Error("WORKBOOK_BASELINE_ID_MIGRATION_CONFLICT");
    }
  }
  if (options.identity) {
    const identity = options.identity;
    let meta = workbook.getWorksheet("_TEK_META");
    if (!meta) meta = workbook.addWorksheet("_TEK_META", { state: "veryHidden" });
    const setMeta = (key, value) => {
      for (let rowNumber = 1; rowNumber <= meta.rowCount; rowNumber += 1) {
        if (cellText(meta.getRow(rowNumber).getCell(1)).trim() === key) {
          meta.getRow(rowNumber).getCell(2).value = value;
          return;
        }
      }
      meta.addRow([key, value]);
    };
    setMeta("schema", String(identity.schemaVersion || WORKBOOK_SCHEMA_VERSION));
    setMeta("workbookId", String(identity.workbookId || ""));
    setMeta("migrationVersion", Number(identity.migrationVersion || WORKBOOK_MIGRATION_VERSION));
    setMeta("migrationPlanToken", String(identity.migrationPlanToken || ""));
    meta.state = "veryHidden";
  }
  if (options.requireClosed === true && isWorkbookLocked(file, options.fsApi || fs)) {
    const error = new Error("WORKBOOK_MIGRATION_REQUIRES_CLOSED_EXCEL");
    error.code = "WORKBOOK_MIGRATION_REQUIRES_CLOSED_EXCEL";
    throw error;
  }
  if (isWorkbookLocked(file, options.fsApi || fs)) {
    const mutateLive = options.applyOpenWorkbookMutation || applyOpenWorkbookMutation;
    await mutateLive(file, {
      sheetName: SHEET_NAME,
      expectedSha256,
      idCells: plans.map((plan) => ({
        rowNumber: Math.trunc(Number(plan.sourceRow) || 0),
        id: String(plan.id || "").trim(),
        ...(Object.hasOwn(plan || {}, "expectedId") || String(plan?.legacyId || "").trim()
          ? { expectedId: String(plan?.expectedId || plan?.legacyId || "").trim() }
          : {}),
      })),
      imageHashes: [],
    }, options);
    suppressWatchUntil = Date.now() + 3000;
    const afterLive = stableFileSnapshot(file);
    suppressedWorkbookSha256 = afterLive.sha256;
    return { ok: true, assigned: plans.length, live: true, sha256: afterLive.sha256 };
  }
  const temporary = `${file}.ids.tmp.xlsx`;
  await workbook.xlsx.writeFile(temporary);
  try {
    if (stableFileSnapshot(file).sha256 !== before.sha256) {
      const changed = new Error("WORKBOOK_CONTENT_CHANGED");
      changed.code = "WORKBOOK_CONTENT_CHANGED";
      throw changed;
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  suppressWatchUntil = Date.now() + 3000;
  const after = stableFileSnapshot(file);
  suppressedWorkbookSha256 = after.sha256;
  return { ok: true, assigned: plans.length, sha256: after.sha256 };
}

function syncWorkbookWithCentralCloud(options = {}) {
  const automatic = options.automatic === true;
  let cloudCommitStarted = false;
  let releaseWriterLock = () => {};
  const run = async ({ signal } = {}) => {
    const assertNotCancelled = () => {
      if (signal?.aborted) throw signal.reason;
    };
    const abortPromise = signal
      ? new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
      : null;
    const work = (async () => {
    const trace = createSyncTrace("workbook");
    trace.record("ipc", { method: "tek-stock-cloud-sync-workbook", status: "entered" });
    let writerLock;
    try {
      assertNotCancelled();
      if (process.env.TEK_STOCK_TEST !== "1") {
        writerLock = acquireWorkbookWriterLock(workbookPath());
      }
      releaseWriterLock = () => {
        writerLock?.release();
        writerLock = undefined;
      };
      signal?.addEventListener("abort", releaseWriterLock, { once: true });
      assertNotCancelled();
      const result = await centralSyncService().syncWorkbook({
        assertNotCancelled,
        onCloudWriteStart: () => { cloudCommitStarted = true; },
        readWorkbook: async () => {
          const workbook = await readWorkbook();
          trace.record("excel-bridge", {
            operation: "read",
            path: workbookPath(),
            sheet: SHEET_NAME,
            rows: Array.isArray(workbook?.items) ? workbook.items.length : 0,
            status: workbook?.ok === true ? "ok" : "failed",
            errorCode: workbook?.ok === true ? "" : "WORKBOOK_READ_FAILED",
          });
          return { ...workbook, items: workbook.rawItems || workbook.items };
        },
        normalizeRows: normalizeExcelRows,
        assignIds: (assignments, expectedSha256) =>
          assignWorkbookPermanentIds(workbookPath(), assignments, expectedSha256),
        acknowledge: async (payload) => {
          const result = await acknowledgeWorkbookFile(workbookPath(), payload);
          trace.record("excel-bridge", {
            operation: "acknowledge",
            path: workbookPath(),
            sheet: SHEET_NAME,
            rows: Array.isArray(payload?.items) ? payload.items.length : 0,
            status: result?.ok === true ? "saved" : "failed",
            errorCode: result?.ok === true ? "" : "EXCEL_ACK_FAILED",
          });
          return result;
        },
        replaceWorkbook: async (payload) => {
          const result = await queueWorkbookWriteNow(payload);
          trace.record("excel-bridge", {
            operation: "write",
            path: workbookPath(),
            sheet: SHEET_NAME,
            rows: Array.isArray(payload?.items) ? payload.items.length : 0,
            status: result?.ok === true ? "saved" : "failed",
            errorCode: result?.ok === true ? "" : "EXCEL_BINDING_FAILED",
          });
          return result;
        },
      });
      const completed = result?.workbookAcknowledged === true;
      const output = trace.finish({
        ...result,
        ok: completed,
        errorCode: completed ? "" : (result?.errorCode || "EXCEL_BINDING_FAILED"),
      });
      if (!completed) {
        appendDiagnosticEvent({
          stage: "excel_sync",
          ok: false,
          errorCode: output.errorCode,
          traceId: output.traceId,
        });
      }
      return output;
    } catch (error) {
      const output = normalizeSyncFailure(error, trace);
      appendDiagnosticEvent({
        stage: "excel_sync",
        ok: false,
        errorCode: output.errorCode,
        traceId: output.traceId,
        snapshotField: output.snapshotField,
      });
      return output;
    } finally {
      releaseWriterLock();
    }
    })();
    return abortPromise ? Promise.race([work, abortPromise]) : work;
  };
  const schedule = automatic
    ? workbookOperationGate.scheduleAutomaticSync
    : workbookOperationGate.scheduleSync;
  return automatic
    ? schedule(run, { onCancel: () => {
      if (cloudCommitStarted) return false;
      releaseWriterLock();
      return true;
    }})
    : schedule(run);
}

async function syncWorkbookWithCentralCloudIpc(options = {}) {
  const syncWorkbook = options.syncWorkbook || syncWorkbookWithCentralCloud;
  const appendDiagnostic = options.appendDiagnostic || appendDiagnosticEvent;
  try {
    return sanitizeWorkbookSyncIpcResult(await syncWorkbook());
  } catch (error) {
    const trace = createSyncTrace("workbook-ipc");
    trace.record("ipc", {
      method: "tek-stock-cloud-sync-workbook",
      status: "failed",
      errorCode: String(error?.code || error?.message || "WORKBOOK_SYNC_FAILED"),
    });
    const output = normalizeSyncFailure(error, trace);
    try {
      appendDiagnostic({
        stage: "excel_sync_ipc",
        ok: false,
        errorCode: output.errorCode,
        traceId: output.traceId,
      });
    } catch {}
    return sanitizeWorkbookSyncIpcResult(output);
  }
}

async function getWorkbookIdentityMigrationPlan(options = {}) {
  if (!options.readWorkbook) {
    const recovery = recoverWorkbookMigration(workbookPath());
    if (recovery.active) {
      const error = new Error("WORKBOOK_MIGRATION_IN_PROGRESS");
      error.code = "WORKBOOK_MIGRATION_IN_PROGRESS";
      throw error;
    }
  }
  const read = options.readWorkbook || readWorkbook;
  const service = options.service || centralSyncService();
  const workbook = await read();
  if (!workbook?.ok) {
    const error = new Error("WORKBOOK_READ_FAILED");
    error.code = "WORKBOOK_READ_FAILED";
    throw error;
  }
  const cloud = await service.snapshot(true);
  return planWorkbookIdentityMigration({
    workbook: {
      sha256: workbook.sha256,
      items: workbook.rawItems || workbook.items,
      sync: workbook.sync,
      baseline: workbook.baseline,
    },
    cloud: {
      revision: cloud.revision,
      items: cloud.items,
    },
  });
}

async function applyWorkbookIdentityMigrationIpc(payload, options = {}) {
  const service = options.service || centralSyncService();
  const read = options.readWorkbook || readWorkbook;
  const assignIds = options.assignIds || ((assignments, expectedSha256, identity) =>
    assignWorkbookPermanentIds(workbookPath(), assignments, expectedSha256, {
      identity,
      requireClosed: true,
    }));
  const beginTransaction = options.beginTransaction || ((!options.readWorkbook && !options.assignIds)
    ? ({ plan: currentPlan }) => beginWorkbookMigrationTransaction(workbookPath(), {
      planToken: currentPlan.planToken,
    })
    : undefined);
  const plan = await getWorkbookIdentityMigrationPlan({ readWorkbook: read, service });
  const requestedAssignments = (Array.isArray(payload?.choices) ? payload.choices : []).map((choice) => ({
    sourceRow: Math.trunc(Number(choice?.sourceRow) || 0),
    id: String(choice?.itemId || "").trim(),
  }));
  let applied;
  if (!plan.rows.length && requestedAssignments.length) {
    const current = await read();
    const currentCloudRevision = Number((await service.snapshot(true)).revision);
    if (!exactAssignmentsPersisted(current?.rawItems || current?.items, requestedAssignments)
        || String(current?.sync?.workbookId || "") !== String(payload?.workbookId || "")
        || String(current?.sync?.schemaVersion || "") !== String(payload?.schemaVersion || "")
        || Number(current?.sync?.migrationVersion) !== Number(payload?.migrationVersion)
        || String(current?.sync?.migrationPlanToken || "") !== String(payload?.planToken || "")
        || currentCloudRevision !== Number(payload?.cloudRevision)) {
      const error = new Error("WORKBOOK_MIGRATION_MANIFEST_STALE");
      error.code = "WORKBOOK_MIGRATION_MANIFEST_STALE";
      throw error;
    }
    applied = { ok: true, alreadyApplied: true, assigned: 0, assignments: requestedAssignments };
  } else {
    applied = await applyWorkbookIdentityMigration({
      plan,
      manifest: payload,
      readWorkbook: async () => {
        const workbook = await read();
        return { ...workbook, items: workbook.rawItems || workbook.items };
      },
      assignIds,
      beginTransaction,
      getCloudRevision: async () => Number((await service.snapshot(true)).revision),
    });
  }
  const sync = options.syncWorkbook
    ? await options.syncWorkbook()
    : await syncWorkbookWithCentralCloud();
  if (sync?.workbookAcknowledged !== true) {
    const error = new Error(sync?.errorCode || "WORKBOOK_MIGRATION_SYNC_FAILED");
    error.code = sync?.errorCode || "WORKBOOK_MIGRATION_SYNC_FAILED";
    error.traceId = sync?.traceId || "";
    throw error;
  }
  return { ok: true, migration: applied, sync };
}

function workbookChangeDelay(now, suppressedUntil) {
  return Math.max(0, (Number(suppressedUntil) || 0) - (Number(now) || 0));
}

function isSelfWrittenWorkbook(snapshotSha256, selfWrittenSha256) {
  const current = String(snapshotSha256 || "").toLowerCase();
  return !!current && current === String(selfWrittenSha256 || "").toLowerCase();
}

async function processObservedWorkbookChange(file, mtimeMs, options = {}) {
  const read = options.readWorkbook || readWorkbookFile;
  const workbook = await read(file);
  const selfWrittenSha256 = options.selfWrittenSha256 === undefined
    ? suppressedWorkbookSha256
    : options.selfWrittenSha256;
  if (isSelfWrittenWorkbook(workbook?.sha256, selfWrittenSha256)
      || isWorkbookSemanticallyAcknowledged(workbook)) {
    return { ok: true, ignored: true, reason: "workbook-content-unchanged" };
  }
  const onChanged = options.onChanged || syncAndNotifyWorkbookChanged;
  onChanged(file, Number(workbook?.mtimeMs) || Number(mtimeMs) || 0);
  return { ok: true, ignored: false };
}

function notifyWorkbookChanged(file, mtimeMs) {
  if (!mainWindow) return;
  mainWindow.webContents.send("tek-stock-excel-changed", { path: file, mtimeMs });
}

function isRetryableWorkbookSyncError(error) {
  return /EXCEL_CHANGED_DURING_READ|WORKBOOK_(?:READ_FAILED|REFRESH_PENDING|CONTENT_CHANGED|UNSAVED_CHANGES)|EBUSY|EPERM|ENOENT|AUTOMATION_UNAVAILABLE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|HTTP_429|HTTP_5\d\d|NETWORK_(?:FAILED|TIMEOUT)/i
    .test(String(error?.code || error?.message || ""));
}

async function syncWorkbookChangeWithRetry(attempts = 4, delayMs = 650) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await syncWorkbookWithCentralCloud({ automatic: true });
    } catch (error) {
      lastError = error;
      if (!isRetryableWorkbookSyncError(error) || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

function schedulePendingWorkbookSync(delayMs = 0) {
  if (workbookRetryTimer || workbookSyncRunning || !pendingWorkbookChange) return;
  workbookRetryTimer = setTimeout(() => {
    workbookRetryTimer = null;
    void runPendingWorkbookSync();
  }, Math.max(0, delayMs));
}

async function runPendingWorkbookSync() {
  if (workbookSyncRunning || !pendingWorkbookChange) return;
  workbookSyncRunning = true;
  const change = pendingWorkbookChange;
  pendingWorkbookChange = null;
  try {
    const sync = await syncWorkbookChangeWithRetry();
    if (sync?.workbookAcknowledged !== true) {
      throw Object.assign(new Error("WORKBOOK_REFRESH_PENDING"), {
        code: "WORKBOOK_REFRESH_PENDING",
      });
    }
    workbookRetryAttempt = 0;
    if (mainWindow) mainWindow.webContents.send("tek-stock-cloud-synced", sync);
  } catch (error) {
    if (mainWindow) {
      mainWindow.webContents.send("tek-stock-cloud-sync-failed", {
        errorCode: String(error?.code || error?.message || "SYNC_FAILED").slice(0, 80),
        retrying: isRetryableWorkbookSyncError(error),
      });
    }
    if (isRetryableWorkbookSyncError(error)) {
      pendingWorkbookChange ||= change;
      workbookRetryAttempt += 1;
    }
  } finally {
    workbookSyncRunning = false;
    if (pendingWorkbookChange) {
      const delay = workbookRetryAttempt
        ? Math.min(30_000, 1_000 * (2 ** Math.min(workbookRetryAttempt - 1, 5)))
        : 0;
      schedulePendingWorkbookSync(delay);
    }
  }
}

function syncAndNotifyWorkbookChanged(file, mtimeMs) {
  notifyWorkbookChanged(file, mtimeMs);
  pendingWorkbookChange = { file, mtimeMs };
  if (workbookRetryTimer) {
    clearTimeout(workbookRetryTimer);
    workbookRetryTimer = null;
  }
  schedulePendingWorkbookSync();
}

function watchWorkbook() {
  const file = workbookPath();
  if (watchedWorkbook === file) return;
  if (watchedWorkbook) fs.unwatchFile(watchedWorkbook);
  watchedWorkbook = file;
  fs.watchFile(file, { interval: 1500 }, (current, previous) => {
    if (!mainWindow || current.mtimeMs <= previous.mtimeMs) return;
    clearTimeout(workbookChangeTimer);
    const delay = workbookChangeDelay(Date.now(), suppressWatchUntil);
    workbookChangeTimer = setTimeout(() => {
      workbookChangeTimer = null;
      void processObservedWorkbookChange(file, current.mtimeMs).catch(() => {
        syncAndNotifyWorkbookChanged(file, current.mtimeMs);
      });
    }, delay + 100);
  });
}

function registerExcelIpc() {
  ipcMain.handle("tek-stock-runtime-secrets", () => ({
    uploadToken: readStoredUploadToken() || readUserEnvironmentSecret("TEK_STOCK_UPLOAD_TOKEN"),
    feedbackToken: readUserEnvironmentSecret("TEK_STOCK_FEEDBACK_TOKEN"),
    appVersion: app.getVersion(),
  }));
  ipcMain.handle("tek-stock-runtime-save-upload-token", (_event, token) => storeUploadToken(token));
  ipcMain.handle("tek-stock-runtime-clear-upload-token", () => clearStoredUploadToken());
  ipcMain.handle("tek-stock-excel-info", () => workbookInfo());
  registerPrivateWorkbookBootstrapIpc(ipcMain, bootstrapPrivateWorkbook);
  ipcMain.handle("tek-stock-excel-write", (_event, items) => queueWorkbookWrite(items));
  ipcMain.handle("tek-stock-excel-ack", (_event, payload) =>
    workbookOperationGate.scheduleWrite(async () => {
      writeQueue = writeQueue
        .catch(() => {})
        .then(() => acknowledgeWorkbookFile(workbookPath(), payload));
      return writeQueue;
    }));
  ipcMain.handle("tek-stock-excel-read", () => readWorkbook());
  ipcMain.handle("tek-stock-excel-reset-local", async (_event, payload) => {
    try {
      return await runCloudResetLocal(payload || {});
    } catch (error) {
      return {
        ok: false,
        errorCode: String(error?.code || "CLOUD_RESET_FAILED"),
        backupPath: String(error?.backupPath || ""),
        rollbackErrorCode: String(error?.rollbackErrorCode || ""),
      };
    }
  });
  ipcMain.handle("tek-stock-excel-prepare-update", async () => {
    return prepareCanonicalWorkbookUpdateIpc();
  });
  ipcMain.handle("tek-stock-excel-open", async () => {
    const info = workbookInfo();
    if (!info.exists) return { ok: false, error: "Excel 文件尚未建立", ...info };
    const focused = focusOpenWorkbook(info.path);
    if (focused.alreadyOpen) return focused;
    try {
      return { ...openWorkbookInOffice(info.path), ...info };
    } catch (error) {
      return { ok: false, error: String(error?.message || error || "Excel open failed"), ...info };
    }
  });
}

function registerCentralCloudIpc(options = {}) {
  const ipc = options.ipcMain || ipcMain;
  const getService = options.getService || centralSyncService;
  ipc.handle("tek-stock-cloud-snapshot", () => getService().snapshot(true));
  ipc.handle("tek-stock-cloud-sync-workbook", () => syncWorkbookWithCentralCloudIpc());
  ipc.handle("tek-stock-cloud-identity-migration-plan", () =>
    getWorkbookIdentityMigrationPlan({
      service: getService(),
      readWorkbook: options.readWorkbook || readWorkbook,
    }));
  ipc.handle("tek-stock-cloud-identity-migration-apply", (_event, payload) =>
    applyWorkbookIdentityMigrationIpc(payload, {
      service: getService(),
      readWorkbook: options.readWorkbook || readWorkbook,
      assignIds: options.assignIds,
      syncWorkbook: options.syncWorkbook,
    }));
  ipc.handle("tek-stock-cloud-mutate", async (_event, operations) => {
    getService().enqueue(operations);
    await getService().flush();
    return getService().snapshot(false);
  });
  ipc.handle("tek-stock-cloud-list-conflicts", () => listSyncConflicts(getService()));
  ipc.handle("tek-stock-cloud-resolve-conflict", (_event, payload) =>
    resolveSyncConflictIpc(payload, {
      service: getService(),
      replaceWorkbook: options.replaceWorkbook || queueWorkbookWrite,
    }));
  ipc.handle("tek-stock-cloud-replace-photo", async (_event, payload) => {
    const request = validatePhotoReplacementPayload(payload);
    return getService().replacePhoto(request.itemId, request.dataUrl, {
      imageSha256: request.imageSha256,
      imageVersion: request.imageVersion,
    });
  });
  ipc.handle("tek-stock-cloud-status", () => ({
    ...readAlibabaCloudConfig(),
    pending: getService().outbox.retryable().length,
  }));
}

function registerDiagnosticsIpc(options = {}) {
  const ipc = options.ipcMain || ipcMain;
  const shellApi = options.shell || shell;
  const dialogApi = options.dialog || dialog;
  const userDataPath = options.userDataPath || app.getPath("userData");
  const documentsPath = options.documentsPath || app.getPath("documents");
  const appVersion = options.appVersion || app.getVersion();
  const currentTime = () => {
    const value = typeof options.now === "function" ? options.now() : new Date();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date();
  };
  const appendOptions = () => ({
    userDataPath,
    appVersion,
    now: currentTime(),
    maxFiles: options.maxFiles,
    maxLineBytes: options.maxLineBytes,
    maxFileBytes: options.maxFileBytes,
  });

  ipc.handle("tek-stock-diagnostics-append", (_event, entry) => {
    try {
      const result = appendDiagnosticEvent(entry, appendOptions());
      return { ok: true, file: path.basename(result.path), bytes: result.bytes };
    } catch (error) {
      return diagnosticFailure(error, "DIAGNOSTICS_WRITE_FAILED");
    }
  });

  ipc.handle("tek-stock-diagnostics-get-path", () => {
    try {
      const directory = ensureDiagnosticsDirectory(userDataPath);
      return { ok: true, path: directory, fileCount: listDiagnosticFiles(userDataPath).length };
    } catch (error) {
      return diagnosticFailure(error);
    }
  });

  ipc.handle("tek-stock-diagnostics-export", async () => {
    try {
      if (!listDiagnosticFiles(userDataPath).length) throw diagnosticsError("NO_DIAGNOSTICS");
      if (typeof dialogApi?.showSaveDialog !== "function") {
        throw diagnosticsError("EXPORT_UNAVAILABLE");
      }
      const selected = await dialogApi.showSaveDialog({
        title: "Export TEK STOCK diagnostics",
        buttonLabel: "Export",
        defaultPath: path.join(
          documentsPath,
          `TEK-STOCK-diagnostics-${localDateStamp(currentTime())}.jsonl`,
        ),
        filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      if (selected?.canceled || !selected?.filePath) return { ok: false, canceled: true };
      return exportDiagnosticsToFile(userDataPath, selected.filePath, {
        maxLineBytes: options.maxLineBytes,
        maxFileBytes: options.maxFileBytes,
      });
    } catch (error) {
      return diagnosticFailure(error, "DIAGNOSTICS_EXPORT_FAILED");
    }
  });

  ipc.handle("tek-stock-diagnostics-open-folder", async () => {
    try {
      const directory = ensureDiagnosticsDirectory(userDataPath);
      if (typeof shellApi?.openPath !== "function") throw diagnosticsError("OPEN_FOLDER_UNAVAILABLE");
      const error = await shellApi.openPath(directory);
      return error
        ? { ok: false, errorCode: "OPEN_FOLDER_FAILED" }
        : { ok: true, path: directory };
    } catch (error) {
      return diagnosticFailure(error, "OPEN_FOLDER_FAILED");
    }
  });
}

function updaterFailure(error) {
  return {
    ok: false,
    errorCode: diagnosticCode(error?.code, "UPDATE_FAILED", 64),
  };
}

function manifestSource(url) {
  try {
    const host = new URL(String(url || "")).hostname.toLowerCase();
    if (host.includes("cn-hangzhou")) return "hangzhou";
    if (host.includes("ap-southeast-1")) return "singapore";
    return "other";
  } catch {
    return "unknown";
  }
}

function waitForInstallerLaunch(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (!child || typeof child.once !== "function") {
      reject(Object.assign(new Error("UPDATE_INSTALLER_LAUNCH_FAILED"), {
        code: "UPDATE_INSTALLER_LAUNCH_FAILED",
      }));
      return;
    }
    const timer = setTimeout(() => {
      reject(Object.assign(new Error("UPDATE_INSTALLER_LAUNCH_TIMEOUT"), {
        code: "UPDATE_INSTALLER_LAUNCH_TIMEOUT",
      }));
    }, timeoutMs);
    child.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error("UPDATE_INSTALLER_LAUNCH_FAILED"), {
        code: "UPDATE_INSTALLER_LAUNCH_FAILED",
        cause: error,
      }));
    });
  });
}

function registerUpdaterIpc(options = {}) {
  const ipc = options.ipcMain || ipcMain;
  const appApi = options.app || app;
  const spawnInstaller = options.spawn || spawn;
  const configuredManifestUrl = options.manifestUrl
    || process.env.TEK_STOCK_UPDATE_MANIFEST_URL;
  const manifestUrls = [...new Set(options.manifestUrls || [
    configuredManifestUrl || DEFAULT_MANIFEST_URL,
    FALLBACK_MANIFEST_URL,
  ])];
  const userDataPath = options.userDataPath || appApi.getPath("userData");
  const tempPath = options.tempPath || appApi.getPath("temp");
  const osRelease = options.osRelease || os.release();
  const getManifest = options.fetchReleaseManifest || fetchReleaseManifest;
  const downloadInstaller = options.downloadVerifiedInstaller || downloadVerifiedInstaller;
  const saveReceipt = options.writeUpdateReceipt || ((receipt) => writeUpdateReceipt(userDataPath, receipt));
  const updaterElectronNet = options.electronNet === undefined ? electronNet : options.electronNet;
  const getReleaseManifest = async () => {
    let lastError;
    for (const url of manifestUrls) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return { manifest: await getManifest(url, {
            userAgent: `TEK-STOCK/${appApi.getVersion()}`,
            timeoutMs: options.manifestTimeoutMs || 8_000,
            electronNet: updaterElectronNet,
          }), manifestUrl: url };
        } catch (error) {
          lastError = error;
        }
      }
    }
    throw lastError || Object.assign(new Error("UPDATE_MANIFEST_UNAVAILABLE"), {
      code: "UPDATE_MANIFEST_UNAVAILABLE",
    });
  };

  ipc.handle("tek-stock-updater-status", async () => {
    const installedVersion = String(appApi.getVersion() || "");
    let receipt = {
      action: "check", checkRan: true, currentVersion: installedVersion,
      downloadOutcome: "not_requested", launchOutcome: "not_requested",
    };
    try {
      const { manifest, manifestUrl } = await getReleaseManifest();
      const release = selectWindowsChannel(manifest, osRelease);
      receipt = {
        ...receipt,
        availableVersion: release.version,
        newerVersionFound: isVersionNewer(release.version, installedVersion),
        installerFound: true,
        channel: release.channel,
        manifestSource: manifestSource(manifestUrl),
      };
      const saved = saveReceipt(receipt);
      return {
        ok: true,
        installedVersion,
        version: release.version,
        channel: release.channel,
        isMismatch: isVersionNewer(release.version, installedVersion),
        receipt: saved,
      };
    } catch (error) {
      receipt = { ...receipt, errorCode: error?.code || "UPDATE_FAILED" };
      let saved;
      try { saved = saveReceipt(receipt); } catch {}
      return { ...updaterFailure(error), installedVersion, receipt: saved || receipt };
    }
  });

  ipc.handle("tek-stock-updater-receipt", () => readUpdateReceipt(userDataPath));

  const downloadAndLaunchUpdate = async (action, requireNewer) => {
    if (updaterActive) return { ok: false, errorCode: "UPDATE_ALREADY_RUNNING" };
    updaterActive = true;
    let stage = "update.manifest";
    const installedVersion = String(appApi.getVersion() || "");
    let receipt = {
      action, checkRan: true, currentVersion: installedVersion,
      downloadOutcome: "not_requested", launchOutcome: "not_requested",
    };
    try {
      const { manifest, manifestUrl } = await getReleaseManifest();
      const release = selectWindowsChannel(manifest, osRelease);
      receipt = {
        ...receipt,
        availableVersion: release.version,
        newerVersionFound: isVersionNewer(release.version, installedVersion),
        installerFound: true,
        channel: release.channel,
        manifestSource: manifestSource(manifestUrl),
      };
      if (requireNewer && !receipt.newerVersionFound) {
        const savedReceipt = saveReceipt(receipt);
        return {
          ok: true,
          updateAvailable: false,
          installedVersion,
          version: release.version,
          channel: release.channel,
          message: "Already up to date",
          receipt: savedReceipt,
        };
      }
      receipt = { ...receipt, downloadOutcome: "started" };
      saveReceipt(receipt);
      stage = "update.download";
      const updateDirectory = fs.mkdtempSync(path.join(tempPath, "TEK-STOCK-update-"));
      const installerPath = path.join(updateDirectory, release.name);
      const downloaded = await downloadInstaller(release, installerPath, {
        userAgent: `TEK-STOCK/${appApi.getVersion()}`,
        electronNet: updaterElectronNet,
      });
      receipt = { ...receipt, downloadOutcome: "verified", launchOutcome: "started" };
      saveReceipt(receipt);
      stage = "update.launch";
      const child = spawnInstaller(process.execPath, [
        path.join(__dirname, "updater-helper.cjs"),
        downloaded.path,
        String(process.pid),
        release.version === String(appApi.getVersion() || "") ? "repair" : "upgrade",
      ], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        },
      });
      await waitForInstallerLaunch(child, options.launchTimeoutMs);
      child.unref?.();
      receipt = { ...receipt, launchOutcome: "queued" };
      const savedReceipt = saveReceipt(receipt);
      appendDiagnosticEvent({
        stage,
        ok: true,
        counts: { bytes: downloaded.bytes },
      }, { userDataPath, appVersion: appApi.getVersion() });
      setTimeout(() => {
        if (typeof appApi.exit === "function") appApi.exit(0);
        else appApi.quit();
      }, 750);
      return {
        ok: true,
        updateAvailable: true,
        version: release.version,
        channel: release.channel,
        message: "Installer verified and queued",
        receipt: savedReceipt,
      };
    } catch (error) {
      receipt = {
        ...receipt,
        downloadOutcome: stage === "update.manifest" ? "not_requested"
          : receipt.downloadOutcome === "verified" ? "verified" : "failed",
        launchOutcome: stage === "update.launch" ? "failed" : receipt.launchOutcome,
        errorCode: error?.code || "UPDATE_FAILED",
      };
      let savedReceipt;
      try { savedReceipt = saveReceipt(receipt); } catch {}
      try {
        appendDiagnosticEvent({
          stage,
          ok: false,
          errorCode: error?.code || "UPDATE_FAILED",
        }, { userDataPath, appVersion: appApi.getVersion() });
      } catch {}
      return { ...updaterFailure(error), receipt: savedReceipt || receipt };
    } finally {
      updaterActive = false;
    }
  };

  ipc.handle("tek-stock-updater-update", () => downloadAndLaunchUpdate("user_update", true));
  ipc.handle("tek-stock-updater-reinstall", () => downloadAndLaunchUpdate("user_reinstall", false));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 700,
    title: "TEK STOCK 新加坡库存",
    icon: path.join(__dirname, "build", "tek-stock-logo.png"),
    backgroundColor: "#f5f3ec",
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  mainWindow.loadFile(path.join(__dirname, "inventory", "index.html"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === "about:blank") return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  watchWorkbook();
}

function latestInstalledExecutable(options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const env = options.env || process.env;
  const currentExecutable = options.currentExecutable || process.execPath;
  const programFiles = env.ProgramW6432 || env.ProgramFiles || "";
  const machineInstall = programFiles
    ? pathApi.join(programFiles, "TEK STOCK", "TEK STOCK.exe")
    : "";
  return machineInstall && fsApi.existsSync(machineInstall)
    ? machineInstall
    : currentExecutable;
}

function ensureLatestDesktopShortcut(options = {}) {
  const appApi = options.appApi || app;
  const shellApi = options.shellApi || shell;
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const platform = options.platform || process.platform;
  if (platform !== "win32" || appApi.isPackaged !== true) return false;

  const target = latestInstalledExecutable({
    fsApi,
    pathApi,
    env: options.env || process.env,
    currentExecutable: options.currentExecutable || process.execPath,
  });
  if (!target || !fsApi.existsSync(target)) return false;
  const shortcut = pathApi.join(appApi.getPath("desktop"), "TEK STOCK.lnk");
  const operation = fsApi.existsSync(shortcut) ? "replace" : "create";
  return shellApi.writeShortcutLink(shortcut, operation, {
    target,
    args: "",
    cwd: pathApi.dirname(target),
    icon: target,
    iconIndex: 0,
    description: "TEK STOCK latest version",
    appUserModelId: "com.samlee.inventory",
  }) === true;
}

if (isolatedSmokeLoadError) {
  app.whenReady().then(() => {
    console.error("Isolated smoke request rejected", isolatedSmokeLoadError);
    app.exit(2);
  });
} else if (isolatedSmokeRequest) {
  app.whenReady().then(async () => {
    const smokeFetch = createSmokeFetch(isolatedSmokeRequest);
    const createSmokeService = (readOnly = false, suffix = "central-sync") => createCentralSync({
      storageDirectory: path.join(app.getPath("userData"), suffix),
      fetchImpl: smokeFetch,
      getApiBaseUrl: () => "https://smoke-api.invalid",
      getAuthorityId: () => "smoke-local",
      getOssBaseUrl: () => "https://smoke-oss.invalid",
      getToken: () => "isolated-smoke-token",
      readOnly,
      requestTimeoutMs: 10_000,
    });
    centralSync = createSmokeService(false);
    registerExcelIpc();
    registerCentralCloudIpc({ getService: () => centralSync });
    registerDiagnosticsIpc();
    const updaterCounters = registerSmokeUpdaterIpc(ipcMain, app.getVersion());
    const result = await runPackagedSmokeRuntime(isolatedSmokeRequest, {
      BrowserWindow,
      preload: path.join(__dirname, "preload.cjs"),
      indexHtml: path.join(__dirname, "inventory", "index.html"),
      updaterCounters,
      workbookSemanticFingerprint,
      excelLive: {
        applyOpenWorkbookMutation,
        isWorkbookLocked,
        replaceOpenWorkbookFile,
        saveOpenWorkbook,
        workbookLockPath: require("./excel-live.cjs").workbookLockPath,
      },
      createMobileService: () => createSmokeService(true, `mobile-${isolatedSmokeRequest.role}`),
    });
    app.exit(result.ok ? 0 : 1);
  }).catch((error) => {
    console.error("Isolated packaged smoke failed", error);
    app.exit(1);
  });
} else if (process.env.TEK_STOCK_TEST !== "1") {
  const ownsSingleInstanceLock = app.requestSingleInstanceLock();
  if (!ownsSingleInstanceLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    app.whenReady().then(() => {
      try {
        ensureLatestDesktopShortcut();
      } catch (error) {
        console.error("Unable to repair TEK STOCK desktop shortcut", error);
      }
      recoverWorkbookMigrationAtStartup();
      registerExcelIpc();
      registerCentralCloudIpc();
      registerDiagnosticsIpc();
      registerUpdaterIpc();
      createWindow();
      void centralSyncService().flush().catch(() => {});
      app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
    });
    app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
    app.on("before-quit", () => {
      clearTimeout(workbookChangeTimer);
      if (watchedWorkbook) fs.unwatchFile(watchedWorkbook);
    });
  }
}

module.exports = {
  appendDiagnosticEvent,
  acknowledgeWorkbookFile,
  assignWorkbookPermanentIds,
  buildWorkbook,
  diagnosticsDirectory,
  downloadBuffer,
  exportDiagnosticsToFile,
  imageBufferForItem,
  ensureLatestDesktopShortcut,
  latestInstalledExecutable,
  listSyncConflicts,
  listDiagnosticFiles,
  mapWithConcurrency,
  openExcelWorkbooks,
  prepareCanonicalWorkbookUpdate,
  prepareCanonicalWorkbookUpdateIpc,
  verifyCloudResetLocal,
  processObservedWorkbookChange,
  readAlibabaCloudConfig,
  readStoredUploadToken,
  readWorkbookFile,
  registerDiagnosticsIpc,
  registerCentralCloudIpc,
  registerUpdaterIpc,
  resolveSyncConflict,
  resolveSyncConflictIpc,
  sanitizeDiagnosticEvent,
  stableFileSnapshot,
  isRetryableWorkbookSyncError,
  syncWorkbookWithCentralCloud,
  syncWorkbookWithCentralCloudIpc,
  getWorkbookIdentityMigrationPlan,
  applyWorkbookIdentityMigrationIpc,
  validateSyncConflictResolution,
  validatePhotoReplacementPayload,
  isSelfWrittenWorkbook,
  isWorkbookSemanticallyAcknowledged,
  workbookSemanticFingerprint,
  workbookChangeDelay,
};
