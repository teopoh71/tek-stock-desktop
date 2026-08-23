"use strict";

process.env.TEK_STOCK_TEST = "1";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  ensureLatestDesktopShortcut,
  latestInstalledExecutable,
} = require("../main.cjs");

test("machine-wide install wins over an older per-user executable", () => {
  const machine = "C:\\Program Files\\TEK STOCK\\TEK STOCK.exe";
  assert.equal(latestInstalledExecutable({
    env: { ProgramFiles: "C:\\Program Files" },
    currentExecutable: "C:\\Users\\Edwin\\AppData\\Local\\Programs\\TEK STOCK\\TEK STOCK.exe",
    fsApi: { existsSync: (candidate) => candidate === machine },
    pathApi: path.win32,
  }), machine);
});

test("current executable is used when no machine install exists", () => {
  const current = "D:\\TEK STOCK\\TEK STOCK.exe";
  assert.equal(latestInstalledExecutable({
    env: {},
    currentExecutable: current,
    fsApi: { existsSync: () => false },
    pathApi: path.win32,
  }), current);
});

test("every packaged Windows launch replaces the exact TEK STOCK desktop shortcut", () => {
  const calls = [];
  const target = "C:\\Program Files\\TEK STOCK\\TEK STOCK.exe";
  const shortcut = "C:\\Users\\Edwin\\Desktop\\TEK STOCK.lnk";
  const result = ensureLatestDesktopShortcut({
    appApi: {
      isPackaged: true,
      getPath: (name) => {
        assert.equal(name, "desktop");
        return "C:\\Users\\Edwin\\Desktop";
      },
    },
    shellApi: {
      writeShortcutLink: (...args) => {
        calls.push(args);
        return true;
      },
    },
    fsApi: { existsSync: (candidate) => candidate === target || candidate === shortcut },
    pathApi: path.win32,
    platform: "win32",
    env: { ProgramFiles: "C:\\Program Files" },
    currentExecutable: "C:\\Users\\Edwin\\AppData\\Local\\Programs\\TEK STOCK\\TEK STOCK.exe",
  });

  assert.equal(result, true);
  assert.deepEqual(calls, [[shortcut, "replace", {
    target,
    args: "",
    cwd: "C:\\Program Files\\TEK STOCK",
    icon: target,
    iconIndex: 0,
    description: "TEK STOCK latest version",
    appUserModelId: "com.samlee.inventory",
  }]]);
});

test("development and non-Windows runs never touch the desktop", () => {
  const shellApi = { writeShortcutLink: () => assert.fail("shortcut must not be written") };
  assert.equal(ensureLatestDesktopShortcut({
    appApi: { isPackaged: false },
    shellApi,
    platform: "win32",
  }), false);
  assert.equal(ensureLatestDesktopShortcut({
    appApi: { isPackaged: true },
    shellApi,
    platform: "linux",
  }), false);
});
