import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asStoredEntries, TYPED_ENTRY_SCHEMAS, withEntryId, withoutStoredFlag } from "../module/scripts/item-data.mjs";
import { idFromLabel } from "../module/scripts/labels.mjs";
import { SchemaField, StringField, TypeDataField5e } from "./fake-system.ts";

const TYPES = { activities: ["attack", "save"], advancement: ["HitPoints"] };
const BITE = idFromLabel("bite");
const ID = "abcdefghij123456";

describe("asStoredEntries", () => {
  it("turns a label into its id, as the key and as the entry's _id, and leaves a document id as it is", () => {
    const given = { system: { activities: { bite: { type: "attack" }, [ID]: { type: "save" } } } };
    const { data, problems } = asStoredEntries(given, {}, TYPES);
    assert.deepEqual(problems, []);
    assert.deepEqual(data.system.activities, {
      [BITE]: { type: "attack", _id: BITE },
      [ID]: { type: "save", _id: ID }
    });
    assert.deepEqual(given.system.activities, { bite: { type: "attack" }, [ID]: { type: "save" } });
  });

  it("gives an entry that exists the type it has, and refuses another one", () => {
    const stored = { system: { activities: { [BITE]: { _id: BITE, type: "attack" } } } };
    const kept = asStoredEntries({ system: { activities: { bite: { name: "Bite" } } } }, stored, TYPES);
    assert.deepEqual(
      [kept.data.system.activities[BITE], kept.problems],
      [{ name: "Bite", _id: BITE, type: "attack" }, []]
    );
    const { problems } = asStoredEntries({ system: { activities: { bite: { type: "save" } } } }, stored, TYPES);
    assert.match(problems.join(), /^system\.activities\.bite: this activity is of the type attack, and keeps it\./);
  });

  it("needs a type the map knows for a new entry, in the activities and in the advancement", () => {
    const given = {
      system: {
        activities: { claw: { name: "Claw" }, tail: { type: "sweep" } },
        advancement: { hp: { type: "HitPoints" }, asi: {} }
      }
    };
    const { data, problems } = asStoredEntries(given, {}, TYPES);
    assert.deepEqual(problems, [
      "system.activities.claw: a new activity needs a type, one of attack, save. get_schema with document Activity lists the fields of each.",
      "system.activities.tail: a new activity needs a type, one of attack, save. get_schema with document Activity lists the fields of each.",
      "system.advancement.asi: a new advancement needs a type, one of HitPoints. get_schema with document Advancement lists the fields of each."
    ]);
    assert.deepEqual(data.system.advancement[idFromLabel("hp")], { type: "HitPoints", _id: idFromLabel("hp") });
  });

  it("takes an _id that is the key or the label, and refuses another one", () => {
    const fine = asStoredEntries(
      { system: { activities: { bite: { _id: "bite", type: "attack" }, [ID]: { _id: ID, type: "save" } } } },
      {},
      TYPES
    );
    assert.deepEqual([fine.problems, fine.data.system.activities[BITE]._id], [[], BITE]);
    const { problems } = asStoredEntries({ system: { activities: { bite: { _id: ID, type: "attack" } } } }, {}, TYPES);
    assert.deepEqual(problems, [`system.activities.bite: its _id "${ID}" is not its key. Leave _id out.`]);
  });

  it("refuses two keys that are one entry", () => {
    const { problems } = asStoredEntries(
      { system: { activities: { bite: { type: "attack" }, [BITE]: { type: "attack" } } } },
      {},
      TYPES
    );
    assert.deepEqual(problems, [
      `system.activities.${BITE} names the activity ${BITE}, which another key of this entry names too.`
    ]);
  });

  it("gives an activity's references to effects the ids of their labels, and leaves other references alone", () => {
    const effects = [{ _id: "poison" }, { _id: ID, onSave: true }, { uuid: "Compendium.x.y.Item.z" }, "text"];
    const { data } = asStoredEntries({ system: { activities: { bite: { type: "save", effects } } } }, {}, TYPES);
    assert.deepEqual(data.system.activities[BITE].effects, [
      { _id: idFromLabel("poison") },
      { _id: ID, onSave: true },
      { uuid: "Compendium.x.y.Item.z" },
      "text"
    ]);
  });

  it("leaves a key Foundry would not store as it is, and an entry that is no object, for the schema check", () => {
    const given = { system: { activities: { "-=bite": null, "a.b": { type: "attack" }, claw: null } } };
    const { data, problems } = asStoredEntries(given, {}, TYPES);
    assert.deepEqual(problems, []);
    assert.deepEqual(Object.keys(data.system.activities), ["-=bite", "a.b", idFromLabel("claw")]);
    assert.equal(data.system.activities[idFromLabel("claw")], null);
  });

  it("leaves data without typed entries as it is", () => {
    for (const given of [{ name: "Bite" }, { system: "x" }, { system: { activities: [] } }, { system: { uses: {} } }]) {
      assert.deepEqual(asStoredEntries(given, {}, TYPES), { data: given, problems: [] });
    }
  });
});

