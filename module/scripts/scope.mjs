// @ts-check

import { MethodError } from "./errors.mjs";

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

/**
 * Whether a wall, a light or a region is on a level: one that names no levels is on every level
 * (CanvasDocument#includedInLevel, client/documents/abstract/canvas-document.mjs:97-105).
 * @param {{levels?: Iterable<string>}} document
 * @param {string} levelId
 */
export function isOnLevel(document, levelId) {
  const levels = [...(document.levels ?? [])];
  return levels.length === 0 || levels.includes(levelId);
}

/**
 * How many levels a wall, a light or a region is on, counted as Foundry counts them: one that names no levels is on
 * every level of its scene (CanvasDocument#includedInLevel, client/documents/abstract/canvas-document.mjs:97-105).
 * @param {Iterable<string> | undefined} levels
 * @param {Iterable<string>} sceneLevelIds
 */
export const levelCount = (levels, sceneLevelIds) => [...(levels ?? [])].length || [...sceneLevelIds].length;

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
 * The entries of a sync that the sync is about, each with its place in the request. An entry of get_scene can be
 * passed back as it is: one that says it was made by hand (managed: false) and one whose own levels are another level
 * set than the call's exists already, and the sync does not own it, so it is left out. A call whose entries were all
 * left out is refused, because it would otherwise remove everything the bridge made on the level set.
 * @template {{managed?: boolean, levels?: Iterable<string>}} T
 * @param {readonly T[]} entries
 * @param {readonly string[]} levels the levels of the call
 * @param {Iterable<string>} sceneLevelIds
 * @param {string} noun what the entries are, in the plural, which is also the name of their list in the request
 * @returns {{entry: T, index: number}[]}
 */
export function ownedEntries(entries, levels, sceneLevelIds, noun) {
  const all = [...sceneLevelIds];
  const owned = entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) => entry.managed !== false && (entry.levels === undefined || sameLevelSet(entry.levels, levels, all))
    );
  if (entries.length > 0 && owned.length === 0) {
    throw new MethodError(
      "invalid_params",
      `All ${entries.length} given ${noun} were left out: each is marked managed: false, which is one made by hand, or has levels of its own that are another level set than this call's (${levels.length > 0 ? levels.join(", ") : "none, which means all levels"}). A sync never touches those. Pass the levels of these ${noun} as the call's levels, or ${noun}: [] to remove the bridge-made ${noun} of this level set. Nothing was written.`
    );
  }
  return owned;
}

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
