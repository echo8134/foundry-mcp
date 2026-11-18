// The regions of a scene: what get_scene says of one, and sync_regions, which brings the regions the bridge made on
// one level set to a given list. planRegions runs every check and reads only. syncRegions writes the plan and reports
// from the stored data.

import { isPlainObject, updateFor, writeOutcome } from "./data-diff.mjs";
import { findDocument, systemTypes, unknownType } from "./document-access.mjs";
import { rulesOf } from "./document-rules.mjs";
import { MethodError } from "./errors.mjs";
import { shapeInFrame, shapeOnCanvas } from "./region-data.mjs";
import { referenceFields, sameReferences, systemAsRead } from "./region-references.mjs";
import { FLAG_SCOPE, isManaged, replacedBySync, sameLevelSet, sameLevels } from "./scope.mjs";
import { checkLevels, resolveScene, sceneFrame, sceneRect } from "./world.mjs";
import { checkAsked, kindOf, NOT_CREATED, planBuilt, planUpdate, refuse, withoutOwnFlags } from "./write-checks.mjs";
import { runSteps, writtenBefore, writtenPart, wrote } from "./write-steps.mjs";

/**
 * @typedef {object} BehaviorPlan what one behavior of an entry leads to
 * @property {string} name
 * @property {string} type
 * @property {any} document the behavior to change, null for one to create
 * @property {Record<string, any> | null} data the data to create it from
 * @property {import("./data-diff.mjs").Asked} write
 * @property {string[]} pending the regions it names that no region of the scene has the name of yet
 */
/**
 * @typedef {object} RegionPlan what one entry of the request leads to
 * @property {string} name
 * @property {any} document the region to change, null for one to create
 * @property {Record<string, any> | null} data the data to create it from, without its behaviors
 * @property {import("./data-diff.mjs").Asked} write
 * @property {BehaviorPlan[] | null} behaviors null for an entry that says nothing of behaviors
 * @property {any[]} stale the bridge-made behaviors of the region that the entry does not name
 */
/** @typedef {{regions: RegionPlan[], deleted: any[], handPlaced: {id: string, name: string}[]}} Plan */

const BRIDGE_MADE = Object.freeze({ [FLAG_SCOPE]: { managed: true } });

/**
 * The name a behavior is stored under. The document's own name is the label of its type where none is stored
 * (client/documents/region-behavior.mjs:76-78).
 */
const storedName = (behavior) => behavior._source.name;

/**
 * What get_scene says of a region, from its stored data (common/documents/region.mjs:48-90): the shapes in the frame,
 * an elevation without a bound as null, a restriction only while it is enabled and an attachment only to a token.
 * Left out is what places no region and decides nothing in play: the lock and the highlighting of the region layer,
 * the ownership, and the shape constraints Foundry works out itself.
 */
export function regionFields(region, frame, rect) {
  const { name, color, shapes, elevation, levels, restriction, attachment, visibility, hidden } = region._source;
  return {
    id: region.id,
    name,
    levels: [...levels],
    elevation: { ...elevation },
    shapes: shapes.map((shape) => shapeInFrame(shape, frame, rect)),
    color,
    visibility,
    hidden,
    ...(restriction.enabled && { restriction: { ...restriction } }),
    ...(attachment.token && { attachment: { token: attachment.token } }),
    behaviors: region.behaviors.map((behavior) => ({
      id: behavior.id,
      type: behavior.type,
      name: storedName(behavior),
      disabled: behavior.disabled,
      system: systemAsRead(behavior),
      managed: isManaged(behavior)
    })),
    managed: isManaged(region)
  };
}

function refuseKept(fields, at) {
  const keys = Object.keys(fields).filter((key) => key.startsWith("_"));
  if (keys.length > 0) {
    throw refuse(`${keys.join(" and ")} cannot be given: Foundry keeps ${keys.length > 1 ? "them" : "it"} itself.`, at);
  }
}

