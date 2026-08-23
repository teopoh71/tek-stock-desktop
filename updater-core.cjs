"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { createHash } = require("node:crypto");

const DEFAULT_MANIFEST_URL = "https://tek-stock-releases-cn-20260801.oss-cn-hangzhou.aliyuncs.com/releases/latest.json";
const FALLBACK_MANIFEST_URL = "https://tek-stock-releases-sg-20260729.oss-ap-southeast-1.aliyuncs.com/releases/latest.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;
const DEFAULT_INSTALLER_TIMEOUT_MS = 120_000;

function updaterError(code, detail) {
  const error = new Error(code);
  error.code = code;
  if (detail) error.detail = String(detail).slice(0, 200);
  return error;
}

function isVersionNewer(candidate, current) {
  const parse = (value) => {
    const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
    return match ? match.slice(1).map(Number) : null;
  };
  const next = parse(candidate);
  const installed = parse(current);
  if (!next || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

function currentVersionFromUserAgent(value) {
  const match = String(value || "").match(/\bTEK-STOCK\/v?(\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?)/i);
  return match ? match[1] : "";
}

function requireHttpsUrl(value, code = "UPDATE_URL_INVALID") {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw updaterError(code);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw updaterError(code);
  }
  return parsed;
}

function selectWindowsChannel(release, osRelease = "") {
  const major = Number(String(osRelease).split(".")[0]) || 0;
  const key = major > 0 && major <= 6 ? "windows7" : "windows10";
  const desktop = release?.desktop;
  if (!desktop || typeof desktop !== "object" || Array.isArray(desktop)) {
    throw updaterError("UPDATE_MANIFEST_DESKTOP_MISSING");
  }
  const selected = desktop[key];
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    throw updaterError("UPDATE_MANIFEST_CHANNEL_MISSING");
  }
  const parsedUrl = requireHttpsUrl(selected.url);
  const url = parsedUrl.toString();
  const sha256 = String(selected.sha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw updaterError("UPDATE_SHA256_INVALID");
  const pathname = parsedUrl.pathname.toLowerCase();
  if (!/\.(?:msi|exe)$/.test(pathname)) throw updaterError("UPDATE_INSTALLER_NOT_SUPPORTED");
  let name;
  try {
    name = decodeURIComponent(path.posix.basename(parsedUrl.pathname));
  } catch {
    throw updaterError("UPDATE_INSTALLER_NAME_INVALID");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}\.(?:msi|exe)$/i.test(name)) {
    throw updaterError("UPDATE_INSTALLER_NAME_INVALID");
  }
  const size = selected.size == null ? null : Number(selected.size);
  if (size != null && (!Number.isSafeInteger(size) || size <= 0 || size > MAX_INSTALLER_BYTES)) {
    throw updaterError("UPDATE_SIZE_INVALID");
  }
  return {
    channel: key,
    version: String(desktop.version || "").slice(0, 40),
    name,
    url,
    sha256,
    size,
  };
}

