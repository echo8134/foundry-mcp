// @ts-check

import { canvasToFrame } from "./geometry.mjs";
import { isManaged } from "./scope.mjs";

/** @typedef {import("./geometry.mjs").Frame} Frame */
/** @typedef {import("./geometry.mjs").Rect} Rect */

/**
 * @param {Record<string, any>} token
 * @param {Frame} frame
 * @param {Rect} rect
 * @returns {Record<string, any>}
 */
export function tokenFields(token, frame, rect) {
  const center = token.getCenterPoint();
  const hp = token.actor?.system?.attributes?.hp;
  return {
    id: token.id,
    name: token.name,
    actorId: token.actorId,
    actorLink: token.actorLink,
    at: canvasToFrame([center.x, center.y], frame, rect),
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