function refuseRepeated(named, what) {
  const first = new Map();
  for (const { name, where } of named) {
    if (first.has(name)) {
      throw refuse(
        `${first.get(name)} and ${where} are both named "${name}". The sync finds ${what} by its name: give each another name.`
      );
    }
    first.set(name, where);
  }
}

/** What document-rules.mjs holds back of a region behavior, as the refusal of an entry. */
function refuseRuled(sentence, at) {
  if (sentence) throw refuse(sentence, at);
}

/**
 * How many levels a region is on, counted as Foundry counts them: a region that names no levels is on every level of
 * its scene (CanvasDocument#includedInLevel, client/documents/abstract/canvas-document.mjs:97-105).
 */
const levelCount = (levels, scene) => levels.length || scene.levels.size;

/**
 * The entries a sync is about. As sync_lights does with a light of get_scene, an entry that says it was made by hand
 * and one whose own levels are another level set than the call's is left out: such a region exists, and this sync
 * does not own it.
 */
function ownEntries(regions, levels, sceneLevels) {
  const entries = regions
    .map((entry, index) => ({ entry, name: entry.name, where: `regions[${index}]` }))
    .filter(
      ({ entry }) =>
        entry.managed !== false && (entry.levels === undefined || sameLevelSet(entry.levels, levels, sceneLevels))
    );
  if (regions.length > 0 && entries.length === 0) {
    throw refuse(
      `All ${regions.length} given regions were left out: each is marked managed: false, which is a region made by hand, or has levels of its own that are another level set than this call's (${levels.length > 0 ? levels.join(", ") : "none, which means all levels"}). A sync never touches those. Pass the levels of these regions as the call's levels, or regions: [] to remove the bridge-made regions of this level set.`
    );
  }
  refuseRepeated(entries, "a region");
  return entries;
}

/** A bridge-made region may hold behaviors someone added in Foundry, which a deletion would take along for good. */
function refuseLosingHandMade(deleted) {
  const losing = deleted.flatMap((region) => {
    const byHand = region.behaviors.filter((behavior) => !isManaged(behavior)).map((behavior) => behavior.name);
    return byHand.length > 0 ? [`the region ${region.name} (${region.id}), which holds ${byHand.join(", ")}`] : [];
  });
  if (losing.length > 0) {
    throw refuse(
      `This call does not name ${losing.join("; ")}. The sync deletes a bridge-made region that its call does not name, and with it the behaviors someone added to it in Foundry, which Foundry cannot bring back. Name the region in the call to keep it, or delete it on purpose with delete_documents.`
    );
  }
}

/**
 * What a reference of a behavior leads to: the absolute UUID, what the refusal of it calls it, and for a region how
 * many levels it is on. Null for a region named by a name that no bridge-made region of the scene has yet.
 * @typedef {(value: unknown, names: string | undefined, at: string) => Promise<{uuid: string, label: string, levels?: number} | null>} Resolve
 */

/**
 * A name leads to the region of the call that has it, and else to the one bridge-made region of the scene that has
 * it on another level set. A region made by hand is named by its UUID.
 * @param {any} scene
 * @param {{name: string, id: string}[]} claims the regions of the call, each with the id it has or is created with
 * @param {{owned: any[], deleted: any[], levels: readonly string[]}} context
 * @returns {Resolve}
 */
