import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const PRINT_TOKEN = fileURLToPath(new URL("../src/print-token.ts", import.meta.url));

const scratch = await mkdtemp(join(tmpdir(), "foundry-mcp-main-"));
const TOKEN_FILE = join(scratch, "token");
after(() => rm(scratch, { recursive: true, force: true }));

const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

function run(env: Record<string, string>, script = MAIN) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, FOUNDRY_MCP_PORT: "0", FOUNDRY_MCP_TOKEN_FILE: TOKEN_FILE, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  return { child, exited, out: () => stdout, err: () => stderr };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("main.ts", () => {
  it("keeps stdout for JSON-RPC messages only and logs to stderr", async () => {
    const { child, exited, out, err } = run({});
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    // Whole lines only: the tools/list answer is about as large as a pipe buffer and can arrive in two parts.
    await waitFor(() => out().split("\n").length > 2, "the initialize and tools/list answers");

    const messages = out()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { jsonrpc?: string; id?: number; result?: any });
    for (const message of messages) assert.equal(message.jsonrpc, "2.0");
    const tools = messages.find((m) => m.id === 2)?.result?.tools as { name: string }[];
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "create_documents",
      "create_walls",
      "delete_actors",
      "delete_documents",
      "delete_tokens",
      "delete_walls",
      "ensure_actor",
      "ensure_scene",
      "get_actor",
      "get_document",
      "get_scene",
      "get_scene_image",
      "get_schema",
      "list_actors",
      "list_documents",
      "list_scenes",
      "place_tokens",
      "sync_lights",
      "sync_regions",
      "sync_walls",
      "update_documents",
      "update_tokens"
    ]);
    assert.match(err(), /foundry-mcp \| /);

    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0);
    for (const line of out().split("\n").filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, "2.0");
  });

  it("normalises FOUNDRY_MCP_ORIGINS entries and logs the effective allowlist", async () => {
    const { child, exited, err } = run({
      FOUNDRY_MCP_ORIGINS: " http://localhost:30000/ , https://foundry.test:8443/some/path "
    });
    await waitFor(() => err().includes("MCP server ready"), "startup");
    assert.match(err(), /allowed origins: http:\/\/localhost:30000, https:\/\/foundry\.test:8443\n/);
    child.stdin.end();
    await exited;
  });

  for (const [label, value, message] of [
    ["an entry that is not a URL", "http://localhost:30000,not a url", /entry "not a url" is not a URL/],
    ["a list with no entries", " , ", /lists no origin/]
  ] as const) {
    it(`fails at startup with a clear message for ${label}`, async () => {
      const { exited, err } = run({ FOUNDRY_MCP_ORIGINS: value });
      const [code] = await exited;
      assert.notEqual(code, 0);
      assert.match(err(), message);
    });
  }

  it("npm run token prints the server's token and nothing else on stdout, and the server logs the file but not the token", async () => {
    const file = join(scratch, "printed", "token");
    const printed = run({ FOUNDRY_MCP_TOKEN_FILE: file }, PRINT_TOKEN);
    const [code] = await printed.exited;
    assert.equal(code, 0);
    assert.match(printed.out(), /^[A-Za-z0-9_-]{43}\n$/);
    const token = printed.out().trim();

    const again = run({ FOUNDRY_MCP_TOKEN_FILE: file }, PRINT_TOKEN);
    await again.exited;
    assert.equal(again.out().trim(), token);

    const server = run({ FOUNDRY_MCP_TOKEN_FILE: file });
    await waitFor(() => server.err().includes("MCP server ready"), "startup");
    assert.ok(server.err().includes(file), "the server does not say which token file it uses");
    assert.ok(!server.err().includes(token) && !server.out().includes(token), "the server printed the token");
    server.child.stdin.end();
    await server.exited;
  });

  it("npm run token says in one line that nothing took the token when the program it is piped into has ended", async () => {
    const file = join(scratch, "piped", "token");
    const child = spawn(process.execPath, [PRINT_TOKEN], {
      env: { ...process.env, FOUNDRY_MCP_TOKEN_FILE: file },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(child);
    child.stdout.destroy();
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const [code] = (await once(child, "exit")) as [number | null];
    assert.equal(code, 1);
    assert.match(stderr, /nothing took the token/);
    assert.doesNotMatch(stderr, /Unhandled|\n\s+at /, "a stack trace instead of a message");
    assert.ok(!stderr.includes((await readFile(file, "utf8")).trim()), "the token went to stderr");
  });

  it("refuses to start with a short token and names the file", async () => {
    const file = join(scratch, "short");
    await writeFile(file, "short\n", { mode: 0o600 });
    const { exited, err } = run({ FOUNDRY_MCP_TOKEN_FILE: file });
    const [code] = await exited;
    assert.notEqual(code, 0);
    assert.ok(err().includes(file));
    assert.match(err(), /shorter than 32 characters/);
  });
});
