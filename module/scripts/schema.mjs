// @ts-check
// Reads only the public shape of Foundry data fields (common/data/fields.mjs) and dnd5e's (dnd5e module/data/fields):
// the class names, `fields`, `element`, `types`, `type`, `model`, `initialKeys`, `persisted`, and the options a field's
// class declares in `_defaults` and so copies onto the field (`initial`, `nullable`, `choices`, `min`, `max`, `step`,
// `integer`, `positive`, `deterministic`).

/** @typedef {string | string[] | {[key: string]: Tree}} Tree */
/** @typedef {(field: any) => Tree} Describe */

/**
 * By class name, from a field's own class up through the classes it extends: the first name found decides. A string is
 * a leaf kind, a function describes the field itself.
 * @type {Readonly<Record<string, string | Describe>>}
 */
const FIELD_KINDS = Object.freeze({
  // dnd5e stores activities and advancements as maps on the item, but each is a document of its own to get_schema.
  ActivitiesField: () => "collection of Activity",
  AdvancementCollectionField: () => "collection of Advancement",
  // An advancement's configuration and value have one model per advancement type (dnd5e
  // module/data/fields/advancement-data-field.mjs).
  AdvancementDataField: (field) => describeField(field.getModelForType?.()?.schema) ?? "object",
  EmbeddedCollectionField: (field) => `collection of ${field.element?.documentName ?? "documents"}`,
  TypeDataField: () => "system data of the document type",
  TypedSchemaField: (field) => ({ $types: mapValues(field.types, describeField) }),
  SchemaField: (field) => mapValues(field.fields, describeField),
  SetField: (field) => ({ $set: describeElement(field) }),
  ArrayField: (field) => ({ $array: describeElement(field) }),
  TypedObjectField: (field) => {
    const keys = initialKeys(field.initialKeys);
    return { $map: describeElement(field), ...(keys && { $keys: keys }) };
  },
  DocumentUUIDField: (field) => leaf(field.type ? `uuid of ${field.type}` : "uuid", field),
  DocumentIdField: (field) =>
    leaf(field.model?.documentName ? `id of ${field.model.documentName}` : "document id", field),
  FormulaField: "formula",
  IdentifierField: "identifier",
  HTMLField: "html",
  JSONField: "json",
  JavaScriptField: "javascript",
  FilePathField: "file path",
  ColorField: "color",
  StringField: "string",
  NumberField: "number",
  BooleanField: "boolean",
  ObjectField: "object",
  DataField: "any"
});

/** @param {{element: unknown}} field @returns {Tree} */
const describeElement = (field) => describeField(field.element) ?? "any";

/**
 * @param {Record<string, any>} object
 * @param {(value: any) => Tree | undefined} describe
 * @returns {{[key: string]: Tree}} without the entries that describe to undefined
 */
function mapValues(object, describe) {
  return Object.fromEntries(
    Object.entries(object ?? {}).flatMap(([key, value]) => {
      const described = describe(value);
      return described === undefined ? [] : [[key, described]];
    })
  );
}

/** @param {unknown} keys @returns {string[] | null} */
export function initialKeys(keys) {
  if (Array.isArray(keys)) return keys.map(String);
  return keys !== null && typeof keys === "object" ? Object.keys(keys) : null;
}

/** @param {unknown} choices @returns {string[] | null} */
function choiceKeys(choices) {
  let resolved = choices;
  if (typeof resolved === "function") {
    try {
      resolved = resolved();
    } catch {
      return null;
    }
  }
  if (Array.isArray(resolved)) return resolved.map(String);
  return resolved !== null && typeof resolved === "object" ? Object.keys(resolved) : null;
}

/**
 * @param {string} kind
 * @param {Record<string, any>} field
 * @returns {string}
 */
function leaf(kind, field) {
  const parts = [kind === "number" && field.integer === true ? "integer" : kind];
  if (field.deterministic === true) parts.push("deterministic");
  if (typeof field.min === "number") parts.push(`min ${field.min}`);
  if (typeof field.max === "number") parts.push(`max ${field.max}`);
  if (typeof field.step === "number") parts.push(`step ${field.step}`);
  if (field.positive === true) parts.push("positive");
  const choices = choiceKeys(field.choices);
  if (choices) parts.push(`one of ${choices.join("|")}`);
  if (field.nullable === true) parts.push("nullable");
  if (field.initial !== undefined && typeof field.initial !== "function") {
    parts.push(`default ${JSON.stringify(field.initial)}`);
  }
  return parts.join(", ");
}

/** @param {object} field @returns {string[]} the class names from the field's own class up through the classes it extends */
export function classChain(field) {
  const names = [];
  for (let type = field.constructor; typeof type === "function" && type.name; type = Object.getPrototypeOf(type)) {
    names.push(type.name);
  }
  return names;
}

/**
 * A field with `persisted: false` holds a value that is derived and never stored (common/data/fields.mjs:136-140).
 * @param {any} field
 * @returns {Tree | undefined} undefined for a field that is not stored
 */
export function describeField(field) {
  if (field === null || typeof field !== "object" || field.persisted === false) return undefined;
  for (const name of classChain(field)) {
    const kind = FIELD_KINDS[name];
    if (typeof kind === "function") return kind(field);
    if (typeof kind === "string") return leaf(kind, field);
  }
  return leaf("any", field);
}

/**
 * Follows a dot path through a field tree. A `$map` takes any key, an `$array` or `$set` an index.
 * @param {Tree} tree
 * @param {string} path
 * @returns {Tree | undefined}
 */
export function selectPath(tree, path) {
  /** @type {Tree | undefined} */
  let node = tree;
  for (const key of path.split(".")) {
    if (node === undefined || typeof node === "string" || Array.isArray(node)) return undefined;
    if (Object.hasOwn(node, key)) node = node[key];
    else if (Object.hasOwn(node, "$map")) node = node.$map;
    else if (/^\d+$/.test(key)) node = node.$array ?? node.$set;
    else return undefined;
  }
  return node;
}

/** The CONFIG.DND5E tables that hold the legal keys of stored fields (dnd5e module/config.mjs). */
export const CONFIG_TABLES = Object.freeze([
  "abilities",
  "skills",
  "actorSizes",
  "creatureTypes",
  "damageTypes",
  "conditionTypes",
  "languages",
  "movementTypes",
  "senses",
  "armorClasses",
  "activityActivationTypes",
  "limitedUsePeriods",
  "itemProperties",
  "spellSchools",
  "weaponTypes",
  "featureTypes",
  "consumableTypes",
  "toolIds",
  "habitats",
  "currencies"
]);

/**
 * dnd5e labels an entry with a string, or an object's `label` (`name` for conditions), and nests legal keys under
 * `children` (languages) or `subtypes` (feature and consumable types).
 * @param {Record<string, any>} table
 * @returns {Record<string, unknown>}
 */
export function configKeys(table) {
  return Object.fromEntries(
    Object.entries(table).map(([key, entry]) => {
      if (typeof entry === "string") return [key, entry];
      const label = entry?.label ?? entry?.name ?? null;
      for (const nest of ["children", "subtypes"]) {
        if (entry?.[nest] !== null && typeof entry?.[nest] === "object") {
          return [key, { label, [nest]: configKeys(entry[nest]) }];
        }
      }
      return [key, label];
    })
  );
}
