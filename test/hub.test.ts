import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, describe, it, mock } from "node:test";
import { WebSocket } from "ws";
import { Channel, newNonce } from "../module/scripts/channel.mjs";
import {
  BridgeError,
  BridgeHub,
  CLOSE_ANOTHER_BRIDGE,
  CLOSE_AUTH_FAILED,
  CLOSE_HANDSHAKE_TIMEOUT,
  CLOSE_PROTOCOL_ERROR
} from "../src/hub.ts";
import { type Challenge, SURFACE_NUMBER } from "../src/protocol.ts";
import { FakeBridge, info, ORIGIN, TOKEN, until, WRONG_TOKEN } from "./helpers.ts";
import { encodeFrame, OPCODE_BINARY, OPCODE_TEXT, parseStream, rawWebSocket } from "./wire.ts";

const KiB = 1024;
const MiB = 1024 * KiB;
// The limits are written out here and in the tests, not imported, so that a changed constant fails a test.
const UNAUTHENTICATED_CAP = 256;
const OPCODE_CLOSE = 0x8;

const hubs: BridgeHub[] = [];
const bridges: FakeBridge[] = [];

async function startHub(options: Partial<ConstructorParameters<typeof BridgeHub>[0]> = {}) {
  const hub = new BridgeHub({ token: TOKEN, port: 0, allowedOrigins: [ORIGIN], ...options });
  hubs.push(hub);
  await hub.start();
  return hub;
}

async function connect(hub: BridgeHub) {
  const bridge = await FakeBridge.connect(hub.port);
  bridges.push(bridge);
  return bridge;
}

async function readyBridge(hub: BridgeHub) {
  const bridge = await connect(hub);
  await bridge.handshake();
  await until(() => hub.bridgeInfo !== null);
  return bridge;
}

// Long enough for a proof to be checked and a request to have been sent if the hub were going to send one.
const settle = () => new Promise((r) => setTimeout(r, 50));

const protocol1HelloAs = (protocol: number) => ({
  type: "hello",
  protocol,
  foundry: "13.351",
  module: "0.1.0",
  world: { id: "old-world", title: "Old World" },
  user: { id: "gm-id", name: "Old Gamemaster" }
});

async function firstFrame(hub: BridgeHub, frame: object | string) {
  const bridge = await connect(hub);
  bridge.sendRaw(typeof frame === "string" ? frame : JSON.stringify(frame));
  await until(() => bridge.closed !== null);
  return bridge.closed!;
}

async function noBridgeMessage(hub: BridgeHub): Promise<string> {
  const error = await hub.request("get_scene", {}).then(
    () => null,
    (thrown: unknown) => thrown
  );
  assert.ok(error instanceof BridgeError && error.code === "no_bridge", `expected no_bridge, got ${String(error)}`);
  return error.message;
}

const MISMATCH_TEXT = /tried to connect with protocol/;

type RawPeer = Awaited<ReturnType<typeof rawWebSocket>>;
const framesFromHub = (peer: RawPeer) => parseStream(peer.received()).frames;

async function rawBridge(hub: BridgeHub): Promise<RawPeer> {
  const peer = await rawWebSocket(hub.port, ORIGIN);
  const clientNonce = newNonce();
  peer.socket.write(encodeFrame(OPCODE_TEXT, JSON.stringify({ type: "hello", protocol: 3, nonce: clientNonce }), true));
  await until(() => framesFromHub(peer).length === 1);
  const challenge = JSON.parse(framesFromHub(peer)[0]!.payload.toString()) as Challenge;
  const channel = await Channel.create({
    token: TOKEN,
    clientNonce,
    serverNonce: challenge.nonce,
    role: "client",
    transmit: (sealed) => peer.socket.write(encodeFrame(OPCODE_BINARY, sealed, true))
  });
  await channel.send({ type: "auth", ...info });
  await until(() => hub.bridgeInfo !== null);
  return peer;
}

function unfinishedFrame(announced: number, sent: number): Buffer {
  const head = Buffer.alloc(14);
  head[0] = 0x80 | OPCODE_BINARY;
  head[1] = 0x80 | 127;
  head.writeBigUInt64BE(BigInt(announced), 2);
  return Buffer.concat([head, Buffer.alloc(sent - head.length)]);
}

afterEach(async () => {
  for (const b of bridges.splice(0)) b.close();
  for (const h of hubs.splice(0)) await h.stop();
});

