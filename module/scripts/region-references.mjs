// What the system data of a region behavior says of other documents: the destinations of a teleportToken, and the
// behaviors a toggleBehavior switches. Foundry stores such a UUID relative to the behavior that holds it
// (common/data/fields.mjs:3530-3539), "..<id>" for a region of the same scene. The tools give and take the absolute
// UUID, and compare two spellings by the document they name.

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
export const namedBy = (uuid, behavior) => foundry.utils.parseUuid(uuid, { relative: behavior })?.uuid ?? uuid;

/** A behavior's stored system data, with the absolute UUID in place of each one stored relative to the behavior. */
export function systemAsRead(behavior) {
  const system = foundry.utils.deepClone(behavior._source.system ?? {});
  for (const { key, list } of referenceFields(behavior.type)) {
    const stored = system[key];
    if (list && Array.isArray(stored)) system[key] = stored.map((uuid) => namedBy(uuid, behavior));
    else if (typeof stored === "string") system[key] = namedBy(stored, behavior);
  }
  return system;
}
