"use strict";

const packageJson = require("../package.json");

module.exports = {
  ...packageJson.build,
  compression: "maximum",
  directories: {
    ...packageJson.build.directories,
    output: "dist-remote",
  },
  afterPack: "./build/verify-remote-package.cjs",
  files: [
    ...packageJson.build.files,
    "!node_modules/sharp-win7/**/*",
    "!node_modules/**/*.md",
    "!node_modules/**/*.map",
    "!node_modules/**/test/**/*",
    "!node_modules/**/tests/**/*",
    "!node_modules/**/docs/**/*",
  ],
  win: {
    ...packageJson.build.win,
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  nsis: {
    oneClick: true,
    perMachine: true,
    allowElevation: true,
    createDesktopShortcut: "always",
    createStartMenuShortcut: true,
    shortcutName: "TEK STOCK",
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
    include: "build/remote-repair.nsh",
    artifactName: "TEK-STOCK-Remote-Repair-${version}-${arch}.${ext}",
  },
};
