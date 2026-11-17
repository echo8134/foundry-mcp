import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWriteQueue } from "../module/scripts/write-queue.mjs";

class Refusal extends Error {}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
const newQueue = () => createWriteQueue({ fail: (message) => new Refusal(message) });
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail("expected a refusal"),
    (error: unknown) => error as Error
  );

function recorder() {
  const events: string[] = [];
  let open = 0;
  let overlapped = false;
  const call =
    (label: string, work: Promise<unknown> | (() => Promise<unknown>) = Promise.resolve()) =>
    async () => {
      if (++open > 1) overlapped = true;
      events.push(`start ${label}`);
      try {
        await (typeof work === "function" ? work() : work);
        return label;
      } finally {
        open--;
        events.push(`end ${label}`);
      }
    };
  return { events, call, overlapped: () => overlapped };
}

describe("the write queue", () => {
  it("runs calls one at a time in the order their requests arrived, also when the first call's prepare is the slowest", async () => {
    const queue = newQueue();
    const { events, call, overlapped } = recorder();
    const slowPrepare = pause(40);
    const first = queue.submit("a", 1000, () => slowPrepare, call("a", pause(5)));
    const second = queue.submit("b", 1000, () => "fast", call("b", pause(5)));
    const third = queue.submit("c", 1000, () => pause(1), call("c"));
    assert.deepEqual(await Promise.all([first, second, third]), ["a", "b", "c"]);
    assert.deepEqual(events, ["start a", "end a", "start b", "end b", "start c", "end c"]);
    assert.equal(overlapped(), false);
  });

  it("starts the prepare of a waiting call when it arrives, beside the call that is running, and hands its result to the run", async () => {
    const queue = newQueue();
    const hold = gate();
    const prepared: string[] = [];
    const { call } = recorder();
    const running = queue.submit("a", 1000, () => "x", call("a", hold.promise));
    let seen: unknown;
    const waiting = queue.submit(
      "b",
      1000,
      () => {
        prepared.push("b");
        return { scene: 7 };
      },
      async (value) => {
        seen = value;
        return "b";
      }
    );
    await pause(10);
    assert.deepEqual(prepared, ["b"]);
    assert.equal(seen, undefined);
    hold.open();
    await Promise.all([running, waiting]);
    assert.deepEqual(seen, { scene: 7 });
  });

  it("removes a call whose prepare fails with that error at once, without stalling the calls behind it", async () => {
    const queue = newQueue();
    const hold = gate();
    const { call } = recorder();
    const running = queue.submit("a", 1000, () => 0, call("a", hold.promise));
    const bad = queue.submit("b", 1000, () => Promise.reject(new Refusal("no such level")), call("b"));
    const thrown = queue.submit(
      "c",
      1000,
      () => {
        throw new Refusal("sync throw");
      },
      call("c")
    );
    const behind = queue.submit("d", 1000, () => 0, call("d"));
    assert.equal((await failure(bad)).message, "no such level");
    assert.equal((await failure(thrown)).message, "sync throw");
    assert.deepEqual(queue.state(), { phase: "running", waiting: 1 });
    hold.open();
    assert.deepEqual(await Promise.all([running, behind]), ["a", "d"]);
  });

  it("answers a waiting call at its own deadline, not when its turn would have come", async () => {
    const queue = newQueue();
    const hold = gate();
    const { events, call } = recorder();
    const running = queue.submit("a", 1000, () => 0, call("a", hold.promise));
    const arrived = Date.now();
    const expired = await failure(queue.submit("b", 80, () => 0, call("b")));
    const waited = Date.now() - arrived;
    assert.ok(waited >= 70 && waited < 400, `answered after ${waited} ms`);
    assert.match(expired.message, /b expired in the queue.*was not applied/);
    assert.deepEqual(queue.state(), { phase: "running", waiting: 0 });
    hold.open();
    await running;
    assert.deepEqual(events, ["start a", "end a"]);
  });

  it("does not start a call that has less than half of its budget left at its turn", async () => {
    const queue = newQueue();
    const { events, call } = recorder();
    const running = queue.submit("a", 1000, () => 0, call("a", pause(70)));
    const late = queue.submit("b", 100, () => 0, call("b"));
    const refused = await failure(late);
    assert.match(refused.message, /b waited .*less than half of its .*not started and was not applied/);
    await running;
    assert.deepEqual(events, ["start a", "end a"]);
    assert.equal(await queue.submit("c", 100, () => 0, call("c")), "c");
  });

  it("starts a call that still has half of its budget left", async () => {
    const queue = newQueue();
    const { call } = recorder();
    const running = queue.submit("a", 1000, () => 0, call("a", pause(30)));
    const second = queue.submit("b", 200, () => 0, call("b", pause(10)));
    assert.deepEqual(await Promise.all([running, second]), ["a", "b"]);
  });

  it("answers a running call that overran at its deadline counted from its arrival, also when it waited part of its budget", async () => {
    const queue = newQueue();
    const { call } = recorder();
    const hold = gate();
    const first = queue.submit("a", 1000, () => 0, call("a", pause(100)));
    const arrived = Date.now();
    const overran = await failure(queue.submit("b", 300, () => 0, call("b", hold.promise)));
    const waited = Date.now() - arrived;
    assert.match(overran.message, /b did not finish within/);
    assert.ok(waited >= 280 && waited < 360, `answered after ${waited} ms, the budget is 300 from arrival`);
    await first;
    hold.open();
  });

  it("starts the calls behind a head that expired, at that moment, not at their own deadlines", async () => {
    const queue = newQueue();
    const { events, call } = recorder();
    const never = new Promise<void>(() => {});
    const arrived = Date.now();
    const head = failure(queue.submit("head", 80, () => never, call("head")));
    const behind = queue.submit("behind", 2000, () => 0, call("behind"));
    assert.match((await head).message, /head expired in the queue/);
    assert.equal(await behind, "behind");
    const waited = Date.now() - arrived;
    assert.ok(waited < 500, `started after ${waited} ms`);
    assert.deepEqual(events, ["start behind", "end behind"]);
  });

  it("does not remove another waiting call when the prepare of a call that already expired fails late", async () => {
    const queue = newQueue();
    const hold = gate();
    const { call } = recorder();
    const running = queue.submit("a", 5000, () => 0, call("a", hold.promise));
    const expired = failure(
      queue.submit(
        "x",
        60,
        () => new Promise<void>((_, reject) => setTimeout(() => reject(new Refusal("late failure")), 150)),
        call("x")
      )
    );
    const survivor = queue.submit("y", 2000, () => 0, call("y"));
    assert.match((await expired).message, /x expired in the queue/);
    await pause(150);
    assert.deepEqual(queue.state(), { phase: "running", waiting: 1 });
    hold.open();
    assert.deepEqual(await Promise.all([running, survivor]), ["a", "y"]);
  });

  it("does not remove another waiting call when the timer of a call refused for having under half its budget would have fired", async () => {
    const queue = newQueue();
    const { call } = recorder();
    const running = queue.submit("a", 1000, () => 0, call("a", pause(70)));
    const late = failure(queue.submit("late", 100, () => 0, call("late")));
    const survivor = queue.submit("survivor", 2000, () => pause(250), call("survivor"));
    assert.match((await late).message, /late waited .*less than half/);
    await pause(60);
    assert.deepEqual(queue.state().waiting, 1);
    assert.deepEqual(await Promise.all([running, survivor]), ["a", "survivor"]);
  });

  it("goes on to the next waiting call after refusing one that has under half its budget left", async () => {
    const queue = newQueue();
    const { events, call } = recorder();
    const running = queue.submit("a", 1000, () => 0, call("a", pause(70)));
    const late = failure(queue.submit("late", 100, () => 0, call("late")));
    const next = queue.submit("next", 2000, () => 0, call("next"));
    assert.match((await late).message, /late waited .*less than half/);
    const arrived = Date.now();
    assert.equal(await next, "next");
    assert.ok(Date.now() - arrived < 500);
    await running;
    assert.deepEqual(events, ["start a", "end a", "start next", "end next"]);
  });

  it("answers a run that throws before returning a promise with that error, and goes on with the next call", async () => {
    const queue = newQueue();
    const { call } = recorder();
    const thrown = await failure(
      queue.submit(
        "a",
        300,
        () => 0,
        () => {
          throw new Refusal("sync run failure");
        }
      )
    );
    assert.equal(thrown.message, "sync run failure");
    assert.deepEqual(queue.state(), { phase: "idle", waiting: 0 });
    assert.equal(await queue.submit("b", 300, () => 0, call("b")), "b");
  });

  describe("when a running call overruns its budget", () => {
    async function stuckQueue() {
      const queue = newQueue();
      const hold = gate();
      const recording = recorder();
      const stuck = queue.submit("ensure_scene", 60, () => 0, recording.call("ensure_scene", hold.promise));
      const answer = await failure(stuck);
      return { queue, hold, ...recording, answer };
    }

    it("answers its caller at the deadline, that it may still be running", async () => {
      const { answer, queue, hold } = await stuckQueue();
      assert.match(
        answer.message,
        /ensure_scene did not finish within.*may still be running in Foundry.*starts no other write.*get_scene or list_scenes/
      );
      assert.equal(queue.state().phase, "stuck");
      hold.open();
    });

    it("refuses a writing call that arrives while stuck at once, naming the stuck method and how long it has run", async () => {
      const { queue, hold, call, events } = await stuckQueue();
      let prepared = false;
      const arrived = Date.now();
      const refused = await failure(queue.submit("sync_walls", 1000, () => (prepared = true), call("sync_walls")));
      assert.ok(Date.now() - arrived < 30);
      assert.match(
        refused.message,
        /sync_walls was refused at once and was not applied: ensure_scene has been running for \d+(\.\d+)? seconds.*no other write.*Gamemaster should reload Foundry/
      );
      assert.equal(prepared, false);
      hold.open();
      await pause(10);
      assert.deepEqual(events, ["start ensure_scene", "end ensure_scene"]);
    });

    it("answers a call that was waiting at its own deadline with the same refusal, and starts nothing", async () => {
      const queue = newQueue();
      const hold = gate();
      const { call, events } = recorder();
      const stuck = failure(queue.submit("ensure_scene", 60, () => 0, call("ensure_scene", hold.promise)));
      const waiting = queue.submit("create_walls", 150, () => 0, call("create_walls"));
      await stuck;
      const arrived = Date.now();
      const refused = await failure(waiting);
      assert.ok(Date.now() - arrived < 150, "answered at its own deadline, which is later than the overrun");
      assert.match(
        refused.message,
        /create_walls expired in the queue and was not applied: ensure_scene has been running.*Gamemaster should reload Foundry/
      );
      hold.open();
      await pause(10);
      assert.deepEqual(events, ["start ensure_scene", "end ensure_scene"]);
    });

    it("resumes with whatever waits once the stuck call settles, and accepts writes again", async () => {
      const queue = newQueue();
      const hold = gate();
      const { call, events, overlapped } = recorder();
      const stuck = failure(queue.submit("ensure_scene", 50, () => 0, call("ensure_scene", hold.promise)));
      const waiting = queue.submit("create_walls", 1000, () => 0, call("create_walls"));
      await stuck;
      assert.equal(queue.state().phase, "stuck");
      hold.open();
      assert.equal(await waiting, "create_walls");
      assert.deepEqual(events, ["start ensure_scene", "end ensure_scene", "start create_walls", "end create_walls"]);
      assert.deepEqual(queue.state(), { phase: "idle", waiting: 0 });
      assert.equal(await queue.submit("sync_walls", 100, () => 0, call("sync_walls")), "sync_walls");
      assert.equal(overlapped(), false);
    });

    it("resumes too when the stuck call fails late, and does not answer its caller twice", async () => {
      const queue = newQueue();
      const { call } = recorder();
      let fail!: (error: Error) => void;
      const dies = new Promise<void>((_, reject) => (fail = reject));
      const stuck = failure(queue.submit("ensure_scene", 40, () => 0, call("ensure_scene", dies)));
      await stuck;
      fail(new Error("late failure"));
      await pause(5);
      assert.equal(queue.state().phase, "idle");
      assert.equal(await queue.submit("sync_walls", 100, () => 0, call("sync_walls")), "sync_walls");
    });

    it("never lets a stampede after the hang run side by side", async () => {
      const queue = newQueue();
      const hold = gate();
      const { call, overlapped, events } = recorder();
      const stuck = failure(queue.submit("ensure_scene", 100, () => 0, call("ensure_scene", hold.promise)));
      const batch = ["a", "b", "c"].map((label) => queue.submit(label, 100, () => 0, call(label, pause(5))));
      const outcomes = await Promise.allSettled(batch);
      await stuck;
      assert.deepEqual(
        outcomes.map((outcome) => outcome.status),
        ["rejected", "rejected", "rejected"]
      );
      assert.equal(overlapped(), false);
      assert.deepEqual(events, ["start ensure_scene"]);
      hold.open();
    });
  });
});
