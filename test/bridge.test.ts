import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { WebSocket as NodeWebSocket } from "ws";
import { Bridge, type Problem } from "../module/scripts/bridge.mjs";
import { Channel, toBase64url } from "../module/scripts/channel.mjs";
import { MethodError } from "../module/scripts/methods.mjs";
import { BridgeError, BridgeHub } from "../src/hub.ts";
import { FakeWebSocket } from "./fake-websocket.ts";
import { ORIGIN, TOKEN, until, WRONG_TOKEN } from "./helpers.ts";

const sockets: NodeWebSocket[] = [];

class BrowserLikeWebSocket extends NodeWebSocket {
  constructor(url: string) {
    super(url, { origin: ORIGIN });
    sockets.push(this);
  }
}

const realWebSocket = globalThis.WebSocket;
const hubs: BridgeHub[] = [];
const bridges: Bridge[] = [];

beforeEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = BrowserLikeWebSocket;
});

afterEach(async () => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  for (const b of bridges.splice(0)) b.stop();
  for (const h of hubs.splice(0)) await h.stop();
  // A socket still closing would clear its 30 s close timer during the next test, where clearTimeout is mocked.
  await until(() => sockets.every((socket) => socket.readyState === NodeWebSocket.CLOSED));
  sockets.length = 0;
});

const bridgeInfo = () => ({
  foundry: "14.370",
  module: "0.2.0",
  world: { id: "w", title: "W" },
  user: { id: "u", name: "GM" }
});

async function hubAndBridge(methods: Record<string, (params: unknown) => Promise<unknown>>, port = 0) {
  const hub = new BridgeHub({ token: TOKEN, port, allowedOrigins: [ORIGIN] });
  hubs.push(hub);
  await hub.start();
  const boundPort = hub.port;
  const bridge = new Bridge({
    getPort: () => boundPort,
    getPageHost: () => "localhost",
    getToken: () => TOKEN,
    getInfo: bridgeInfo,
    methods,
    log: () => {},
    warn: () => {}
  });
  bridges.push(bridge);
  bridge.start();
  await until(() => hub.bridgeInfo !== null);
  return { hub, bridge };
}

describe("module bridge against the hub", () => {
  it("introduces itself in the auth frame after the handshake", async () => {
    const { hub } = await hubAndBridge({});
    assert.deepEqual(hub.bridgeInfo, bridgeInfo());
  });

  it("runs a registered method and returns its result", async () => {
    const { hub } = await hubAndBridge({ get_scene: async (params) => ({ echoed: params }) });
    assert.deepEqual(await hub.request("get_scene", { sceneId: "s" }), { echoed: { sceneId: "s" } });
  });

  it("answers an unregistered method with unknown_method", async () => {
    const { hub } = await hubAndBridge({});
    await assert.rejects(
      hub.request("create_walls", {}),
      (e: unknown) => e instanceof BridgeError && e.code === "unknown_method"
    );
  });

  it("does not treat inherited object properties as methods", async () => {
    const { hub } = await hubAndBridge({});
    await assert.rejects(
      hub.request("constructor" as never, {}),
      (e: unknown) => e instanceof BridgeError && e.code === "unknown_method"
    );
  });

  it("keeps its code when a method throws a MethodError, and reports other exceptions as foundry_error", async () => {
    const { hub } = await hubAndBridge({
      get_scene: async () => {
        throw new MethodError("not_found", "no scene");
      },
      delete_walls: async () => {
        throw new Error("validation failed");
      },
      create_walls: async () => ({ created: 0 })
    });
    await assert.rejects(
      hub.request("get_scene", {}),
      (e: unknown) => e instanceof BridgeError && e.code === "not_found" && e.message === "no scene"
    );
    await assert.rejects(
      hub.request("delete_walls", { all: true }),
      (e: unknown) => e instanceof BridgeError && e.code === "foundry_error" && e.message === "validation failed"
    );
    assert.deepEqual(await hub.request("create_walls", {}), { created: 0 });
  });

  it("reconnects with backoff after the server goes away", async () => {
    const { hub } = await hubAndBridge({ get_scene: async () => "ok" });
    const { port } = hub;
    await hub.stop();
    await until(() => hub.bridgeInfo === null);
    const next = new BridgeHub({ token: TOKEN, port, allowedOrigins: [ORIGIN] });
    hubs.push(next);
    await next.start();
    await until(() => next.bridgeInfo !== null, 4000);
    assert.equal(await next.request("get_scene", {}), "ok");
  });
});

