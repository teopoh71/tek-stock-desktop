"use strict";

process.env.TEK_STOCK_TEST = "1";
delete process.env.TEK_STOCK_UPDATE_MANIFEST_URL;

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const test = require("node:test");
const { createHash } = require("node:crypto");

const {
  DEFAULT_INSTALLER_TIMEOUT_MS,
  downloadVerifiedInstaller,
  isVersionNewer,
  requireHttpsUrl,
  selectWindowsChannel,
} = require("../updater-core.cjs");
const { registerUpdaterIpc } = require("../main.cjs");

function manifestFor(buffer) {
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  return {
    desktop: {
      version: "1.6.0",
      windows7: { url: "https://example.test/win7.msi", sha256, size: buffer.length },
      windows10: { url: "https://example.test/win10.msi", sha256, size: buffer.length },
    },
    android: { version: "1.4.0", url: "https://example.test/app.apk", sha256 },
  };
}

function fakeHttps(buffer, statusCode = 200, observations = {}) {
  return {
    get(_url, _options, callback) {
      const request = new EventEmitter();
      request.setTimeout = (timeout) => { observations.timeout = timeout; };
      request.destroy = (error) => request.emit("error", error);
      process.nextTick(() => {
        const response = Readable.from([buffer]);
        response.statusCode = statusCode;
        response.headers = { "content-length": String(buffer.length) };
        callback(response);
      });
      return request;
    },
  };
}

function fakeElectronNet(buffer, observations = {}) {
  return {
    request(options) {
      observations.requests = (observations.requests || 0) + 1;
      observations.url = options.url;
      observations.redirect = options.redirect;
      const request = new EventEmitter();
      request.abort = () => { observations.aborted = true; };
      request.end = () => {
        const response = Readable.from([buffer]);
        response.statusCode = 200;
        response.headers = { "content-length": String(buffer.length) };
        queueMicrotask(() => request.emit("response", response));
      };
      return request;
    },
  };
}

test("release manifest selects dedicated Windows 7 and Windows 10 installers", () => {
  const manifest = manifestFor(Buffer.from("msi"));
  assert.equal(selectWindowsChannel(manifest, "6.1.7601").channel, "windows7");
  assert.equal(selectWindowsChannel(manifest, "6.1.7601").name, "win7.msi");
  assert.match(selectWindowsChannel(manifest, "6.1.7601").url, /win7\.msi$/);
  assert.equal(selectWindowsChannel(manifest, "10.0.22631").channel, "windows10");
  assert.match(selectWindowsChannel(manifest, "10.0.22631").url, /win10\.msi$/);
});

test("update alert appears only when the online version is newer", () => {
  assert.equal(isVersionNewer("1.5.35", "1.5.34"), true);
  assert.equal(isVersionNewer("1.6.0", "1.5.34"), true);
  assert.equal(isVersionNewer("1.5.34", "1.5.34"), false);
  assert.equal(isVersionNewer("1.5.32", "1.5.34"), false);
  assert.equal(isVersionNewer("invalid", "1.5.34"), false);
});

test("updater accepts verified MSI or NSIS EXE and rejects unsupported or malformed releases", () => {
  assert.throws(() => requireHttpsUrl("http://example.test/file.msi"), { code: "UPDATE_URL_INVALID" });
  assert.throws(() => requireHttpsUrl("https://user:pass@example.test/file.msi"), { code: "UPDATE_URL_INVALID" });
  const manifest = manifestFor(Buffer.from("msi"));
  manifest.desktop.windows10.url = "https://example.test/file.exe";
  manifest.desktop.windows10.name = "file.exe";
  assert.equal(selectWindowsChannel(manifest, "10.0").name, "file.exe");
  manifest.desktop.windows10.url = "https://example.test/file.zip";
  manifest.desktop.windows10.name = "file.zip";
  assert.throws(() => selectWindowsChannel(manifest, "10.0"), { code: "UPDATE_INSTALLER_NOT_SUPPORTED" });
  manifest.desktop.windows10.url = "https://example.test/bad%20name.msi";
  assert.throws(() => selectWindowsChannel(manifest, "10.0"), { code: "UPDATE_INSTALLER_NAME_INVALID" });
  manifest.desktop.windows10.url = "https://example.test/file.msi";
  manifest.desktop.windows10.sha256 = "bad";
  assert.throws(() => selectWindowsChannel(manifest, "10.0"), { code: "UPDATE_SHA256_INVALID" });
});

