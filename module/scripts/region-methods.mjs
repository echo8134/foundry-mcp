// sync_regions, which brings the regions the bridge made on one level set of a scene to a given list. planRegionSync
// runs every check and reads only. writeRegionSync writes the plan and reports from the stored data.

import { isPlainObject, writeOutcome } from "./data-diff.mjs";
import { findDocument, systemTypes, unknownType } from "./document-access.mjs";
import { rulesOf } from "./document-rules.mjs";
import { MethodError } from "./errors.mjs";
import { shapeOnCanvas } from "./region-data.mjs";
import { absoluteSystem, pendingOf, referenceFields, sameReferences } from "./region-references.mjs";
import { FLAG_SCOPE, isManaged, levelCount, ownedEntries, replacedBySync, sameLevelSet, sameLevels } from "./scope.mjs";
import { checkLevels, sceneFrame, sceneRect } from "./world.mjs";
import {
  checkAsked,
  firstRepeat,
  kindOf,
  NOT_CREATED,
  planBuilt,
  planUpdate,
  refuse,
  refuseRuled,
  withoutOwnFlags
} from "./write-checks.mjs";
import { runSteps, updatesOf, writtenBefore, writtenPart, wrote } from "./write-steps.mjs";

/** @typedef {{field: string, region: string}} Pending a region named by a name that no region of the scene has yet */
/**
 * @typedef {object} BehaviorPlan what one behavior of an entry leads to
 * @property {string} id the id the behavior has, or is created under
 * @property {string} name the name it is stored under, which is empty for one without a name
 * @property {string} type
 * @property {any} document the behavior to change, null for one to create
 * @property {Record<string, any> | null} data the data to create it from
 * @property {import("./data-diff.mjs").Asked} write
 * @property {Pending[]} pending
 */
/**
 * @typedef {object} RegionPlan what one entry of the request leads to
 * @property {string} id the id the region has, or is created under
 * @property {string} name
 * @property {any} document the region to change, null for one to create
 * @property {Record<string, any> | null} data the data to create it from, without its behaviors
 * @property {import("./data-diff.mjs").Asked} write
 * @property {BehaviorPlan[] | null} behaviors null for an entry that says nothing of behaviors
 * @property {any[]} stale the bridge-made behaviors of the region that the entry does not name
 */
/**
 * @typedef {object} WaitingPlan a behavior of another region that waited for a region of this call by its name
 * @property {any} region the region the behavior lies in
 * @property {any} document the behavior
 * @property {import("./data-diff.mjs").Asked} write its destinations with the regions found, and the names still open
 * @property {string[]} names the names that lead to a region now
 */
/** @typedef {{regions: RegionPlan[], deleted: any[], handPlaced: {id: string, name: string}[], waiting: WaitingPlan[]}} Plan */
/** @typedef {{uuid: string, levels: number}} Target a region a name leads to, and how many levels it is on */

const PENDING_FLAG = `flags.${FLAG_SCOPE}.pending`;

/** The bridge's own flag of a document it creates. A behavior keeps in it the regions it names that do not exist yet. */
const bridgeFlag = (pending = []) => ({ [FLAG_SCOPE]: { managed: true, ...(pending.length > 0 && { pending }) } });

/** What the bridge's own flag of a behavior that exists is to say of the regions that do not exist yet. */
const withPending = (write, pending) =>
  pending.length > 0
    ? { ...write, wanted: { ...write.wanted, flags: { ...write.wanted.flags, [FLAG_SCOPE]: { pending } } } }
    : { ...write, remove: [...write.remove, PENDING_FLAG] };

/**
 * What the sync finds a bridge-made behavior of a region by, in the words of a refusal: its type and its name. One
 * without a name is stored without one, so that Foundry shows the label of its type
 * (client/documents/region-behavior.mjs:76-78), and goes by its type.
 */
const behaviorKey = (type, name) => `${type} "${name || type}"`;

