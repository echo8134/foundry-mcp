// @ts-check
// The comparisons every write tool is built on, for the plain data of any document. Three values take part:
//   given   what the caller passed
//   wanted  what Foundry would store for it: the given data after Foundry's own cleaning
//   stored  the document's `_source`, before and after the write
// A write is refused when cleaning would turn a given value into another one (recastLeaves), sends the part of wanted
// that differs from stored (diffData), and reports what changed in storage (changedPaths) and what is still not as
// wanted (diffData again). updateFor and writeOutcome put these together with the entries a caller asks to remove.

/** @typedef {{path: string, given: unknown, kept: unknown}} Recast a given value, and what Foundry would store for it */
/**
 * @typedef {(path: string, wanted: unknown, stored: unknown) => boolean} SameLeaf whether two values that are not equal
 *   say the same, such as two spellings of one HTML content
 */
/**
 * @typedef {{wanted: Record<string, unknown>, remove?: readonly string[], same?: SameLeaf, unseen?: readonly string[]}} Asked
 *   what a write is to bring about: the wanted data, the dot paths of the entries to remove, the leaves that may say
 *   the same in other words, and the dot paths of the wanted values that are written and never handed back, such as a
 *   password
 */

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

/** @type {SameLeaf} */
const never = () => false;

/**
 * Exact, but for the values `same` takes as one. A key that holds undefined counts as absent: Foundry's cleaning
 * leaves such a key for a field without an initial value, and JSON drops it.
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} path where the two values lie, for `same`
 * @param {SameLeaf} same
 * @returns {boolean}
 */
function sameAt(a, b, path, same) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameAt(x, b[i], join(path, i), same));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const left = entries(a);
    return (
      left.length === entries(b).length &&
      left.every(([key, value]) => sameAt(value, own(b, key), join(path, key), same))
    );
  }
  return same(path, a, b);
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean} whether the two are equal in depth
 */
export const sameData = (a, b) => sameAt(a, b, "", never);

/**
 * An object without keys asks for an object and says nothing about what is in it.
 * @param {unknown} wanted
 * @param {unknown} stored
 * @param {string} path
 * @param {SameLeaf} same
 */
const sameLeaf = (wanted, stored, path, same) =>
  isPlainObject(wanted) ? isPlainObject(stored) : sameAt(wanted, stored, path, same);

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
 * @param {SameLeaf} [same] takes two values that are not equal as one, also inside an array
 * @returns {{paths: string[], changes: Record<string, unknown>}} the dot paths of the leaves that differ, and the part of
 *   `wanted` that holds exactly those leaves
 */
