import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explainFieldProblems, fieldProblems } from "../module/scripts/field-check.mjs";
import {
  AdvancementDataField,
  ArrayField,
  BooleanField,
  DataField,
  DocumentFlagsField,
  EmbeddedCollectionField,
  MappingField,
  NumberField,
  ObjectField,
  SchemaField,
  SetField,
  StringField,
  TypeDataField5e,
  TypedObjectField,
  TypedSchemaField
} from "./fake-system.ts";

/** Foundry's TypeDataField picks the data model of the document type (common/data/fields.mjs:4317). */
class TypeDataField extends DataField {
  getModelForType(type: string) {
    const models: Record<string, { schema: SchemaField }> = {
      npc: { schema: new SchemaField({ cr: new NumberField() }) }
    };
    return models[type] ?? null;
  }
}

const fields = {
  name: new StringField(),
  hidden: new BooleanField(),
  light: new SchemaField({ dim: new NumberField(), bright: new NumberField() }),
  derived: new NumberField({ persisted: false }),
  bonuses: new SchemaField({ melee: new StringField() }, { persisted: false }),
  flags: new DocumentFlagsField(),
  config: new ObjectField(),
  detection: new TypedObjectField(new SchemaField({ range: new NumberField() })),
  abilities: new MappingField(new SchemaField({ value: new NumberField() }), {
    initialKeys: { str: {}, dex: {} },
    initialKeysOnly: true
  }),
  currency: new MappingField(new NumberField(), { initialKeys: ["gp", "sp"], initialKeysOnly: true }),
  skills: new MappingField(new SchemaField({ value: new NumberField() }), { initialKeys: ["acr"] }),
  members: new ArrayField(new SchemaField({ quantity: new NumberField() })),
  tags: new SetField(new StringField()),
  effects: new EmbeddedCollectionField({ documentName: "ActiveEffect" }),
  shape: new TypedSchemaField({
    circle: new SchemaField({ type: new StringField(), radius: new NumberField() }),
    rectangle: new SchemaField({ type: new StringField(), width: new NumberField() })
  })
};
const schema = new SchemaField(fields);
const typed = new SchemaField({ ...fields, system: new TypeDataField() });

