// What the generic document tools know of any document: its class and what the class says of it, how a UUID leads to
// it, where a new one may go, and which compendium lock stands in the way of a write.

import { systemTypes } from "./actor-methods.mjs";
import { isPlainObject } from "./data-diff.mjs";
import { DOCUMENT_TYPES } from "./document-types.mjs";
import { MethodError } from "./errors.mjs";
import { classChain } from "./schema.mjs";
import { refuse } from "./write-checks.mjs";

/**
 * @typedef {object} Target where a listing reads and where a create writes
 * @property {any} cls the document class
 * @property {any} parent the document the new ones are embedded in, null for a primary document
 * @property {any} pack the compendium pack the new ones go into, null for the world. A parent names its own pack.
 */

export function classOf(type) {
  const cls = CONFIG[type]?.documentClass;
  if (cls) return cls;
  throw new MethodError(
    "invalid_params",
    `This Foundry has no document class for ${type}. Its version may not have that document type.`
  );
}

const fieldsOf = (cls) => cls.schema.fields;

export const hasField = (cls, name) => Object.hasOwn(fieldsOf(cls), name);

/**
 * The subtypes of a document class, or null for a class without them. A class has subtypes when its `type` is a
 * DocumentTypeField, whose choices are the types of the class (common/data/fields.mjs:4285-4295): an actor's npc, a
 * journal page's text, a folder's Actor. An ActorDelta's type is a plain string (common/documents/actor-delta.mjs:48).
 * @returns {string[] | null}
 */
export function subtypesOf(cls) {
  const field = fieldsOf(cls).type;
  if (field === null || typeof field !== "object" || !classChain(field).includes("DocumentTypeField")) return null;
  return systemTypes(cls.documentName);
}

/** The type Foundry gives a new document that names none: the initial value of its type field, where it has one. */
export function initialTypeOf(cls) {
  const { initial } = fieldsOf(cls).type;
  return typeof initial === "string" ? initial : undefined;
}

/** Folders hold documents of these types (common/constants.mjs:542-543), in the world and inside a compendium pack. */
export const hasFolders = (type) => CONST.FOLDER_DOCUMENT_TYPES.includes(type);

/**
 * The embedded documents of a class, each with the field that stores them and the class of its documents: Foundry's
 * Document.hierarchy (common/abstract/document.mjs:259-266), whose fields name that class as `model`
 * (common/data/fields.mjs:3033-3035). A token's own actor data is one such document and no collection
 * (common/documents/token.mjs:64).
 * @returns {{field: string, cls: any}[]}
 */
export const embeddedFieldsOf = (cls) =>
  Object.entries(cls.hierarchy).map(([field, { model }]) => ({ field, cls: model }));

/** The document names a class embeds, as its metadata lists them (common/abstract/document.mjs:131). */
const embeddedNamesOf = (cls) => Object.keys(cls.metadata.embedded ?? {});

/** The document types whose documents hold documents of the given type. */
const holdersOf = (type) =>
  DOCUMENT_TYPES.filter((name) => {
    const cls = CONFIG[name]?.documentClass;
    return cls !== undefined && embeddedNamesOf(cls).includes(type);
  });

/**
 * Applies `change` to the data of a document, and to the data of each embedded document given inside it, down through
 * their own embedded documents. `path` names where the data lies, and ends in a dot below the top.
 * @param {Record<string, any>} data
 * @param {any} cls
 * @param {(data: Record<string, any>, cls: any, path: string) => Record<string, any>} change gets a shallow copy
 * @returns {Record<string, any>}
 */
export function mapGiven(data, cls, change, path = "") {
  const changed = change({ ...data }, cls, path);
  for (const { field, cls: inner } of embeddedFieldsOf(cls)) {
    const given = changed[field];
    if (Array.isArray(given)) {
      changed[field] = given.map((child, index) =>
        isPlainObject(child) ? mapGiven(child, inner, change, `${path}${field}.${index}.`) : child
      );
    } else if (isPlainObject(given)) {
      changed[field] = mapGiven(given, inner, change, `${path}${field}.`);
    }
  }
  return changed;
}

/**
 * Document data with each embedded collection as an object keyed by position, down through the embedded documents'
 * own collections. The comparisons of data-diff.mjs take a list as one value, and so would call a created page changed
 * for the id Foundry gave it. Keyed by position, an embedded document is compared field by field with the one given in
 * its place.
 * @param {unknown} data
 * @param {any} cls
 * @returns {any}
 */
export function byPosition(data, cls) {
  if (!isPlainObject(data)) return data;
  const keyed = { ...data };
  for (const { field, cls: inner } of embeddedFieldsOf(cls)) {
    const value = keyed[field];
    if (Array.isArray(value)) {
      keyed[field] = Object.fromEntries(value.map((child, index) => [index, byPosition(child, inner)]));
    } else if (isPlainObject(value)) {
      keyed[field] = byPosition(value, inner);
    }
  }
  return keyed;
}

/** fromUuid loads a compendium document, and resolves null where nothing is (client/utils/helpers.mjs:172-183). */
async function fromUuid(uuid) {
  try {
    return (await foundry.utils.fromUuid(uuid)) ?? null;
  } catch {
    return null;
  }
}

