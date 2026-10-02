"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../inventory/app.js"), "utf8");
const start = source.indexOf("async function handleUpdateClick()");
const end = source.indexOf("\n  function searchable", start);
function runUpdate(synced) {
  const actions = [];
  const context = { updateInventory: async () => { actions.push("data-sync"); return synced; },
    applyNewerDesktopUpdate: async (automatic, options) => { assert.equal(automatic, false); assert.equal(options.preserveDataSyncFailure, !synced); actions.push("verified-native-update"); return "checked"; } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + "; this.invokeUpdate = handleUpdateClick;", context);
  return context.invokeUpdate().then(result => ({ actions, result }));
}
test("a failed Excel sync still checks the native updater for a repair release", async () => {
  assert.deepEqual(await runUpdate(false), { actions: ["data-sync", "verified-native-update"], result: "checked" });
});
test("a successful Excel sync keeps the existing verified update path", async () => {
  assert.deepEqual(await runUpdate(true), { actions: ["data-sync", "verified-native-update"], result: "checked" });
});

test("a successful app check keeps the failed data-sync receipt visible", async () => {
  const rendered = [];
  const context = { window: { TekStockUpdater: { update: async () => ({ ok: true, updateAvailable: false, receipt: { action: "check" } }) } },
    reportMaintenanceState: async () => {}, renderUpdateReceipt: receipt => rendered.push(receipt), toast: () => {}, showRecovery: () => {} };
  vm.createContext(context);
  const begin = source.indexOf("async function applyNewerDesktopUpdate(");
  vm.runInContext(source.slice(begin, start) + ";this.checkUpdate = applyNewerDesktopUpdate;", context);
  await context.checkUpdate(false, { preserveDataSyncFailure: true });
  assert.equal(rendered.length, 0);
  await context.checkUpdate(false, { preserveDataSyncFailure: false });
  assert.equal(rendered.length, 1);
});
