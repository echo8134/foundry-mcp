// @ts-check
// Reads given data, and the paths of entries to remove, against a data schema by walking both side by side. Reads the
// same public field shape as schema.mjs: the class names, `fields`, `element`, `types`, `persisted`, `initialKeys`,
// `initialKeysOnly` and `getModelForType`.

import { isPlainObject } from "./data-diff.mjs";
import { classChain, initialKeys } from "./schema.mjs";

/**
 * @typedef {{path: string, problem: "unknown"}
 *   | {path: string, problem: "derived"}
 *   | {path: string, problem: "key", keys: string[]}
 *   | {path: string, problem: "reserved", key: string}
 *   | {path: string, problem: "variant", types: string[]}
 *   | {path: string, problem: "model", type: string | undefined}
 *   | {path: string, problem: "unchecked"}
 *   | {path: string, problem: "embedded"}} FieldProblem
 */
/**
 * @typedef {(entry: unknown, field: any, heldType?: string) => object | null | undefined} SchemaFor the schema to check
 *   a given entry against, or nothing when the entry names no type it knows. It gets the field too, because the class
 *   name alone does not tell the fields apart: dnd5e's activities and advancements are both maps of TypeDataField5e.
 *   `heldType` is the type of the behavior the entry is the config of, which has no type of its own.
 */
/** @typedef {{documentName: string, path: string, data: Record<string, unknown>}} GivenDocument a document given inside the data of another: its document name, where it lies, and its own data */
/**
 * @typedef {{type?: string, heldType?: string, schemaFor: Readonly<Record<string, SchemaFor>>, problems: FieldProblem[],
 *   html: Set<string>, idArrays: Set<string>, documents: GivenDocument[], embedded?: boolean,
 *   inEmbedded?: boolean}} Walk
 *   `html` collects the paths of the leaves that lie on an HTMLField, `idArrays` those of the lists whose elements
 *   are each given an `_id` of their own, and `documents` the documents the walk went into. Without `embedded` an
 *   embedded document in the data is a problem. `inEmbedded` is set below one, where the type comes from the data and
 *   not from the caller.
 */
/** @typedef {{path: string, problem: "unknown" | "field" | "reserved"}} RemovalProblem */

/** @param {string} path @param {string | number} key */
const join = (path, key) => (path ? `${path}.${key}` : String(key));

/**
 * Keys Foundry reads as an instruction: a leading `-=` as a deletion and `==` as a replacement
 * (common/data/fields.mjs:1113-1140, :2189-2206), and an object that has the key `__$OPERATOR$__` as an operator to
 * rebuild (:1175-1184). Foundry's own setProperty skips the last three (common/utils/helpers.mjs:842).
 * @param {string} key
 */
const isInstructionKey = (key) =>
  key.startsWith("-=") ||
  key.startsWith("==") ||
  ["__$OPERATOR$__", "__proto__", "constructor", "prototype"].includes(key);

/**
 * Keys Foundry does not store as they are: the ones it reads as an instruction, and a key with a dot, which cleaning
 * expands into nested objects (common/data/fields.mjs:1162-1165).
 * @param {string} key
 */
export const isReservedKey = (key) => key.includes(".") || isInstructionKey(key);

/**
 * Looks at every key of the data, whatever field it lies below: a free-form object such as flags takes a reserved key
 * like any other.
 * @param {unknown} value
 * @param {string} path
 * @param {FieldProblem[]} problems
 */
function findReservedKeys(value, path, problems) {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) findReservedKeys(child, join(path, index), problems);
  } else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (isReservedKey(key)) problems.push({ path, problem: "reserved", key });
      else findReservedKeys(child, join(path, key), problems);
    }
  }
}

/** @param {Record<string, unknown>} value @returns {[string, unknown][]} the entries findReservedKeys has not reported */
const plainEntries = (value) => Object.entries(value).filter(([key]) => !isReservedKey(key));

const NEEDS_TYPE =
  "fieldProblems needs the document type to check the data of a TypeDataField such as system: pass { type }.";

/** @param {unknown} field */
const isTypeData = (field) =>
  field !== null && typeof field === "object" && classChain(field).includes("TypeDataField");