function referenceResolver(scene, claims, { owned, deleted, levels }) {
  const named = (name) => {
    const own = claims.find((claim) => claim.name === name);
    if (own) return [{ uuid: `${scene.uuid}.Region.${own.id}`, levels: levelCount(levels, scene) }];
    return scene.regions
      .filter((region) => isManaged(region) && region.name === name && !owned.includes(region))
      .map((region) => ({ uuid: region.uuid, levels: levelCount([...region.levels], scene) }));
  };
  return async (value, names, at) => {
    if (names === "Region" && isPlainObject(value) && typeof value.region === "string") {
      const found = named(value.region);
      if (found.length > 1) {
        throw refuse(
          `${found.length} bridge-made regions of this scene are named "${value.region}" (${found.map((one) => one.uuid).join(", ")}). Give the UUID of one in place of its name.`,
          at
        );
      }
      return found[0] ? { ...found[0], label: `"${value.region}"` } : null;
    }
    if (typeof value !== "string" || value.startsWith(".")) {
      const orName =
        names === "Region" ? ', or {region: "<name>"} for a region of this scene that the bridge made' : "";
      throw refuse(`Give the absolute UUID of a ${names ?? "document"}, such as Scene.<id>.Region.<id>${orName}.`, at);
    }
    const document = await findDocument(value);
    if (!document) throw new MethodError("not_found", `${at}Nothing exists at the UUID ${value}. Nothing was written.`);
    if (names !== undefined && document.documentName !== names) {
      throw refuse(`${value} is a ${document.documentName}, not a ${names}.`, at);
    }
    if (deleted.includes(document)) {
      throw refuse(`${value} is a bridge-made region that this call does not name, so the call deletes it.`, at);
    }
    return {
      uuid: document.uuid,
      label: value,
      ...(document.documentName === "Region" && { levels: levelCount([...document.levels], document.parent) })
    };
  };
}

/**
 * The system data of a behavior with each reference as an absolute UUID, and the names that lead nowhere yet.
 * Foundry teleports a token only into a region that is on one level (client/documents/region.mjs:1639-1641, called
 * without a level at client/data/region-behaviors/teleport-token.mjs:138), so a destination on several is refused.
 * @param {string} type
 * @param {unknown} system
 * @param {Resolve} resolve
 * @param {string} at
 */
async function withReferences(type, system, resolve, at) {
  if (!isPlainObject(system)) return { system, pending: [] };
  const resolved = { ...system };
  const pending = [];
  for (const { key, list, names } of referenceFields(type)) {
    const given = system[key];
    if (given === undefined || given === null) continue;
    if (list && !Array.isArray(given)) throw refuse(`system.${key} must be a list.`, at);
    const uuids = [];
    for (const [index, value] of (list ? given : [given]).entries()) {
      const place = `${at}system.${key}${list ? `[${index}]` : ""}: `;
      const target = await resolve(value, names, place);
      if (!target) {
        pending.push(value.region);
      } else if (type === "teleportToken" && target.levels !== 1) {
        throw refuse(
          `The destination ${target.label} is on ${target.levels} levels. Foundry teleports a token only into a region that is on exactly one level: sync that region in a call whose levels name one level.`,
          place
        );
      } else {
        uuids.push(target.uuid);
      }
    }
    resolved[key] = list ? [...new Set(uuids)] : (uuids[0] ?? null);
  }
  return { system: resolved, pending };
}

/**
 * A changeLevel behavior offers a token the other levels its region is on, and nothing on a region of one level
 * (client/data/region-behaviors/change-level.mjs:66-70, :233-246).
 */
function refuseStairToNowhere(type, levels, scene, at) {
  if (type !== "changeLevel" || levelCount(levels, scene) !== 1) return;
  throw refuse(
    "A changeLevel behavior offers a token the other levels its region is on, and with this call's levels the region is on one level, so it would offer none. Sync the stair in a call whose levels are the levels it joins, or that has no levels for every level of the scene.",
    at
  );
}

/**
 * Every check of the behaviors an entry gives, against the bridge-made behaviors of its region. Those someone added
 * in Foundry are never found by a name and never deleted. Reads only.
 * @param {any} region the region the behaviors lie in: the stored one, or the one built for a creation
 * @param {boolean} stored whether the region exists
 * @returns {Promise<{behaviors: BehaviorPlan[], stale: any[]}>}
 */