function requestHttps(url, options = {}, redirectsLeft = 3) {
  const parsed = requireHttpsUrl(url);
  if (options.electronNet && typeof options.electronNet.request === "function") {
    return new Promise((resolve, reject) => {
      let response;
      let resolved = false;
      let timer;
      const timeoutMs = options.timeoutMs || DEFAULT_NETWORK_TIMEOUT_MS;
      const clearWatchdog = () => clearTimeout(timer);
      const armWatchdog = () => {
        clearWatchdog();
        timer = setTimeout(() => {
          const error = updaterError("UPDATE_NETWORK_TIMEOUT");
          try { request.abort(); } catch {}
          try { response?.destroy(error); } catch {}
          if (!resolved) reject(error);
        }, timeoutMs);
      };
      const fail = (error) => {
        clearWatchdog();
        const safeError = error?.code?.startsWith("UPDATE_")
          ? error
          : updaterError("UPDATE_NETWORK_FAILED", error?.code);
        if (!resolved) reject(safeError);
        else {
          try { response?.destroy(safeError); } catch {}
        }
      };
      const request = options.electronNet.request({
        method: "GET",
        url: parsed.toString(),
        redirect: "manual",
      });
      request.setHeader?.("User-Agent", options.userAgent || "TEK-STOCK-Updater");
      request.on("response", (incoming) => {
        response = incoming;
        const status = Number(response.statusCode) || 0;
        const locationHeader = response.headers?.location;
        const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
        if ([301, 302, 303, 307, 308].includes(status)) {
          clearWatchdog();
          response.resume?.();
          if (redirectsLeft <= 0) return reject(updaterError("UPDATE_TOO_MANY_REDIRECTS"));
          let next;
          try {
            next = requireHttpsUrl(new URL(location || "", parsed).toString());
          } catch {
            return reject(updaterError("UPDATE_REDIRECT_INVALID"));
          }
          resolved = true;
          return resolve(requestHttps(next, options, redirectsLeft - 1));
        }
        if (status !== 200) {
          clearWatchdog();
          response.resume?.();
          return reject(updaterError(`UPDATE_HTTP_${status || "ERROR"}`));
        }
        response.on("data", armWatchdog);
        response.once("end", clearWatchdog);
        response.once("close", clearWatchdog);
        response.once("error", fail);
        resolved = true;
        armWatchdog();
        resolve(response);
      });
      request.once("error", fail);
      armWatchdog();
      request.end();
    });
  }
  const client = options.https || https;
  return new Promise((resolve, reject) => {
    const request = client.get(parsed, {
      headers: { "User-Agent": options.userAgent || "TEK-STOCK-Updater" },
    }, (response) => {
      const status = Number(response.statusCode) || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        if (redirectsLeft <= 0) return reject(updaterError("UPDATE_TOO_MANY_REDIRECTS"));
        let next;
        try {
          next = requireHttpsUrl(new URL(response.headers.location || "", parsed).toString());
        } catch {
          return reject(updaterError("UPDATE_REDIRECT_INVALID"));
        }
        return resolve(requestHttps(next, options, redirectsLeft - 1));
      }
      if (status !== 200) {
        response.resume();
        return reject(updaterError(`UPDATE_HTTP_${status || "ERROR"}`));
      }
      resolve(response);
    });
    request.setTimeout(options.timeoutMs || DEFAULT_NETWORK_TIMEOUT_MS, () => {
      request.destroy(updaterError("UPDATE_NETWORK_TIMEOUT"));
    });
    request.once("error", (error) => reject(error?.code?.startsWith("UPDATE_")
      ? error
      : updaterError("UPDATE_NETWORK_FAILED", error?.code)));
  });
}

async function fetchReleaseManifest(url = DEFAULT_MANIFEST_URL, options = {}) {
  const response = await requestHttps(url, options);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > (options.maxBytes || MAX_MANIFEST_BYTES)) {
      response.destroy();
      throw updaterError("UPDATE_MANIFEST_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw updaterError("UPDATE_MANIFEST_INVALID_JSON");
  }
}

async function downloadVerifiedInstaller(release, destination, options = {}) {
  const installedVersion = currentVersionFromUserAgent(options.userAgent);
  const releaseVersion = String(release?.version || "").trim();
  if (installedVersion && releaseVersion && isVersionNewer(installedVersion, releaseVersion)) {
    throw updaterError("UPDATE_DOWNGRADE_BLOCKED", `${installedVersion} -> ${releaseVersion}`);
  }
  const target = path.resolve(destination);
  const expectedSize = release.size;
  const maxBytes = options.maxBytes || MAX_INSTALLER_BYTES;
  const response = await requestHttps(release.url, {
    ...options,
    timeoutMs: options.timeoutMs || DEFAULT_INSTALLER_TIMEOUT_MS,
  });
  const declaredSize = Number(response.headers["content-length"]);
  if (declaredSize && (declaredSize > maxBytes || (expectedSize && declaredSize !== expectedSize))) {
    response.destroy();
    throw updaterError("UPDATE_DOWNLOAD_SIZE_MISMATCH");
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const output = fs.createWriteStream(target, { flags: "wx", mode: 0o600 });
  try {
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw updaterError("UPDATE_INSTALLER_TOO_LARGE");
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise((resolve) => output.once("drain", resolve));
    }
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
    if (expectedSize && bytes !== expectedSize) throw updaterError("UPDATE_DOWNLOAD_SIZE_MISMATCH");
    if (hash.digest("hex") !== release.sha256) throw updaterError("UPDATE_SHA256_MISMATCH");
    return { path: target, bytes };
  } catch (error) {
    output.destroy();
    try { fs.rmSync(target, { force: true }); } catch {}
    throw error?.code ? error : updaterError("UPDATE_DOWNLOAD_FAILED", error?.code);
  }
}

module.exports = {
  DEFAULT_MANIFEST_URL,
  FALLBACK_MANIFEST_URL,
  DEFAULT_INSTALLER_TIMEOUT_MS,
  MAX_INSTALLER_BYTES,
  downloadVerifiedInstaller,
  fetchReleaseManifest,
  isVersionNewer,
  requireHttpsUrl,
  selectWindowsChannel,
  updaterError,
};
