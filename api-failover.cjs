"use strict";

function apiError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeTransportError(error) {
  if (error?.code) return error;
  const name = String(error?.name || "");
  const message = String(error?.message || error || "");
  if (name === "AbortError") return apiError("API_REQUEST_TIMEOUT", { cause: error });
  if (/fetch failed|offline|network|enetunreach|enetdown|econnreset|econnrefused|enotfound|eai_again/i.test(message)) {
    const normalized = apiError("API_NETWORK_UNREACHABLE", { cause: error });
    normalized.message = message || normalized.message;
    return normalized;
  }
  return error;
}

function createApiRequester(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getToken = options.getToken || (() => "");
  const getApiBaseUrl = options.getApiBaseUrl || (() => "");
  const getApiFallbackBaseUrls = options.getApiFallbackBaseUrls || (() => []);
  const getAuthorityId = options.getAuthorityId || (() => "");
  const requestTimeoutMs = Math.min(30_000, Math.max(25,
    Math.trunc(Number(options.requestTimeoutMs) || 5_000)));
  let preferredApiBaseUrl = "";

  function normalizeBaseUrl(candidate, missingCode = "API_BASE_URL_INVALID") {
    const value = String(candidate || "").trim().replace(/\/$/, "");
    let parsed;
    try { parsed = new URL(value); } catch { throw apiError(missingCode); }
    if (parsed.protocol !== "https:"
        && !(options.allowHttp === true && parsed.protocol === "http:")) {
      throw apiError("API_BASE_URL_INVALID");
    }
    return parsed.toString().replace(/\/$/, "");
  }

  function resolveEndpoints() {
    const primary = normalizeBaseUrl(getApiBaseUrl(), "API_BASE_URL_MISSING");
    const rawFallbacks = getApiFallbackBaseUrls();
    if (!Array.isArray(rawFallbacks)) throw apiError("API_FALLBACK_URLS_INVALID");
    const endpoints = [primary];
    for (const candidate of rawFallbacks) {
      const endpoint = normalizeBaseUrl(candidate);
      if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
    }
    if (endpoints.length > 4) throw apiError("API_FALLBACK_URLS_INVALID");
    const authorityId = String(getAuthorityId() || "").trim();
    if (endpoints.length > 1 && !authorityId) throw apiError("API_AUTHORITY_ID_MISSING");
    if (authorityId && !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(authorityId)) {
      throw apiError("API_AUTHORITY_ID_INVALID");
    }
    if (preferredApiBaseUrl && endpoints.includes(preferredApiBaseUrl)) {
      return {
        authorityId,
        endpoints: [preferredApiBaseUrl, ...endpoints.filter((entry) => entry !== preferredApiBaseUrl)],
      };
    }
    return { authorityId, endpoints };
  }

  async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const externalSignal = init.signal;
    const forwardAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal?.aborted) forwardAbort();
    else externalSignal?.addEventListener?.("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(apiError("API_REQUEST_TIMEOUT")),
      requestTimeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw apiError("API_REQUEST_TIMEOUT", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.("abort", forwardAbort);
    }
  }

  return async function request(route, init = {}) {
    const { write = false, safePresign = false, validateResponse, ...fetchInit } = init;
    const { authorityId, endpoints } = resolveEndpoints();
    const headers = { accept: "application/json", ...(fetchInit.headers || {}) };
    if (authorityId) headers["x-tek-stock-authority-id"] = authorityId;
    if (write === true) {
      const token = String(getToken() || "").trim();
      if (!token) throw apiError("SYNC_TOKEN_MISSING");
      headers.authorization = `Bearer ${token}`;
    }
    const idempotencyKey = Object.entries(headers).find(([key]) =>
      key.toLowerCase() === "idempotency-key")?.[1];
    const mayFailOver = write !== true || safePresign === true
      || Boolean(String(idempotencyKey || "").trim());
    let lastError;
    for (let index = 0; index < endpoints.length; index += 1) {
      const endpoint = endpoints[index];
      try {
        const response = await fetchWithTimeout(`${endpoint}${route}`, {
          ...fetchInit, headers, cache: "no-store",
        });
        if (authorityId) {
          const responseAuthorityId = String(
            response.headers?.get?.("x-tek-stock-authority-id") || "",
          ).trim();
          if (responseAuthorityId !== authorityId) {
            throw apiError("API_AUTHORITY_MISMATCH", {
              expectedAuthorityId: authorityId,
              responseAuthorityId,
            });
          }
        }
        const body = await response.json().catch((cause) => {
          if (!response.ok) {
            throw apiError(`HTTP_${response.status}`, {
              cause, status: response.status, currentRevision: 0,
            });
          }
          throw apiError("API_RESPONSE_JSON_INVALID", { cause });
        });
        if (!response.ok) throw apiError(body.code || `HTTP_${response.status}`, {
          status: response.status,
          currentRevision: Number(body.currentRevision) || 0,
        });
        const validatedBody = typeof validateResponse === "function"
          ? await validateResponse(body)
          : body;
        preferredApiBaseUrl = endpoint;
        return validatedBody;
      } catch (error) {
        lastError = normalizeTransportError(error);
        const retryable = !Number.isInteger(error?.status)
          || (error.status >= 500 && error.status <= 599);
        if (index + 1 >= endpoints.length || !retryable || !mayFailOver) throw lastError;
      }
    }
    throw lastError || apiError("API_REQUEST_FAILED");
  };
}

module.exports = { createApiRequester };
