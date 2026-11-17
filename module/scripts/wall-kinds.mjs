// @ts-check
// Presets follow WallsLayer.prepareSceneControls (client/canvas/layers/walls.mjs). Literals are, in
// common/constants.mjs, EDGE_SENSE_TYPES (NONE 0, LIMITED 10, NORMAL 20, PROXIMITY 30), WALL_DOOR_TYPES
// (NONE 0, DOOR 1, SECRET 2) and WALL_DOOR_STATES (CLOSED 0, OPEN 1, LOCKED 2).

/** @typedef {"wall" | "door" | "secret-door" | "window" | "terrain" | "invisible" | "ethereal"} WallKind */
/** @typedef {"closed" | "open" | "locked"} DoorState */
/** @typedef {{light: number, sight: number, sound: number, move: number, door: number}} WallBehavior */

/** @type {Readonly<Record<WallKind, Readonly<WallBehavior>>>} */
const WALL_KINDS = Object.freeze({
  wall: { light: 20, sight: 20, sound: 20, move: 20, door: 0 },
  door: { light: 20, sight: 20, sound: 20, move: 20, door: 1 },
  "secret-door": { light: 20, sight: 20, sound: 20, move: 20, door: 2 },
  window: { light: 30, sight: 30, sound: 20, move: 20, door: 0 },
  terrain: { light: 10, sight: 10, sound: 10, move: 20, door: 0 },
  invisible: { light: 0, sight: 0, sound: 0, move: 20, door: 0 },
  ethereal: { light: 20, sight: 20, sound: 0, move: 0, door: 0 }
});

/** @type {readonly WallKind[]} */
export const WALL_KIND_NAMES = /** @type {WallKind[]} */ (Object.keys(WALL_KINDS));

/** @type {Readonly<Record<DoorState, number>>} */
const DOOR_STATES = Object.freeze({ closed: 0, open: 1, locked: 2 });

/** @type {readonly DoorState[]} */
export const DOOR_STATE_NAMES = /** @type {DoorState[]} */ (Object.keys(DOOR_STATES));

/** @type {readonly WallKind[]} */
export const DOOR_KINDS = Object.freeze(/** @type {WallKind[]} */ (["door", "secret-door"]));

/**
 * @param {WallKind} kind
 * @param {number} gridDistance
 * @param {DoorState} [state]
 * @returns {WallBehavior & {ds?: number, threshold?: {light: number, sight: number, attenuation: boolean}}}
 */
export function wallFields(kind, gridDistance, state) {
  const fields = { ...WALL_KINDS[kind], ...(state !== undefined && { ds: DOOR_STATES[state] }) };
  if (kind !== "window") return fields;
  const threshold = 2 * gridDistance;
  return { ...fields, threshold: { light: threshold, sight: threshold, attenuation: true } };
}

/**
 * @param {WallBehavior} wall
 * @returns {WallKind | "custom"}
 */
export function classifyWall({ light, sight, sound, move, door }) {
  for (const kind of WALL_KIND_NAMES) {
    const row = WALL_KINDS[kind];
    if (row.light === light && row.sight === sight && row.sound === sound && row.move === move && row.door === door) {
      return kind;
    }
  }
  return "custom";
}
