// @ts-check

/**
 * @param {any} object
 * @param {string} path
 */
export function getPath(object, path) {
  let value = object;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[key];
  }
  return value;
}

/**
 * @param {Record<string, any>} object
 * @param {string} path
 * @param {unknown} value
 */
export function setPath(object, path, value) {
  const keys = path.split(".");
  const last = /** @type {string} */ (keys.pop());
  let target = object;
  for (const key of keys) target = target[key] ??= {};
  target[last] = value;
}