describe("BridgeHub", () => {
  it("rejects a foreign origin with HTTP 403", async () => {
    const hub = await startHub();
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}`, { origin: "https://evil.example" });
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("open", () => reject(new Error("foreign origin was accepted")));
      ws.once("error", () => {});
    });
    assert.equal(status, 403);
    assert.equal(hub.bridgeInfo, null);
  });

  it("survives clients that abort refused upgrades at varying moments and still serves a real bridge", async () => {
    const hub = await startHub();
    for (let i = 0; i < 300; i++) {
      await new Promise<void>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${hub.port}`, { origin: "https://evil.example" });
        ws.on("error", () => {});
        ws.on("unexpected-response", () => {});
        setTimeout(() => {
          ws.terminate();
          resolve();
        }, i % 3);
      });
    }
    await new Promise((r) => setTimeout(r, 100));
    const bridge = await readyBridge(hub);
    const pending = hub.request("get_scene", {});
    await until(() => bridge.requests.length === 1);
    await bridge.respond(bridge.requests[0]!.id, "alive");
    assert.equal(await pending, "alive");
  });

  it("by default takes a page at http://localhost:30000 and refuses one at http://127.0.0.1:30000", async () => {
    const hub = await startHub({ allowedOrigins: undefined });
    await assert.rejects(FakeBridge.connect(hub.port, "http://127.0.0.1:30000"), /403/);
    bridges.push(await FakeBridge.connect(hub.port, "http://localhost:30000"));
  });

  it("rejects an upgrade with no Origin header", async () => {
    const hub = await startHub();
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}`);
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("open", () => reject(new Error("originless upgrade was accepted")));
      ws.once("error", () => {});
    });
    assert.equal(status, 403);
  });

  it("answers hello with a challenge whose sealed proof opens under the token, then serves a bridge whose sealed auth opens too", async () => {
    const hub = await startHub();
    const bridge = await connect(hub);
    bridge.sendHello();
    await until(() => bridge.challenge !== undefined);
    assert.equal(hub.bridgeInfo, null, "a hello alone must not make a bridge");
    await bridge.sendAuth();
    assert.equal(bridge.proofOpened, true, "the challenge proof did not open under the token");
    await until(() => hub.bridgeInfo !== null);
    assert.deepEqual(hub.bridgeInfo, info);
    const pending = hub.request("get_scene", { sceneId: "s" });
    await until(() => bridge.requests.length === 1);
    assert.deepEqual(bridge.requests[0]?.params, { sceneId: "s" });
    await bridge.respond(bridge.requests[0]!.id, "round trip");
    assert.equal(await pending, "round trip");
    const hubFrames = bridge.wire.filter((entry) => entry.from === "hub");
    assert.equal(hubFrames.length, 2, "the challenge and one request");
    assert.ok(!hubFrames[1]!.data.toString("latin1").includes("get_scene"), "the request crossed the wire unsealed");
  });

  it("gives every connection a fresh server nonce", async () => {
    const hub = await startHub();
    const nonces = [];
    for (let i = 0; i < 2; i++) {
      const bridge = await connect(hub);
      bridge.sendHello();
      await until(() => bridge.challenge !== undefined);
      nonces.push(bridge.challenge!.nonce);
    }
    assert.notEqual(nonces[0], nonces[1]);
  });

  it("does not tell a connection that has not authenticated whether a bridge is connected", async () => {
    const hub = await startHub();
    await readyBridge(hub);
    const stranger = await connect(hub);
    stranger.sendHello();
    await until(() => stranger.challenge !== undefined);
    const turnedAway = stranger.closed !== null;
    assert.equal(turnedAway, false, "an unauthenticated connection was turned away at once");
    await stranger.sendAuth(WRONG_TOKEN);
    await until(() => stranger.closed !== null);
    assert.equal(stranger.closed?.code, CLOSE_AUTH_FAILED);
  });

  it("closes a bridge with a wrong client proof with 4401 and never sends it a request", async () => {
    const hub = await startHub();
    const bridge = await connect(hub);
    await bridge.handshake(WRONG_TOKEN);
    assert.equal(bridge.proofOpened, false, "the server proof opened under the wrong token");
    await until(() => bridge.closed !== null);
    assert.equal(bridge.closed?.code, CLOSE_AUTH_FAILED);
    assert.ok(!bridge.closed?.reason.includes(TOKEN), "the close reason carries the token");
    assert.equal(hub.bridgeInfo, null);
    await assert.rejects(
      hub.request("get_scene", {}),
      (error: unknown) => error instanceof BridgeError && error.code === "no_bridge"
    );
    assert.deepEqual(bridge.requests, []);
  });

  it("does not let a connection that only sent hello hold the bridge slot", async () => {
    const hub = await startHub();
    const squatter = await connect(hub);
    squatter.sendHello();
    await until(() => squatter.challenge !== undefined);
    const real = await readyBridge(hub);
    assert.equal(real.closed, null);
    const pending = hub.request("get_scene", {});
    await until(() => real.requests.length === 1);
    await real.respond(real.requests[0]!.id, "real");
    assert.equal(await pending, "real");
    assert.deepEqual(squatter.requests, []);
  });

  it("answers a first sealed frame that opens but is not auth exactly like one that does not open", async () => {
    const hub = await startHub();
    const bridge = await connect(hub);
    bridge.sendHello();
    await until(() => bridge.challenge !== undefined);
    const channel = await Channel.create({
      token: TOKEN,
      clientNonce: bridge.clientNonce,
      serverNonce: bridge.challenge!.nonce,
      role: "client",
      transmit: (sealed) => bridge.sendRaw(sealed)
    });
    await channel.send({ type: "response", id: "x", ok: true, result: null });
    await until(() => bridge.closed !== null);
    assert.deepEqual(bridge.closed, { code: CLOSE_AUTH_FAILED, reason: "the bridge did not prove it knows the token" });
    assert.equal(hub.bridgeInfo, null);
  });

  it("does not hand the bridge slot to a connection that closed while its proof was being checked", async () => {
    const hub = await startHub();
    const gone = await connect(hub);
    gone.sendHello();
    await until(() => gone.challenge !== undefined);
    await gone.sendAuth();
    gone.ws.terminate();
    await settle();
    assert.equal(hub.bridgeInfo, null);
    const real = await readyBridge(hub);
    assert.equal(real.closed, null);
  });

  it("refuses a second connection that authenticates after the first became the bridge", async () => {
    const hub = await startHub();
    const late = await connect(hub);
    late.sendHello();
    await until(() => late.challenge !== undefined);
    const first = await readyBridge(hub);
    await late.sendAuth();
    await until(() => late.closed !== null);
    assert.equal(late.closed?.code, CLOSE_ANOTHER_BRIDGE);
    assert.equal(first.closed, null);
    assert.deepEqual(hub.bridgeInfo, info);
  });

  for (const [label, frames] of [
    ["auth before hello", (b: FakeBridge) => b.sendText({ type: "auth", ...info })],
    ["a binary first frame", (b: FakeBridge) => b.sendRaw(randomBytes(40))],
    [
      "a second hello",
      (b: FakeBridge) => {
        b.sendHello();
        b.sendHello();
      }
    ],
    [
      "a protocol 2 hello",
      (b: FakeBridge) => b.sendText({ type: "hello", protocol: 2, nonce: randomBytes(32).toString("base64url") })
    ],
    [
      "a hello whose nonce is not 32 bytes of base64url",
      (b: FakeBridge) => b.sendText({ type: "hello", protocol: 3, nonce: "a\nb" })
    ],
    [
      "a protocol 2 plaintext auth after the challenge",
      async (b: FakeBridge) => {
        b.sendHello();
        await until(() => b.challenge !== undefined);
        b.sendText({ type: "auth", proof: b.challenge!.proof, ...info });
      }
    ]
  ] as const) {
    it(`rejects ${label} with 4400 and makes no bridge`, async () => {
      const hub = await startHub();
      const bridge = await connect(hub);
      await frames(bridge);
      await until(() => bridge.closed !== null);
      assert.equal(bridge.closed?.code, CLOSE_PROTOCOL_ERROR);
      await settle();
      assert.equal(hub.bridgeInfo, null);
    });
  }

  it("refuses a protocol 1 hello with 4400 and a reason that names both protocols and both remedies, and logs the two numbers but nothing else of the frame", async () => {
    const logged: string[] = [];
    const hub = await startHub({ log: (message) => logged.push(message) });
    const closed = await firstFrame(hub, protocol1HelloAs(1));
    // Written out, not imported: the module tells a refused hello by this number, also from a server of another version.
    assert.equal(closed.code, 4400);
    assert.match(closed.reason, /protocol 1\b/);
    assert.match(closed.reason, /server 3\b/);
    assert.match(closed.reason, /reload Foundry/);
    assert.match(closed.reason, /restart the MCP server/);
    const about = logged.filter((line) => /protocol 1\b/.test(line));
    assert.equal(about.length, 1, "not exactly one log line about the refused hello");
    assert.match(about[0]!, /protocol 3\b/);
    const toolError = await noBridgeMessage(hub);
    for (const told of ["13.351", "0.1.0", "old-world", "Old World", "gm-id", "Old Gamemaster"]) {
      assert.ok(!logged.some((line) => line.includes(told)), `the log carries ${told} from the refused hello`);
      assert.ok(!toolError.includes(told), `the tool error carries ${told} from the refused hello`);
    }
    assert.equal(hub.bridgeInfo, null);
  });

  it("keeps the close reason for a four-digit protocol inside the 123 bytes a close frame may carry, with room for a four-digit protocol of its own", async () => {
    const hub = await startHub();
    const closed = await firstFrame(hub, protocol1HelloAs(9999));
    assert.equal(closed.code, 4400);
    assert.match(closed.reason, /protocol 9999\b/);
    assert.ok(Buffer.byteLength(closed.reason) <= 123 - 3, `the reason is ${Buffer.byteLength(closed.reason)} bytes`);
  });

  for (const [protocol, side, remedy, otherRemedy] of [
    [1, "an older module", /reload Foundry \(F5\)/, /restart this MCP server/i],
    [4, "a newer module", /restart this MCP server/, /reload Foundry/i]
  ] as const) {
    it(`fails a request after refusing the hello of ${side} with no_bridge, naming both protocols and the one remedy`, async () => {
      const hub = await startHub();
      await firstFrame(hub, protocol1HelloAs(protocol));
      const message = await noBridgeMessage(hub);
      assert.match(message, new RegExp(`protocol ${protocol}\\b`));
      assert.match(message, /protocol 3\b/);
      assert.match(message, remedy);
      assert.doesNotMatch(message, otherRemedy);
      assert.match(message, /Retrying alone does not help/);
      assert.doesNotMatch(message, /retry shortly/);
      assert.match(message, /the user has to paste the bridge token/);
      assert.match(message, /Do not print the token/);
    });
  }

  it("goes back to the plain no_bridge text once the refused hello is older than 30 seconds", async () => {
    let now = 1_000_000;
    const hub = await startHub({ now: () => now });
    await firstFrame(hub, protocol1HelloAs(1));
    now += 30_000;
    assert.match(await noBridgeMessage(hub), MISMATCH_TEXT);
    now += 1;
    const message = await noBridgeMessage(hub);
    assert.doesNotMatch(message, MISMATCH_TEXT);
    assert.match(message, /reconnects by itself within about 15 seconds/);
  });

  it("forgets a refused hello once a bridge has authenticated", async () => {
    const hub = await startHub();
    await firstFrame(hub, protocol1HelloAs(1));
    assert.match(await noBridgeMessage(hub), MISMATCH_TEXT);
    const bridge = await readyBridge(hub);
    bridge.close();
    await until(() => hub.bridgeInfo === null);
    const message = await noBridgeMessage(hub);
    assert.doesNotMatch(message, MISMATCH_TEXT);
    assert.match(message, /reconnects by itself within about 15 seconds/);
  });

  for (const [label, frame] of [
    ["a frame that is not JSON", "not json"],
    ["a hello without a protocol", { type: "hello", nonce: newNonce() }],
    ["a hello whose protocol is a string", { ...protocol1HelloAs(1), protocol: "1" }],
    ["a hello whose protocol is a fraction", { ...protocol1HelloAs(1), protocol: 1.5 }],
    ["a hello whose protocol is 0", protocol1HelloAs(0)],
    ["a hello whose protocol has five digits", protocol1HelloAs(10000)],
    ["a frame of another type that names protocol 1", { ...protocol1HelloAs(1), type: "auth" }],
    ["a protocol 3 hello with a bad nonce", { type: "hello", protocol: 3, nonce: "short" }]
  ] as const) {
    it(`refuses ${label} as before and does not take it for a protocol mismatch`, async () => {
      const logged: string[] = [];
      const hub = await startHub({ log: (message) => logged.push(message) });
      const closed = await firstFrame(hub, frame);
      assert.equal(closed.code, 4400);
      assert.match(closed.reason, /must be a protocol 3 hello/);
      const message = await noBridgeMessage(hub);
      assert.doesNotMatch(message, MISMATCH_TEXT);
      assert.match(message, /reconnects by itself within about 15 seconds/);
      assert.ok(!logged.some((line) => /refused a hello/.test(line)), "logged as a hello for another protocol");
    });
  }

  it("closes a connection that sends no hello in time", async () => {
    const hub = await startHub({ handshakeTimeoutMs: 40 });
    const bridge = await connect(hub);
    await until(() => bridge.closed !== null);
    assert.equal(bridge.closed?.code, CLOSE_HANDSHAKE_TIMEOUT);
    assert.equal(hub.bridgeInfo, null);
  });

  it("closes a connection that stops after hello when the handshake time runs out", async () => {
    const hub = await startHub({ handshakeTimeoutMs: 80 });
    const bridge = await connect(hub);
    bridge.sendHello();
    await until(() => bridge.challenge !== undefined);
    await until(() => bridge.closed !== null);
    assert.equal(bridge.closed?.code, CLOSE_HANDSHAKE_TIMEOUT);
    assert.equal(hub.bridgeInfo, null);
  });

  it("rejects requests with a message that tells a human what to do when no bridge is connected", async () => {
    const hub = await startHub();
    await assert.rejects(hub.request("get_scene", {}), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "no_bridge");
      assert.match(error.message, /as Gamemaster/);
      assert.match(error.message, /foundry-mcp module/);
      assert.match(error.message, /127\.0\.0\.1 address the module does not connect/);
      assert.match(error.message, /open Foundry at http:\/\/localhost:/);
      assert.match(error.message, /the user has to paste the bridge token/);
      assert.match(error.message, /Do not print the token/);
      assert.doesNotMatch(error.message, /npm run/, "a model with a shell would print the token into its transcript");
      return true;
    });
  });

  for (const [what, sent] of [
    ["names no method surface", { ...info, surface: undefined }],
    ["names a lower method surface than the server's", { ...info, surface: SURFACE_NUMBER - 1 }]
  ] as const) {
    it(`sends nothing to a module that ${what}, and says the user has to reload Foundry`, async () => {
      const hub = await startHub();
      const bridge = await connect(hub);
      await bridge.handshake(TOKEN, sent);
      await until(() => hub.bridgeInfo !== null);
      await assert.rejects(hub.request("get_scene", {}), (error: unknown) => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, "outdated_module");
        assert.match(error.message, /older foundry-mcp module/);
        assert.match(error.message, /reload Foundry \(F5\)/);
        return true;
      });
      await settle();
      assert.equal(bridge.requests.length, 0);
    });
  }

  it("works with a module that names a higher method surface than the server's", async () => {
    const hub = await startHub();
    const bridge = await connect(hub);
    await bridge.handshake(TOKEN, { ...info, surface: SURFACE_NUMBER + 1 });
    await until(() => hub.bridgeInfo !== null);
    const pending = hub.request("get_scene", {});
    await until(() => bridge.requests.length === 1);
    await bridge.respond(bridge.requests[0]!.id, "newer");
    assert.equal(await pending, "newer");
  });

  it("correlates two requests answered out of order", async () => {
    const hub = await startHub();
    const bridge = await readyBridge(hub);
    const first = hub.request("get_scene", { sceneId: "a" });
    const second = hub.request("get_scene", { sceneId: "b" });
    await until(() => bridge.requests.length === 2);
    const [reqA, reqB] = bridge.requests;
    assert.deepEqual(reqA?.params, { sceneId: "a" });
    await bridge.respond(reqB!.id, { answer: "for b" });
    await bridge.respond(reqA!.id, { answer: "for a" });
    assert.deepEqual(await first, { answer: "for a" });
    assert.deepEqual(await second, { answer: "for b" });
  });

  it("turns a bridge error response into a typed error", async () => {
    const hub = await startHub();
    const bridge = await readyBridge(hub);
    const pending = hub.request("delete_walls", { all: true });
    await until(() => bridge.requests.length === 1);
    await bridge.fail(bridge.requests[0]!.id, "not_found", "no such scene");
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "not_found");
      assert.equal(error.message, "no such scene");
      return true;
    });
  });

  it("times out a request the bridge never answers", async () => {
    const hub = await startHub();
    await readyBridge(hub);
    await assert.rejects(hub.request("get_scene", {}, { timeoutMs: 40 }), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "timeout");
      return true;
    });
  });

  it("closes a second bridge once it authenticates, while the first stays usable", async () => {
    const hub = await startHub();
    const first = await readyBridge(hub);
    const second = await connect(hub);
    await second.handshake();
    await until(() => second.closed !== null);
    assert.equal(second.closed?.code, CLOSE_ANOTHER_BRIDGE);
    assert.equal(first.closed, null);
    const pending = hub.request("get_scene", {});
    await until(() => first.requests.length === 1);
    await first.respond(first.requests[0]!.id, "still here");
    assert.equal(await pending, "still here");
  });

  it("accepts a new bridge after the first one goes away", async () => {
    const hub = await startHub();
    const first = await readyBridge(hub);
    first.close();
    await until(() => hub.bridgeInfo === null);
    await readyBridge(hub);
    assert.ok(hub.bridgeInfo);
  });

  it("rejects pending requests when the bridge closes", async () => {
    const hub = await startHub();
    const bridge = await readyBridge(hub);
    const pending = hub.request("get_scene", {});
    await until(() => bridge.requests.length === 1);
    bridge.close();
    await assert.rejects(pending, (error: unknown) => error instanceof BridgeError && error.code === "bridge_closed");
  });

  it("drops the bridge when a request cannot be sent, fails the requests waiting on it, and takes a new bridge", async () => {
    const hub = await startHub();
    const bridge = await readyBridge(hub);
    const waiting = hub.request("get_scene", {}, { timeoutMs: 1000 });
    await until(() => bridge.requests.length === 1);
    const bridgeClosed = (error: unknown) => error instanceof BridgeError && error.code === "bridge_closed";
    const encrypt = mock.method(crypto.subtle, "encrypt", async () => {
      throw new Error("no AES-GCM here");
    });
    try {
      await assert.rejects(hub.request("list_scenes", {}), bridgeClosed);
    } finally {
      encrypt.mock.restore();
    }
    await assert.rejects(waiting, bridgeClosed);
    assert.equal(hub.bridgeInfo, null);
    await until(() => bridge.closed !== null);
    const next = await readyBridge(hub);
    const pending = hub.request("get_scene", {});
    await until(() => next.requests.length === 1);
    await next.respond(next.requests[0]!.id, "served");
    assert.equal(await pending, "served");
  });

  it("delivers a result of 18 MiB from the bridge, the size of a large scene image", async () => {
    const hub = await startHub();
    const bridge = await readyBridge(hub);
    const pending = hub.request("get_scene_image", {});
    await until(() => bridge.requests.length === 1);
    const image = "A".repeat(18 * MiB);
    await bridge.respond(bridge.requests[0]!.id, { image });
    assert.ok(((await pending) as { image: string }).image === image, "the result did not arrive whole");
    assert.equal(bridge.closed, null);
  });

  it("takes a frame of 64 MiB from the bridge and closes with 1009 on a larger one", async () => {
    const hub = await startHub();
    const closeCode = (peer: RawPeer) =>
      framesFromHub(peer)
        .find((frame) => frame.opcode === OPCODE_CLOSE)
        ?.payload.readUInt16BE(0);
    const atTheCap = await rawBridge(hub);
    atTheCap.socket.write(unfinishedFrame(64 * MiB, 14));
    await settle();
    assert.equal(closeCode(atTheCap), undefined);
    assert.ok(hub.bridgeInfo, "the bridge ended on a frame of 64 MiB");
    atTheCap.socket.destroy();
    await until(() => hub.bridgeInfo === null);
    const over = await rawBridge(hub);
    over.socket.write(unfinishedFrame(64 * MiB + 1, 14));
    await until(() => closeCode(over) !== undefined);
    assert.equal(closeCode(over), 1009);
    over.socket.destroy();
  });

  it("starts without the port and fails every request with a message naming it", async () => {
    const holder = await startHub();
    const hub = await startHub({ port: holder.port });
    assert.equal(hub.state.kind, "unavailable");
    await assert.rejects(hub.request("get_scene", {}), (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "port_unavailable");
      assert.ok(error.message.includes(String(holder.port)));
      assert.match(error.message, /another foundry-mcp instance/i);
      return true;
    });
  });

  it("binds the loopback interface only", async () => {
    const hub = await startHub();
    assert.equal(hub.state.kind, "listening");
    assert.equal(hub.state.kind === "listening" && hub.state.address, "127.0.0.1");
  });

  it("does not promote a connection it has started closing when a hello follows a bad first frame", async () => {
    const logged: string[] = [];
    const hub = await startHub({ log: (message) => logged.push(message) });
    const liar = await connect(hub);
    liar.ws.send("not json");
    liar.sendHello();
    await until(() => liar.closed !== null);
    assert.equal(liar.closed?.code, CLOSE_PROTOCOL_ERROR);
    await settle();
    assert.equal(hub.bridgeInfo, null);
    assert.ok(!logged.some((line) => line.startsWith("bridge ready")), "the closing connection became the bridge");
    const honest = await readyBridge(hub);
    assert.ok(hub.bridgeInfo);
    assert.equal(honest.closed, null);
  });

  it("does not promote a connection closed for a missed hello deadline", async () => {
    const logged: string[] = [];
    const hub = await startHub({ handshakeTimeoutMs: 30, log: (message) => logged.push(message) });
    const late = await connect(hub);
    await until(() => late.closed !== null);
    late.sendHello();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hub.bridgeInfo, null);
    assert.ok(!logged.some((line) => line.startsWith("bridge ready")), "the closed connection became the bridge");
  });

  it("rejects pending requests when the hub stops", async () => {
    const hub = await startHub();
    const bridge = await readyBridge(hub);
    const pending = hub.request("get_scene", {});
    await until(() => bridge.requests.length === 1);
    await hub.stop();
    await assert.rejects(pending, (error: unknown) => error instanceof BridgeError && error.code === "bridge_closed");
  });

  it("rejects a request at once when the answer fails envelope validation but names the request", async () => {
    const hub = await startHub();
    const bridge = await readyBridge(hub);
    const pending = hub.request("get_scene", {}, { timeoutMs: 5000 });
    await until(() => bridge.requests.length === 1);
    await bridge.channel!.send({
      type: "response",
      id: bridge.requests[0]!.id,
      ok: false,
      error: { code: "weird", message: "x" }
    });
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, "foundry_error");
      assert.match(error.message, /malformed response from the bridge/);
      return true;
    });
  });

  it("keeps listening and stays usable after a late error on the listener", async () => {
    const hub = await startHub();
    assert.ok(hub.state.kind === "listening");
    hub.state.http.emit("error", new Error("late listener error"));
    assert.equal(hub.state.kind, "listening");
    await readyBridge(hub);
    assert.ok(hub.bridgeInfo);
  });

  it("binds again on the next request once the port holder is gone", async () => {
    const holder = new BridgeHub({ token: TOKEN, port: 0, allowedOrigins: [ORIGIN] });
    await holder.start();
    const hub = await startHub({ port: holder.port });
    assert.equal(hub.state.kind, "unavailable");
    await holder.stop();
    await assert.rejects(
      hub.request("get_scene", {}),
      (error: unknown) => error instanceof BridgeError && error.code === "no_bridge"
    );
    assert.equal(hub.state.kind, "listening");
    await readyBridge(hub);
    assert.ok(hub.bridgeInfo);
  });

  it("tells a human that the module reconnects by itself when no bridge is connected", async () => {
    const hub = await startHub();
    await assert.rejects(hub.request("get_scene", {}), /reconnects by itself within about 15 seconds/);
  });

  it("keeps an authenticated bridge connected and serving long after the handshake timeout", async () => {
    const hub = await startHub({ handshakeTimeoutMs: 40 });
    const bridge = await readyBridge(hub);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(bridge.closed, null);
    const pending = hub.request("get_scene", {});
    await until(() => bridge.requests.length === 1);
    await bridge.respond(bridge.requests[0]!.id, "still serving");
    assert.equal(await pending, "still serving");
  });

  for (const [label, inject] of [
    [
      "a text frame",
      (b: FakeBridge) => b.sendText({ type: "response", id: b.requests[0]!.id, ok: true, result: "forged" })
    ],
    ["a binary frame that does not open", (b: FakeBridge) => b.sendRaw(randomBytes(64))]
  ] as const) {
    it(`ends the bridge on ${label} after the handshake and fails the pending request instead of settling it`, async () => {
      const hub = await startHub();
      const bridge = await readyBridge(hub);
      const pending = hub.request("get_scene", {});
      await until(() => bridge.requests.length === 1);
      inject(bridge);
      await assert.rejects(pending, (error: unknown) => error instanceof BridgeError && error.code === "bridge_closed");
      assert.equal(hub.bridgeInfo, null);
      await until(() => bridge.closed !== null);
    });
  }

  it("never puts the token into a frame in either direction or into a log line", async () => {
    const logged: string[] = [];
    const hub = await startHub({ handshakeTimeoutMs: 60, log: (message) => logged.push(message) });
    const all: FakeBridge[] = [];
    const open = async () => {
      const bridge = await connect(hub);
      all.push(bridge);
      return bridge;
    };
    const good = await readyBridge(hub);
    all.push(good);
    const pending = hub.request("get_scene", {});
    await until(() => good.requests.length === 1);
    await good.respond(good.requests[0]!.id, "ok");
    await pending;
    await (await open()).handshake(WRONG_TOKEN);
    (await open()).sendRaw("garbage");
    (await open()).sendHello();
    await (await open()).handshake();
    await until(() => all.slice(1).every((bridge) => bridge.closed !== null));
    const codes = all
      .slice(1)
      .map((bridge) => bridge.closed?.code)
      .sort();
    assert.deepEqual(
      codes,
      [CLOSE_PROTOCOL_ERROR, CLOSE_AUTH_FAILED, CLOSE_HANDSHAKE_TIMEOUT, CLOSE_ANOTHER_BRIDGE].sort(),
      "not every case ran"
    );
    for (const bridge of all) {
      assert.ok(bridge.wire.length > 0);
      for (const entry of bridge.wire)
        assert.ok(!entry.data.toString("latin1").includes(TOKEN), `the token crossed the wire from the ${entry.from}`);
      assert.ok(!bridge.closed?.reason.includes(TOKEN));
    }
    assert.ok(logged.length > 0);
    assert.ok(!logged.some((line) => line.includes(TOKEN)), "the token reached the log");
  });
});

describe("BridgeHub with unauthenticated connections", () => {
  it("cuts off a rejected peer that ignores the close frame within about a second", async () => {
    const hub = await startHub();
    const peer = await rawWebSocket(hub.port, ORIGIN);
    const started = Date.now();
    peer.socket.write(encodeFrame(OPCODE_TEXT, "not a hello", true));
    await peer.closed;
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 900 && elapsed < 1600, `the connection lived ${elapsed} ms after its rejection`);
  });

  it("does not parse frames that arrive after a rejection", async () => {
    const hub = await startHub();
    const peer = await rawWebSocket(hub.port, ORIGIN);
    peer.socket.write(encodeFrame(OPCODE_TEXT, "not a hello", true));
    await until(() => peer.received().includes(Buffer.from([0x88])));
    const parse = mock.method(JSON, "parse");
    try {
      const hello = JSON.stringify({ type: "hello", protocol: 3, nonce: randomBytes(32).toString("base64url") });
      for (let i = 0; i < 20; i++) peer.socket.write(encodeFrame(OPCODE_TEXT, hello, true));
      await settle();
      assert.equal(parse.mock.callCount(), 0);
    } finally {
      parse.mock.restore();
    }
    assert.ok(!peer.received().toString("latin1").includes("challenge"), "a closing connection got a challenge");
  });

  // The cap tests open hundreds of connections one after the other, so no handshake may time out meanwhile.
  const capHub = () => startHub({ handshakeTimeoutMs: 60_000 });

  for (const [label, advance] of [
    ["sent nothing", async () => {}],
    [
      "sent a hello and got a challenge",
      async (held: FakeBridge[]) => {
        for (const bridge of held) bridge.sendHello();
        await until(() => held.every((bridge) => bridge.challenge !== undefined));
      }
    ]
  ] as const) {
    it(`drops the oldest of more than ${UNAUTHENTICATED_CAP} unauthenticated connections that ${label}, not the newcomer`, async () => {
      const hub = await capHub();
      const held: FakeBridge[] = [];
      for (let i = 0; i < UNAUTHENTICATED_CAP; i++) held.push(await connect(hub));
      await advance(held);
      await settle();
      assert.ok(held.every((bridge) => bridge.closed === null));
      const newcomer = await connect(hub);
      await until(() => held[0]!.closed !== null);
      await settle();
      assert.ok(
        held.slice(1).every((bridge) => bridge.closed === null),
        "a connection other than the oldest was dropped"
      );
      assert.equal(newcomer.closed, null);
    });
  }

  it(`lets the real module authenticate while ${UNAUTHENTICATED_CAP} idle unauthenticated sockets hang`, async () => {
    const hub = await capHub();
    for (let i = 0; i < UNAUTHENTICATED_CAP; i++) await connect(hub);
    const real = await readyBridge(hub);
    const pending = hub.request("get_scene", {});
    await until(() => real.requests.length === 1);
    await real.respond(real.requests[0]!.id, "through");
    assert.equal(await pending, "through");
  });

  it(`keeps the bridge when more than ${UNAUTHENTICATED_CAP} unauthenticated connections arrive after it authenticated`, async () => {
    const hub = await capHub();
    const bridge = await readyBridge(hub);
    for (let i = 0; i <= UNAUTHENTICATED_CAP; i++) await connect(hub);
    await settle();
    assert.equal(bridge.closed, null);
    const pending = hub.request("get_scene", {});
    await until(() => bridge.requests.length === 1);
    await bridge.respond(bridge.requests[0]!.id, "still the bridge");
    assert.equal(await pending, "still the bridge");
  });

  it("cuts a connection off without a close frame once it has sent more than 16 KiB without authenticating, even as one unfinished frame", async () => {
    const hub = await startHub();
    const peer = await rawWebSocket(hub.port, ORIGIN);
    const frame = unfinishedFrame(MiB, 16 * KiB + 1);
    peer.socket.write(frame.subarray(0, 16 * KiB));
    await settle();
    assert.equal(peer.socket.destroyed, false, "cut off at 16 KiB, not above it");
    peer.socket.write(frame.subarray(16 * KiB));
    await until(() => peer.socket.destroyed);
    assert.deepEqual(framesFromHub(peer), []);
  });

  it("goes on counting after the challenge and cuts off, without a close frame, a peer whose hello and unfinished next frame together are larger than 16 KiB", async () => {
    const hub = await startHub();
    const peer = await rawWebSocket(hub.port, ORIGIN);
    const hello = encodeFrame(OPCODE_TEXT, JSON.stringify({ type: "hello", protocol: 3, nonce: newNonce() }), true);
    peer.socket.write(hello);
    await until(() => framesFromHub(peer).length === 1);
    peer.socket.write(unfinishedFrame(MiB, 16 * KiB + 1 - hello.length));
    await until(() => peer.socket.destroyed);
    assert.deepEqual(
      framesFromHub(peer).map((frame) => frame.opcode),
      [OPCODE_TEXT],
      "the hub sent something other than the challenge"
    );
  });

  it("counts the bytes that arrive in one piece with the upgrade request", async () => {
    const hub = await startHub();
    const peer = await rawWebSocket(hub.port, ORIGIN, unfinishedFrame(MiB, 16 * KiB + 1));
    await until(() => peer.socket.destroyed);
    assert.deepEqual(framesFromHub(peer), []);
  });

  it("goes on counting after a rejection and cuts the peer off at once, not after the second it has to answer the close frame", async () => {
    const hub = await startHub();
    const peer = await rawWebSocket(hub.port, ORIGIN);
    peer.socket.write(encodeFrame(OPCODE_TEXT, "not a hello", true));
    await until(() => framesFromHub(peer).some((frame) => frame.opcode === OPCODE_CLOSE));
    const started = Date.now();
    peer.socket.write(unfinishedFrame(MiB, 16 * KiB + 1));
    await peer.closed;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `the rejected connection was read for another ${elapsed} ms`);
  });

  it("answers a hello with an unknown field, but not one that such a field makes larger than 16 KiB", async () => {
    const hub = await startHub();
    const hello = (pad: string) =>
      encodeFrame(OPCODE_TEXT, JSON.stringify({ type: "hello", protocol: 3, nonce: newNonce(), pad }), true);
    const small = await rawWebSocket(hub.port, ORIGIN);
    small.socket.write(hello("x"));
    await until(() => framesFromHub(small).length === 1);
    assert.equal(JSON.parse(framesFromHub(small)[0]!.payload.toString()).type, "challenge");
    small.socket.destroy();
    const large = await rawWebSocket(hub.port, ORIGIN);
    large.socket.write(hello("x".repeat(16 * KiB)));
    await until(() => large.socket.destroyed);
    assert.deepEqual(framesFromHub(large), [], "the oversized hello was answered");
  });

  it("cuts off a hello for another protocol that is larger than 16 KiB before reading its protocol", async () => {
    const hub = await startHub();
    const peer = await rawWebSocket(hub.port, ORIGIN);
    peer.socket.write(
      encodeFrame(OPCODE_TEXT, JSON.stringify({ ...protocol1HelloAs(1), pad: "x".repeat(16 * KiB) }), true)
    );
    await until(() => peer.socket.destroyed);
    assert.deepEqual(framesFromHub(peer), [], "the oversized hello was answered");
    assert.doesNotMatch(await noBridgeMessage(hub), MISMATCH_TEXT);
  });
});
