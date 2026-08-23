"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { safeSnapshot } = require("../central-sync.cjs");

test("snapshot validation identifies the invalid top-level contract field", () => {
  const fixtures = [
    [{ revision: 248 }, "items"],
    [{ revision: "not-a-revision", items: [] }, "revision"],
    [{ revision: 248, items: [], changeSequence: -1 }, "changeSequence"],
  ];

  for (const [snapshot, expectedField] of fixtures) {
    assert.throws(() => safeSnapshot(snapshot), (error) =>
      error.code === "CLOUD_SNAPSHOT_INVALID"
      && error.snapshotField === expectedField);
  }
});