async function planBehaviors(region, stored, entries, where, { scene, levels, resolve }) {
  const kind = kindOf("RegionBehavior");
  const types = systemTypes("RegionBehavior");
  const mine = stored ? region.behaviors.filter(isManaged) : [];
  const own = entries
    .map((entry, index) => ({ entry, name: entry.name || entry.type, where: `${where}.behaviors[${index}]` }))
    .filter(({ entry }) => entry.managed !== false);
  refuseRepeated(own, "a behavior of a region");
  const behaviors = [];
  for (const { entry, name, where: place } of own) {
    const at = `${place}: `;
    const { id: _id, managed: _managed, type, name: _name, ...fields } = entry;
    refuseKept(fields, at);
    if (!types.includes(type)) throw refuse(unknownType("region behavior type", type, types), at);
    refuseStairToNowhere(type, levels, scene, at);
    // A behavior that was stored without a name goes by its type, as an entry without one does.
    const matches = mine.filter((behavior) => (storedName(behavior) || type) === name && behavior.type === type);
    if (matches.length > 1) {
      throw refuse(
        `${matches.length} bridge-made behaviors of the region ${region.name} are named "${name}" (${matches.map((behavior) => behavior.id).join(", ")}). Delete all but one in Foundry, or with delete_documents.`,
        at
      );
    }
    const [behavior] = matches;
    const { system, pending } = await withReferences(type, fields.system, resolve, at);
    const stated = { ...fields, name, ...(system !== undefined && { system }) };
    if (behavior) {
      const asked = withoutOwnFlags(kind, stated, behavior._source);
      refuseRuled(rulesOf("RegionBehavior").update?.(behavior, asked, []), at);
      const write = await planUpdate(kind, behavior, asked, { where: at, same: sameReferences(behavior) });
      behaviors.push({ name, type, document: behavior, data: null, write, pending });
    } else {
      const asked = { ...stated, type };
      refuseRuled(rulesOf("RegionBehavior").create?.(asked), at);
      checkAsked(kind, asked, { type, where: at });
      const data = { ...structuredClone(asked), flags: { ...asked.flags, ...BRIDGE_MADE } };
      const { write } = await planBuilt(kind, CONFIG.RegionBehavior.documentClass, data, asked, {
        parent: region,
        where: at
      });
      behaviors.push({ name, type, document: null, data, write, pending });
    }
  }
  return { behaviors, stale: mine.filter((behavior) => !behaviors.some((plan) => plan.document === behavior)) };
}

/** What an entry gives of the region's own stored data, with its shapes as Foundry stores them. */
function regionAsked(entry, { frame, rect }, at) {
  const { id: _id, managed: _managed, levels: _levels, behaviors: _behaviors, shapes, ...fields } = entry;
  refuseKept(fields, at);
  const stored = shapes.map((shape, index) => {
    const { shape: onCanvas, problems } = shapeOnCanvas(shape, frame, rect);
    if (problems.length > 0) throw refuse(`shapes[${index}]: ${problems.join(" ")}`, at);
    return onCanvas;
  });
  return { ...fields, shapes: stored };
}

/**
 * Every check of one entry, and what it leads to. The region gets the call's levels. Reads only.
 * @returns {Promise<RegionPlan>}
 */
async function planRegion({ entry, where, document, id }, context) {
  const { scene, levels, geometry } = context;
  const at = `${where}: `;
  const kind = kindOf("Region");
  const asked = regionAsked(entry, geometry, at);
  let region = document;
  let data = null;
  let write;
  if (document) {
    // Stored levels that are the call's in another order are no change.
    const fields = sameLevels(document._source.levels, levels) ? asked : { ...asked, levels: [...levels] };
    write = await planUpdate(kind, document, withoutOwnFlags(kind, fields, document._source), { where: at });
  } else {
    const fields = { ...asked, levels: [...levels] };
    checkAsked(kind, fields, { where: at });
    data = { ...structuredClone(fields), _id: id, flags: { ...fields.flags, ...BRIDGE_MADE } };
    ({ built: region, write } = await planBuilt(kind, CONFIG.Region.documentClass, data, fields, {
      parent: scene,
      where: at
    }));
  }
  const { behaviors, stale } =
    entry.behaviors === undefined
      ? { behaviors: null, stale: [] }
      : await planBehaviors(region, document !== null, entry.behaviors, where, context);
  return { name: entry.name, document, data, write, behaviors, stale };
}