/**
 * The walk that goes on in the data of one embedded document, or null where there is nothing to walk. Its type is the
 * one the data gives, or else the one Foundry would fill in: the initial value of the `type` field of its class
 * (common/data/fields.mjs:4285-4310).
 * @param {any} schema the schema of the embedded document class
 * @param {unknown} documentName
 * @param {unknown} value
 * @param {string} path
 * @param {Walk} walk
 * @returns {Walk | null}
 */
function embeddedWalk(schema, documentName, value, path, walk) {
  if (!walk.embedded || typeof documentName !== "string" || schema === null || typeof schema !== "object") {
    walk.problems.push({ path, problem: walk.embedded ? "unchecked" : "embedded" });
    return null;
  }
  if (!isPlainObject(value)) return null;
  walk.documents.push({ documentName, path, data: value });
  const initial = schema.fields?.type?.initial;
  const type = typeof value.type === "string" ? value.type : typeof initial === "string" ? initial : undefined;
  return { ...walk, type, heldType: undefined, inEmbedded: true };
}

/** @param {any} field @param {unknown} value @param {string} path @param {Walk} walk */
function checkSchema(field, value, path, walk) {
  if (!isPlainObject(value)) return;
  for (const [key, child] of plainEntries(value)) {
    const inner = Object.hasOwn(field.fields ?? {}, key) ? field.fields[key] : undefined;
    if (!inner) walk.problems.push({ path: join(path, key), problem: "unknown" });
    else if (inner.persisted === false) walk.problems.push({ path: join(path, key), problem: "derived" });
    else check(inner, child, join(path, key), walk);
  }
}

/**
 * By class name, from a field's own class up through the classes it extends: the first name found decides how the
 * data below the field is checked. A field whose class leads to none of the entries before DataField takes anything
 * below it: free-form objects such as flags, and leaves, whose values Foundry's own validation checks.
 * @type {Readonly<Record<string, (field: any, value: unknown, path: string, walk: Walk) => void>>}
 */
