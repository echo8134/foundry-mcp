// @ts-check

import { getPath } from "./paths.mjs";

/** @typedef {string | {[key: string]: Spec}} Spec */

/** The numbers the sheet shows, by the path each is read from on the prepared `actor.system`. dnd5e computes most of them and stores few. */
const DERIVED = Object.freeze({
  ac: "attributes.ac.value",
  hp: { value: "attributes.hp.value", max: "attributes.hp.max", temp: "attributes.hp.temp" },
  prof: "attributes.prof",
  xp: "details.xp.value",
  level: "details.level",
  init: "attributes.init.total",
  spell: { dc: "attributes.spell.dc", attack: "attributes.spell.attack" }
});

/**
 * The same for every entry of a keyed table of the system. In dnd5e 6.1 an ability's save is an object
 * (dnd5e module/data/actor/templates/common.mjs:364).
 * @type {Readonly<Record<string, Spec>>}
 */
const DERIVED_PER_KEY = Object.freeze({
  abilities: { mod: "mod", save: "save.value" },
  skills: { total: "total", passive: "passive" }
});

/**
 * @param {unknown} source
 * @param {Spec} spec
 * @returns {unknown} undefined when nothing the spec names is there
 */
function pick(source, spec) {
  if (typeof spec === "string") return getPath(source, spec);
  const picked = Object.entries(spec).flatMap(([key, inner]) => {
    const value = pick(source, inner);
    return value === undefined ? [] : [[key, value]];
  });
  return picked.length > 0 ? Object.fromEntries(picked) : undefined;
}

/**
 * @param {Record<string, any>} system the prepared `actor.system`
 * @returns {Record<string, unknown>} what the actor type has of the derived values
 */
export function derivedValues(system) {
  /** @type {Record<string, unknown>} */
  const derived = /** @type {Record<string, unknown> | undefined} */ (pick(system, DERIVED)) ?? {};
  for (const [table, spec] of Object.entries(DERIVED_PER_KEY)) {
    const entries = system?.[table];
    if (entries === null || typeof entries !== "object") continue;
    derived[table] = Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, pick(entry, spec) ?? {}]));
  }
  return derived;
}