/** The document at a UUID, or null: for a deletion, which ignores what is not there. */
export const findDocument = fromUuid;

/**
 * @param {string} uuid
 * @param {{where?: string, write?: boolean}} [options] `where` names the entry of the request, and `write` says that
 *   the call is one that writes, which a refusal ends before anything is written
 */
export async function resolveDocument(uuid, { where = "", write = false } = {}) {
  const document = await fromUuid(uuid);
  if (document) return document;
  throw new MethodError(
    "not_found",
    `${where}Nothing exists at the UUID ${uuid}.${write ? " Nothing was written." : ""} list_documents returns the UUIDs of the documents of a type.`
  );
}

/** The compendium pack a document lies in, its own or its parent's, or null for a world document. */
export const packOf = (document) => (document.pack ? game.packs.get(document.pack) : null);

/**
 * Foundry writes nothing into a locked pack (common/abstract/backend.mjs:260-283). A pack of a system or a module is
 * locked until the Gamemaster unlocks it, and a world pack is not (client/documents/collections/compendium-collection.mjs:227-229).
 */
export function refuseLocked(pack, what, where = "") {
  if (!pack?.locked) return;
  throw refuse(
    `${what} in the compendium pack ${pack.collection} (${pack.title}), which is locked. The Gamemaster unlocks a pack in Foundry: right-click it in the Compendium Packs tab, Toggle Edit Lock.`,
    where
  );
}

function findPack(id, type) {
  const pack = game.packs.get(id);
  if (pack) return pack;
  const known = game.packs.filter((one) => one.documentName === type).map((one) => one.collection);
  throw new MethodError(
    "not_found",
    `No compendium pack with the id ${id}. ${known.length > 0 ? `The packs of ${type} documents: ${known.join(", ")}.` : `This world has no pack of ${type} documents.`}`
  );
}

/** Where documents of a type can be, said as what to pass. */
function placesOf(type) {
  const holders = holdersOf(type);
  const places = [];
  if (holders.length > 0) places.push(`parent: the UUID of the ${holders.join(" or ")} that holds them`);
  if (CONST.COMPENDIUM_DOCUMENT_TYPES.includes(type)) places.push("pack: the id of a compendium pack of them");
  return places.join(", or ");
}

/**
 * Where a listing reads or a create writes, from the type, parent and pack of a request. Owns every refusal about the
 * place: a parent that holds no such documents, a pack of another type, a type the world itself has none of, and for a
 * write a locked pack.
 * @param {{type: string, parent?: string, pack?: string}} request
 * @param {{write?: boolean}} [options]
 * @returns {Promise<Target>}
 */
export async function targetOf({ type, parent: parentUuid, pack: packId }, { write = false } = {}) {
  const cls = classOf(type);
  if (parentUuid !== undefined && packId !== undefined) {
    throw refuse(
      "Give parent or pack, not both. A parent that lies in a compendium pack names that pack in its own UUID."
    );
  }
  if (parentUuid !== undefined) {
    const parent = await resolveDocument(parentUuid, { write });
    const held = embeddedNamesOf(classOf(parent.documentName));
    if (!held.includes(type)) {
      const holds = held.length > 0 ? `It holds: ${held.join(", ")}.` : "It holds no embedded documents.";
      const instead = placesOf(type);
      throw refuse(
        `${parentUuid} is a ${parent.documentName}, which holds no ${type} documents. ${holds}${instead ? ` For ${type} pass ${instead}.` : ""}`
      );
    }
    if (write) refuseLocked(packOf(parent), `${parentUuid} lies`);
    return { cls, parent, pack: null };
  }
  if (packId !== undefined) {
    const pack = findPack(packId, type);
    if (pack.documentName !== type) {
      throw refuse(
        `The pack ${packId} holds ${pack.documentName} documents, not ${type}. Pass type ${pack.documentName}, or for a document inside one of them its UUID as parent.`
      );
    }
    if (write) refuseLocked(pack, "The new documents would lie");
    return { cls, parent: null, pack };
  }
  if (!CONST.WORLD_DOCUMENT_TYPES.includes(type)) {
    throw refuse(`A world has no ${type} documents of its own. Pass ${placesOf(type)}.`);
  }
  return { cls, parent: null, pack: null };
}

const MAX_FOLDER_DEPTH = 32;

/** The folder path of a document from the folders it lies in, in the world or in its pack. */
export function folderPathOf(document) {
  const names = [];
  for (
    let folder = document.folder ?? null;
    folder && names.length < MAX_FOLDER_DEPTH;
    folder = folder.folder ?? null
  ) {
    names.unshift(folder.name);
  }
  return names;
}

/** What a list says of one document: enough to tell it from the others and to read it with get_document. */
export function shortEntry(document) {
  const cls = classOf(document.documentName);
  return {
    uuid: document.uuid,
    id: document.id,
    ...(hasField(cls, "name") && { name: document.name }),
    ...(subtypesOf(cls) && { type: document.type })
  };
}
