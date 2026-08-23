"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const ExcelJS = require("exceljs");

const project = path.resolve(__dirname, "..");
const packageVersion = require(path.join(project, "package.json")).version;
const versionParts = packageVersion.split(".").map(Number);
const priorVersion = `${versionParts[0]}.${versionParts[1]}.${versionParts[2] - 1}`;
const output = path.join(project, "outputs", "task-6-packaged-electron-smoke.json");
const executable = path.resolve(
  process.env.TEK_STOCK_SMOKE_EXECUTABLE
    || path.join(project, "dist-update", "win-unpacked", "TEK STOCK.exe"),
);
const oldArtifact = path.join(project, "dist-update", `TEK-STOCK-新加坡库存-${priorVersion}-x64.exe`);
const currentArtifact = path.join(project, "dist-update", `TEK-STOCK-新加坡库存-${packageVersion}-x64.exe`);
const sevenZip = "C:\\Users\\edwin\\AppData\\Local\\electron-builder\\Cache\\7zip@1.0.0\\7zip-win-x64-1nrf7\\bin\\7za.exe";
const nonce = crypto.randomBytes(24).toString("hex");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-packaged-smoke-"));

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function safeCleanup() {
  const resolved = path.resolve(root);
  const temp = path.resolve(os.tmpdir());
  assert.equal(path.relative(temp, resolved).startsWith(".."), false);
  assert.match(path.basename(resolved), /^tek-stock-packaged-smoke-/);
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "x-tek-stock-authority-id": "smoke-local",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function createCloudServer() {
  const state = {
    revision: 0,
    updatedAt: "2026-08-06T00:00:00.000Z",
    items: [
      { id: "existing", model: "EXISTING", category: "Chair", stock: 3,
        showroomQuantity: 0, computedTotalSold: 0, cost: null, sellingPrice: null,
        arrival: "", showroom: "", outbound: "", totalSold: 0, image: "",
        specification: "OLD", sourceFile: "TEK-STOCK-LIVE.xlsx", sourceSheet: "åº“å­˜æ€»è¡¨", sourceRow: 5 },
      { id: "delete-me", model: "DELETE", category: "Table", stock: 1,
        showroomQuantity: 0, computedTotalSold: 0, cost: null, sellingPrice: null,
        specification: "", arrival: "", showroom: "", outbound: "", totalSold: 0, image: "",
        sourceFile: "TEK-STOCK-LIVE.xlsx", sourceSheet: "åº“å­˜æ€»è¡¨", sourceRow: 6 },
    ],
    changes: [],
    uploads: new Map(),
    idempotent: new Map(),
  };
  function commit(operations) {
    const items = new Map(state.items.map((item) => [item.id, structuredClone(item)]));
    const revision = state.revision + 1;
    let sequence = 0;
    for (const operation of operations) {
      if (operation.type === "delete") {
        items.delete(operation.itemId);
        state.changes.push({ revision, sequence: sequence++, operation: "delete",
          itemId: operation.itemId, createdAt: new Date(1_800_000_000_000 + revision).toISOString() });
      } else {
        items.set(operation.item.id, structuredClone(operation.item));
        state.changes.push({ revision, sequence: sequence++, operation: "upsert",
          itemId: operation.item.id, item: structuredClone(operation.item),
          createdAt: new Date(1_800_000_000_000 + revision).toISOString() });
      }
    }
    state.items = [...items.values()];
    state.revision = revision;
    state.updatedAt = new Date(1_800_000_000_000 + revision).toISOString();
  }
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/snapshot") {
        const items = structuredClone(state.items);
        jsonResponse(response, 200, { revision: state.revision, updatedAt: state.updatedAt, items,
          fingerprint: sha256(JSON.stringify(items)), photoFingerprint: sha256("photos") });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/changes") {
        const afterRevision = Number(url.searchParams.get("after_revision") || 0);
        const afterSequenceText = url.searchParams.get("after_sequence");
        const afterSequence = afterSequenceText == null ? -1 : Number(afterSequenceText);
        const events = state.changes.filter((event) => event.revision > afterRevision
          || (event.revision === afterRevision && event.sequence > afterSequence));
        jsonResponse(response, 200, { events, toRevision: events.at(-1)?.revision ?? afterRevision,
          toSequence: events.at(-1)?.sequence ?? (afterSequence < 0 ? null : afterSequence),
          currentRevision: state.revision, hasMore: false });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/items/batch") {
        const body = JSON.parse((await readBody(request)).toString("utf8"));
        const key = String(request.headers["idempotency-key"] || "");
        if (key && state.idempotent.has(key)) {
          jsonResponse(response, 200, state.idempotent.get(key));
          return;
        }
        if (Number(body.expectedRevision) !== state.revision) {
          jsonResponse(response, 409, { code: "REVISION_CONFLICT", currentRevision: state.revision });
          return;
        }
        commit(body.operations);
        const result = { ok: true, revision: state.revision, updatedAt: state.updatedAt };
        if (key) state.idempotent.set(key, result);
        jsonResponse(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/photos/presign") {
        const body = JSON.parse((await readBody(request)).toString("utf8"));
        jsonResponse(response, 200, { objectKey: `photos/${body.itemId}/${body.sha256}.png`,
          uploadUrl: `https://smoke-oss.invalid/upload/${body.sha256}`, headers: {} });
        return;
      }
      if (request.method === "PUT" && url.pathname.startsWith("/upload/")) {
        state.uploads.set(path.posix.basename(url.pathname), await readBody(request));
        response.writeHead(200, { "x-tek-stock-authority-id": "smoke-local" });
        response.end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/photos/commit") {
        const body = JSON.parse((await readBody(request)).toString("utf8"));
        const item = state.items.find((candidate) => candidate.id === body.itemId);
        assert.ok(item);
        const updated = { ...item, image: body.objectKey, imageSha256: body.sha256,
          imageVersion: body.imageVersion };
        commit([{ type: "upsert", item: updated }]);
        jsonResponse(response, 200, { ok: true, revision: state.revision, updatedAt: state.updatedAt });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/photos/")) {
        const digest = path.posix.basename(url.pathname).split(".")[0];
        const bytes = state.uploads.get(digest);
        if (!bytes) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { "content-type": "image/png",
          "x-tek-stock-authority-id": "smoke-local" });
        response.end(bytes);
        return;
      }
      jsonResponse(response, 404, { code: "NOT_FOUND" });
    } catch (error) {
      jsonResponse(response, 500, { code: error.code || "SMOKE_SERVER_FAILED", message: error.message });
    }
  });
  return { server, state };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function manifest(role, mode, serverOrigin, resultName) {
  const profile = path.join(root, `profile-${role.toLowerCase()}`);
  return {
    version: 1, nonce, root, role, mode, serverOrigin,
    userDataPath: path.join(profile, "user-data"),
    localAppDataPath: path.join(profile, "local-app-data"),
    documentsPath: path.join(profile, "documents"),
    controlDirectory: path.join(root, "control"),
    resultPath: path.join(profile, resultName),
  };
}

