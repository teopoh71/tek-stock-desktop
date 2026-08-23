const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = __dirname;
const dataPath = path.join(appRoot, "inventory-data.json");
const lockPath = path.join(appRoot, "photo-lock.json");
const writeMode = process.argv.includes("--write");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const items = Array.isArray(data) ? data : data.items;
if (!Array.isArray(items)) throw new Error("inventory-data.json has no items array");

const current = {};
const errors = [];

for (const item of items) {
  const image = String(item.image || "");
  if (!image) continue;
  if (!/^assets\/images\/edited-[a-f0-9]+\.webp$/i.test(image)) {
    errors.push(`${item.id}: unapproved image path ${image}`);
    continue;
  }
  const filePath = path.join(appRoot, ...image.split("/"));
  if (!fs.existsSync(filePath)) {
    errors.push(`${item.id}: missing ${image}`);
    continue;
  }
  current[item.id] = { image, sha256: sha256(filePath) };
}

const nonApprovedFiles = fs
  .readdirSync(path.join(appRoot, "assets", "images"))
  .filter((name) => !/^edited-[a-f0-9]+\.webp$/i.test(name));
if (nonApprovedFiles.length) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "..", "package.json"), "utf8"));
  const fileRules = Array.isArray(packageJson?.build?.files) ? packageJson.build.files : [];
  const excludesAllImages = fileRules.includes("!inventory/assets/images/**/*");
  const includesEditedOnly = fileRules.some((rule) =>
    rule &&
    typeof rule === "object" &&
    rule.from === "inventory/assets/images" &&
    rule.to === "inventory/assets/images" &&
    Array.isArray(rule.filter) &&
    rule.filter.length === 1 &&
    rule.filter[0] === "edited-*.webp",
  );
  if (!excludesAllImages || !includesEditedOnly) {
    errors.push(`non-approved photo files are not excluded from installers: ${nonApprovedFiles.length}`);
  }
}
if (errors.length) throw new Error(errors.join("\n"));

if (writeMode) {
  const lock = {
    version: 1,
    purpose: "Approved photos only. Build must fail if an old file overwrites an approved image.",
    itemCount: Object.keys(current).length,
    items: current,
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  console.log(`Photo lock written: ${lock.itemCount} approved images`);
  process.exit(0);
}

if (!fs.existsSync(lockPath)) throw new Error("photo-lock.json is missing");
const locked = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const lockedItems = locked.items || {};

for (const [id, actual] of Object.entries(current)) {
  const expected = lockedItems[id];
  if (!expected) errors.push(`${id}: not present in approved photo lock`);
  else if (expected.image !== actual.image || expected.sha256 !== actual.sha256) {
    errors.push(`${id}: approved photo was replaced or changed`);
  }
}
for (const id of Object.keys(lockedItems)) {
  if (!current[id]) errors.push(`${id}: approved photo reference disappeared`);
}

if (errors.length) throw new Error(errors.join("\n"));
console.log(`Photo lock verified: ${Object.keys(current).length} approved images`);
if (nonApprovedFiles.length) {
  console.log(`Installer excludes ${nonApprovedFiles.length} unreferenced non-approved photo files`);
}
