import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import type { AutomaticClientOptions } from "../src/automatic-client.ts";
import { BridgeError, BridgeHub } from "../src/hub.ts";
import { FakeBridge, info, TOKEN, until } from "./helpers.ts";

const managed = { ...info, user: { id: "automatic-user-id", name: "Claude" } };

function gate() {
  let open = () => {};
  const waiting = new Promise<void>((resolve) => (open = resolve));
  return { open, waiting };
}

async function start(
  t: TestContext,
  options: Partial<AutomaticClientOptions> & Pick<AutomaticClientOptions, "launch">
) {
  const hub = new BridgeHub({
    token: TOKEN,
    port: 0,
    automaticClient: { user: managed.user.name, graceMs: 1, ...options }
  });
  t.after(() => hub.stop());
  assert.equal((await hub.start()).kind, "listening");
  return hub;
}

it("uses a manual tab that authenticates during the grace period without launching a client", async (t) => {
  const launch = t.mock.fn(async () => {
    throw new Error("unexpected login");
  });
  const hub = await start(t, { graceMs: 60_000, launch });
  const pending = hub.request("get_scene", {});
  const dm = await FakeBridge.connect(hub.port);
  await dm.handshake();
  await until(() => dm.requests.length === 1);
  await dm.respond(dm.requests[0]!.id, "from DM");
  assert.equal(await pending, "from DM");
  const next = hub.request("get_actor", {});
  await until(() => dm.requests.length === 2);
  await dm.respond(dm.requests[1]!.id, "also DM");
  assert.equal(await next, "also DM");
  assert.equal(launch.mock.callCount(), 0);
});

it("shares a launch and waits for sealed authentication even when the browser has finished loading", async (t) => {
  const close = t.mock.fn(async () => {});
  const launch = t.mock.fn(async () => ({ userId: managed.user.id, close }));
  const hub = await start(t, { launch });
  const requests = Promise.all([hub.request("get_scene", {}), hub.request("get_actor", {})]);
  await until(() => launch.mock.callCount() === 1);
  const client = await FakeBridge.connect(hub.port);
  client.sendHello();
  await until(() => client.challenge !== undefined);
  assert.equal(client.requests.length, 0);
  await client.sendAuth(TOKEN, managed);
  await until(() => client.requests.length === 2);
  for (const request of client.requests) await client.respond(request.id, request.method);
  assert.deepEqual(await requests, ["get_scene", "get_actor"]);
  assert.equal(close.mock.callCount(), 0);
  await hub.stop();
  assert.equal(launch.mock.callCount(), 1);
  assert.equal(close.mock.callCount(), 1);
});

it("serves a DM during login and closes a late browser before logging in again", async (t) => {
  const duringLogin = gate();
  const finishLogin = gate();
  const doneClosing = gate();
  const signals: AbortSignal[] = [];
  let closed = 0;
  const hub = await start(t, {
    async launch({ signal, port }) {
      assert.equal(port, hub.port);
      signals.push(signal);
      duringLogin.open();
      await finishLogin.waiting;
      return {
        userId: managed.user.id,
        async close() {
          closed++;
          await doneClosing.waiting;
        }
      };
    }
  });
  const pending = hub.request("delete_walls", {});
  await duringLogin.waiting;
  const dm = await FakeBridge.connect(hub.port);
  await dm.handshake();
  await until(() => dm.requests.length === 1);
  assert.equal(signals[0]?.aborted, true);
  await dm.respond(dm.requests[0]!.id, "served before login completed");
  assert.equal(await pending, "served before login completed");
  dm.close();
  await until(() => hub.bridgeInfo === null);
  const next = hub.request("get_actor", {});
  finishLogin.open();
  await until(() => closed === 1);
  assert.equal(signals.length, 1);
  doneClosing.open();
  await until(() => signals.length === 2);
  const owned = await FakeBridge.connect(hub.port);
  await owned.handshake(TOKEN, managed);
  await until(() => owned.requests.length === 1);
  assert.equal(owned.requests[0]!.method, "get_actor");
  await owned.respond(owned.requests[0]!.id, "new client");
  assert.equal(await next, "new client");
});

