"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");

const SMOKE_ARGUMENT = "--tek-stock-isolated-smoke=";
const SAFE_NONCE = /^[a-f0-9]{32,128}$/i;

function smokeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function requiredPath(root, value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw smokeError("SMOKE_PATH_INVALID");
  const resolved = path.resolve(value);
  if (!isInside(root, resolved)) throw smokeError("SMOKE_PATH_OUTSIDE_ROOT");
  return resolved;
}

function loadIsolatedSmokeRequest(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  const env = options.env || process.env;
  if (env.TEK_STOCK_ISOLATED_SMOKE !== "1") return null;
  const argument = argv.find((value) => String(value).startsWith(SMOKE_ARGUMENT));
  if (!argument) return null;
  const manifestPath = path.resolve(String(argument).slice(SMOKE_ARGUMENT.length));
  if (!path.isAbsolute(String(argument).slice(SMOKE_ARGUMENT.length))) {
    throw smokeError("SMOKE_MANIFEST_PATH_INVALID");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const root = path.resolve(String(manifest?.root || ""));
  const tempRoot = path.resolve(os.tmpdir());
  if (!path.isAbsolute(String(manifest?.root || "")) || !isInside(tempRoot, root)
      || !path.basename(root).startsWith("tek-stock-packaged-smoke-")) {
    throw smokeError("SMOKE_ROOT_INVALID");
  }
  if (!isInside(root, manifestPath)) throw smokeError("SMOKE_PATH_OUTSIDE_ROOT");
  const nonce = String(manifest?.nonce || "");
  if (!SAFE_NONCE.test(nonce) || nonce !== String(env.TEK_STOCK_SMOKE_NONCE || "")) {
    throw smokeError("SMOKE_NONCE_INVALID");
  }
  if (Number(manifest?.version) !== 1 || !["A", "B"].includes(manifest?.role)
      || !["workflow", "verify", "update-audit"].includes(manifest?.mode)) {
    throw smokeError("SMOKE_MANIFEST_INVALID");
  }
  let server;
  try {
    server = new URL(String(manifest.serverOrigin || ""));
  } catch {
    throw smokeError("SMOKE_SERVER_INVALID");
  }
  if (server.protocol !== "http:" || server.hostname !== "127.0.0.1" || !server.port
      || server.pathname !== "/") {
    throw smokeError("SMOKE_SERVER_INVALID");
  }
  return {
    version: 1,
    nonce,
    root,
    manifestPath,
    role: manifest.role,
    mode: manifest.mode,
    serverOrigin: server.origin,
    userDataPath: requiredPath(root, manifest.userDataPath),
    localAppDataPath: requiredPath(root, manifest.localAppDataPath),
    documentsPath: requiredPath(root, manifest.documentsPath),
    controlDirectory: requiredPath(root, manifest.controlDirectory),
    resultPath: requiredPath(root, manifest.resultPath),
  };
}

function configureSmokeAppPaths(appApi, request) {
  const paths = {
    userData: request.userDataPath,
    documents: request.documentsPath,
    desktop: path.join(request.root, "desktop"),
    temp: path.join(request.root, "temp"),
    home: path.join(request.root, "home"),
  };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(request.localAppDataPath, { recursive: true, mode: 0o700 });
  fs.mkdirSync(request.controlDirectory, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(paths)) appApi.setPath(name, value);
  return paths;
}

function registerSmokeUpdaterIpc(ipc, appVersion) {
  const counters = { updateInvocations: 0, reinstallInvocations: 0 };
  const currentVersion = String(appVersion || "");
  const status = {
    ok: true,
    installedVersion: currentVersion,
    version: currentVersion,
    isMismatch: false,
    smoke: true,
  };
  ipc.handle("tek-stock-updater-status", () => status);
  ipc.handle("tek-stock-updater-receipt", () => ({
    action: "isolated_smoke",
    checkRan: false,
    currentVersion,
    downloadOutcome: "not_requested",
    launchOutcome: "not_requested",
  }));
  ipc.handle("tek-stock-updater-update", () => {
    counters.updateInvocations += 1;
    return { ok: false, errorCode: "SMOKE_UPDATER_DISABLED" };
  });
  ipc.handle("tek-stock-updater-reinstall", () => {
    counters.reinstallInvocations += 1;
    return { ok: false, errorCode: "SMOKE_UPDATER_DISABLED" };
  });
  return counters;
}

function createSmokeFetch(request, fetchImpl = globalThis.fetch) {
  return async function smokeFetch(input, init) {
    const requested = new URL(String(input));
    if (!["smoke-api.invalid", "smoke-oss.invalid"].includes(requested.hostname)
        || requested.protocol !== "https:") {
      throw smokeError("SMOKE_NETWORK_TARGET_REJECTED");
    }
    const target = new URL(request.serverOrigin);
    target.pathname = requested.pathname;
    target.search = requested.search;
    return fetchImpl(target, init);
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function controlPath(request, name) {
  if (!/^[a-z0-9][a-z0-9.-]{0,79}$/i.test(String(name || "")) || String(name).includes("..")) {
    throw smokeError("SMOKE_CONTROL_INVALID");
  }
  return path.join(request.controlDirectory, name);
}

async function waitForControl(request, name, timeoutMs = 90_000) {
  const file = controlPath(request, name);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return file;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw smokeError("SMOKE_CONTROL_TIMEOUT");
}

async function waitForRenderer(window, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await window.webContents.executeJavaScript(
        "Boolean(window.TekStockExcel?.bootstrap && window.TekStockCloud?.snapshot)",
      )) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw smokeError("SMOKE_RENDERER_TIMEOUT");
}

async function invokeRenderer(window, expression) {
  const script = `(async()=>{try{return {ok:true,value:await (${expression})};}`
    + `catch(error){return {ok:false,errorCode:String(error?.code||error?.message||"SMOKE_RENDERER_FAILED")}}})()`;
  const result = await window.webContents.executeJavaScript(script, true);
  if (!result?.ok) throw smokeError(result?.errorCode || "SMOKE_RENDERER_FAILED");
  return result.value;
}

async function editWorkbook(file, role, action) {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw smokeError("SMOKE_WORKBOOK_SHEET_MISSING");
  const findRow = (id) => {
    for (let rowNumber = 5; rowNumber <= sheet.rowCount; rowNumber += 1) {
      if (String(sheet.getRow(rowNumber).getCell(2).text || "").trim() === id) return rowNumber;
    }
    return 0;
  };
  if (action === "phase1") {
    const existing = findRow("existing");
    if (!existing) throw smokeError("SMOKE_EXISTING_ITEM_MISSING");
    if (role === "A") sheet.getRow(existing).getCell(5).value = 9;
    else sheet.getRow(existing).getCell(10).value = "B EDIT";
    const row = sheet.getRow(Math.max(5, sheet.rowCount + 1));
    row.getCell(3).value = role === "A" ? "Chair" : "Table";
    row.getCell(4).value = `${role}-NEW`;
    row.getCell(5).value = role === "A" ? 1 : 2;
    row.commit();
  } else if (action === "phase2" && role === "A") {
    const deleted = findRow("delete-me");
    if (!deleted) throw smokeError("SMOKE_DELETE_ITEM_MISSING");
    sheet.spliceRows(deleted, 1);
  }
  await workbook.xlsx.writeFile(file);
}

async function canonicalSmokePhotoDataUrl() {
  const source = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const png = await require("sharp")(source)
    .rotate()
    .resize(224, 152, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png({ compressionLevel: 6 })
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

function exerciseExcelLiveRace(request, excelLive) {
  const directory = path.join(request.userDataPath, "smoke-lock-race");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "race.xlsx");
  const replacement = `${file}.tmp.xlsx`;
  const original = Buffer.from("original-workbook-bytes");
  const newer = Buffer.from("newer-saved-workbook-bytes");
  fs.writeFileSync(file, original);
  fs.writeFileSync(replacement, Buffer.from("replacement-workbook-bytes"));
  fs.writeFileSync(excelLive.workbookLockPath(file), Buffer.from("isolated-lock"));
  if (!excelLive.isWorkbookLocked(file)) throw smokeError("SMOKE_LOCK_NOT_DETECTED");
  const expectedSha256 = createHash("sha256").update(original).digest("hex");
  let errorCode = "";
  try {
    excelLive.replaceOpenWorkbookFile(file, replacement, {
      expectedSha256,
      execFileSync: () => {
        fs.writeFileSync(file, newer);
        throw Object.assign(new Error("WORKBOOK_CONTENT_CHANGED"), {
          code: "WORKBOOK_CONTENT_CHANGED",
        });
      },
    });
  } catch (error) {
    errorCode = String(error?.code || error?.message || "");
  }
  if (errorCode !== "WORKBOOK_CONTENT_CHANGED"
      || !fs.readFileSync(file).equals(newer) || fs.existsSync(replacement)) {
    throw smokeError("SMOKE_LOCK_RACE_FAILED");
  }
  return {
    mode: "deterministic-production-excel-live-cas",
    lockDetected: true,
    newerSavePreserved: true,
    errorCode,
  };
}

function createSmokeWindow(BrowserWindow, preload, show = false) {
  return new BrowserWindow({
    width: 1200,
    height: 800,
    show,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
      preload,
    },
  });
}

async function runUpdateAudit(request, options) {
  const window = createSmokeWindow(options.BrowserWindow, options.preload);
  await window.loadURL("data:text/html,<main id='update-audit'>TEK STOCK isolated update audit</main>");
  await waitForRenderer(window);
  const info = await invokeRenderer(window, "window.TekStockExcel.info()");
  const dom = await window.webContents.executeJavaScript(
    "({marker:document.querySelector('#update-audit')?.textContent||'',preload:Boolean(window.TekStockUpdater&&window.TekStockExcel)})",
  );
  return { mode: request.mode, role: request.role, info, dom };
}

async function runWorkflow(request, options) {
  const window = createSmokeWindow(options.BrowserWindow, options.preload);
  await window.loadFile(options.indexHtml);
  await waitForRenderer(window);
  const bootstrap = await invokeRenderer(window, "window.TekStockExcel.bootstrap()");
  if (!bootstrap?.ok) throw smokeError("SMOKE_BOOTSTRAP_FAILED");
  const info = await invokeRenderer(window, "window.TekStockExcel.info()");
  const initial = await invokeRenderer(window, "window.TekStockExcel.read()");
  const dom = await window.webContents.executeJavaScript(
    "({title:document.title,grid:Boolean(document.querySelector('#inventoryGrid')),version:document.querySelector('.version-badge span')?.textContent||'',preload:Boolean(window.TekStockCloud&&window.TekStockExcel&&window.TekStockUpdater)})",
  );
  writeJsonAtomic(controlPath(request, `${request.role}-ready.json`), {
    ok: true, role: request.role, workbookPath: info.path, dom,
  });
  if (request.mode === "verify") {
    await waitForControl(request, "finish-go");
  } else {
    await waitForControl(request, "phase1-go");
    await editWorkbook(info.path, request.role, "phase1");
    const phase1 = await invokeRenderer(window, "window.TekStockCloud.syncWorkbook()");
    writeJsonAtomic(controlPath(request, `${request.role}-phase1.json`), { ok: true, phase1 });
    await waitForControl(request, "phase2-go");
    if (request.role === "A") {
      await editWorkbook(info.path, request.role, "phase2");
    } else {
      const png = await canonicalSmokePhotoDataUrl();
      await invokeRenderer(window, `window.TekStockCloud.replacePhoto("existing",${JSON.stringify(png)})`);
    }
    const phase2 = await invokeRenderer(window, "window.TekStockCloud.syncWorkbook()");
    writeJsonAtomic(controlPath(request, `${request.role}-phase2.json`), { ok: true, phase2 });
    await waitForControl(request, "finish-go");
  }
  for (let round = 0; round < 4; round += 1) {
    await invokeRenderer(window, "window.TekStockCloud.syncWorkbook()");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const workbook = await invokeRenderer(window, "window.TekStockExcel.read()");
  const cloud = await invokeRenderer(window, "window.TekStockCloud.snapshot()");
  const cloudRows = cloud.items.map((item) => ({ ...item, imageHash: item.imageSha256 || "" }));
  const cloudFingerprint = options.workbookSemanticFingerprint(cloudRows);
  const mobile = options.createMobileService();
  const mobileSnapshot = await mobile.canonicalSnapshot();
  let mobileWriteError = "";
  try { mobile.enqueue([{ type: "delete", itemId: "existing" }]); } catch (error) {
    mobileWriteError = String(error?.code || error?.message || "");
  }
  const finalDom = await window.webContents.executeJavaScript(
    "({cloudVersion:document.querySelector('#cloudVersion')?.textContent||'',syncError:document.querySelector('#syncError')?.textContent||''})",
  );
  const screenshotPath = controlPath(request, `${request.role}-final.png`);
  window.showInactive();
  await new Promise((resolve) => setTimeout(resolve, 350));
  fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
  window.hide();
  return {
    mode: request.mode,
    role: request.role,
    bootstrapState: bootstrap.state,
    workbookPath: info.path,
    workbookBytes: fs.statSync(info.path).size,
    workbookFingerprint: workbook.semanticFingerprint,
    workbookItems: workbook.rawItems,
    cloudFingerprint,
    cloudRevision: cloud.revision,
    cloudItems: cloud.items,
    mobileItems: mobileSnapshot.items,
    mobileWriteError,
    dom: { ...dom, ...finalDom },
    screenshotPath,
    initialWorkbookFingerprint: initial.semanticFingerprint,
    excelLive: exerciseExcelLiveRace(request, options.excelLive),
  };
}

async function runPackagedSmokeRuntime(request, options) {
  let result;
  try {
    result = request.mode === "update-audit"
      ? await runUpdateAudit(request, options)
      : await runWorkflow(request, options);
    result = { ok: true, ...result, updater: { ...options.updaterCounters } };
  } catch (error) {
    result = {
      ok: false,
      role: request.role,
      mode: request.mode,
      errorCode: String(error?.code || error?.message || "SMOKE_FAILED"),
      stack: String(error?.stack || "").slice(0, 4000),
      updater: { ...options.updaterCounters },
    };
  }
  writeJsonAtomic(request.resultPath, result);
  return result;
}

module.exports = {
  configureSmokeAppPaths,
  createSmokeFetch,
  runPackagedSmokeRuntime,
  loadIsolatedSmokeRequest,
  registerSmokeUpdaterIpc,
};
