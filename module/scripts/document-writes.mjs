// Writing any document: create, update and delete. Each has a plan, which runs every check and reads only, and a
// function that writes the plan and reports from the stored data.

import { diffData, isPlainObject, putAt, updateFor, writeOutcome } from "./data-diff.mjs";
import {
  classOf,
  findDocument,
  hasField,
  packOf,
  refuseLocked,
  resolveDocument,
  shortEntry,
  subtypesOf,
  targetOf,
  unknownType
} from "./document-access.mjs";
import { rulesOf, secretsGiven } from "./document-rules.mjs";
import { byPosition, embeddedFieldsOf, mapGiven } from "./embedded.mjs";
import { MethodError } from "./errors.mjs";
import { documentsWithin, initialTypeOf } from "./field-check.mjs";
import { FLAG_SCOPE, isManaged } from "./scope.mjs";
import {
  changedInStorage,
  checkAsked,
  forWrite,
  kindOf,
  NOT_CREATED,
  planBuilt,
  planUpdate,
  RUN_AGAIN,
  refuse,
  walkOf,
  withoutOwnFlags
} from "./write-checks.mjs";

function refuseUnwritten(documentName, where = "") {
  const { unwritten } = rulesOf(documentName);
  if (unwritten) throw refuse(unwritten, where);
}

function refuseRuled(sentence, where = "") {
  if (sentence) throw refuse(sentence, where);
}

/**
 * What holds for a new document of a name holds for each document given inside the data of another, which is created
 * with it, or written with the field that holds it as the scenes of an adventure are.
 */
function refuseRuledWithin(cls, data, walk, where) {
  for (const { documentName, path, data: within } of documentsWithin(cls.schema, data, walk)) {
    refuseRuled(rulesOf(documentName).create?.(within), `${where}${path}: `);
  }
}

/** The bridge's own flag on a document a create has just made. */
const MANAGED = Object.freeze({ managed: true });

/**
 * get_document returns the bridge's own flag in the data of a bridge-made document, and that data can be given to
 * make a copy. So the flag is taken where it is the one of a bridge-made document, at every path the kind of document
 * has it, on the document and on the embedded documents given with it: a create sets it anyway, and on the prototype
 * token of an actor, where it does not belong, a create sets none.
 */
const withoutMadeFlags = (given, cls) =>
  mapGiven(given, cls, (data, inner) => {
    const kind = kindOf(inner.documentName);
    const made = {};
    for (const path of kind.ownFlags) putAt(made, path, MANAGED);
    return withoutOwnFlags(kind, data, made);
  });

/** Every document a create makes is the bridge's, and so is every embedded document made with it that has flags. */
const asBridgeMade = (asked, cls) =>
  mapGiven(asked, cls, (data, inner) =>
    hasField(inner, "flags")
      ? { ...data, flags: { ...(isPlainObject(data.flags) ? data.flags : {}), [FLAG_SCOPE]: MANAGED } }
      : data
  );

/** The type of a new document: the one given, or the one Foundry fills in. Undefined for a class without types. */
function typeOfNew(cls, asked, where) {
  const types = subtypesOf(cls);
  if (types === null) return undefined;
  const name = cls.documentName;
  const type = asked.type ?? initialTypeOf(cls.schema);
  if (type === undefined) {
    throw refuse(
      `A new ${name} needs a type, one of ${types.join(", ")}. get_schema with document ${name} lists the fields of each.`,
      where
    );
  }
  if (!types.includes(type)) throw refuse(unknownType(`${name} type`, type, types), where);
  return type;
}

/** Every check of one new document, and the data to create it from. Reads only. */
async function planCreation({ cls, parent, pack }, given, where) {
  const name = cls.documentName;
  const kind = kindOf(name);
  const asked = withoutMadeFlags(given, cls);
  const type = typeOfNew(cls, asked, where);
  refuseRuled(rulesOf(name).create?.(asked), where);
  refuseRuledWithin(cls, asked, walkOf(type, true), where);
  checkAsked(kind, asked, { type, where, embedded: true });
  const data = asBridgeMade(asked, cls);
  const { write } = await planBuilt(kind, cls, data, asked, { parent, pack: pack?.collection ?? null, where });
  return { data, write: { ...write, unseen: secretsGiven(name, write.wanted) } };
}

/** Every check of a create, and for each new document the data to create it from. Reads only. */
export async function planCreations(request) {
  const target = await forWrite(targetOf(request));
  if (target.parent) refuseLocked(packOf(target.parent), `${request.parent} lies`);
  else refuseLocked(target.pack, "The new documents would lie");
  refuseUnwritten(request.type);
  const plans = [];
  for (const [index, given] of request.documents.entries()) {
    plans.push(await planCreation(target, given, `documents[${index}]: `));
  }
  return { target, plans };
}