describe("withEntryId", () => {
  it("puts the id in place of a label in the path of a typed entry, and leaves every other path", () => {
    assert.deepEqual(
      [
        "system.activities.bite",
        "system.activities.bite.attack",
        `system.activities.${ID}`,
        "system.advancement.hp",
        "system.activities",
        "system.uses.bite",
        "flags.activities.bite",
        "system.activities.-=bite"
      ].map(withEntryId),
      [
        `system.activities.${BITE}`,
        `system.activities.${BITE}.attack`,
        `system.activities.${ID}`,
        `system.advancement.${idFromLabel("hp")}`,
        "system.activities",
        "system.uses.bite",
        "flags.activities.bite",
        "system.activities.-=bite"
      ]
    );
  });
});

describe("withoutStoredFlag", () => {
  const stored = { flags: { "foundry-mcp": { managed: true }, world: { a: 1 } } };

  it("drops the bridge's own flag from given data while it equals the stored one", () => {
    const given = { name: "x", flags: { "foundry-mcp": { managed: true }, world: { a: 2 } } };
    assert.deepEqual(withoutStoredFlag(given, stored), { name: "x", flags: { world: { a: 2 } } });
    assert.deepEqual(given.flags["foundry-mcp"], { managed: true });
  });

  it("keeps a flag that differs from the stored one, or that a new document is given", () => {
    const other = { flags: { "foundry-mcp": { managed: false } } };
    assert.equal(withoutStoredFlag(other, stored), other);
    const fresh = { flags: { "foundry-mcp": { managed: true } } };
    assert.equal(withoutStoredFlag(fresh, {}), fresh);
    assert.deepEqual(withoutStoredFlag({ flags: "x" }, stored), { flags: "x" });
  });
});

describe("TYPED_ENTRY_SCHEMAS", () => {
  const attack = new SchemaField({ type: new StringField() });
  const terrain = new SchemaField({ multiplier: new StringField() });
  const models: Record<string, { schema: SchemaField }> = {
    attack: { schema: attack },
    difficultTerrain: { schema: terrain }
  };
  const field = new TypeDataField5e({ getModel: (type: string) => models[type] });
  const { TypeDataField5e: schemaFor, AdvancementDataField: fixed } = TYPED_ENTRY_SCHEMAS;

  it("takes the data model of an entry's own type, and of the behavior a config lies in", () => {
    assert.equal(schemaFor!({ type: "attack" }, field), attack);
    assert.equal(schemaFor!({ multiplier: 2 }, field, "difficultTerrain"), terrain);
    assert.equal(schemaFor!({ type: "attack" }, field, "difficultTerrain"), terrain);
  });

  it("answers nothing for a type without a model, for an entry that is no object, and for a field without models", () => {
    assert.deepEqual(
      [
        schemaFor!({ type: "ghost" }, field),
        schemaFor!(null, field),
        schemaFor!("attack", field),
        schemaFor!({ type: "attack" }, {})
      ],
      [undefined, undefined, undefined, undefined]
    );
  });

  it("takes the one model an advancement's configuration has, whatever the entry says", () => {
    const configuration = { getModelForType: () => ({ schema: terrain }) };
    assert.equal(fixed!({ type: "attack" }, configuration), terrain);
    assert.equal(fixed!({}, { getModelForType: () => undefined }), undefined);
  });
});
