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

/**
 * What a lookup by name leads to. A write takes the one document of that name the bridge made. It takes none when
 * there are several, and none when the only ones of that name were made by hand: a name must never take over a
 * document someone made in Foundry.
 * @template {{flags?: any}} T
 * @param {readonly T[]} named the documents that have the name
 * @returns {{kind: "one", document: T} | {kind: "several", documents: T[]} | {kind: "handMade", documents: T[]} | {kind: "none"}}
 */
export function claimNamed(named) {
  const managed = named.filter(isManaged);
  const [document] = managed;
  if (document !== undefined && managed.length === 1) return { kind: "one", document };
  if (managed.length > 1) return { kind: "several", documents: managed };
  return named.length > 0 ? { kind: "handMade", documents: [...named] } : { kind: "none" };
}
