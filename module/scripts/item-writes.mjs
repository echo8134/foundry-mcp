// The items and active effects of an actor, as ensure_actor writes them. An item and an effect go the same way: each is
// found by id, or by name among what the bridge made, then changed where it exists and created where it does not.
// planEmbedded runs every check and reads only. writeEmbedded writes the plan and reports from the stored data.
//
// Measured on Foundry 14.370 with dnd5e 6.1.0, against what the server holds: for the actor of an unlinked token these
// same embedded-document calls write into the token's own changes and keep what that token changed before, items,
// effects and actor data alike. An item of the world actor that is changed for one token is stored whole with that
// token, so its entries can be removed there, and one that is deleted for a token leaves a tombstone with it.

import { dropAt, entriesToRemove, giveElementIds, writeOutcome } from "./data-diff.mjs";
import { resolveDocument, systemTypes, unknownType } from "./document-access.mjs";
import { MethodError } from "./errors.mjs";
import { elementIdArrays, initialTypeOf } from "./field-check.mjs";
import { asStoredEntries, withEntryId } from "./item-data.mjs";
import { idFor } from "./labels.mjs";
import { claimNamed, FLAG_SCOPE } from "./scope.mjs";
import {
  checkAsked,
  firstRepeat,
  forWrite,
  KINDS,
  NOT_CREATED,
  planBuilt,
  planUpdate,
  refuse,
  walkOf,
  withoutOwnFlags
} from "./write-checks.mjs";
import { runSteps, updatesOf, writtenBefore, writtenPart } from "./write-steps.mjs";

/**
 * @typedef {object} Plan what one entry of the request leads to
 * @property {string} where the entry in the request, such as items[2] or items[2].effects[0]
 * @property {string} key what tells two entries for one document apart
 * @property {any} document the document to change, null for one to create
 * @property {Record<string, any> | null} data the data to create it from
 * @property {string | null} id its id, null for an item to create: Foundry gives a new item its id
 * @property {string} name
 * @property {string} type
 * @property {import("./data-diff.mjs").Asked} write
 * @property {Plan[]} effects the effects of an item
 * @property {{ids: string[], dropped: number} | null} removal the effects to delete from an item, and how many the
 *   creation data of a new item was already cleared of. Null when the entry names none.
 */
/** @typedef {{items: Plan[], effects: Plan[], removeItems: string[] | null, removeEffects: string[] | null}} EmbeddedPlan */

/** The inputs of an item entry that are the item's own stored data, each under the name of its stored field. */
const ITEM_DATA_KEYS = Object.freeze(["name", "img", "system", "flags"]);

const EMBEDDED_INPUTS = Object.freeze(["items", "removeItems", "effects", "removeEffects"]);

const NOT_CREATED_HERE = `${NOT_CREATED} dnd5e gives a character one species and one background, and a group actor no features.`;

export const hasEmbedded = (request) => EMBEDDED_INPUTS.some((key) => request[key] !== undefined);

const schemaOf = (kind) => CONFIG[kind.document].documentClass.schema;

/**
 * dnd5e adds a copy of the spell a cast activity names to the actor, and deletes it with the activity (dnd5e
 * module/data/item/templates/activities.mjs:407-415, :451-475, module/documents/activity/cast.mjs:118-146). The copy
 * is dnd5e's own: a name never leads to it.
 */
const isSpellCopy = (item) => item.flags?.dnd5e?.cachedFor !== undefined;

const entryTypes = () => ({
  activities: Object.keys(CONFIG.DND5E.activityTypes),
  advancement: Object.keys(CONFIG.DND5E.advancementTypes)
});

/** The given data with an `_id` on each element of the lists whose elements carry one, taken from `stored` by place. */
function withElementIds(kind, given, stored, type) {
  const data = structuredClone(given);
  const lists = elementIdArrays(schemaOf(kind), data, walkOf(type));
  giveElementIds(data, lists, stored, () => foundry.utils.randomID());
  return data;
}

