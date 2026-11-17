import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  changedPaths,
  diffData,
  explainRecasts,
  pickData,
  recastLeaves,
  sameData
} from "../module/scripts/data-diff.mjs";

describe("recastLeaves", () => {
  it("finds nothing when Foundry would store every given value as it was given", () => {
    const given = { hidden: true, name: "Goblin", light: { dim: 10, color: null }, levels: ["a", "b"], flags: {} };
    assert.deepEqual(recastLeaves(given, structuredClone(given)), []);
  });

  it("accepts a number kept as the string of the same number, and a string kept trimmed or in another case", () => {
    const given = { formula: 30, bonus: 1.5, name: "  Goblin ", color: "#FF0000", blank: "   " };
    const wanted = { formula: "30", bonus: "1.5", name: "Goblin", color: "#ff0000", blank: "" };
    assert.deepEqual(recastLeaves(given, wanted), []);
  });

  it("names a string Foundry would store as another string: a colour it read as a hex number, a default for an empty one", () => {
    const given = { light: { color: "blue" }, tint: "#F80", bar: { attribute: "" }, src: "", short: "ff8800" };
    const wanted = {
      light: { color: "#00000b" },
      tint: "#000f80",
      bar: { attribute: "attributes.hp" },
      src: "icons/svg/mystery-man.svg",
      short: "#ff8800"
    };
    assert.deepEqual(recastLeaves(given, wanted), [
      { path: "light.color", given: "blue", kept: "#00000b" },
      { path: "tint", given: "#F80", kept: "#000f80" },
      { path: "bar.attribute", given: "", kept: "attributes.hp" },
      { path: "src", given: "", kept: "icons/svg/mystery-man.svg" },
      { path: "short", given: "ff8800", kept: "#ff8800" }
    ]);
  });

  it("names every given value Foundry would turn into another one, with what it would store", () => {
    const given = { hidden: "yes", light: null, disposition: null, rotation: 370, width: "2", shown: 1, label: true };
    const wanted = {
      hidden: false,
      light: { dim: 0 },
      disposition: -1,
      rotation: 10,
      width: 2,
      shown: true,
      label: "true"
    };
    assert.deepEqual(recastLeaves(given, wanted), [
      { path: "hidden", given: "yes", kept: false },
      { path: "light", given: null, kept: { dim: 0 } },
      { path: "disposition", given: null, kept: -1 },
      { path: "rotation", given: 370, kept: 10 },
      { path: "width", given: "2", kept: 2 },
      { path: "shown", given: 1, kept: true },
      { path: "label", given: true, kept: "true" }
    ]);
  });

  it("does not count a number as kept when the string is another number", () => {
    assert.deepEqual(recastLeaves({ formula: 30 }, { formula: "31" }), [{ path: "formula", given: 30, kept: "31" }]);
  });

  it("takes the keys cleaning adds as its defaults, at any depth and inside an array element", () => {
    const given = { modes: { seeAll: { range: 5 } }, parts: [{ number: 2 }, { number: 1, types: ["fire"] }] };
    const wanted = {
      modes: { seeAll: { range: 5, enabled: true } },
      parts: [
        { number: 2, denomination: undefined, types: [], scaling: { number: 1 } },
        { number: 1, denomination: undefined, types: ["fire"], scaling: { number: 1 } }
      ],
      added: 1
    };
    assert.deepEqual(recastLeaves(given, wanted), []);
  });

  it("looks inside arrays, and names the element and the key", () => {
    const given = { parts: [{ number: 2 }, { number: "3", types: ["fire", "cold"] }] };
    const wanted = { parts: [{ number: 2 }, { number: 3, types: ["fire", "Cold"] }] };
    assert.deepEqual(recastLeaves(given, wanted), [{ path: "parts.1.number", given: "3", kept: 3 }]);
  });

  it("reports a given key Foundry would drop, a list it would shorten, and a value of another shape", () => {
    const given = { flags: { "Bad Scope": { a: 1 } }, tags: ["a", "a"], light: 5, hidden: { a: 1 }, list: { 0: "a" } };
    const wanted = { flags: {}, tags: ["a"], light: {}, hidden: false, list: ["a"] };
    assert.deepEqual(recastLeaves(given, wanted), [
      { path: "flags.Bad Scope", given: { a: 1 }, kept: undefined },
      { path: "tags", given: ["a", "a"], kept: ["a"] },
      { path: "light", given: 5, kept: {} },
      { path: "hidden", given: { a: 1 }, kept: false },
      { path: "list", given: { 0: "a" }, kept: ["a"] }
    ]);
  });

  it("reads only own keys of the cleaned data", () => {
    assert.deepEqual(recastLeaves({ a: { toString: 1 } }, { a: {} }), [
      { path: "a.toString", given: 1, kept: undefined }
    ]);
  });
});

