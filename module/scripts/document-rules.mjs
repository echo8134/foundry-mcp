// What the generic document tools hold back for single document names, in one table that create, update, delete and
// read consult. A rule answers with the sentence of a refusal, or with null.

import { hasPath, sameData } from "./data-diff.mjs";
import { scenesWithTokensOf } from "./world.mjs";

/**
 * @typedef {object} Rules
 * @property {string} [unwritten] why these tools write no document of the name, and what writes it instead
 * @property {readonly string[]} [secret] fields that are never returned and never compared with what was written
 * @property {(data: Record<string, any>) => string | null} [create] why the data makes no new document, asked of a
 *   document that is created and of every document given inside the data of another
 * @property {(document: any, data: Record<string, any>, remove: readonly string[]) => string | null} [update] why the
 *   document is not changed this way
 * @property {(document: any, going: (other: any) => boolean) => string | null} [remove] why the document is not
 *   deleted. `going` says of another document whether the same call deletes it
 * @property {boolean} [last] deleted after the other documents of a call, which may be what stands in its way
 */

const isBlank = (value) => typeof value !== "string" || value.trim() === "";

const OPEN_JOIN_PAGE =
  "The join page of a Foundry server can be reached by anyone who has its address, and a user without a password can be entered by any of them.";

const NO_SALT = "passwordSalt cannot be given: Foundry makes the salt itself when it stores a password.";

/** Foundry trims a text it stores (common/data/fields.mjs:1764), so such a password would not be the one given. */
const PADDED =
  "The password may not begin or end with a space: Foundry would store it without, and the user could not log in with the password as given.";

const isPadded = (password) => typeof password === "string" && password !== password.trim();

const isSelf = (user) => user.id === game.user.id;

const UNATTENDED = "by itself, without anyone clicking";

const MACRO_REACH = "in one connected browser or in all of them, the players' included";

/**
 * The region behaviors through which Foundry runs stored code by itself, each with the field of its system data that
 * says which code. executeScript runs its source as a function (client/data/region-behaviors/execute-script.mjs:32-37)
 * and executeMacro the macro at its uuid (execute-macro.mjs:32-46), for every region event the behavior lists and in
 * every browser the event reaches. Nobody has to click: creating one fires behaviorActivated at once on each client
 * that has the scene (client/documents/region.mjs:2566-2582).
 */
const RUNS_CODE = Object.freeze({
  executeScript: {
    field: "source",
    runs: `its source is code that Foundry runs ${UNATTENDED}, in every connected browser, the players' included`
  },
  executeMacro: { field: "uuid", runs: `it makes Foundry run a macro ${UNATTENDED}, ${MACRO_REACH}` }
});

/**
 * The type of a behavior as Foundry would store it, where it is one that runs code. Foundry makes a text of whatever
 * it is given for the type and trims it (common/data/fields.mjs:1764-1767, :1781-1783), so a padded type and a list
 * of one type name that type.
 */
function codeOf(type) {
  const stored = String(type ?? "").trim();
  return Object.hasOwn(RUNS_CODE, stored) ? stored : null;
}

/** The region behaviors of the world's scenes that run the macro (client/data/region-behaviors/execute-macro.mjs:34). */
const behaviorsRunning = (macro) =>
  game.scenes
    .map((scene) =>
      scene.regions.map((region) =>
        region.behaviors.filter(
          (behavior) => behavior.type === "executeMacro" && behavior._source.system?.uuid === macro.uuid
        )
      )
    )
    .flat(2);