describe("fieldProblems", () => {
  it("finds none for data whose every leaf is a stored field", () => {
    const data = {
      name: "Goblin",
      hidden: true,
      light: { dim: 10 },
      abilities: { str: { value: 12 } },
      currency: { gp: 5 },
      members: [{ quantity: 2 }],
      tags: ["a", "b"],
      shape: { type: "circle", radius: 3 }
    };
    assert.deepEqual(fieldProblems(schema, data), []);
  });

  it("names every unknown field by its full path, at the top and nested", () => {
    const problems = fieldProblems(schema, { hiden: true, light: { dimm: 3, bright: 2 }, members: [{}, { qty: 1 }] });
    assert.deepEqual(problems, [
      { path: "hiden", problem: "unknown" },
      { path: "light.dimm", problem: "unknown" },
      { path: "members.1.qty", problem: "unknown" }
    ]);
  });

  it("refuses a path into a field that is not stored, as derived", () => {
    assert.deepEqual(fieldProblems(schema, { derived: 3, bonuses: { melee: "+1" } }), [
      { path: "derived", problem: "derived" },
      { path: "bonuses", problem: "derived" }
    ]);
  });

  it("allows any path below a free-form object such as flags", () => {
    const data = { flags: { dnd5e: { lockSize: true, deep: { any: [1] } } }, config: { anything: { at: "all" } } };
    assert.deepEqual(fieldProblems(schema, data), []);
  });

  it("allows any key of a keyed map, and checks below the key against the map's element", () => {
    assert.deepEqual(
      fieldProblems(schema, { detection: { seeAll: { range: 30 } }, skills: { arc: { value: 1 } } }),
      []
    );
    assert.deepEqual(fieldProblems(schema, { detection: { seeAll: { rnge: 30 } } }), [
      { path: "detection.seeAll.rnge", problem: "unknown" }
    ]);
  });

  it("refuses a key outside the initial keys of a map that keeps only those, naming the keys it takes", () => {
    assert.deepEqual(fieldProblems(schema, { abilities: { strr: { value: 1 } }, currency: { zz: 1, gp: 2 } }), [
      { path: "abilities.strr", problem: "key", keys: ["str", "dex"] },
      { path: "currency.zz", problem: "key", keys: ["gp", "sp"] }
    ]);
  });

  it("checks the variant of a typed schema that the data's type names", () => {
    assert.deepEqual(fieldProblems(schema, { shape: { type: "rectangle", width: 2, radius: 1 } }), [
      { path: "shape.radius", problem: "unknown" }
    ]);
  });

  it("refuses a typed schema value that names no variant, instead of leaving it unchecked", () => {
    const types = ["circle", "rectangle"];
    assert.deepEqual(fieldProblems(schema, { shape: { radius: 1, bogus: 2 } }), [
      { path: "shape", problem: "variant", types }
    ]);
    assert.deepEqual(fieldProblems(schema, { shape: { type: "blob" } }), [
      { path: "shape", problem: "variant", types }
    ]);
  });

  it("checks system data against the data model of the document type", () => {
    assert.deepEqual(fieldProblems(typed, { system: { cr: 1, ac: 3 } }, { type: "npc" }), [
      { path: "system.ac", problem: "unknown" }
    ]);
  });

  it("throws when the schema has typed system data and no type is passed, whatever the data", () => {
    assert.throws(() => fieldProblems(typed, { system: { ac: 3 } }), TypeError);
    assert.throws(() => fieldProblems(typed, { name: "Goblin" }), /needs the document type/);
    const nested = new SchemaField({ delta: new SchemaField({ system: new TypeDataField() }) });
    assert.throws(() => fieldProblems(nested, { delta: { system: { ac: 3 } } }), TypeError);
  });

  it("refuses system data of a type that has no data model, instead of taking anything", () => {
    assert.deepEqual(fieldProblems(typed, { system: { ac: 3 } }, { type: "character" }), [
      { path: "system", problem: "model", type: "character" }
    ]);
    assert.deepEqual(fieldProblems(typed, { name: "x", system: {} }, { type: "character" }), []);
  });

  for (const [label, key] of [
    ["has a dot", "foundry-mcp.managed"],
    ["starts with -=", "-=foundry-mcp"],
    ["starts with ==", "==foundry-mcp"],
    ["is the operator marker", "__$OPERATOR$__"],
    ["is __proto__", "__proto__"],
    ["is constructor", "constructor"],
    ["is prototype", "prototype"]
  ] as const) {
    it(`refuses a key that ${label}, in a schema, a map and a free-form object alike`, () => {
      const inside = JSON.parse(`{${JSON.stringify(key)}: null}`);
      const data = {
        ...inside,
        light: structuredClone(inside),
        detection: structuredClone(inside),
        flags: { scope: { deep: [{ list: structuredClone(inside) }] } },
        effects: [structuredClone(inside)]
      };
      assert.deepEqual(
        fieldProblems(schema, data).map(({ path, problem }) => [path, problem]),
        [
          ["", "reserved"],
          ["light", "reserved"],
          ["detection", "reserved"],
          ["flags.scope.deep.0.list", "reserved"],
          ["effects.0", "reserved"],
          ["effects", "embedded"]
        ]
      );
    });
  }

  it("takes a plain key that only looks like a reserved one", () => {
    assert.deepEqual(fieldProblems(schema, { flags: { "my-module": { "=a": 1, "a-=b": 2, proto: 3 } } }), []);
  });

  it("leaves values of the wrong type to their own checks", () => {
    assert.deepEqual(fieldProblems(schema, { light: 5, members: { no: 1 }, name: { a: 1 }, shape: 5 }), []);
  });

  it("refuses any data for an embedded collection, whose documents the tools take through inputs of their own", () => {
    assert.deepEqual(fieldProblems(schema, { effects: [{ anything: 1 }] }), [{ path: "effects", problem: "embedded" }]);
    assert.deepEqual(fieldProblems(schema, { name: "x", effects: [] }), [{ path: "effects", problem: "embedded" }]);
  });
});

