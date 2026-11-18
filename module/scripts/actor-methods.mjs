import { derivedValues } from "./actor-data.mjs";
import { dropAt } from "./data-diff.mjs";
import { folderPathOf, resolveDocument } from "./document-access.mjs";
import { listDocuments } from "./document-methods.mjs";
import { MethodError } from "./errors.mjs";
import { FLAG_SCOPE, isManaged } from "./scope.mjs";
import { takenBack } from "./world.mjs";

/** The world's actors as list_documents lists them, each with the number a Dungeon Master picks an actor by. */
export async function listActors({ folder, type, name }) {
  const listed = await listDocuments({ type: "Actor", folder, name, subtype: type });
  const actors = listed.documents.map(({ uuid: _uuid, ...entry }) => {
    const details = game.actors.get(entry.id).system?.details;
    return {
      ...entry,
      ...(entry.type === "npc" && typeof details?.cr === "number" && { cr: details.cr }),
      ...(entry.type === "character" && typeof details?.level === "number" && { level: details.level })
    };
  });
  return { folders: listed.folders, actors, total: listed.total, truncated: listed.truncated };
}

/** An actor by the id of a world actor, or by the UUID of any actor. */
export async function resolveActor(ref) {
  if (!ref.includes(".")) {
    const actor = game.actors.get(ref);
    if (actor) return actor;
    throw new MethodError("not_found", `No world actor with id ${ref}. Pass an id from list_actors, or a UUID.`);
  }
  const document = await resolveDocument(ref);
  if (document.documentName !== "Actor") {
    throw new MethodError("invalid_params", `The UUID ${ref} is a ${document.documentName}, not an Actor.`);
  }
  return document;
}

/** The folder path of a world actor. An actor in a compendium or of a token has none here. */
export const actorFolderPath = (actor) => (actor.pack || actor.isToken ? [] : folderPathOf(actor));

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
      return takenBack(item, item._source);
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
