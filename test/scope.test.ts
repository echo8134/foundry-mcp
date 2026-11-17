import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FLAG_SCOPE, replacedBySync, restrictingLevels, sameLevels } from "../module/scripts/scope.mjs";

const managed = { [FLAG_SCOPE]: { managed: true } };

describe("level scope", () => {
  it("compares level sets as sets, and an empty set as all levels", () => {
    assert.equal(sameLevels(["a", "b"], ["b", "a", "a"]), true);
    assert.equal(sameLevels([], undefined), true);
    assert.equal(sameLevels(["a"], []), false);
  });

  it("counts a set that names every level of the scene as the empty set", () => {
    assert.deepEqual([...restrictingLevels(["a"], ["a"])], []);
    assert.deepEqual([...restrictingLevels(["b", "a"], ["a", "b"])], []);
    assert.deepEqual([...restrictingLevels(["a", "b", "stale"], ["a", "b"])], []);
    assert.deepEqual([...restrictingLevels(["a"], ["a", "b"])], ["a"]);
    assert.deepEqual([...restrictingLevels(["a"], [])], ["a"]);
  });

  it("replaces a bridge-made document whose level set is equal in effect, and nothing else", () => {
    const one = ["lvl1"];
    assert.equal(replacedBySync({ flags: managed, levels: new Set(["lvl1"]) }, [], one), true);
    assert.equal(replacedBySync({ flags: managed, levels: new Set() }, ["lvl1"], one), true);
    assert.equal(replacedBySync({ flags: managed, levels: new Set(["lvl1"]) }, ["lvl2"], ["lvl1", "lvl2"]), false);
    assert.equal(replacedBySync({ flags: {}, levels: new Set() }, [], one), false);
  });
});
