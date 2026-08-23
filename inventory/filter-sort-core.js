"use strict";

(function initFilterSortCore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.TekStockFilterSort = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function categoryValue(item, helpers) {
    return String(helpers.categoryLabel(item?.category) || item?.category || "").trim();
  }

  function stockValue(item, helpers) {
    const value = Number(helpers.itemStock(item));
    return Number.isFinite(value) ? value : 0;
  }

  function modelCompare(left, right) {
    return String(left?.model || "").localeCompare(String(right?.model || ""), "en", { numeric: true })
      || String(left?.id || "").localeCompare(String(right?.id || ""), "en", { numeric: true });
  }

  function validCreatedAt(item) {
    const value = String(item?.createdAt || "").trim();
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function toggleCategorySelection(selection, label) {
    const next = new Set(selection || []);
    const value = String(label || "").trim();
    if (!value) return next;
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  function filterItems(items, options = {}, helpers = {}) {
    const selected = new Set(options.selectedCategories || []);
    const query = String(options.query || "").trim().toLocaleLowerCase();
    const searchable = helpers.searchable || ((item) => [item.model, item.category, item.specification].join(" "));
    const stockOf = helpers.itemStock || (() => 0);
    return (items || []).filter((item) => {
      const category = categoryValue(item, helpers);
      const stock = Number(stockOf(item)) || 0;
      if (selected.size && !selected.has(category)) return false;
      if (options.stockFilter === "available" && stock <= 2) return false;
      if (options.stockFilter === "low" && !(stock > 0 && stock <= 2)) return false;
      if (options.stockFilter === "out" && stock > 0) return false;
      return !query || String(searchable(item)).toLocaleLowerCase().includes(query);
    });
  }

  function sortItems(items, direction, helpers = {}) {
    const sorted = [...(items || [])];
    const compare = (left, right) => {
      if (direction === "newest") {
        const leftTime = validCreatedAt(left);
        const rightTime = validCreatedAt(right);
        if (leftTime !== null || rightTime !== null) {
          if (leftTime === null) return 1;
          if (rightTime === null) return -1;
          if (leftTime !== rightTime) return rightTime - leftTime;
        }
      } else if (direction === "desc" || direction === "asc") {
        const difference = stockValue(left, helpers) - stockValue(right, helpers);
        if (difference) return direction === "desc" ? -difference : difference;
      }
      return modelCompare(left, right);
    };
    return sorted.sort(compare);
  }

  function missingCreatedAt(items) {
    return (items || []).filter((item) => validCreatedAt(item) === null);
  }

  function representativePhotos(items, categoryLabel, approvedImage) {
    const grouped = new Map();
    for (const item of items || []) {
      const label = String(categoryLabel(item?.category) || item?.category || "").trim();
      const image = String(approvedImage(item) || "").trim();
      if (!label || !image) continue;
      const current = grouped.get(label);
      const score = stockValue(item, { itemStock: (candidate) => candidate.stock });
      const currentScore = current ? stockValue(current, { itemStock: (candidate) => candidate.stock }) : -Infinity;
      if (!current || score > currentScore || (score === currentScore && modelCompare(item, current) < 0)) {
        grouped.set(label, { label, sourceId: item.id, model: item.model, category: label, image });
      }
    }
    return grouped;
  }

  function montagePhotos(items, categoryLabel, approvedImage, limit = 4) {
    const byCategory = representativePhotos(items, categoryLabel, approvedImage);
    return [...byCategory.values()].slice(0, Math.max(1, limit));
  }

  return {
    filterItems,
    sortItems,
    toggleCategorySelection,
    representativePhotos,
    montagePhotos,
    missingCreatedAt,
    validCreatedAt,
  };
});