describe("fieldProblems below a dnd5e TypeDataField5e", () => {
  const utility = new SchemaField({ type: new StringField(), name: new StringField() });
  const hitPoints = new SchemaField({ type: new StringField(), configuration: new AdvancementDataField() });
  const item = new SchemaField({
    activities: new MappingField(new TypeDataField5e()),
    advancement: new MappingField(new TypeDataField5e())
  });
  const activity = (entry: any) => (entry?.type === "utility" ? utility : undefined);

  it("refuses every entry when no schema is given for the field, even one that looks complete", () => {
    const data = { activities: { flourish: { type: "utility", name: "Flourish" }, bare: {} } };
    assert.deepEqual(fieldProblems(item, data), [
      { path: "activities.flourish", problem: "unchecked" },
      { path: "activities.bare", problem: "unchecked" }
    ]);
  });

  it("checks each entry against the schema schemaFor gives for it, and refuses one that names no known type", () => {
    const data = {
      activities: {
        ok: { type: "utility", name: "Flourish" },
        x: { type: "utility", bogus: 1 },
        ghost: { type: "ghost" }
      },
      advancement: { untyped: { name: "no type" } }
    };
    assert.deepEqual(fieldProblems(item, data, { schemaFor: { TypeDataField5e: activity } }), [
      { path: "activities.x.bogus", problem: "unknown" },
      { path: "activities.ghost", problem: "model", type: "ghost" },
      { path: "advancement.untyped", problem: "model", type: undefined }
    ]);
  });

  it("takes the entry for the field's own class before the one for the class it extends, and passes the field", () => {
    const seen: unknown[] = [];
    const schemaFor = {
      TypeDataField5e: (entry: any, field: unknown) => {
        seen.push(field);
        return entry?.type === "HitPoints" ? hitPoints : undefined;
      },
      AdvancementDataField: () => new SchemaField({ hint: new StringField() })
    };
    const data = { advancement: { hp: { type: "HitPoints", configuration: { hint: "x", bogus: 2 } } } };
    assert.deepEqual(fieldProblems(item, data, { schemaFor }), [
      { path: "advancement.hp.configuration.bogus", problem: "unknown" }
    ]);
    assert.deepEqual(seen, [item.fields.advancement.element]);
    assert.deepEqual(fieldProblems(item, data, { schemaFor: { TypeDataField5e: schemaFor.TypeDataField5e } }), [
      { path: "advancement.hp.configuration", problem: "model", type: undefined }
    ]);
  });
});

describe("explainFieldProblems", () => {
  it("says what is unknown, what is derived, and which keys a fixed map takes", () => {
    const text = explainFieldProblems([
      { path: "hiden", problem: "unknown" },
      { path: "light.dimm", problem: "unknown" },
      { path: "derived", problem: "derived" },
      { path: "abilities.strr", problem: "key", keys: ["str", "dex"] }
    ]);
    assert.equal(
      text,
      "No such field: hiden, light.dimm. Derived, never stored: derived. abilities.strr: the key must be one of str, dex."
    );
  });

  it("names a reserved key with the object it is in, and says what to give instead", () => {
    const text = explainFieldProblems([
      { path: "flags", problem: "reserved", key: "foundry-mcp.managed" },
      { path: "", problem: "reserved", key: "-=light" }
    ]);
    assert.match(text, /^Not a plain key: "foundry-mcp\.managed" in flags, "-=light" in the entry\. /);
    assert.match(text, /Give nested objects in place of a key with a dot\.$/);
  });

  it("says which types a typed value takes, and that a document type has no data model", () => {
    const text = explainFieldProblems([
      { path: "shape", problem: "variant", types: ["circle", "rectangle"] },
      { path: "system", problem: "model", type: "ghost" }
    ]);
    assert.equal(
      text,
      "shape: give its type, one of circle, rectangle. system: the type ghost has no data model to check it against."
    );
  });

  it("says that embedded documents come through their own inputs, and that data it cannot check is left out", () => {
    const text = explainFieldProblems([
      { path: "items", problem: "embedded" },
      { path: "effects", problem: "embedded" },
      { path: "system.activities.x", problem: "unchecked" },
      { path: "system.activities.y", problem: "model", type: undefined }
    ]);
    assert.equal(
      text,
      "Not taken inside the data: items, effects. Embedded documents such as items and effects are given through the tool's own inputs for them. " +
        "Cannot be checked here: system.activities.x. What such an entry holds depends on its type, and this call has no data model for it. Leave it out of this call. " +
        "system.activities.y: give its type, which picks the data model to check it against."
    );
  });
});
