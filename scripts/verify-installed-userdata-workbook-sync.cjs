"use strict";

const path = require("node:path");
const { app, net } = require("electron");

process.env.TEK_STOCK_TEST = "1";
app.setPath("userData", path.join(process.env.APPDATA, "samlee-inventory-desktop"));

async function run() {
  const desktop = require("../main.cjs");
  const token = desktop.readStoredUploadToken();
  if (!token) throw Object.assign(new Error("Stored token could not be decrypted"), { code: "TOKEN_DECRYPT_FAILED" });
  const response = await net.fetch("https://tek-stoless-api-ogihpifevf.cn-hangzhou.fcapp.run/v1/items/batch", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
      "idempotency-key": `tek-installed-credential-check-${Date.now()}` },
    body: "{}",
  });
  if (response.status === 401) throw Object.assign(new Error("Stored token was rejected"), { code: "UNAUTHORIZED" });
  const sync = await desktop.syncWorkbookWithCentralCloud();
  console.log(JSON.stringify({ ok: true, credentialStatus: response.status,
    revision: sync.revision, itemCount: sync.items?.length,
    created: sync.created?.length || 0, updated: sync.updated?.length || 0,
    deleted: sync.deleted?.length || 0, workbookAcknowledged: sync.workbookAcknowledged === true }));
}

app.whenReady().then(() => run().then(
  () => app.exit(0),
  (error) => {
    console.error(JSON.stringify({ ok: false, code: error?.code || error?.message || "UNKNOWN",
      status: error?.status || 0 }));
    app.exit(1);
  },
));