const STRUCTURES = Object.freeze({
  SchemaField: checkSchema,
  // dnd5e MappingField stores a key outside initialKeys and then ignores it (dnd5e module/data/fields/mapping-field.mjs).
  TypedObjectField: (field, value, path, walk) => {
    if (!isPlainObject(value)) return;
    const keys = field.initialKeysOnly === true ? initialKeys(field.initialKeys) : null;
    for (const [key, child] of plainEntries(value)) {
      if (keys && !keys.includes(key)) walk.problems.push({ path: join(path, key), problem: "key", keys });
      else check(field.element, child, join(path, key), walk);
    }
  },
  // The actor tools take embedded documents such as items and effects through inputs of their own. A walk with
  // `embedded` goes on into each one: the field names the class of its documents as `element`, and gives their schema
  // as `schema` (common/data/fields.mjs:3033-3043).
  EmbeddedCollectionField: (field, value, path, walk) => {
    if (!walk.embedded) return void walk.problems.push({ path, problem: "embedded" });
    if (!Array.isArray(value)) return;
    for (const [index, child] of value.entries()) {
      const at = join(path, index);
      const inner = embeddedWalk(field.schema, field.element?.documentName, child, at, walk);
      if (inner) check(field.schema, child, at, inner);
    }
  },
  // One embedded document in place of a collection, such as a token's own actor data: the field is the schema of its
  // class, which it names as `model` (common/data/fields.mjs:3415-3462).
  EmbeddedDocumentField: (field, value, path, walk) => {
    if (!walk.embedded) return checkSchema(field, value, path, walk);
    const inner = embeddedWalk(field, field.model?.documentName, value, path, walk);
    if (inner) checkSchema(field, value, path, inner);
  },
  ArrayField: (field, value, path, walk) => {
    if (!Array.isArray(value)) return;
    // An `_id` with a function as its initial value is made up for each element that comes without one, as in dnd5e
    // module/data/abstract/active-effect-data-model.mjs:35. One without is a reference to another document.
    if (typeof field.element?.fields?._id?.initial === "function") walk.idArrays.add(path);
    for (const [index, child] of value.entries()) check(field.element, child, join(path, index), walk);
  },
  // dnd5e picks the data model of a behavior's config by the type of the behavior it lies in (dnd5e
  // module/data/activity/fields/applied-behavior-field.mjs:30-33).
  AppliedBehaviorField: (field, value, path, walk) => {
    const heldType = isPlainObject(value) && typeof value.type === "string" ? value.type : undefined;
    checkSchema(field, value, path, { ...walk, heldType });
  },
  TypedSchemaField: (field, value, path, walk) => {
    if (!isPlainObject(value)) return;
    const types = field.types ?? {};
    if (typeof value.type === "string" && Object.hasOwn(types, value.type)) check(types[value.type], value, path, walk);
    else walk.problems.push({ path, problem: "variant", types: Object.keys(types) });
  },
  TypeDataField: (field, value, path, walk) => {
    if (walk.type === undefined && !walk.inEmbedded) throw new TypeError(NEEDS_TYPE);
    const schema = walk.type === undefined ? undefined : field.getModelForType?.(walk.type)?.schema;
    if (schema) check(schema, value, path, walk);
    else if (isPlainObject(value) && Object.keys(value).length > 0) {
      walk.problems.push({ path, problem: "model", type: walk.type });
    }
  },
  HTMLField: (_field, _value, path, walk) => {
    walk.html.add(path);
  },
  // dnd5e picks the data model of each activity or advancement with a function the field was built with (dnd5e
  // module/data/fields/type-data-field.mjs), which this walk does not call: the caller passes the schemas in schemaFor.
  TypeDataField5e: (field, value, path, walk) => {
    const name = classChain(field).find((className) => Object.hasOwn(walk.schemaFor, className));
    const schemaFor = name === undefined ? undefined : walk.schemaFor[name];
    if (!schemaFor) return void walk.problems.push({ path, problem: "unchecked" });
    const schema = schemaFor(value, field, walk.heldType);
    if (schema) return check(schema, value, path, { ...walk, heldType: undefined });
    const type = walk.heldType ?? (isPlainObject(value) && typeof value.type === "string" ? value.type : undefined);
    walk.problems.push({ path, problem: "model", type });
  },
  DataField: () => {}
});

/**
 * @typedef {{type?: string, schemaFor?: Readonly<Record<string, SchemaFor>>, embedded?: boolean}} WalkOptions
 *   `type` is the document type, which picks the data model of a TypeDataField such as `system`. `schemaFor` maps the
 *   class name of a dnd5e TypeDataField5e, or of a class that extends it, to the schema of each given entry; without
 *   one, any data below such a field is the problem `unchecked`. With `embedded` the walk goes on into the embedded
 *   documents given inside the data, each with the type it names; without it, any of them is the problem `embedded`.
 */

/**
 * @param {WalkOptions} options
 * @returns {Walk}
 */
const newWalk = ({ type, schemaFor = {}, embedded }) => ({
  type,
  schemaFor,
  embedded,
  problems: [],
  html: new Set(),
  idArrays: new Set(),
  documents: []
});

/** @param {unknown} field @param {unknown} value @param {string} path @param {Walk} walk */
function check(field, value, path, walk) {
  if (field === null || typeof field !== "object") return;
  for (const name of classChain(field)) {
    const structure = STRUCTURES[name];
    if (structure) return structure(field, value, path, walk);
  }
}

/**
 * Every leaf path of `data` must lead to a stored field of `schema`, and no key may be one Foundry reads as an
 * instruction. Data the walk cannot follow is a problem, not a pass.
 * @param {object} schema a SchemaField
 * @param {Record<string, unknown>} data
 * @param {WalkOptions} [options]
 * @returns {FieldProblem[]}
 * @throws {TypeError} when the schema has a TypeDataField and no type is given: without it the data below that field
 *   would go unchecked
 */
export function fieldProblems(schema, data, options = {}) {
  const { fields = {} } = /** @type {{fields?: Record<string, unknown>}} */ (schema);
  if (options.type === undefined && Object.values(fields).some(isTypeData)) throw new TypeError(NEEDS_TYPE);
  const walk = newWalk(options);
  findReservedKeys(data, "", walk.problems);
  check(schema, data, "", walk);
  return walk.problems;
}

