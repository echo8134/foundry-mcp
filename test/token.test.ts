import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { promisify } from "node:util";
import { loadToken, tokenPath } from "../src/token.ts";

const TOKEN_MODULE = new URL("../src/token.ts", import.meta.url).href;

const dirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "foundry-mcp-token-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("token file", () => {
  it("creates the directory with mode 0700 and the file with mode 0600, holding a 43 character base64url token", async () => {
    const file = join(await tempDir(), "foundry-mcp", "token");
    const logged: string[] = [];
    const token = await loadToken(file, (message) => logged.push(message));
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(join(file, ".."))).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(!logged.some((line) => line.includes(token)), "the token reached the log");
  });

  it("makes every one of a new token's 32 bytes random", async () => {
    const tokens = await Promise.all(
      Array.from({ length: 8 }, async () => Buffer.from(await loadToken(join(await tempDir(), "token")), "base64url"))
    );
    for (const token of tokens) assert.equal(token.length, 32);
    for (let i = 0; i < 32; i++) {
      assert.ok(new Set(tokens.map((token) => token[i])).size > 1, `byte ${i} is the same in 8 new tokens`);
    }
  });

  it("returns the same token on a second call", async () => {
    const file = join(await tempDir(), "token");
    assert.equal(await loadToken(file), await loadToken(file));
  });

  it("gives every concurrent first call the same token", async () => {
    for (let round = 0; round < 20; round++) {
      const file = join(await tempDir(), "token");
      const tokens = await Promise.all(Array.from({ length: 4 }, () => loadToken(file)));
      assert.equal(new Set(tokens).size, 1);
    }
  });

  it("trims a token read from the file", async () => {
    const file = join(await tempDir(), "token");
    const written = "a".repeat(32);
    await writeFile(file, `  ${written}\n\n`, { mode: 0o600 });
    assert.equal(await loadToken(file), written);
  });

  for (const [label, content, message] of [
    ["a short token", "abc123\n", /shorter than 32 characters/],
    ["an empty file", "", /shorter than 32 characters/],
    ["a token with inner whitespace", `${"a".repeat(20)} ${"b".repeat(20)}\n`, /contains whitespace/]
  ] as const) {
    it(`refuses ${label} with an error that names the file and does not echo it`, async () => {
      const file = join(await tempDir(), "token");
      await writeFile(file, content, { mode: 0o600 });
      await assert.rejects(loadToken(file), (error: Error) => {
        assert.ok(error.message.includes(file), error.message);
        assert.match(error.message, message);
        assert.match(error.message, /"npm run -s token" .* yourself, not through an AI agent/);
        if (content.trim()) assert.ok(!error.message.includes(content.trim()), "the error echoes the token");
        return true;
      });
    });
  }

  for (const [who, mode] of [
    ["everyone", 0o644],
    ["only the group", 0o640],
    ["only others", 0o604]
  ] as const) {
    it(`warns about a file that ${who} can read besides the owner, naming it, and still loads it without changing the mode`, async () => {
      const file = join(await tempDir(), "token");
      await writeFile(file, `${"c".repeat(43)}\n`);
      await chmod(file, mode);
      const logged: string[] = [];
      assert.equal(await loadToken(file, (message) => logged.push(message)), "c".repeat(43));
      assert.ok(
        logged.some((line) => /warning/.test(line) && line.includes(file)),
        logged.join("\n")
      );
      assert.equal((await stat(file)).mode & 0o777, mode);
    });
  }

  it("resolves the path from FOUNDRY_MCP_TOKEN_FILE, then an absolute XDG_CONFIG_HOME, then ~/.config", () => {
    assert.equal(tokenPath({ FOUNDRY_MCP_TOKEN_FILE: "/x/t", XDG_CONFIG_HOME: "/cfg" }), "/x/t");
    assert.equal(tokenPath({ XDG_CONFIG_HOME: "/cfg" }), "/cfg/foundry-mcp/token");
    assert.match(tokenPath({ XDG_CONFIG_HOME: "relative" }), /\/\.config\/foundry-mcp\/token$/);
    assert.match(tokenPath({}), /\/\.config\/foundry-mcp\/token$/);
  });

  it("gives every process that starts at the same moment on a fresh path the same token", async () => {
    // Each process imports the module first and then waits for a shared start time, so their first calls overlap.
    const script = `const { loadToken } = await import(process.argv[1]);
      const startAt = Number(process.argv[3]);
      while (Date.now() < startAt) await new Promise((r) => setImmediate(r));
      process.stdout.write(await loadToken(process.argv[2]));`;
    const startAt = String(Date.now() + 500);
    const rounds = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const file = join(await tempDir(), "token");
        const runs = Array.from({ length: 6 }, () =>
          promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, TOKEN_MODULE, file, startAt])
        );
        return (await Promise.all(runs)).map((run) => run.stdout);
      })
    );
    for (const tokens of rounds) {
      assert.match(tokens[0]!, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(new Set(tokens).size, 1, "processes on one path got different tokens");
    }
  });

  it("refuses a token file that belongs to another user and names it", async () => {
    const file = join(await tempDir(), "token");
    await writeFile(file, `${"d".repeat(43)}\n`, { mode: 0o600 });
    const uid = process.getuid!();
    const getuid = mock.method(process as { getuid: () => number }, "getuid", () => uid + 1);
    try {
      await assert.rejects(loadToken(file), (error: Error) => {
        assert.ok(error.message.includes(file), error.message);
        assert.match(error.message, /belongs to another user/);
        return true;
      });
    } finally {
      getuid.mock.restore();
    }
  });

  it("warns when the group or others can write to the token file's directory, naming it, and not about a private one", async () => {
    for (const mode of [0o777, 0o770, 0o707]) {
      const dir = join(await tempDir(), "shared");
      await mkdir(dir);
      await chmod(dir, mode);
      const logged: string[] = [];
      await loadToken(join(dir, "token"), (message) => logged.push(message));
      assert.ok(
        logged.some((line) => /warning/.test(line) && line.includes(`${dir} is writable by other users`)),
        `mode ${mode.toString(8)}: ${logged.join("\n")}`
      );
    }
    const quiet: string[] = [];
    await loadToken(join(await tempDir(), "private", "token"), (message) => quiet.push(message));
    assert.ok(!quiet.some((line) => /warning/.test(line)), quiet.join("\n"));
  });

  for (const [label, target] of [
    [
      "a token file of this user",
      async (dir: string) => {
        const real = join(dir, "real-token");
        await writeFile(real, `${"e".repeat(43)}\n`, { mode: 0o600 });
        return real;
      }
    ],
    ["nothing", async (dir: string) => join(dir, "missing")]
  ] as const) {
    it(`refuses a symbolic link at the token path that points to ${label}, naming it and asking for a regular file`, async () => {
      const dir = await tempDir();
      const file = join(dir, "token");
      await symlink(await target(dir), file);
      const before = await readdir(dir);
      await assert.rejects(loadToken(file), (error: Error) => {
        assert.ok(error.message.includes(file), error.message);
        assert.match(error.message, /symbolic link/);
        assert.match(error.message, /regular file/);
        return true;
      });
      assert.deepEqual(await readdir(dir), before, "something was created beside the link");
    });
  }
});
