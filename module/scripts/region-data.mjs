// @ts-check
// A scene's levels and the shapes of its regions, as the tools give and take them. Foundry stores a shape in canvas
// pixels (common/data/data.mjs:214-560). A tool gives and takes it in the frame of the call, as it does a wall.

import { isPlainObject } from "./data-diff.mjs";
import { canvasToFrame, frameToCanvas } from "./geometry.mjs";

/** @typedef {import("./geometry.mjs").Frame} Frame */
/** @typedef {import("./geometry.mjs").Point} Point */
/** @typedef {import("./geometry.mjs").Rect} Rect */
/** @typedef {Record<string, any>} Shape */
/**
 * @typedef {object} ShapeSpec what a shape type holds that depends on the frame
 * @property {true} [at] a point in `x` and `y`
 * @property {readonly [string, string]} [sides] two lengths above 0 that lie along the axes until the shape is turned
 * @property {readonly string[]} [radii] lengths above 0 that have no direction
 * @property {readonly string[]} [reach] lengths without a direction that may be 0
 * @property {true} [points] the corners of a polygon
 * @property {true} [origin] a point in `origin` that may be null
 * @property {true} [base] the shape an emanation surrounds, in `base`
 */

/**
 * Foundry's shape types (common/data/data.mjs:214-560). What a type holds besides, such as a cone's angle, a token
 * shape's size in grid cells or a grid shape's cells, is the same in every frame.
 * @type {Readonly<Record<string, ShapeSpec>>}
 */
const SHAPES = Object.freeze({
  rectangle: { at: true, sides: ["width", "height"] },
  circle: { at: true, radii: ["radius"] },
  ellipse: { at: true, sides: ["radiusX", "radiusY"] },
  cone: { at: true, radii: ["radius"] },
  ring: { at: true, reach: ["radius", "innerWidth", "outerWidth"] },
  line: { at: true, sides: ["length", "width"] },
  token: { at: true },
  polygon: { points: true, origin: true },
  grid: { origin: true },
  emanation: { base: true, reach: ["radius"] }
});

const SHAPE_TYPES = Object.freeze(Object.keys(SHAPES));

/** @param {unknown} value @returns {value is number} */
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** @param {unknown} value @returns {value is Point} */
const isPoint = (value) => Array.isArray(value) && value.length === 2 && value.every(isNumber);

/** @param {unknown} shape @returns {ShapeSpec | undefined} */
const specOf = (shape) =>
  isPlainObject(shape) && typeof shape.type === "string" && Object.hasOwn(SHAPES, shape.type)
    ? SHAPES[shape.type]
    : undefined;

/**
 * One way between the two coordinate systems: where a point goes, what a length along each axis is multiplied by, and
 * what is kept of a length and of a polygon's points.
 * @typedef {{point: (point: Point) => Point, sx: number, sy: number, length: (value: number) => number,
 *   points: (points: any[], point: (point: Point) => Point) => unknown[]}} Way
 */

/** @param {readonly number[]} flat x and y in turn @returns {Point[]} */
function pairsOf(flat) {
  /** @type {Point[]} */
  const pairs = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    pairs.push([/** @type {number} */ (flat[index]), /** @type {number} */ (flat[index + 1])]);
  }
  return pairs;
}

/**
 * Foundry scales the two sides of a shape each by its own axis while the shape lies along the axes, and both by the
 * mean of the two scales once it is turned off them (client/documents/scene.mjs:1157-1168).
 * @param {unknown} rotation
 * @param {Way} way
 * @returns {[number, number]}
 */
function sideScales(rotation, { sx, sy }) {
  const turned = (((isNumber(rotation) ? rotation : 0) % 360) + 360) % 360;
  if (turned === 0 || turned === 180) return [sx, sy];
  if (turned === 90 || turned === 270) return [sy, sx];
  return [(sx + sy) / 2, (sx + sy) / 2];
}

/**
 * A shape of a type this module does not know is handed on as it is.
 * @param {Shape} shape
 * @param {Way} way
 * @returns {Shape}
 */
function convert(shape, way) {
  const spec = specOf(shape);
  if (!spec) return shape;
  const out = { ...shape };
  /** @param {string} key @param {number} factor */
  const scale = (key, factor) => {
    if (isNumber(shape[key])) out[key] = way.length(shape[key] * factor);
  };
  if (spec.at) [out.x, out.y] = way.point([shape.x, shape.y]);
  if (spec.sides) {
    const [first, second] = sideScales(shape.rotation, way);
    scale(spec.sides[0], first);
    scale(spec.sides[1], second);
  }
  for (const key of [...(spec.radii ?? []), ...(spec.reach ?? [])]) scale(key, (way.sx + way.sy) / 2);
  if (spec.points) out.points = way.points(shape.points, way.point);
  if (spec.origin && shape.origin) {
    const [x, y] = way.point([shape.origin.x, shape.origin.y]);
    out.origin = { x, y };
  }
  if (spec.base) out.base = convert(shape.base, way);
  return out;
}

/**
 * A stored shape in the frame, with a polygon's points as pairs.
 * @param {Shape} stored
 * @param {Frame} frame
 * @param {Rect} rect
 * @returns {Shape}
 */
