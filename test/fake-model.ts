// What Foundry's data model does to given data, for the stand-in fields of fake-system.ts: how it cleans a value before
// it validates it, and what it then refuses. Written from the behavior measured on the real token model of Foundry
// 14.370, field kind by field kind.

import {
  AngleField,
  ArrayField,
  BooleanField,
  ColorField,
  type DataField,
  FilePathField,
  NumberField,
  ObjectField,
  SchemaField,
  StringField,
  TypedObjectField
} from "./fake-system.ts";

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Stands in a cleaned change for Foundry's deletion operator, which `{"-=key": null}` is turned into. */
export const DELETED = Symbol("deleted");

/** A step of 0.01 keeps two decimals, and so on. */
function toNearest(value: number, step: number) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

/**
 * Foundry's colour and file path fields take no empty string unless built to (common/data/fields.mjs:3670, :3736),
 * other string fields take one unless built with `blank: false`.
 */
const takesBlank = (field: DataField) =>
  field.blank ?? !(field instanceof ColorField || field instanceof FilePathField);

/**
 * Measured: "blue" and "black" are stored as #00000b, "beige" as #0000be, "#F80" as #000f80 and "ff8800" as #ff8800.
 * The text is read as a hexadecimal number from its start, with or without a leading #, as far as it holds hex digits.
 */
function hexColour(text: string) {
  const number = Number.parseInt(text.startsWith("#") ? text.slice(1) : text, 16);
  return Number.isNaN(number) ? text : `#${number.toString(16).padStart(6, "0")}`;
}

function initialOf(field: DataField): unknown {
  if (field.initial !== undefined) return typeof field.initial === "function" ? field.initial() : field.initial;
  if (field instanceof SchemaField) return cleanValue(field, {}, { partial: false });
  if (field instanceof ObjectField) return {};
  if (field instanceof ArrayField) return [];
  if (field instanceof BooleanField) return false;
  if (field instanceof StringField && field.nullable !== true) return "";
  return field.nullable === true ? null : undefined;
}

/** A key with a dot becomes nested objects, and `-=key` with null marks the key for deletion. */
function expandKeys(data: Record<string, any>) {
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("-=") && value === null) {
      delete data[key];
      data[key.slice(2)] = DELETED;
    } else if (key.includes(".")) {
      delete data[key];
      const parts = key.split(".");
      let node = data;
      for (const part of parts.slice(0, -1)) {
        if (!isObject(node[part])) node[part] = {};
        node = node[part];
      }
      node[parts.at(-1)!] = value;
    }
  }
}

type CleanOptions = { partial: boolean; source?: unknown };

/**
 * The value Foundry would store for a given one. A missing value, and null where the field does not take it, become
 * the field's initial value. A value of another type is cast and not refused: a string for a boolean is true only when
 * it reads "true", a numeric string becomes its number, a number for a string its text, anything but an object for a
 * schema an empty object. Numbers are rounded to an integer or a step and an angle is brought into 0 to 360, strings
 * are trimmed, an empty one where the field takes none becomes the initial value, and a colour is read as a hex
 * number. A schema drops the keys it does not have. Where the update is partial and the stored data has the object,
 * only the given keys are cleaned; an object that is new, and every array element, gets all its defaults.
 */
export function cleanValue(field: DataField, value: unknown, { partial, source }: CleanOptions): unknown {
  if (value === DELETED) return value;
  if (value === undefined) return initialOf(field);
  if (value === null) return field.nullable === true ? null : initialOf(field);
  if (field instanceof BooleanField) {
    if (typeof value === "string") return value === "true";
    return typeof value === "object" ? false : Boolean(value);
  }
  if (field instanceof NumberField) {
    const number = typeof value === "string" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number)) return value;
    if (field instanceof AngleField) return ((number % 360) + 360) % 360;
    if (field.integer === true) return Math.round(number);
    return typeof field.step === "number" ? toNearest(number, field.step) : number;
  }
  if (field instanceof StringField) {
    if (typeof value === "number") return String(value);
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (text === "" && !takesBlank(field)) return initialOf(field);
    return field instanceof ColorField ? hexColour(text) : text;
  }
  if (field instanceof SchemaField) {
    const data: Record<string, any> = isObject(value) ? value : {};
    expandKeys(data);
    const all = !partial || !isObject(source);
    for (const key of Object.keys(data)) if (!Object.hasOwn(field.fields, key)) delete data[key];
    for (const [key, child] of Object.entries<DataField>(field.fields)) {
      if (key in data || all) data[key] = cleanValue(child, data[key], { partial, source: (source as any)?.[key] });
    }
    return data;
  }
  if (field instanceof TypedObjectField) {
    const data: Record<string, any> = isObject(value) ? value : {};
    expandKeys(data);
    for (const key of Object.keys(data)) {
      data[key] = cleanValue(field.element, data[key], { partial, source: (source as any)?.[key] });
    }
    return data;
  }
  if (field instanceof ArrayField) {
    const list = Array.isArray(value) ? value : [value];
    return list.map((element) => cleanValue(field.element, element, { partial: false }));
  }
  if (field instanceof ObjectField) return isObject(value) ? value : {};
  return value;
}

/** The complaints Foundry's validation has about cleaned data, each with the path of its field. */
export function validationErrors(field: DataField, value: unknown, path = ""): string[] {
  const fail = (message: string) => [`${path}: ${message}`];
  if (value === DELETED) return [];
  if (value === null) return field.nullable === true ? [] : fail("may not be null");
  if (value === undefined) return [];
  if (field instanceof BooleanField) return typeof value === "boolean" ? [] : fail("must be a boolean");
  if (field instanceof NumberField) {
    if (typeof value !== "number" || !Number.isFinite(value)) return fail("must be a number");
    if (field.positive === true && !(value > 0)) return fail("must be a positive number");
    if (typeof field.min === "number" && value < field.min) return fail(`must be at least ${field.min}`);
    if (typeof field.max === "number" && value > field.max) return fail(`must be at most ${field.max}`);
    if (Array.isArray(field.choices) && !field.choices.includes(value)) return fail(`${value} is not a valid choice`);
    return [];
  }
  if (field instanceof ColorField && !(typeof value === "string" && /^#[0-9a-f]{6}$/.test(value))) {
    return fail("must be a valid color string");
  }
  if (field instanceof StringField) return typeof value === "string" ? [] : fail("must be a string");
  if (field instanceof SchemaField) {
    if (!isObject(value)) return fail("must be an object");
    return Object.entries<DataField>(field.fields).flatMap(([key, child]) =>
      validationErrors(child, value[key], path ? `${path}.${key}` : key)
    );
  }
  if (field instanceof TypedObjectField) {
    if (!isObject(value)) return fail("must be an object");
    return Object.entries(value).flatMap(([key, child]) => validationErrors(field.element, child, `${path}.${key}`));
  }
  if (field instanceof ArrayField) {
    if (!Array.isArray(value)) return fail("must be an Array");
    return value.flatMap((element, index) => validationErrors(field.element, element, `${path}.${index}`));
  }
  return [];
}

/** Merges cleaned changes into stored data as an update does: objects key by key, anything else replaced whole. */
export function applyChanges(target: Record<string, any>, changes: Record<string, any>) {
  for (const [key, value] of Object.entries(changes)) {
    if (value === DELETED) delete target[key];
    else if (isObject(value) && isObject(target[key])) applyChanges(target[key], value);
    else target[key] = isObject(value) ? applyChanges({}, value) : value;
  }
  return target;
}