/**
 * What Foundry does with a behavior of a type and its data model does not say, each as a check that answers with the
 * sentence of a refusal or with nothing. `region` is asked of the number of levels the behavior's region is on, and
 * `target` of each document a reference of the behavior leads to.
 */
const BEHAVIOR_CHECKS = Object.freeze({
  // It offers a token the other levels its region is on (client/data/region-behaviors/change-level.mjs:66-70, :233-246).
  changeLevel: {
    region: (levels) =>
      levels === 1
        ? "A changeLevel behavior offers a token the other levels its region is on, and with this call's levels the region is on one level, so it would offer none. Sync the stair in a call whose levels are the levels it joins, or that has no levels for every level of the scene."
        : null
  },
  // It teleports a token only into a region that is on one level (client/documents/region.mjs:1639-1641, called
  // without a level at client/data/region-behaviors/teleport-token.mjs:138).
  teleportToken: {
    target: ({ label, levels }) =>
      levels === 1
        ? null
        : `The destination ${label} is on ${levels} levels. Foundry teleports a token only into a region that is on exactly one level: sync that region in a call whose levels name one level.`
  }
});

function refuseKept(fields, at) {
  const keys = Object.keys(fields).filter((key) => key.startsWith("_"));
  if (keys.length > 0) {
    throw refuse(`${keys.join(" and ")} cannot be given: Foundry keeps ${keys.length > 1 ? "them" : "it"} itself.`, at);
  }
}

/**
 * The one bridge-made document a name leads to, or none. Several are refused: the sync could not tell which is meant.
 * @param {any[]} named the bridge-made documents that have the name
 * @param {string} what what they are and share, as it reads after their number
 */
