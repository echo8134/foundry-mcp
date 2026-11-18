// The Foundry calls of a planned write, run in their order, and what the error says when one of them throws: which call
// it was, what the stored data shows was written by then, and that the call can be run again.

import { updateFor } from "./data-diff.mjs";
import { MethodError } from "./errors.mjs";

export const RUN_AGAIN = "Running the call again writes what still differs.";

/**
 * @typedef {object} Step one Foundry call of a write
 * @property {string} what the call, as it reads after "Foundry failed while"
 * @property {() => unknown} run
 * @property {string} [where] the entry of the request the call is about
 */

/**
 * Runs the steps in their order. Foundry may have applied a part of a call that throws, so the error says what the
 * stored data shows at that moment.
 * @param {readonly Step[]} steps
 * @param {() => string} describe what was written, read from the stored data when a step has thrown
 */
export async function runSteps(steps, describe) {
  for (const { what, run, where = "" } of steps) {
    try {
      await run();
    } catch (error) {
      throw new MethodError(
        "foundry_error",
        `${where}Foundry failed while ${what} (${error.message}). ${describe()} ${RUN_AGAIN}`
      );
    }
  }
}

/**
 * The updates of the plans whose document exists and is stored otherwise than asked, each under the id of its document,
 * as one call of Foundry takes them.
 * @param {readonly {document: any, write: import("./data-diff.mjs").Asked}[]} plans
 */
export const updatesOf = (plans) =>
  plans.flatMap(({ document, write }) => {
    if (!document) return [];
    const { update, writes } = updateFor(write, document._source, _del);
    return writes ? [{ _id: document.id, ...update }] : [];
  });

/** Whether an entry of a result says that its document was created or changed. */
export const wrote = ({ created, changed = [], error }) => !error && (created || changed.length > 0);

/**
 * What a failed write says of one entry of its result, as the stored data shows it: nothing of an entry that was not
 * written.
 * @param {string} noun
 * @param {{id?: string, name: string, created: boolean, changed?: string[], error?: string}} entry
 * @returns {string[]}
 */
export const writtenPart = (noun, entry) =>
  wrote(entry)
    ? [`${noun} ${entry.name} (${entry.id}) ${entry.created ? "created" : `changed (${entry.changed.join(", ")})`}`]
    : [];

/**
 * @param {readonly string[]} parts what was written, as writtenPart says it
 * @param {string} [none] what to say when nothing was
 */
export const writtenBefore = (parts, none = "Nothing was written before that.") =>
  parts.length > 0 ? `Written before that, as the stored data shows: ${parts.join("; ")}.` : none;

/**
 * What the error of a failed update says of the stored data, where Foundry may have applied a part of the update.
 * @param {readonly string[]} written what changed, each with its paths
 */
export const changedInStorage = (written) =>
  written.length > 0 ? `Changed in the stored data: ${written.join("; ")}.` : "Nothing was changed in the stored data.";