export function shapeInFrame(stored, frame, rect) {
  return convert(stored, {
    point: (point) => canvasToFrame(point, frame, rect),
    sx: frame.width / rect.width,
    sy: frame.height / rect.height,
    length: (value) => value,
    points: (flat, point) => pairsOf(flat).map(point)
  });
}

/** @param {Shape} shape @returns {string[]} what the conversion cannot work with, each as a sentence */
function inputProblems(shape) {
  const spec = specOf(shape);
  if (!spec) return [`its type must be one of ${SHAPE_TYPES.join(", ")}.`];
  const problems = [];
  if (spec.at && !(isNumber(shape.x) && isNumber(shape.y))) problems.push("x and y must be numbers.");
  const lengths = [...(spec.sides ?? []), ...(spec.radii ?? []), ...(spec.reach ?? [])];
  const unmeasured = lengths.filter((key) => shape[key] !== undefined && !isNumber(shape[key]));
  if (unmeasured.length > 0) problems.push(`${unmeasured.join(" and ")} must be a number.`);
  if (spec.points && !(Array.isArray(shape.points) && shape.points.length >= 3 && shape.points.every(isPoint))) {
    problems.push("points must be at least 3 points, each as [x, y].");
  }
  if (
    spec.origin &&
    shape.origin != null &&
    !(isPlainObject(shape.origin) && isPoint([shape.origin.x, shape.origin.y]))
  ) {
    problems.push("origin must be {x, y} or null.");
  }
  if (spec.base) problems.push(...inputProblems(shape.base).map((problem) => `base: ${problem}`));
  return problems;
}

/** @param {Shape} shape a shape in canvas pixels @returns {string[]} what Foundry could not store or draw of it */
function canvasProblems(shape) {
  const spec = /** @type {ShapeSpec} */ (specOf(shape));
  const problems = [];
  const flat = [
    ...(spec.at ? [shape.x, shape.y] : []),
    ...(spec.points ? shape.points : []),
    ...(spec.origin && shape.origin ? [shape.origin.x, shape.origin.y] : [])
  ];
  if (!flat.every(Number.isSafeInteger)) {
    problems.push("a coordinate is too large once converted to scene pixels (the bridge stores only safe integers).");
  }
  const collapsed = [...(spec.sides ?? []), ...(spec.radii ?? [])].filter((key) => !(shape[key] > 0));
  if (collapsed.length > 0) {
    problems.push(`${collapsed.join(" and ")} must be above 0 once rounded to whole scene pixels at this frame.`);
  }
  if (spec.points && shape.points.length < 6) {
    problems.push("fewer than 3 of its points are apart once converted to scene pixels, so it encloses nothing.");
  }
  if (spec.base) problems.push(...canvasProblems(shape.base).map((problem) => `base: ${problem}`));
  return problems;
}

/**
 * The corners as Foundry stores them, in one flat list, without a corner that falls on the one before it: a polygon
 * may have no edge of length 0 but the one that closes it (common/data/data.mjs:469-471).
 * @param {Point[]} pairs
 * @param {(point: Point) => Point} point
 * @returns {number[]}
 */
function storedCorners(pairs, point) {
  /** @type {Point[]} */
  const corners = [];
  for (const [x, y] of pairs.map(point)) {
    const last = corners.at(-1);
    if (!last || last[0] !== x || last[1] !== y) corners.push([x, y]);
  }
  const [first, last] = [corners[0], corners.at(-1)];
  if (corners.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) corners.pop();
  return corners.flat();
}

/**
 * A shape given in the frame as Foundry stores it: points and lengths in whole scene pixels, so that the same input
 * always stores the same shape, and a polygon's points in one flat list.
 * @param {Shape} given
 * @param {Frame} frame
 * @param {Rect} rect
 * @returns {{shape: Shape, problems: string[]}} the shape in canvas pixels, and why it cannot be stored, each as a
 *   sentence. With a problem the shape is the given one.
 */
export function shapeOnCanvas(given, frame, rect) {
  const unusable = inputProblems(given);
  if (unusable.length > 0) return { shape: given, problems: unusable };
  const shape = convert(given, {
    point: (point) => frameToCanvas(point, frame, rect),
    sx: rect.width / frame.width,
    sy: rect.height / frame.height,
    length: Math.round,
    points: storedCorners
  });
  return { shape, problems: canvasProblems(shape) };
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

/**
 * @param {readonly {name: string, color: string, contours: readonly (readonly number[])[]}[]} regions each with the
 *   outlines of its area in canvas pixels, a hole being an outline inside another
 * @param {Rect} rect
 * @param {{width: number, height: number}} image
 * @returns {{name: string, color: string, contours: Point[][], label: Point | null}[]} the outlines in image pixels,
 *   and the middle of the box around them, where the name goes
 */
export function regionMarkers(regions, rect, image) {
  const sx = image.width / rect.width;
  const sy = image.height / rect.height;
  return regions.map(({ name, color, contours }) => {
    const outlines = contours.map((flat) =>
      pairsOf(flat).map(([x, y]) => /** @type {Point} */ ([(x - rect.x) * sx, (y - rect.y) * sy]))
    );
    const all = outlines.flat();
    const xs = all.map(([x]) => x);
    const ys = all.map(([, y]) => y);
    /** @type {Point | null} */
    const label =
      all.length > 0 ? [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2] : null;
    return { name, color, contours: outlines, label };
  });
}
