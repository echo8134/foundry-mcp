import { derivedValues } from "./actor-data.mjs";
import { dropAt } from "./data-diff.mjs";
import { MethodError } from "./errors.mjs";
import { folderPath, folderScope } from "./folders.mjs";
import { TYPED_ENTRY_SCHEMAS } from "./item-data.mjs";
import { FLAG_SCOPE, isManaged } from "./scope.mjs";
import { folderRecords, takenBack } from "./world.mjs";

const MAX_ACTORS = 200;

/** Core lists "base" (CONST.BASE_DOCUMENT_TYPE) for every typed document; only some may be created with it (common/abstract/document.mjs:462). */
export function systemTypes(documentName) {
  const { baseTypeAllowed } = CONFIG[documentName].documentClass.metadata;
  return game.documentTypes[documentName].filter((type) => type !== "base" || baseTypeAllowed === true);
}

export function checkType(types, type, noun) {
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

export async function resolveActor(ref) {
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

/** The folder path of a world actor. An actor in a compendium or of a token has none here. */
export function actorFolderPath(actor) {
  if (actor.pack || actor.isToken) return [];
  return folderPath(folderRecords("Actor"), actor.folder?.id ?? null) ?? [];
}

/**
 * An actor's own data without the bridge's own flag on the prototype token, which Foundry's Assign Token copies there
 * from a bridge-made token (client/applications/sheets/token/prototype-config.mjs:278-292), and without the prototype
 * token of a token's actor, whose data has none.
 */
function storedForWrite(actor) {
  const { system, prototypeToken, ownership } = actor._source;
  const data = takenBack(actor, actor.isToken ? { system, ownership } : { system, prototypeToken, ownership });
  dropAt(data, `prototypeToken.flags.${FLAG_SCOPE}`);
  return data;
}

function mustHave(actor, collection, ids, noun) {
  const missing = ids.filter((id) => !collection.has(id));
  if (missing.length > 0) {
    throw new MethodError(
      "not_found",
      `${actor.name} has no ${noun} with the id ${missing.join(", ")}. The ${noun} ids are in this tool's ${noun}s list.`
    );
  }
}

export async function getActor({ actor: ref, items = [], effects = [] }) {
  const actor = await resolveActor(ref);
  mustHave(actor, actor.items, items, "item");
  mustHave(actor, actor.effects, effects, "effect");
  return {
    id: actor.id,
    uuid: actor.uuid,
    name: actor.name,
    type: actor.type,
    img: actor.img,
    folder: actorFolderPath(actor),
    managed: isManaged(actor),
    ...storedForWrite(actor),
    derived: derivedValues(actor.system),
    items: actor.items.map((item) => ({ id: item.id, name: item.name, type: item.type, managed: isManaged(item) })),
    itemData: items.map((id) => {
      const item = actor.items.get(id);
      return takenBack(item, item._source, TYPED_ENTRY_SCHEMAS);
    }),
    effects: actor.effects.map((effect) => ({ id: effect.id, name: effect.name, disabled: effect.disabled })),
    effectData: effects.map((id) => {
      const effect = actor.effects.get(id);
      return takenBack(effect, effect._source);
    }),
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
