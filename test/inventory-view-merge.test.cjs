"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { mergeInventoryViews } = require("../inventory/excel-sync-core.js");

function item(id, model, stock, extra = {}) {
  return {
    id,
    model,
    category: "Chair",
    specification: "",
    stock,
    ...extra,
  };
}

test("identity matches keep one logical stock value without summing online and offline", () => {
  const online = item("legacy-source.xlsx::Stock::12", "MATCHED", 5);
  const offline = item("legacy-source.xlsx::Stock::12", "MATCHED", 5);
  const result = mergeInventoryViews({ onlineItems: [online], offlineItems: [offline] });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].stock, 5);
  assert.deepEqual(result.matches, [{
    kind: "legacyId",
    key: online.id,
    onlineId: online.id,
    offlineId: offline.id,
  }]);
  assert.deepEqual(result.quantityConflicts, []);
});

test("source identity matches only when both rows have explicit unique source fields", () => {
  const online = item("cloud-id", "SOURCE-MATCH", 2, {
    sourceFile: "TEK-STOCK-LIVE.xlsx",
    sourceSheet: "库存总表",
    sourceRow: 17,
  });
  const offline = item("legacy-id", "SOURCE-MATCH", 3, {
    sourceFile: "TEK-STOCK-LIVE.xlsx",
    sourceSheet: "库存总表",
    sourceRow: 17,
  });
  const result = mergeInventoryViews({ onlineItems: [online], offlineItems: [offline] });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.matches[0].kind, "sourceIdentity");
  assert.equal(result.quantityConflicts.length, 1);
  assert.deepEqual(result.quantityConflicts[0], {
    kind: "sourceIdentity",
    key: "tek-stock-live.xlsx\u0000库存总表\u000017",
    onlineStock: 2,
    offlineStock: 3,
  });
});

test("same model with different identities remains separate and needs review", () => {
  const online = item("cloud-only", "REVIEW-MODEL", 5);
  const offline = item("offline-only", "REVIEW-MODEL", 5);
  const result = mergeInventoryViews({ onlineItems: [online], offlineItems: [offline] });

  assert.equal(result.ok, true);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.modelOnlyReview, [{
    model: "review-model",
    onlineIds: ["cloud-only"],
    offlineIds: ["offline-only"],
  }]);
});

test("duplicate identity on one side fails closed instead of hiding stock", () => {
  const first = item("same-id", "DUPLICATE", 5);
  const second = item("same-id", "DUPLICATE", 5);
  const result = mergeInventoryViews({ onlineItems: [first, second], offlineItems: [] });

  assert.equal(result.ok, false);
  assert.deepEqual(result.duplicateKeys, [{ side: "online", kind: "id", key: "same-id", count: 2 }]);
  assert.deepEqual(result.items, []);
});