describe("explainRecasts", () => {
  it("names each path with the given value and what Foundry would store", () => {
    const text = explainRecasts([
      { path: "hidden", given: "yes", kept: false },
      { path: "flags.Bad Scope", given: { a: 1 }, kept: undefined }
    ]);
    assert.equal(
      text,
      'Foundry would not store these values as given: hidden: "yes" would be stored as false; flags.Bad Scope: {"a":1} would not be stored.'
    );
  });

  it("cuts a long value short", () => {
    const text = explainRecasts([{ path: "light", given: null, kept: { note: "x".repeat(500) } }]);
    assert.match(text, /light: null would be stored as \{"note":"x+\.\.\.\.$/);
    assert.ok(text.length < 200, text);
  });
});

describe("diffData", () => {
  it("finds nothing when every wanted leaf equals the stored one, and ignores stored keys that were not asked for", () => {
    const stored = { hidden: false, light: { dim: 10, bright: 5 }, name: "Goblin" };
    assert.deepEqual(diffData({ hidden: false, light: { dim: 10 } }, stored), { paths: [], changes: {} });
  });

  it("walks objects and reports only the leaves that differ, with a change that holds exactly those leaves", () => {
    const stored = { hidden: false, light: { dim: 10, bright: 5, animation: { type: "torch", speed: 5 } } };
    const wanted = { hidden: false, light: { dim: 20, bright: 5, animation: { type: "torch", speed: 3 } } };
    assert.deepEqual(diffData(wanted, stored), {
      paths: ["light.dim", "light.animation.speed"],
      changes: { light: { dim: 20, animation: { speed: 3 } } }
    });
  });

  it("compares an array whole and carries the whole array as the change", () => {
    const stored = { levels: ["a", "b"], points: [{ x: 1 }, { x: 2 }] };
    assert.deepEqual(diffData({ levels: ["a", "b"], points: [{ x: 1 }, { x: 2 }] }, stored).paths, []);
    assert.deepEqual(diffData({ levels: ["a", "c"] }, stored), { paths: ["levels"], changes: { levels: ["a", "c"] } });
    assert.deepEqual(diffData({ levels: ["a"] }, stored).paths, ["levels"]);
    assert.deepEqual(diffData({ points: [{ x: 1 }, { x: 3 }] }, stored).paths, ["points"]);
    assert.deepEqual(diffData({ points: [{ x: 1 }, { x: 2, y: 0 }] }, stored).paths, ["points"]);
  });

  it("finds an array of objects equal to the stored one when its elements carry the defaults cleaning filled in", () => {
    const stored = { parts: [{ number: 2, denomination: 6, bonus: "", types: [], custom: { enabled: false } }] };
    const cleaned = {
      parts: [{ number: 2, denomination: 6, bonus: "", types: [], custom: { enabled: false, formula: undefined } }]
    };
    assert.deepEqual(diffData(cleaned, stored), { paths: [], changes: {} });
    assert.deepEqual(diffData({ parts: [{ number: 2 }] }, stored).paths, ["parts"]);
  });

  it("counts a key that holds undefined as absent, on either side", () => {
    const stored = { a: [{ x: 1, y: undefined }], b: { c: 1 } };
    assert.deepEqual(diffData({ a: [{ x: 1 }], b: { c: 1, d: undefined }, e: undefined }, stored).paths, []);
    assert.deepEqual(diffData({ a: [{ x: 1, y: undefined, z: undefined }] }, { a: [{ x: 1 }] }).paths, []);
  });

  it("compares exactly: a number is not the string of the same number", () => {
    const stored = { formula: "30", count: 4, label: "", on: true };
    assert.deepEqual(diffData({ formula: "30", count: 4 }, stored).paths, []);
    assert.deepEqual(diffData({ formula: 30, count: "4", label: 0, on: 1 }, stored).paths, [
      "formula",
      "count",
      "label",
      "on"
    ]);
  });

  it("reports a leaf the stored data lacks, also below an object that is not stored or not an object", () => {
    const stored = { flags: null, name: "Goblin" };
    assert.deepEqual(diffData({ flags: { dnd5e: { lockSize: true } }, title: "x" }, stored), {
      paths: ["flags.dnd5e.lockSize", "title"],
      changes: { flags: { dnd5e: { lockSize: true } }, title: "x" }
    });
    assert.deepEqual(diffData({ name: { first: "Gob" } }, stored).paths, ["name.first"]);
  });

  it("takes an object without keys as asking for an object, whatever is in the stored one", () => {
    const stored = { flags: { core: { a: 1 } }, name: "Goblin" };
    assert.deepEqual(diffData({ flags: { core: {} } }, stored).paths, []);
    assert.deepEqual(diffData({ flags: { mine: {} }, name: {} }, stored), {
      paths: ["flags.mine", "name"],
      changes: { flags: { mine: {} }, name: {} }
    });
  });

  it("tells null apart from a missing value and from false", () => {
    const stored = { color: null, hidden: false };
    assert.deepEqual(diffData({ color: null, hidden: false }, stored).paths, []);
    assert.deepEqual(diffData({ hidden: null, other: null }, stored).paths, ["hidden", "other"]);
  });

  it("reads only own keys of the stored data, and keeps a __proto__ key as a key", () => {
    assert.deepEqual(diffData({ a: { toString: 1 } }, { a: {} }).paths, ["a.toString"]);
    const { paths, changes } = diffData(JSON.parse('{"__proto__": {"x": 1}}'), {});
    assert.deepEqual(paths, ["__proto__.x"]);
    assert.deepEqual(Object.keys(changes), ["__proto__"]);
    assert.equal(Object.getPrototypeOf(changes), Object.prototype);
  });
});

describe("sameData", () => {
  it("is true for data that is equal in depth, whatever the order of its keys", () => {
    assert.equal(sameData({ managed: true, list: [1, { a: null }] }, { list: [1, { a: null }], managed: true }), true);
    assert.equal(sameData({ managed: true }, { managed: true, extra: undefined }), true);
  });

  it("is false for a missing or an extra key, another type and another order of a list", () => {
    for (const other of [{}, { managed: true, extra: 1 }, { managed: "true" }, { managed: 1 }, null, undefined]) {
      assert.equal(sameData({ managed: true }, other), false, JSON.stringify(other));
    }
    assert.equal(sameData([1, 2], [2, 1]), false);
    assert.equal(sameData([], {}), false);
  });
});

describe("pickData", () => {
  it("copies the part of the source that the shape names, taking arrays and other leaves whole", () => {
    const source = { name: "Goblin", hidden: false, light: { dim: 10, bright: 5 }, parts: [{ n: 1, d: 6 }], x: 3 };
    const picked = pickData(source, { hidden: "yes", light: { dim: 99 }, parts: [{ n: 1 }], missing: 1 });
    assert.deepEqual(picked, { hidden: false, light: { dim: 10 }, parts: [{ n: 1, d: 6 }] });
  });

  it("returns a copy that a later change of the source does not reach", () => {
    const source = { light: { dim: 10 }, parts: [{ n: 1 }] };
    const picked = pickData(source, { light: { dim: 0 }, parts: [] }) as any;
    source.light.dim = 20;
    source.parts[0]!.n = 2;
    assert.deepEqual(picked, { light: { dim: 10 }, parts: [{ n: 1 }] });
  });

  it("picks nothing below an object without keys", () => {
    assert.deepEqual(pickData({ name: "Goblin", flags: { core: { a: 1 } } }, {}), {});
    assert.deepEqual(pickData({ name: "Goblin", flags: { core: { a: 1 } } }, { flags: { core: {} } }), {
      flags: { core: {} }
    });
  });

  it("takes the source's value whole where the shape goes deeper than the source", () => {
    assert.deepEqual(pickData({ flags: null, light: 5 }, { flags: { a: { b: 1 } }, light: { dim: 1 } }), {
      flags: null,
      light: 5
    });
  });
});

describe("changedPaths", () => {
  it("names the wanted leaf paths whose stored value is another one after the write", () => {
    const wanted = { hidden: true, light: { dim: 20, bright: 5 }, name: "Grik", parts: [{ n: 2 }] };
    const before = { hidden: false, light: { dim: 10, bright: 5 }, name: "Goblin", parts: [{ n: 1 }], x: 1 };
    const after = { hidden: true, light: { dim: 15, bright: 5 }, name: "Goblin", parts: [{ n: 2 }], x: 2 };
    assert.deepEqual(changedPaths(wanted, before, after), ["hidden", "light.dim", "parts"]);
  });

  it("sees a leaf that was not stored before, and compares against a picked copy as against the whole", () => {
    const wanted = { flags: { mine: { a: 1 } }, modes: { seeAll: { range: 5, enabled: true } } };
    const before = { flags: {}, name: "Goblin" };
    const after = { flags: { mine: { a: 1 } }, modes: { seeAll: { range: 5, enabled: true } }, name: "Goblin" };
    const expected = ["flags.mine.a", "modes.seeAll.range", "modes.seeAll.enabled"];
    assert.deepEqual(changedPaths(wanted, before, after), expected);
    assert.deepEqual(changedPaths(wanted, pickData(before, wanted), after), expected);
  });

  it("counts an object without keys as changed only when an object appeared where there was none", () => {
    const wanted = { flags: { mine: {}, core: {} } };
    const before = { flags: { core: { a: 1 } } };
    const after = { flags: { core: { a: 1, b: 2 }, mine: {} } };
    assert.deepEqual(changedPaths(wanted, pickData(before, wanted), after), ["flags.mine"]);
  });

  it("finds nothing when the write changed nothing that was wanted", () => {
    const stored = { hidden: false, light: { dim: 10 } };
    assert.deepEqual(changedPaths({ hidden: true, light: { dim: 20 } }, structuredClone(stored), stored), []);
  });
});
