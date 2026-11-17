// @ts-check

/**
 * @typedef {object} Entry
 * @property {string} name
 * @property {number} budget
 * @property {number} deadline
 * @property {() => Promise<any>} run
 * @property {any} prepared
 * @property {boolean} ready
 * @property {"waiting" | "running"} state
 * @property {boolean} overran
 * @property {number} startedAt
 * @property {ReturnType<typeof setTimeout> | undefined} timer
 * @property {(value: any) => void} resolve
 * @property {(error: unknown) => void} reject
 */

const seconds = (/** @type {number} */ ms) => `${Math.round(ms / 100) / 10} seconds`;

/**
 * @param {{ fail: (message: string) => Error }} options
 */
export function createWriteQueue({ fail }) {
  /** @type {Entry[]} */
  const waiting = [];
  /** @type {Entry | null} */
  let current = null;

  /** @param {string} name @param {string} what */
  const stuckMessage = (name, what) =>
    `${name} ${what} and was not applied: ${current?.name} has been running for ${seconds(Date.now() - (current?.startedAt ?? 0))} and has not finished, and the bridge starts no other write while it runs. Nothing was written. Run it again once writes are accepted again. If this does not clear up, the Gamemaster should reload Foundry.`;

  /** @param {Entry} entry */
  function expire(entry) {
    if (entry.state !== "waiting") return;
    waiting.splice(waiting.indexOf(entry), 1);
    entry.reject(
      fail(
        current?.overran
          ? stuckMessage(entry.name, "expired in the queue")
          : `${entry.name} expired in the queue after ${seconds(entry.budget)} behind earlier writes and was not applied. Nothing was written. Run it again.`
      )
    );
    pump();
  }

  /** @param {Entry} entry */
  function overrun(entry) {
    if (current !== entry) return;
    entry.overran = true;
    entry.reject(
      fail(
        `${entry.name} did not finish within ${seconds(entry.budget)} and may still be running in Foundry. The bridge starts no other write until it ends and refuses them meanwhile. Once writes are accepted again, check the scene with get_scene or list_scenes before changing it.`
      )
    );
  }

  /** @param {Entry} entry */
  function start(entry) {
    entry.state = "running";
    entry.startedAt = Date.now();
    current = entry;
    entry.timer = setTimeout(() => overrun(entry), Math.max(0, entry.deadline - Date.now()));
    /** @type {Promise<any>} */
    let running;
    try {
      running = Promise.resolve(entry.run());
    } catch (error) {
      running = Promise.reject(error);
    }
    const end = (/** @type {() => void} */ answer) => {
      clearTimeout(entry.timer);
      if (!entry.overran) answer();
      current = null;
      pump();
    };
    running.then(
      (value) => end(() => entry.resolve(value)),
      (error) => end(() => entry.reject(error))
    );
  }

  function pump() {
    while (!current && waiting.length > 0) {
      const head = /** @type {Entry} */ (waiting[0]);
      if (!head.ready) return;
      waiting.shift();
      clearTimeout(head.timer);
      const left = head.deadline - Date.now();
      if (left < head.budget / 2) {
        head.reject(
          fail(
            `${head.name} waited ${seconds(head.budget - left)} in the queue, which leaves less than half of its ${seconds(head.budget)} budget to run in, so it was not started and was not applied. Nothing was written. Run it again.`
          )
        );
        continue;
      }
      start(head);
    }
  }

  /**
   * @template P, R
   * @param {string} name
   * @param {number} budget
   * @param {() => P | Promise<P>} prepare
   * @param {(prepared: P) => Promise<R>} run
   * @returns {Promise<R>}
   */
  function submit(name, budget, prepare, run) {
    return new Promise((resolve, reject) => {
      if (current?.overran) {
        reject(fail(stuckMessage(name, "was refused at once")));
        return;
      }
      /** @type {Entry} */
      const entry = {
        name,
        budget,
        deadline: Date.now() + budget,
        run: () => run(entry.prepared),
        prepared: undefined,
        ready: false,
        state: "waiting",
        overran: false,
        startedAt: 0,
        timer: setTimeout(() => expire(entry), budget),
        resolve,
        reject
      };
      waiting.push(entry);
      /** @type {Promise<P>} */
      let preparing;
      try {
        preparing = Promise.resolve(prepare());
      } catch (error) {
        preparing = Promise.reject(error);
      }
      preparing.then(
        (prepared) => {
          entry.prepared = prepared;
          entry.ready = true;
          pump();
        },
        (error) => {
          if (!waiting.includes(entry)) return;
          waiting.splice(waiting.indexOf(entry), 1);
          clearTimeout(entry.timer);
          reject(error);
          pump();
        }
      );
    });
  }

  return {
    submit,
    state: () => ({ phase: current ? (current.overran ? "stuck" : "running") : "idle", waiting: waiting.length })
  };
}