/**
 * Every check of a sync, and what it leads to. Reads only.
 * @returns {Promise<Plan>}
 */
async function planRegions(scene, { frame, levels = [], regions }) {
  checkLevels(scene, levels);
  const sceneLevels = [...scene.levels.keys()];
  const rect = sceneRect(scene);
  const entries = ownEntries(regions, levels, sceneLevels);
  const owned = scene.regions.filter((region) => replacedBySync(region, levels, sceneLevels));
  const claims = entries.map(({ entry, name, where }) => {
    const named = owned.filter((region) => region.name === name);
    if (named.length > 1) {
      throw refuse(
        `${named.length} bridge-made regions of this level set are named "${name}" (${named.map((region) => region.id).join(", ")}). Delete all but one in Foundry, or with delete_documents.`,
        `${where}: `
      );
    }
    const document = named[0] ?? null;
    // A new region is created under an id made here, so that a behavior of the same call can name it.
    return { entry, name, where, document, id: document?.id ?? foundry.utils.randomID() };
  });
  const deleted = owned.filter((region) => !claims.some((claim) => claim.document === region));
  refuseLosingHandMade(deleted);
  const context = {
    scene,
    levels,
    geometry: { frame: frame ?? sceneFrame(rect), rect },
    resolve: referenceResolver(scene, claims, { owned, deleted, levels })
  };
  const plans = [];
  for (const claim of claims) plans.push(await planRegion(claim, context));
  const names = new Set(claims.map((claim) => claim.name));
  const handPlaced = scene.regions
    .filter((region) => !isManaged(region) && names.has(region.name))
    .map((region) => ({ id: region.id, name: region.name }));
  return { regions: plans, deleted, handPlaced };
}

export async function prepareRegions(request) {
  const scene = resolveScene(request.sceneId);
  await planRegions(scene, request);
  return { scene, request };
}

/** The behavior a write made for a plan: a region has one bridge-made behavior of a name and type. */
const madeFor = (plan, region) =>
  region.behaviors.find(
    (behavior) => isManaged(behavior) && storedName(behavior) === plan.name && behavior.type === plan.type
  );

function behaviorOutcome(plan, region, state) {
  const behavior = plan.document ?? madeFor(plan, region);
  const pending = plan.pending.length > 0 ? { pending: plan.pending } : {};
  if (!behavior) return { name: plan.name, type: plan.type, created: false, error: NOT_CREATED, ...pending };
  // Whatever spelling Foundry stored a reference in, it is the asked one when it names the same document.
  const named = sameReferences(behavior);
  const same = (path, a, b) => plan.write.same(path, a, b) || named(path, a, b);
  return {
    id: behavior.id,
    name: behavior.name,
    type: behavior.type,
    created: !plan.document,
    ...writeOutcome({ ...plan.write, same }, state.before.get(plan) ?? {}, behavior._source, !state.refused.has(plan)),
    ...pending
  };
}

function regionOutcome(plan, state) {
  const region = plan.document ?? state.made.get(plan);
  if (!region) return { name: plan.name, created: false, error: NOT_CREATED };
  return {
    id: region.id,
    name: region.name,
    created: !plan.document,
    ...writeOutcome(plan.write, state.before.get(plan) ?? {}, region._source, !state.refused.has(plan)),
    ...(plan.behaviors && {
      behaviors: plan.behaviors.map((behavior) => behaviorOutcome(behavior, region, state)),
      removedBehaviors: state.removed.get(plan) ?? 0
    })
  };
}

