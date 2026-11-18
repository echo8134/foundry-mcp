// What the system data of a region behavior says of other documents: the destinations of a teleportToken, and the
// behaviors a toggleBehavior switches. Foundry stores such a UUID relative to the behavior that holds it
// (common/data/fields.mjs:3530-3539), "..<id>" for a region of the same scene. The tools give and take the absolute
// UUID, and compare two spellings by the document they name. A region may also be named by its name before it exists:
// sync_regions keeps such a name on the behavior, in the bridge's own flag, until a region has it.

import { isPlainObject } from "./data-diff.mjs";
import { FLAG_SCOPE, isManaged } from "./scope.mjs";

/**
 * The fields of a behavior type's system data whose UUIDs Foundry stores relative to the behavior, read from the data
 * model of the type (client/data/region-behaviors/teleport-token.mjs:46, toggle-behavior.mjs:36-37).
 * @param {string} type
 * @returns {{key: string, list: boolean, names: string | undefined}[]} each with whether it holds a list of UUIDs or
 *   one, and the document type its UUIDs name
 */
export function referenceFields(type) {
  const model = CONFIG.RegionBehavior.documentClass.schema.fields.system.getModelForType?.(type);
  return Object.entries(model?.schema?.fields ?? {}).flatMap(([key, field]) => {
    const element = field.element ?? field;
    return element.relative === true ? [{ key, list: field.element !== undefined, names: element.type }] : [];
  });
}

/**
 * The absolute UUID a stored one names. Foundry resolves a relative one against the behavior
 * (client/data/region-behaviors/teleport-token.mjs:83). One it cannot read is handed on as it is.
 */
const namedBy = (uuid, behavior) => foundry.utils.parseUuid(uuid, { relative: behavior })?.uuid ?? uuid;

/** A behavior's stored system data, with the absolute UUID in place of each one stored relative to the behavior. */
export function absoluteSystem(behavior) {
  const system = foundry.utils.deepClone(behavior._source.system ?? {});
  for (const { key, list } of referenceFields(behavior.type)) {
    const stored = system[key];
    if (list && Array.isArray(stored)) system[key] = stored.map((uuid) => namedBy(uuid, behavior));
    else if (typeof stored === "string") system[key] = namedBy(stored, behavior);
  }
  return system;
}

/**
 * The regions a bridge-made behavior names by a name that no region of its scene had when sync_regions wrote it, each
 * with the field of the system data it belongs in. The flag lies in the world, where anyone can change it, so only
 * what has this shape counts, and only for a field of the type that holds a list of regions.
 * @returns {{field: string, region: string}[]}
 */
export function pendingOf(behavior) {
  const kept = isManaged(behavior) ? behavior.flags[FLAG_SCOPE].pending : undefined;
  if (!Array.isArray(kept)) return [];
  const fields = referenceFields(behavior.type).flatMap(({ key, list, names }) =>
    list && names === "Region" ? [key] : []
  );
  return kept.flatMap((one) =>
    isPlainObject(one) && fields.includes(one.field) && typeof one.region === "string"
      ? [{ field: one.field, region: one.region }]
      : []
  );
}

/**
 * A behavior's system data as get_scene gives it and sync_regions takes it: each stored UUID as the absolute one, and
 * each region the behavior still waits for as {region: name}.
 */
export function systemAsRead(behavior) {
  const system = absoluteSystem(behavior);
  for (const { field, region } of pendingOf(behavior)) system[field] = [...(system[field] ?? []), { region }];
  return system;
}

/**
 * Two spellings of a UUID say the same when they name one document: Foundry may store the UUID it is given as one
 * relative to the behavior.
 * @returns {import("./data-diff.mjs").SameLeaf}
 */
export function sameReferences(behavior) {
  const fields = referenceFields(behavior.type).map(({ key }) => `system.${key}`);
  return (path, a, b) =>
    fields.some((field) => path === field || path.startsWith(`${field}.`)) &&
    typeof a === "string" &&
    typeof b === "string" &&
    namedBy(a, behavior) === namedBy(b, behavior);
}
