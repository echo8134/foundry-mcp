import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimNamed, FLAG_SCOPE, replacedBySync, restrictingLevels, sameLevels } from "../module/scripts/scope.mjs";

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

describe("claimNamed", () => {
  const made = (id: string) => ({ id, flags: managed });
  const byHand = (id: string) => ({ id, flags: {} });

  it("takes the one bridge-made document of the name, also beside one made by hand", () => {
    const one = made("a");
    assert.deepEqual(claimNamed([one]), { kind: "one", document: one });
    assert.deepEqual(claimNamed([byHand("x"), one, byHand("y")]), { kind: "one", document: one });
  });

  it("takes none of several bridge-made documents, and names them without the ones made by hand", () => {
    const [a, b] = [made("a"), made("b")];
    assert.deepEqual(claimNamed([a, byHand("x"), b]), { kind: "several", documents: [a, b] });
  });

  it("never takes a document made by hand, and says so when the name has only such", () => {
    const [x, y] = [byHand("x"), byHand("y")];
    assert.deepEqual(claimNamed([x, y]), { kind: "handMade", documents: [x, y] });
    assert.deepEqual(claimNamed([{ id: "z", flags: { [FLAG_SCOPE]: { managed: "yes" } } }]).kind, "handMade");
  });

  it("finds nothing where no document has the name", () => {
    assert.deepEqual(claimNamed([]), { kind: "none" });
  });
});
