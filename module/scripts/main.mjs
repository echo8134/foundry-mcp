import { Bridge } from "./bridge.mjs";
import { PROTOCOL } from "./channel.mjs";
import { METHODS } from "./methods.mjs";

const MODULE_ID = "foundry-mcp";
const DEFAULT_PORT = 31800;
const log = (message, ...rest) => console.log(`foundry-mcp | ${message}`, ...rest);

let bridge = null;

// User#isGM is true from Assistant GM up (common/documents/user.mjs).
const isGamemaster = () => game.user.hasRole(CONST.USER_ROLES.GAMEMASTER);

const restartIfEnabled = () => {
  if (bridge && game.settings.get(MODULE_ID, "enabled")) bridge.restart();
};

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "port", {
    name: "Bridge port",
    hint: "Port of the local foundry-mcp server on 127.0.0.1. Must match FOUNDRY_MCP_PORT of the MCP server.",
    scope: "client",
    config: true,
    type: Number,
    default: DEFAULT_PORT,
    onChange: restartIfEnabled
  });
  game.settings.register(MODULE_ID, "token", {
    name: "Bridge token",
    hint: 'Shared secret of the local foundry-mcp server. Run "npm run -s token" in the foundry-mcp folder yourself, not through an AI agent, and paste the output here. Stored in this browser only.',
    scope: "client",
    config: true,
    type: String,
    default: "",
    onChange: restartIfEnabled
  });
  game.settings.register(MODULE_ID, "enabled", {
    name: "Connect to the local MCP server",
    hint: "Only the Gamemaster's client ever connects.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: (enabled) => {
      if (!isGamemaster()) return;
      if (enabled) (bridge ?? createBridge()).start();
      else bridge?.stop();
    }
  });
});

function describe(problem) {
  switch (problem.kind) {
    case "no-token":
      return 'foundry-mcp: no bridge token is set, so the bridge does not connect. Run "npm run -s token" in the foundry-mcp folder yourself, not through an AI agent, and paste the output into Configure Settings, Foundry MCP (local bridge), Bridge token.';
    case "insecure-context":
      return `foundry-mcp: the bridge needs a secure page and does not connect. Open Foundry via http://localhost:${globalThis.location?.port || 30000} or https.`;
    case "loopback-ip-page":
      return `foundry-mcp: the bridge does not connect from a page opened at 127.0.0.1, because the browser would send the Foundry login cookie to whatever process holds the bridge port. Open Foundry via http://localhost:${globalThis.location?.port || 30000} instead.`;
    case "bad-proof":
      return `foundry-mcp: the process on 127.0.0.1:${problem.port} did not prove it knows the bridge token. Either the token in the module settings is wrong or another program holds the port. The bridge keeps retrying.`;
    case "no-challenge":
      return `foundry-mcp: the process on 127.0.0.1:${problem.port} does not answer like a foundry-mcp server of this version. Restart the MCP server, or check that the port setting matches FOUNDRY_MCP_PORT. The bridge keeps retrying.`;
    case "protocol-mismatch":
      return `foundry-mcp: the MCP server on 127.0.0.1:${problem.port} speaks another protocol than this module (protocol ${PROTOCOL}), so one of the two is outdated. Restart the MCP server, or reload Foundry (F5) if the module was updated. The bridge keeps retrying.`;
  }
}

function createBridge() {
  bridge = new Bridge({
    getPort: () => game.settings.get(MODULE_ID, "port"),
    getPageHost: () => globalThis.location?.hostname,
    getToken: () => game.settings.get(MODULE_ID, "token"),
    getInfo: () => ({
      foundry: game.version,
      module: game.modules.get(MODULE_ID).version,
      world: { id: game.world.id, title: game.world.title },
      user: { id: game.user.id, name: game.user.name }
    }),
    methods: METHODS,
    log,
    warn: (problem) => ui.notifications.warn(describe(problem))
  });
  return bridge;
}

Hooks.once("ready", () => {
  if (!isGamemaster()) return;
  const instance = createBridge();
  if (game.settings.get(MODULE_ID, "enabled")) instance.start();
});
