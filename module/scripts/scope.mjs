// @ts-check

export const FLAG_SCOPE = "foundry-mcp";

/**
 * @param {Iterable<string> | undefined} a
 * @param {Iterable<string> | undefined} b */
export function sameLevels(a, b) {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * An empty set means all levels (CanvasDocument#includedInLevel, client/documents/abstract/canvas-document.mjs).
 * @param {Iterable<string> | undefined} levels
 * @param {Iterable<string>} sceneLevelIds
 */
export function restrictingLevels(levels, sceneLevelIds) {
  const set = new Set(levels ?? []);
  const all = [...sceneLevelIds];
  return all.length > 0 && all.every((id) => set.has(id)) ? new Set() : set;
}

/** @param {{flags?: any}} document */
export const isManaged = (document) => document.flags?.[FLAG_SCOPE]?.managed === true;

/**
 * @param {Iterable<string> | undefined} a
 * @param {Iterable<string> | undefined} b
 * @param {Iterable<string>} sceneLevelIds
 */
export const sameLevelSet = (a, b, sceneLevelIds) =>
  sameLevels(restrictingLevels(a, sceneLevelIds), restrictingLevels(b, sceneLevelIds));

/**
 * @param {{flags?: any, levels?: Iterable<string>}} document
 * @param {readonly string[]} levels
 * @param {Iterable<string>} sceneLevelIds
 */
export const replacedBySync = (document, levels, sceneLevelIds) =>
  isManaged(document) && sameLevelSet(document.levels, levels, sceneLevelIds);
