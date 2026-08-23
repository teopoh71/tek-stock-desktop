"use strict";

const packageJson = require("../package.json");

module.exports = {
  ...packageJson.build,
  electronVersion: "22.3.27",
  compression: "maximum",
  directories: {
    ...packageJson.build.directories,
    output: "dist-win7",
  },
  files: [
    ...packageJson.build.files,
    "!node_modules/sharp/**/*",
    "!node_modules/@img/**/*",
    "!node_modules/**/*.md",
    "!node_modules/**/*.map",
    "!node_modules/**/test/**/*",
    "!node_modules/**/tests/**/*",
    "!node_modules/**/docs/**/*",
  ],
  win: {
    ...packageJson.build.win,
    target: [{ target: "msi", arch: ["x64"] }],
  },
  msi: {
    ...packageJson.build.msi,
    artifactName: "TEK-STOCK-Windows7-${version}-${arch}.${ext}",
  },
};
