"use strict";

function createElectronFetch(electronNet) {
  if (!electronNet || typeof electronNet.fetch !== "function") return undefined;
  return electronNet.fetch.bind(electronNet);
}

module.exports = { createElectronFetch };
