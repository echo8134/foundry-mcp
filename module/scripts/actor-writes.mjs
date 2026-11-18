import { derivedValues, withCreateDefaults } from "./actor-data.mjs";
import { actorFolderPath, checkType, resolveActor, systemTypes } from "./actor-methods.mjs";
import { dropAt, entriesToRemove, hasPath, pickData, updateFor, writeOutcome } from "./data-diff.mjs";
import { MethodError } from "./errors.mjs";
import { hasEmbedded, planEmbedded, writeEmbedded } from "./item-writes.mjs";
import { claimNamed, FLAG_SCOPE, isManaged } from "./scope.mjs";
import { createMissingFolders, findFolder } from "./world.mjs";
import {
  checkAsked,
  checkImage,
  checkKeptAsGiven,
  checkRemoval,
  KINDS,
  modelRefusal,
  refuse,
  wantedChanges,
  writeOf
} from "./write-checks.mjs";

/** The inputs of ensure_actor that are the actor's own stored data, each under the name of its stored field. */
const DATA_KEYS = Object.freeze(["name", "img", "system", "prototypeToken", "ownership", "flags"]);

/**
 * What the actor of a token cannot take: its data is the token's own changes to the world actor, which have no such
 * fields (common/documents/actor-delta.mjs:44-57). Measured: Foundry drops them from an update without an error.
 */
const NOT_ON_A_TOKEN_ACTOR = Object.freeze(["folder", "prototypeToken"]);

/** What the result reports for each input of items and effects, and under which name. */
const EMBEDDED_REPORTS = Object.freeze({
  items: "items",
  effects: "effects",
  removeItems: "removedItems",
  removeEffects: "removedEffects"
});

const askedData = (request) =>
  Object.fromEntries(DATA_KEYS.filter((key) => request[key] !== undefined).map((key) => [key, request[key]]));

/** Why a name leads to no actor to write, by what claimNamed found. */
const NAME_REFUSALS = Object.freeze({
  several: (name, place, ids) =>
    `${ids.length} bridge-made actors are named "${name}" in ${place} (${ids.join(", ")}). Pass the id of one as actor.`,
  handMade: (name, place, ids) =>
    `An actor named "${name}" in ${place} was not made by this bridge (${ids.join(", ")}). Pass its id as actor to change it on purpose, or give another name.`
});

/**
 * With actor, that actor. Without, the bridge-made world actor of exactly that name in exactly that folder: one is the
 * target, and none means a new actor.
 * @returns {Promise<{actor: object | null, place: {id: string | null, missing: string[]} | null}>} place is the folder
 *   the actor is to be put in, null to leave it where it is
 */
async function findTarget({ actor: ref, name, folder, from }) {
  if (ref !== undefined) {
    const actor = await resolveActor(ref);
    if (actor.pack) {
      throw refuse(
        `${ref} is an actor in the compendium ${actor.pack}, and this tool writes no compendium. To make a world actor of it, pass its UUID as from, with a name.`
      );
    }
    if (from !== undefined) {
      throw refuse("from copies an actor when a new one is created, and actor names one that exists. Leave from out.");
    }
    return { actor, place: folder === undefined ? null : findFolder("Actor", folder) };
  }
  const path = folder ?? [];
  const place = findFolder("Actor", path);
  const named =
    place.missing.length > 0
      ? []
      : game.actors.filter((actor) => actor.name === name && (actor.folder?.id ?? null) === place.id);
  const claim = claimNamed(named);
  if (claim.kind === "one") return { actor: claim.document, place: null };
  if (claim.kind === "none") return { actor: null, place };
  throw refuse(
    NAME_REFUSALS[claim.kind](
      name,
      path.length > 0 ? `folder ${JSON.stringify(path)}` : "the root",
      claim.documents.map((actor) => actor.id)
    )
  );
}

/**
 * The actor of a token is its world actor with that token's own changes over it. Removing an entry from the token's
 * changes shows the world actor's entry again, so an entry the world actor has cannot be removed for one token.
 */
function checkTokenRemovals(actor, remove) {
  const world = actor.token.baseActor;
  const fromWorld = remove.filter((path) => hasPath(world._source, path));
  if (fromWorld.length > 0) {
    throw refuse(
      `remove: ${fromWorld.join(", ")} comes from the world actor ${world.name} (${world.id}), and on the actor of a token only what that token changed can be removed. Remove it from the world actor, by its id as actor.`
    );
  }
}