function launch(exe, data, name) {
  const manifestPath = path.join(root, `${name}.json`);
  atomicJson(manifestPath, data);
  const outputLines = [];
  const child = spawn(exe, [`--tek-stock-isolated-smoke=${manifestPath}`], {
    windowsHide: true,
    env: { ...process.env, TEK_STOCK_ISOLATED_SMOKE: "1", TEK_STOCK_SMOKE_NONCE: nonce },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => outputLines.push(chunk.toString()));
  child.stderr.on("data", (chunk) => outputLines.push(chunk.toString()));
  return { child, data, outputLines };
}

async function waitForFile(file, processes, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    for (const processInfo of processes) {
      if (processInfo.child.exitCode != null
          && (processInfo.child.exitCode !== 0 || !fs.existsSync(processInfo.data.resultPath))) {
        let result = "";
        if (fs.existsSync(processInfo.data.resultPath)) {
          result = `\n${fs.readFileSync(processInfo.data.resultPath, "utf8")}`;
        }
        throw new Error(`Packaged process exited ${processInfo.child.exitCode} before ${file}\n${processInfo.outputLines.join("")}${result}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${file}\n${processes.flatMap((value) => value.outputLines).join("")}`);
}

async function waitForExit(processInfo, timeoutMs = 30_000) {
  if (processInfo.child.exitCode != null) return processInfo.child.exitCode;
  return Promise.race([
    new Promise((resolve) => processInfo.child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      `Packaged process did not exit\n${processInfo.outputLines.join("")}`,
    )), timeoutMs)),
  ]);
}

