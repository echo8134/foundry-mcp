import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";
import puppeteer from "puppeteer-core";
import { WebSocketServer } from "ws";
import { launchFoundryClient } from "../src/foundry-client.ts";

const env = process.env;
const chromium = env.CHROME_PATH ?? "/usr/bin/chromium";
const password = " fixture password ";
const options = { user: "Claude", token: "fixture token", port: 31999 };
beforeEach(() => {
  process.env = { ...env, CHROME_PATH: chromium, FOUNDRY_PASSWORD: password };
});
afterEach(() => {
  process.env = env;
});

async function serve(t: TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return server[Symbol.asyncDispose]();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://localhost:${address.port}`;
}

function launch(url: string, signal = AbortSignal.timeout(15_000)) {
  return launchFoundryClient({ ...options, url, signal });
}

it("rejects a cancelled launch before it starts Chromium", async () => {
  await assert.rejects(launch("http://localhost", AbortSignal.abort(new Error("cancelled"))), /cancelled/);
});

it("rejects unsupported base URLs without including embedded credentials in the error", async () => {
  for (const url of ["ftp://localhost", "invalid", "http://secret:secret@localhost", "http://localhost/?secret"]) {
    await assert.rejects(launch(url), (e: Error) => e.message.includes("FOUNDRY_URL") && !e.message.includes("secret"));
  }
});

it("requires HTTPS outside loopback before reading credentials", async () => {
  delete process.env.FOUNDRY_PASSWORD;
  process.env.FOUNDRY_PASSWORD_FILE = "/dev/null/missing";
  for (const host of ["world.example", "localhost.example", "127.0.0.1.example", "192.168.1.1", "[fd00::1]"]) {
    await assert.rejects(launch(`http://${host}`), /HTTPS/);
  }
  for (const host of ["localhost", "foundry.localhost", "localhost.", "127.0.0.2", "[::1]"]) {
    await assert.rejects(launch(`http://${host}`), /FOUNDRY_PASSWORD_FILE/);
  }
  await assert.rejects(launch("http://127.0.0.1"), /session cookie/);
});

it("names the password file setting if its configured path cannot be read", async () => {
  delete process.env.FOUNDRY_PASSWORD;
  process.env.FOUNDRY_PASSWORD_FILE = "/dev/null/missing";
  await assert.rejects(launch("http://localhost"), /FOUNDRY_PASSWORD_FILE/);
});

it("names the Chromium setting if the executable is missing", async () => {
  process.env.CHROME_PATH = "/dev/null/missing";
  await assert.rejects(launch("http://localhost"), /CHROME_PATH/);
});

const joinForm = '<select name="userId"><option value="gm">Claude</option></select>';
const game = (gm: boolean, active: boolean) => `<script>
  window.CONST = { USER_ROLES: { GAMEMASTER: 4 } };
  window.game = { ready: true, user: { id: 'gm', hasRole: role => ${gm} && role === 4 },
    modules: new Map([['foundry-mcp', { active: ${active} }]]) };
</script>`;

