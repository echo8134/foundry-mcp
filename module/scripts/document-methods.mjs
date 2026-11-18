// Reading any document: a list of the documents of one type in the world, in a parent or in a compendium pack, and
// one document in full.

import {
  classOf,
  embeddedFieldsOf,
  folderPathOf,
  hasField,
  hasFolders,
  packOf,
  resolveDocument,
  shortEntry,
  subtypesOf,
  targetOf
} from "./document-access.mjs";
import { withoutSecrets } from "./document-rules.mjs";
import { MethodError } from "./errors.mjs";
import { folderPath, folderScope } from "./folders.mjs";
import { isManaged } from "./scope.mjs";
import { folderRecords, foldersAsRecords, takenBack } from "./world.mjs";
import { kindOf, refuse } from "./write-checks.mjs";

const MAX_LISTED = 200;

/**
 * @typedef {object} Listed one document of a listing, read from the document or from the index entry of its pack
 * @property {string} uuid
 * @property {string} id
 * @property {string | undefined} name
 * @property {string | undefined} type
 * @property {string | null} folderId
 * @property {boolean} managed
 * @property {number} time when a chat message was sent, 0 for anything else
 */

/** @returns {Listed} */
const listedDocument = (document) => ({
  uuid: document.uuid,
  id: document.id,
  name: document.name,
  type: document.type,
  folderId: document.folder?.id ?? null,
  managed: isManaged(document),
  time: document.timestamp ?? 0
});

/**
 * The index of a pack holds a plain object for each document, with the fields asked for, and loads no document
 * (client/documents/collections/compendium-collection.mjs:337-367).
 * @returns {Promise<Listed[]>}
 */
async function listedFromIndex(pack, cls) {
  const fields = ["name", "type", "folder"].filter((name) => hasField(cls, name));
  if (hasField(cls, "flags")) fields.push("flags.foundry-mcp.managed");
  const index = await pack.getIndex({ fields });
  return Array.from(index.values(), (entry) => ({
    uuid: pack.getUuid(entry._id),
    id: entry._id,
    name: entry.name,
    type: entry.type,
    folderId: entry.folder ?? null,
    managed: isManaged(entry),
    time: 0
  }));
}

/** The documents a listing is about, and the folders they can lie in: those of the world, or those of the pack. */
async function listedAt({ cls, parent, pack }) {
  const type = cls.documentName;
  if (parent) {
    return { all: Array.from(parent.getEmbeddedCollection(type).values(), listedDocument), folders: null };
  }
  if (pack) {
    const folders = hasFolders(type) ? foldersAsRecords(pack.folders.values()) : null;
    return { all: await listedFromIndex(pack, cls), folders };
  }
  const folders = hasFolders(type) ? folderRecords(type) : null;
  return { all: Array.from(game.collections.get(type).values(), listedDocument), folders };
}

const byFolderThenName = (a, b) =>
  a.path.join("\0").localeCompare(b.path.join("\0")) || (a.name ?? "").localeCompare(b.name ?? "");

/**
 * The order of a listing and the end of it that is kept when it is longer than the limit. A chat log is read from its
 * end, so its newest messages are the ones kept.
 */
const ORDERS = Object.freeze({
  ChatMessage: { compare: (a, b) => a.time - b.time, keep: (sorted) => sorted.slice(-MAX_LISTED) }
});
const DEFAULT_ORDER = Object.freeze({ compare: byFolderThenName, keep: (sorted) => sorted.slice(0, MAX_LISTED) });

/** The filters of a listing that the documents of the type or of the place have nothing to match with. */
function checkFilters(cls, { folder, name, subtype }, folders, types) {
  const type = cls.documentName;
  if (folder !== undefined && folders === null) {
    throw refuse(
      hasFolders(type)
        ? `folder narrows a listing of the world or of a pack, and embedded documents lie in no folder. Leave folder out.`
        : `${type} documents lie in no folder. Leave folder out.`
    );
  }
  if (name !== undefined && !hasField(cls, "name")) {
    throw refuse(`${type} documents have no name. Leave name out.`);
  }
  if (subtype !== undefined && types === null) {
    throw refuse(`${type} documents have no types. Leave subtype out.`);
  }
  if (subtype !== undefined && !types.includes(subtype)) {
    throw refuse(`Unknown ${type} type "${subtype}". Use one of: ${types.join(", ")}.`);
  }
}