function control(name, value = { ok: true }) {
  atomicJson(path.join(root, "control", name), value);
}

function comparable(items) {
  return items.map(({ embeddedImageDataUrl: _data, ...item }) => ({
    ...item,
    image: item.imageSha256 ? `sha256:${item.imageSha256}` : String(item.image || ""),
  }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function snapshotFiles(files) {
  return Object.fromEntries(Object.entries(files).map(([name, file]) => [name, {
    path: file, bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)),
  }]));
}

function extractArtifact(artifact, destination) {
  const result = spawnSync(sevenZip, ["x", artifact, `-o${destination}`, "-aoa", "-y"], {
    encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

async function main() {
  assert.equal(process.platform, "win32");
  for (const file of [executable, oldArtifact, currentArtifact, sevenZip]) assert.equal(fs.existsSync(file), true, file);
  const cloud = createCloudServer();
  const serverOrigin = await listen(cloud.server);
  const children = [];
  try {
    const workflows = ["A", "B"].map((role) => {
      const info = launch(executable, manifest(role, "workflow", serverOrigin, "workflow-result.json"), `workflow-${role}`);
      children.push(info);
      return info;
    });
    for (const role of ["A", "B"]) {
      await waitForFile(path.join(root, "control", `${role}-ready.json`), workflows);
    }
    control("phase1-go");
    for (const role of ["A", "B"]) {
      await waitForFile(path.join(root, "control", `${role}-phase1.json`), workflows);
    }
    control("phase2-go");
    for (const role of ["A", "B"]) {
      await waitForFile(path.join(root, "control", `${role}-phase2.json`), workflows);
    }
    control("finish-go");
    const workflowResults = [];
    for (const info of workflows) {
      workflowResults.push(await waitForFile(info.data.resultPath, workflows));
      assert.equal(await waitForExit(info), 0, info.outputLines.join(""));
    }
    const verifies = ["A", "B"].map((role) => {
      const info = launch(executable, manifest(role, "verify", serverOrigin, "verify-result.json"), `verify-${role}`);
      children.push(info);
      return info;
    });
    const verifyResults = [];
    for (const info of verifies) {
      verifyResults.push(await waitForFile(info.data.resultPath, verifies));
      assert.equal(await waitForExit(info), 0, info.outputLines.join(""));
    }
    for (const result of [...workflowResults, ...verifyResults]) {
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.updater.updateInvocations, 0);
      assert.equal(result.updater.reinstallInvocations, 0);
    }
    for (const result of verifyResults) {
      assert.match(result.dom.title, /^TEK STOCK(?: 新加坡库存)?$/);
      assert.equal(result.dom.grid, true);
      assert.equal(result.dom.preload, true);
      assert.equal(result.dom.version, `App v${packageVersion}`);
      assert.equal(result.mobileWriteError, "READ_ONLY_CLIENT");
      assert.equal(result.workbookFingerprint, result.cloudFingerprint, JSON.stringify({
        role: result.role,
        workbookFingerprint: result.workbookFingerprint,
        cloudFingerprint: result.cloudFingerprint,
        workbookItems: result.workbookItems,
        cloudItems: result.cloudItems,
      }));
      assert.equal(result.excelLive.lockDetected, true);
      assert.equal(result.excelLive.newerSavePreserved, true);
      assert.ok(result.workbookBytes > 1_000);
      assert.deepEqual(fs.readFileSync(result.workbookPath).subarray(0, 2), Buffer.from("PK"));
      assert.deepEqual(comparable(result.mobileItems), comparable(result.cloudItems));
    }
    assert.equal(verifyResults[0].workbookFingerprint, verifyResults[1].workbookFingerprint);
    assert.deepEqual(comparable(verifyResults[0].workbookItems), comparable(verifyResults[1].workbookItems));
    const models = new Map(verifyResults[0].cloudItems.map((item) => [item.model, item]));
    assert.equal(models.has("DELETE"), false);
    assert.equal(models.get("EXISTING").stock, 9);
    assert.equal(models.get("EXISTING").specification, "B EDIT");
    assert.match(models.get("EXISTING").imageSha256, /^[a-f0-9]{64}$/);
    assert.ok(models.get("A-NEW")?.id);
    assert.ok(models.get("B-NEW")?.id);

    const profileA = manifest("A", "update-audit", serverOrigin, "update-audit-result.json");
    const clientId = JSON.parse(fs.readFileSync(path.join(profileA.userDataPath, "workbook-client.json"), "utf8")).clientId;
    const stateFiles = {
      workbook: path.join(profileA.localAppDataPath, "TEK STOCK", "workbooks", clientId, "TEK-STOCK-LIVE.xlsx"),
      clientId: path.join(profileA.userDataPath, "workbook-client.json"),
      outbox: path.join(profileA.userDataPath, "central-sync", "outbox.json"),
      credentials: path.join(profileA.userDataPath, "sync-credentials.json"),
      photoCache: path.join(profileA.userDataPath, "central-sync", "photo-cache", "update-boundary", "fixture.webp"),
    };
    fs.mkdirSync(path.dirname(stateFiles.photoCache), { recursive: true });
    fs.writeFileSync(stateFiles.credentials, '{"version":1,"uploadToken":"isolated-nonsecret-fixture"}\n');
    fs.writeFileSync(stateFiles.photoCache, "isolated-photo-cache-fixture");
    const beforeUpdate = snapshotFiles(stateFiles);
    const isolatedProgramFiles = path.join(root, "ProgramFiles", "TEK STOCK");
    fs.mkdirSync(isolatedProgramFiles, { recursive: true });
    extractArtifact(oldArtifact, isolatedProgramFiles);
    const oldProgramHash = sha256(fs.readFileSync(path.join(isolatedProgramFiles, "resources", "app.asar")));
    extractArtifact(currentArtifact, isolatedProgramFiles);
    const currentProgramHash = sha256(fs.readFileSync(path.join(isolatedProgramFiles, "resources", "app.asar")));
    assert.notEqual(currentProgramHash, oldProgramHash);
    const audit = launch(path.join(isolatedProgramFiles, "TEK STOCK.exe"), profileA, "update-audit");
    children.push(audit);
    const updateResult = await waitForFile(profileA.resultPath, [audit]);
    assert.equal(await waitForExit(audit), 0, audit.outputLines.join(""));
    assert.equal(updateResult.ok, true, JSON.stringify(updateResult));
    assert.equal(updateResult.updater.updateInvocations, 0);
    assert.equal(updateResult.updater.reinstallInvocations, 0);
    assert.equal(updateResult.dom.preload, true);
    assert.match(updateResult.dom.marker, /isolated update audit/);
    const afterUpdate = snapshotFiles(stateFiles);
    assert.deepEqual(afterUpdate, beforeUpdate);

    const screenshotOutputs = new Map();
    for (const result of verifyResults) {
      const target = path.join(project, "outputs", `packaged-smoke-${packageVersion}-${result.role}.png`);
      fs.copyFileSync(result.screenshotPath, target);
      screenshotOutputs.set(result.role, target);
    }
    const summary = {
      ok: true,
      executable,
      packageVersion,
      rootWasTemporary: true,
      profiles: verifyResults.map((result) => ({
        role: result.role, workbookPath: result.workbookPath, workbookBytes: result.workbookBytes,
        fingerprint: result.workbookFingerprint, cloudRevision: result.cloudRevision,
        ids: result.cloudItems.map((item) => item.id).sort(), dom: result.dom,
        screenshot: screenshotOutputs.get(result.role),
        excelLive: result.excelLive, updater: result.updater,
      })),
      identicalFingerprint: verifyResults[0].workbookFingerprint,
      cloudItems: verifyResults[0].cloudItems,
      mobileReadOnly: true,
      updateBoundary: { before: beforeUpdate, after: afterUpdate, oldProgramHash, currentProgramHash,
        updater: updateResult.updater, auditDom: updateResult.dom },
      office: { realAutomationUsed: false,
        residual: "WPS was already running and a dedicated isolated COM instance could not be proven; production excel-live lock/CAS race harness was used." },
    };
    atomicJson(output, summary);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    for (const info of children) {
      if (info.child.exitCode == null) info.child.kill();
    }
    await Promise.all(children.map((info) => info.child.exitCode == null
      ? Promise.race([
        new Promise((resolve) => info.child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ])
      : undefined));
    await new Promise((resolve) => cloud.server.close(resolve));
    safeCleanup();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  try { safeCleanup(); } catch {}
  process.exitCode = 1;
});
