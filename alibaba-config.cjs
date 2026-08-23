"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_KEYS = new Set([
  "apiBaseUrl", "apiFallbackBaseUrls", "authorityId", "ossPublicBaseUrl",
]);
const PLACEHOLDER_HOST = /(^|\.)(example(?:\.com)?|invalid|localhost|test)$/i;

function configError(message) {
  const error = new Error(`ALIBABA_CONFIG_INVALID: ${message}`);
  error.code = "ALIBABA_CONFIG_INVALID";
  return error;
}

function normalizeEndpoint(value, name, allowMissing) {
  const text = String(value || "").trim().replace(/\/$/, "");
  if (!text && allowMissing) return "";
  let url;
  try { url = new URL(text); } catch { throw configError(`${name} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw configError(`${name} must be a credential-free HTTPS URL`);
  }
  const host = url.hostname.toLowerCase();
  if (PLACEHOLDER_HOST.test(host) || host.includes("example") || host.includes("placeholder")
      || host.endsWith(".local") || text.includes("${") || /<[^>]+>/.test(text)) {
    throw configError(`${name} must not use a placeholder or local host`);
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeFallbackEndpoints(value, apiBaseUrl) {
  if (value == null || value === "") return [];
  if (!Array.isArray(value)) throw configError("apiFallbackBaseUrls must be an array");
  const seen = new Set(apiBaseUrl ? [apiBaseUrl] : []);
  const endpoints = [];
  for (const candidate of value) {
    const endpoint = normalizeEndpoint(candidate, "apiFallbackBaseUrls", false);
    if (seen.has(endpoint)) continue;
    seen.add(endpoint);
    endpoints.push(endpoint);
  }
  if (endpoints.length > 3) throw configError("apiFallbackBaseUrls supports at most 3 endpoints");
  return endpoints;
}

function normalizeAuthorityId(value) {
  const authorityId = String(value || "").trim();
  if (!authorityId) return "";
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(authorityId)) {
    throw configError("authorityId must be a stable non-secret identifier");
  }
  return authorityId;
}

function environmentFallbacks(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return text.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function validateAlibabaCloudConfig(value, options = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError("configuration must be a JSON object");
  }
  const unexpected = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (unexpected.length) {
    throw configError(`unexpected field(s): ${unexpected.sort().join(", ")}`);
  }
  const allowMissing = options.allowMissing === true;
  const apiBaseUrl = normalizeEndpoint(value.apiBaseUrl, "apiBaseUrl", allowMissing);
  const apiFallbackBaseUrls = normalizeFallbackEndpoints(value.apiFallbackBaseUrls, apiBaseUrl);
  const authorityId = normalizeAuthorityId(value.authorityId);
  if (apiFallbackBaseUrls.length && !authorityId) {
    throw configError("authorityId is required when API fallbacks are configured");
  }
  const ossPublicBaseUrl = normalizeEndpoint(value.ossPublicBaseUrl, "ossPublicBaseUrl", allowMissing);
  return { apiBaseUrl, apiFallbackBaseUrls, authorityId, ossPublicBaseUrl };
}

function readAlibabaCloudConfigFiles(options = {}) {
  const fsApi = options.fsApi || fs;
  function readConfig(file) {
    if (!file) return {};
    try {
      return validateAlibabaCloudConfig(JSON.parse(fsApi.readFileSync(file, "utf8")));
    } catch {
      return {};
    }
  }

  const userConfig = readConfig(path.join(
    String(options.userDataPath || ""), "alibaba-cloud.json",
  ));
  const packagedConfig = readConfig(String(options.packagedConfigPath || ""));
  const env = options.env || process.env;
  const usePackagedApi = Boolean(packagedConfig.apiBaseUrl);
  return validateAlibabaCloudConfig({
    // Packaged endpoints are release-audited and keep every installation on the
    // same inventory and photo store. Preserve user/environment overrides as
    // fallback inputs when no valid packaged configuration is present.
    apiBaseUrl: String(packagedConfig.apiBaseUrl
      || env.TEK_STOCK_API_BASE_URL || userConfig.apiBaseUrl || "").trim(),
    apiFallbackBaseUrls: usePackagedApi
      ? packagedConfig.apiFallbackBaseUrls
      : environmentFallbacks(env.TEK_STOCK_API_FALLBACK_BASE_URLS).length
        ? environmentFallbacks(env.TEK_STOCK_API_FALLBACK_BASE_URLS)
        : userConfig.apiFallbackBaseUrls,
    authorityId: String(usePackagedApi
      ? packagedConfig.authorityId || ""
      : env.TEK_STOCK_AUTHORITY_ID || userConfig.authorityId || "").trim(),
    ossPublicBaseUrl: String(packagedConfig.ossPublicBaseUrl
      || env.TEK_STOCK_OSS_PUBLIC_BASE_URL || userConfig.ossPublicBaseUrl || "").trim(),
  }, { allowMissing: true });
}

module.exports = { readAlibabaCloudConfigFiles, validateAlibabaCloudConfig };
