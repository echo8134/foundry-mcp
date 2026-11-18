import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  documentsWithin,
  elementIdArrays,
  explainFieldProblems,
  explainRemovalProblems,
  fieldProblems,
  removalProblems,
  sameHtml
} from "../module/scripts/field-check.mjs";
import {
  ActivitiesField,
  AdvancementDataField,
  AppliedBehaviorField,
  ArrayField,
  BooleanField,
  DataField,
  DocumentFlagsField,
  DocumentIdField,
  DocumentOwnershipField,
  EmbeddedCollectionField,
  EmbeddedDataField,
  EmbeddedDocumentField,
  HTMLField,
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

/** Stands in for the TypeDataField of a journal page, whose spell pages have a data model. */
class PageDataField extends TypeDataField {
  getModelForType(type: string) {
    return type === "spell" ? { schema: new SchemaField({ level: new NumberField() }) } : null;
  }
}

describe("fieldProblems with the embedded documents given inside the data", () => {
  const page = {
    documentName: "JournalEntryPage",
    schema: new SchemaField({
      name: new StringField(),
      type: new StringField({ initial: "text" }),
      system: new PageDataField(),
      text: new SchemaField({ content: new HTMLField() }),
      flags: new DocumentFlagsField()
    })
  };
  const item = {
    documentName: "Item",
    schema: new SchemaField({
      name: new StringField(),
      type: new StringField(),
      system: new TypeDataField(),
      effects: new EmbeddedCollectionField(page)
    })
  };
  const delta = { documentName: "ActorDelta", schema: new SchemaField({ name: new StringField() }) };
  const entry = new SchemaField({
    name: new StringField(),
    pages: new EmbeddedCollectionField(page),
    items: new EmbeddedCollectionField(item),
    delta: new EmbeddedDocumentField(delta),
    loose: new EmbeddedCollectionField({ documentName: "Loose" })
  });
  const embedded = true;
  const problems = (data: Record<string, unknown>) =>
    fieldProblems(entry, data, { embedded }).map(({ path, problem }) => [path, problem]);

  it("checks each embedded document against the schema of its own class, at its place in the list", () => {
    assert.deepEqual(problems({ name: "Lore", pages: [{ name: "One", text: { content: "<p>x</p>" } }] }), []);
    assert.deepEqual(problems({ pages: [{ name: "One" }, { nmae: "Two", text: { contnet: "x" } }] }), [
      ["pages.1.nmae", "unknown"],
      ["pages.1.text.contnet", "unknown"]
    ]);
  });

  it("checks the system data of an embedded document by the type it names, or else by the type Foundry fills in", () => {
    assert.deepEqual(problems({ pages: [{ type: "spell", system: { level: 3, school: "evo" } }] }), [
      ["pages.0.system.school", "unknown"]
    ]);
    assert.deepEqual(problems({ pages: [{ system: { level: 3 } }] }), [["pages.0.system", "model"]]);
    assert.deepEqual(problems({ items: [{ type: "npc", system: { cr: 1, ac: 2 } }] }), [
      ["items.0.system.ac", "unknown"]
    ]);
  });

  it("asks for the type of an embedded document that names none and gets none filled in, where its system data needs one", () => {
    const found = fieldProblems(
      entry,
      { items: [{ name: "Sword", system: { cr: 1 } }, { name: "Bare" }] },
      { embedded }
    );
    assert.deepEqual(found, [{ path: "items.0.system", problem: "model", type: undefined }]);
  });

  it("goes on into the embedded documents of an embedded document, and into a single embedded document", () => {
    assert.deepEqual(problems({ items: [{ type: "npc", effects: [{ name: "Lit", glow: 1 }] }] }), [
      ["items.0.effects.0.glow", "unknown"]
    ]);
    assert.deepEqual(problems({ delta: { name: "Own", hp: 3 } }), [["delta.hp", "unknown"]]);
    assert.deepEqual(problems({ delta: null }), []);
  });

  it("reports a collection whose class it cannot read as unchecked, and leaves a list that is none to the model", () => {
    assert.deepEqual(problems({ loose: [{ anything: 1 }] }), [["loose.0", "unchecked"]]);
    assert.deepEqual(problems({ pages: { name: "One" } }), []);
  });

  it("finds a reserved key inside an embedded document as anywhere else", () => {
    assert.deepEqual(problems({ pages: [{ flags: { "a.b": 1 } }] }), [["pages.0.flags", "reserved"]]);
  });

  it("keeps refusing embedded documents for a walk that was not asked to follow them", () => {
    assert.deepEqual(fieldProblems(entry, { pages: [{ name: "One" }] }), [{ path: "pages", problem: "embedded" }]);
    assert.deepEqual(fieldProblems(entry, { delta: { name: "Own", hp: 3 } }), [
      { path: "delta.hp", problem: "unknown" }
    ]);
  });

  it("finds the HTML leaves of embedded documents, so that a stored page is compared by what it says", () => {
    const data = { pages: [{ name: "One", text: { content: "<p>a</p>" } }] };
    const same = sameHtml(entry, data, (html) => html.toLowerCase(), { embedded });
    assert.equal(same("pages.0.text.content", "<P>a</P>", "<p>a</p>"), true);
    assert.equal(same("pages.0.name", "ONE", "one"), false);
    assert.equal(
      sameHtml(entry, data, (html) => html.toLowerCase())("pages.0.text.content", "<P>a</P>", "<p>a</p>"),
      false
    );
  });
});

describe("fieldProblems of documents held as data", () => {
  const effect = { documentName: "ActiveEffect", schema: new SchemaField({ name: new StringField() }) };
  const actor = {
    documentName: "Actor",
    schema: new SchemaField({
      name: new StringField(),
      type: new StringField(),
      system: new TypeDataField(),
      effects: new EmbeddedCollectionField(effect)
    })
  };
  const held = (model: { documentName?: string; schema: SchemaField }) =>
    Object.assign(new EmbeddedDataField(model.schema.fields), { model });
  const adventure = new SchemaField({
    name: new StringField(),
    actors: new SetField(held(actor)),
    token: held({ schema: new SchemaField({ name: new StringField() }) })
  });
  const problems = (data: Record<string, unknown>, options = {}) =>
    fieldProblems(adventure, data, options).map(({ path, problem }) => [path, problem]);

  it("checks each one by the type it names, though the document that holds them has none", () => {
    assert.deepEqual(problems({ name: "Mine", actors: [{ name: "Goblin", type: "npc", system: { cr: 1 } }] }), []);
    assert.deepEqual(problems({ actors: [{ type: "npc", system: { cr: 1, ac: 2 } }, { nmae: "Ogre" }] }), [
      ["actors.0.system.ac", "unknown"],
      ["actors.1.nmae", "unknown"]
    ]);
    assert.deepEqual(problems({ actors: [{ name: "Bare", system: { cr: 1 } }] }), [["actors.0.system", "model"]]);
  });

  it("takes the embedded documents inside one as its data, whether or not the walk follows embedded documents", () => {
    const data = { actors: [{ type: "npc", effects: [{ name: "Lit", glow: 1 }] }] };
    for (const options of [{}, { embedded: true }]) {
      assert.deepEqual(problems(data, options), [["actors.0.effects.0.glow", "unknown"]]);
    }
  });

  it("reads a model that is no document as a plain schema", () => {
    assert.deepEqual(problems({ token: { name: "Goblin", hp: 3 } }), [["token.hp", "unknown"]]);
  });

  it("lists each one and the embedded documents inside it, with where they lie", () => {
    const data = { actors: [{ type: "npc", effects: [{ name: "Lit" }] }], token: { name: "Goblin" } };
    assert.deepEqual(
      documentsWithin(adventure, data).map(({ documentName, path }) => [documentName, path]),
      [
        ["Actor", "actors.0"],
        ["ActiveEffect", "actors.0.effects.0"]
      ]
    );
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

describe("fieldProblems below a behavior of a dnd5e activity", () => {
  const terrain = new SchemaField({ multiplier: new NumberField() });
  const behavior = new AppliedBehaviorField({
    type: new StringField(),
    name: new StringField(),
    config: new TypeDataField5e()
  });
  const activity = new SchemaField({ type: new StringField(), behaviors: new ArrayField(behavior) });
  const item = new SchemaField({ activities: new MappingField(new TypeDataField5e()) });
  const schemaFor = {
    TypeDataField5e: (entry: any, _field: unknown, heldType?: string) => {
      if (heldType !== undefined) return heldType === "difficultTerrain" ? terrain : undefined;
      return entry?.type === "attack" ? activity : undefined;
    }
  };
  const withBehaviors = (behaviors: unknown[]) => ({ activities: { bite: { type: "attack", behaviors } } });

  it("checks a behavior's config against the data model of the behavior's own type", () => {
    const data = withBehaviors([
      { type: "difficultTerrain", name: "Mud", config: { multiplier: 3 } },
      { type: "difficultTerrain", config: { speed: 3 } }
    ]);
    assert.deepEqual(fieldProblems(item, data, { schemaFor }), [
      { path: "activities.bite.behaviors.1.config.speed", problem: "unknown" }
    ]);
  });

  it("refuses the config of a behavior whose type has no data model, or that names none", () => {
    const data = withBehaviors([{ type: "ghost", config: { any: 1 } }, { config: { any: 1 } }]);
    assert.deepEqual(fieldProblems(item, data, { schemaFor }), [
      { path: "activities.bite.behaviors.0.config", problem: "model", type: "ghost" },
      { path: "activities.bite.behaviors.1.config", problem: "model", type: undefined }
    ]);
  });

  it("does not hand a behavior's type on to the entries beside it or below its config", () => {
    const nested = new SchemaField({ multiplier: new NumberField(), inner: new TypeDataField5e() });
    const seen: unknown[] = [];
    const tracing = {
      TypeDataField5e: (entry: any, _field: unknown, heldType?: string) => {
        seen.push(heldType);
        if (heldType === "difficultTerrain") return nested;
        return entry?.type === "attack" ? activity : undefined;
      }
    };
    const data = {
      activities: {
        bite: { type: "attack", behaviors: [{ type: "difficultTerrain", config: { inner: { type: "attack" } } }] },
        claw: { type: "attack" }
      }
    };
    assert.deepEqual(fieldProblems(item, data, { schemaFor: tracing }), []);
    assert.deepEqual(seen, [undefined, "difficultTerrain", undefined, undefined]);
  });
});

describe("elementIdArrays", () => {
  const generated = () => new DocumentIdField({ initial: () => "newid00000000001" });
  const schema = new SchemaField({
    changes: new ArrayField(new SchemaField({ _id: generated(), key: new StringField() })),
    references: new ArrayField(new SchemaField({ _id: new DocumentIdField({ initial: null }) })),
    parts: new ArrayField(new SchemaField({ number: new NumberField() })),
    tags: new SetField(new StringField()),
    system: new TypeDataField({ documentName: "Item" }),
    activities: new MappingField(new TypeDataField5e())
  });
  const activity = new SchemaField({
    type: new StringField(),
    profiles: new ArrayField(
      new SchemaField({ _id: generated(), groups: new ArrayField(new SchemaField({ _id: generated() })) })
    )
  });
  const schemaFor = { TypeDataField5e: () => activity };

  it("names the given lists whose elements are each given an id of their own, at any depth", () => {
    const data = {
      changes: [{ key: "a" }],
      references: [{ _id: "x" }],
      parts: [{ number: 1 }],
      tags: ["a"],
      activities: { bite: { type: "summon", profiles: [{ groups: [{}] }, { groups: [] }] } }
    };
    assert.deepEqual(elementIdArrays(schema, data, { type: "feat", schemaFor }), [
      "changes",
      "activities.bite.profiles",
      "activities.bite.profiles.0.groups",
      "activities.bite.profiles.1.groups"
    ]);
  });

  it("names no list the data does not give, and none where the value is no list", () => {
    assert.deepEqual(elementIdArrays(schema, { changes: "all", parts: [] }, { type: "feat", schemaFor }), []);
    assert.deepEqual(elementIdArrays(schema, {}, { type: "feat" }), []);
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

describe("sameHtml", () => {
  const withHtml = new SchemaField({
    name: new StringField(),
    bio: new HTMLField(),
    notes: new TypedObjectField(new SchemaField({ text: new HTMLField(), title: new StringField() })),
    pages: new ArrayField(new SchemaField({ body: new HTMLField() })),
    system: new TypeDataField()
  });
  // Stands in for the parsed form: two spellings of one content differ in case and in spaces only.
  const canonical = (html: string) => html.toLowerCase().replace(/\s+/g, "");
  const data = {
    name: "Goblin",
    bio: "<p>a</p>",
    notes: { one: { text: "<p>b</p>", title: "T" } },
    pages: [{ body: "<p>c</p>" }]
  };
  const same = sameHtml(withHtml, data, canonical, { type: "npc" });

  it("takes two texts of an HTML field as one when their canonical forms are equal", () => {
    assert.equal(same("bio", "<P>a</P>", "<p> a </p>"), true);
    assert.equal(same("bio", "<p>a</p>", "<p>b</p>"), false);
  });

  it("finds the HTML fields below a keyed map and inside a list, by the path the data has them at", () => {
    assert.equal(same("notes.one.text", "<P>b</P>", "<p>b</p>"), true);
    assert.equal(same("pages.0.body", "<P>c</P>", "<p>c</p>"), true);
    assert.equal(same("pages.1.body", "<P>c</P>", "<p>c</p>"), false, "the data has no second page");
  });

  it("compares no other field that way, and no value that is not a text", () => {
    assert.equal(same("name", "GOBLIN", "goblin"), false);
    assert.equal(same("notes.one.title", "T", "t"), false);
    assert.equal(same("bio", null, "<p>a</p>"), false);
    assert.equal(same("bio", "<p>a</p>", undefined), false);
  });

  it("follows the system data of the document type", () => {
    class BiographyData extends TypeDataField {
      override getModelForType() {
        return { schema: new SchemaField({ details: new SchemaField({ biography: new HTMLField() }) }) };
      }
    }
    const typedHtml = new SchemaField({ system: new BiographyData() });
    const typedSame = sameHtml(typedHtml, { system: { details: { biography: "<p>x</p>" } } }, canonical, {
      type: "npc"
    });
    assert.equal(typedSame("system.details.biography", "<P>x</P>", "<p>x</p>"), true);
    assert.throws(() => sameHtml(typedHtml, { system: { details: {} } }, canonical), TypeError);
  });
});

describe("removalProblems", () => {
  const actor = new SchemaField({
    name: new StringField(),
    system: new TypeDataField(),
    prototypeToken: new EmbeddedDataField({
      detection: new TypedObjectField(new SchemaField({ range: new NumberField() }))
    }),
    ownership: new DocumentOwnershipField(),
    flags: new DocumentFlagsField(),
    items: new EmbeddedCollectionField({ documentName: "Item" }),
    tools: new MappingField(new SchemaField({ value: new NumberField(), bonus: new StringField() })),
    abilities: new MappingField(new SchemaField({ value: new NumberField() }), {
      initialKeys: ["str", "dex"],
      initialKeysOnly: true
    }),
    tags: new SetField(new StringField()),
    members: new ArrayField(new SchemaField({ notes: new TypedObjectField(new StringField()) })),
    derived: new TypedObjectField(new NumberField(), { persisted: false }),
    activities: new ActivitiesField(),
    shape: new TypedSchemaField({ circle: new SchemaField({ type: new StringField() }) })
  });
  const problems = (paths: string[], type: string | undefined = "npc") => removalProblems(actor, paths, { type });

  it("takes the path of an entry of a keyed map, also one that keeps only its initial keys", () => {
    assert.deepEqual(
      problems(["tools.thief", "abilities.str", "abilities.stray", "prototypeToken.detection.seeAll"]),
      []
    );
    assert.deepEqual(problems(["activities.bite"]), []);
  });

  it("takes a key at any depth below a free-form object, and a whole flags scope", () => {
    assert.deepEqual(
      problems(["flags.world", "flags.world.note", "flags.world.deep.deeper.key", "ownership.user1"]),
      []
    );
  });

  it("refuses a path that names a field, a part of an entry, or something inside a list", () => {
    const paths = [
      "name",
      "flags",
      "tools",
      "system",
      "tools.thief.value",
      "tags.0",
      "members.0.notes.x",
      "items.abc",
      "name.deeper",
      "activities.bite.name",
      "shape.type"
    ];
    assert.deepEqual(
      problems(paths),
      paths.map((path) => ({ path, problem: "field" }))
    );
  });

  it("refuses a path the schema does not have, and one into a field that is not stored", () => {
    assert.deepEqual(problems(["tols.thief", "prototypeToken.detections.x", "derived.x", "system.skills.x"]), [
      { path: "tols.thief", problem: "unknown" },
      { path: "prototypeToken.detections.x", problem: "unknown" },
      { path: "derived.x", problem: "unknown" },
      { path: "system.skills.x", problem: "unknown" }
    ]);
  });

  it("follows the system data of the document type, and needs the type for it", () => {
    class ToolData extends TypeDataField {
      override getModelForType(type: string) {
        const tools = new MappingField(new SchemaField({ value: new NumberField() }));
        return type === "npc" ? { schema: new SchemaField({ tools, cr: new NumberField() }) } : null;
      }
    }
    const typed = new SchemaField({ system: new ToolData() });
    assert.deepEqual(removalProblems(typed, ["system.tools.thief"], { type: "npc" }), []);
    assert.deepEqual(removalProblems(typed, ["system.cr", "system.tols.x"], { type: "npc" }), [
      { path: "system.cr", problem: "field" },
      { path: "system.tols.x", problem: "unknown" }
    ]);
    assert.deepEqual(removalProblems(typed, ["system.tools.thief"], { type: "ghost" }), [
      { path: "system.tools.thief", problem: "unknown" }
    ]);
    assert.throws(() => removalProblems(typed, ["system.tools.thief"]), TypeError);
  });

  it("refuses a path with an empty key or one Foundry reads as an instruction", () => {
    const paths = [
      "flags.world.-=note",
      "flags.==world",
      "flags.world.__proto__",
      "tools..x",
      ".tools",
      "flags.constructor.x"
    ];
    assert.deepEqual(
      problems(paths),
      paths.map((path) => ({ path, problem: "reserved" }))
    );
  });
});

describe("explainRemovalProblems", () => {
  it("says what is unknown, what cannot be removed and what to do instead, and what is no plain key", () => {
    const text = explainRemovalProblems([
      { path: "tols.thief", problem: "unknown" },
      { path: "name", problem: "field" },
      { path: "tags.0", problem: "field" },
      { path: "flags.-=x", problem: "reserved" }
    ]);
    assert.match(text, /^Not a path of plain keys: flags\.-=x\. /);
    assert.match(text, / No such field: tols\.thief\. /);
    assert.match(
      text,
      / Not an entry that can be removed: name, tags\.0\. remove takes the path of one entry of a keyed map/
    );
    assert.match(text, /give it another value instead, and give a list whole to drop an element of it\.$/);
  });
});
