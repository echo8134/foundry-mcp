import { derivedValues } from "./actor-data.mjs";
import { MethodError } from "./errors.mjs";
import { folderPath, folderScope } from "./folders.mjs";
import { CONFIG_TABLES, configKeys, describeField, selectPath } from "./schema.mjs";
import { isManaged } from "./scope.mjs";
import { folderRecords } from "./world.mjs";

const MAX_ACTORS = 200;

/** Core lists "base" (CONST.BASE_DOCUMENT_TYPE) for every typed document; only some may be created with it (common/abstract/document.mjs:462). */
function systemTypes(documentName) {
  const { baseTypeAllowed } = CONFIG[documentName].documentClass.metadata;
  return game.documentTypes[documentName].filter((type) => type !== "base" || baseTypeAllowed === true);
}

function checkType(types, type, noun) {
  if (!types.includes(type)) {
    throw new MethodError("invalid_params", `Unknown ${noun} "${type}". Use one of: ${types.join(", ")}.`);
  }
}

const byFolderThenName = (a, b) =>
  a.path.join("\0").localeCompare(b.path.join("\0")) || a.actor.name.localeCompare(b.actor.name);

export async function listActors({ folder, type, name }) {
  if (type !== undefined) checkType(systemTypes("Actor"), type, "actor type");
  const folders = folderRecords("Actor");
  const scope = folderScope(folders, folder);
  if (!scope) throw new MethodError("not_found", `No actor folder at path ${JSON.stringify(folder)}.`);
  const needle = name?.toLocaleLowerCase();
  const matched = game.actors
    .map((actor) => ({ actor, path: folderPath(folders, actor.folder?.id ?? null) ?? [] }))
    .filter(
      ({ actor, path }) =>
        scope.inScope(path) &&
        (type === undefined || actor.type === type) &&
        (!needle || actor.name.toLocaleLowerCase().includes(needle))
    )
    .sort(byFolderThenName);
  const actors = matched.slice(0, MAX_ACTORS).map(({ actor, path }) => {
    const details = actor.system?.details;
    return {
      id: actor.id,
      name: actor.name,
      type: actor.type,
      folder: path,
      managed: isManaged(actor),
      ...(actor.type === "npc" && typeof details?.cr === "number" && { cr: details.cr }),
      ...(actor.type === "character" && typeof details?.level === "number" && { level: details.level })
    };
  });
  return { folders: scope.folders, actors, total: matched.length, truncated: matched.length > MAX_ACTORS };
}

async function resolveActor(ref) {
  if (!ref.includes(".")) {
    const actor = game.actors.get(ref);
    if (actor) return actor;
    throw new MethodError("not_found", `No world actor with id ${ref}. Pass an id from list_actors, or a UUID.`);
  }
  let document;
  try {
    document = await foundry.utils.fromUuid(ref);
  } catch (error) {
    throw new MethodError("not_found", `Foundry could not resolve the UUID ${ref}: ${error.message}`);
  }
  if (!document) throw new MethodError("not_found", `Nothing exists at the UUID ${ref}.`);
  if (document.documentName !== "Actor") {
    throw new MethodError("invalid_params", `The UUID ${ref} is a ${document.documentName}, not an Actor.`);
  }
  return document;
}

export async function getActor({ actor: ref, items = [] }) {
  const actor = await resolveActor(ref);
  const missing = items.filter((id) => !actor.items.has(id));
  if (missing.length > 0) {
    throw new MethodError(
      "not_found",
      `${actor.name} has no item with the id ${missing.join(", ")}. The item ids are in this tool's items list.`
    );
  }
  const inWorld = !actor.pack && !actor.isToken;
  const { system, prototypeToken, ownership } = actor._source;
  return {
    id: actor.id,
    uuid: actor.uuid,
    name: actor.name,
    type: actor.type,
    img: actor.img,
    folder: inWorld ? (folderPath(folderRecords("Actor"), actor.folder?.id ?? null) ?? []) : [],
    managed: isManaged(actor),
    system,
    prototypeToken,
    ownership,
    derived: derivedValues(actor.system),
    items: actor.items.map((item) => ({ id: item.id, name: item.name, type: item.type, managed: isManaged(item) })),
    itemData: items.map((id) => actor.items.get(id)._source),
    effects: actor.effects.map((effect) => ({ id: effect.id, name: effect.name, disabled: effect.disabled })),
    // concreteOnly leaves out ephemeral tokens that are not stored in their scene (client/documents/actor.mjs:589-597).
    tokens: actor.pack
      ? []
      : actor.getDependentTokens({ concreteOnly: true }).map((token) => ({
          sceneId: token.parent.id,
          sceneName: token.parent.name,
          tokenId: token.id,
          name: token.name
        }))
  };
}

const typedDocument = (documentName) => ({
  types: () => systemTypes(documentName),
  schema: () => CONFIG[documentName].documentClass.schema,
  system: (type) => CONFIG[documentName].dataModels?.[type]?.schema
});

/** dnd5e keeps activities and advancements inside an item, each type with a class of its own (dnd5e module/config.mjs). */
const pseudoDocument = (table) => ({
  types: () => Object.keys(CONFIG.DND5E[table]),
  schema: (type) => CONFIG.DND5E[table][type].documentClass.schema
});

/** Where get_schema finds each document's types and field schema. `types: null` means the document has no types. */
const SCHEMA_SOURCES = Object.freeze({
  Actor: typedDocument("Actor"),
  Item: typedDocument("Item"),
  ActiveEffect: typedDocument("ActiveEffect"),
  Token: { types: null, schema: () => CONFIG.Token.documentClass.schema },
  Activity: pseudoDocument("activityTypes"),
  Advancement: pseudoDocument("advancementTypes")
});

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
  if (!Object.hasOwn(SCHEMA_SOURCES, document)) {
    throw new MethodError(
      "invalid_params",
      `Unknown document "${document}". Use one of: ${Object.keys(SCHEMA_SOURCES).join(", ")}, Config.`
    );
  }
  const source = SCHEMA_SOURCES[document];
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
