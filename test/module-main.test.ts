import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { FakeWebSocket } from "./fake-websocket.ts";

const ROLES = { NONE: 0, PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 };

type SettingConfig = { onChange: (value: unknown) => void };
type Hooks = Record<string, () => void>;

const globals = globalThis as Record<string, unknown>;
const saved = {
  Hooks: globals.Hooks,
  game: globals.game,
  CONST: globals.CONST,
  ui: globals.ui,
  WebSocket: globals.WebSocket,
  location: globals.location
};
let loads = 0;

// init runs with game.user still null, as in Foundry.
async function boot(role: number, initial: { port?: number; enabled?: boolean; token?: string } = {}) {
  const hooks: Hooks = {};
  const registered: Record<string, SettingConfig> = {};
  const warnings: string[] = [];
  const values: Record<string, unknown> = { port: 31800, enabled: true, token: "t".repeat(43), ...initial };
  const game: Record<string, unknown> = {
    user: null,
    version: "14.370",
    world: { id: "w", title: "W" },
    modules: new Map([["foundry-mcp", { version: "0.1.0" }]]),
    settings: {
      register: (_ns: string, key: string, config: SettingConfig) => (registered[key] = config),
      get: (_ns: string, key: string) => values[key]
    }
  };
  globals.Hooks = { once: (name: string, fn: () => void) => (hooks[name] = fn) };
  globals.game = game;
  globals.CONST = { USER_ROLES: ROLES };
  globals.ui = { notifications: { warn: (message: string) => warnings.push(message) } };
  globals.WebSocket = FakeWebSocket;
  await import(`../module/scripts/main.mjs?load=${++loads}`);
  hooks.init!();
  game.user = { id: "u", name: "User", hasRole: (needed: number) => role >= needed };
  hooks.ready!();
  return {
    warnings,
    registered,
    changeToken(value: string) {
      values.token = value;
      registered.token!.onChange(value);
    },
    changeEnabled(value: boolean) {
      values.enabled = value;
      registered.enabled!.onChange(value);
    },
    changePort(value: number) {
      values.port = value;
      registered.port!.onChange(value);
    }
  };
}

