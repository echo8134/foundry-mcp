import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeHub, DEFAULT_ORIGINS, DEFAULT_PORT } from "./hub.ts";
import { loadToken, tokenPath } from "./token.ts";
import { createMcpServer } from "./tools.ts";

const log = (message: string) => console.error(`foundry-mcp | ${message}`);

function readPort(): number {
  const raw = process.env.FOUNDRY_MCP_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`FOUNDRY_MCP_PORT must be an integer from 0 to 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

function readOrigins(): string[] {
  const raw = process.env.FOUNDRY_MCP_ORIGINS;
  if (raw === undefined || raw === "") return DEFAULT_ORIGINS;
  const origins = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return new URL(entry).origin;
      } catch {
        throw new Error(
          `FOUNDRY_MCP_ORIGINS entry ${JSON.stringify(entry)} is not a URL such as http://localhost:30000`
        );
      }
    });
  if (origins.length === 0) throw new Error("FOUNDRY_MCP_ORIGINS is set but lists no origin");
  return origins;
}

const origins = readOrigins();
log(`allowed origins: ${origins.join(", ")}`);

const tokenFile = tokenPath();
const token = await loadToken(tokenFile, log);
log(`bridge token file: ${tokenFile}`);

const hub = new BridgeHub({ token, port: readPort(), allowedOrigins: origins, log });
await hub.start();

const server = createMcpServer(hub);
await server.connect(new StdioServerTransport());
log("MCP server ready on stdio");

const shutdown = async () => {
  await hub.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.once("end", shutdown);
