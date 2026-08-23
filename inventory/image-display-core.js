(function initImageDisplayCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TekStockImageDisplay = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createImageDisplayCore() {
  "use strict";

  function versionedImageSource(source, version) {
    const image = String(source || "").trim();
    if (!image || /^data:image\//i.test(image)) return image;
    const separator = image.includes("?") ? "&" : "?";
    return `${image}${separator}v=${encodeURIComponent(String(version || ""))}`;
  }

  function nextImageFailure(fallback, fallbackUsed, version) {
    const source = String(fallback || "").trim();
    if (source && !fallbackUsed) {
      return {
        type: "retry",
        source: versionedImageSource(source, version),
      };
    }
    return { type: "placeholder" };
  }

  return {
    versionedImageSource,
    nextImageFailure,
  };
}));