function askedItemData(entry, stored, type, at) {
  const given = Object.fromEntries(
    ITEM_DATA_KEYS.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]])
  );
  const { data, problems } = asStoredEntries(withoutOwnFlags(KINDS.Item, given, stored), stored, entryTypes());
  if (problems.length > 0) throw refuse(problems.join(" "), at);
  return withElementIds(KINDS.Item, data, stored, type);
}

/** Why a name leads to no document to write, by what claimNamed found. */
const NAME_REFUSALS = Object.freeze({
  several: (what, ids, key) => `${ids.length} bridge-made ${what} (${ids.join(", ")}). Pass the id of one as ${key}.`,
  handMade: (what, ids, key) =>
    `${what} that this bridge did not make (${ids.join(", ")}). Pass its id as ${key} to change it on purpose, or give another name.`
});

function refuseRepeats(plans, noun) {
  const repeat = firstRepeat(plans);
  if (repeat) {
    throw refuse(`${repeat.first} and ${repeat.second} lead to the same ${noun}. Give it once, with all its changes.`);
  }
}

function refuseChangedAndRemoved(plans, ids, list, noun) {
  const both = plans.filter((plan) => plan.id !== null && ids.includes(plan.id));
  if (both.length > 0) {
    throw refuse(
      `${both.map((plan) => `${plan.where} (${plan.id})`).join(", ")}: ${list} deletes the same ${noun} in this call. Do one of the two.`
    );
  }
}

async function planEffectChange(effect, given, where) {
  const at = `${where}: `;
  const kind = KINDS.ActiveEffect;
  if (given.type !== undefined && given.type !== effect.type) {
    throw refuse(`${effect.name} is of the type ${effect.type}, and an effect keeps its type. Leave type out.`, at);
  }
  const stored = effect._source;
  const asked = withElementIds(kind, withoutOwnFlags(kind, given, stored), stored, effect.type);
  return {
    where,
    key: effect.id,
    document: effect,
    data: null,
    id: effect.id,
    name: effect.name,
    type: effect.type,
    write: await planUpdate(kind, effect, asked, { where: at }),
    effects: [],
    removal: null
  };
}

async function planEffectCreation(parent, id, given, where) {
  const at = `${where}: `;
  const kind = KINDS.ActiveEffect;
  if (given.name === undefined) throw refuse("A new effect needs a name.", at);
  const types = systemTypes("ActiveEffect");
  const type = given.type ?? initialTypeOf(schemaOf(kind));
  if (!types.includes(type)) throw refuse(unknownType("effect type", type, types), at);
  const asked = withElementIds(kind, given, {}, type);
  checkAsked(kind, asked, { type, where: at });
  const data = { ...structuredClone(asked), _id: id, flags: { ...asked.flags, [FLAG_SCOPE]: { managed: true } } };
  const { built, write } = await planBuilt(kind, CONFIG.ActiveEffect.documentClass, data, asked, { parent, where: at });
  return {
    where,
    key: id,
    document: null,
    data,
    id,
    name: built.name,
    type,
    write,
    effects: [],
    removal: null
  };
}

/** With _id, the effect of that id or label, which is created under it when the parent has none. Without, by name. */
function planEffect(parent, { _id, ...given }, where) {
  if (_id !== undefined) {
    const id = idFor(_id);
    const effect = parent.effects.get(id);
    return effect ? planEffectChange(effect, given, where) : planEffectCreation(parent, id, given, where);
  }
  const at = `${where}: `;
  if (given.name === undefined) throw refuse("An effect needs an _id or a name.", at);
  const claim = claimNamed(parent.effects.filter((effect) => effect.name === given.name));
  if (claim.kind === "one") return planEffectChange(claim.document, given, where);
  if (claim.kind === "none") return planEffectCreation(parent, foundry.utils.randomID(), given, where);
  const ids = claim.documents.map((effect) => effect.id);
  const what = claim.kind === "several" ? "effects" : "An effect";
  throw refuse(NAME_REFUSALS[claim.kind](`${what} of ${parent.name} named "${given.name}"`, ids, "_id"), at);
}

