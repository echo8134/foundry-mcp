// The checks every write of a document runs before anything is written, and the wording of their refusals. `where`
// names the entry of the request a refusal is about, and is empty for the one document a call is about.

import { explainRecasts, givesValueOn, hasPath, recastLeaves, updateFor } from "./data-diff.mjs";
import { MethodError } from "./errors.mjs";
import {
  explainFieldProblems,
  explainRemovalProblems,
  fieldProblems,
  removalProblems,
  sameHtml
} from "./field-check.mjs";
import { TYPED_ENTRY_SCHEMAS } from "./item-data.mjs";
import { FLAG_SCOPE } from "./scope.mjs";
import { canonicalHtml, checkUpdate, cleanedChanges, loadTexture } from "./world.mjs";

const OWN_FLAG = `flags.${FLAG_SCOPE}`;

/**
 * What the checks need to know of each kind of document. `ownFlags` are the paths of the bridge's own flag: on an
 * actor also on its prototype token, because a token dropped from an actor whose prototype token has it would count
 * as bridge-made. `schemaFor` gives the data models of the typed entries the schema check cannot find by itself.
 */
export const KINDS = Object.freeze({
  Actor: {
    document: "Actor",
    noun: "actor",
    ownFlags: [OWN_FLAG, `prototypeToken.${OWN_FLAG}`],
    schemaFor: {},
    alsoListed: ""
  },
  Item: {
    document: "Item",
    noun: "item",
    ownFlags: [OWN_FLAG],
    schemaFor: TYPED_ENTRY_SCHEMAS,
    alsoListed: " Those of an activity are listed with document Activity."
  },
  ActiveEffect: { document: "ActiveEffect", noun: "effect", ownFlags: [OWN_FLAG], schemaFor: {}, alsoListed: "" }
});

const schemaOf = (kind) => CONFIG[kind.document].documentClass.schema;

/**
 * The kind of any document name. Actor, Item and ActiveEffect keep their entries above. Any other document goes by its
 * name, has the bridge's own flag where its schema has flags (a Setting has none, common/documents/setting.mjs:39-49),
 * and has an entry below a dnd5e TypeDataField5e checked by the data model that field picks for it, wherever the
 * system put such a field.
 */
export function kindOf(documentName) {
  if (Object.hasOwn(KINDS, documentName)) return KINDS[documentName];
  const { fields } = CONFIG[documentName].documentClass.schema;
  return {
    document: documentName,
    noun: documentName,
    ownFlags: Object.hasOwn(fields, "flags") ? [OWN_FLAG] : [],
    schemaFor: TYPED_ENTRY_SCHEMAS,
    alsoListed: ""
  };
}

/** The `schemaFor` of the documents of a name, for a check that goes on into the embedded documents given with one. */
export const embeddedSchemas = (documentName) => kindOf(documentName).schemaFor;

export const refuse = (message, where = "") =>
  new MethodError("invalid_params", `${where}${message} Nothing was written.`);

export const modelRefusal = (kind, error, where = "") =>
  refuse(`Foundry's ${kind.noun} model refuses the data: ${error.message}`, where);

/**
 * The given data and the entries to remove, against the fields the document stores. Reads only. With `embedded`, as
 * fieldProblems takes it, the embedded documents given inside the data are checked too, and without it refused.
 */
export function checkAsked(kind, asked, remove, type, where = "", embedded) {
  const given = kind.ownFlags.filter((path) => hasPath(asked, path));
  if (given.length > 0) {
    throw refuse(
      `${given.join(" and ")} cannot be given: it is the bridge's own flag, which only the bridge sets.`,
      where
    );
  }
  const problems = fieldProblems(schemaOf(kind), asked, { type, schemaFor: kind.schemaFor, embedded });
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

export function checkKeptAsGiven(asked, wanted, where = "") {
  const recasts = recastLeaves(asked, wanted);
  if (recasts.length > 0) throw refuse(`${explainRecasts(recasts)} Give each value as Foundry stores it.`, where);
}

/** An image may be null, which is no image and nothing to load (common/data/fields.mjs:3742). */
export async function checkImage(img, where = "") {
  if (typeof img === "string" && !(await loadTexture(img)))
    throw refuse(`The image ${img} could not be loaded.`, where);
}

/** The given changes as Foundry would store them on the document, or the refusal of its model. */
export function wantedChanges(kind, document, asked, where = "") {
  try {
    return cleanedChanges(document, asked);
  } catch (error) {
    throw modelRefusal(kind, error, where);
  }
}

/** A dry run of the removal, which Foundry's model may refuse although each path names an entry. */
export function checkRemoval(kind, document, remove, where = "", advice = "") {
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
 */
export const writeOf = (kind, wanted, remove, type, given = wanted, embedded) => ({
  wanted,
  remove,
  same: sameHtml(schemaOf(kind), given, canonicalHtml, { type, schemaFor: kind.schemaFor, embedded })
});
