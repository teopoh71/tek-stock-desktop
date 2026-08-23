((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TekStockRemoteRead = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
  "use strict";

  function cacheBustedUrl(url, token) {
    const value = String(url || "").trim();
    if (!value) return "";
    return `${value}${value.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;
  }

  function readSources(authoritativeUrl, mirrorUrls = []) {
    const seen = new Set();
    return [
      { url: authoritativeUrl, authoritative: true },
      ...mirrorUrls.map((url) => ({ url, authoritative: false })),
    ].filter((source) => {
      source.url = String(source.url || "").trim();
      if (!source.url || seen.has(source.url)) return false;
      seen.add(source.url);
      return true;
    });
  }

  function isUnchangedSnapshot(options = {}) {
    const incomingFingerprint = String(options.incomingFingerprint || "");
    const currentFingerprint = String(options.currentFingerprint || "");
    return options.skipRender === true
      && options.cloudState === "live"
      && Number(options.incomingRevision) === Number(options.currentRevision)
      && Number(options.incomingItemCount) === Number(options.currentItemCount)
      && incomingFingerprint.length > 0
      && incomingFingerprint === currentFingerprint
      && options.hasPendingEdits !== true;
  }

  async function fetchHighestRevision(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const isValidPayload = options.isValidPayload || (() => true);
    const sources = readSources(options.authoritativeUrl, options.mirrorUrls);
    const sourceTimeoutMs = Math.max(250, Number(options.sourceTimeoutMs) || 5000);
    if (typeof fetchImpl !== "function" || sources.length === 0) {
      throw new Error("REMOTE_READ_SOURCES_UNAVAILABLE");
    }
    const token = options.cacheToken ?? Date.now();
    const candidates = (await Promise.all(sources.map(async (source, index) => {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timeout = setTimeout(() => controller?.abort(), sourceTimeoutMs);
      try {
        const response = await fetchImpl(cacheBustedUrl(source.url, `${token}-${index}`), {
          cache: "no-store",
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`);
        const payload = await response.json();
        if (!isValidPayload(payload)) throw new Error("unsafe cloud payload rejected");
        return {
          ...source,
          payload,
          revision: Math.max(0, Math.trunc(Number(payload.revision) || 0)),
        };
      } catch (error) {
        return { ...source, error };
      } finally {
        clearTimeout(timeout);
      }
    }))).filter((candidate) => candidate.payload);
    if (candidates.length === 0) throw new Error("REMOTE_READ_ALL_SOURCES_FAILED");
    const minimumRevision = Math.max(0, Math.trunc(Number(options.minimumRevision) || 0));
    const eligible = minimumRevision
      ? candidates.filter((candidate) => candidate.revision >= minimumRevision)
      : candidates;
    if (eligible.length === 0) {
      const error = new Error("REMOTE_READ_BELOW_MINIMUM_REVISION");
      error.minimumRevision = minimumRevision;
      error.highestAvailableRevision = Math.max(...candidates.map((candidate) => candidate.revision));
      throw error;
    }
    eligible.sort((left, right) =>
      right.revision - left.revision
      || Number(right.authoritative) - Number(left.authoritative));
    return eligible[0];
  }

  return {
    cacheBustedUrl,
    fetchHighestRevision,
    isUnchangedSnapshot,
    readSources,
  };
});