async function planEffects(parent, entries, where) {
  const plans = [];
  for (const [index, entry] of entries.entries()) plans.push(await planEffect(parent, entry, `${where}[${index}]`));
  refuseRepeats(plans, "effect");
  return plans;
}

async function planItemChange(item, entry, where) {
  const at = `${where}: `;
  const kind = KINDS.Item;
  const { type, effects = [], remove = [], removeEffects } = entry;
  if (type !== undefined && type !== item.type) {
    throw refuse(
      `${item.name} is a ${item.type}, and Foundry cannot change the type of an item. Leave type out, or create another item.`,
      at
    );
  }
  const asked = askedItemData(entry, item._source, item.type, at);
  const write = await planUpdate(kind, item, asked, { remove: remove.map(withEntryId), where: at });
  const plans = await planEffects(item, effects, `${where}.effects`);
  const ids = removeEffects?.map(idFor) ?? [];
  refuseChangedAndRemoved(plans, ids, `${where}.removeEffects`, "effect");
  return {
    where,
    key: item.id,
    document: item,
    data: null,
    id: item.id,
    name: item.name,
    type: item.type,
    write,
    effects: plans,
    removal: removeEffects ? { ids, dropped: 0 } : null
  };
}

async function planItemCreation(actor, entry, source, where) {
  const at = `${where}: `;
  const kind = KINDS.Item;
  const { type, effects = [], remove = [], removeEffects } = entry;
  // Measured: fromCompendium leaves out the id, the folder and the sort of the source, keeps its effects with their
  // ids, resets the ownership to the current user, and records the source of a compendium item.
  const start = source ? game.items.fromCompendium(source, { clearFolder: true }) : {};
  const asked = askedItemData(entry, start, type, at);
  const removed = remove.map(withEntryId);
  checkAsked(kind, asked, { remove: removed, type, where: at });
  const data = foundry.utils.mergeObject(start, structuredClone(asked));
  for (const path of entriesToRemove(removed, data)) dropAt(data, path);
  data.type = type;
  data.flags = { ...data.flags, [FLAG_SCOPE]: { managed: true } };
  const copied = data.effects ?? [];
  const dropped = new Set(removeEffects?.map(idFor));
  const kept = copied.filter((effect) => !dropped.has(effect._id));
  data.effects = kept;
  const { built, write } = await planBuilt(kind, CONFIG.Item.documentClass, data, asked, {
    remove: removed,
    parent: actor,
    where: at
  });
  // The effects the copy brings are found and changed like those of an item that exists, each checked by its plan.
  const plans = await planEffects(built, effects, `${where}.effects`);
  refuseChangedAndRemoved(plans, [...dropped], `${where}.removeEffects`, "effect");
  data.effects = [
    ...kept.map((effect) => {
      const plan = plans.find((one) => one.document && one.id === effect._id);
      return plan ? foundry.utils.mergeObject(effect, structuredClone(plan.write.wanted)) : effect;
    }),
    ...plans.flatMap((plan) => (plan.document ? [] : [plan.data]))
  ];
  return {
    where,
    key: `${type} ${built.name}`,
    document: null,
    data,
    id: null,
    name: built.name,
    type,
    write,
    effects: plans,
    removal: removeEffects ? { ids: [], dropped: copied.length - kept.length } : null
  };
}

async function itemToCopy(from, at) {
  const source = await forWrite(resolveDocument(from, at));
  if (source.documentName !== "Item") {
    throw refuse(`The UUID ${from} is a ${source.documentName}, not an Item. Pass the UUID of an item as from.`, at);
  }
  return source;
}

/**
 * With id, that item of the actor. Without, the bridge-made item of exactly that name and type: one is changed, and
 * none means a new item.
 */
