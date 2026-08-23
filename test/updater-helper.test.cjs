"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  run,
  validateArguments,
  waitForParentExit,
} = require("../updater-helper.cjs");

function exitedChild(code = 0) {
  const child = new EventEmitter();
  process.nextTick(() => child.emit("exit", code));
  return child;
}

function spawnedChild(observations) {
  const child = new EventEmitter();
  child.unref = () => observations.push("app-unref");
  process.nextTick(() => child.emit("spawn"));
  return child;
}

test("update helper accepts only verified MSI or EXE names and a valid parent PID", () => {
  assert.throws(
    () => validateArguments("C:\\Temp\\bad name.msi", 10, "upgrade"),
    { code: "UPDATE_HELPER_ARGUMENTS_INVALID" },
  );
  const result = validateArguments("C:\\Temp\\TEK-STOCK-Desktop-1.5.26-x64.msi", 10, "repair");
  assert.equal(result.parentPid, 10);
  assert.equal(result.installMode, "repair");
  assert.equal(result.installerName, "TEK-STOCK-Desktop-1.5.26-x64.msi");
  const exe = validateArguments("C:\\Temp\\TEK-STOCK-Remote-Repair-1.5.59-x64.exe", 10, "upgrade");
  assert.equal(exe.installerType, "exe");
});

test("NSIS update runs silently without Windows Installer", async () => {
  const observations = [];
  await run({
    installerPath: "C:\\Temp\\TEK-STOCK-Remote-Repair-1.5.59-x64.exe",
    parentPid: 42,
    installMode: "upgrade",
    kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    delay: async () => {},
    installedExecutable: "C:\\Program Files\\TEK STOCK\\TEK STOCK.exe",
    existsSync: () => false,
    spawn: (command, args, options) => {
      observations.push({ command, args, options });
      return exitedChild(0);
    },
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].command, "C:\\Temp\\TEK-STOCK-Remote-Repair-1.5.59-x64.exe");
  assert.deepEqual(observations[0].args, ["/S"]);
  assert.equal(observations[0].options.windowsHide, true);
});

test("helper contains no ping, cmd, or generated script-file path", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "updater-helper.cjs"), "utf8");
  assert.doesNotMatch(source, /ping\.exe/i);
  assert.doesNotMatch(source, /cmd\.exe/i);
  assert.doesNotMatch(source, /TEK-STOCK-install\.cmd/i);
  assert.doesNotMatch(source, /writeFileSync/);
});

test("upgrade waits in Node then invokes msiexec directly and launches latest app hidden", async () => {
  const observations = [];
  let checks = 0;
  await run({
    installerPath: "C:\\Temp\\TEK-STOCK-Desktop-1.5.26-x64.msi",
    parentPid: 42,
    installMode: "upgrade",
    intervalMs: 1,
    timeoutMs: 100,
    kill: () => {
      checks += 1;
      if (checks < 3) return;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    delay: async (milliseconds) => observations.push({ delay: milliseconds }),
    systemRoot: "C:\\Windows",
    installedExecutable: "C:\\Program Files\\TEK STOCK\\TEK STOCK.exe",
    existsSync: () => true,
    spawn: (command, args, options) => {
      observations.push({ command, args, options, checks });
      return /msiexec\.exe$/i.test(command)
        ? exitedChild(0)
        : spawnedChild(observations);
    },
  });
  assert.deepEqual(observations[0], { delay: 1200 });
  const installer = observations[1];
  assert.equal(installer.command, "C:\\Windows\\System32\\msiexec.exe");
  assert.deepEqual(installer.args, [
    "/i",
    "C:\\Temp\\TEK-STOCK-Desktop-1.5.26-x64.msi",
    "/passive",
    "/norestart",
    "/l*v",
    "C:\\Temp\\TEK-STOCK-reinstall.log",
  ]);
  assert.equal(installer.options.windowsHide, true);
  assert.equal(installer.options.detached, false);
  assert.equal(installer.args.includes("REINSTALL=ALL"), false);
  assert.equal(installer.checks, 3);
  const app = observations[2];
  assert.equal(app.command, "C:\\Program Files\\TEK STOCK\\TEK STOCK.exe");
  assert.deepEqual(app.args, []);
  assert.equal(app.options.windowsHide, true);
  assert.equal(app.options.detached, true);
  assert.equal(observations[3], "app-unref");
});

test("same-version repair keeps MSI repair properties", async () => {
  let installerLaunch;
  const result = await run({
    installerPath: "C:\\Temp\\TEK-STOCK-Desktop-1.5.26-x64.msi",
    parentPid: 42,
    installMode: "repair",
    kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    delay: async () => {},
    existsSync: () => false,
    spawn: (command, args, options) => {
      installerLaunch = { command, args, options };
      return exitedChild(3010);
    },
  });
  assert.ok(installerLaunch.args.includes("REINSTALL=ALL"));
  assert.ok(installerLaunch.args.includes("REINSTALLMODE=amus"));
  assert.equal(installerLaunch.options.windowsHide, true);
  assert.equal(result.rebootRequired, true);
  assert.equal(result.appLaunched, false);
});

test("upgrade requiring reboot skips forced repair and does not relaunch the app", async () => {
  let launches = 0;
  const result = await run({
    installerPath: "C:\\Temp\\TEK-STOCK-Desktop-1.5.26-x64.msi",
    parentPid: 42,
    installMode: "upgrade",
    kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    delay: async () => {},
    installedExecutable: "C:\\Program Files\\TEK STOCK\\TEK STOCK.exe",
    existsSync: () => true,
    spawn: () => {
      launches += 1;
      return exitedChild(3010);
    },
  });
  assert.equal(launches, 1);
  assert.equal(result.rebootRequired, true);
  assert.equal(result.appLaunched, false);
});

test("nonzero installer exit prevents application launch", async () => {
  let launches = 0;
  await assert.rejects(
    run({
      installerPath: "C:\\Temp\\TEK-STOCK-Desktop-1.5.26-x64.msi",
      parentPid: 42,
      installMode: "upgrade",
      kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
      delay: async () => {},
      existsSync: () => true,
      spawn: () => {
        launches += 1;
        return exitedChild(1603);
      },
    }),
    { code: "UPDATE_INSTALLER_FAILED", exitCode: 1603 },
  );
  assert.equal(launches, 1);
});

test("update helper stops rather than installing while the parent remains alive", async () => {
  await assert.rejects(
    waitForParentExit(42, {
      intervalMs: 1,
      timeoutMs: 2,
      kill: () => {},
    }),
    { code: "UPDATE_PARENT_EXIT_TIMEOUT" },
  );
});
