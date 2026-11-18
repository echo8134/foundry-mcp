// The checks every write of a document runs before anything is written, and the wording of their refusals and of what
// a failed write says. planUpdate runs them for a document that exists and planBuilt for a new one. `where` names the
// entry of the request a refusal is about, and is empty for the one document a call is about.

import {
  dropAt,
  explainRecasts,
  givesValueOn,
  hasPath,
  pickData,
  recastLeaves,
  sameData,
  updateFor
} from "./data-diff.mjs";
import { byPosition, mapGiven } from "./embedded.mjs";
import { MethodError } from "./errors.mjs";
import {
  explainFieldProblems,
  explainRemovalProblems,
  fieldProblems,
  removalProblems,
  sameHtml
} from "./field-check.mjs";
import { TYPED_ENTRY_SCHEMAS } from "./item-data.mjs";
import { getPath } from "./paths.mjs";
import { FLAG_SCOPE } from "./scope.mjs";
import { canonicalHtml, checkUpdate, cleanedChanges, loadTexture } from "./world.mjs";

const OWN_FLAG = `flags.${FLAG_SCOPE}`;

/**
 * What the checks need to know of each kind of document. `ownFlags` are the paths of the bridge's own flag: on an
 * actor also on its prototype token, because a token dropped from an actor whose prototype token has it would count
 * as bridge-made.
 */
export const KINDS = Object.freeze({
  Actor: { document: "Actor", noun: "actor", ownFlags: [OWN_FLAG, `prototypeToken.${OWN_FLAG}`], alsoListed: "" },
  Item: {
    document: "Item",
    noun: "item",
    ownFlags: [OWN_FLAG],
    alsoListed: " Those of an activity are listed with document Activity."
  },
  ActiveEffect: { document: "ActiveEffect", noun: "effect", ownFlags: [OWN_FLAG], alsoListed: "" }
});

const schemaOf = (kind) => CONFIG[kind.document].documentClass.schema;

/**
 * The kind of any document name. Actor, Item and ActiveEffect keep their entries above. Any other document goes by its
 * name, and has the bridge's own flag where its schema has flags (a Setting has none,
 * common/documents/setting.mjs:39-49).
 */
export function kindOf(documentName) {
  if (Object.hasOwn(KINDS, documentName)) return KINDS[documentName];
  const { fields } = CONFIG[documentName].documentClass.schema;
  return {
    document: documentName,
    noun: documentName,
    ownFlags: Object.hasOwn(fields, "flags") ? [OWN_FLAG] : [],
    alsoListed: ""
  };
}

/**
 * How the schema walk reads the data of a document of a type. An entry below a dnd5e TypeDataField5e is checked by
 * the data model that field picks for it, wherever the system put such a field: in dnd5e 6.1.0 only an item's
 * activities and advancement hold one. With `embedded` the walk goes on into the embedded documents given in the data.
 * @returns {import("./field-check.mjs").WalkOptions}
 */
export const walkOf = (type, embedded = false) => ({ type, schemaFor: TYPED_ENTRY_SCHEMAS, embedded });

const UNWRITTEN = "Nothing was written.";

export const refuse = (message, where = "") => new MethodError("invalid_params", `${where}${message} ${UNWRITTEN}`);

/**
 * A lookup that a write begins with, such as the document a UUID names. What the lookup cannot find ends the write
 * before it wrote anything, and its error says so.
 * @template T
 * @param {Promise<T>} lookup
 * @returns {Promise<T>}
 */
export const forWrite = (lookup) =>
  lookup.catch((error) => {
    throw error instanceof MethodError ? new MethodError(error.code, `${error.message} ${UNWRITTEN}`) : error;
  });

const modelRefusal = (kind, error, where) =>
  refuse(`Foundry's ${kind.noun} model refuses the data: ${error.message}`, where);

