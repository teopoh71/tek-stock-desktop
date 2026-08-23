const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const styles = fs.readFileSync(
  path.join(__dirname, "..", "inventory", "styles.css"),
  "utf8",
);
const app = fs.readFileSync(
  path.join(__dirname, "..", "inventory", "app.js"),
  "utf8",
);
const index = fs.readFileSync(
  path.join(__dirname, "..", "inventory", "index.html"),
  "utf8",
);
const packageConfig = require("../package.json");

test("product pictures are centered inside every card", () => {
  assert.match(
    styles,
    /\.product-image-wrap\s*\{[^}]*display:\s*grid;[^}]*place-items:\s*center;/s,
  );
  assert.match(
    styles,
    /\.product-image\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*margin:\s*auto;[^}]*object-position:\s*50%\s+50%;/s,
  );
});

test("full-picture preview uses symmetric padding", () => {
  assert.match(
    styles,
    /\.image-preview-dialog\s*\{[^}]*padding:\s*20px;/s,
  );
  assert.doesNotMatch(
    styles,
    /\.image-preview-dialog\s*\{[^}]*padding:\s*52px\s+20px\s+20px;/s,
  );
});

test("missing and failed pictures never leave a broken image icon", () => {
  assert.match(styles, /\.dialog-card\s*>\s*img\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.match(app, /replaceWithImageFallback\(image\)/);
  assert.match(app, /el\.detailImage\.addEventListener\("error",\s*hideBrokenDetailImage\)/);
  assert.match(index, /image-display-core\.js\?v=20260729-broken-image-v1/);
  assert.doesNotMatch(app, /escapeHtml\(item\.image\)\}\?v=/);
});

test("desktop installer uses one all-users scope", () => {
  assert.equal(packageConfig.build.msi.perMachine, true);
});
