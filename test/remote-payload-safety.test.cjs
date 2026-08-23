const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isSafeRemotePayload,
  looksCorrupted,
} = require("../inventory/remote-payload-safety.js");

function makeItems(count = 325) {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    category: "餐椅",
    model: `MODEL-${index}`,
    stock: index,
    stockText: `${index}`,
    specification: "正常规格",
    arrival: "",
    showroom: "",
    outbound: "",
    sellingPriceText: "100",
  }));
}

test("accepts legacy question marks in derived stockText", () => {
  const items = makeItems();
  for (let index = 0; index < 27; index += 1) {
    items[index].stockText = `${items[index].stock}\n??`;
  }
  assert.equal(isSafeRemotePayload({ items }), true);
});

test("rejects widespread corruption in authoritative product text", () => {
  const items = makeItems();
  for (let index = 0; index < 27; index += 1) {
    items[index].specification = "??";
  }
  assert.equal(isSafeRemotePayload({ items }), false);
});

test("rejects excessive corrupt or missing categories", () => {
  const items = makeItems();
  for (let index = 0; index < 7; index += 1) {
    items[index].category = index % 2 ? "" : "??";
  }
  assert.equal(isSafeRemotePayload({ items }), false);
});

test("allows a legitimate single question mark", () => {
  const items = makeItems();
  items[0].specification = "Left or right?";
  assert.equal(looksCorrupted(items[0].specification), false);
  assert.equal(isSafeRemotePayload({ items }), true);
});

test("rejects Unicode replacement characters and undersized payloads", () => {
  const items = makeItems();
  for (let index = 0; index < 27; index += 1) {
    items[index].arrival = "bad\uFFFDtext";
  }
  assert.equal(isSafeRemotePayload({ items }), false);
  assert.equal(isSafeRemotePayload({ items: makeItems(9) }), false);
});
