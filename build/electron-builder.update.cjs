"use strict";

const packageJson = require("../package.json");

module.exports = {
  ...packageJson.build,
  compression: "maximum",
  directories: {
    ...packageJson.build.directories,
    output: "dist-update",
  },
  afterPack: "./build/verify-remote-package.cjs",
  files: [
    ...packageJson.build.files,
    "!node_modules/sharp-win7/**/*",
    "!node_modules/**/*.md",
    "!node_modules/**/*.map",
    "!node_modules/**/test/**/*",
    "!node_modules/**/tests/**/*",
    "!node_modules/**/__tests__/**/*",
    "!node_modules/**/docs/**/*",
    "!test/**/*",
    "!tests/**/*",
    "!**/*.xlsx",
    "!**/*.xlsm",
    "!**/*.xls",
    "!**/backups/**/*",
    "!**/workbook-client.json",
    "!**/sync-credentials.json",
    "!**/credentials*.json",
    "!**/*token*.json",
    "!**/outbox.json",
    "!**/photo-cache/**/*",
    "!**/.env*",
    "!**/*.pem",
    "!**/*.key",
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
    artifactName: "TEK-STOCK-新加坡库存-${version}-${arch}.${ext}",
  },
};
