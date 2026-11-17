import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { WebSocket as NodeWebSocket } from "ws";
import { Bridge } from "../module/scripts/bridge.mjs";
import { Channel, fromBase64url } from "../module/scripts/channel.mjs";
import { SURFACE } from "../module/scripts/surface.mjs";
import { BridgeError, BridgeHub } from "../src/hub.ts";
import { ORIGIN, TOKEN, until } from "./helpers.ts";
import { encodeFrame, OPCODE_BINARY, OPCODE_TEXT, type RawFrame, SamePortRelay } from "./wire.ts";

const info = {
  foundry: "14.370",
  module: "0.2.0",
  surface: SURFACE,
  world: { id: "world-id-7c1e", title: "Hidden Halls" },
  user: { id: "user-id-93ab", name: "Gamemaster Gertrud" }
};

class BrowserLikeWebSocket extends NodeWebSocket {
  constructor(url: string) {
    super(url, { origin: ORIGIN });
  }
}

const realWebSocket = globalThis.WebSocket;
const cleanups: (() => unknown)[] = [];

beforeEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = BrowserLikeWebSocket;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
});

async function relayedBridge() {
  const calls: string[] = [];
  let releaseDelete = () => {};
  const relay = await SamePortRelay.listen();
  cleanups.push(() => relay.close());
  const bridge = new Bridge({
    getPort: () => relay.port,
    getPageHost: () => "localhost",
    getToken: () => TOKEN,
    getInfo: () => info,
    methods: {
      get_scene: async () => {
        calls.push("get_scene");
        return { scene: "real" };
      },
      // Never answers on its own, so the module sends nothing while the relay injects toward the server.
      delete_walls: () => {
        calls.push("delete_walls");
        return new Promise((resolve) => (releaseDelete = () => resolve({ deleted: 0 })));
      }
    },
    log: () => {},
    warn: () => {}
  });
  cleanups.push(() => bridge.stop());
  bridge.start();
  await relay.accepted;

  const logs: string[] = [];
  const hub = new BridgeHub({
    token: TOKEN,
    port: relay.port,
    allowedOrigins: [ORIGIN],
    log: (line) => logs.push(line)
  });
  cleanups.push(() => hub.stop());
  cleanups.push(() => releaseDelete());
  assert.equal((await hub.start()).kind, "listening", "the server could not bind the port the relay released");
  await relay.dialUpstream();
  await until(() => hub.bridgeInfo !== null);
  return { relay, bridge, hub, calls, logs };
}

async function decrypt(relay: SamePortRelay) {
  const textOf = (frames: RawFrame[]) =>
    frames.filter((f) => f.opcode === OPCODE_TEXT).map((f) => JSON.parse(f.payload.toString()));
  const [hello] = textOf(relay.framesToServer);
  const [challenge] = textOf(relay.framesToModule);
  const nonces = { token: TOKEN, clientNonce: hello.nonce, serverNonce: challenge.nonce, transmit: () => {} };
  const asModule = await Channel.create({ ...nonces, role: "client" });
  const asServer = await Channel.create({ ...nonces, role: "server" });
  const open = async (channel: Channel, frames: Uint8Array[]) => {
    const texts: string[] = [];
    for (const frame of frames) {
      const opened = await channel.receive(frame);
      assert.ok(opened.ok, "a frame the relay carried did not open with the real token");
      texts.push(opened.text);
    }
    return texts.map((text) => JSON.parse(text));
  };
  const binary = (frames: RawFrame[]) => frames.filter((f) => f.opcode === OPCODE_BINARY).map((f) => f.payload);
  return {
    toModule: await open(asModule, [fromBase64url(challenge.proof)!, ...binary(relay.framesToModule)]),
    toServer: await open(asServer, binary(relay.framesToServer))
  };
}

const lastBinary = (frames: RawFrame[]) => frames.filter((f) => f.opcode === OPCODE_BINARY).at(-1)!;

describe("same-port relay", () => {
  it("carries a working bridge as a plain wire, and none of the bytes it saw reveal the world, the user, a method or the token", async () => {
    const { relay, hub } = await relayedBridge();
    assert.deepEqual(hub.bridgeInfo, info);
    assert.deepEqual(await hub.request("get_scene", { sceneId: "s1" }), { scene: "real" });

    const seen = relay.seen;
    const { toModule, toServer } = await decrypt(relay);
    assert.ok(
      seen.includes(JSON.parse(relay.framesToServer[0]!.payload.toString()).nonce),
      "the search does not see unmasked payloads"
    );
    assert.deepEqual(
      toServer[0],
      { type: "auth", ...info },
      "the sealed auth frame does not carry the identifying fields"
    );
    assert.equal(toModule[1].method, "get_scene", "the sealed request does not carry the method");
    for (const secret of [
      info.world.id,
      info.world.title,
      info.user.id,
      info.user.name,
      "get_scene",
      "sceneId",
      TOKEN
    ]) {
      assert.ok(!seen.includes(secret), `the relay saw ${secret}`);
    }
  });

  const towardModule: [string, (relay: SamePortRelay) => Buffer][] = [
    [
      "a protocol 2 plaintext request",
      () =>
        encodeFrame(
          OPCODE_TEXT,
          JSON.stringify({ type: "request", id: "evil", method: "delete_walls", params: { all: true } }),
          false
        )
    ],
    ["random bytes", () => encodeFrame(OPCODE_BINARY, randomBytes(80), false)],
    ["a replay of an earlier sealed request", (relay) => lastBinary(relay.framesToModule).raw]
  ];
  for (const [label, frame] of towardModule) {
    it(`never runs ${label} it injects toward the module, and the connection ends`, async () => {
      const { relay, hub, calls } = await relayedBridge();
      assert.deepEqual(await hub.request("get_scene", {}), { scene: "real" });
      relay.injectToModule(frame(relay));
      await until(() => relay.moduleClosed);
      await until(() => hub.bridgeInfo === null);
      assert.deepEqual(calls, ["get_scene"]);
    });
  }

  it("never delivers a forged plaintext response it injects toward the server, even with the right request id, and the bridge ends", async () => {
    const { relay, hub, calls } = await relayedBridge();
    const pending = hub.request("delete_walls", { all: true });
    await until(() => calls.length === 1);
    const { toModule } = await decrypt(relay);
    const { id } = toModule.at(-1);
    relay.injectToServer(
      encodeFrame(OPCODE_TEXT, JSON.stringify({ type: "response", id, ok: true, result: { forged: true } }), true)
    );
    await assert.rejects(pending, (error: unknown) => error instanceof BridgeError && error.code === "bridge_closed");
    assert.equal(hub.bridgeInfo, null);
  });

  it("never delivers a replayed sealed response it injects toward the server, and the bridge ends", async () => {
    const { relay, hub, calls } = await relayedBridge();
    assert.deepEqual(await hub.request("get_scene", {}), { scene: "real" });
    const pending = hub.request("delete_walls", { all: true });
    await until(() => calls.length === 2);
    relay.injectToServer(lastBinary(relay.framesToServer).raw);
    await assert.rejects(pending, (error: unknown) => error instanceof BridgeError && error.code === "bridge_closed");
    assert.equal(hub.bridgeInfo, null);
  });
});
