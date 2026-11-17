// @ts-check

import { getPath, setPath } from "./paths.mjs";

/** @typedef {import("./geometry.mjs").Point} Point */
/** @typedef {import("./geometry.mjs").Rect} Rect */
/** @typedef {{path: string}} LightField */

/** @type {Readonly<Record<string, LightField>>} */
export const LIGHT_FIELDS = Object.freeze({
  name: { path: "name" },
  bright: { path: "config.bright" },
  dim: { path: "config.dim" },
  color: { path: "config.color" },
  alpha: { path: "config.alpha" },
  angle: { path: "config.angle" },
  rotation: { path: "rotation" },
  "animation.type": { path: "config.animation.type" },
  "animation.speed": { path: "config.animation.speed" },
  "animation.intensity": { path: "config.animation.intensity" },
  "animation.reverse": { path: "config.animation.reverse" },
  walls: { path: "walls" },
  vision: { path: "vision" },
  hidden: { path: "hidden" },
  "darkness.min": { path: "config.darkness.min" },
  "darkness.max": { path: "config.darkness.max" },
  negative: { path: "config.negative" }
});

/**
 * @param {Record<string, any>} light
 * @param {Point} canvasPoint
 * @param {readonly string[]} levels
 * @param {Record<string, any>} flags
 * @returns {Record<string, any>}
 */
export function lightData(light, canvasPoint, levels, flags) {
  /** @type {Record<string, any>} */
  const data = { x: canvasPoint[0], y: canvasPoint[1], levels, flags };
  for (const [key, field] of Object.entries(LIGHT_FIELDS)) {
    const given = getPath(light, key);
    if (given !== undefined) setPath(data, field.path, given);
  }
  return data;
}

/**
 * @param {Record<string, any>} stored
 * @returns {Record<string, any>}
 */
export function lightFields(stored) {
  /** @type {Record<string, any>} */
  const light = {};
  const animated = getPath(stored, "config.animation.type") != null;
  for (const [key, field] of Object.entries(LIGHT_FIELDS)) {
    if (key.startsWith("animation.") && !animated) continue;
    const value = getPath(stored, field.path);
    if (value !== null && value !== undefined && value !== "") setPath(light, key, value);
  }
  return light;
}

/**
 * Foundry's light radius is max(dim, bright) in grid distance units (AmbientLightDocument#prepareDerivedData,
 * client/documents/ambient-light.mjs).
 * @param {readonly {x: number, y: number, config: {dim: number, bright: number, negative?: boolean}}[]} lights
 * @param {Rect} rect
 * @param {{size: number, distance: number}} grid
 * @param {{width: number, height: number}} image
 * @returns {{x: number, y: number, radius: number, negative: boolean}[]}
 */
export function lightMarkers(lights, rect, grid, image) {
  const sx = image.width / rect.width;
  const sy = image.height / rect.height;
  const pixelsPerUnit = grid.size / grid.distance;
  return lights.map(({ x, y, config }) => ({
    x: (x - rect.x) * sx,
    y: (y - rect.y) * sy,
    radius: Math.max(config.dim, config.bright) * pixelsPerUnit * ((sx + sy) / 2),
    negative: config.negative === true
  }));
}