describe("module bridge lifecycle", () => {
  const PORT = 31800;
  type Methods = Record<string, (params: unknown) => Promise<unknown>>;

  function lifecycle(
    options: { getPort?: () => number; getPageHost?: () => string; getToken?: () => string; methods?: Methods } = {}
  ) {
    const logs: unknown[][] = [];
    const problems: Problem[] = [];
    const calls: string[] = [];
    const methods: Methods = options.methods ?? {
      get_scene: async () => {
        calls.push("get_scene");
        return "ran";
      }
    };
    const bridge = new Bridge({
      getPort: options.getPort ?? (() => PORT),
      getPageHost: options.getPageHost ?? (() => "localhost"),
      getToken: options.getToken ?? (() => TOKEN),
      getInfo: bridgeInfo,
      methods,
      log: (...args: unknown[]) => logs.push(args),
      warn: (problem: Problem) => problems.push(problem)
    });
    bridges.push(bridge);
    return { bridge, logs, problems, calls };
  }

  // Timers are mocked here, so waiting for WebCrypto polls with setImmediate against the real clock.
  async function eventually(condition: () => boolean, what: string): Promise<void> {
    const deadline = performance.now() + 2000;
    while (!condition()) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setImmediate(r));
    }
  }

  // Long enough for any proof check the bridge started to have finished.
  async function quiet(): Promise<void> {
    const until = performance.now() + 50;
    while (performance.now() < until) await new Promise((r) => setImmediate(r));
  }

  const request = { type: "request", id: "r1", method: "get_scene", params: {} };
  const deliverText = (ws: FakeWebSocket, frame: object) => ws.emit("message", { data: JSON.stringify(frame) });
  const textFrames = (ws: FakeWebSocket) =>
    ws.sent.filter((raw) => typeof raw === "string").map((raw) => JSON.parse(raw) as Record<string, any>);

  async function fakeServer(ws: FakeWebSocket, token: string = TOKEN, proofFrame: object = { type: "ready" }) {
    const [hello] = textFrames(ws);
    assert.equal(hello?.type, "hello");
    const outbox: Uint8Array[] = [];
    const serverNonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const channel = await Channel.create({
      token,
      clientNonce: hello!.nonce,
      serverNonce,
      role: "server",
      transmit: (sealed) => outbox.push(sealed)
    });
    await channel.send(proofFrame);
    let opened = 0;
    return {
      challenge: { type: "challenge", nonce: serverNonce, proof: toBase64url(outbox[0]!) },
      async seal(frame: object): Promise<ArrayBuffer> {
        await channel.send(frame);
        return outbox.at(-1)!.slice().buffer;
      },
      async deliver(frame: object): Promise<ArrayBuffer> {
        const data = await this.seal(frame);
        ws.emit("message", { data });
        return data;
      },
      async received(): Promise<Record<string, any>[]> {
        const binary = ws.sent.filter((raw): raw is Uint8Array => typeof raw !== "string");
        const frames = [];
        for (const sealed of binary.slice(opened)) {
          const result = await channel.receive(sealed);
          assert.ok(result.ok, "a frame from the module did not open");
          frames.push(JSON.parse(result.text));
        }
        opened = binary.length;
        return frames;
      }
    };
  }

  async function handshake(ws: FakeWebSocket) {
    ws.emit("open");
    const server = await fakeServer(ws);
    deliverText(ws, server.challenge);
    await eventually(() => ws.sent.length === 2, "the auth frame");
    assert.equal((await server.received())[0]?.type, "auth");
    return server;
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("does not construct a WebSocket without a token and warns that one is needed", () => {
    for (const token of ["", "   "]) {
      const { bridge, problems } = lifecycle({ getToken: () => token });
      bridge.start();
      mock.timers.tick(60_000);
      assert.equal(FakeWebSocket.instances.length, 0);
      assert.deepEqual(problems, [{ kind: "no-token" }]);
    }
  });

  it("does not connect when the page has no crypto.subtle and warns about the secure context", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: crypto.getRandomValues.bind(crypto) },
      configurable: true
    });
    try {
      const { bridge, problems } = lifecycle();
      bridge.start();
      assert.equal(FakeWebSocket.instances.length, 0);
      assert.deepEqual(problems, [{ kind: "insecure-context" }]);
    } finally {
      Object.defineProperty(globalThis, "crypto", descriptor);
    }
  });

  for (const [label, token] of [
    ["", TOKEN],
    [", also while no token is set", ""]
  ] as const) {
    it(`does not construct a WebSocket on a page opened at the host it dials, and warns about that page${label}`, () => {
      const { bridge, problems } = lifecycle({ getPageHost: () => "127.0.0.1", getToken: () => token });
      bridge.start();
      mock.timers.tick(60_000);
      assert.equal(FakeWebSocket.instances.length, 0);
      assert.deepEqual(problems, [{ kind: "loopback-ip-page" }]);
      assert.equal(bridge.state.kind, "idle");
    });
  }

  it("connects from a page at 127.0.0.2, a loopback address it does not dial", () => {
    const { bridge, problems } = lifecycle({ getPageHost: () => "127.0.0.2" });
    bridge.start();
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.deepEqual(problems, []);
  });

  it("completes the handshake with a sealed auth frame carrying the identifying fields, then runs a sealed request", async () => {
    const { bridge, calls } = lifecycle();
    bridge.start();
    const ws = FakeWebSocket.last;
    assert.equal(ws.binaryType, "arraybuffer");
    ws.emit("open");
    const [hello] = textFrames(ws);
    assert.deepEqual(
      Object.keys(hello!).sort(),
      ["nonce", "protocol", "type"],
      "the hello frame says more than it needs to"
    );
    assert.equal(hello!.protocol, 3);
    const server = await fakeServer(ws);
    deliverText(ws, server.challenge);
    await eventually(() => ws.sent.length === 2, "the auth frame");
    assert.equal(typeof ws.sent[1], "object", "the auth frame was not sealed");
    assert.deepEqual(await server.received(), [{ type: "auth", ...bridgeInfo() }]);

    await server.deliver(request);
    await eventually(() => ws.sent.length === 3, "the response");
    assert.deepEqual(calls, ["get_scene"]);
    assert.deepEqual(await server.received(), [{ type: "response", id: "r1", ok: true, result: "ran" }]);
    assert.ok(
      !ws.sent.some((raw) => Buffer.from(raw).toString("latin1").includes(TOKEN)),
      "the token crossed the wire"
    );
  });

  it("uses a fresh client nonce for every connection", async () => {
    const { bridge } = lifecycle();
    bridge.start();
    const first = FakeWebSocket.last;
    first.emit("open");
    first.emit("close", { code: 1006, reason: "" });
    mock.timers.tick(1000);
    const second = FakeWebSocket.last;
    assert.notEqual(second, first);
    second.emit("open");
    assert.notEqual(textFrames(first)[0]!.nonce, textFrames(second)[0]!.nonce);
  });

  it("closes on a bad server proof, sends no auth, never runs a later request, and warns once across retries without resetting the backoff", async () => {
    const { bridge, problems, calls, logs } = lifecycle();
    bridge.start();
    for (const attempt of [1, 2]) {
      const ws = FakeWebSocket.last;
      ws.emit("open");
      const impostor = await fakeServer(ws, WRONG_TOKEN);
      deliverText(ws, impostor.challenge);
      await eventually(() => ws.closeCalls === 1, `close after bad proof ${attempt}`);
      await impostor.deliver(request);
      deliverText(ws, request);
      await quiet();
      assert.deepEqual(ws.sent.length, 1, "the module sent more than hello to a server that did not prove the token");
      assert.deepEqual(calls, []);
      const before = FakeWebSocket.instances.length;
      const delay = attempt === 1 ? 1000 : 2000;
      mock.timers.tick(delay - 1);
      assert.equal(FakeWebSocket.instances.length, before, `retried before ${delay} ms`);
      mock.timers.tick(1);
      assert.equal(FakeWebSocket.instances.length, before + 1, `no retry after ${delay} ms`);
    }
    assert.deepEqual(problems, [{ kind: "bad-proof", port: PORT }]);
    assert.ok(!logs.flat().some((entry) => String(entry).includes(TOKEN)), "the token reached the log");
  });

  it("closes on a challenge whose sealed frame 0 opens but is not the ready frame, and sends no auth", async () => {
    const { bridge, problems } = lifecycle();
    bridge.start();
    const ws = FakeWebSocket.last;
    ws.emit("open");
    deliverText(ws, (await fakeServer(ws, TOKEN, request)).challenge);
    await eventually(() => ws.closeCalls === 1, "the close");
    await quiet();
    assert.equal(ws.sent.length, 1);
    assert.deepEqual(problems, [{ kind: "bad-proof", port: PORT }]);
  });

  for (const [length, accepted] of [
    [1024, true],
    [1025, false]
  ] as const) {
    it(`${accepted ? "accepts" : "does not parse"} a challenge of ${length} characters whose proof opens under the token`, async () => {
      const { bridge, problems } = lifecycle();
      bridge.start();
      const ws = FakeWebSocket.last;
      ws.emit("open");
      const server = await fakeServer(ws);
      const padded = (pad: string) => JSON.stringify({ ...server.challenge, pad });
      const challenge = padded("x".repeat(length - padded("").length));
      assert.equal(challenge.length, length);
      ws.emit("message", { data: challenge });
      if (accepted) {
        await eventually(() => ws.sent.length === 2, "the auth frame");
        assert.deepEqual(problems, []);
      } else {
        assert.equal(ws.closeCalls, 1);
        await quiet();
        assert.equal(ws.sent.length, 1, "auth was sent in answer to an oversized challenge");
        assert.deepEqual(problems, [{ kind: "no-challenge", port: PORT }]);
      }
    });
  }

  it("closes without the wrong-token warning when WebCrypto itself fails", async () => {
    const { bridge, problems, logs } = lifecycle();
    bridge.start();
    const ws = FakeWebSocket.last;
    ws.emit("open");
    const server = await fakeServer(ws);
    const decrypt = mock.method(crypto.subtle, "decrypt", async () => {
      throw new TypeError("no AES-GCM here");
    });
    try {
      deliverText(ws, server.challenge);
      await eventually(() => ws.closeCalls === 1, "the close");
    } finally {
      decrypt.mock.restore();
    }
    assert.deepEqual(problems, []);
    assert.ok(
      logs.some((entry) => entry.some((part) => part instanceof TypeError)),
      "the crypto error was not logged"
    );
    assert.equal(ws.sent.length, 1);
  });

  it("closes when a request arrives while a valid server proof is still being checked, and never runs it", async () => {
    const { bridge, calls, problems } = lifecycle();
    bridge.start();
    const ws = FakeWebSocket.last;
    ws.emit("open");
    const server = await fakeServer(ws);
    const sealed = await server.seal(request);
    deliverText(ws, server.challenge);
    ws.emit("message", { data: sealed });
    assert.equal(ws.closeCalls, 1);
    await quiet();
    assert.equal(ws.sent.length, 1, "auth was sent after the connection was abandoned");
    assert.deepEqual(calls, []);
    assert.deepEqual(problems, [], "a valid proof was reported as bad");
  });

  it("closes when a request arrives instead of the challenge, never runs it, and says the server does not answer like foundry-mcp", async () => {
    const { bridge, calls, problems } = lifecycle();
    bridge.start();
    const ws = FakeWebSocket.last;
    ws.emit("open");
    deliverText(ws, request);
    assert.equal(ws.closeCalls, 1);
    await quiet();
    assert.equal(ws.sent.length, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(problems, [{ kind: "no-challenge", port: PORT }]);
  });

  for (const [label, frame] of [
    ["a text frame, even a well-formed request", async () => JSON.stringify(request)],
    ["random bytes", async () => crypto.getRandomValues(new Uint8Array(64)).buffer],
    [
      "a frame sealed under another token",
      async (ws: FakeWebSocket) => (await fakeServer(ws, WRONG_TOKEN)).seal(request)
    ]
  ] as const) {
    it(`closes on ${label} once open, and never runs it`, async () => {
      const { bridge, calls } = lifecycle();
      bridge.start();
      const ws = FakeWebSocket.last;
      await handshake(ws);
      ws.emit("message", { data: await frame(ws) });
      await eventually(() => ws.closeCalls === 1, "the close");
      await quiet();
      assert.deepEqual(calls, []);
      assert.equal(bridge.state.kind, "waiting");
    });
  }

  it("closes on a replayed sealed request and does not run it a second time", async () => {
    const { bridge, calls } = lifecycle();
    bridge.start();
    const ws = FakeWebSocket.last;
    const server = await handshake(ws);
    const sealed = await server.deliver(request);
    await eventually(() => calls.length === 1, "the first run");
    ws.emit("message", { data: sealed });
    await eventually(() => ws.closeCalls === 1, "the close");
    await quiet();
    assert.deepEqual(calls, ["get_scene"]);
  });

  it("stays connected and serving long after the handshake timeout", async () => {
    const { bridge, calls } = lifecycle();
    bridge.start();
    const ws = FakeWebSocket.last;
    const server = await handshake(ws);
    mock.timers.tick(60_000);
    assert.equal(ws.closeCalls, 0);
    await server.deliver(request);
    await eventually(() => calls.length === 1, "the request");
  });

  it("closes the socket when no challenge arrives within 5 s, and when it never opens", () => {
    const { bridge } = lifecycle();
    bridge.start();
    const silent = FakeWebSocket.last;
    silent.emit("open");
    mock.timers.tick(4999);
    assert.equal(silent.closeCalls, 0);
    mock.timers.tick(1);
    assert.equal(silent.closeCalls, 1);
    mock.timers.tick(1000);
    const neverOpens = FakeWebSocket.last;
    assert.notEqual(neverOpens, silent);
    mock.timers.tick(5000);
    assert.equal(neverOpens.closeCalls, 1);
  });

  it("warns once that the port holder sends no challenge, for sockets that open and stay silent but not for refused ones", () => {
    const { bridge, problems } = lifecycle();
    bridge.start();
    for (const delay of [1000, 2000, 4000]) {
      FakeWebSocket.last.emit("close", { code: 1006, reason: "" });
      mock.timers.tick(delay);
    }
    assert.deepEqual(problems, [], "a refused connection was reported");
    for (const delay of [8000, 15000]) {
      FakeWebSocket.last.emit("open");
      mock.timers.tick(5000);
      mock.timers.tick(delay);
    }
    assert.deepEqual(problems, [{ kind: "no-challenge", port: PORT }]);
  });

  it("reports a protocol mismatch once, not a missing challenge, when the server answers the hello with close code 4400, and logs the reason it gave", () => {
    const { bridge, problems, logs } = lifecycle();
    bridge.start();
    const reason = "first frame must be a valid hello";
    for (const delay of [1000, 2000]) {
      FakeWebSocket.last.emit("open");
      FakeWebSocket.last.emit("close", { code: 4400, reason });
      mock.timers.tick(delay);
    }
    assert.deepEqual(problems, [{ kind: "protocol-mismatch", port: PORT }]);
    assert.ok(
      logs.some((entry) => /refused/.test(String(entry[0])) && entry.includes(reason)),
      "no log line carries the close reason as a hint"
    );
  });

  for (const code of [1006, 4408]) {
    it(`warns once that the port holder sends no challenge when it closes with code ${code} before one`, () => {
      const { bridge, problems } = lifecycle();
      bridge.start();
      for (const delay of [1000, 2000]) {
        FakeWebSocket.last.emit("open");
        FakeWebSocket.last.emit("close", { code, reason: "module speaks protocol 3, server 4" });
        mock.timers.tick(delay);
      }
      assert.deepEqual(problems, [{ kind: "no-challenge", port: PORT }]);
    });
  }

  it("does not take close code 4400 for a protocol mismatch once the challenge has arrived", async () => {
    const { bridge, problems } = lifecycle();
    bridge.start();
    const ws = FakeWebSocket.last;
    ws.emit("open");
    deliverText(ws, (await fakeServer(ws)).challenge);
    ws.emit("close", { code: 4400, reason: "every frame after the challenge must be sealed" });
    await quiet();
    assert.deepEqual(problems, []);
  });

  it("warns again after restart(), for a second wrong token and for a second silent port holder", async () => {
    const { bridge, problems } = lifecycle();
    for (let round = 0; round < 2; round++) {
      if (round === 0) bridge.start();
      else bridge.restart();
      const ws = FakeWebSocket.last;
      ws.emit("open");
      deliverText(ws, (await fakeServer(ws, WRONG_TOKEN)).challenge);
      await eventually(() => ws.closeCalls === 1, "the close");
      mock.timers.tick(1000);
      FakeWebSocket.last.emit("open");
      mock.timers.tick(5000);
    }
    assert.deepEqual(problems, [
      { kind: "bad-proof", port: PORT },
      { kind: "no-challenge", port: PORT },
      { kind: "bad-proof", port: PORT },
      { kind: "no-challenge", port: PORT }
    ]);
  });

  it("stop() closes the connection and no reconnect follows", () => {
    const { bridge } = lifecycle();
    bridge.start();
    const ws = FakeWebSocket.last;
    ws.emit("open");
    bridge.stop();
    assert.equal(ws.closeCalls, 1);
    ws.emit("close", { code: 1000, reason: "" });
    mock.timers.tick(60_000);
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(bridge.state.kind, "idle");
  });

  it("stop() cancels a pending retry", () => {
    const { bridge } = lifecycle();
    bridge.start();
    FakeWebSocket.last.emit("close", { code: 1006, reason: "" });
    assert.equal(bridge.state.kind, "waiting");
    bridge.stop();
    mock.timers.tick(60_000);
    assert.equal(FakeWebSocket.instances.length, 1);
  });

  it("restart() drops the connection and connects again at once", () => {
    const { bridge } = lifecycle();
    bridge.start();
    const first = FakeWebSocket.last;
    first.emit("open");
    bridge.restart();
    assert.equal(first.closeCalls, 1);
    assert.equal(FakeWebSocket.instances.length, 2);
    first.emit("close", { code: 1000, reason: "" });
    mock.timers.tick(60_000);
    assert.equal(FakeWebSocket.instances.length, 2);
  });

  it("doubles the retry delay from 1 s and caps it at 15 s", () => {
    const { bridge } = lifecycle();
    bridge.start();
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000, 15000]) {
      const before = FakeWebSocket.instances.length;
      FakeWebSocket.last.emit("close", { code: 1006, reason: "" });
      mock.timers.tick(delay - 1);
      assert.equal(FakeWebSocket.instances.length, before, `retried before ${delay} ms`);
      mock.timers.tick(1);
      assert.equal(FakeWebSocket.instances.length, before + 1, `no retry after ${delay} ms`);
    }
  });

  it("goes back to the shortest delay after a connection that served a request", async () => {
    const { bridge } = lifecycle();
    bridge.start();
    for (const delay of [1000, 2000]) {
      FakeWebSocket.last.emit("close", { code: 1006, reason: "" });
      mock.timers.tick(delay);
    }
    const ws = FakeWebSocket.last;
    const server = await handshake(ws);
    await server.deliver(request);
    await quiet();
    ws.emit("close", { code: 1006, reason: "" });
    const before = FakeWebSocket.instances.length;
    mock.timers.tick(1000);
    assert.equal(FakeWebSocket.instances.length, before + 1);
  });

  it("logs and retries instead of going idle when the port cannot form a URL", () => {
    let port = 70000;
    const { bridge, logs } = lifecycle({ getPort: () => port });
    bridge.start();
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(bridge.state.kind, "waiting");
    assert.match(String(logs[0]?.[0]), /cannot connect to ws:\/\/127\.0\.0\.1:70000 .*1 to 65535/);
    port = Number.NaN;
    mock.timers.tick(1000);
    assert.equal(bridge.state.kind, "waiting");
    assert.match(String(logs[1]?.[0]), /NaN/);
    port = 31800;
    mock.timers.tick(2000);
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(FakeWebSocket.last.url, "ws://127.0.0.1:31800");
  });

  it("logs and retries when the WebSocket constructor throws", () => {
    const { bridge, logs } = lifecycle();
    (globalThis as { WebSocket: unknown }).WebSocket = class {
      constructor() {
        throw new SyntaxError("blocked");
      }
    };
    bridge.start();
    assert.equal(bridge.state.kind, "waiting");
    assert.match(String(logs[0]?.[0]), /blocked/);
  });

  it("reports a failing method through the injected log and still answers", async () => {
    const boom = new Error("boom");
    const { bridge, logs } = lifecycle({
      methods: {
        get_scene: async () => {
          throw boom;
        }
      }
    });
    bridge.start();
    const ws = FakeWebSocket.last;
    const server = await handshake(ws);
    await server.deliver(request);
    await eventually(() => ws.sent.length === 3, "the response");
    assert.deepEqual(
      logs.find((l) => String(l[0]).includes("get_scene failed")),
      ["get_scene failed:", boom]
    );
    assert.deepEqual(await server.received(), [
      { type: "response", id: "r1", ok: false, error: { code: "foundry_error", message: "boom" } }
    ]);
  });
});
