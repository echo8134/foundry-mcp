// Writing any document: create, update and delete. Each plans first, which runs every check and reads only, and then
// writes the plan. A plan is made once before the call waits for its turn, to refuse a bad request at once, and again
// when its turn comes: a write queued before it may have changed what the plan was made on.

import { isPlainObject, pickData, updateFor, writeOutcome } from "./data-diff.mjs";
import {
  byPosition,
  classOf,
  embeddedFieldsOf,
  findDocument,
  hasField,
  initialTypeOf,
  mapGiven,
  packOf,
  refuseLocked,
  resolveDocument,
  shortEntry,
  subtypesOf,
  targetOf
} from "./document-access.mjs";
import { rulesOf, secretsGiven, withoutSecrets } from "./document-rules.mjs";
import { MethodError } from "./errors.mjs";
import { withoutStoredFlag } from "./item-data.mjs";
import { FLAG_SCOPE, isManaged } from "./scope.mjs";
import {
  checkAsked,
  checkImage,
  checkKeptAsGiven,
  checkRemoval,
  embeddedSchemas,
  kindOf,
  modelRefusal,
  refuse,
  wantedChanges,
  writeOf
} from "./write-checks.mjs";

const NOT_CREATED =
  "foundry_error: Foundry created nothing for this entry and reported no error, which is what it does when the system or a module refuses a creation.";

function refuseUnwritten(documentName, where = "") {
  const { unwritten } = rulesOf(documentName);
  if (unwritten) throw refuse(unwritten, where);
}

function refuseRuled(sentence, where = "") {
  if (sentence) throw refuse(sentence, where);
}

/** The flags of a document a create has just made. */
const AS_CREATED = Object.freeze({ flags: { [FLAG_SCOPE]: { managed: true } } });

/**
 * get_document returns the bridge's own flag in the data of a bridge-made document, and that data can be given to
 * make a copy. So the flag is taken where it says what a create sets anyway, on the document and on the embedded
 * documents given with it, and any other value of it is refused.
 */
const withoutOwnFlags = (given, cls, where) =>
  mapGiven(given, cls, (data, _inner, path) => {
    const kept = withoutStoredFlag(data, AS_CREATED);
    if (isPlainObject(kept.flags) && Object.hasOwn(kept.flags, FLAG_SCOPE)) {
      throw refuse(
        `${path}flags.${FLAG_SCOPE} cannot be given: it is the bridge's own flag, which only the bridge sets.`,
        where
      );
    }
    return kept;
  });

/** Every document a create makes is the bridge's, and so is every embedded document made with it that has flags. */
const asBridgeMade = (asked, cls) =>
  mapGiven(asked, cls, (data, inner) =>
    hasField(inner, "flags")
      ? { ...data, flags: { ...(isPlainObject(data.flags) ? data.flags : {}), ...AS_CREATED.flags } }
      : data
  );

/** The type of a new document: the one given, or the one Foundry fills in. Undefined for a class without types. */
function typeOfNew(cls, asked, where) {
  const types = subtypesOf(cls);
  if (types === null) return undefined;
  const name = cls.documentName;
  const type = asked.type ?? initialTypeOf(cls);
  if (type === undefined) {
    throw refuse(
      `A new ${name} needs a type, one of ${types.join(", ")}. get_schema with document ${name} lists the fields of each.`,
      where
    );
  }
  if (!types.includes(type)) {
    throw refuse(`Unknown ${name} type ${JSON.stringify(type)}. Use one of: ${types.join(", ")}.`, where);
  }
  return type;
}

/** Every check of one new document, and the data to create it from. Reads only. */
async function planCreation({ cls, parent, pack }, given, where) {
  const name = cls.documentName;
  const kind = kindOf(name);
  const asked = withoutOwnFlags(given, cls, where);
  const type = typeOfNew(cls, asked, where);
  refuseRuled(rulesOf(name).create?.(asked), where);
  checkAsked(kind, asked, [], type, where, embeddedSchemas);
  const data = asBridgeMade(asked, cls);
  let built;
  try {
    // Built with its parent and pack, as Foundry builds a document before it creates it
    // (client/data/client-backend.mjs:91-94). The constructor keeps the object it is given and cleans it in place.
    built = new cls(structuredClone(data), { parent, pack: pack?.collection ?? null });
  } catch (error) {
    throw modelRefusal(kind, error, where);
  }
  const shape = byPosition(asked, cls);
  const wanted = pickData(byPosition(built.toObject(), cls), shape);
  checkKeptAsGiven(shape, wanted, where);
  await checkImage(wanted.img, where);
  return { data, write: writeOf(kind, withoutSecrets(name, wanted), [], type, asked, embeddedSchemas) };
}

