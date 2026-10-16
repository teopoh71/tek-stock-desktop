"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../inventory/movement-core.js");

// Same rule as recordQuantity in inventory/app.js: what Excel and old app versions count as sold.
const countedPcs = (text) => [...String(text || "").matchAll(/\(\s*(\d+)\s*PCS?\s*\)/gi)]
  .reduce((sum, match) => sum + Number(match[1]), 0);

const base = () => ({
  id: "x", model: "FC CT 224", stock: 3,
  arrival: "2 PCS ( 20-10-25 )",
  outbound: "MILANO ( PO 25249 ) DD: 13-7-2026",
  showroom: "MILANO C/S ON 3-11-25",
});

test("legacy free text stays as legacy lines; legacy arrival format parses", () => {
  const { entries, legacy } = core.parseItem(base());
  assert.deepEqual(entries.map((entry) => entry.kind), ["received"]);
  assert.equal(entries[0].date, "2025-10-20");
  assert.deepEqual(legacy.map((entry) => entry.field), ["outbound", "showroom"]);
});

test("booking keeps warehouse stock, lowers available, is not counted as sold", () => {
  const item = base();
  const patch = core.applyMovement(item, { type: "sale", qty: 4, who: "bella home", po: "25360", date: "2026-10-30" });
  assert.equal(patch.stock, undefined);
  assert.match(patch.outbound, /\n\[已订\] BELLA HOME PO 25360 ×4 DD: 30-10-26$/);
  Object.assign(item, patch);
  assert.deepEqual(core.summarize(item), { warehouse: 3, booked: 4, available: -1, transit: 0, showroom: 0 });
  assert.equal(countedPcs(item.outbound), 0);
});

test("delivering a booking deducts stock and becomes a counted sale", () => {
  const item = { ...base(), stock: 5 };
  Object.assign(item, core.applyMovement(item, { type: "sale", qty: 2, who: "A", po: "1", date: "2026-10-30" }));
  const booked = core.parseItem(item).entries.find((entry) => entry.kind === "booked");
  Object.assign(item, core.applyMovement(item, { type: "deliver", line: booked.line, date: "2026-10-31" }));
  assert.equal(item.stock, 3);
  assert.equal(countedPcs(item.outbound), 2);
  assert.ok(item.outbound.startsWith("MILANO ( PO 25249 )"), "legacy text kept");
  assert.equal(core.summarize(item).booked, 0);
});

test("direct delivered sale and showroom both require enough stock", () => {
  const item = base();
  assert.throws(() => core.applyMovement(item, { type: "sale", delivered: true, qty: 4, who: "A", po: "1", date: "2026-10-16" }),
    { code: "NOT_ENOUGH_STOCK" });
  const patch = core.applyMovement(item, { type: "showroom", qty: 1, who: "casa", date: "2026-10-16" });
  assert.equal(patch.stock, 2);
  assert.equal(countedPcs(patch.showroom), 1);
});

test("transit then receive adds stock once", () => {
  const item = base();
  Object.assign(item, core.applyMovement(item, { type: "transit", qty: 4, ref: "pi 7226", date: "2026-11-05" }));
  assert.equal(item.stock, 3);
  assert.equal(core.summarize(item).transit, 4);
  const transit = core.parseItem(item).entries.find((entry) => entry.kind === "transit");
  Object.assign(item, core.applyMovement(item, { type: "receive", line: transit.line, date: "2026-11-06" }));
  assert.equal(item.stock, 7);
  assert.equal(core.summarize(item).transit, 0);
  assert.match(item.arrival, /4 PCS \( 6-11-26 \) PI 7226$/);
  assert.throws(() => core.applyMovement(item, { type: "receive", line: transit.line, date: "2026-11-06" }),
    { code: "LINE_NOT_FOUND" });
});

test("showroom return restores stock and removes only that line", () => {
  const item = base();
  Object.assign(item, core.applyMovement(item, { type: "showroom", qty: 2, who: "A", date: "2026-10-16" }));
  const line = core.parseItem(item).entries.find((entry) => entry.kind === "showroom").line;
  Object.assign(item, core.applyMovement(item, { type: "showroomReturn", line }));
  assert.equal(item.stock, 3);
  assert.equal(item.showroom, "MILANO C/S ON 3-11-25");
});

test("input is validated and sanitized", () => {
  const item = base();
  assert.throws(() => core.applyMovement(item, { type: "arrive", qty: 0, date: "2026-10-16" }), { code: "INVALID_QTY" });
  assert.throws(() => core.applyMovement(item, { type: "arrive", qty: 1.5, date: "2026-10-16" }), { code: "INVALID_QTY" });
  assert.throws(() => core.applyMovement(item, { type: "arrive", qty: 1, date: "2026-02-30" }), { code: "INVALID_DATE" });
  assert.throws(() => core.applyMovement(item, { type: "sale", qty: 1, who: " ", po: "1", date: "2026-10-16" }), { code: "MISSING_FIELD" });
  const patch = core.applyMovement(item, { type: "sale", qty: 1, who: "A\n[已订] B (x)", po: "1", date: "2026-10-16" });
  assert.equal(patch.outbound.split("\n").length, 2, "no injected lines");
  assert.equal(core.parseItem({ ...item, ...patch }).entries.filter((entry) => entry.kind === "booked").length, 1);
});

test("overview counts due-soon bookings and oversold models", () => {
  const items = [
    { stock: 1, outbound: "[已订] A PO 1 ×2 DD: 20-10-26\n[已订] B PO 2 ×1 DD: 30-12-26", arrival: "[在路上] PI 1 ×5 ETA: 5-11-26" },
    { stock: 4, outbound: "", arrival: "" },
  ];
  assert.deepEqual(core.overview(items, "2026-10-16"), { available: 4, dueSoon: 1, transit: 5, oversold: 1 });
});