export function diffData(wanted, stored, same = never) {
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
      } else if (!sameLeaf(value, own(have, key), path, same)) {
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

/**
 * Follows a dot path through own keys, as far as there are objects to look into.
 * @param {unknown} data
 * @param {string} path
 * @returns {{value: unknown, reached: boolean}} the value the way ended on, and whether that was the end of the path
 */
function follow(data, path) {
  let value = data;
  for (const key of path.split(".")) {
    if (!isPlainObject(value)) return { value, reached: false };
    value = own(value, key);
  }
  return { value, reached: true };
}

/**
 * @param {unknown} data
 * @param {string} path a dot path
 * @returns {boolean} whether the data holds a value at the path
 */
export function hasPath(data, path) {
  const { value, reached } = follow(data, path);
  return reached && value !== undefined;
}

/**
 * @param {unknown} data
 * @param {string} path a dot path
 * @returns {boolean} whether the data gives a value at the path, or one on the way to it that is no object to look into
 */
export const givesValueOn = (data, path) => follow(data, path).value !== undefined;

/**
 * @param {readonly string[]} paths dot paths of entries to remove
 * @param {unknown} stored
 * @returns {string[]} the paths the stored data has an entry at, without those that lie inside another of them
 */
export function entriesToRemove(paths, stored) {
  const present = [...new Set(paths)].filter((path) => hasPath(stored, path));
  return present.filter((path) => !present.some((outer) => path.startsWith(`${outer}.`)));
}

/**
 * @param {Record<string, unknown>} data
 * @param {string} path a dot path, whose objects on the way are created where the data has none
 * @param {unknown} value
 */
export function putAt(data, path, value) {
  const keys = path.split(".");
  const last = /** @type {string} */ (keys.pop());
  let node = data;
  for (const key of keys) {
    const next = own(node, key);
    if (isPlainObject(next)) {
      node = next;
    } else {
      /** @type {Record<string, unknown>} */
      const made = {};
      put(node, key, made);
      node = made;
    }
  }
  put(node, last, value);
}

/**
 * @param {Record<string, unknown>} data
 * @param {string} path a dot path whose key is deleted from the data, when it is there
 */
export function dropAt(data, path) {
  const cut = path.lastIndexOf(".");
  const { value: parent, reached } = cut < 0 ? { value: data, reached: true } : follow(data, path.slice(0, cut));
  if (reached && isPlainObject(parent)) delete parent[path.slice(cut + 1)];
}

/**
 * Follows a dot path through own keys and through the indexes of lists.
 * @param {unknown} data
 * @param {string} path
 * @returns {unknown} the value at the path, undefined where the data has none
 */
function valueAt(data, path) {
  let value = data;
  for (const key of path.split(".")) {
    if (Array.isArray(value)) value = value[Number(key)];
    else value = own(value, key);
  }
  return value;
}

/**
 * Gives each element of the named lists that has no `_id` the one of the stored element in its place, or else a new
 * one. Without it Foundry's cleaning makes up another id on every call, and no two calls would ask for the same list.
 * An id that another element of the given list names is not given twice.
 * @param {Record<string, unknown>} given changed in place
 * @param {readonly string[]} paths the dot paths of the lists whose elements each carry an `_id`
 * @param {unknown} stored the stored data the given data is to change, or the data a new document starts from
 * @param {() => string} newId
 */
export function giveElementIds(given, paths, stored, newId) {
  for (const path of paths) {
    const list = valueAt(given, path);
    if (!Array.isArray(list)) continue;
    const before = valueAt(stored, path);
    const taken = new Set(list.map((element) => own(element, "_id")));
    for (const [index, element] of list.entries()) {
      if (!isPlainObject(element) || element._id !== undefined) continue;
      const kept = Array.isArray(before) ? own(before[index], "_id") : undefined;
      const id = typeof kept === "string" && !taken.has(kept) ? kept : newId();
      taken.add(id);
      put(element, "_id", id);
    }
  }
}

/**
 * @param {Asked} asked
 * @param {unknown} stored
 * @param {unknown} deletion the value that makes Foundry delete a key when an update holds it
 * @returns {{update: Record<string, unknown>, writes: boolean}} the update that brings the stored data to what is asked,
 *   and whether it holds anything
 */
export function updateFor({ wanted, remove = [], same }, stored, deletion) {
  const { paths, changes } = diffData(wanted, stored, same);
  const removing = entriesToRemove(remove, stored);
  for (const path of removing) putAt(changes, path, deletion);
  return { update: changes, writes: paths.length + removing.length > 0 };
}

/**
 * @param {unknown} data
 * @param {readonly string[]} keys the keys of a dot path
 * @returns {unknown} the data without what lies at the path, the given object left as it is
 */
function without(data, [key, ...rest]) {
  if (!isPlainObject(data) || key === undefined) return data;
  return Object.fromEntries(
    Object.entries(data).flatMap(([name, value]) => {
      if (name !== key) return [[name, value]];
      return rest.length > 0 ? [[name, without(value, rest)]] : [];
    })
  );
}

/**
 * @param {Asked} asked
 * @param {unknown} before the stored data before the write, a copy
 * @param {unknown} after the stored data after it
 * @param {boolean} [stored] whether Foundry took the write, which is all that tells what became of an unseen value
 * @returns {{changed: string[], unapplied: string[]}} the paths whose stored value is another one, or gone, after the
 *   write, and the paths that are still not as asked. A path can be in both.
 */
export function writeOutcome({ wanted, remove = [], same, unseen = [] }, before, after, stored = true) {
  const asked = [...new Set(remove)];
  const seen = /** @type {Record<string, unknown>} */ (
    unseen.reduce((data, path) => without(data, path.split(".")), /** @type {unknown} */ (wanted))
  );
  return {
    changed: [
      ...changedPaths(seen, before, after),
      ...asked.filter((path) => hasPath(before, path) && !hasPath(after, path)),
      ...(stored ? unseen : [])
    ],
    unapplied: [
      ...diffData(seen, after, same).paths,
      ...asked.filter((path) => hasPath(after, path)),
      ...(stored ? [] : unseen)
    ]
  };
}
