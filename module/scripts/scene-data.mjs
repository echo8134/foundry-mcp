// @ts-check
// Literals are CONST.GRID_TYPES (GRIDLESS 0, SQUARE 1) and CONST.FOG_EXPLORATION_MODES (DISABLED 0, INDIVIDUAL 1),
// common/constants.mjs.

import { getPath, setPath } from "./paths.mjs";

/** @typedef {{on: "scene" | "level", path: string, encode?: (value: any) => unknown, decode?: (stored: any) => unknown, thumbnail?: true, geometry?: true}} SceneField */

const GRID_TYPE_CODES = Object.freeze({ gridless: 0, square: 1 });
/** @param {number} code */
const gridTypeName = (code) => Object.entries(GRID_TYPE_CODES).find(([, value]) => value === code)?.[0] ?? "hex";

/** shiftX and shiftY are nullable NumberFields (common/documents/scene.mjs), and Foundry reads a stored null as 0. */
const nullAsZero = (/** @type {number | null} */ stored) => stored ?? 0;

/** @type {Readonly<Record<string, SceneField>>} */
const SCENE_FIELDS = Object.freeze({
  name: { on: "scene", path: "name" },
  folder: { on: "scene", path: "folder" },
  navName: { on: "scene", path: "navName" },
  navigation: { on: "scene", path: "navigation" },
  width: { on: "scene", path: "width", thumbnail: true, geometry: true },
  height: { on: "scene", path: "height", thumbnail: true, geometry: true },
  padding: { on: "scene", path: "padding", geometry: true },
  shiftX: { on: "scene", path: "shiftX", geometry: true, decode: nullAsZero },
  shiftY: { on: "scene", path: "shiftY", geometry: true, decode: nullAsZero },
  "grid.type": {
    on: "scene",
    path: "grid.type",
    geometry: true,
    encode: (/** @type {keyof typeof GRID_TYPE_CODES} */ type) => GRID_TYPE_CODES[type],
    decode: gridTypeName
  },
  "grid.size": { on: "scene", path: "grid.size", geometry: true },
  "grid.distance": { on: "scene", path: "grid.distance" },
  "grid.units": { on: "scene", path: "grid.units" },
  tokenVision: { on: "scene", path: "tokenVision" },
  fogExploration: {
    on: "scene",
    path: "fog.mode",
    encode: (/** @type {boolean} */ on) => (on ? 1 : 0),
    decode: (/** @type {number} */ mode) => mode !== 0
  },
  globalLight: { on: "scene", path: "environment.globalLight.enabled" },
  darkness: { on: "scene", path: "environment.darknessLevel" },
  weather: { on: "scene", path: "weather" },
  "background.src": { on: "level", path: "background.src", thumbnail: true }
});

/** @param {readonly string[]} changed */
export const touchesThumbnail = (changed) => changed.some((key) => SCENE_FIELDS[key]?.thumbnail === true);

/** @param {readonly string[]} changed */
export const touchesGeometry = (changed) => changed.some((key) => SCENE_FIELDS[key]?.geometry === true);

/**
 * @param {Record<string, any>} input
 * @param {{scene: Record<string, any>, level: Record<string, any>}} current
 * @returns {{scene: Record<string, any>, level: Record<string, any>, changed: string[]}}
 */
export function planSceneChanges(input, current) {
  /** @type {{scene: Record<string, any>, level: Record<string, any>, changed: string[]}} */
  const plan = { scene: {}, level: {}, changed: [] };
  for (const [key, field] of Object.entries(SCENE_FIELDS)) {
    const given = getPath(input, key);
    if (given === undefined) continue;
    const stored = getPath(current[field.on], field.path);
    if (stored !== undefined && (field.decode ? field.decode(stored) : stored) === given) continue;
    setPath(plan[field.on], field.path, field.encode ? field.encode(given) : given);
    plan.changed.push(key);
  }
  return plan;
}

/**
 * @param {{sceneX: number, sceneY: number, sceneWidth: number, sceneHeight: number, width: number, height: number}} dimensions
 * @param {{x: number, y: number}} shift
 * @returns {{axis: "x" | "y", shift: number, over: number, min: number, max: number}[]}
 */
export function canvasOverflow({ sceneX, sceneY, sceneWidth, sceneHeight, width, height }, shift) {
  return /** @type {const} */ ([
    ["x", sceneX, sceneWidth, width],
    ["y", sceneY, sceneHeight, height]
  ]).flatMap(([axis, origin, size, canvasSize]) => {
    const over = Math.max(-origin, origin + size - canvasSize);
    const k = shift[axis];
    return over > 0
      ? [{ axis, shift: k, over, min: Math.ceil(origin + k + size - canvasSize), max: Math.floor(origin + k) }]
      : [];
  });
}

/**
 * @param {Record<string, any>} input
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function unknownSceneFields(input, prefix = "") {
  const known = Object.keys(SCENE_FIELDS);
  return Object.entries(input).flatMap(([key, value]) => {
    const path = prefix + key;
    if (prefix === "" && key === "sceneId") return [];
    if (known.includes(path)) return [];
    if (known.some((name) => name.startsWith(`${path}.`)) && typeof value === "object" && value !== null) {
      return unknownSceneFields(value, `${path}.`);
    }
    return [path];
  });
}

/**
 * @template {{name: string, folderId: string | null}} T
 * @param {readonly T[]} scenes
 * @param {string} name
 * @param {string | null} folderId
 * @returns {T[]}
 */
export function scenesNamed(scenes, name, folderId) {
  return scenes.filter((scene) => scene.name === name && scene.folderId === folderId);
}

/**
 * What get_scene says of a level, from its stored data, where an elevation without a bound is null
 * (common/documents/level.mjs:74-116, ExtendedNumberField at common/data/fields.mjs:1655).
 * @param {Record<string, any>} level
 * @param {string | undefined} initialId the id of the scene's initial level
 * @returns {Record<string, any>}
 */
export function levelFields(level, initialId) {
  const { sort, elevation, background, foreground, textures, visibility } = level._source;
  return {
    id: level.id,
    name: level.name,
    sort,
    initial: level.id === initialId,
    elevation: { bottom: elevation.bottom, top: elevation.top },
    background: { src: background.src, color: background.color },
    foreground: { src: foreground.src },
    textures: { ...textures },
    visibility: { levels: [...visibility.levels] }
  };
}
