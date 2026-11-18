// What the generic document tools know of any document: its class and what the class says of it, how a UUID leads to
// it, where a new one may go, and which compendium lock stands in the way of a write.

import { DOCUMENT_TYPES } from "./document-types.mjs";
import { embeddedNamesOf } from "./embedded.mjs";
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

/** Core lists "base" (CONST.BASE_DOCUMENT_TYPE) for every typed document; only some may be created with it (common/abstract/document.mjs:462). */
export function systemTypes(documentName) {
  const { baseTypeAllowed } = CONFIG[documentName].documentClass.metadata;
  return game.documentTypes[documentName].filter((type) => type !== "base" || baseTypeAllowed === true);
}

/** What every tool says of a type that is none of the document's, or of a table that is none of the system's. */
export const unknownType = (noun, type, types) =>
  `Unknown ${noun} ${JSON.stringify(type)}. Use one of: ${types.join(", ")}.`;

export function checkType(types, type, noun) {
  if (!types.includes(type)) throw new MethodError("invalid_params", unknownType(noun, type, types));
}

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

/** Folders hold documents of these types (common/constants.mjs:542-543), in the world and inside a compendium pack. */
export const hasFolders = (type) => CONST.FOLDER_DOCUMENT_TYPES.includes(type);

/** The document types whose documents hold documents of the given type. */
const holdersOf = (type) =>
  DOCUMENT_TYPES.filter((name) => {
    const cls = CONFIG[name]?.documentClass;
    return cls !== undefined && embeddedNamesOf(cls).includes(type);
  });

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

/** @param {string} uuid @param {string} [where] the entry of the request the UUID is given in */
export async function resolveDocument(uuid, where = "") {
  const document = await fromUuid(uuid);
  if (document) return document;
  throw new MethodError(
    "not_found",
    `${where}Nothing exists at the UUID ${uuid}. list_documents returns the UUIDs of the documents of a type.`
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
 * Where a listing reads or a create writes, from the type, parent and pack of a request. Says what to pass instead
 * for a place that holds no such documents: a parent of another kind, a pack of another type, a type the world itself
 * has none of. Reads only, and knows of no lock: a write checks that itself.
 * @param {{type: string, parent?: string, pack?: string}} request
 * @returns {Promise<Target>}
 */
export async function targetOf({ type, parent: parentUuid, pack: packId }) {
  const cls = classOf(type);
  const noPlace = (message) => new MethodError("invalid_params", message);
  if (parentUuid !== undefined && packId !== undefined) {
    throw noPlace(
      "Give parent or pack, not both. A parent that lies in a compendium pack names that pack in its own UUID."
    );
  }
  if (parentUuid !== undefined) {
    const parent = await resolveDocument(parentUuid);
    const held = embeddedNamesOf(classOf(parent.documentName));
    if (!held.includes(type)) {
      const holds = held.length > 0 ? `It holds: ${held.join(", ")}.` : "It holds no embedded documents.";
      const instead = placesOf(type);
      throw noPlace(
        `${parentUuid} is a ${parent.documentName}, which holds no ${type} documents. ${holds}${instead ? ` For ${type} pass ${instead}.` : ""}`
      );
    }
    return { cls, parent, pack: null };
  }
  if (packId !== undefined) {
    const pack = findPack(packId, type);
    if (pack.documentName !== type) {
      throw noPlace(
        `The pack ${packId} holds ${pack.documentName} documents, not ${type}. Pass type ${pack.documentName}, or for a document inside one of them its UUID as parent.`
      );
    }
    return { cls, parent: null, pack };
  }
  if (!CONST.WORLD_DOCUMENT_TYPES.includes(type)) {
    throw noPlace(`A world has no ${type} documents of its own. Pass ${placesOf(type)}.`);
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
