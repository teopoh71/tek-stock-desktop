"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

function isProcessAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForParentExit(pid, options = {}) {
  const intervalMs = options.intervalMs || 250;
  const timeoutMs = options.timeoutMs || 30_000;
  const kill = options.kill || process.kill;
  const startedAt = Date.now();
  while (isProcessAlive(pid, kill)) {
    if (Date.now() - startedAt >= timeoutMs) {
      const error = new Error("UPDATE_PARENT_EXIT_TIMEOUT");
      error.code = "UPDATE_PARENT_EXIT_TIMEOUT";
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(Number(code)));
  });
}

function validateArguments(installerPath, parentPid, installMode) {
  const input = String(installerPath || "");
  const resolved = path.resolve(input);
  const extension = path.extname(resolved).toLowerCase();
  const pid = Number(parentPid);
  if (!path.isAbsolute(input)
      || ![".msi", ".exe"].includes(extension)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}\.(?:msi|exe)$/i.test(path.basename(resolved))
      || !Number.isSafeInteger(pid)
      || pid <= 0
      || !["repair", "upgrade"].includes(installMode)) {
    const error = new Error("UPDATE_HELPER_ARGUMENTS_INVALID");
    error.code = "UPDATE_HELPER_ARGUMENTS_INVALID";
    throw error;
  }
  return {
    installerPath: resolved,
    installerName: path.basename(resolved),
    installerType: extension.slice(1),
    parentPid: pid,
    installMode,
  };
}

async function run(options = {}) {
  const args = validateArguments(
    options.installerPath ?? process.argv[2],
    options.parentPid ?? process.argv[3],
    options.installMode ?? process.argv[4],
  );
  await waitForParentExit(args.parentPid, options);
  const delay = options.delay || ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  await delay(options.settleDelayMs ?? 1200);
  const logPath = path.join(path.dirname(args.installerPath), "TEK-STOCK-reinstall.log");
  const launch = options.spawn || spawn;
  const systemRoot = options.systemRoot || process.env.SystemRoot || "C:\\Windows";
  const msiexecPath = path.join(systemRoot, "System32", "msiexec.exe");
  const runInstaller = async (command, installerArguments) => {
    const installer = launch(command, installerArguments, {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    const exitCode = await waitForChildExit(installer);
    if (exitCode !== 0 && exitCode !== 3010) {
      const error = new Error(`UPDATE_INSTALLER_EXIT_${exitCode}`);
      error.code = "UPDATE_INSTALLER_FAILED";
      error.exitCode = exitCode;
      throw error;
    }
    return exitCode;
  };
  const standardArguments = ["/passive", "/norestart", "/l*v", logPath];
  // Run exactly one MSI transaction. Running a normal upgrade and then an
  // immediate forced repair lets Windows Installer restart TEK STOCK between
  // passes; the repair then sees app.asar in use, schedules files for reboot,
  // returns 3010, and prevents the helper from reopening the app.
  const installerArguments = args.installerType === "exe"
    ? ["/S"]
    : args.installMode === "upgrade"
      ? ["/i", args.installerPath, ...standardArguments]
      : [
        "/i",
        args.installerPath,
        "REINSTALL=ALL",
        "REINSTALLMODE=amus",
        ...standardArguments,
      ];
  const installExitCode = await runInstaller(
    args.installerType === "exe" ? args.installerPath : msiexecPath,
    installerArguments,
  );
  const rebootRequired = installExitCode === 3010;

  const programFiles = options.programFiles || process.env.ProgramFiles || "";
  const installedExecutable = options.installedExecutable
    || (programFiles ? path.join(programFiles, "TEK STOCK", "TEK STOCK.exe") : "");
  const exists = options.existsSync || fs.existsSync;
  let appLaunched = false;
  if (!rebootRequired && installedExecutable && exists(installedExecutable)) {
    const app = launch(installedExecutable, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      app.once("spawn", resolve);
      app.once("error", reject);
    });
    app.unref?.();
    appLaunched = true;
  }
  return { logPath, installExitCode, installedExecutable, appLaunched, rebootRequired };
}

if (require.main === module) {
  run().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}

module.exports = {
  isProcessAlive,
  run,
  validateArguments,
  waitForChildExit,
  waitForParentExit,
};
