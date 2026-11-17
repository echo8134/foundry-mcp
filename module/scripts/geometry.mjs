// @ts-check

/** @typedef {{width: number, height: number}} Frame */
/** @typedef {[number, number]} Point */
/** @typedef {{x: number, y: number, width: number, height: number}} Rect */
/** @typedef {{points: Point[], closed?: boolean, kind?: import("./wall-kinds.mjs").WallKind, state?: import("./wall-kinds.mjs").DoorState}} WallPath */
/** @typedef {{c: [number, number, number, number], kind: import("./wall-kinds.mjs").WallKind, state?: import("./wall-kinds.mjs").DoorState}} Segment */

/**
 * @param {Point} point
 * @param {Frame} frame
 * @param {Rect} rect
 * @returns {Point}
 */
export function frameToCanvas([x, y], frame, rect) {
  return [Math.round(rect.x + (x * rect.width) / frame.width), Math.round(rect.y + (y * rect.height) / frame.height)];
}

/**
 * @param {Point} point
 * @param {Frame} frame
 * @param {Rect} rect
 * @returns {Point}
 */
export function canvasToFrame([x, y], frame, rect) {
  return [((x - rect.x) * frame.width) / rect.width, ((y - rect.y) * frame.height) / rect.height];
}

/**
 * @param {WallPath[]} paths
 * @param {Frame} frame
 * @param {Rect} rect
 * @returns {{segments: Segment[], skipped: number, unstorable: Point | null}}
 */
export function pathsToSegments(paths, frame, rect) {
  /** @type {Segment[]} */
  const segments = [];
  let skipped = 0;
  for (const path of paths) {
    const kind = path.kind ?? "wall";
    const points = path.points.map((p) => frameToCanvas(p, frame, rect));
    const unstorable = points.find((p) => !p.every(Number.isSafeInteger));
    if (unstorable) return { segments: [], skipped: 0, unstorable };
    const count = path.closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
      const a = /** @type {Point} */ (points[i]);
      const b = /** @type {Point} */ (points[(i + 1) % points.length]);
      if (a[0] === b[0] && a[1] === b[1]) skipped++;
      else segments.push({ c: [a[0], a[1], b[0], b[1]], kind, ...(path.state !== undefined && { state: path.state }) });
    }
  }
  return { segments, skipped, unstorable: null };
}