function oneNamed(named, what, at) {
  if (named.length > 1) {
    throw refuse(
      `${named.length} bridge-made ${what} (${named.map((one) => one.id).join(", ")}). Delete all but one in Foundry, or with delete_documents.`,
      at
    );
  }
  return named[0] ?? null;
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
 * The bridge-made regions of the scene that have a name once the call is written: the one of the call, under the id
 * it has or is created under, and those of other level sets. A region made by hand is named by its UUID.
 * @param {any} scene
 * @param {{name: string, id: string}[]} claims the regions of the call
 * @param {any[]} owned the bridge-made regions of the call's level set
 * @param {readonly string[]} levels
 * @returns {(name: string) => {own: Target[], others: Target[]}}
 */
function namedRegions(scene, claims, owned, levels) {
  const count = (onLevels) => levelCount(onLevels, scene.levels.keys());
  return (name) => ({
    own: claims
      .filter((claim) => claim.name === name)
      .map((claim) => ({ uuid: `${scene.uuid}.Region.${claim.id}`, levels: count(levels) })),
    others: scene.regions
      .filter((region) => isManaged(region) && region.name === name && !owned.includes(region))
      .map((region) => ({ uuid: region.uuid, levels: count(region.levels) }))
  });
}

/**
 * What a reference of a behavior leads to: the absolute UUID, what the refusal of it calls it, and for a region how
 * many levels it is on. Or the name it gives, where no bridge-made region of the scene has that name yet.
 * @typedef {(value: unknown, names: string | undefined, at: string) => Promise<(Partial<Target> & {uuid: string, label: string}) | {pending: string}>} Resolve
 */

/**
 * A name leads to the region of the call that has it, and else to the one bridge-made region of the scene that has it
 * on another level set.
 * @param {ReturnType<typeof namedRegions>} named
 * @param {any[]} deleted the regions the call deletes
 * @returns {Resolve}
 */
function referenceResolver(named, deleted) {
  return async (value, names, at) => {
    if (names === "Region" && isPlainObject(value) && typeof value.region === "string") {
      const { own, others } = named(value.region);
      if (own.length === 0 && others.length > 1) {
        throw refuse(
          `${others.length} bridge-made regions of this scene are named "${value.region}" (${others.map((one) => one.uuid).join(", ")}). Give the UUID of one in place of its name.`,
          at
        );
      }
      const [found] = [...own, ...others];
      return found ? { ...found, label: `"${value.region}"` } : { pending: value.region };
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
      ...(document.documentName === "Region" && {
        levels: levelCount(document.levels, document.parent.levels.keys())
      })
    };
  };
}

/**
 * The system data of a behavior with each reference as an absolute UUID, and the regions it names that do not exist
 * yet, which are left out of the data.
 * @param {string} type
 * @param {unknown} system
 * @param {Resolve} resolve
 * @param {string} at
 * @returns {Promise<{system: unknown, pending: Pending[]}>}
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
      if ("pending" in target) {
        pending.push({ field: key, region: target.pending });
        continue;
      }
      refuseRuled(BEHAVIOR_CHECKS[type]?.target?.(target), place);
      uuids.push(target.uuid);
    }
    resolved[key] = list ? [...new Set(uuids)] : (uuids[0] ?? null);
  }
  return { system: resolved, pending };
}

/**
 * Every check of the behaviors an entry gives, against the bridge-made behaviors of its region. Those someone added
 * in Foundry are never found and never deleted. Reads only.
 * @param {any} region the region the behaviors lie in: the stored one, or the one built for a creation
 * @param {boolean} stored whether the region exists
 * @returns {Promise<{behaviors: BehaviorPlan[], stale: any[]}>}
 */
async function planBehaviors(region, stored, entries, where, { scene, levels, resolve }) {
  const kind = kindOf("RegionBehavior");
  const types = systemTypes("RegionBehavior");
  const mine = stored ? region.behaviors.filter(isManaged) : [];
  const own = entries
    .map((entry, index) => ({ entry, where: `${where}.behaviors[${index}]` }))
    .filter(({ entry }) => entry.managed !== false);
  const repeat = firstRepeat(
    own.map(({ entry, where: at }) => ({ key: behaviorKey(entry.type, entry.name), where: at }))
  );
  if (repeat) {
    throw refuse(
      `${repeat.first} and ${repeat.second} are both the behavior ${repeat.key}. The sync finds a behavior of a region by its type and its name: give one of them another name.`
    );
  }
  const behaviors = [];
  for (const { entry, where: place } of own) {
    const at = `${place}: `;
    const { id: _id, managed: _managed, type, name = "", ...fields } = entry;
    refuseKept(fields, at);
    if (!types.includes(type)) throw refuse(unknownType("region behavior type", type, types), at);
    refuseRuled(BEHAVIOR_CHECKS[type]?.region?.(levelCount(levels, scene.levels.keys())), at);
    const key = behaviorKey(type, name);
    const behavior = oneNamed(
      mine.filter((one) => behaviorKey(one.type, one._source.name) === key),
      `behaviors of the region ${region.name} are the ${key}`,
      at
    );
    const { system, pending: open } = await withReferences(type, fields.system, resolve, at);
    // A field the entry leaves out keeps the names it waits for, as it keeps its stored destinations.
    const kept = behavior ? pendingOf(behavior).filter(({ field }) => fields.system?.[field] === undefined) : [];
    const pending = [...kept, ...open];
    const stated = { ...fields, name, ...(system !== undefined && { system }) };
    if (behavior) {
      const asked = withoutOwnFlags(kind, stated, behavior._source);
      refuseRuled(rulesOf("RegionBehavior").update?.(behavior, asked, []), at);
      const write = await planUpdate(kind, behavior, asked, { where: at, same: sameReferences(behavior) });
      behaviors.push({
        id: behavior.id,
        name,
        type,
        document: behavior,
        data: null,
        write: withPending(write, pending),
        pending
      });
    } else {
      const asked = { ...stated, type };
      refuseRuled(rulesOf("RegionBehavior").create?.(asked), at);
      checkAsked(kind, asked, { type, where: at });
      // Created under an id made here, so that the result finds the behavior whatever else the region holds.
      const id = foundry.utils.randomID();
      const data = { ...structuredClone(asked), _id: id, flags: { ...asked.flags, ...bridgeFlag(pending) } };
      const { write } = await planBuilt(kind, CONFIG.RegionBehavior.documentClass, data, asked, {
        parent: region,
        where: at,
        same: sameReferences
      });
      behaviors.push({ id, name, type, document: null, data, write, pending });
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
    data = { ...structuredClone(fields), _id: id, flags: { ...fields.flags, ...bridgeFlag() } };
    ({ built: region, write } = await planBuilt(kind, CONFIG.Region.documentClass, data, fields, {
      parent: scene,
      where: at
    }));
  }
  const { behaviors, stale } =
    entry.behaviors === undefined
      ? { behaviors: null, stale: [] }
      : await planBehaviors(region, document !== null, entry.behaviors, where, context);
  return { id, name: entry.name, document, data, write, behaviors, stale };
}

/**
 * The behaviors of the scene that wait for a region by its name (see pendingOf) and that the call writes nothing else
 * of, each with the regions its names lead to now. A name leads on once exactly one bridge-made region of the scene
 * has it and the behavior's type takes that region. Until then it stays as it is. Reads only.
 * @param {any} scene
 * @param {RegionPlan[]} plans
 * @param {any[]} deleted the regions the call deletes
 * @param {ReturnType<typeof namedRegions>} named
 * @returns {Promise<WaitingPlan[]>}
 */
async function planWaiting(scene, plans, deleted, named) {
  const kind = kindOf("RegionBehavior");
  const written = new Set(
    plans.flatMap((plan) => [...(plan.behaviors ?? []).map((behavior) => behavior.document), ...plan.stale])
  );
  const waiting = [];
  for (const region of scene.regions.filter((one) => !deleted.includes(one))) {
    for (const behavior of region.behaviors.filter((one) => !written.has(one))) {
      const pending = pendingOf(behavior);
      const found = pending.flatMap((one) => {
        const { own, others } = named(one.region);
        const [target, ...more] = [...own, ...others];
        const refusal = BEHAVIOR_CHECKS[behavior.type]?.target;
        return target && more.length === 0 && !refusal?.({ ...target, label: one.region })
          ? [{ ...one, uuid: target.uuid }]
          : [];
      });
      if (found.length === 0) continue;
      const names = found.map((one) => one.region);
      const stored = absoluteSystem(behavior);
      const system = {};
      for (const { field, uuid } of found) system[field] = [...new Set([...(system[field] ?? stored[field]), uuid])];
      const at = `The ${behavior.type} behavior ${behavior.id} of the region ${region.name} waits for the region ${names.join(", ")}, which this call makes: `;
      refuseRuled(rulesOf("RegionBehavior").update?.(behavior, { system }, []), at);
      const write = await planUpdate(kind, behavior, { system }, { where: at, same: sameReferences(behavior) });
      const open = pending.filter((one) => !found.some((hit) => hit.field === one.field && hit.region === one.region));
      waiting.push({ region, document: behavior, write: withPending(write, open), names });
    }
  }
  return waiting;
}

/**
 * Every check of a sync, and what it leads to. Reads only.
 * @returns {Promise<Plan>}
 */
export async function planRegionSync(scene, { frame, levels = [], regions }) {
  checkLevels(scene, levels);
  const sceneLevels = [...scene.levels.keys()];
  const rect = sceneRect(scene);
  const entries = ownedEntries(regions, levels, sceneLevels, "regions").map(({ entry, index }) => ({
    entry,
    name: entry.name,
    where: `regions[${index}]`
  }));
  const repeat = firstRepeat(entries.map(({ name, where }) => ({ key: name, where })));
  if (repeat) {
    throw refuse(
      `${repeat.first} and ${repeat.second} are both named "${repeat.key}". The sync finds a region by its name: give each another name.`
    );
  }
  const owned = scene.regions.filter((region) => replacedBySync(region, levels, sceneLevels));
  const claims = entries.map(({ entry, name, where }) => {
    const document = oneNamed(
      owned.filter((region) => region.name === name),
      `regions of this level set are named "${name}"`,
      `${where}: `
    );
    // A new region is created under an id made here, so that a behavior of the same call can name it.
    return { entry, name, where, document, id: document?.id ?? foundry.utils.randomID() };
  });
  const deleted = owned.filter((region) => !claims.some((claim) => claim.document === region));
  refuseLosingHandMade(deleted);
  const named = namedRegions(scene, claims, owned, levels);
  const context = {
    scene,
    levels,
    geometry: { frame: frame ?? sceneFrame(rect), rect },
    resolve: referenceResolver(named, deleted)
  };
  const plans = [];
  for (const claim of claims) plans.push(await planRegion(claim, context));
  const names = new Set(claims.map((claim) => claim.name));
  // A region of the same name on another level set is no double of an entry: every floor may have its stairs.
  const handPlaced = scene.regions
    .filter(
      (region) => !isManaged(region) && names.has(region.name) && sameLevelSet(region.levels, levels, sceneLevels)
    )
    .map((region) => ({ id: region.id, name: region.name }));
  return { regions: plans, deleted, handPlaced, waiting: await planWaiting(scene, plans, deleted, named) };
}

/** What became of a behavior of an entry, read from its region under the id of its plan. */
function behaviorOutcome(plan, region, before) {
  const behavior = region.behaviors.get(plan.id);
  const pending = plan.pending.length > 0 ? { pending: plan.pending.map((one) => one.region) } : {};
  if (!behavior) return { name: plan.name, type: plan.type, created: false, error: NOT_CREATED, ...pending };
  return {
    id: behavior.id,
    name: behavior._source.name,
    type: behavior.type,
    created: !plan.document,
    ...writeOutcome(plan.write, before.get(plan) ?? {}, behavior._source),
    ...pending
  };
}

/** What became of an entry, read from the scene under the id of its plan. */
function regionOutcome(plan, scene, before) {
  const region = scene.regions.get(plan.id);
  if (!region) return { name: plan.name, created: false, error: NOT_CREATED };
  return {
    id: region.id,
    name: region.name,
    created: !plan.document,
    ...writeOutcome(plan.write, before.get(plan) ?? {}, region._source),
    ...(plan.behaviors && {
      behaviors: plan.behaviors.map((behavior) => behaviorOutcome(behavior, region, before)),
      removedBehaviors: plan.stale.filter((behavior) => !region.behaviors.has(behavior.id)).length
    })
  };
}

/** Whether the sync wrote anything of a region that was there before: its own data, or a behavior of it. */
const wasUpdated = (region) =>
  !region.created &&
  !region.error &&
  (wrote(region) || (region.behaviors ?? []).some(wrote) || region.removedBehaviors > 0);

/** The result of a sync, and what a failed one says was written: all of it read from the stored data. */
function resultOf(scene, plan, before) {
  const regions = plan.regions.map((region) => regionOutcome(region, scene, before));
  const resolved = plan.waiting.map((waiting) => ({
    id: waiting.document.id,
    type: waiting.document.type,
    region: { id: waiting.region.id, name: waiting.region.name },
    names: waiting.names,
    ...writeOutcome(waiting.write, before.get(waiting), waiting.document._source)
  }));
  return {
    created: regions.filter((region) => region.created).length,
    updated: regions.filter(wasUpdated).length,
    deleted: plan.deleted.filter((region) => !scene.regions.has(region.id)).length,
    regions,
    ...(resolved.length > 0 && { resolved }),
    ...(plan.handPlaced.length > 0 && { handPlaced: plan.handPlaced }),
    sceneId: scene.id,
    sceneName: scene.name
  };
}

/** What the stored data shows of a plan after a write that threw: Foundry may have applied a part of it. */
function describeWritten({ regions, resolved = [], deleted }) {
  const behaviorPart = (regionName, behavior) =>
    writtenPart(`behavior of the region ${regionName}`, { ...behavior, name: behavior.name || behavior.type });
  return writtenBefore([
    ...regions.flatMap((region) => [
      ...writtenPart("region", region),
      ...(region.behaviors ?? []).flatMap((behavior) => behaviorPart(region.name, behavior)),
      ...(region.removedBehaviors > 0
        ? [`${region.removedBehaviors} behaviors of the region ${region.name} deleted`]
        : [])
    ]),
    ...resolved.flatMap((one) => behaviorPart(one.region.name, { ...one, name: "", created: false })),
    ...(deleted > 0 ? [`${deleted} regions deleted`] : [])
  ]);
}

/**
 * The Foundry calls a plan takes, in their order: the new regions in one call, each with its behaviors, the changed
 * regions in one, then for each region that was there its new, its changed and its dropped behaviors, then the
 * behaviors that waited for a region of this call. Regions are deleted last, so that a call that fails earlier has
 * deleted none. A call that would send nothing is not made.
 */
function stepsOf(scene, plan) {
  const Region = CONFIG.Region.documentClass;
  const Behavior = CONFIG.RegionBehavior.documentClass;
  const some = (list, send) => list.length > 0 && send(list);
  const creations = plan.regions.filter((region) => !region.document);
  const changed = plan.regions.filter((region) => region.document);
  const waitingIn = new Map();
  for (const waiting of plan.waiting)
    waitingIn.set(waiting.region, [...(waitingIn.get(waiting.region) ?? []), waiting]);
  return [
    {
      what: "creating the regions",
      run: () =>
        some(
          creations.map((region) => ({
            ...structuredClone(region.data),
            behaviors: (region.behaviors ?? []).map((behavior) => structuredClone(behavior.data))
          })),
          (data) => Region.createDocuments(data, { parent: scene, keepId: true })
        )
    },
    {
      what: "updating the regions",
      run: () => some(updatesOf(changed), (updates) => Region.updateDocuments(updates, { parent: scene }))
    },
    ...changed.flatMap(({ name, document: parent, behaviors, stale }) => [
      {
        what: `creating the behaviors of the region ${name}`,
        run: () =>
          some(
            (behaviors ?? []).flatMap((behavior) => (behavior.document ? [] : [structuredClone(behavior.data)])),
            (data) => Behavior.createDocuments(data, { parent, keepId: true })
          )
      },
      {
        what: `updating the behaviors of the region ${name}`,
        run: () => some(updatesOf(behaviors ?? []), (updates) => Behavior.updateDocuments(updates, { parent }))
      },
      {
        what: `deleting behaviors of the region ${name}`,
        run: () =>
          some(
            stale.map((behavior) => behavior.id),
            (ids) => Behavior.deleteDocuments(ids, { parent })
          )
      }
    ]),
    ...[...waitingIn].map(([parent, waiting]) => ({
      what: `writing the destinations the region ${parent.name} waited for`,
      run: () => some(updatesOf(waiting), (updates) => Behavior.updateDocuments(updates, { parent }))
    })),
    {
      what: "deleting the regions the call does not name",
      run: () =>
        some(
          plan.deleted.map((region) => region.id),
          (ids) => Region.deleteDocuments(ids, { parent: scene })
        )
    }
  ];
}

/**
 * Writes a plan, and reports each entry from the stored data.
 * @param {any} scene
 * @param {Plan} plan
 */
export async function writeRegionSync(scene, plan) {
  const before = new Map();
  const existing = [...plan.regions, ...plan.regions.flatMap((region) => region.behaviors ?? []), ...plan.waiting];
  for (const one of existing) if (one.document) before.set(one, one.document.toObject());
  await runSteps(stepsOf(scene, plan), () => describeWritten(resultOf(scene, plan, before)));
  return resultOf(scene, plan, before);
}