export async function listDocuments(request) {
  const { type, folder, name, subtype } = request;
  const target = await targetOf(request);
  const { cls } = target;
  const types = subtypesOf(cls);
  const { all, folders } = await listedAt(target);
  checkFilters(cls, request, folders, types);
  const scope = folders && folderScope(folders, folder);
  if (folders && !scope) {
    throw new MethodError("not_found", `No ${type} folder at path ${JSON.stringify(folder)}.`);
  }
  const needle = name?.toLocaleLowerCase();
  const order = ORDERS[type] ?? DEFAULT_ORDER;
  const matched = all
    .map((listed) => ({ ...listed, path: (folders && folderPath(folders, listed.folderId)) ?? [] }))
    .filter(
      (listed) =>
        (!scope || scope.inScope(listed.path)) &&
        (subtype === undefined || listed.type === subtype) &&
        (!needle || (listed.name ?? "").toLocaleLowerCase().includes(needle))
    )
    .sort(order.compare);
  const documents = order.keep(matched).map((listed) => ({
    uuid: listed.uuid,
    id: listed.id,
    ...(hasField(cls, "name") && { name: listed.name }),
    ...(types && { type: listed.type }),
    ...(folders && { folder: listed.path }),
    managed: listed.managed
  }));
  return {
    ...(scope && { folders: scope.folders }),
    documents,
    total: matched.length,
    truncated: matched.length > MAX_LISTED,
    // Only these types can lie in a compendium pack (common/constants.mjs:431-442).
    ...(CONST.COMPENDIUM_DOCUMENT_TYPES.includes(type) && {
      packs: game.packs
        .filter((pack) => pack.documentName === type)
        .map((pack) => ({ id: pack.collection, title: pack.title, locked: pack.locked }))
    })
  };
}

/**
 * The stored data of a document in the shape update_documents takes back: without its embedded documents, which are
 * read and written by their own UUIDs, and without what no caller is shown.
 */
function storedForWrite(document) {
  const cls = classOf(document.documentName);
  const embedded = embeddedFieldsOf(cls).map(({ field }) => field);
  // toObject, not structuredClone: measured, the stored data of some documents cannot be structured-cloned.
  const stored = Object.fromEntries(Object.entries(document.toObject()).filter(([key]) => !embedded.includes(key)));
  return takenBack(document, withoutSecrets(document.documentName, stored), kindOf(document.documentName).schemaFor);
}

/**
 * The embedded documents of a document as short lists, by the name of their document type. getEmbeddedCollection
 * answers for a single embedded document too, with a collection of at most that one (common/abstract/document.mjs:828-835,
 * common/data/fields.mjs:3455-3461).
 */
function embeddedLists(document) {
  const lists = {};
  const totals = {};
  for (const name of Object.keys(classOf(document.documentName).metadata.embedded ?? {})) {
    const all = Array.from(document.getEmbeddedCollection(name).values());
    lists[name] = all.slice(0, MAX_LISTED).map(shortEntry);
    if (all.length > MAX_LISTED) totals[name] = all.length;
  }
  return { embedded: lists, ...(Object.keys(totals).length > 0 && { embeddedTotals: totals }) };
}

export async function getDocument({ uuid }) {
  const document = await resolveDocument(uuid);
  const { documentName } = document;
  const pack = packOf(document);
  const { uuid: resolved, ...entry } = shortEntry(document);
  return {
    uuid: resolved,
    documentName,
    ...entry,
    parent: document.parent?.uuid ?? null,
    pack: pack?.collection ?? null,
    ...(pack && { locked: pack.locked }),
    ...(hasFolders(documentName) && !document.parent && { folder: folderPathOf(document) }),
    managed: isManaged(document),
    data: storedForWrite(document),
    ...embeddedLists(document)
  };
}