async function planCreations(request) {
  const target = await targetOf(request, { write: true });
  refuseUnwritten(request.type);
  const plans = [];
  for (const [index, given] of request.documents.entries()) {
    plans.push(await planCreation(target, given, `documents[${index}]: `));
  }
  return { target, plans };
}

export async function prepareCreation(request) {
  await planCreations(request);
  return request;
}

export async function createDocuments(request) {
  const { target, plans } = await planCreations(request);
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
  const document = await resolveDocument(uuid, { where, write: true });
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
  const asked = withoutStoredFlag(given, document._source);
  refuseRuled(rulesOf(name).update?.(document, asked, remove), where);
  checkAsked(kind, asked, remove, document.type, where);
  const wanted = wantedChanges(kind, document, asked, where);
  checkKeptAsGiven(asked, wanted, where);
  if (wanted.img !== document._source.img) await checkImage(wanted.img, where);
  checkRemoval(kind, document, remove, where);
  return {
    document,
    write: writeOf(kind, wanted, remove, document.type),
    // What the stored data shows of the write. A secret is written and never handed back, so it shows nothing.
    shown: writeOf(kind, withoutSecrets(name, wanted), remove, document.type),
    secrets: secretsGiven(name, wanted)
  };
}

async function planChanges({ documents: entries }) {
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

export async function prepareChanges(request) {
  await planChanges(request);
  return request;
}

/** What the stored data shows after a write that threw: Foundry may have applied a part of it. */
function describeWritten(plans, before) {
  const written = plans.flatMap(({ document, shown }, index) => {
    const { changed } = writeOutcome(shown, before[index], document._source);
    return changed.length > 0 ? [`${document.uuid} (${changed.join(", ")})`] : [];
  });
  return written.length > 0
    ? `Changed in the stored data: ${written.join("; ")}.`
    : "Nothing was changed in the stored data.";
}

export async function updateDocuments(request) {
  const plans = await planChanges(request);
  // toObject, not structuredClone: measured, the stored data of some documents cannot be structured-cloned.
  const before = plans.map(({ document }) => document.toObject());
  const documents = [];
  for (const [index, { document, write, shown, secrets }] of plans.entries()) {
    const { update, writes } = updateFor(write, document._source, _del);
    let stored = false;
    if (writes) {
      try {
        // An update resolves without the document when a hook refuses it (client/data/client-backend.mjs:237-241).
        stored = (await document.update(update)) !== undefined;
      } catch (error) {
        throw new MethodError(
          "foundry_error",
          `documents[${index}]: Foundry failed while updating ${document.uuid} (${error.message}). ${describeWritten(plans, before)} Running the call again writes what still differs.`
        );
      }
    }
    const { changed, unapplied } = writeOutcome(shown, before[index], document._source);
    (stored ? changed : unapplied).push(...secrets);
    documents.push({ uuid: document.uuid, changed, unapplied });
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
async function planDeletion({ uuids, handMade }) {
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
  refuseRuled(documents.flatMap((document) => rulesOf(document.documentName).remove?.(document) ?? []).join(" "));
  const foreign = documents.filter((document) => !isManaged(document));
  if (foreign.length > 0 && handMade !== true) {
    throw refuse(
      `These documents were not made by this bridge: ${foreign.map(labelOf).join(", ")}. Foundry cannot bring a deleted document back. Pass handMade: true to delete them as well.`
    );
  }
  return documents;
}

export async function prepareDeletion(request) {
  await planDeletion(request);
  return request;
}

/** Foundry deletes the documents of one class in one parent or pack with one call (common/abstract/document.mjs:696-701). */
function deletionGroups(documents) {
  const groups = new Map();
  for (const document of documents) {
    const parent = document.parent ?? null;
    const pack = document.pack ?? null;
    const key = JSON.stringify([document.documentName, parent?.uuid ?? null, pack]);
    if (!groups.has(key)) groups.set(key, { cls: classOf(document.documentName), parent, pack, documents: [] });
    groups.get(key).documents.push(document);
  }
  return [...groups.values()];
}

export async function deleteDocuments(request) {
  const planned = await planDeletion(request);
  const deleted = [];
  for (const { cls, parent, pack, documents } of deletionGroups(planned)) {
    const entries = new Map(
      documents.map((document) => [
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