/**
 * The tools that read a document return the bridge's own flag in its stored data, and that data can be passed back.
 * So the flag is taken where it says what is stored, at every path the kind of document has it, and is no part of the
 * change. With any other value it stays in the data, for checkAsked to refuse.
 * @param {{ownFlags: readonly string[]}} kind
 * @param {Record<string, any>} given
 * @param {Record<string, any>} stored the stored data of the document, or what a new one is made with
 * @returns {Record<string, any>}
 */
export function withoutOwnFlags(kind, given, stored) {
  const taken = kind.ownFlags.filter(
    (path) => hasPath(given, path) && sameData(getPath(given, path), getPath(stored, path))
  );
  if (taken.length === 0) return given;
  const data = structuredClone(given);
  for (const path of taken) dropAt(data, path);
  return data;
}

/** Where the data gives the bridge's own flag: in the document, and in each embedded document given with it. */
function ownFlagsGiven(kind, asked) {
  const paths = [];
  mapGiven(asked, CONFIG[kind.document].documentClass, (data, cls, path) => {
    paths.push(
      ...kindOf(cls.documentName)
        .ownFlags.filter((flag) => hasPath(data, flag))
        .map((flag) => path + flag)
    );
    return data;
  });
  return paths;
}

/**
 * The given data and the entries to remove, against the fields the document stores. Reads only.
 * @param {{document: string, ownFlags: readonly string[], alsoListed: string}} kind
 * @param {Record<string, any>} asked
 * @param {{remove?: readonly string[], type?: string, where?: string, embedded?: boolean}} [options] with `embedded`
 *   the embedded documents given inside the data are checked too, and without it refused
 */
export function checkAsked(kind, asked, { remove = [], type, where = "", embedded = false } = {}) {
  const given = ownFlagsGiven(kind, asked);
  if (given.length > 0) {
    throw refuse(
      `${given.join(" and ")} cannot be given: it is the bridge's own flag, which only the bridge sets.`,
      where
    );
  }
  const problems = fieldProblems(schemaOf(kind), asked, walkOf(type, embedded));
  if (problems.length > 0) {
    const ofType = type === undefined ? "" : ` and type ${type}`;
    throw refuse(
      `${explainFieldProblems(problems)} get_schema with document ${kind.document}${ofType} lists the stored fields.${kind.alsoListed}`,
      where
    );
  }
  const removals = removalProblems(schemaOf(kind), remove, { type });
  if (removals.length > 0) throw refuse(`remove: ${explainRemovalProblems(removals)}`, where);
  const own = remove.filter((path) => kind.ownFlags.some((flag) => path === flag || path.startsWith(`${flag}.`)));
  if (own.length > 0) throw refuse(`remove: ${own.join(", ")} is the bridge's own flag, which stays.`, where);
  const both = remove.filter((path) => givesValueOn(asked, path));
  if (both.length > 0) {
    throw refuse(`${both.join(", ")} is named in remove and given a value in the same call. Do one of the two.`, where);
  }
}

function checkKeptAsGiven(asked, wanted, where) {
  const recasts = recastLeaves(asked, wanted);
  if (recasts.length > 0) throw refuse(`${explainRecasts(recasts)} Give each value as Foundry stores it.`, where);
}

/** An image may be null, which is no image and nothing to load (common/data/fields.mjs:3742). */
async function checkImage(img, where) {
  if (typeof img === "string" && !(await loadTexture(img)))
    throw refuse(`The image ${img} could not be loaded.`, where);
}

/** A dry run of the removal, which Foundry's model may refuse although each path names an entry. */
function checkRemoval(kind, document, remove, where, advice) {
  const removal = updateFor({ wanted: {}, remove }, document._source, _del);
  if (!removal.writes) return;
  try {
    checkUpdate(document, removal.update);
  } catch (error) {
    throw refuse(`Foundry's ${kind.noun} model refuses the removal: ${error.message}${advice}`, where);
  }
}

