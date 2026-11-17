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
export class TypeDataField extends ObjectField {}
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
export class TypeDataField5e extends ObjectField {}
export class AdvancementDataField extends TypeDataField5e {
  constructor(typeModel?: { schema: SchemaField }) {
    super();
    this.typeModel = typeModel;
  }
  getModelForType() {
    return this.typeModel;
  }
}
export class ActivitiesField extends MappingField {
  constructor() {
    super(new TypeDataField5e());
  }
}

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
  const creature = (details: Record<string, DataField>) =>
    new SchemaField({ abilities, attributes: new SchemaField({ hp }), details: new SchemaField(details) });
  const actorSchema = new SchemaField({
    _id: new DocumentIdField({ nullable: true }),
    name: new StringField({ initial: "" }),
    type: new StringField(),
    img: new FilePathField({ nullable: true, initial: null }),
    system: new TypeDataField(),
    prototypeToken: new EmbeddedDataField({
      name: new StringField({ initial: "" }),
      actorLink: new BooleanField({ initial: false })
    }),
    items: new EmbeddedCollectionField(Item),
    effects: new EmbeddedCollectionField(ActiveEffect),
    folder: new ForeignDocumentField(document("Folder"), { nullable: true })
  });
  const itemSchema = new SchemaField({
    name: new StringField({ initial: "" }),
    system: new TypeDataField(),
    effects: new EmbeddedCollectionField(ActiveEffect)
  });
  return {
    Actor: {
      documentClass: { schema: actorSchema, metadata: { baseTypeAllowed: false } },
      dataModels: {
        character: {
          schema: creature({ level: new NumberField({ integer: true, min: 0, initial: 1, persisted: false }) })
        },
        npc: { schema: creature({ cr: new NumberField({ min: 0, nullable: true, initial: 1 }) }) },
        vehicle: { schema: new SchemaField({ attributes: new SchemaField({ hp }) }) },
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
        feat: { schema: new SchemaField({ description: new SchemaField({ value: new HTMLField({ initial: "" }) }) }) },
        spell: { schema: new SchemaField({ level: new NumberField({ integer: true, min: 0, max: 9, initial: 1 }) }) }
      }
    },
    ActiveEffect: {
      documentClass: {
        schema: new SchemaField({ name: new StringField(), system: new TypeDataField() }),
        metadata: { baseTypeAllowed: true }
      },
      dataModels: {
        base: { schema: new SchemaField({}) },
        enchantment: { schema: new SchemaField({ magical: new BooleanField({ initial: true }) }) }
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
        attack: {
          documentClass: {
            schema: new SchemaField({
              type: new StringField({ initial: "attack" }),
              attack: new SchemaField({ bonus: new FormulaField() })
            })
          }
        },
        heal: { documentClass: { schema: new SchemaField({ healing: new SchemaField({}) }) } }
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