async function planItem(actor, entry, where) {
  const at = `${where}: `;
  const { id, type, from } = entry;
  if (id !== undefined) {
    const item = actor.items.get(id);
    if (!item) {
      throw new MethodError(
        "not_found",
        `${at}${actor.name} has no item with the id ${id}. Nothing was written. get_actor lists its items.`
      );
    }
    if (from !== undefined) {
      throw refuse("from copies an item when a new one is created, and id names one that exists. Leave from out.", at);
    }
    return planItemChange(item, entry, where);
  }
  const source = from === undefined ? null : await itemToCopy(from, at);
  if (source && type !== undefined && type !== source.type) {
    throw refuse(`${from} is a ${source.type}, not a ${type}. Leave type out, or pass ${source.type}.`, at);
  }
  const itemType = source?.type ?? type;
  const name = entry.name ?? source?.name;
  if (itemType === undefined || name === undefined) {
    throw refuse("An entry without id needs a name and a type, or from: the UUID of an item to copy.", at);
  }
  const types = systemTypes("Item");
  if (!types.includes(itemType)) throw refuse(unknownType("item type", itemType, types), at);
  const named = actor.items.filter((item) => item.name === name && item.type === itemType && !isSpellCopy(item));
  const claim = claimNamed(named);
  if (claim.kind === "one") return planItemChange(claim.document, entry, where);
  if (claim.kind === "none") return planItemCreation(actor, { ...entry, name, type: itemType }, source, where);
  const ids = claim.documents.map((item) => item.id);
  const what = claim.kind === "several" ? `items of ${actor.name} are` : `${actor.name} has`;
  throw refuse(NAME_REFUSALS[claim.kind](`${what} a ${itemType} named "${name}"`, ids, "id"), at);
}

/**
 * Every check of the items and effects a request gives, and what each entry leads to. Reads only.
 * @param {any} actor the actor to write, or one built from the data a new actor is created from
 * @returns {Promise<EmbeddedPlan>}
 */
export async function planEmbedded(actor, { items = [], removeItems, effects = [], removeEffects }) {
  const itemPlans = [];
  for (const [index, entry] of items.entries()) itemPlans.push(await planItem(actor, entry, `items[${index}]`));
  refuseRepeats(itemPlans, "item");
  const effectPlans = await planEffects(actor, effects, "effects");
  const plan = {
    items: itemPlans,
    effects: effectPlans,
    removeItems: removeItems ? [...new Set(removeItems)] : null,
    removeEffects: removeEffects ? [...new Set(removeEffects.map(idFor))] : null
  };
  refuseChangedAndRemoved(itemPlans, plan.removeItems ?? [], "removeItems", "item");
  refuseChangedAndRemoved(effectPlans, plan.removeEffects ?? [], "removeEffects", "effect");
  return plan;
}

/** Ids that are not there are left out: Foundry throws for one, and deletes none (client/data/client-backend.mjs:402). */
async function deleteExisting(parent, documentName, collection, ids) {
  const existing = ids.filter((id) => collection.has(id));
  if (existing.length === 0) return 0;
  return (await parent.deleteEmbeddedDocuments(documentName, existing)).length;
}

async function writeEffects(parent, plans) {
  const creations = plans.flatMap((plan) => (plan.document ? [] : [plan.data]));
  if (creations.length > 0) await parent.createEmbeddedDocuments("ActiveEffect", creations, { keepId: true });
  const updates = updatesOf(plans);
  if (updates.length > 0) await parent.updateEmbeddedDocuments("ActiveEffect", updates);
}

/**
 * The Foundry calls a plan takes, in their order: new items in one request, then changed items in one, then effects,
 * then the deletions. `state` takes what only a call can tell: how many documents a deletion removed.
 */