/**
 * Which leaves hold HTML is read from the schema. Two texts of such a leaf say the same when their canonical forms are
 * equal: the Foundry server rewrites HTML when it stores it, so the stored text is seldom the given one.
 * @param {object} schema a SchemaField
 * @param {Record<string, unknown>} data the data whose HTML leaves are compared
 * @param {(html: string) => string} canonical the content of an HTML text in a form that does not depend on how it is
 *   spelled
 * @param {WalkOptions} [options] as for fieldProblems
 * @returns {import("./data-diff.mjs").SameLeaf}
 */
export function sameHtml(schema, data, canonical, options = {}) {
  const walk = newWalk(options);
  check(schema, data, "", walk);
  return (path, wanted, stored) =>
    walk.html.has(path) &&
    typeof wanted === "string" &&
    typeof stored === "string" &&
    canonical(wanted) === canonical(stored);
}

/**
 * Foundry gives an element of such a list a new random `_id` on every cleaning unless the data names one: the changes
 * of an active effect, and in dnd5e an activity's behaviors, a summon or transform activity's profiles and a class's
 * starting equipment.
 * @param {object} schema a SchemaField
 * @param {Record<string, unknown>} data the data whose lists are looked at
 * @param {WalkOptions} [options] as for fieldProblems
 * @returns {string[]} the paths of the given lists whose elements are each given an `_id` of their own
 */
export function elementIdArrays(schema, data, options = {}) {
  const walk = newWalk(options);
  check(schema, data, "", walk);
  return [...walk.idArrays];
}

/**
 * A write that creates a document creates the documents given inside its data with it, so what holds for a new
 * document of a name holds for each of these.
 * @param {object} schema a SchemaField
 * @param {Record<string, unknown>} data
 * @param {WalkOptions} [options] as for fieldProblems
 * @returns {GivenDocument[]} the documents given inside the data, at any depth, that the walk goes into
 */
export function documentsWithin(schema, data, options = {}) {
  const walk = newWalk(options);
  check(schema, data, "", walk);
  return walk.documents;
}

/**
 * @param {FieldProblem[]} problems
 * @returns {string} one sentence per kind of problem
 */
export function explainFieldProblems(problems) {
  const paths = (/** @type {FieldProblem["problem"]} */ kind) =>
    problems.filter((problem) => problem.problem === kind).map((problem) => problem.path);
  const sentences = [];
  const reserved = problems.flatMap((problem) =>
    problem.problem === "reserved" ? [`${JSON.stringify(problem.key)} in ${problem.path || "the entry"}`] : []
  );
  if (reserved.length > 0) {
    sentences.push(
      `Not a plain key: ${reserved.join(", ")}. A key may not contain a dot, which Foundry expands into nested objects, nor be one Foundry reads as an instruction (a leading -= or ==, __$OPERATOR$__) or a part of every object (__proto__, constructor, prototype). Give nested objects in place of a key with a dot.`
    );
  }
  if (paths("unknown").length > 0) sentences.push(`No such field: ${paths("unknown").join(", ")}.`);
  if (paths("derived").length > 0) sentences.push(`Derived, never stored: ${paths("derived").join(", ")}.`);
  if (paths("embedded").length > 0) {
    sentences.push(
      `Not taken inside the data: ${paths("embedded").join(", ")}. Embedded documents such as items and effects are given through the tool's own inputs for them.`
    );
  }
  if (paths("unchecked").length > 0) {
    sentences.push(
      `Cannot be checked here: ${paths("unchecked").join(", ")}. What such an entry holds depends on its type, and this call has no data model for it. Leave it out of this call.`
    );
  }
  for (const problem of problems) {
    if (problem.problem === "key") {
      sentences.push(`${problem.path}: the key must be one of ${problem.keys.join(", ")}.`);
    } else if (problem.problem === "variant") {
      sentences.push(`${problem.path}: give its type, one of ${problem.types.join(", ")}.`);
    } else if (problem.problem === "model") {
      sentences.push(
        problem.type === undefined
          ? `${problem.path}: give its type, which picks the data model to check it against.`
          : `${problem.path}: the type ${problem.type} has no data model to check it against.`
      );
    }
  }
  return sentences.join(" ");
}

