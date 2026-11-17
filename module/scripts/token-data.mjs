// @ts-check

import { canvasToFrame } from "./geometry.mjs";
import { isManaged } from "./scope.mjs";

/** @typedef {import("./geometry.mjs").Frame} Frame */
/** @typedef {import("./geometry.mjs").Rect} Rect */

/**
 * Measured from the stored position and size. On the viewed scene the document's own x and y may be a frame of a
 * running animation, or clamped to the canvas (client/canvas/placeables/token.mjs:2423, :1408-1413).
 * @param {Record<string, any>} token
 * @returns {{x: number, y: number}} the token's centre in canvas pixels
 */
export const storedCentre = (token) => token.getCenterPoint(token._source);

/**
 * @param {Record<string, any>} token
 * @param {Frame} frame
 * @param {Rect} rect
 * @returns {import("./geometry.mjs").Point} the token's centre in the frame
 */
export function tokenCentre(token, frame, rect) {
  const { x, y } = storedCentre(token);
  return canvasToFrame([x, y], frame, rect);
}

/**
 * @param {Record<string, any>} token
 * @param {Frame} frame
 * @param {Rect} rect
 * @returns {Record<string, any>}
 */
export function tokenFields(token, frame, rect) {
  const hp = token.actor?.system?.attributes?.hp;
  return {
    id: token.id,
    name: token.name,
    actorId: token.actorId,
    actorLink: token.actorLink,
    at: tokenCentre(token, frame, rect),
    width: token.width,
    height: token.height,
    elevation: token.elevation,
    level: token.level,
    hidden: token.hidden,
    disposition: token.disposition,
    rotation: token.rotation,
    managed: isManaged(token),
    ...(hp && typeof hp === "object" && { hp: { value: hp.value, max: hp.max } })
  };
}

/**
 * The stored data in the shape update_tokens takes back: `id` for `_id`, and the centre `at` for the corner `x` and `y`.
 * Left out: an unlinked token's own actor data (`delta`), and the movement history and region ids Foundry keeps itself.
 * @param {Record<string, any>} token
 * @param {Frame} frame
 * @param {Rect} rect
 * @returns {Record<string, any>}
 */
export function storedTokenData(token, frame, rect) {
  const { _id, x: _x, y: _y, delta: _delta, _movementHistory, _regions, ...stored } = token._source;
  return { id: _id, at: tokenCentre(token, frame, rect), ...stored };
}

/**
 * The centre is given, not worked out from a corner: on a hex grid a token's centre is not the middle of its bounding
 * rectangle (BaseToken#getCenterPoint, common/documents/token.mjs:506).
 * @param {readonly {x: number, y: number, width: number, height: number, disposition: number, hidden: boolean}[]} tokens
 *   centre and size in canvas pixels
 * @param {Rect} rect
 * @param {{width: number, height: number}} image
 * @returns {{x: number, y: number, width: number, height: number, disposition: number, hidden: boolean}[]} centre and
 *   size in image pixels
 */
export function tokenMarkers(tokens, rect, image) {
  const sx = image.width / rect.width;
  const sy = image.height / rect.height;
  return tokens.map(({ x, y, width, height, disposition, hidden }) => ({
    x: (x - rect.x) * sx,
    y: (y - rect.y) * sy,
    width: width * sx,
    height: height * sy,
    disposition,
    hidden
  }));
}