it("cancels individual calls before dispatch and abandons login when the last caller leaves", async (t) => {
  const entered = gate();
  let launches = 0;
  let aborted = false;
  const hub = await start(t, {
    async launch({ signal }) {
      launches++;
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true }
      );
      entered.open();
      return { userId: managed.user.id, close: async () => {} };
    }
  });
  const first = new AbortController();
  const second = new AbortController();
  const cancelOne = hub.request("delete_walls", {}, { signal: first.signal });
  const cancelTwo = hub.request("delete_tokens", {}, { signal: second.signal });
  await entered.waiting;
  first.abort();
  await assert.rejects(cancelOne, { name: "AbortError" });
  assert.equal(aborted, false);
  second.abort();
  await assert.rejects(cancelTwo, { name: "AbortError" });
  assert.equal(aborted, true);
  const dm = await FakeBridge.connect(hub.port);
  await dm.handshake();
  await until(() => hub.bridgeInfo !== null);
  await assert.rejects(hub.request("delete_actors", {}, { signal: second.signal }), { name: "AbortError" });
  const live = hub.request("get_scene", {});
  await until(() => dm.requests.length > 0);
  assert.deepEqual(
    dm.requests.map((r) => r.method),
    ["get_scene"]
  );
  await dm.respond(dm.requests[0]!.id, "only live call");
  assert.equal(await live, "only live call");
  assert.equal(launches, 1);
});

it("reports a login failure before dispatch and retries startup on the next call", async (t) => {
  let tries = 0;
  const hub = await start(t, {
    async launch() {
      if (++tries === 1) throw new Error("The configured Foundry user is already signed in.");
      return { userId: managed.user.id, close: async () => {} };
    }
  });
  await assert.rejects(
    hub.request("delete_walls", {}),
    (error) => error instanceof BridgeError && error.code === "no_bridge" && /already signed in/.test(error.message)
  );
  const retry = hub.request("get_scene", {});
  await until(() => tries === 2);
  const owned = await FakeBridge.connect(hub.port);
  await owned.handshake(TOKEN, managed);
  await until(() => owned.requests.length === 1);
  await owned.respond(owned.requests[0]!.id, "retried");
  assert.equal(await retry, "retried");
});

it("times out before dispatch and closes a browser that never authenticated", async (t) => {
  const close = t.mock.fn(async () => {});
  const hub = await start(t, {
    startupTimeoutMs: 75,
    launch: async () => ({ userId: managed.user.id, close })
  });
  await assert.rejects(
    hub.request("delete_walls", {}),
    (error) =>
      error instanceof BridgeError &&
      error.code === "no_bridge" &&
      /timed out waiting for an authenticated bridge/.test(error.message)
  );
  await until(() => close.mock.callCount() === 1);
});

it("aborts a partial startup on shutdown and waits for its browser to close", async (t) => {
  const entered = gate();
  const aborted = gate();
  const release = gate();
  const close = t.mock.fn(async () => {});
  const hub = await start(t, {
    async launch({ signal }) {
      signal.addEventListener("abort", aborted.open, { once: true });
      entered.open();
      await release.waiting;
      return { userId: managed.user.id, close };
    }
  });
  const pending = hub.request("delete_walls", {});
  await entered.waiting;
  const stopped = hub.stop();
  await aborted.waiting;
  await assert.rejects(pending, /server is shutting down/);
  release.open();
  await stopped;
  assert.equal(close.mock.callCount(), 1);
});

it("never sends an unanswered write again after the owned browser disconnects", async (t) => {
  const close = t.mock.fn(async () => {});
  const launch = t.mock.fn(async () => ({ userId: managed.user.id, close }));
  const hub = await start(t, { launch });
  const mutation = hub.request("delete_walls", {});
  await until(() => launch.mock.callCount() === 1);
  const first = await FakeBridge.connect(hub.port);
  await first.handshake(TOKEN, managed);
  await until(() => first.requests.length === 1);
  first.close();
  await assert.rejects(mutation, (error) => error instanceof BridgeError && error.code === "bridge_closed");
  const next = hub.request("get_scene", {});
  await until(() => launch.mock.callCount() === 2);
  assert.equal(close.mock.callCount(), 1);
  const second = await FakeBridge.connect(hub.port);
  await second.handshake(TOKEN, managed);
  await until(() => second.requests.length > 0);
  assert.deepEqual(
    second.requests.map((request) => request.method),
    ["get_scene"]
  );
  await second.respond(second.requests[0]!.id, "after disconnect");
  assert.equal(await next, "after disconnect");
});
