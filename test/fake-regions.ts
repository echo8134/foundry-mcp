// Stand-ins for what Foundry does with a region: the fields of its shapes, the outlines of its area, and the UUIDs a
// region behavior stores relative to itself. Written from the Foundry 14.370 source, each with its place there.

import { isObject } from "./fake-model.ts";
import {
  AngleField,
  ArrayField,
  BooleanField,
  type DataField,
  DocumentUUIDField,
  NumberField,
  SchemaField,
  StringField,
  TypedSchemaField
} from "./fake-system.ts";

type Source = Record<string, any>;

const coordinate = () => new NumberField({ required: true });
const length = () => new NumberField({ required: true, min: 0 });
const turned = () => new AngleField({ initial: 0 });
const onGrid = () => new BooleanField({ initial: false });
const origin = () => new SchemaField({ x: coordinate(), y: coordinate() }, { nullable: true, initial: null });

/**
 * The shapes of a region, each type with the fields and initial values of Foundry's data model for it
 * (common/data/data.mjs:127-560). An emanation surrounds a shape of any type but its own and a ring (:330-331).
 */
export function shapeTypes(inEmanation = false): Record<string, SchemaField> {
  const shape = (type: string, own: Record<string, DataField>) =>
    new SchemaField({
      type: new StringField({ required: true, blank: false, initial: type }),
      hole: new BooleanField({ initial: false }),
      ...own
    });
  const types: Record<string, SchemaField> = {
    rectangle: shape("rectangle", {
      x: coordinate(),
      y: coordinate(),
      width: length(),
      height: length(),
      anchorX: new NumberField({ initial: 0 }),
      anchorY: new NumberField({ initial: 0 }),
      rotation: turned(),
      gridBased: onGrid()
    }),
    circle: shape("circle", { x: coordinate(), y: coordinate(), radius: length(), gridBased: onGrid() }),
    ellipse: shape("ellipse", {
      x: coordinate(),
      y: coordinate(),
      radiusX: length(),
      radiusY: length(),
      rotation: turned(),
      gridBased: onGrid()
    }),
    cone: shape("cone", {
      x: coordinate(),
      y: coordinate(),
      radius: length(),
      angle: new NumberField({ required: true, min: 0, max: 360 }),
      rotation: turned(),
      curvature: new StringField({ initial: "round" }),
      gridBased: onGrid()
    }),
    line: shape("line", {
      x: coordinate(),
      y: coordinate(),
      length: length(),
      width: length(),
      rotation: turned(),
      gridBased: onGrid()
    }),
    polygon: shape("polygon", { points: new ArrayField(coordinate()), origin: origin() }),
    token: shape("token", {
      x: new NumberField({ required: true, integer: true }),
      y: new NumberField({ required: true, integer: true }),
      width: new NumberField({ required: true, positive: true }),
      height: new NumberField({ required: true, positive: true }),
      shape: new NumberField({ required: true, choices: [0, 1, 2, 3, 4, 5] })
    }),
    grid: shape("grid", {
      offsets: new ArrayField(
        new SchemaField({
          i: new NumberField({ required: true, integer: true }),
          j: new NumberField({ required: true, integer: true })
        })
      ),
      origin: origin()
    })
  };
  if (inEmanation) return types;
  return {
    ...types,
    ring: shape("ring", {
      x: coordinate(),
      y: coordinate(),
      radius: length(),
      innerWidth: length(),
      outerWidth: length(),
      gridBased: onGrid()
    }),
    emanation: shape("emanation", {
      base: new TypedSchemaField(shapeTypes(true)),
      radius: length(),
      gridBased: onGrid()
    })
  };
}

/**
 * Stands in for RegionDocument#polygons (client/documents/region.mjs:50-61), the outlines of a region's area that
 * Foundry works out of its shapes, a hole being an outline inside another. The fake gives each shape its own outline,
 * and knows a polygon and a rectangle that is not turned.
 */
export function outlineOf(shape: Source): { points: number[] } {
  if (shape.type === "polygon") return { points: [...shape.points] };
  if (shape.type !== "rectangle" || shape.rotation !== 0)
    throw new Error(`The fake draws no outline of ${shape.type}.`);
  const left = shape.x - shape.anchorX * shape.width;
  const top = shape.y - shape.anchorY * shape.height;
  const [right, bottom] = [left + shape.width, top + shape.height];
  return { points: [left, top, right, top, right, bottom, left, bottom] };
}

/**
 * buildRelativeUuid (common/utils/helpers.mjs:1474-1507) for world documents: the way from the origin up to the
 * document both lie in, a dot for each step, and down to the target. The document type of the target is left out
 * where it is the one of the document the way last left.
 */
function relativeUuid(target: string, origin: string): string {
  const parts = origin.split(".");
  let prefix = origin;
  let left: string | undefined;
  for (let ups = 0; ; ups++) {
    if (target === prefix) return ".".repeat(ups + 1);
    if (target.startsWith(`${prefix}.`)) {
      const rest = target.slice(prefix.length);
      return left && rest.startsWith(`.${left}.`)
        ? ".".repeat(ups - 1) + rest.slice(left.length + 1)
        : ".".repeat(ups) + rest;
    }
    left = parts.at(-2)!;
    parts.length -= 2;
    if (parts.length === 0) return target.startsWith(`${left}.`) ? ".".repeat(ups) + target.slice(left.length) : target;
    prefix = parts.join(".");
  }
}

/**
 * The UUID a relative one names (common/utils/helpers.mjs:1386-1451), for world documents: each dot after the first
 * goes up one document, and what follows names a document below that one, or beside it when it begins with an id.
 */
export function absoluteUuid(uuid: string, relative: any): string | null {
  let ups = 1;
  while (uuid[ups] === ".") ups++;
  const rest = uuid.slice(ups);
  let document = relative;
  while (--ups && document) document = document.parent;
  if (!document) return null;
  if (!rest) return document.uuid;
  if (rest.split(".").length % 2 === 0) return `${document.uuid}.${rest}`;
  return document.parent
    ? `${document.parent.uuid}.${document.documentName}.${rest}`
    : `${document.documentName}.${rest}`;
}

/**
 * DocumentUUIDField#_cleanType (common/data/fields.mjs:3530-3539): where the field asks for it, an absolute UUID
 * becomes one relative to the document it is cleaned for. A document that is not stored yet has no UUID to be
 * relative to, and keeps the UUID as given.
 */
export function relativized(field: DataField, value: unknown, origin: string | null): unknown {
  if (origin === null) return value;
  if (field instanceof DocumentUUIDField) {
    const absolute = field.relative && field.relativize && typeof value === "string" && !value.startsWith(".");
    return absolute ? relativeUuid(value as string, origin) : value;
  }
  if (field instanceof SchemaField && isObject(value)) {
    for (const [key, child] of Object.entries<DataField>(field.fields)) {
      if (key in value) value[key] = relativized(child, value[key], origin);
    }
  } else if (field instanceof ArrayField && Array.isArray(value)) {
    return value.map((element) => relativized(field.element, element, origin));
  }
  return value;
}
