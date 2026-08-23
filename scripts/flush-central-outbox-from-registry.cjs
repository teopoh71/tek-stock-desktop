"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createCentralSync } = require("../central-sync.cjs");
const cloud = require("../inventory/alibaba-cloud.json");

function readProtectedRegistryToken() {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$blob=(Get-ItemProperty -Path 'HKCU:\\Software\\TEK-STOCK\\Deployment' -Name ServerlessUploadToken -ErrorAction Stop).ServerlessUploadToken",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect([byte[]]$blob,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($plain))",
  ].join("; ");
  const encoded = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const token = Buffer.from(encoded, "base64").toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Protected deployment token is invalid");
  return token;
}

async function run() {
  const token = readProtectedRegistryToken();
  const storageDirectory = path.join(process.env.APPDATA, "samlee-inventory-desktop", "central-sync");
  const sync = createCentralSync({
    storageDirectory,
    getApiBaseUrl: () => cloud.apiBaseUrl,
    getApiFallbackBaseUrls: () => cloud.apiFallbackBaseUrls || [],
    getAuthorityId: () => cloud.authorityId || "",
    getOssBaseUrl: () => cloud.ossPublicBaseUrl,
    getToken: () => token,
  });
  const snapshot = await sync.flush();
  console.log(JSON.stringify({
    ok: true,
    revision: snapshot.revision,
    items: snapshot.items.length,
    retryable: sync.outbox.retryable().length,
    model1234567: snapshot.items.filter((item) => String(item.model) === "1234567").length,
  }));
}

run().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error?.code || "UNKNOWN",
    status: error?.status || 0,
    currentRevision: error?.currentRevision || 0,
  }));
  process.exitCode = 1;
});