/** Every check of a change to an actor that exists. Reads only. */
async function planChange(actor, request, place) {
  const { type, remove = [] } = request;
  if (type !== undefined && type !== actor.type) {
    throw refuse(
      `${actor.name} is a ${actor.type}, and Foundry cannot change the type of an actor. Leave type out, or create another actor.`
    );
  }
  const notHere = actor.isToken ? NOT_ON_A_TOKEN_ACTOR.filter((key) => request[key] !== undefined) : [];
  if (notHere.length > 0) {
    throw refuse(
      `${actor.uuid} is the actor of a token. Its data is that token's own changes to its world actor, which have no ${notHere.join(" and no ")}. Leave ${notHere.join(" and ")} out, or pass the world actor.`
    );
  }
  const asked = askedData(request);
  checkAsked(KINDS.Actor, asked, remove, actor.type);
  if (actor.isToken) checkTokenRemovals(actor, remove);
  const wanted = wantedChanges(KINDS.Actor, actor, asked);
  checkKeptAsGiven(asked, wanted);
  if (wanted.img !== actor._source.img) await checkImage(wanted.img);
  const ownership = remove.some((path) => path.startsWith("ownership."));
  checkRemoval(
    KINDS.Actor,
    actor,
    remove,
    "",
    ownership ? " To take a user's level away, give it as -1 in ownership instead." : ""
  );
  return {
    actor,
    data: null,
    write: writeOf(KINDS.Actor, wanted, remove, actor.type),
    place,
    embedded: hasEmbedded(request) ? await planEmbedded(actor, request) : null
  };
}

async function copySource(from) {
  const source = await resolveActor(from);
  if (source.isToken) {
    throw refuse(`${from} is the actor of a token. Pass a world actor or a compendium actor as from.`);
  }
  return source;
}

/** Every check of a new actor, and the data to create it from. Reads only. */
async function planCreation(request, place) {
  const { from, remove = [] } = request;
  const source = from === undefined ? null : await copySource(from);
  if (source && request.type !== undefined && request.type !== source.type) {
    throw refuse(`${from} is a ${source.type}, not a ${request.type}. Leave type out, or pass ${source.type}.`);
  }
  const type = source?.type ?? request.type;
  if (type === undefined) {
    throw refuse(
      "Creating an actor needs a type, or from: the UUID of an actor to copy. get_schema with document Actor lists the types."
    );
  }
  checkType(systemTypes("Actor"), type, "actor type");
  const given = askedData(request);
  checkAsked(KINDS.Actor, given, remove, type);
  const asked = withCreateDefaults(type, given);
  // fromCompendium leaves out the id, the folder and the sort of the source, resets the ownership to the current
  // user, and records the source of a compendium actor (client/documents/abstract/world-collection.mjs:109-134).
  const start = source ? game.actors.fromCompendium(source, { clearFolder: true }) : {};
  const data = foundry.utils.mergeObject(start, structuredClone(asked));
  for (const path of entriesToRemove(remove, data)) dropAt(data, path);
  data.type = type;
  data.flags = { ...data.flags, [FLAG_SCOPE]: { managed: true } };
  let built;
  try {
    // The constructor keeps the object it is given as the stored data and cleans it in place.
    built = new CONFIG.Actor.documentClass(structuredClone(data));
  } catch (error) {
    throw modelRefusal(KINDS.Actor, error);
  }
  const wanted = pickData(built._source, asked);
  checkKeptAsGiven(asked, wanted);
  await checkImage(wanted.img);
  // The items and effects are checked on the actor built from the data, and planned again on the one Foundry makes.
  if (hasEmbedded(request)) await planEmbedded(built, request);
  return { actor: null, data, write: writeOf(KINDS.Actor, wanted, remove, type), place, embedded: null };
}

async function planActor(request) {
  const { actor, place } = await findTarget(request);
  return actor ? planChange(actor, request, place) : planCreation(request, place);
}

export async function prepareEnsureActor(request) {
  await planActor(request);
  return request;
}

async function createActor(data) {
  let created;
  try {
    created = await CONFIG.Actor.documentClass.create(data);
  } catch (error) {
    throw new MethodError(
      "foundry_error",
      `Foundry failed while creating the actor (${error.message}). list_actors shows whether it exists now.`
    );
  }
  // Foundry skips a document that fails its validation or that a hook refuses, and resolves without it
  // (client/data/client-backend.mjs:91-108).
  if (!created) {
    throw new MethodError(
      "foundry_error",
      "Foundry created no actor and reported no error, which is what it does when a hook or a module refuses the creation. No actor was written."
    );
  }
  return created;
}

async function changeActor(actor, write, before) {
  const { update, writes } = updateFor(write, actor._source, _del);
  if (!writes) return;
  try {
    // Measured on 14.370: an update sent through a token's actor loses earlier changes of that token on the server
    // (hp.temp written after hp.value dropped the value, seen only after a reload) and applies no deletion. The same
    // update sent through the token merges into its delta.
    await (actor.isToken ? actor.token.update({ delta: update }) : actor.update(update));
  } catch (error) {
    const { changed } = writeOutcome(write, before, actor._source);
    const written =
      changed.length > 0
        ? `Changed in the stored data: ${changed.join(", ")}.`
        : "Nothing was changed in the stored data.";
    throw new MethodError(
      "foundry_error",
      `Foundry failed while updating ${actor.name} (${error.message}). ${written} Running the call again writes what still differs.`
    );
  }
}

/** A failed write leaves the folders made for it in place, and says so. */
function withMadeFolders(error, made) {
  if (made.length === 0 || !(error instanceof MethodError)) return error;
  return new MethodError(
    error.code,
    `${error.message} The actor folders ${JSON.stringify(made)} were made for this call and stay: running it again uses them.`
  );
}

