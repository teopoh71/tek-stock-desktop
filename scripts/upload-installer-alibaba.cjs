"use strict";
// Uploads a desktop installer to the Alibaba Singapore cloud and checks the public download;
// with --publish it then offers that installer to every computer through the Alibaba update feed.
// Usage: node scripts/upload-installer-alibaba.cjs <installer.exe> [--publish <version>]
// The admin token is read from %APPDATA%\TEK-STOCK-maintenance\alibaba-tokens.json and never printed.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// The function's own fcapp.run address may not redirect to OSS, so downloads go through the ZOLANO domain route.
const BASE = "https://design.myzolano.vip/tekstock";

async function main(file, flag, version) {
  const name = path.basename(file || "");
  if (!/^TEK-STOCK-Singapore-\d+\.\d+\.\d+-x64\.exe$/.test(name) || !fs.existsSync(file)) throw Error("INSTALLER_REQUIRED");
  const bytes = fs.readFileSync(file);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const token = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, "TEK-STOCK-maintenance", "alibaba-tokens.json"), "utf8")).adminToken;
  const link = await fetch(`${BASE}/admin/releases/upload-url`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name }) });
  const linkBody = await link.json();
  if (link.status === 409) console.error("already uploaded; checking it");
  else if (!link.ok) throw Error(`UPLOAD_LINK_${link.status}_${linkBody.code}`);
  else {
    for (let attempt = 1; ; attempt++) {
      try {
        const put = await fetch(linkBody.uploadUrl, { method: "PUT", headers: linkBody.headers, body: bytes });
        if (put.ok) break;
        throw Error(`UPLOAD_HTTP_${put.status} ${(await put.text()).slice(0, 200)}`);
      } catch (error) { if (attempt >= 3) throw error; console.error(`retry upload: ${error.message}`); }
    }
  }
  // Download it back exactly the way the desktop updater will, and compare (long downloads can be cut off).
  let download;
  for (let attempt = 1; ; attempt++) {
    try {
      download = await fetch(`${BASE}/releases/download/${name}`);
      if (!download.ok) throw Error(`DOWNLOAD_HTTP_${download.status}`);
      const back = Buffer.from(await download.arrayBuffer());
      const backSha = crypto.createHash("sha256").update(back).digest("hex");
      if (back.length !== bytes.length || backSha !== sha256) throw Error("DOWNLOAD_MISMATCH");
      break;
    } catch (error) { if (attempt >= 4) throw error; console.error(`retry download check: ${error.message}`); }
  }
  const url = `${BASE}/releases/download/${name}`;
  let published = false;
  if (flag === "--publish") {
    if (!name.includes(`-${version}-`)) throw Error("PUBLISH_VERSION_MISMATCH");
    const feed = await fetch(`${BASE}/admin/releases/manifest`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ desktop: { version, windows10: { url, sha256, size: bytes.length } } }) });
    if (!feed.ok) throw Error(`PUBLISH_HTTP_${feed.status}_${(await feed.json().catch(() => ({}))).code}`);
    const live = await (await fetch(`${BASE}/releases/latest.json`, { cache: "no-store" })).json();
    if (live.desktop?.version !== version || live.desktop.windows10?.sha256 !== sha256 || live.desktop.windows10.url !== url) throw Error("PUBLISH_NOT_LIVE");
    published = true;
  }
  return { ok: true, url, size: bytes.length, sha256, downloadHost: new URL(download.url).host, published };
}

main(process.argv[2], process.argv[3], process.argv[4]).then(r => console.log(JSON.stringify(r, null, 2)), e => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; });