export async function createDocuments({ target, plans }) {
  const { cls, parent, pack } = target;
  const documents = [];
  for (const [index, { data, write }] of plans.entries()) {
    let created;
    try {
      // One at a time, so that a failure can name the documents made before it.
      created = await cls.create(structuredClone(data), { parent, pack: pack?.collection ?? null });
    } catch (error) {
      const made = documents.flatMap((one) => one.uuid ?? []);
      const before =
        made.length > 0
          ? `Created before it, and left in place: ${made.join(", ")}.`
          : "No document was created before it.";
      throw new MethodError(
        "foundry_error",
        `documents[${index}]: Foundry failed while creating the ${cls.documentName} (${error.message}). ${before} The entries after it were not tried. list_documents shows what exists now.`
      );
    }
    // Foundry skips a document that fails its validation or that a hook refuses, and resolves without it
    // (client/data/client-backend.mjs:91-108).
    if (!created) {
      documents.push({ ...(typeof data.name === "string" && { name: data.name }), error: NOT_CREATED });
      continue;
    }
    const { unapplied } = writeOutcome(write, {}, byPosition(created.toObject(), cls));
    documents.push({ ...shortEntry(created), unapplied });
  }
  return {
    requested: plans.length,
    created: documents.filter((one) => one.uuid !== undefined).length,
    documents
  };
}

/** Every check of a change to one document, and what the change is to bring about. Reads only. */
async function planChange({ uuid, data: given = {}, remove = [] }, where) {
  const document = await forWrite(resolveDocument(uuid, where));
  const name = document.documentName;
  refuseUnwritten(name, where);
  refuseLocked(packOf(document), `${uuid} lies`, where);
  const cls = classOf(name);
  const kind = kindOf(name);
  const embedded = embeddedFieldsOf(cls)
    .map(({ field }) => field)
    .filter((field) => given[field] !== undefined);
  if (embedded.length > 0) {
    throw refuse(
      `${embedded.join(" and ")} cannot be given: it holds the embedded documents of the ${name}, which each have a UUID of their own. Change one with this tool by its UUID, create one with create_documents and ${uuid} as parent, and delete one with delete_documents.`,
      where
    );
  }
  if (given._id !== undefined && given._id !== document.id) {
    throw refuse(`_id: Foundry cannot change the id of a document, which is ${document.id}. Leave _id out.`, where);
  }
  if (subtypesOf(cls) && given.type !== undefined && given.type !== document.type) {
    throw refuse(
      `${uuid} is of the type ${document.type}, and Foundry cannot change the type of a document. Leave type out, or create another ${name}.`,
      where
    );
  }
  // get_document returns the id in the stored data, which can be passed back: the same id is no part of the change.
  const { _id: _same, ...rest } = given;
  const asked = withoutOwnFlags(kind, rest, document._source);
  refuseRuled(rulesOf(name).update?.(document, asked, remove), where);
  const write = await planUpdate(kind, document, asked, { remove, where });
  // Asked of what the update writes: a field given as it is stored is no part of it.
  const { changes } = diffData(write.wanted, document._source, write.same);
  refuseRuledWithin(cls, changes, walkOf(document.type), where);
  return { document, write: { ...write, unseen: secretsGiven(name, write.wanted) } };
}

/** Every check of an update, and what each entry is to bring about. Reads only. */
export async function planChanges({ documents: entries }) {
  const plans = [];
  for (const [index, entry] of entries.entries()) plans.push(await planChange(entry, `documents[${index}]: `));
  const places = new Map();
  for (const [index, { document }] of plans.entries()) {
    const first = places.get(document.uuid);
    if (first !== undefined) {
      throw refuse(
        `documents[${first}] and documents[${index}] are the same document, ${document.uuid}. Give it once, with all its changes.`
      );
    }
    places.set(document.uuid, index);
  }
  return plans;
}

/**
 * What was written when an update threw, from the stored data: Foundry may have applied a part of it. `stored` says
 * of each entry before the one that threw whether Foundry took its update. A value that is never handed back, such as
 * a password, is named with the entry that wrote it, and of the entry that threw nothing tells whether it was written.
 */
function describeWritten(plans, before, stored) {
  const written = plans.flatMap(({ document, write }, index) => {
    const { changed } = writeOutcome(write, before[index], document._source, stored[index] ?? false);
    const unknown =
      index === stored.length
        ? write.unseen.map((path) => `${path}, which cannot be read back and may have been written`)
        : [];
    const all = [...changed, ...unknown];
    return all.length > 0 ? [`${document.uuid} (${all.join(", ")})`] : [];
  });
  return changedInStorage(written);
}

