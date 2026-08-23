"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { app, net, safeStorage } = require("electron");

const API_BASE = "https://tek-stoss-api-v-vwyjovetgw.cn-hangzhou.fcapp.run";
const CREDENTIALS_NAME = "sync-credentials.json";
const DESKTOP_USER_DATA_NAME = "samlee-inventory-desktop";
const roamingRoot = process.env.APPDATA || path.dirname(app.getPath("userData"));
const desktopUserDataPath = path.join(roamingRoot, DESKTOP_USER_DATA_NAME);

// Chromium's Windows encryption key is scoped to the Electron userData path.
// Select the installed application's path before safeStorage is initialized.
app.setPath("userData", desktopUserDataPath);

function readProtectedRegistryToken() {
  const script = [
    "Add-Type -AssemblyName System.Security",
    "$blob=(Get-ItemProperty -Path 'HKCU:\\Software\\TEK-STOCK\\Deployment' -Name ServerlessUploadToken -ErrorAction Stop).ServerlessUploadToken",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect([byte[]]$blob,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($plain))",
  ].join("; ");
  const encoded = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const token = Buffer.from(encoded, "base64").toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Protected deployment token is invalid");
  return token;
}

async function validateToken(token) {
  const response = await net.fetch(`${API_BASE}/v1/items/batch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": `tek-token-repair-${Date.now()}`,
    },
    body: "{}",
  });
  if (response.status === 401) throw new Error("Protected deployment token was rejected");
  if (response.status < 400 || response.status >= 500) {
    throw new Error(`Unexpected token validation response: HTTP ${response.status}`);
  }
  return response.status;
}

async function run() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows secure storage is unavailable");
  const token = readProtectedRegistryToken();
  const validationStatus = await validateToken(token);
  const destination = path.join(app.getPath("userData"), CREDENTIALS_NAME);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const encrypted = safeStorage.encryptString(token).toString("base64");
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, uploadToken: encrypted }, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, destination);
  const saved = JSON.parse(fs.readFileSync(destination, "utf8"));
  const secureRoundTrip = safeStorage.decryptString(Buffer.from(saved.uploadToken, "base64")) === token;
  if (!secureRoundTrip) throw new Error("Secure credential round-trip verification failed");
  console.log(JSON.stringify({ ok: true, validationStatus, secureRoundTrip,
    credentialBytes: fs.statSync(destination).size }));
}

app.whenReady().then(() => run().then(
  () => app.exit(0),
  (error) => {
    console.error(error?.message || "Upload-token repair failed");
    app.exit(1);
  },
));