function stepsOf(actor, plan, state) {
  const creations = plan.items.flatMap((item) => (item.document ? [] : [item.data]));
  const changed = plan.items.filter((item) => item.document);
  return [
    { what: "creating the items", run: () => creations.length > 0 && actor.createEmbeddedDocuments("Item", creations) },
    {
      what: "updating the items",
      run: () => {
        const updates = updatesOf(changed);
        return updates.length > 0 && actor.updateEmbeddedDocuments("Item", updates);
      }
    },
    { what: "writing the effects", run: () => writeEffects(actor, plan.effects) },
    ...changed.map((item) => ({
      what: `writing the effects of the item ${item.name}`,
      run: () => writeEffects(item.document, item.effects)
    })),
    {
      what: "deleting the items",
      run: async () => {
        state.removedItems = await deleteExisting(actor, "Item", actor.items, plan.removeItems ?? []);
      }
    },
    {
      what: "deleting the effects",
      run: async () => {
        state.removedEffects = await deleteExisting(actor, "ActiveEffect", actor.effects, plan.removeEffects ?? []);
      }
    },
    ...changed.flatMap((item) =>
      item.removal
        ? [
            {
              what: `deleting the effects of the item ${item.name}`,
              run: async () => {
                const { document } = item;
                state.removed.set(
                  item,
                  await deleteExisting(document, "ActiveEffect", document.effects, item.removal.ids)
                );
              }
            }
          ]
        : []
    )
  ];
}

function effectOutcome(plan, parent, state) {
  const effect = parent.effects.get(plan.id);
  if (!effect) return { id: plan.id, name: plan.name, created: false, error: NOT_CREATED_HERE };
  return {
    id: effect.id,
    name: effect.name,
    created: !plan.document,
    ...writeOutcome(plan.write, state.before.get(plan) ?? {}, effect._source)
  };
}

function itemOutcome(plan, actor, state) {
  // An item the call made is one the actor did not have before, of the name and type its entry asked for. The
  // documents a creation returns are not used: measured, they come in another order than the data.
  const item = plan.document
    ? actor.items.get(plan.id)
    : actor.items.find(
        (one) => !state.known.has(one.id) && !isSpellCopy(one) && one.name === plan.name && one.type === plan.type
      );
  if (!item) return { name: plan.name, type: plan.type, created: false, error: NOT_CREATED_HERE };
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    created: !plan.document,
    ...writeOutcome(plan.write, state.before.get(plan) ?? {}, item._source),
    ...(plan.effects.length > 0 && { effects: plan.effects.map((effect) => effectOutcome(effect, item, state)) }),
    ...(plan.removal && { removedEffects: plan.removal.dropped + (state.removed.get(plan) ?? 0) })
  };
}

const outcomeOf = (actor, plan, state) => ({
  items: plan.items.map((item) => itemOutcome(item, actor, state)),
  effects: plan.effects.map((effect) => effectOutcome(effect, actor, state)),
  removedItems: state.removedItems,
  removedEffects: state.removedEffects
});

/** What the stored data shows of a plan after a write that threw: Foundry may have applied a part of it. */
function describeWritten({ items, effects, removedItems, removedEffects }) {
  const parts = [
    ...items.flatMap((item) => [
      ...writtenPart("item", item),
      ...(item.effects ?? []).flatMap((effect) => writtenPart(`effect of the item ${item.name}`, effect))
    ]),
    ...effects.flatMap((effect) => writtenPart("effect", effect)),
    ...(removedItems > 0 ? [`${removedItems} items deleted`] : []),
    ...(removedEffects > 0 ? [`${removedEffects} effects deleted`] : [])
  ];
  return writtenBefore(parts, "No item and no effect was written before that.");
}

/**
 * Writes a plan, and reports each entry from the stored data. An item Foundry did not create is named in its entry and
 * nothing is undone.
 * @param {any} actor
 * @param {EmbeddedPlan} plan
 * @returns {Promise<{items: object[], effects: object[], removedItems: number, removedEffects: number}>}
 */
export async function writeEmbedded(actor, plan) {
  const state = {
    known: new Set(actor.items.map((item) => item.id)),
    before: new Map(),
    removed: new Map(),
    removedItems: 0,
    removedEffects: 0
  };
  for (const one of [...plan.items, ...plan.effects, ...plan.items.flatMap((item) => item.effects)]) {
    // toObject, not structuredClone: measured, the stored data of some items cannot be structured-cloned.
    if (one.document) state.before.set(one, one.document.toObject());
  }
  const steps = stepsOf(actor, plan, state).map(({ what, run }) => ({ what: `${what} of ${actor.name}`, run }));
  await runSteps(steps, () => describeWritten(outcomeOf(actor, plan, state)));
  return outcomeOf(actor, plan, state);
}