/**
 * What a write is to bring about, with the HTML fields of the wanted data compared by what they say. `given` is the
 * data the HTML fields are found in, where the wanted data is in another shape than the schema describes.
 * @returns {import("./data-diff.mjs").Asked}
 */
const writeOf = (kind, wanted, { remove, type, given = wanted, embedded = false }) => ({
  wanted,
  remove,
  same: sameHtml(schemaOf(kind), given, canonicalHtml, walkOf(type, embedded))
});

/**
 * Every check of a change to a document that exists, and what the change is to bring about: the asked data against
 * the fields, the changes as Foundry would store them, no value recast, an image that loads, and a removal the model
 * takes. Reads only.
 * @param {{document: string, noun: string, ownFlags: readonly string[], alsoListed: string}} kind
 * @param {any} document
 * @param {Record<string, any>} asked
 * @param {{remove?: readonly string[], where?: string, advice?: string}} [options] `advice` ends the refusal of a
 *   removal that Foundry's model does not take
 * @returns {Promise<import("./data-diff.mjs").Asked>}
 */
export async function planUpdate(kind, document, asked, { remove = [], where = "", advice = "" } = {}) {
  const { type } = document;
  checkAsked(kind, asked, { remove, type, where });
  let wanted;
  try {
    wanted = cleanedChanges(document, asked);
  } catch (error) {
    throw modelRefusal(kind, error, where);
  }
  checkKeptAsGiven(asked, wanted, where);
  if (wanted.img !== document._source.img) await checkImage(wanted.img, where);
  checkRemoval(kind, document, remove, where, advice);
  return writeOf(kind, wanted, { remove, type });
}

/**
 * The checks of a new document that need it built: Foundry's model takes the data, no asked value is recast, and its
 * image loads. The document is built in memory with its parent and pack, as Foundry builds one before it creates it
 * (client/data/client-backend.mjs:91-94). An embedded document given with it is compared by its place in the list,
 * and not by the id Foundry gives it. Reads only.
 * @param {{document: string, noun: string}} kind
 * @param {any} cls the document class
 * @param {Record<string, any>} data what the document is created from: the asked data, and what the caller adds to it
 * @param {Record<string, any>} asked the data a caller asked for, which the stored document is compared with
 * @param {{remove?: readonly string[], parent?: any, pack?: string | null, where?: string}} [options] `remove` names
 *   the entries the caller took out of the data, which the stored document is to lack
 * @returns {Promise<{built: any, write: import("./data-diff.mjs").Asked}>} the unsaved document, and what its
 *   creation is to bring about
 */
export async function planBuilt(kind, cls, data, asked, { remove = [], parent = null, pack = null, where = "" } = {}) {
  let built;
  try {
    // The constructor keeps the object it is given as the stored data and cleans it in place.
    built = new cls(structuredClone(data), { parent, pack });
  } catch (error) {
    throw modelRefusal(kind, error, where);
  }
  const shape = byPosition(asked, cls);
  const wanted = pickData(byPosition(built.toObject(), cls), shape);
  checkKeptAsGiven(shape, wanted, where);
  await checkImage(wanted.img, where);
  return { built, write: writeOf(kind, wanted, { remove, type: built.type, given: asked, embedded: true }) };
}

/** What an entry of a result says in place of its document when Foundry made none for it. */
export const createdNothing = (what) =>
  `Foundry created ${what} and reported no error, which is what it does when the system or a module refuses a creation.`;

export const NOT_CREATED = `foundry_error: ${createdNothing("nothing for this entry")}`;

/**
 * What the error of a failed update says of the stored data, where Foundry may have applied a part of the update.
 * @param {readonly string[]} written what changed, each with its paths
 */
export const changedInStorage = (written) =>
  written.length > 0 ? `Changed in the stored data: ${written.join("; ")}.` : "Nothing was changed in the stored data.";

export const RUN_AGAIN = "Running the call again writes what still differs.";