test("installer download is kept only after size and SHA-256 verification", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-updater-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("verified-msi-content");
  const release = selectWindowsChannel(manifestFor(bytes), "10.0");
  const destination = path.join(directory, "verified.msi");
  const result = await downloadVerifiedInstaller(release, destination, { https: fakeHttps(bytes) });
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(fs.readFileSync(destination), bytes);

  const badDestination = path.join(directory, "bad.msi");
  await assert.rejects(
    downloadVerifiedInstaller({ ...release, sha256: "0".repeat(64) }, badDestination, {
      https: fakeHttps(bytes),
    }),
    { code: "UPDATE_SHA256_MISMATCH" },
  );
  assert.equal(fs.existsSync(badDestination), false);
});

test("large installer downloads use a cross-region-safe inactivity timeout", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-updater-timeout-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("streamed-msi");
  const observations = {};
  const release = selectWindowsChannel(manifestFor(bytes), "10.0");
  await downloadVerifiedInstaller(release, path.join(directory, "streamed.msi"), {
    https: fakeHttps(bytes, 200, observations),
  });
  assert.equal(observations.timeout, DEFAULT_INSTALLER_TIMEOUT_MS);
});

test("installer download prefers Electron networking so Windows proxy settings are honored", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-updater-proxy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("system-proxy-msi");
  const observations = {};
  const release = selectWindowsChannel(manifestFor(bytes), "10.0");
  const directHttps = {
    get() {
      throw new Error("Node HTTPS must not be used when Electron networking is available");
    },
  };
  const result = await downloadVerifiedInstaller(release, path.join(directory, "proxy.msi"), {
    electronNet: fakeElectronNet(bytes, observations),
    https: directHttps,
  });
  assert.equal(result.bytes, bytes.length);
  assert.equal(observations.requests, 1);
  assert.equal(observations.redirect, "manual");
});

test("manifest check retries bounded Hangzhou OSS primary then falls back to Singapore OSS", async () => {
  const handlers = new Map();
  const seen = [];
  const receipts = [];
  const bytes = Buffer.from("msi");
  registerUpdaterIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: {
      getPath: () => os.tmpdir(),
      getVersion: () => "1.5.15",
    },
    osRelease: "10.0",
    fetchReleaseManifest: async (url, options) => {
      seen.push({ url, timeoutMs: options.timeoutMs });
      if (seen.length <= 2) throw Object.assign(new Error("timeout"), { code: "UPDATE_NETWORK_TIMEOUT" });
      return manifestFor(bytes);
    },
    writeUpdateReceipt: (receipt) => { receipts.push(receipt); return receipt; },
  });
  const status = await handlers.get("tek-stock-updater-status")();
  assert.equal(status.ok, true);
  assert.deepEqual(seen.map(({ url }) => new URL(url).hostname), [
    "tek-stock-releases-cn-20260801.oss-cn-hangzhou.aliyuncs.com",
    "tek-stock-releases-cn-20260801.oss-cn-hangzhou.aliyuncs.com",
    "tek-stock-releases-sg-20260729.oss-ap-southeast-1.aliyuncs.com",
  ]);
  assert.ok(seen.every(({ timeoutMs }) => timeoutMs === 8_000));
  assert.deepEqual(receipts, [{
    action: "check",
    checkRan: true,
    currentVersion: "1.5.15",
    downloadOutcome: "not_requested",
    launchOutcome: "not_requested",
    availableVersion: "1.6.0",
    newerVersionFound: true,
    installerFound: true,
    channel: "windows10",
    manifestSource: "singapore",
  }]);
});

test("failed manifest check still returns and stores a concrete receipt", async () => {
  const handlers = new Map();
  const receipts = [];
  registerUpdaterIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { getPath: () => os.tmpdir(), getVersion: () => "1.5.52" },
    manifestUrls: ["https://example.test/latest.json"],
    fetchReleaseManifest: async () => {
      throw Object.assign(new Error("timeout"), { code: "UPDATE_NETWORK_TIMEOUT" });
    },
    writeUpdateReceipt: (receipt) => { receipts.push(receipt); return receipt; },
  });
  const result = await handlers.get("tek-stock-updater-status")();
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "UPDATE_NETWORK_TIMEOUT");
  assert.equal(result.receipt.checkRan, true);
  assert.equal(result.receipt.currentVersion, "1.5.52");
  assert.equal(result.receipt.installerFound, undefined);
  assert.equal(result.receipt.errorCode, "UPDATE_NETWORK_TIMEOUT");
  assert.equal(receipts.length, 1);
});

