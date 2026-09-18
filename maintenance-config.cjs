"use strict";
const fs = require("node:fs");
const path = require("node:path");
function httpsEndpoint(value) {
  if (!value) return "";
  const url = new URL(String(value));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("MAINTENANCE_URL_INVALID");
  return url.toString();
}
function readMaintenanceConfig(directory, env = process.env) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(__dirname, "maintenance.defaults.json"), "utf8")); } catch {}
  try { config = { ...config, ...JSON.parse(fs.readFileSync(path.join(directory, "maintenance.json"), "utf8")) }; } catch {}
  try {
    return {
      diagnosticsUrl: httpsEndpoint(env.TEK_STOCK_DIAGNOSTICS_URL || config.diagnosticsUrl),
      manifestUrl: httpsEndpoint(env.TEK_STOCK_UPDATE_MANIFEST_URL || config.manifestUrl),
      autoUpdate: config.autoUpdate === true,
    };
  } catch { return { diagnosticsUrl: "", manifestUrl: "", autoUpdate: false }; }
}
function postDiagnostics(url, token, events, electronNet) {
  const target = httpsEndpoint(url);
  if (!target || !token) return Promise.reject(new Error("DIAGNOSTICS_NOT_CONFIGURED"));
  return new Promise((resolve, reject) => {
    const request = electronNet.request({ method: "POST", url: target, redirect: "manual" });
    const timer = setTimeout(() => { request.abort(); reject(new Error("DIAGNOSTICS_TIMEOUT")); }, 8000);
    const fail = () => { clearTimeout(timer); reject(new Error("DIAGNOSTICS_SEND_FAILED")); };
    request.setHeader("content-type", "application/json");
    request.setHeader("authorization", "Bearer " + token);
    request.on("redirect", () => { request.abort(); fail(); });
    request.on("error", fail);
    request.on("response", response => {
      let body = "";
      response.on("data", chunk => { body += chunk.toString(); if (body.length > 8192) { request.abort(); fail(); } });
      response.on("error", fail);
      response.on("end", () => {
        clearTimeout(timer);
        if (response.statusCode !== 202) return fail();
        try { resolve(JSON.parse(body)); } catch { fail(); }
      });
    });
    request.write(JSON.stringify({ events })); request.end();
  });
}
module.exports = { readMaintenanceConfig, postDiagnostics, httpsEndpoint };