/** @typedef {{names: RemovalProblem["problem"] | "entry", next?: unknown}} PathStep */

/** @type {(field: any, key: string) => PathStep} */
const insideAField = () => ({ names: "field" });

/**
 * By class name, as STRUCTURES: what a path names when it ends on a key below the field, and the field it goes on in.
 * Without one, a path that goes on names what the step says. An entry is what can be removed: a key of a keyed map, or
 * a key at any depth below a free-form object such as a flags scope. Below a field of any other class there is none.
 */
const PATH_STEPS = Object.freeze(
  /** @type {Record<string, (field: any, key: string) => PathStep>} */ ({
    SchemaField: (field, key) => {
      const inner = Object.hasOwn(field.fields ?? {}, key) ? field.fields[key] : undefined;
      return inner && inner.persisted !== false ? { names: "field", next: inner } : { names: "unknown" };
    },
    TypedObjectField: (field) => ({ names: "entry", next: field.element }),
    // An ObjectField by its class, but what it holds follows a data model that this walk does not have.
    TypeDataField5e: insideAField,
    ObjectField: () => ({ names: "entry" })
  })
);

/**
 * @param {object} schema a SchemaField
 * @param {string[]} keys
 * @param {string | undefined} type
 * @returns {PathStep["names"]}
 */
function pathNames(schema, keys, type) {
  /** @type {unknown} */
  let field = schema;
  /** @type {PathStep["names"]} */
  let names = "field";
  for (const key of keys) {
    if (isTypeData(field)) {
      if (type === undefined) throw new TypeError(NEEDS_TYPE);
      field = /** @type {any} */ (field).getModelForType?.(type)?.schema;
    }
    if (field === null || typeof field !== "object") return "unknown";
    const name = classChain(field).find((className) => Object.hasOwn(PATH_STEPS, className));
    const step = (PATH_STEPS[name ?? ""] ?? insideAField)(field, key);
    if (step.next === undefined) return step.names;
    names = step.names;
    field = step.next;
  }
  return names;
}

/**
 * A path to remove must name an entry of a keyed map, or a key below a free-form object, and each of its keys must be
 * a plain one.
 * @param {object} schema a SchemaField
 * @param {readonly string[]} paths dot paths
 * @param {{type?: string}} [options] `type` is the document type, as for fieldProblems
 * @returns {RemovalProblem[]}
 * @throws {TypeError} when a path leads into a TypeDataField and no type is given
 */
export function removalProblems(schema, paths, { type } = {}) {
  return paths.flatMap((path) => {
    const keys = path.split(".");
    if (keys.some((key) => key === "" || isInstructionKey(key))) return [{ path, problem: "reserved" }];
    const names = pathNames(schema, keys, type);
    return names === "entry" ? [] : [{ path, problem: names }];
  });
}

/**
 * @param {RemovalProblem[]} problems
 * @returns {string} one sentence per kind of problem
 */
export function explainRemovalProblems(problems) {
  const paths = (/** @type {RemovalProblem["problem"]} */ kind) =>
    problems.filter((problem) => problem.problem === kind).map((problem) => problem.path);
  const sentences = [];
  if (paths("reserved").length > 0) {
    sentences.push(
      `Not a path of plain keys: ${paths("reserved").join(", ")}. A key may not be empty, nor one Foundry reads as an instruction (a leading -= or ==, __$OPERATOR$__) or a part of every object (__proto__, constructor, prototype).`
    );
  }
  if (paths("unknown").length > 0) sentences.push(`No such field: ${paths("unknown").join(", ")}.`);
  if (paths("field").length > 0) {
    sentences.push(
      `Not an entry that can be removed: ${paths("field").join(", ")}. remove takes the path of one entry of a keyed map, such as system.tools.thief, or of a key below a free-form object such as flags.world. A field keeps its place: give it another value instead, and give a list whole to drop an element of it.`
    );
  }
  return sentences.join(" ");
}
