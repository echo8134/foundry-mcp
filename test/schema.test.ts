import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configKeys, describeField, selectPath } from "../module/scripts/schema.mjs";
import {
  ActivitiesField,
  ArrayField,
  BooleanField,
  DataField,
  DocumentIdField,
  DocumentUUIDField,
  EmbeddedCollectionField,
  EmbeddedDataField,
  FilePathField,
  ForeignDocumentField,
  FormulaField,
  HTMLField,
  IdentifierField,
  MappingField,
  NumberField,
  SchemaField,
  SetField,
  StringField,
  TypeDataField,
  TypedObjectField,
  TypedSchemaField
} from "./fake-system.ts";

describe("describeField", () => {
  it("writes a leaf as its kind, then its constraints, then its default", () => {
    assert.equal(describeField(new NumberField({ integer: true, min: 0, initial: 10 })), "integer, min 0, default 10");
    assert.equal(
      describeField(new NumberField({ min: 0, max: 1, step: 0.05, nullable: true, initial: null })),
      "number, min 0, max 1, step 0.05, nullable, default null"
    );
    assert.equal(describeField(new NumberField({ positive: true })), "number, positive");
    assert.equal(describeField(new StringField({ choices: ["a", "b", "c"] })), "string, one of a|b|c");
    assert.equal(
      describeField(new StringField({ choices: { lr: "Long Rest", sr: "Short Rest" } })),
      "string, one of lr|sr"
    );
    assert.equal(describeField(new StringField({ choices: () => ["x", "y"] })), "string, one of x|y");
    assert.equal(describeField(new BooleanField({ initial: false })), "boolean, default false");
    assert.equal(describeField(new StringField({ initial: "ft" })), 'string, default "ft"');
  });

  it("names the kind of a subclass by the nearest class it knows", () => {
    class AngleField extends NumberField {}
    class CreatureTypeField extends SchemaField {}
    class Unknown extends DataField {}
    assert.equal(describeField(new FormulaField({ deterministic: true })), "formula, deterministic");
    assert.equal(describeField(new HTMLField()), "html");
    assert.equal(describeField(new IdentifierField()), "identifier");
    assert.equal(describeField(new FilePathField({ nullable: true })), "file path, nullable");
    assert.equal(describeField(new DocumentIdField()), "document id");
    assert.equal(describeField(new ForeignDocumentField({ documentName: "Folder" })), "id of Folder");
    assert.equal(describeField(new DocumentUUIDField({ type: "Item" })), "uuid of Item");
    assert.equal(describeField(new AngleField({ min: 0, max: 360 })), "number, min 0, max 360");
    assert.deepEqual(describeField(new CreatureTypeField({ value: new StringField() })), { value: "string" });
    assert.equal(describeField(new Unknown()), "any");
  });

  it("does not run a default that is computed, and survives choices that cannot be computed", () => {
    assert.equal(describeField(new StringField({ initial: () => "now" })), "string");
    const failing = new StringField({
      choices: () => {
        throw new Error("CONFIG not ready");
      }
    });
    assert.equal(describeField(failing), "string");
  });

  it("writes schemas as objects, arrays, sets and maps by their element, and leaves out what is not stored", () => {
    const tree = describeField(
      new SchemaField({
        hp: new SchemaField({ value: new NumberField({ integer: true }), max: new NumberField({ persisted: false }) }),
        tags: new SetField(new StringField()),
        rolls: new ArrayField(new SchemaField({ formula: new FormulaField() })),
        abilities: new MappingField(new SchemaField({ value: new NumberField() }), {
          initialKeys: { str: {}, dex: {} }
        }),
        movement: new MappingField(new NumberField(), { initialKeys: ["walk", "fly"] }),
        flags: new TypedObjectField(new DataField()),
        derived: new SchemaField({ total: new NumberField() }, { persisted: false })
      })
    );
    assert.deepEqual(tree, {
      hp: { value: "integer" },
      tags: { $set: "string" },
      rolls: { $array: { formula: "formula" } },
      abilities: { $map: { value: "number" }, $keys: ["str", "dex"] },
      movement: { $map: "number", $keys: ["walk", "fly"] },
      flags: { $map: "any" }
    });
  });

  it("names embedded collections instead of expanding them, and expands embedded data", () => {
    const tree = describeField(
      new SchemaField({
        items: new EmbeddedCollectionField({ documentName: "Item" }),
        activities: new ActivitiesField(),
        system: new TypeDataField(),
        prototypeToken: new EmbeddedDataField({ name: new StringField() })
      })
    );
    assert.deepEqual(tree, {
      items: "collection of Item",
      activities: "collection of Activity",
      system: "system data of the document type",
      prototypeToken: { name: "string" }
    });
  });

  it("writes a field with one schema per type as $types", () => {
    const field = new TypedSchemaField({
      flat: new SchemaField({ value: new NumberField() }),
      formula: new SchemaField({ formula: new FormulaField() })
    });
    assert.deepEqual(describeField(field), { $types: { flat: { value: "number" }, formula: { formula: "formula" } } });
  });
});

describe("selectPath", () => {
  const tree = {
    attributes: { hp: { value: "integer" } },
    abilities: { $map: { value: "number" }, $keys: ["str"] },
    rolls: { $array: { formula: "formula" } }
  };

  it("follows a dot path, through a map by any key and through an array by an index", () => {
    assert.deepEqual(selectPath(tree, "attributes"), { hp: { value: "integer" } });
    assert.equal(selectPath(tree, "attributes.hp.value"), "integer");
    assert.equal(selectPath(tree, "abilities.str.value"), "number");
    assert.deepEqual(selectPath(tree, "abilities.$keys"), ["str"]);
    assert.equal(selectPath(tree, "rolls.0.formula"), "formula");
  });

  it("answers undefined for a path that is not in the tree", () => {
    assert.equal(selectPath(tree, "attributes.ac"), undefined);
    assert.equal(selectPath(tree, "attributes.hp.value.deeper"), undefined);
    assert.equal(selectPath(tree, "rolls.first"), undefined);
  });
});

describe("configKeys", () => {
  it("gives each key its label, from a string, a label or a name, and nests children and subtypes", () => {
    assert.deepEqual(
      configKeys({
        str: { label: "Strength", abbreviation: "str" },
        simpleM: "Simple Melee",
        blinded: { name: "Blinded", img: "blinded.svg" },
        alchemist: "Compendium.dnd5e.equipment24.Item.phbtulAlchemists",
        bare: { ability: "int" },
        standard: { label: "Standard", selectable: false, children: { common: "Common" } },
        class: { label: "Class Feature", subtypes: { channelDivinity: "Channel Divinity" } }
      }),
      {
        str: "Strength",
        simpleM: "Simple Melee",
        blinded: "Blinded",
        alchemist: "Compendium.dnd5e.equipment24.Item.phbtulAlchemists",
        bare: null,
        standard: { label: "Standard", children: { common: "Common" } },
        class: { label: "Class Feature", subtypes: { channelDivinity: "Channel Divinity" } }
      }
    );
  });
});