/**
 * dnd5e sets some data of a new actor itself, such as a character's prototype token actorLink, disposition and sight
 * (dnd5e module/data/actor/character.mjs:265-278, module/data/actor/group.mjs:432-436). Written once more as a change,
 * the given values stick.
 */
async function writeAgainWhatCreationDropped(actor, write) {
  if (writeOutcome(write, {}, actor._source).unapplied.length === 0) return;
  await changeActor(actor, write, actor.toObject());
}

/** A failed write of items or effects leaves the actor written, and says so. */
function withActorWritten(error, actor, created, changed) {
  if (!(error instanceof MethodError)) return error;
  const written = created
    ? `The actor ${actor.name} (${actor.id}) was created before that and stays.`
    : changed.length > 0
      ? `The actor's own data was changed before that (${changed.join(", ")}).`
      : "The actor's own data was not changed.";
  return new MethodError(error.code, `${error.message} ${written}`);
}

export async function ensureActor(request) {
  // Planned again inside the write queue: a write queued before this one may have created, renamed, moved or deleted
  // an actor or a folder since prepare looked.
  const { actor: existing, data, write, place, embedded: planned } = await planActor(request);
  const made = place?.missing ?? [];
  const folder = place ? await createMissingFolders("Actor", place) : undefined;
  if (place && request.folder !== undefined) write.wanted.folder = folder;
  // toObject, not structuredClone: measured, the stored data of an actor that has certain items (a spell copied from
  // a compendium) cannot be structured-cloned.
  const before = existing ? existing.toObject() : {};
  let actor = existing;
  try {
    if (existing) await changeActor(existing, write, before);
    else {
      actor = await createActor({ ...data, folder });
      await writeAgainWhatCreationDropped(actor, write);
    }
  } catch (error) {
    throw withMadeFolders(error, made);
  }
  let embedded = {};
  if (hasEmbedded(request)) {
    try {
      // The plan of a new actor was made on an actor built from its data. It is made again on the one Foundry
      // created, which has the ids and what the system put into its items.
      embedded = await writeEmbedded(actor, planned ?? (await planEmbedded(actor, request)));
    } catch (error) {
      const { changed } = writeOutcome(write, before, actor._source);
      throw withMadeFolders(withActorWritten(error, actor, !existing, changed), made);
    }
  }
  return {
    id: actor.id,
    uuid: actor.uuid,
    name: actor.name,
    type: actor.type,
    folder: actorFolderPath(actor),
    created: !existing,
    ...writeOutcome(write, before, actor._source),
    ...Object.fromEntries(
      Object.entries(EMBEDDED_REPORTS).flatMap(([input, key]) =>
        request[input] === undefined ? [] : [[key, embedded[key]]]
      )
    ),
    derived: derivedValues(actor.system)
  };
}

/**
 * The names of the scenes a world actor has tokens on, which its deletion would leave without an actor. concreteOnly
 * leaves out tokens that are not stored in their scene, such as the ones place_tokens builds to check its input
 * (client/documents/actor.mjs:589-597).
 * @param {any} actor
 * @param {(token: any) => boolean} [going] whether a token is deleted by the same call, and so needs no actor
 * @returns {string[]}
 */
export function scenesWithTokensOf(actor, going = () => false) {
  const staying = actor.getDependentTokens({ concreteOnly: true }).filter((token) => !going(token));
  return [...new Set(staying.map((token) => token.parent.name))];
}

/** Every check of a deletion, and the world actors it deletes. Reads only. */
function planDeletion({ ids, handMade }) {
  const actors = [...new Set(ids)].flatMap((id) => game.actors.get(id) ?? []);
  const foreign = actors.filter((actor) => !isManaged(actor));
  if (foreign.length > 0 && handMade !== true) {
    throw refuse(
      `These actors were not made by this bridge: ${foreign.map((actor) => `${actor.name} (${actor.id})`).join(", ")}. Foundry cannot bring a deleted actor back. Pass handMade: true to delete them as well.`
    );
  }
  const placed = actors.flatMap((actor) => {
    const scenes = scenesWithTokensOf(actor);
    return scenes.length > 0 ? [`${actor.name} (${actor.id}) on ${scenes.join(", ")}`] : [];
  });
  if (placed.length > 0) {
    throw refuse(
      `These actors still have tokens on a scene, which would be left without an actor: ${placed.join("; ")}. Delete the tokens first with delete_tokens. get_actor lists them.`
    );
  }
  return actors;
}

export function prepareActorDeletion(request) {
  planDeletion(request);
  return request;
}

export async function deleteActors(request) {
  const actors = planDeletion(request);
  if (actors.length === 0) return { deleted: 0, ids: [], names: [] };
  const deleted = await CONFIG.Actor.documentClass.deleteDocuments(actors.map((actor) => actor.id));
  return { deleted: deleted.length, ids: deleted.map((actor) => actor.id), names: deleted.map((actor) => actor.name) };
}
