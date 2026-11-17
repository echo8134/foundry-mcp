import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { derivedValues } from "../module/scripts/actor-data.mjs";

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
