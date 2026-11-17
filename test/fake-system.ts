// Stand-ins with the class names and public properties of Foundry's data fields (common/data/fields.mjs) and dnd5e's
// (dnd5e module/data/fields): each copies its options onto itself, as DataField's constructor does.

export class DataField {
  [option: string]: any;
  persisted = true;
  constructor(options: Record<string, any> = {}) {
    Object.assign(this, options);
  }
}
export class BooleanField extends DataField {}
export class NumberField extends DataField {}
export class AngleField extends NumberField {}
export class StringField extends DataField {}
export class ColorField extends StringField {}
export class HTMLField extends StringField {}
export class FilePathField extends StringField {}
export class DocumentIdField extends StringField {}
export class ForeignDocumentField extends DocumentIdField {
  constructor(model: unknown, options: Record<string, any> = {}) {
    super(options);
    this.model = model;
  }
}
export class DocumentUUIDField extends StringField {}
export class ObjectField extends DataField {}
/** Foundry's TypeDataField: the data model of the document type, from CONFIG (common/data/fields.mjs:4385-4388). */
export class TypeDataField extends ObjectField {
  constructor(document: { documentName: string }, options: Record<string, any> = {}) {
    super(options);
    this.document = document;
  }
  getModelForType(type: string) {
    const config = (globalThis as Record<string, any>).CONFIG;
    return config?.[this.document.documentName]?.dataModels?.[type] ?? null;
  }
}
/** A user's level by user id, and the default (common/data/fields.mjs:3896-3925). */
export class DocumentOwnershipField extends ObjectField {}
export class SchemaField extends DataField {
  constructor(fields: Record<string, DataField>, options: Record<string, any> = {}) {
    super(options);
    this.fields = fields;
  }
}
export class EmbeddedDataField extends SchemaField {}
export class ArrayField extends DataField {
  constructor(element: unknown, options: Record<string, any> = {}) {
    super(options);
    this.element = element;
  }
}
export class SetField extends ArrayField {}
export class EmbeddedCollectionField extends ArrayField {}
export class TypedObjectField extends ObjectField {
  constructor(element: DataField, options: Record<string, any> = {}) {
    super(options);
    this.element = element;
  }
}
export class DocumentFlagsField extends TypedObjectField {
  constructor() {
    super(new ObjectField());
  }
}
export class TypedSchemaField extends DataField {
  constructor(types: Record<string, SchemaField>, options: Record<string, any> = {}) {
    super(options);
    this.types = types;
  }
}
export class FormulaField extends StringField {}
export class IdentifierField extends StringField {}
export class MappingField extends TypedObjectField {}
/** dnd5e's TypeDataField5e: the data model of an entry comes from the `getModel` function it was built with. */
export class TypeDataField5e extends ObjectField {
  getModelForType(type?: string) {
    return this.getModel?.(type) ?? null;
  }
}
export class AdvancementDataField extends TypeDataField5e {
  constructor(typeModel?: { schema: SchemaField }) {
    super();
    this.typeModel = typeModel;
  }
  getModelForType() {
    return this.typeModel;
  }
}
const dnd5e = () => (globalThis as Record<string, any>).CONFIG?.DND5E;
export class ActivitiesField extends MappingField {
  constructor() {
    super(new TypeDataField5e({ getModel: (type: string) => dnd5e()?.activityTypes[type]?.documentClass }));
  }
}
export class AdvancementCollectionField extends MappingField {
  constructor() {
    super(new TypeDataField5e({ getModel: (type: string) => dnd5e()?.advancementTypes[type]?.documentClass }));
  }
}
/** A behavior an activity applies. Its config takes the data model of the behavior's own type. */
export class AppliedBehaviorField extends SchemaField {}

let elementIds = 0;
/** Stands in for foundry.utils.randomID as the initial value of an `_id` a list element is given. */
const newElementId = () => `element${String(++elementIds).padStart(9, "0")}`;
const generatedId = () => new DocumentIdField({ nullable: true, initial: newElementId });

/**
 * The fields every dnd5e activity has, as far as the tests use them (dnd5e module/data/activity/base-activity.mjs:50-99):
 * its own id and type, a description, references to effects of its item, and behaviors with an id of their own.
 */