describe("module main.mjs", () => {
  // Each boot leaves a bridge no test can stop; mocked timers keep its timeouts from firing after the globals are gone.
  beforeEach(() => {
    FakeWebSocket.instances = [];
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {
    mock.timers.reset();
    Object.assign(globals, saved);
  });

  for (const [name, role] of [
    ["a player", ROLES.PLAYER],
    ["a trusted player", ROLES.TRUSTED],
    ["an Assistant GM", ROLES.ASSISTANT]
  ] as const) {
    it(`never starts the bridge for ${name}, even when the setting is toggled`, async () => {
      const world = await boot(role);
      world.changeEnabled(false);
      world.changeEnabled(true);
      world.changePort(31801);
      world.changeToken("u".repeat(43));
      assert.equal(FakeWebSocket.instances.length, 0);
      assert.deepEqual(world.warnings, []);
    });
  }

  it("starts the bridge for a Gamemaster on the configured port", async () => {
    await boot(ROLES.GAMEMASTER, { port: 31900 });
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.equal(FakeWebSocket.last.url, "ws://127.0.0.1:31900");
  });

  it("does not start when the enabled setting is off", async () => {
    await boot(ROLES.GAMEMASTER, { enabled: false });
    assert.equal(FakeWebSocket.instances.length, 0);
  });

  it("starts and stops when the enabled setting is toggled", async () => {
    const world = await boot(ROLES.GAMEMASTER, { enabled: false });
    world.changeEnabled(true);
    assert.equal(FakeWebSocket.instances.length, 1);
    world.changeEnabled(false);
    assert.equal(FakeWebSocket.last.closeCalls, 1);
    world.changeEnabled(true);
    assert.equal(FakeWebSocket.instances.length, 2);
  });

  it("reconnects to the new port when the port changes while enabled", async () => {
    const world = await boot(ROLES.GAMEMASTER);
    world.changePort(31901);
    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(FakeWebSocket.instances[0]!.closeCalls, 1);
    assert.equal(FakeWebSocket.last.url, "ws://127.0.0.1:31901");
  });

  it("keeps the token in a client-scope String setting shown in the settings form", async () => {
    const { registered } = await boot(ROLES.GAMEMASTER);
    assert.deepEqual(
      Object.fromEntries(
        ["scope", "config", "type", "default"].map((key) => [key, (registered.token as Record<string, unknown>)[key]])
      ),
      { scope: "client", config: true, type: String, default: "" }
    );
  });

  it("opens no socket without a token and tells the Gamemaster once how to get one", async () => {
    const { warnings } = await boot(ROLES.GAMEMASTER, { token: "" });
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /npm run -s token/);
    assert.match(warnings[0]!, /not through an AI agent/);
    assert.match(warnings[0]!, /Bridge token/);
  });

  it("opens no socket on a page opened at 127.0.0.1 and tells the Gamemaster to use localhost and why, and connects on a localhost page", async () => {
    globals.location = { hostname: "127.0.0.1", host: "127.0.0.1:30123", port: "30123" };
    const { warnings } = await boot(ROLES.GAMEMASTER);
    assert.equal(FakeWebSocket.instances.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /http:\/\/localhost:30123/);
    assert.match(warnings[0]!, /login cookie/);

    globals.location = { hostname: "localhost", host: "localhost:30123", port: "30123" };
    const onLocalhost = await boot(ROLES.GAMEMASTER);
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.deepEqual(onLocalhost.warnings, []);
  });

  it("tells the Gamemaster once when the process on the port opens the socket but sends no challenge", async () => {
    const { warnings } = await boot(ROLES.GAMEMASTER, { port: 31904 });
    FakeWebSocket.last.emit("open");
    mock.timers.tick(5000);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /127\.0\.0\.1:31904 does not answer like a foundry-mcp server of this version/);
    assert.match(warnings[0]!, /Restart the MCP server/);
  });

  it("tells the Gamemaster once, in its own words and without the server's close reason, when the server speaks another protocol", async () => {
    const { warnings } = await boot(ROLES.GAMEMASTER, { port: 31905 });
    const reason = '<img src=x onerror="alert(1)"> module speaks protocol 3, server 9';
    for (const delay of [1000, 2000]) {
      FakeWebSocket.last.emit("open");
      FakeWebSocket.last.emit("close", { code: 4400, reason });
      mock.timers.tick(delay);
    }
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0]!,
      /MCP server on 127\.0\.0\.1:31905 speaks another protocol than this module \(protocol 3\)/
    );
    assert.match(warnings[0]!, /outdated/);
    assert.match(warnings[0]!, /Restart the MCP server/);
    assert.match(warnings[0]!, /reload Foundry/);
    for (const part of ["<img", "onerror", "server 9"])
      assert.ok(!warnings[0]!.includes(part), `the notification carries ${part} from the close reason`);
  });

  it("does not warn about a missing token when the bridge is off", async () => {
    const { warnings } = await boot(ROLES.GAMEMASTER, { token: "", enabled: false });
    assert.deepEqual(warnings, []);
  });

  it("connects once a token is pasted, and reconnects when it changes", async () => {
    const world = await boot(ROLES.GAMEMASTER, { token: "" });
    world.changeToken("v".repeat(43));
    assert.equal(FakeWebSocket.instances.length, 1);
    world.changeToken("w".repeat(43));
    assert.equal(FakeWebSocket.instances[0]!.closeCalls, 1);
    assert.equal(FakeWebSocket.instances.length, 2);
  });

  it("does not connect when the port changes while disabled", async () => {
    const started = await boot(ROLES.GAMEMASTER, { enabled: false });
    started.changePort(31902);
    assert.equal(FakeWebSocket.instances.length, 0);

    const toggled = await boot(ROLES.GAMEMASTER);
    toggled.changeEnabled(false);
    const before = FakeWebSocket.instances.length;
    toggled.changePort(31903);
    assert.equal(FakeWebSocket.instances.length, before);
  });
});