/** @type {Readonly<Record<string, Rules>>} */
const RULES = Object.freeze({
  /**
   * The server stores a given password as a hash with a salt of its own, and hands neither to a client
   * (dist/database/documents/user.mjs, _preCreate, _preUpdate and fromSource with safe). So a password can be written
   * and never read back, and one that is given is written on every call.
   */
  User: {
    secret: ["password", "passwordSalt"],
    create: (data) => {
      if (data.passwordSalt !== undefined) return NO_SALT;
      if (isBlank(data.password)) return `A new user needs a password that is not blank. ${OPEN_JOIN_PAGE}`;
      return isPadded(data.password) ? PADDED : null;
    },
    update: (user, data, remove) => {
      if (data.passwordSalt !== undefined) return NO_SALT;
      const unset = remove.some((path) => path === "password" || path === "passwordSalt");
      if (unset || (data.password !== undefined && isBlank(data.password))) {
        return `The password of ${user.name} cannot be removed or made blank. ${OPEN_JOIN_PAGE} Give another password, or leave password out to keep the one it has.`;
      }
      if (isPadded(data.password)) return PADDED;
      // Foundry logs a user out whose own role changed, and ends the sessions of a user whose password changed
      // (client/documents/user.mjs:361-363, dist/database/documents/user.mjs _onUpdate). A given password is written
      // on every call, and a role only when it is another one.
      const cutsOff = [
        ...(data.role !== undefined && data.role !== user._source.role ? ["role"] : []),
        ...(data.password !== undefined ? ["password"] : [])
      ];
      if (isSelf(user) && cutsOff.length > 0) {
        return `${user.name} is the user this bridge works as, and Foundry logs a user out when its ${cutsOff.join(" or ")} changes: the bridge would lose Foundry in the middle of the call. Change it in Foundry's own user configuration.`;
      }
      return null;
    },
    remove: (user) =>
      isSelf(user) ? `${user.name} is the user this bridge works as, and cannot be deleted through it.` : null
  },
  Setting: {
    unwritten:
      "These tools write no Setting. A world setting is a registered value with a type and a change handler, and a write of the stored document goes past both. Reading settings works (list_documents and get_document)."
  },
  RegionBehavior: {
    create: (data) => {
      const type = codeOf(data.type);
      return type
        ? `These tools create no region behavior of the type ${type}: ${RUNS_CODE[type].runs}. The Gamemaster adds such a behavior in Foundry's own region configuration.`
        : null;
    },
    update: (behavior, data) => {
      const type = codeOf(behavior.type);
      if (!type) return null;
      const { field, runs } = RUNS_CODE[type];
      const given = data.system?.[field];
      return given !== undefined && !sameData(given, behavior._source.system?.[field])
        ? `${behavior.uuid} is a region behavior of the type ${type}: ${runs}. These tools do not change its ${field}. The Gamemaster changes it in Foundry's own region configuration.`
        : null;
    }
  },
  Macro: {
    update: (macro, data) => {
      if (data.command === undefined || data.command === macro._source.command) return null;
      const behaviors = behaviorsRunning(macro);
      return behaviors.length > 0
        ? `Foundry runs the macro ${macro.name} (${macro.uuid}) ${UNATTENDED}, ${MACRO_REACH}: the region behavior ${behaviors.map((behavior) => behavior.uuid).join(", ")} names it. These tools do not change the command of such a macro. The Gamemaster changes it in Foundry's own macro configuration.`
        : null;
    }
  },
  ActorDelta: {
    unwritten:
      "These tools write no ActorDelta. It is a token's own changes to its actor, which ensure_actor writes: pass the token's actor as actor, by its UUID Scene.<id>.Token.<id>.Actor.<id>."
  },
  Actor: {
    update: (actor) =>
      actor.isToken
        ? `${actor.uuid} is the actor of a token. Its data is that token's own changes to its world actor, which Foundry stores another way than an actor's: change it with ensure_actor, by the same UUID as actor.`
        : null,
    remove: (actor, going) => {
      if (actor.isToken) {
        return `${actor.uuid} is the actor of a token, and goes with its token: delete the token with delete_tokens.`;
      }
      if (actor.pack) return null;
      const scenes = scenesWithTokensOf(actor, going);
      return scenes.length > 0
        ? `${actor.name} (${actor.uuid}) still has tokens on ${scenes.join(", ")}, which would be left without an actor. Delete the tokens first with delete_tokens, or give their UUIDs in the same call. get_actor lists them.`
        : null;
    },
    last: true
  }
});

/** @returns {Rules} */
export const rulesOf = (documentName) => (Object.hasOwn(RULES, documentName) ? RULES[documentName] : {});

/** A copy of document data without the fields no caller is shown. */
export function withoutSecrets(documentName, data) {
  const { secret = [] } = rulesOf(documentName);
  return Object.fromEntries(Object.entries(data).filter(([key]) => !secret.includes(key)));
}

/** The secret fields a caller gave a value for: they are written, and nothing shows whether they were stored. */
export const secretsGiven = (documentName, data) =>
  (rulesOf(documentName).secret ?? []).filter((key) => hasPath(data, key));
