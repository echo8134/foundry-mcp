// get_schema: the stored fields of any document type, read from the classes of the running Foundry and of its system.

import { checkType } from "./actor-methods.mjs";
import { subtypesOf } from "./document-access.mjs";
import { DOCUMENT_TYPES, SCHEMA_EXTRAS } from "./document-types.mjs";
import { MethodError } from "./errors.mjs";
import { CONFIG_TABLES, configKeys, describeField, selectPath } from "./schema.mjs";

/**
 * A document class of the running Foundry: its types where it has them, its fields, and for a type the data model of
 * its system data.
 */
function documentSource(documentName) {
  const cls = CONFIG[documentName].documentClass;
  return {
    types: subtypesOf(cls) === null ? null : () => subtypesOf(cls),
    schema: () => cls.schema,
    system: (type) => CONFIG[documentName].dataModels?.[type]?.schema
  };
}

/** dnd5e keeps activities and advancements inside an item, each type with a class of its own (dnd5e module/config.mjs). */
const pseudoDocument = (table) => ({
  types: () => Object.keys(CONFIG.DND5E[table]),
  schema: (type) => CONFIG.DND5E[table][type].documentClass.schema
});

const PSEUDO_DOCUMENTS = Object.freeze({
  Activity: pseudoDocument("activityTypes"),
  Advancement: pseudoDocument("advancementTypes")
});

const hasClass = (documentName) =>
  DOCUMENT_TYPES.includes(documentName) && Boolean(CONFIG[documentName]?.documentClass);

/** Where get_schema finds a document's types and field schema. `types: null` means the document has no types. */
function sourceOf(document) {
  if (Object.hasOwn(PSEUDO_DOCUMENTS, document)) return PSEUDO_DOCUMENTS[document];
  if (hasClass(document)) return documentSource(document);
  throw new MethodError(
    "invalid_params",
    `Unknown document "${document}". Use one of: ${[...DOCUMENT_TYPES.filter(hasClass), ...SCHEMA_EXTRAS].join(", ")}.`
  );
}

function noPathWithout(path, what, instead = "Leave path out.") {
  if (path !== undefined) {
    throw new MethodError("invalid_params", `path selects inside a field tree, and ${what} has none. ${instead}`);
  }
}

function configSchema(type, path) {
  if (type === undefined) {
    noPathWithout(path, "a list of tables");
    return { types: [...CONFIG_TABLES] };
  }
  checkType(CONFIG_TABLES, type, "Config table");
  noPathWithout(path, "a Config table");
  const table = CONFIG.DND5E[type];
  if (table === null || typeof table !== "object") {
    throw new MethodError("foundry_error", `The dnd5e system has no CONFIG.DND5E.${type} table.`);
  }
  return { keys: configKeys(table) };
}

export async function getSchema({ document, type, path }) {
  if (document === "Config") return configSchema(type, path);
  const source = sourceOf(document);
  if (source.types === null) {
    if (type !== undefined) throw new MethodError("invalid_params", `${document} has no types. Leave type out.`);
  } else if (type === undefined) {
    noPathWithout(path, "a list of types", "Pass type to get a field tree, or leave path out.");
    return { types: source.types() };
  } else {
    checkType(source.types(), type, `${document} type`);
  }
  const tree = describeField(source.schema(type));
  const system = source.system?.(type);
  if (system) tree.system = describeField(system);
  if (path === undefined) return { fields: tree };
  const fields = selectPath(tree, path);
  if (fields === undefined) {
    throw new MethodError("not_found", `No field at path ${path} in ${type ? `the ${type} ` : ""}${document}.`);
  }
  return { fields };
}
