const assert = require("node:assert/strict");
const test = require("node:test");

const { createElectronFetch } = require("../electron-network-fetch.cjs");

test("central sync can use Electron networking so Windows proxy settings are honored", async () => {
  const electronNet = {
    fetch(url, init) {
      assert.equal(this, electronNet);
      assert.equal(url, "https://tek-stock.test/v1/snapshot");
      assert.equal(init.headers.accept, "application/json");
      return Promise.resolve({ ok: true, status: 200 });
    },
  };

  const fetchImpl = createElectronFetch(electronNet);
  assert.equal(typeof fetchImpl, "function");
  const response = await fetchImpl("https://tek-stock.test/v1/snapshot", {
    headers: { accept: "application/json" },
  });
  assert.equal(response.status, 200);
});

test("missing Electron networking leaves isolated test callers on their injected transport", () => {
  assert.equal(createElectronFetch({}), undefined);
});
