// @ts-check

/** @typedef {{id: string, name: string, parentId: string | null}} FolderRecord */

/**
 * @param {readonly FolderRecord[]} folders
 * @param {string | null} id
 * @returns {string[] | null}
 */
export function folderPath(folders, id) {
  /** @type {string[]} */
  const names = [];
  const seen = new Set();
  for (let at = id; at !== null; ) {
    const folder = folders.find((f) => f.id === at);
    if (!folder || seen.has(at)) return null;
    seen.add(at);
    names.unshift(folder.name);
    at = folder.parentId;
  }
  return names;
}

/**
 * @param {readonly FolderRecord[]} folders
 * @returns {{id: string, path: string[]}[]}
 */
export function listFolderPaths(folders) {
  return folders
    .flatMap((folder) => {
      const path = folderPath(folders, folder.id);
      return path ? [{ id: folder.id, path }] : [];
    })
    .sort((a, b) => a.path.join("\0").localeCompare(b.path.join("\0")));
}

/** @param {string[]} path @param {string[]} prefix */
export const isUnder = (path, prefix) => prefix.every((name, i) => path[i] === name);

/**
 * The folders at and under a path, and a test for paths in that scope. No path, or [], is everything.
 * @param {readonly FolderRecord[]} folders
 * @param {string[] | undefined} path
 * @returns {{folders: {id: string, path: string[]}[], inScope: (path: string[]) => boolean} | null} null when no folder
 *   has that path
 */
export function folderScope(folders, path) {
  const all = listFolderPaths(folders);
  const narrowed = path !== undefined && path.length > 0 ? path : null;
  if (narrowed && !all.some((entry) => entry.path.length === narrowed.length && isUnder(entry.path, narrowed))) {
    return null;
  }
  /** @param {string[]} candidate */
  const inScope = (candidate) => !narrowed || isUnder(candidate, narrowed);
  return { folders: all.filter((entry) => inScope(entry.path)), inScope };
}

/**
 * @param {readonly FolderRecord[]} folders
 * @param {readonly string[]} path
 * @returns {{chain: FolderRecord[], missing: string[], ambiguous: string[] | null}}
 */
export function resolveFolderPath(folders, path) {
  /** @type {FolderRecord[]} */
  const chain = [];
  for (const [i, name] of path.entries()) {
    const parentId = chain.at(-1)?.id ?? null;
    const matches = folders.filter((f) => f.parentId === parentId && f.name === name);
    if (matches.length > 1) return { chain, missing: [], ambiguous: path.slice(0, i + 1) };
    if (matches.length === 0) return { chain, missing: path.slice(i), ambiguous: null };
    chain.push(/** @type {FolderRecord} */ (matches[0]));
  }
  return { chain, missing: [], ambiguous: null };
}
