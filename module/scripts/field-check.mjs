// @ts-check
// Checks given data against a data schema by walking both side by side. Reads the same public field shape as
// schema.mjs: the class names, `fields`, `element`, `types`, `persisted`, `initialKeys`, `initialKeysOnly` and
// `getModelForType`.

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
 * @typedef {(entry: unknown, field: any) => object | null | undefined} SchemaFor the schema to check a given entry
 *   against, or nothing when the entry names no type it knows. It gets the field too, because the class name alone
 *   does not tell the fields apart: dnd5e's activities and advancements are both maps of TypeDataField5e.
 */
/** @typedef {{type?: string, schemaFor: Readonly<Record<string, SchemaFor>>, problems: FieldProblem[]}} Walk */

/** @param {string} path @param {string | number} key */
const join = (path, key) => (path ? `${path}.${key}` : String(key));

/**
 * Keys Foundry does not store as they are. Cleaning expands a key with a dot into nested objects
 * (common/data/fields.mjs:1162-1165), reads a leading `-=` as a deletion and `==` as a replacement (:1113-1140,
 * :2189-2206), and rebuilds an operator from an object that has the key `__$OPERATOR$__` (:1175-1184). Foundry's own
 * setProperty skips the last three (common/utils/helpers.mjs:842).
 * @param {string} key
 */
const isReservedKey = (key) =>
  key.includes(".") ||
  key.startsWith("-=") ||
  key.startsWith("==") ||
  ["__$OPERATOR$__", "__proto__", "constructor", "prototype"].includes(key);

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
 * By class name, from a field's own class up through the classes it extends: the first name found decides how the
 * data below the field is checked. A field whose class leads to none of the entries before DataField takes anything
 * below it: free-form objects such as flags, and leaves, whose values Foundry's own validation checks.
 * @type {Readonly<Record<string, (field: any, value: unknown, path: string, walk: Walk) => void>>}
 */
const STRUCTURES = Object.freeze({
  SchemaField: (field, value, path, walk) => {
    if (!isPlainObject(value)) return;
    for (const [key, child] of plainEntries(value)) {
      const inner = Object.hasOwn(field.fields ?? {}, key) ? field.fields[key] : undefined;
      if (!inner) walk.problems.push({ path: join(path, key), problem: "unknown" });
      else if (inner.persisted === false) walk.problems.push({ path: join(path, key), problem: "derived" });
      else check(inner, child, join(path, key), walk);
    }
  },
  // dnd5e MappingField stores a key outside initialKeys and then ignores it (dnd5e module/data/fields/mapping-field.mjs).
  TypedObjectField: (field, value, path, walk) => {
    if (!isPlainObject(value)) return;
    const keys = field.initialKeysOnly === true ? initialKeys(field.initialKeys) : null;
    for (const [key, child] of plainEntries(value)) {
      if (keys && !keys.includes(key)) walk.problems.push({ path: join(path, key), problem: "key", keys });
      else check(field.element, child, join(path, key), walk);
    }
  },
  // The write tools take embedded documents such as items and effects through inputs of their own.
  EmbeddedCollectionField: (_field, _value, path, walk) => {
    walk.problems.push({ path, problem: "embedded" });
  },
  ArrayField: (field, value, path, walk) => {
    if (!Array.isArray(value)) return;
    for (const [index, child] of value.entries()) check(field.element, child, join(path, index), walk);
  },
  TypedSchemaField: (field, value, path, walk) => {
    if (!isPlainObject(value)) return;
    const types = field.types ?? {};
    if (typeof value.type === "string" && Object.hasOwn(types, value.type)) check(types[value.type], value, path, walk);
    else walk.problems.push({ path, problem: "variant", types: Object.keys(types) });
  },
  TypeDataField: (field, value, path, walk) => {
    if (walk.type === undefined) throw new TypeError(NEEDS_TYPE);
    const schema = field.getModelForType?.(walk.type)?.schema;
    if (schema) check(schema, value, path, walk);
    else if (isPlainObject(value) && Object.keys(value).length > 0) {
      walk.problems.push({ path, problem: "model", type: walk.type });
    }
  },
  // dnd5e picks the data model of each activity or advancement with a function the field was built with (dnd5e
  // module/data/fields/type-data-field.mjs), which this walk does not call: the caller passes the schemas in schemaFor.
  TypeDataField5e: (field, value, path, walk) => {
    const name = classChain(field).find((className) => Object.hasOwn(walk.schemaFor, className));
    const schemaFor = name === undefined ? undefined : walk.schemaFor[name];
    if (!schemaFor) return void walk.problems.push({ path, problem: "unchecked" });
    const schema = schemaFor(value, field);
    if (schema) return check(schema, value, path, walk);
    const type = isPlainObject(value) && typeof value.type === "string" ? value.type : undefined;
    walk.problems.push({ path, problem: "model", type });
  },
  DataField: () => {}
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
 * @param {{type?: string, schemaFor?: Readonly<Record<string, SchemaFor>>}} [options] `type` is the document type,
 *   which picks the data model of a TypeDataField such as `system`. `schemaFor` maps the class name of a dnd5e
 *   TypeDataField5e, or of a class that extends it, to the schema of each given entry; without one, any data below
 *   such a field is the problem `unchecked`.
 * @returns {FieldProblem[]}
 * @throws {TypeError} when the schema has a TypeDataField and no type is given: without it the data below that field
 *   would go unchecked
 */
export function fieldProblems(schema, data, { type, schemaFor = {} } = {}) {
  const { fields = {} } = /** @type {{fields?: Record<string, unknown>}} */ (schema);
  if (type === undefined && Object.values(fields).some(isTypeData)) throw new TypeError(NEEDS_TYPE);
  /** @type {Walk} */
  const walk = { type, schemaFor, problems: [] };
  findReservedKeys(data, "", walk.problems);
  check(schema, data, "", walk);
  return walk.problems;
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
