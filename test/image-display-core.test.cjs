const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const corePath = path.join(__dirname, "..", "inventory", "image-display-core.js");
const imageDisplay = require(corePath);

test("embedded data images are never changed by cache busting", () => {
  const source = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  assert.equal(imageDisplay.versionedImageSource(source, "photo-v4"), source);
});

test("remote and local image paths receive a safe cache version", () => {
  assert.equal(
    imageDisplay.versionedImageSource("https://example.test/photo.webp", "photo v4"),
    "https://example.test/photo.webp?v=photo%20v4",
  );
  assert.equal(
    imageDisplay.versionedImageSource("photo.webp?size=small", "photo-v4"),
    "photo.webp?size=small&v=photo-v4",
  );
});

test("a failed image retries one packaged source, then becomes a placeholder", () => {
  assert.deepEqual(
    imageDisplay.nextImageFailure("assets/images/edited-chair.webp", false, "photo-v4"),
    {
      type: "retry",
      source: "assets/images/edited-chair.webp?v=photo-v4",
    },
  );
  assert.deepEqual(
    imageDisplay.nextImageFailure("assets/images/edited-chair.webp", true, "photo-v4"),
    { type: "placeholder" },
  );
  assert.deepEqual(
    imageDisplay.nextImageFailure("", false, "photo-v4"),
    { type: "placeholder" },
  );
});
