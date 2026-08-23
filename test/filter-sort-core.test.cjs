"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../inventory/filter-sort-core.js");

const helpers = {
  categoryLabel: (value) => String(value || "").trim(),
  itemStock: (item) => Number(item.stock) || 0,
  searchable: (item) => [item.model, item.category, item.specification].join(" ").toLocaleLowerCase(),
};

const items = [
  { id: "chair-low", model: "CHAIR LOW", category: "餐椅", stock: 2, image: "assets/images/edited-chair-low.webp", createdAt: "2026-08-01T08:00:00.000Z" },
  { id: "chair-high", model: "CHAIR HIGH", category: "餐椅", stock: 8, image: "assets/images/edited-chair-high.webp", createdAt: "2026-08-05T08:00:00.000Z" },
  { id: "table-mid", model: "TABLE MID", category: "餐桌", stock: 5, image: "assets/images/edited-table.webp", createdAt: "2026-08-03T08:00:00.000Z" },
  { id: "legacy-table", model: "TABLE LEGACY", category: "餐桌", stock: 9, image: "assets/images/edited-table-legacy.webp" },
];

test("single and multi category selection use OR semantics", () => {
  assert.deepEqual(core.filterItems(items, { selectedCategories: new Set(["餐椅"]) }, helpers).map((item) => item.id), ["chair-low", "chair-high"]);
  assert.deepEqual(core.filterItems(items, { selectedCategories: new Set(["餐椅", "餐桌"]) }, helpers).map((item) => item.id), items.map((item) => item.id));
});

test("toggling a selected category removes it and empty selection means all", () => {
  const selected = new Set(["餐椅"]);
  assert.deepEqual([...core.toggleCategorySelection(selected, "餐椅")], []);
  assert.deepEqual(core.filterItems(items, { selectedCategories: new Set() }, helpers).map((item) => item.id), items.map((item) => item.id));
});

test("descending and ascending stock sort only the current filtered result", () => {
  const filtered = core.filterItems(items, { selectedCategories: new Set(["餐椅", "餐桌"]) }, helpers);
  const originalOrder = filtered.map((item) => item.id);
  assert.deepEqual(core.sortItems(filtered, "desc", helpers).map((item) => item.id), ["legacy-table", "chair-high", "table-mid", "chair-low"]);
  assert.deepEqual(core.sortItems(filtered, "asc", helpers).map((item) => item.id), ["chair-low", "table-mid", "chair-high", "legacy-table"]);
  assert.deepEqual(filtered.map((item) => item.id), originalOrder);
});

test("newest sort puts valid createdAt values first and legacy missing dates last", () => {
  assert.deepEqual(core.sortItems(items, "newest", helpers).map((item) => item.id), ["chair-high", "table-mid", "chair-low", "legacy-table"]);
  assert.deepEqual(core.missingCreatedAt(items).map((item) => item.id), ["legacy-table"]);
});

test("representative photos are approved real images from their own category", () => {
  const photos = core.representativePhotos(items, helpers.categoryLabel, (item) => /^assets\/images\/edited-[a-z0-9-]+\.webp$/.test(item.image) ? item.image : "");
  assert.equal(photos.get("餐椅").sourceId, "chair-high");
  assert.equal(photos.get("餐椅").image, "assets/images/edited-chair-high.webp");
  assert.equal(photos.get("餐桌").sourceId, "legacy-table");
  assert.equal(photos.get("餐桌").category, "餐桌");
});
