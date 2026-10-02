"use strict";

// Isolated component check: no application bootstrap, account, inventory or network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
    await page.route("**/*", route => route.abort());
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<html lang="zh-CN"><body><main><h1>TEK STOCK · isolated recovery check</h1><input id="search" value="pending local item"></main></body></html>');
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, "inventory/styles.css"), "utf8") });
    await page.addScriptTag({ path: path.join(root, "inventory/recovery-core.js") });
    await page.evaluate(() => {
      window.reconnects = 0;
      window.ui = TekStockRecovery.mount(document, {
        auth: async () => { window.reconnects += 1; return false; },
        report: async () => ({ ok: false }),
      });
      ui.show("SYNC_TOKEN_INVALID");
    });
    const panel = page.locator("#recoveryPanel");
    assert.equal(await panel.isVisible(), true);
    assert.match(await panel.innerText(), /SYNC_TOKEN_INVALID/);
    assert.match(await panel.innerText(), /同步密钥格式不正确/);
    assert.equal(await panel.getByRole("button", { name: /重置|重装/ }).count(), 0);
    await panel.getByRole("button", { name: "重新连接账号", exact: true }).click();
    await page.waitForFunction(() => window.reconnects === 1
      && document.querySelector('#recoveryPanel [role="status"]').textContent.includes("暂时未完成"));
    assert.equal(await page.locator("#search").inputValue(), "pending local item");
    const directory = path.join(root, "output/playwright");
    fs.mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, "invalid-sync-token-reconnect.png") });
    await panel.getByRole("button", { name: "稍后处理，继续查看", exact: true }).click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await page.locator("#search").inputValue(), "pending local item");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, checks: ["actionable invalid-key explanation", "reconnect action",
      "no reset action", "cancel preserves input", "later preserves input"], browserErrors: errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