test("Update does not download or launch when the installed app is current", async () => {
  const handlers = new Map();
  const receipts = [];
  let downloads = 0;
  let launches = 0;
  const bytes = Buffer.from("msi");
  registerUpdaterIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { getPath: () => os.tmpdir(), getVersion: () => "1.6.0" },
    osRelease: "10.0",
    fetchReleaseManifest: async () => manifestFor(bytes),
    downloadVerifiedInstaller: async () => { downloads += 1; },
    spawn: () => { launches += 1; },
    writeUpdateReceipt: (receipt) => { receipts.push({ ...receipt }); return receipt; },
  });

  const result = await handlers.get("tek-stock-updater-update")();
  assert.equal(result.ok, true);
  assert.equal(result.updateAvailable, false);
  assert.equal(downloads, 0);
  assert.equal(launches, 0);
  assert.deepEqual(receipts.at(-1), {
    action: "user_update",
    checkRan: true,
    currentVersion: "1.6.0",
    downloadOutcome: "not_requested",
    launchOutcome: "not_requested",
    availableVersion: "1.6.0",
    newerVersionFound: false,
    installerFound: true,
    channel: "windows10",
    manifestSource: "hangzhou",
  });
});

test("Update downloads and launches only a verified newer MSI", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-auto-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const spawned = [];
  let exitCode = null;
  const bytes = Buffer.from("new-msi");
  registerUpdaterIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: {
      getPath: (name) => name === "temp" ? root : path.join(root, "user-data"),
      getVersion: () => "1.5.99",
      exit: (code) => { exitCode = code; },
    },
    osRelease: "10.0",
    fetchReleaseManifest: async () => manifestFor(bytes),
    downloadVerifiedInstaller: async (_release, destination) => {
      fs.writeFileSync(destination, bytes);
      return { path: destination, bytes: bytes.length };
    },
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
    tempPath: root,
    userDataPath: path.join(root, "user-data"),
    writeUpdateReceipt: (receipt) => receipt,
  });

  const result = await handlers.get("tek-stock-updater-update")();
  assert.equal(result.ok, true);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.receipt.action, "user_update");
  assert.equal(result.receipt.downloadOutcome, "verified");
  assert.equal(result.receipt.launchOutcome, "queued");
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args.slice(2), [String(process.pid), "upgrade"]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(exitCode, 0);
});

test("reinstall IPC downloads selected MSI, exits the app, then delegates installation to a detached helper", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-updater-ipc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handlers = new Map();
  const spawned = [];
  let exitCode = null;
  let downloadedDestination = "";
  const receipts = [];
  const bytes = Buffer.from("msi");

  registerUpdaterIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: {
      getPath: (name) => name === "temp" ? root : path.join(root, "user-data"),
      getVersion: () => "1.5.12",
      exit: (code) => { exitCode = code; },
      quit: () => { throw new Error("app.quit should not be used when app.exit is available"); },
    },
    osRelease: "6.1.7601",
    fetchReleaseManifest: async () => manifestFor(bytes),
    downloadVerifiedInstaller: async (release, destination) => {
      assert.equal(release.channel, "windows7");
      downloadedDestination = destination;
      fs.writeFileSync(destination, bytes);
      return { path: destination, bytes: bytes.length };
    },
    spawn: (command, args, options) => {
      spawned.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit("spawn"));
      return child;
    },
    tempPath: root,
    userDataPath: path.join(root, "user-data"),
    writeUpdateReceipt: (receipt) => { receipts.push({ ...receipt }); return receipt; },
  });

  const status = await handlers.get("tek-stock-updater-status")();
  assert.deepEqual(
    { ok: status.ok, installedVersion: status.installedVersion, version: status.version, isMismatch: status.isMismatch },
    { ok: true, installedVersion: "1.5.12", version: "1.6.0", isMismatch: true },
  );
  const result = await handlers.get("tek-stock-updater-reinstall")();
  assert.deepEqual(
    { ok: result.ok, channel: result.channel, version: result.version },
    { ok: true, channel: "windows7", version: "1.6.0" },
  );
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, process.execPath);
  assert.match(spawned[0].args[0], /updater-helper\.cjs$/);
  assert.match(downloadedDestination, /win7\.msi$/);
  assert.deepEqual(spawned[0].args.slice(1), [downloadedDestination, String(process.pid), "upgrade"]);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(spawned[0].options.windowsHide, true);
  assert.equal(spawned[0].options.env.ELECTRON_RUN_AS_NODE, "1");
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(exitCode, 0);
  assert.equal(receipts.at(-1).downloadOutcome, "verified");
  assert.equal(receipts.at(-1).launchOutcome, "queued");
  assert.equal(receipts.at(-1).currentVersion, "1.5.12");
  assert.equal(receipts.at(-1).availableVersion, "1.6.0");
});
