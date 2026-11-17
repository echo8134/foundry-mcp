import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { idFor, idFromLabel, isDocumentId } from "../module/scripts/labels.mjs";

describe("idFromLabel", () => {
  it("makes a document id of any label, the empty one and one of other scripts too", () => {
    for (const label of ["bite", "", "Breath Weapon (Recharge 5-6)", "__proto__", "feu 🔥", "x".repeat(500)]) {
      assert.match(idFromLabel(label), /^[a-zA-Z0-9]{16}$/, label);
    }
  });

  // An id written into a world by one version is how every later version finds that activity or effect again.
  it("gives the ids it gave before, so what an earlier call made is found again", () => {
    assert.deepEqual(["bite", "claw", "rage", "", "breath weapon"].map(idFromLabel), [
      "NX7Gpyz3Lr10j1FM",
      "BbLiRKUZAqsgZXM9",
      "OzQbZCAAg5UYsKBd",
      "5lVjt7vxlIx6tPL6",
      "DaI69bAdlX48LJEt"
    ]);
  });

  it("tells labels apart, also ones that differ in case or in a space", () => {
    const labels = [
      "bite",
      "Bite",
      "bite ",
      " bite",
      "bit",
      "bites",
      ...Array.from({ length: 5000 }, (_, i) => `a${i}`)
    ];
    assert.equal(new Set(labels.map(idFromLabel)).size, labels.length);
  });
});

describe("idFor", () => {
  it("keeps what has the form of a document id, and takes anything else as a label", () => {
    assert.equal(idFor("abcdefghij123456"), "abcdefghij123456");
    for (const label of ["abcdefghij12345", "abcdefghij1234567", "abcdefghij12345-", "bite"]) {
      assert.equal(idFor(label), idFromLabel(label));
      assert.notEqual(idFor(label), label);
    }
  });

  it("knows a document id by its form", () => {
    assert.deepEqual(
      ["abcdefghij123456", "ABCDEFGHIJ123456", "abcdefghij12345", "abcdefghij12345_", 1234567890123456, null].map(
        isDocumentId
      ),
      [true, true, false, false, false, false]
    );
  });
});
