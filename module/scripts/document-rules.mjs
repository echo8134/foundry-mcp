// What the generic document tools hold back for single document names, in one table that create, update, delete and
// read consult. A rule answers with the sentence of a refusal, or with null.

import { scenesWithTokensOf } from "./actor-writes.mjs";
import { hasPath } from "./data-diff.mjs";

/**
 * @typedef {object} Rules
 * @property {string} [unwritten] why these tools write no document of the name, and what writes it instead
 * @property {readonly string[]} [secret] fields that are never returned and never compared with what was written
 * @property {(data: Record<string, any>) => string | null} [create] why the data makes no new document
 * @property {(document: any, data: Record<string, any>, remove: readonly string[]) => string | null} [update] why the
 *   document is not changed this way
 * @property {(document: any) => string | null} [remove] why the document is not deleted
 */

const isBlank = (value) => typeof value !== "string" || value.trim() === "";

const OPEN_JOIN_PAGE =
  "The join page of a Foundry server can be reached by anyone who has its address, and a user without a password can be entered by any of them.";

const NO_SALT = "passwordSalt cannot be given: Foundry makes the salt itself when it stores a password.";

const isSelf = (user) => user.id === game.user.id;

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
      return isBlank(data.password) ? `A new user needs a password that is not blank. ${OPEN_JOIN_PAGE}` : null;
    },
    update: (user, data, remove) => {
      if (data.passwordSalt !== undefined) return NO_SALT;
      const unset = remove.some((path) => path === "password" || path === "passwordSalt");
      if (unset || (data.password !== undefined && isBlank(data.password))) {
        return `The password of ${user.name} cannot be removed or made blank. ${OPEN_JOIN_PAGE} Give another password, or leave password out to keep the one it has.`;
      }
      // Foundry logs a user out whose own role changed, and ends the sessions of a user whose password changed
      // (client/documents/user.mjs:361-363, dist/database/documents/user.mjs _onUpdate).
      const cutsOff = ["role", "password"].filter((key) => data[key] !== undefined);
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
  ActorDelta: {
    unwritten:
      "These tools write no ActorDelta. It is a token's own changes to its actor, which ensure_actor writes: pass the token's actor as actor, by its UUID Scene.<id>.Token.<id>.Actor.<id>."
  },
  Actor: {
    update: (actor) =>
      actor.isToken
        ? `${actor.uuid} is the actor of a token. Its data is that token's own changes to its world actor, which Foundry stores another way than an actor's: change it with ensure_actor, by the same UUID as actor.`
        : null,
    remove: (actor) => {
      if (actor.isToken) {
        return `${actor.uuid} is the actor of a token, and goes with its token: delete the token with delete_tokens.`;
      }
      if (actor.pack) return null;
      const scenes = scenesWithTokensOf(actor);
      return scenes.length > 0
        ? `${actor.name} (${actor.uuid}) still has tokens on ${scenes.join(", ")}, which would be left without an actor. Delete the tokens first with delete_tokens. get_actor lists them.`
        : null;
    }
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
