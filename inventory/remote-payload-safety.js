(function initRemotePayloadSafety(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TekStockRemoteSafety = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createRemotePayloadSafety() {
  "use strict";

  const authoritativeTextFields = [
    "category",
    "model",
    "specification",
    "arrival",
    "showroom",
    "outbound",
    "sellingPriceText",
  ];

  function looksCorrupted(value) {
    const text = String(value == null ? "" : value);
    return text.includes("\uFFFD") || /\?{2,}/.test(text);
  }

  function isSafeRemotePayload(payload) {
    const items = payload?.items;
    if (!Array.isArray(items) || items.length < 10) return false;

    const brokenCategories = items.filter((item) => {
      const category = String(item?.category || "").trim();
      return !category || looksCorrupted(category);
    }).length;

    const brokenTextFields = items.reduce((count, item) => count
      + authoritativeTextFields.filter((field) => looksCorrupted(item?.[field])).length, 0);

    return brokenCategories <= Math.max(3, Math.floor(items.length * 0.02))
      && brokenTextFields <= Math.max(20, Math.floor(items.length * 0.08));
  }

  return {
    authoritativeTextFields,
    isSafeRemotePayload,
    looksCorrupted,
  };
}));
