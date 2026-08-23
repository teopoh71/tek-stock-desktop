"use strict";

const updateConfig = require("./electron-builder.update.cjs");

module.exports = {
  ...updateConfig,
  directories: {
    ...updateConfig.directories,
    output: "dist-boss-user",
  },
  nsis: {
    ...updateConfig.nsis,
    oneClick: true,
    perMachine: false,
    allowElevation: false,
    artifactName: "TEK-STOCK-Singapore-${version}-${arch}-user.${ext}",
  },
};
