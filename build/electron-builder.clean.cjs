"use strict";

const updateConfig = require("./electron-builder.update.cjs");

module.exports = {
  ...updateConfig,
  directories: { ...updateConfig.directories, output: "dist-clean" },
  nsis: {
    ...updateConfig.nsis,
    include: "build/clean-reinstall.nsh",
    artifactName: "TEK-STOCK-Clean-Reinstall-${version}-${arch}.${ext}",
    // Ordinary uninstall packages retain their existing user-data policy.
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
  },
};
