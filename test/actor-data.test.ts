import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { derivedValues, withCreateDefaults } from "../module/scripts/actor-data.mjs";

describe("derivedValues", () => {
  it("reads the numbers dnd5e derives for a character, and only those", () => {
    const system = {
      attributes: {
        ac: { value: 15, flat: null, calc: "default" },
        hp: { value: 20, max: 24, temp: 3, tempmax: 0 },
        prof: 2,
        init: { total: 3, mod: 2, bonus: "" },
        spell: { dc: 13, attack: 5, mod: 3 }
      },
      details: { xp: { value: 300 }, level: 3, race: null },
      abilities: {
        str: { value: 10, mod: 0, save: { value: 2, bonus: 0 } },
        dex: { value: 14, mod: 2, save: { value: 2, bonus: 0 } }
      },
      skills: { acr: { value: 1, ability: "dex", total: 4, passive: 14 } }
    };
    assert.deepEqual(derivedValues(system), {
      ac: 15,
      hp: { value: 20, max: 24, temp: 3 },
      prof: 2,
      xp: 300,
      level: 3,
      init: 3,
      spell: { dc: 13, attack: 5 },
      abilities: { str: { mod: 0, save: 2 }, dex: { mod: 2, save: 2 } },
      skills: { acr: { total: 4, passive: 14 } }
    });
  });

  it("leaves out what an actor type does not have, and keeps a value dnd5e derives as null", () => {
    assert.deepEqual(derivedValues({ attributes: { ac: { value: 19 }, hp: { value: 100, max: 100 } } }), {
      ac: 19,
      hp: { value: 100, max: 100 }
    });
    assert.deepEqual(derivedValues({ members: [], attributes: { movement: { land: 30 } } }), {});
    assert.deepEqual(derivedValues({ attributes: { prof: null } }), { prof: null });
  });

  it("gives an ability without its derived numbers an empty entry rather than dropping the key", () => {
    assert.deepEqual(derivedValues({ abilities: { str: { value: 10 } } }), { abilities: { str: {} } });
  });
});

describe("withCreateDefaults", () => {
  it("gives a new npc that has a hit point maximum and no hit points the maximum as its hit points", () => {
    const data = { name: "Ogre", system: { attributes: { hp: { max: 59 } }, details: { cr: 2 } } };
    assert.deepEqual(withCreateDefaults("npc", data), {
      name: "Ogre",
      system: { attributes: { hp: { max: 59, value: 59 } }, details: { cr: 2 } }
    });
    assert.deepEqual(data.system.attributes.hp, { max: 59 }, "the given data is not changed");
  });

  it("keeps hit points that are given, also 0 and null", () => {
    for (const value of [0, 12, null]) {
      const data = { system: { attributes: { hp: { max: 59, value } } } };
      assert.deepEqual(withCreateDefaults("npc", data), data);
    }
  });

  it("adds nothing without a maximum, and nothing for another actor type", () => {
    const bare = { name: "Ogre", system: { attributes: { hp: { temp: 3 } } } };
    assert.deepEqual(withCreateDefaults("npc", bare), bare);
    assert.deepEqual(withCreateDefaults("npc", { name: "Ogre" }), { name: "Ogre" });
    const vehicle = { system: { attributes: { hp: { max: 40 } } } };
    assert.deepEqual(withCreateDefaults("vehicle", vehicle), vehicle);
    assert.deepEqual(withCreateDefaults("character", vehicle), vehicle);
  });
});
