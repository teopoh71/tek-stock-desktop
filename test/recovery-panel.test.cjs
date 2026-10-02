"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { advice, mount } = require("../inventory/recovery-core.js");

function element() {
  return { children: [], dataset: {}, listeners: {},
    setAttribute() {}, append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
  };
}
function setup(handler) {
  const document = { createElement: element, body: element() };
  const ui = mount(document, { update: handler });
  ui.show("UPDATE_NETWORK_FAILED");
  const button = ui.panel.children[3].children.find(b => b.dataset.recoveryAction === "update");
  return { ui, click: () => button.listeners.click() };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("a missing sync token offers the account reconnection action", () => {
  const result = advice("SYNC_TOKEN_MISSING");
  assert.equal(result.kind, "auth");
  assert.deepEqual(result.actions.map(action => action.id), ["auth", "later", "report"]);
});

test("a header-invalid sync key offers reconnect instead of reset or generic error", () => {
  const result = advice("SYNC_TOKEN_INVALID");
  assert.equal(result.kind, "auth");
  assert.deepEqual(result.actions.map(action => action.id), ["auth", "later", "report"]);
});

test("successful update recheck dismisses its stale network error", async () => {
  const { ui, click } = setup(async () => true);
  click(); await settle();
  assert.equal(ui.panel.hidden, true);
  ui.reopen(); assert.equal(ui.panel.hidden, true);
});

test("failed update recheck retains recovery choices", async () => {
  const { ui, click } = setup(async () => ({ ok: false }));
  click(); await settle();
  assert.equal(ui.panel.hidden, false);
});

test("successful recheck cannot dismiss a newer failure raised while waiting", async () => {
  let resolve;
  const { ui, click } = setup(() => new Promise(done => { resolve = done; }));
  click(); await settle(); ui.show("UPDATE_SHA256_MISMATCH");
  resolve(true); await settle();
  assert.equal(ui.panel.hidden, false);
  assert.match(ui.panel.children[2].textContent, /UPDATE_SHA256_MISMATCH/);
});

test("a later live cloud read clears the exact transient read error captured at request start", () => {
  const document = { createElement: element, body: element() };
  const ui = mount(document);
  ui.show({ errorCode: "API_REQUEST_TIMEOUT", source: "cloud-read" });
  const captured = ui.captureCloudReadFailure();

  assert.ok(captured);
  assert.equal(ui.clearCloudReadFailure(captured), true);
  assert.equal(ui.panel.hidden, true);
});

test("live cloud read cannot clear a newer same-code cloud-read failure", () => {
  const document = { createElement: element, body: element() };
  const ui = mount(document);
  ui.show({ errorCode: "API_REQUEST_TIMEOUT", source: "cloud-read" });
  const captured = ui.captureCloudReadFailure();
  ui.show({ errorCode: "API_REQUEST_TIMEOUT", source: "cloud-read" });

  assert.equal(ui.clearCloudReadFailure(captured), false);
  assert.equal(ui.panel.hidden, false);
});

test("live cloud read cannot clear a newer auth, conflict, workbook, write, or update failure", () => {
  for (const failure of [
    { errorCode: "UNAUTHORIZED", source: "cloud-read" },
    { errorCode: "WORKBOOK_MERGE_CONFLICT", source: "workbook-sync" },
    { errorCode: "API_REQUEST_TIMEOUT", source: "workbook-sync" },
    { errorCode: "CLOUD_UPLOAD_FAILED", source: "cloud-write" },
    { errorCode: "UPDATE_NETWORK_TIMEOUT", source: "update" },
  ]) {
    const document = { createElement: element, body: element() };
    const ui = mount(document);
    ui.show({ errorCode: "API_REQUEST_TIMEOUT", source: "cloud-read" });
    const captured = ui.captureCloudReadFailure();
    ui.show(failure);

    assert.equal(ui.clearCloudReadFailure(captured), false, failure.errorCode);
    assert.equal(ui.panel.hidden, false, failure.errorCode);
    assert.match(ui.panel.children[2].textContent, new RegExp(failure.errorCode));
  }
});

test("only transient cloud-read failures are eligible for live-read clearing", () => {
  const document = { createElement: element, body: element() };
  const ui = mount(document);

  ui.show({ errorCode: "UNAUTHORIZED", source: "cloud-read" });
  assert.equal(ui.captureCloudReadFailure(), null);
  ui.show({ errorCode: "API_REQUEST_TIMEOUT", source: "workbook-sync" });
  assert.equal(ui.captureCloudReadFailure(), null);
  assert.equal(ui.panel.hidden, false);
});
