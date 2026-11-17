// @ts-check
// The comparisons every write tool is built on, for the plain data of any document. Three values take part:
//   given   what the caller passed
//   wanted  what Foundry would store for it: the given data after Foundry's own cleaning
//   stored  the document's `_source`, before and after the write
// A write is refused when cleaning would turn a given value into another one (recastLeaves), sends the part of wanted
// that differs from stored (diffData), and reports what changed in storage (changedPaths) and what is still not as
// wanted (diffData again).

/** @typedef {{path: string, given: unknown, kept: unknown}} Recast a given value, and what Foundry would store for it */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** @param {string} path @param {string | number} key */
const join = (path, key) => (path ? `${path}.${key}` : String(key));

/**
 * Own keys only, so that a key such as `toString` or `__proto__` never reads from Object.prototype.
 * @param {unknown} object
 * @param {string} key
 */
const own = (object, key) => (isPlainObject(object) && Object.hasOwn(object, key) ? object[key] : undefined);

/**
 * A plain assignment to `__proto__` would replace the object's prototype instead of adding a key.
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @param {unknown} value
 */
const put = (object, key, value) =>
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

/**
 * An object with keys is walked key by key. Anything else is a leaf: a scalar, an array, an object without keys.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isBranch = (value) => isPlainObject(value) && Object.keys(value).length > 0;

/** @param {Record<string, unknown>} object @returns {[string, unknown][]} the entries that hold a value */
const entries = (object) => Object.entries(object).filter(([, value]) => value !== undefined);

/**
 * Exact. A key that holds undefined counts as absent: Foundry's cleaning leaves such a key for a field without an
 * initial value, and JSON drops it.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameData(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameData(x, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const left = entries(a);
    return left.length === entries(b).length && left.every(([key, value]) => sameData(value, own(b, key)));
  }
  return false;
}

/**
 * An object without keys asks for an object and says nothing about what is in it.
 * @param {unknown} wanted
 * @param {unknown} stored
 */
const sameLeaf = (wanted, stored) => (isPlainObject(wanted) ? isPlainObject(stored) : sameData(wanted, stored));

/** @param {string} text */
const tidy = (text) => text.trim().toLowerCase();

/**
 * Foundry may keep a given value in another form without changing what it says: a number as the string of the same
 * number (a formula field), and a string trimmed or in another case (a colour in lower case). Any other string says
 * something else: a colour Foundry read as a hex number, or the initial value that replaced an empty string.
 * @param {unknown} given
 * @param {unknown} kept
 */
const keptAsGiven = (given, kept) =>
  given === kept ||
  (typeof kept === "string" &&
    ((typeof given === "string" && tidy(given) === tidy(kept)) ||
      (typeof given === "number" && String(given) === kept)));

/**
 * Finds the given values Foundry's cleaning would turn into something else, leaf by leaf and inside arrays too. Keys
 * that only `wanted` has are the defaults cleaning filled in, and are no difference.
 * @param {Record<string, unknown>} given
 * @param {unknown} wanted the given data after Foundry's cleaning
 * @returns {Recast[]}
 */
export function recastLeaves(given, wanted) {
  /** @type {Recast[]} */
  const recasts = [];
  /** @param {unknown} give @param {unknown} want @param {string} path */
  const walk = (give, want, path) => {
    if (isPlainObject(give) && isPlainObject(want)) {
      for (const [key, value] of entries(give)) walk(value, own(want, key), join(path, key));
    } else if (Array.isArray(give) && Array.isArray(want) && give.length === want.length) {
      for (const [index, value] of give.entries()) walk(value, want[index], join(path, index));
    } else if (isPlainObject(give) || Array.isArray(give) || !keptAsGiven(give, want)) {
      recasts.push({ path, given: give, kept: want });
    }
  };
  walk(given, wanted, "");
  return recasts;
}

const MAX_SHOWN = 80;

/** @param {unknown} value */
function show(value) {
  const text = JSON.stringify(value) ?? "nothing";
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}...` : text;
}

/**
 * @param {Recast[]} recasts
 * @returns {string} one sentence that names each path with the given value and what Foundry would store
 */
export function explainRecasts(recasts) {
  const parts = recasts.map(({ path, given, kept }) =>
    kept === undefined
      ? `${path}: ${show(given)} would not be stored`
      : `${path}: ${show(given)} would be stored as ${show(kept)}`
  );
  return `Foundry would not store these values as given: ${parts.join("; ")}.`;
}

/**
 * Compares wanted data with stored data by leaf path. Keys that `stored` has and `wanted` lacks are not compared.
 * @param {Record<string, unknown>} wanted
 * @param {unknown} stored
 * @returns {{paths: string[], changes: Record<string, unknown>}} the dot paths of the leaves that differ, and the part of
 *   `wanted` that holds exactly those leaves
 */
export function diffData(wanted, stored) {
  /** @type {string[]} */
  const paths = [];
  /**
   * @param {Record<string, unknown>} want
   * @param {unknown} have
   * @param {string} prefix
   * @returns {Record<string, unknown>}
   */
  const walk = (want, have, prefix) => {
    /** @type {Record<string, unknown>} */
    const changes = {};
    for (const [key, value] of entries(want)) {
      const path = join(prefix, key);
      if (isBranch(value)) {
        const nested = walk(value, own(have, key), path);
        if (Object.keys(nested).length > 0) put(changes, key, nested);
      } else if (!sameLeaf(value, own(have, key))) {
        paths.push(path);
        put(changes, key, value);
      }
    }
    return changes;
  };
  const changes = walk(wanted, stored, "");
  return { paths, changes };
}

/**
 * Copies the part of `source` that `shape` names: an object is followed key by key, any other value is taken whole.
 * Of a document built for a create this is the wanted data, and of a stored document it is the state to compare a later
 * one with.
 * @param {unknown} source
 * @param {unknown} shape
 * @returns {unknown}
 */
export function pickData(source, shape) {
  if (!isPlainObject(shape) || !isPlainObject(source)) return structuredClone(source);
  /** @type {Record<string, unknown>} */
  const picked = {};
  for (const [key, value] of entries(shape)) {
    if (Object.hasOwn(source, key)) put(picked, key, pickData(source[key], value));
  }
  return picked;
}

/**
 * @param {Record<string, unknown>} wanted its leaf paths are the ones looked at
 * @param {unknown} before the stored data before a write, or its part picked by `wanted`
 * @param {unknown} after the stored data after the write
 * @returns {string[]} the leaf paths whose stored value is another one after the write
 */
export function changedPaths(wanted, before, after) {
  /** @type {string[]} */
  const paths = [];
  /** @param {unknown} node @param {unknown} was @param {unknown} is @param {string} path */
  const walk = (node, was, is, path) => {
    if (isBranch(node)) {
      for (const [key, value] of entries(node)) walk(value, own(was, key), own(is, key), join(path, key));
    } else if (isPlainObject(node) ? isPlainObject(was) !== isPlainObject(is) : !sameData(was, is)) {
      paths.push(path);
    }
  };
  walk(wanted, before, after, "");
  return paths;
}