export async function updateDocuments(plans) {
  // toObject, not structuredClone: measured, the stored data of some documents cannot be structured-cloned.
  const before = plans.map(({ document }) => document.toObject());
  const stored = [];
  const documents = [];
  for (const [index, { document, write }] of plans.entries()) {
    const { update, writes } = updateFor(write, document._source, _del);
    try {
      // An update resolves without the document when a hook refuses it (client/data/client-backend.mjs:237-241).
      stored.push(writes && (await document.update(update)) !== undefined);
    } catch (error) {
      throw new MethodError(
        "foundry_error",
        `documents[${index}]: Foundry failed while updating ${document.uuid} (${error.message}). ${describeWritten(plans, before, stored)} ${RUN_AGAIN}`
      );
    }
    documents.push({ uuid: document.uuid, ...writeOutcome(write, before[index], document._source, stored[index]) });
  }
  return { documents };
}

const labelOf = (document) =>
  typeof document.name === "string" ? `${document.name} (${document.uuid})` : document.uuid;

/** Whether a document lies inside another of the call, which takes it along when it is deleted. */
function hasAncestorIn(document, uuids) {
  for (let parent = document.parent ?? null; parent; parent = parent.parent ?? null) {
    if (uuids.has(parent.uuid)) return true;
  }
  return false;
}

/** Every check of a deletion, and the documents it deletes. Reads only. */
export async function planDeletion({ uuids, handMade }) {
  const found = new Map();
  for (const uuid of new Set(uuids)) {
    const document = await findDocument(uuid);
    if (document) found.set(document.uuid, document);
  }
  const asked = new Set(found.keys());
  const documents = [...found.values()].filter((document) => !hasAncestorIn(document, asked));
  for (const document of documents) {
    refuseUnwritten(document.documentName);
    refuseLocked(packOf(document), `${document.uuid} lies`);
  }
  const going = (other) => asked.has(other.uuid) || hasAncestorIn(other, asked);
  refuseRuled(
    documents.flatMap((document) => rulesOf(document.documentName).remove?.(document, going) ?? []).join(" ")
  );
  const foreign = documents.filter((document) => !isManaged(document));
  if (foreign.length > 0 && handMade !== true) {
    throw refuse(
      `These documents were not made by this bridge: ${foreign.map(labelOf).join(", ")}. Foundry cannot bring a deleted document back. Pass handMade: true to delete them as well.`
    );
  }
  return documents;
}

/**
 * Foundry deletes the documents of one class in one parent or pack with one call (common/abstract/document.mjs:696-701).
 * The groups come in the order of the request, but for those a rule puts last: an actor goes after its tokens.
 */
function deletionGroups(documents) {
  const groups = new Map();
  for (const document of documents) {
    const parent = document.parent ?? null;
    const pack = document.pack ?? null;
    const key = JSON.stringify([document.documentName, parent?.uuid ?? null, pack]);
    if (!groups.has(key)) groups.set(key, { cls: classOf(document.documentName), parent, pack, documents: [] });
    groups.get(key).documents.push(document);
  }
  const isLast = ({ cls }) => rulesOf(cls.documentName).last === true;
  return [...groups.values()].sort((a, b) => Number(isLast(a)) - Number(isLast(b)));
}

export async function deleteDocuments(planned) {
  const deleted = [];
  for (const { cls, parent, pack, documents } of deletionGroups(planned)) {
    // Asked again at its turn, when nothing of the call is still to go: a token whose deletion a hook refused keeps
    // its actor.
    const due = documents.filter((document) => !rulesOf(cls.documentName).remove?.(document, () => false));
    if (due.length === 0) continue;
    const entries = new Map(
      due.map((document) => [
        document.id,
        { uuid: document.uuid, ...(typeof document.name === "string" && { name: document.name }) }
      ])
    );
    let gone;
    try {
      // Foundry skips a document whose deletion a hook refuses, and resolves with the rest
      // (client/data/client-backend.mjs:404-409).
      gone = await cls.deleteDocuments([...entries.keys()], { parent, pack });
    } catch (error) {
      const before =
        deleted.length > 0
          ? `Deleted before that: ${deleted.map((one) => one.uuid).join(", ")}.`
          : "Nothing was deleted before that.";
      throw new MethodError(
        "foundry_error",
        `Foundry failed while deleting ${[...entries.values()].map((one) => one.uuid).join(", ")} (${error.message}). ${before} list_documents shows what exists now.`
      );
    }
    deleted.push(...gone.flatMap((document) => entries.get(document.id) ?? []));
  }
  return { deleted: deleted.length, documents: deleted };
}