/** Whether the sync wrote anything of a region that was there before: its own data, or a behavior of it. */
const wasUpdated = (region) =>
  !region.created &&
  !region.error &&
  (wrote(region) || (region.behaviors ?? []).some(wrote) || region.removedBehaviors > 0);

function resultOf(scene, plan, state) {
  const regions = plan.regions.map((region) => regionOutcome(region, state));
  return {
    created: regions.filter((region) => region.created).length,
    updated: regions.filter(wasUpdated).length,
    deleted: state.deleted,
    regions,
    ...(plan.handPlaced.length > 0 && { handPlaced: plan.handPlaced }),
    sceneId: scene.id,
    sceneName: scene.name
  };
}

/** What the stored data shows of a plan after a write that threw: Foundry may have applied a part of it. */
function describeWritten({ regions, deleted }) {
  return writtenBefore([
    ...regions.flatMap((region) => [
      ...writtenPart("region", region),
      ...(region.behaviors ?? []).flatMap((behavior) => writtenPart(`behavior of the region ${region.name}`, behavior)),
      ...(region.removedBehaviors > 0
        ? [`${region.removedBehaviors} behaviors of the region ${region.name} deleted`]
        : [])
    ]),
    ...(deleted > 0 ? [`${deleted} regions deleted`] : [])
  ]);
}

/** An update resolves without the document when a hook refuses it (client/data/client-backend.mjs:237-241). */
async function update(plan, state) {
  const { update: changes, writes } = updateFor(plan.write, plan.document._source, _del);
  if (writes && (await plan.document.update(changes)) === undefined) state.refused.add(plan);
}

/**
 * The Foundry calls a plan takes, in their order. A new region is created with its behaviors in one call, under the
 * id the plan made for it. Regions are deleted last, so that a call that fails earlier has deleted none.
 */
function stepsOf(scene, plan, state) {
  const Region = CONFIG.Region.documentClass;
  const Behavior = CONFIG.RegionBehavior.documentClass;
  const steps = [];
  for (const region of plan.regions) {
    const behaviors = region.behaviors ?? [];
    if (!region.document) {
      steps.push({
        what: `creating the region ${region.name}`,
        run: async () => {
          const data = { ...structuredClone(region.data), behaviors: behaviors.map((behavior) => behavior.data) };
          state.made.set(region, (await Region.create(data, { parent: scene, keepId: true })) ?? null);
        }
      });
      continue;
    }
    steps.push({ what: `updating the region ${region.name}`, run: () => update(region, state) });
    for (const behavior of behaviors) {
      steps.push({
        what: `writing the behavior ${behavior.name} of the region ${region.name}`,
        run: () =>
          behavior.document
            ? update(behavior, state)
            : Behavior.create(structuredClone(behavior.data), { parent: region.document })
      });
    }
    if (region.stale.length === 0) continue;
    steps.push({
      what: `deleting behaviors of the region ${region.name}`,
      run: async () => {
        const ids = region.stale.map((behavior) => behavior.id);
        state.removed.set(region, (await Behavior.deleteDocuments(ids, { parent: region.document })).length);
      }
    });
  }
  if (plan.deleted.length > 0) {
    steps.push({
      what: "deleting the regions the call does not name",
      run: async () => {
        const ids = plan.deleted.map((region) => region.id);
        state.deleted = (await Region.deleteDocuments(ids, { parent: scene })).length;
      }
    });
  }
  return steps;
}

export async function syncRegions({ scene, request }) {
  // Planned again inside the write queue: a write queued before this one may have changed the scene since prepare looked.
  const plan = await planRegions(scene, request);
  const state = { before: new Map(), made: new Map(), refused: new Set(), removed: new Map(), deleted: 0 };
  for (const one of plan.regions.flatMap((region) => [region, ...(region.behaviors ?? [])])) {
    if (one.document) state.before.set(one, one.document.toObject());
  }
  await runSteps(stepsOf(scene, plan, state), () => describeWritten(resultOf(scene, plan, state)));
  return resultOf(scene, plan, state);
}
