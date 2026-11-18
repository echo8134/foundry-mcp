// @ts-check
// What an item entry of ensure_actor gives, brought into the shape dnd5e stores. dnd5e keeps an item's activities and
// advancements as maps from id to entry, and each entry repeats its id as `_id` and names its `type` (dnd5e
// module/data/fields/activities-field.mjs:58-65, advancement-collection-field.mjs:36-43: both collections are keyed by
// `_id`). A caller may write a label in place of an id, and leaves out what an entry that exists already says.

import { isPlainObject } from "./data-diff.mjs";
import { isReservedKey } from "./field-check.mjs";
import { idFor } from "./labels.mjs";

/** @typedef {{key: string, noun: string, document: string}} TypedMap */

/**
 * The maps of an item's system data that hold typed entries by id, each with the name get_schema knows its entries by.
 * @type {readonly TypedMap[]}
 */
export const TYPED_MAPS = Object.freeze([
  { key: "activities", noun: "activity", document: "Activity" },
  { key: "advancement", noun: "advancement", document: "Advancement" }
]);

/**
 * The data model of an entry below a dnd5e TypeDataField5e, for the schema check, by the class of the field. An
 * advancement's configuration and value take the model of their advancement type whatever the entry says, and any
 * other entry the model of its own type, or of the behavior it is the config of (dnd5e
 * module/data/fields/type-data-field.mjs:37-39, advancement-data-field.mjs:17-19).
 * @type {Readonly<Record<string, import("./field-check.mjs").SchemaFor>>}
 */
export const TYPED_ENTRY_SCHEMAS = Object.freeze({
  AdvancementDataField: (_entry, field) => field.getModelForType?.()?.schema,
  TypeDataField5e: (entry, field, heldType) =>
    field.getModelForType?.(heldType ?? (isPlainObject(entry) ? entry.type : undefined))?.schema
});

/** @param {unknown} reference @returns {unknown} an activity's reference to an effect of its item, with a label as its id */
const withEffectId = (reference) =>
  isPlainObject(reference) && typeof reference._id === "string"
    ? { ...reference, _id: idFor(reference._id) }
    : reference;

/**
 * @param {TypedMap} map
 * @param {string} label the key the caller gave
 * @param {Record<string, unknown>} entry
 * @param {unknown} storedType the type of the stored entry of that id, undefined for a new entry
 * @param {readonly string[]} types the entry types of the map
 * @returns {string | null} why the entry cannot have the type it gives, or null
 */
function typeProblem({ key, noun, document }, label, entry, storedType, types) {
  const path = `system.${key}.${label}`;
  if (storedType !== undefined) {
    return entry.type === undefined || entry.type === storedType
      ? null
      : `${path}: this ${noun} is of the type ${storedType}, and keeps it. Leave type out, or remove the entry (remove: ["${path}"]) and give the new one under another key.`;
  }
  return typeof entry.type === "string" && types.includes(entry.type)
    ? null
    : `${path}: a new ${noun} needs a type, one of ${types.join(", ")}. get_schema with document ${document} lists the fields of each.`;
}

/**
 * Brings the typed entries of given item data into the stored shape: a key that is no document id is a label and
 * becomes the id of that label, each entry gets its id as `_id` and the type of the stored entry it changes, and an
 * activity's references to effects of its item take labels the same way. A key Foundry would not store as it is stays,
 * for the schema check to refuse.
 * @param {Record<string, any>} given the given data of an item
 * @param {Record<string, any>} stored the stored data of the item, or the data a new item starts from
 * @param {Readonly<Record<string, readonly string[]>>} types the entry types of each map, by the map's key
 * @returns {{data: Record<string, any>, problems: string[]}} the data in the stored shape, and why it cannot be written
 */
export function asStoredEntries(given, stored, types) {
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(given.system)) return { data: given, problems };
  const system = { ...given.system };
  for (const map of TYPED_MAPS) {
    const entries = system[map.key];
    if (!isPlainObject(entries)) continue;
    /** @type {Record<string, unknown>} */
    const byId = {};
    for (const [label, entry] of Object.entries(entries)) {
      const id = isReservedKey(label) ? label : idFor(label);
      const path = `system.${map.key}.${label}`;
      if (Object.hasOwn(byId, id)) {
        problems.push(`${path} names the ${map.noun} ${id}, which another key of this entry names too.`);
      } else if (!isPlainObject(entry)) {
        byId[id] = entry;
      } else {
        if (entry._id !== undefined && entry._id !== id && entry._id !== label) {
          problems.push(`${path}: its _id ${JSON.stringify(entry._id)} is not its key. Leave _id out.`);
        }
        const storedType = stored.system?.[map.key]?.[id]?.type;
        const problem = typeProblem(map, label, entry, storedType, types[map.key] ?? []);
        if (problem) problems.push(problem);
        byId[id] = {
          ...entry,
          _id: id,
          ...(storedType !== undefined && { type: storedType }),
          ...(Array.isArray(entry.effects) && { effects: entry.effects.map(withEffectId) })
        };
      }
    }
    system[map.key] = byId;
  }
  return { data: { ...given, system }, problems };
}

/**
 * @param {string} path a dot path of an entry to remove, in which the key of a typed entry may be a label
 * @returns {string} the path with the id in place of the label
 */
export function withEntryId(path) {
  const [root, key, label, ...rest] = path.split(".");
  if (root !== "system" || label === undefined || isReservedKey(label)) return path;
  if (!TYPED_MAPS.some((map) => map.key === key)) return path;
  return [root, key, idFor(label), ...rest].join(".");
}