const activity = (type: string, own: Record<string, DataField> = {}) => ({
  documentClass: {
    schema: new SchemaField({
      _id: generatedId(),
      type: new StringField({ initial: type }),
      name: new StringField({ initial: "" }),
      description: new SchemaField({ value: new HTMLField({ initial: "" }) }),
      effects: new ArrayField(new SchemaField({ _id: new DocumentIdField({ nullable: true, initial: null }) })),
      behaviors: new ArrayField(
        new AppliedBehaviorField({
          _id: generatedId(),
          type: new StringField(),
          config: new TypeDataField5e({ getModel: (kind: string) => dnd5e()?.activityBehaviorTypes[kind]?.model })
        })
      ),
      ...own
    })
  }
});

const damageParts = () =>
  new ArrayField(
    new SchemaField({
      number: new NumberField({ integer: true, min: 0, nullable: true, initial: null }),
      denomination: new NumberField({ integer: true, min: 0, nullable: true, initial: null }),
      bonus: new FormulaField({ initial: "" }),
      types: new SetField(new StringField())
    })
  );

/**
 * The token fields a test uses, with the initial values of Foundry's own (common/documents/token.mjs:53-189). A level id
 * is not checked for its form, because a test scene names its levels freely.
 */
export function tokenSchema() {
  const integer = (initial: number) => new NumberField({ integer: true, initial });
  return new SchemaField({
    _id: new DocumentIdField({ nullable: true, initial: null }),
    name: new StringField({ initial: "" }),
    actorId: new DocumentIdField({ nullable: true, initial: null }),
    actorLink: new BooleanField({ initial: false }),
    delta: new ObjectField(),
    x: integer(0),
    y: integer(0),
    elevation: new NumberField({ initial: 0 }),
    width: new NumberField({ positive: true, initial: 1 }),
    height: new NumberField({ positive: true, initial: 1 }),
    depth: new NumberField({ min: 0, initial: 1 }),
    // CONST.TOKEN_SHAPES. A token on a grid that is not hexagonal gets RECTANGLE_1 (common/documents/token.mjs:231-233).
    shape: new NumberField({ integer: true, choices: [0, 1, 2, 3, 4, 5], initial: 4 }),
    level: new DocumentIdField({ nullable: false }),
    sort: integer(0),
    rotation: new AngleField({ initial: 0 }),
    hidden: new BooleanField({ initial: false }),
    disposition: new NumberField({ integer: true, choices: [-2, -1, 0, 1], initial: -1 }),
    texture: new SchemaField({ src: new FilePathField({ nullable: true, initial: "icons/svg/mystery-man.svg" }) }),
    light: new SchemaField({
      dim: new NumberField({ min: 0, step: 0.01, initial: 0 }),
      bright: new NumberField({ min: 0, step: 0.01, initial: 0 }),
      color: new ColorField({ nullable: true, initial: null })
    }),
    detectionModes: new TypedObjectField(
      new SchemaField({
        enabled: new BooleanField({ initial: true }),
        range: new NumberField({ min: 0, step: 0.01, nullable: true, initial: null })
      })
    ),
    flags: new DocumentFlagsField(),
    _movementHistory: new ArrayField(new ObjectField()),
    _regions: new ArrayField(new DocumentIdField())
  });
}

