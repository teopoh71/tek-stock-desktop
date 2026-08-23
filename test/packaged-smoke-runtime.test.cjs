"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  configureSmokeAppPaths,
  createSmokeFetch,
  loadIsolatedSmokeRequest,
  registerSmokeUpdaterIpc,
} = require("../packaged-smoke-runtime.cjs");

function smokeManifest(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tek-stock-packaged-smoke-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = {
    version: 1,
    nonce: "0123456789abcdef0123456789abcdef",
    root,
    role: "A",
    mode: "workflow",
    serverOrigin: "http://127.0.0.1:41777",
    userDataPath: path.join(root, "profile-a", "user-data"),
    localAppDataPath: path.join(root, "profile-a", "local-app-data"),
    documentsPath: path.join(root, "profile-a", "documents"),
    controlDirectory: path.join(root, "control"),
    resultPath: path.join(root, "profile-a", "result.json"),
    ...overrides,
  };
  const manifestPath = path.join(root, "profile-a.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { manifest, manifestPath, root };
}

test("isolated packaged smoke requires both gates and contains every writable path", (t) => {
  const fixture = smokeManifest(t);
  const argv = ["TEK STOCK.exe", `--tek-stock-isolated-smoke=${fixture.manifestPath}`];
  assert.equal(loadIsolatedSmokeRequest({ argv, env: {} }), null);
  assert.equal(loadIsolatedSmokeRequest({
    argv: ["TEK STOCK.exe"],
    env: {
      TEK_STOCK_ISOLATED_SMOKE: "1",
      TEK_STOCK_SMOKE_NONCE: fixture.manifest.nonce,
    },
  }), null);

  const request = loadIsolatedSmokeRequest({
    argv,
    env: {
      TEK_STOCK_ISOLATED_SMOKE: "1",
      TEK_STOCK_SMOKE_NONCE: fixture.manifest.nonce,
    },
  });
  assert.equal(request.root, path.resolve(fixture.root));
  assert.equal(request.role, "A");
  assert.equal(request.serverOrigin, "http://127.0.0.1:41777");

  const escaped = smokeManifest(t, {
    resultPath: path.join(path.dirname(fixture.root), "escaped-result.json"),
  });
  assert.throws(() => loadIsolatedSmokeRequest({
    argv: ["TEK STOCK.exe", `--tek-stock-isolated-smoke=${escaped.manifestPath}`],
    env: {
      TEK_STOCK_ISOLATED_SMOKE: "1",
      TEK_STOCK_SMOKE_NONCE: escaped.manifest.nonce,
    },
  }), { code: "SMOKE_PATH_OUTSIDE_ROOT" });
});

test("smoke path configuration redirects every Electron writable location", (t) => {
  const { manifest, manifestPath } = smokeManifest(t);
  const request = loadIsolatedSmokeRequest({
    argv: ["TEK STOCK.exe", `--tek-stock-isolated-smoke=${manifestPath}`],
    env: { TEK_STOCK_ISOLATED_SMOKE: "1", TEK_STOCK_SMOKE_NONCE: manifest.nonce },
  });
  const configured = new Map();
  configureSmokeAppPaths({ setPath: (name, value) => configured.set(name, value) }, request);
  assert.deepEqual(Object.fromEntries(configured), {
    userData: path.resolve(manifest.userDataPath),
    documents: path.resolve(manifest.documentsPath),
    desktop: path.resolve(manifest.root, "desktop"),
    temp: path.resolve(manifest.root, "temp"),
    home: path.resolve(manifest.root, "home"),
  });
  for (const directory of configured.values()) assert.equal(fs.statSync(directory).isDirectory(), true);
});

test("smoke updater channels are disabled and count any forbidden invocation", async () => {
  const handlers = new Map();
  const counters = registerSmokeUpdaterIpc({
    handle: (channel, handler) => handlers.set(channel, handler),
  }, "1.5.61");
  assert.equal((await handlers.get("tek-stock-updater-status")()).ok, true);
  assert.deepEqual(await handlers.get("tek-stock-updater-update")(), {
    ok: false,
    errorCode: "SMOKE_UPDATER_DISABLED",
  });
  assert.deepEqual(await handlers.get("tek-stock-updater-reinstall")(), {
    ok: false,
    errorCode: "SMOKE_UPDATER_DISABLED",
  });
  assert.deepEqual(counters, { updateInvocations: 1, reinstallInvocations: 1 });
});

test("smoke fetch redirects only the two reserved HTTPS hosts to loopback", async (t) => {
  const { manifest, manifestPath } = smokeManifest(t);
  const request = loadIsolatedSmokeRequest({
    argv: ["TEK STOCK.exe", `--tek-stock-isolated-smoke=${manifestPath}`],
    env: { TEK_STOCK_ISOLATED_SMOKE: "1", TEK_STOCK_SMOKE_NONCE: manifest.nonce },
  });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("ok");
  };
  const fetchSmoke = createSmokeFetch(request, fetchImpl);
  await fetchSmoke("https://smoke-api.invalid/v1/snapshot?after=2", { method: "GET" });
  await fetchSmoke("https://smoke-oss.invalid/photos/item/photo.webp", { method: "GET" });
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:41777/v1/snapshot?after=2",
    "http://127.0.0.1:41777/photos/item/photo.webp",
  ]);
  await assert.rejects(fetchSmoke("https://example.com/v1/snapshot"), {
    code: "SMOKE_NETWORK_TARGET_REJECTED",
  });
});