describe("headless login", {
  skip: existsSync(chromium) ? false : "Set CHROME_PATH to run with installed Chromium"
}, () => {
  it("lets only the configured HTTPS origin reach the loopback bridge", { timeout: 15_000 }, async (t) => {
    const browser = await puppeteer.launch({ executablePath: chromium, headless: true, pipe: true });
    t.after(() => browser.close());
    if (Number.parseInt((await browser.version()).split("/")[1] ?? "", 10) < 147) {
      t.skip("Chromium versions before 147 do not gate WebSockets on loopback permission");
      return;
    }
    const bridge = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(bridge, "listening");
    t.after(() => new Promise<void>((resolve) => bridge.close(() => resolve())));
    bridge.on("connection", (socket) => socket.send("connected"));
    const address = bridge.address();
    assert.ok(address && typeof address === "object");

    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const body =
        req.method() === "POST"
          ? '{"status":"success"}'
          : new URL(req.url()).pathname === "/join"
            ? joinForm
            : game(true, true);
      return req.respond({ status: 200, contentType: "text/html", body });
    });
    t.mock.method(puppeteer, "launch", async () => browser);
    t.mock.method(browser, "newPage", async () => page);
    const origin = "https://foundry.invalid";
    await launch(origin);
    const states =
      "Promise.all(['loopback-network', 'local-network'].map(async name => (await navigator.permissions.query({name})).state))";
    assert.deepEqual(await page.evaluate(states), ["granted", "prompt"]);
    const reply = await page.evaluate(
      (port) =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}`);
          socket.onerror = () => reject(new Error("loopback connection failed"));
          socket.onmessage = (event) => {
            socket.close();
            resolve(event.data);
          };
        }),
      address.port
    );
    assert.equal(reply, "connected");
    await page.goto(`${origin}:8443/game`);
    assert.deepEqual(await page.evaluate(states), ["prompt", "prompt"]);
  });

  it("joins under the route prefix, seeds the game settings, and shuts down on abort", {
    timeout: 20_000
  }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "foundry-client-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    delete process.env.FOUNDRY_PASSWORD;
    process.env.FOUNDRY_PASSWORD_FILE = join(dir, "password");
    await writeFile(process.env.FOUNDRY_PASSWORD_FILE, `${password}\r\n`);
    const events = new EventEmitter();
    const report = once(events, "settings");
    const closed = once(events, "closed");
    const frameOrigin = await serve(t, (_req, res) => {
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<script>parent.postMessage(localStorage.getItem('foundry-mcp.token'), '*')</script>");
    });
    let login: unknown;
    const origin = await serve(t, async (req, res) => {
      if (req.url === "/world/game") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `${game(true, true)}<script>window.addEventListener('message', event => {
            fetch('/settings', {method:'POST', body: JSON.stringify([localStorage.getItem('foundry-mcp.port'),
              localStorage.getItem('foundry-mcp.token'), event.data])}).then(r => r.text());
          });</script><iframe src="${frameOrigin}"></iframe>`
        );
      } else if (req.url === "/settings") {
        events.emit("settings", await json(req));
        res.write("waiting");
        res.on("close", () => events.emit("closed"));
      } else if (req.url === "/world/join" && req.method === "POST") {
        login = await json(req);
        res.end(JSON.stringify({ status: "success" }));
      } else if (req.url === "/world/join") {
        res.setHeader("Content-Type", "text/html");
        res.end(joinForm);
      } else res.writeHead(404).end();
    });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const client = await launch(`${origin}/world/`, controller.signal);
    t.after(client.close);
    assert.equal(client.userId, "gm");
    assert.deepEqual(login, { action: "join", userId: "gm", password });
    assert.deepEqual((await report)[0], [JSON.stringify(options.port), JSON.stringify(options.token), null]);
    controller.abort();
    await closed;
  });

  it("closes the browser when cancelled during navigation", { timeout: 15_000 }, async (t) => {
    const controller = new AbortController();
    const events = new EventEmitter();
    const closed = once(events, "closed");
    const origin = await serve(t, (_req, res) => {
      res.once("close", () => events.emit("closed"));
      controller.abort(new Error("login cancelled"));
    });
    await assert.rejects(launch(origin, controller.signal), /login cancelled/);
    await closed;
  });

  for (const [description, form, joined, world, error] of [
    ["occupied user", joinForm.replace("value=", "disabled value="), true, "", /already logged in/],
    ["invalid password in a 200 response", joinForm, false, "", /refused login.*password/],
    ["assistant GM", joinForm, true, game(false, true), /full Gamemaster/],
    ["disabled module", joinForm, true, game(true, false), /Enable the foundry-mcp module/]
  ] as const) {
    it(`reports ${description}`, async (t) => {
      const origin = await serve(t, (req, res) => {
        if (req.url === "/join" && req.method === "POST") {
          res.end(JSON.stringify({ status: joined ? "success" : "failed", message: password }));
        } else {
          res.setHeader("Content-Type", "text/html");
          res.end(req.url === "/join" ? form : world);
        }
      });
      await assert.rejects(launch(origin), (e: Error) => error.test(e.message) && !e.message.includes(password));
    });
  }

  it("does not forward the login POST across a redirect", async (t) => {
    const methods: string[] = [];
    const other = await serve(t, (req, res) => {
      methods.push(req.method!);
      res.end();
    });
    const origin = await serve(t, (req, res) => {
      if (req.method === "POST") res.writeHead(307, { Location: `${other}/join` }).end();
      else res.writeHead(200, { "Content-Type": "text/html" }).end(joinForm);
    });
    await assert.rejects(launch(origin), /fetch|redirect/i);
    assert.deepEqual(methods, []);
  });
});