/** A small dnd5e: a few actor, item and effect types with their system models, and the CONFIG.DND5E tables get_schema reads. */
export function systemConfig() {
  const document = (documentName: string) => ({ documentName });
  const Item = document("Item");
  const ActiveEffect = document("ActiveEffect");
  const hp = new SchemaField({
    value: new NumberField({ integer: true, min: 0, nullable: true, initial: null }),
    max: new NumberField({ integer: true, min: 0, nullable: true, initial: null }),
    temp: new NumberField({ integer: true, min: 0, nullable: true, initial: null })
  });
  const abilities = new MappingField(
    new SchemaField({ value: new NumberField({ integer: true, min: 0, initial: 10 }) }),
    {
      initialKeys: { str: {}, dex: {} }
    }
  );
  const flat = () => new NumberField({ integer: true, min: 0, nullable: true, initial: null });
  // The fields of dnd5e's creature data that the write tests use, with the kinds dnd5e gives them (dnd5e
  // module/data/actor/templates/attributes.mjs, creature.mjs, module/data/shared/senses-field.mjs, movement-field.mjs).
  const creature = (details: Record<string, DataField>) =>
    new SchemaField({
      abilities,
      attributes: new SchemaField({
        hp,
        ac: new SchemaField({
          flat: flat(),
          calcs: new SetField(new StringField(), { initial: () => ["unarmored", "armored"] }),
          value: new NumberField({ integer: true, persisted: false })
        }),
        senses: new SchemaField({
          ranges: new MappingField(new NumberField({ min: 0, nullable: true, initial: null }), {
            initialKeys: ["darkvision", "blindsight"],
            initialKeysOnly: true
          })
        }),
        movement: new SchemaField({
          speeds: new MappingField(new FormulaField({ deterministic: true }), {
            initialKeys: ["walk", "fly"],
            initialKeysOnly: true
          })
        })
      }),
      details: new SchemaField(details),
      skills: new MappingField(new SchemaField({ value: new NumberField({ min: 0, max: 2, initial: 0 }) }), {
        initialKeys: ["acr", "prc", "ste"],
        initialKeysOnly: true
      }),
      tools: new MappingField(
        new SchemaField({
          value: new NumberField({ min: 0, max: 2, initial: 1 }),
          ability: new StringField({ initial: "int" })
        })
      )
    });
  const biography = () =>
    new SchemaField({ value: new HTMLField({ initial: "" }), public: new HTMLField({ initial: "" }) });
  const actorSchema = new SchemaField({
    _id: new DocumentIdField({ nullable: true }),
    name: new StringField({ initial: "" }),
    type: new StringField(),
    img: new FilePathField({ nullable: true, initial: null }),
    system: new TypeDataField(document("Actor")),
    prototypeToken: new EmbeddedDataField({
      name: new StringField({ initial: "" }),
      actorLink: new BooleanField({ initial: false }),
      flags: new DocumentFlagsField()
    }),
    items: new EmbeddedCollectionField(Item),
    effects: new EmbeddedCollectionField(ActiveEffect),
    folder: new ForeignDocumentField(document("Folder"), { nullable: true }),
    ownership: new DocumentOwnershipField({ initial: () => ({ default: 0 }) }),
    flags: new DocumentFlagsField(),
    _stats: new ObjectField()
  });
  // The fields of Foundry's own item and effect documents (common/documents/item.mjs, active-effect.mjs:46-87).
  const itemSchema = new SchemaField({
    _id: new DocumentIdField({ nullable: true, initial: null }),
    name: new StringField({ required: true, blank: false }),
    type: new StringField(),
    img: new FilePathField({ nullable: true, initial: "icons/svg/item-bag.svg" }),
    system: new TypeDataField(Item),
    effects: new EmbeddedCollectionField(ActiveEffect),
    folder: new ForeignDocumentField(document("Folder"), { nullable: true, initial: null }),
    sort: new NumberField({ integer: true, initial: 0 }),
    ownership: new DocumentOwnershipField({ initial: () => ({ default: 0 }) }),
    flags: new DocumentFlagsField(),
    _stats: new ObjectField()
  });
  const effectSchema = new SchemaField({
    _id: new DocumentIdField({ nullable: true, initial: null }),
    name: new StringField({ required: true, blank: false }),
    img: new FilePathField({ nullable: true, initial: "icons/svg/aura.svg" }),
    type: new StringField({ initial: "base" }),
    system: new TypeDataField(ActiveEffect),
    disabled: new BooleanField({ initial: false }),
    duration: new SchemaField({
      value: new NumberField({ integer: true, min: 0, nullable: true, initial: null }),
      units: new StringField({ initial: "seconds" })
    }),
    description: new HTMLField({ initial: "" }),
    tint: new ColorField({ initial: "#ffffff" }),
    transfer: new BooleanField({ initial: true }),
    statuses: new SetField(new StringField()),
    flags: new DocumentFlagsField(),
    _stats: new ObjectField()
  });
  // dnd5e gives each change of an effect an id of its own (dnd5e module/data/abstract/active-effect-data-model.mjs:34-36).
  const effectChanges = () =>
    new ArrayField(
      new SchemaField({
        _id: generatedId(),
        key: new StringField({ initial: "" }),
        type: new StringField({ initial: "add" }),
        value: new StringField({ initial: "" }),
        phase: new StringField({ initial: "initial" })
      })
    );
  const description = () => new SchemaField({ value: new HTMLField({ initial: "" }) });
  return {
    Actor: {
      documentClass: { schema: actorSchema, metadata: { baseTypeAllowed: false } },
      dataModels: {
        character: {
          schema: creature({ level: new NumberField({ integer: true, min: 0, initial: 1, persisted: false }) })
        },
        npc: {
          schema: creature({ cr: new NumberField({ min: 0, nullable: true, initial: 1 }), biography: biography() })
        },
        vehicle: {
          schema: new SchemaField({
            attributes: new SchemaField({
              hp,
              ac: new SchemaField({ flat: flat(), override: flat(), calc: new StringField({ initial: "flat" }) })
            })
          }),
          // dnd5e turns the legacy `ac.calc` into the current fields on every cleaning and deletes it, and its vehicle
          // model then fills it in again as an initial value: measured, a vehicle's stored `calc: "flat"` given back
          // is not stored, and makes `override` the flat value (dnd5e module/data/actor/templates/attributes.mjs:185-212,
          // module/data/actor/vehicle.mjs:42-45).
          migrate(system: Record<string, any>) {
            const ac = system.attributes?.ac;
            if (!ac?.calc) return;
            if (ac.calc === "flat") ac.override = ac.flat;
            delete ac.calc;
          }
        },
        group: {
          schema: new SchemaField({ members: new ArrayField(new SchemaField({ quantity: new NumberField() })) })
        }
      }
    },
    Item: {
      documentClass: { schema: itemSchema, metadata: { baseTypeAllowed: false } },
      dataModels: {
        weapon: {
          schema: new SchemaField({
            damage: new SchemaField({ base: new FormulaField({ deterministic: false }) }),
            activities: new ActivitiesField()
          })
        },
        feat: {
          schema: new SchemaField({
            description: description(),
            type: new SchemaField({ value: new StringField({ initial: "" }) }),
            activities: new ActivitiesField()
          })
        },
        spell: {
          schema: new SchemaField({
            description: description(),
            level: new NumberField({ integer: true, min: 0, max: 9, initial: 1 }),
            activities: new ActivitiesField()
          })
        },
        class: {
          schema: new SchemaField({
            levels: new NumberField({ integer: true, min: 0, initial: 1 }),
            advancement: new AdvancementCollectionField()
          })
        }
      }
    },
    ActiveEffect: {
      documentClass: { schema: effectSchema, metadata: { baseTypeAllowed: true } },
      dataModels: {
        base: { schema: new SchemaField({ changes: effectChanges() }) },
        enchantment: {
          schema: new SchemaField({ changes: effectChanges(), magical: new BooleanField({ initial: true }) })
        }
      }
    },
    Token: {
      documentClass: {
        // Foundry's BaseToken.MOVEMENT_FIELDS (common/documents/token.mjs:204).
        MOVEMENT_FIELDS: Object.freeze(["x", "y", "elevation", "width", "height", "depth", "shape", "level"]),
        schema: tokenSchema()
      }
    },
    DND5E: {
      activityTypes: {
        attack: activity("attack", {
          attack: new SchemaField({
            bonus: new FormulaField({ initial: "" }),
            flat: new BooleanField({ initial: false })
          }),
          damage: new SchemaField({ includeBase: new BooleanField({ initial: true }), parts: damageParts() })
        }),
        save: activity("save", {
          save: new SchemaField({
            ability: new SetField(new StringField()),
            dc: new SchemaField({ formula: new FormulaField({ initial: "" }) })
          }),
          damage: new SchemaField({ onSave: new StringField({ initial: "half" }), parts: damageParts() })
        }),
        cast: activity("cast", {
          spell: new SchemaField({ uuid: new DocumentUUIDField({ nullable: true, initial: null }) })
        }),
        heal: { documentClass: { schema: new SchemaField({ healing: new SchemaField({}) }) } }
      },
      activityBehaviorTypes: {
        difficultTerrain: {
          model: { schema: new SchemaField({ multiplier: new NumberField({ min: 0, initial: 2 }) }) }
        }
      },
      advancementTypes: {
        HitPoints: {
          documentClass: {
            schema: new SchemaField({
              level: new NumberField({ integer: true, min: 0 }),
              configuration: new AdvancementDataField(),
              value: new AdvancementDataField({ schema: new SchemaField({ hint: new StringField() }) })
            })
          }
        }
      },
      abilities: { str: { label: "Strength", abbreviation: "str" }, dex: { label: "Dexterity" } },
      weaponTypes: { simpleM: "Simple Melee", martialR: "Martial Ranged" },
      conditionTypes: { blinded: { name: "Blinded", img: "blinded.svg" } },
      languages: {
        standard: { label: "Standard", selectable: false, children: { common: "Common", elvish: "Elvish" } },
        cant: "Thieves' Cant"
      },
      featureTypes: { class: { label: "Class Feature", subtypes: { channelDivinity: "Channel Divinity" } } }
    }
  };
}
