import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import puppeteer from "puppeteer-core";

const FOUNDRY_URL = (process.env.FOUNDRY_URL ?? "http://localhost:30000").replace(/\/+$/, "");
const FOUNDRY_USER = process.env.FOUNDRY_USER ?? "Gamemaster";
const FOUNDRY_PASSWORD = process.env.FOUNDRY_PASSWORD ?? "";
const CHROME_PATH = process.env.CHROME_PATH ?? "/usr/bin/chromium";
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
// Foundry serves the module from one checkout. This serves the page another, to prove a branch before Foundry has it.
const MODULE_DIR = process.env.FOUNDRY_MCP_MODULE_DIR ? resolve(process.env.FOUNDRY_MCP_MODULE_DIR) : null;
const MODULE_ROUTE = "/modules/foundry-mcp/";

const results = [];
let failed = false;

async function check(name, fn) {
  try {
    await fn();
    results.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL ${name}: ${error.message}`);
    error.reported = true;
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function same(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${what}: expected ${e}, got ${a}`);
}

async function assertRejects(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    assert(pattern.test(error.message), `expected an error matching ${pattern}, got: ${error.message}`);
    return;
  }
  throw new Error(`expected an error matching ${pattern}, but the call succeeded`);
}

function inconclusive(reason) {
  console.log(`inconclusive: ${reason}`);
  process.exit(2);
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function tool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const first = result.content[0];
  if (result.isError) throw new Error(`${name} failed: ${first.text}`);
  return result.content.length === 1 && first.type === "text" ? JSON.parse(first.text) : result.content;
}

async function eventually(condition, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function toolWithRetry(client, name, args, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await tool(client, name, args);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

let status;
try {
  const response = await fetch(`${FOUNDRY_URL}/api/status`);
  status = await response.json();
} catch (error) {
  inconclusive(`cannot reach Foundry at ${FOUNDRY_URL} (${error.message})`);
}
if (status?.active !== true) inconclusive(`no world is active at ${FOUNDRY_URL}`);
console.log(`PASS foundry reports an active world (${status.world ?? "unnamed"}, version ${status.version ?? "?"})`);
// The test creates and deletes documents, so it runs only in a world kept for it.
const TEST_WORLD = process.env.FOUNDRY_WORLD ?? "mcp-test";
if (status.world !== TEST_WORLD) {
  inconclusive(
    `the active world is "${status.world}", not the test world "${TEST_WORLD}". Launch "${TEST_WORLD}", or set FOUNDRY_WORLD to the world this test may write to.`
  );
}

const port = await freePort();
const tokenDir = await mkdtemp(join(tmpdir(), "foundry-mcp-e2e-"));
const tokenFile = join(tokenDir, "token");
const token = randomBytes(32).toString("base64url");
await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
const client = new Client({ name: "foundry-mcp-e2e", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [MAIN],
  env: {
    ...process.env,
    FOUNDRY_MCP_PORT: String(port),
    FOUNDRY_MCP_ORIGINS: new URL(FOUNDRY_URL).origin,
    FOUNDRY_MCP_TOKEN_FILE: tokenFile
  },
  stderr: "inherit"
});
const pageLog = [];
const servedFromModuleDir = new Set();
let browser;
let page;
let sceneId;

try {
  await client.connect(transport);

  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist"
    ]
  });
  page = await browser.newPage();
  if (MODULE_DIR) {
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const { pathname } = new URL(request.url());
      if (!pathname.startsWith(MODULE_ROUTE) || !pathname.endsWith(".mjs")) return request.continue();
      let relative;
      try {
        relative = decodeURIComponent(pathname.slice(MODULE_ROUTE.length));
      } catch {
        return request.respond({ status: 400 });
      }
      const file = resolve(MODULE_DIR, relative);
      if (!file.startsWith(MODULE_DIR + sep)) return request.respond({ status: 403 });
      try {
        await request.respond({ status: 200, contentType: "text/javascript", body: await readFile(file) });
        servedFromModuleDir.add(pathname.slice(MODULE_ROUTE.length));
      } catch {
        await request.respond({ status: 404 });
      }
    });
  }
  page.on("console", (message) => {
    if (!message.text().includes("foundry-mcp |")) return;
    pageLog.push(message.text());
    console.error(`[page] ${message.text()}`);
  });
  // ClientSettings#setClient stores client settings in localStorage as JSON; the port string is already valid JSON.
  await page.evaluateOnNewDocument(
    (p, t) => {
      localStorage.setItem("foundry-mcp.port", p);
      localStorage.setItem("foundry-mcp.token", JSON.stringify(t));
    },
    String(port),
    token
  );

  await check("logged in as the Gamemaster and the game is ready", async () => {
    await page.goto(`${FOUNDRY_URL}/join`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('select[name="userId"] option[value]:not([value=""])', { timeout: 30000 });
    const users = await page.$$eval('select[name="userId"] option', (options) =>
      options.map((o) => ({ id: o.value, name: o.textContent.trim(), disabled: o.disabled }))
    );
    const user = users.find((u) => u.name === FOUNDRY_USER);
    assert(user, `user "${FOUNDRY_USER}" not found among ${users.map((u) => u.name).join(", ")}`);
    assert(!user.disabled, `user "${FOUNDRY_USER}" is already logged in elsewhere`);
    const joined = await page.evaluate(
      async (userId, password) => {
        const response = await fetch("/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "join", userId, password })
        });
        return { ok: response.ok, body: await response.text() };
      },
      user.id,
      FOUNDRY_PASSWORD
    );
    assert(joined.ok, `join request failed: ${joined.body}`);
    await page.goto(`${FOUNDRY_URL}/game`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => globalThis.game?.ready === true, { timeout: 180000 });
  });

  await check("the foundry-mcp module is active", async () => {
    const active = await page.evaluate(() => game.modules.get("foundry-mcp")?.active === true);
    assert(
      active,
      "game.modules.get('foundry-mcp')?.active is not true (is the module linked into Data/modules and enabled in the world?)"
    );
  });

  if (MODULE_DIR) {
    await check(`the page runs the module scripts from ${MODULE_DIR}`, async () => {
      assert(
        servedFromModuleDir.has("scripts/main.mjs"),
        `scripts/main.mjs was not requested, served were: ${[...servedFromModuleDir].join(", ") || "none"}`
      );
    });
  }

  await check("temporary scene created", async () => {
    sceneId = await page.evaluate(async () => {
      const scene = await foundry.documents.Scene.create({
        name: "foundry-mcp e2e",
        width: 1000,
        height: 800,
        padding: 0.25,
        grid: { type: 1, size: 100, distance: 5, units: "ft" }
      });
      return scene.id;
    });
    assert(sceneId, "scene was not created");
    await page.evaluate(async (id) => {
      const scene = game.scenes.get(id);
      const [level] = scene.levels.contents;
      await scene.updateEmbeddedDocuments("Level", [{ _id: level.id, "background.src": "ui/parchment.jpg" }]);
    }, sceneId);
  });

  await check("get_scene reports frame 1000x800 and no walls", async () => {
    const scene = await toolWithRetry(client, "get_scene", { sceneId });
    same(scene.frame, { width: 1000, height: 800 }, "frame");
    same(scene.walls, [], "walls");
    assert(scene.background.src?.includes("parchment"), `background src was ${scene.background.src}`);
  });

  await check("the page logged that the server opened its sealed proof under the token", async () => {
    assert(
      pageLog.some((line) => line.includes("proved it knows the token")),
      "no handshake success line in the page log"
    );
  });

  let ids;
  await check("create_walls creates 5 walls from a closed rectangle and a door", async () => {
    const created = await tool(client, "create_walls", {
      sceneId,
      frame: { width: 100, height: 80 },
      paths: [
        {
          points: [
            [10, 10],
            [90, 10],
            [90, 70],
            [10, 70]
          ],
          closed: true
        },
        {
          points: [
            [50, 30],
            [50, 50]
          ],
          kind: "door"
        }
      ]
    });
    same(
      [created.created, created.requested, created.ids.length, created.skipped],
      [5, 5, 5, 0],
      "created, requested, ids, skipped"
    );
    same([created.sceneId, created.sceneName], [sceneId, "foundry-mcp e2e"], "target scene in the result");
    ids = created.ids;
  });

  await check("the page sees the expected canvas coordinates and a door", async () => {
    const walls = await page.evaluate((id) => {
      const scene = game.scenes.get(id);
      return scene.walls.map((w) => ({ c: [...w.c], door: w.door }));
    }, sceneId);
    const key = (c) => c.join(",");
    const expected = [
      "400,300,1200,300",
      "1200,300,1200,900",
      "1200,900,400,900",
      "400,900,400,300",
      "800,500,800,700"
    ];
    same(walls.map((w) => key(w.c)).sort(), [...expected].sort(), "wall coordinates");
    const doors = walls.filter((w) => w.door === 1).map((w) => key(w.c));
    same(doors, ["800,500,800,700"], "door walls");
  });

  await check("get_scene returns the walls in scene pixels with kinds", async () => {
    const scene = await tool(client, "get_scene", { sceneId });
    const summary = scene.walls.map((w) => `${w.kind}:${w.c.join(",")}`).sort();
    same(
      summary,
      [
        "door:500,300,500,500",
        "wall:100,100,900,100",
        "wall:100,700,100,100",
        "wall:900,100,900,700",
        "wall:900,700,100,700"
      ],
      "walls"
    );
  });

  const decode = (image, fractions) =>
    page.evaluate(
      async (mimeType, data, points) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:${mimeType};base64,${data}`)).blob());
        const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = surface.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        const pixels = points.map(([fx, fy]) => {
          const x = Math.round(bitmap.width * fx);
          const y = Math.round(bitmap.height * fy);
          return [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
        });
        return { width: bitmap.width, height: bitmap.height, pixels };
      },
      image.mimeType,
      image.data,
      fractions
    );

  const imageContent = (content) => {
    const image = content.find((c) => c.type === "image");
    const text = content.find((c) => c.type === "text");
    assert(image && text, "expected one image block and one text block");
    return { image, ...JSON.parse(text.text) };
  };

  await check("get_scene_image without walls reports a background and shows the map, not the flat colour", async () => {
    const { image, frame, background } = imageContent(await tool(client, "get_scene_image", { sceneId }));
    assert(background === true, `background was ${background}`);
    const flat = await page.evaluate((id) => {
      const color = game.scenes.get(id).initialLevel.background.color;
      return foundry.utils.Color.from(color).rgb.map((v) => Math.round(v * 255));
    }, sceneId);
    const decoded = await decode(image, [
      [0.25, 0.25],
      [0.7, 0.2],
      [0.3, 0.8]
    ]);
    same({ width: decoded.width, height: decoded.height }, frame, "decoded size vs frame");
    for (const pixel of decoded.pixels) {
      const distance = pixel.reduce((sum, value, i) => sum + Math.abs(value - flat[i]), 0);
      assert(
        distance >= 40,
        `pixel rgb(${pixel}) is too close to the flat background rgb(${flat}): the map image is missing`
      );
    }
  });

  await check(
    "get_scene_image with showWalls returns an image matching its frame, with the wall in red and the door in blue",
    async () => {
      const { image, frame } = imageContent(await tool(client, "get_scene_image", { sceneId, showWalls: true }));
      const decoded = await decode(image, [
        [0.5, 0.125],
        [0.5, 0.5]
      ]);
      same({ width: decoded.width, height: decoded.height }, frame, "decoded size vs frame");
      assert(
        Math.abs(decoded.width / decoded.height - 1000 / 800) < 0.01,
        `aspect ratio ${decoded.width}:${decoded.height}`
      );
      const [[r, g, b], [dr, dg, db]] = decoded.pixels;
      assert(r > 180 && g < 110 && b < 110, `no red wall line at the top wall position, pixel was rgb(${r},${g},${b})`);
      assert(
        db > 180 && dr < 120 && db - dr > 100,
        `no blue door line at the door position, pixel was rgb(${dr},${dg},${db})`
      );
    }
  );

  await check("delete_walls deletes 5 and the page confirms zero walls", async () => {
    const deleted = await tool(client, "delete_walls", { sceneId, ids });
    same(deleted, { deleted: 5, sceneId, sceneName: "foundry-mcp e2e" }, "delete result");
    const remaining = await page.evaluate((id) => game.scenes.get(id).walls.size, sceneId);
    same(remaining, 0, "walls left in the page");
  });

  await check("delete_walls with all: true removes a freshly created wall", async () => {
    const created = await tool(client, "create_walls", {
      sceneId,
      paths: [
        {
          points: [
            [100, 100],
            [300, 100]
          ]
        }
      ]
    });
    same(created.created, 1, "created");
    same(await page.evaluate((id) => game.scenes.get(id).walls.size, sceneId), 1, "walls in the page before");
    const deleted = await tool(client, "delete_walls", { sceneId, all: true });
    same(deleted.deleted, 1, "deleted");
    same(await page.evaluate((id) => game.scenes.get(id).walls.size, sceneId), 0, "walls in the page after");
  });

  const sceneFolder = `foundry-mcp e2e ${Date.now()}`;
  const path = [sceneFolder, "inner"];
  const sceneInput = {
    name: "foundry-mcp e2e ensured",
    folder: path,
    background: { src: "ui/parchment.jpg" },
    width: 1000,
    height: 800,
    grid: { type: "square", size: 100, distance: 5, units: "ft" },
    navName: "e2e",
    globalLight: true,
    weather: "rain"
  };
  const pageScene = (id) =>
    page.evaluate((sid) => {
      const scene = game.scenes.get(sid);
      return {
        folder: scene.folder?.name,
        parent: scene.folder?.folder?.name,
        active: scene.active,
        thumb: scene.thumb,
        gridSize: scene.grid.size,
        globalLight: scene.environment.globalLight.enabled,
        weather: scene.weather,
        src: scene.initialLevel.background.src,
        walls: scene.walls.map((w) => ({ id: w.id, ds: w.ds, managed: w.flags["foundry-mcp"]?.managed === true }))
      };
    }, id);
  try {
    let ensuredId;
    await check("ensure_scene creates the folders and a scene that is not active and has a thumbnail", async () => {
      const result = await tool(client, "ensure_scene", sceneInput);
      assert(result.created === true, "created was not true");
      same(result.folder, path, "folder path");
      same(result.name, sceneInput.name, "name");
      ensuredId = result.id;
      const seen = await pageScene(ensuredId);
      same(
        [seen.folder, seen.parent, seen.active, seen.gridSize],
        ["inner", sceneFolder, false, 100],
        "folder, parent, active, grid size"
      );
      same(
        [seen.globalLight, seen.weather, seen.src.includes("parchment")],
        [true, "rain", true],
        "global light, weather, background"
      );
      assert(seen.thumb, "the scene has no thumbnail");
    });

    await check("ensure_scene run again with the same input changes nothing", async () => {
      const before = await pageScene(ensuredId);
      const result = await tool(client, "ensure_scene", sceneInput);
      same([result.id, result.created, result.changed, result.unapplied], [ensuredId, false, [], []], "second result");
      same((await pageScene(ensuredId)).thumb, before.thumb, "thumbnail untouched");
    });

    await check("ensure_scene updates only the field that differs", async () => {
      const result = await tool(client, "ensure_scene", { ...sceneInput, navName: "e2e two" });
      same([result.id, result.changed, result.unapplied], [ensuredId, ["navName"], []], "update result");
    });

    await check("list_scenes narrowed to the folder returns the scene and both folders", async () => {
      const listed = await tool(client, "list_scenes", { folder: [sceneFolder] });
      same(
        listed.folders.map((f) => f.path),
        [[sceneFolder], path],
        "folders"
      );
      same(
        listed.scenes.map((s) => s.id),
        [ensuredId],
        "scenes"
      );
      const [entry] = listed.scenes;
      same(
        [entry.navName, entry.folder, entry.width, entry.height, entry.grid.size, entry.walls],
        ["e2e two", path, 1000, 800, 100, { total: 0, managed: 0 }],
        "scene entry"
      );
    });

    await check("sync_walls replaces bridge-made walls, keeps a hand-drawn wall and sets the door state", async () => {
      await page.evaluate(
        (sid) => game.scenes.get(sid).createEmbeddedDocuments("Wall", [{ c: [0, 0, 100, 0] }]),
        ensuredId
      );
      const paths = [
        {
          points: [
            [10, 10],
            [90, 10],
            [90, 70],
            [10, 70]
          ],
          closed: true
        },
        {
          points: [
            [50, 30],
            [50, 50]
          ],
          kind: "door",
          state: "locked"
        }
      ];
      const first = await tool(client, "sync_walls", { sceneId: ensuredId, frame: { width: 100, height: 80 }, paths });
      same([first.deleted, first.created], [0, 5], "first sync");
      const again = await tool(client, "sync_walls", { sceneId: ensuredId, frame: { width: 100, height: 80 }, paths });
      same([again.deleted, again.created], [5, 5], "second sync");
      const walls = (await pageScene(ensuredId)).walls;
      same(
        [walls.length, walls.filter((w) => w.managed).length, walls.filter((w) => w.ds === 2).length],
        [6, 5, 1],
        "walls, managed, locked"
      );
      const listed = await tool(client, "list_scenes", { folder: path });
      same(listed.scenes[0].walls, { total: 6, managed: 5 }, "list_scenes wall counts");
      const emptied = await tool(client, "sync_walls", { sceneId: ensuredId, paths: [] });
      same([emptied.deleted, emptied.created, (await pageScene(ensuredId)).walls.length], [5, 0, 1], "emptied");
    });

    await check(
      "sync_lights, the lights in get_scene and list_scenes, and showLights on the ensured scene",
      async () => {
        const pageLights = () =>
          page.evaluate(
            (sid) =>
              game.scenes.get(sid).lights.map((l) => ({
                id: l.id,
                x: l.x,
                y: l.y,
                name: l.name,
                bright: l.config.bright,
                dim: l.config.dim,
                color: l.config.color?.css ?? null,
                animation: l.config.animation.type,
                negative: l.config.negative,
                managed: l.flags["foundry-mcp"]?.managed === true
              })),
            ensuredId
          );
        const origin = await page.evaluate((sid) => {
          const { sceneX, sceneY } = game.scenes.get(sid).dimensions;
          return [sceneX, sceneY];
        }, ensuredId);
        await page.evaluate(
          (sid) =>
            game.scenes.get(sid).createEmbeddedDocuments("AmbientLight", [{ x: 100, y: 100, config: { dim: 5 } }]),
          ensuredId
        );
        const frame = { width: 100, height: 80 };
        const lights = [
          { at: [50, 40], bright: 10, dim: 20, color: "#ff8800", animation: { type: "torch" }, name: "e2e torch" },
          { at: [10, 10], dim: 10, negative: true }
        ];
        const first = await tool(client, "sync_lights", { sceneId: ensuredId, frame, lights });
        same([first.deleted, first.created, first.ids.length, first.sceneId], [0, 2, 2, ensuredId], "first sync");
        const again = await tool(client, "sync_lights", { sceneId: ensuredId, frame, lights });
        same([again.deleted, again.created], [2, 2], "second sync");

        const seen = await pageLights();
        same(seen.length, 3, "lights on the scene, one of them by hand");
        same(seen.filter((l) => l.managed).length, 2, "managed lights");
        const torch = seen.find((l) => l.name === "e2e torch");
        same([torch.x, torch.y], [origin[0] + 500, origin[1] + 400], "torch position in canvas pixels");
        same([torch.bright, torch.dim, torch.color, torch.animation], [10, 20, "#ff8800", "torch"], "torch settings");
        assert(seen.find((l) => l.negative)?.managed === true, "the darkness source was not made, or not flagged");

        const read = await tool(client, "get_scene", { sceneId: ensuredId });
        same(read.lights.length, 3, "lights in get_scene");
        const readTorch = read.lights.find((l) => l.name === "e2e torch");
        same(
          [readTorch.at, readTorch.bright, readTorch.dim, readTorch.managed],
          [[500, 400], 10, 20, true],
          "torch as read"
        );
        same(read.lights.filter((l) => !l.managed).length, 1, "hand-placed lights in get_scene");
        same(
          (await tool(client, "list_scenes", { folder: path })).scenes[0].lights,
          { total: 3, managed: 2 },
          "list_scenes light counts"
        );

        const content = (lightList) =>
          lightList.map(({ id, ...light }) => light).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const handId = read.lights.find((l) => !l.managed).id;
        const trip = await tool(client, "sync_lights", { sceneId: ensuredId, lights: read.lights });
        same([trip.deleted, trip.created], [2, 2], "round trip counts");
        const back = await tool(client, "get_scene", { sceneId: ensuredId });
        same(content(back.lights), content(read.lights), "lights after the round trip");
        same(back.lights.find((l) => !l.managed).id, handId, "the hand-placed light is the same document");

        const { image, frame: imageFrame } = imageContent(
          await tool(client, "get_scene_image", { sceneId: ensuredId, showLights: true })
        );
        same(imageFrame, { width: 1000, height: 800 }, "image frame");
        const decoded = await decode(image, [
          [0.5, 0.5],
          [0.1, 0.125]
        ]);
        const [[lr, lg, lb], [dr, dg, db]] = decoded.pixels;
        assert(lr > 200 && lg > 150 && lb < 80, `no light marker at the torch, pixel was rgb(${lr},${lg},${lb})`);
        assert(
          db > 200 && dr > 150 && dg < 130,
          `no darkness marker at the darkness source, pixel was rgb(${dr},${dg},${db})`
        );

        await assertRejects(
          tool(client, "sync_lights", {
            sceneId: ensuredId,
            lights: [{ at: [1, 1], dim: 5, animation: { type: "no-such-animation" } }]
          }),
          /Unknown animation/
        );
        same((await pageLights()).length, 3, "lights after a refused sync");
        await assertRejects(
          tool(client, "sync_lights", { sceneId: ensuredId, lights: [{ at: [1, 1], dim: 5, managed: false }] }),
          /were left out as hand-placed.*so nothing was changed/
        );
        same((await pageLights()).length, 3, "lights after a sync whose given lights were all left out");

        const emptied = await tool(client, "sync_lights", { sceneId: ensuredId, lights: [] });
        same(
          [emptied.deleted, emptied.created, (await pageLights()).length],
          [2, 0, 1],
          "emptied, the hand-placed light stays"
        );
      }
    );

    await check(
      "ensure_scene keeps the grid size when the map is widened, moves the placed walls with it, and a rerun writes nothing",
      async () => {
        const wider = { ...sceneInput, navName: "e2e two", width: 1200 };
        const wallLength = async () => {
          const [wall] = (await tool(client, "get_scene", { sceneId: ensuredId })).walls;
          return wall.c[2] - wall.c[0];
        };
        const before = await wallLength();
        const result = await tool(client, "ensure_scene", wider);
        same([result.changed, result.unapplied], [["width"], []], "widened");
        same((await pageScene(ensuredId)).gridSize, 100, "grid size after widening");
        same(await wallLength(), Math.round(before * 1.2), "the hand-drawn wall scaled with the map");
        const again = await tool(client, "ensure_scene", wider);
        same([again.changed, again.unapplied], [[], []], "rerun");
        same((await pageScene(ensuredId)).gridSize, 100, "grid size after the rerun");
      }
    );

    await check(
      "ensure_scene with a shift only keeps the walls on the map, reports the shift, and a rerun writes nothing; a shift beyond the padding is refused",
      async () => {
        const read = () => tool(client, "get_scene", { sceneId: ensuredId });
        const before = await read();
        assert(before.walls.length > 0, "the scene has no wall to keep in place");
        const result = await tool(client, "ensure_scene", { sceneId: ensuredId, shiftX: 30, shiftY: -20 });
        same([result.changed, result.unapplied], [["shiftX", "shiftY"], []], "shift result");
        const after = await read();
        same([after.shiftX, after.shiftY], [30, -20], "reported shift");
        same(
          after.walls.map((w) => w.c),
          before.walls.map((w) => w.c),
          "wall frame coordinates"
        );
        const again = await tool(client, "ensure_scene", { sceneId: ensuredId, shiftX: 30, shiftY: -20 });
        same([again.changed, again.unapplied], [[], []], "rerun");

        const flat = { ...sceneInput, name: "foundry-mcp e2e flat", padding: 0 };
        await assertRejects(
          tool(client, "ensure_scene", { ...flat, shiftX: 30 }),
          /shiftX 30 would leave 30 px of the map outside the canvas.*shiftX can be from 0 to 0/
        );
        const created = await tool(client, "ensure_scene", flat);
        await assertRejects(
          tool(client, "ensure_scene", { sceneId: created.id, shiftX: 30 }),
          /shiftX 30 would leave 30 px.*shiftX can be from 0 to 0/
        );
        same(
          (await tool(client, "get_scene", { sceneId: created.id })).shiftX,
          0,
          "shift of the padding 0 scene after the refusal"
        );
      }
    );
  } finally {
    await page
      .evaluate(async (name) => {
        const top = game.folders.find((f) => f.type === "Scene" && f.name === name && !f.folder);
        await top?.delete({ deleteSubfolders: true, deleteContents: true });
      }, sceneFolder)
      .catch((e) => console.log(`cleanup: folder delete failed: ${e.message}`));
  }

  const actorName = `foundry-mcp e2e goblin ${Date.now()}`;
  let made;
  try {
    await check("an npc with one item and one friendly token of it are created in the page", async () => {
      made = await page.evaluate(
        async (id, name) => {
          const actor = await Actor.implementation.create({
            name,
            type: "npc",
            system: { attributes: { hp: { value: 7, max: 7 } }, details: { cr: 0.25 } },
            items: [{ name: "e2e scimitar", type: "weapon" }]
          });
          const scene = game.scenes.get(id);
          const tokenData = (await actor.getTokenDocument({ x: 400, y: 300, disposition: 1 })).toObject();
          const [token] = await scene.createEmbeddedDocuments("Token", [tokenData]);
          return { actorId: actor.id, itemId: actor.items.contents[0].id, tokenId: token.id, linked: token.actorLink };
        },
        sceneId,
        actorName
      );
      assert(made?.actorId && made.tokenId, `nothing was made: ${JSON.stringify(made)}`);
    });

    await check("list_actors finds the npc by part of its name, with its challenge rating", async () => {
      const result = await tool(client, "list_actors", { name: actorName.toUpperCase(), type: "npc" });
      same(
        result.actors.map((a) => [a.id, a.name, a.type, a.cr, a.managed]),
        [[made.actorId, actorName, "npc", 0.25, false]],
        "listed actors"
      );
      same([result.total, result.truncated], [1, false], "total and truncated");
    });

    await check(
      "get_actor returns stored system data, derived numbers, the item asked for and the placed token",
      async () => {
        const actor = await tool(client, "get_actor", { actor: made.actorId, items: [made.itemId] });
        same([actor.uuid, actor.type, actor.system.details.cr], [`Actor.${made.actorId}`, "npc", 0.25], "stored data");
        same([actor.derived.hp?.value, actor.derived.hp?.max], [7, 7], "derived hp");
        assert(Number.isFinite(actor.derived.ac), `derived ac was ${actor.derived.ac}`);
        assert(
          Number.isFinite(actor.derived.abilities?.str?.save),
          `str save was ${actor.derived.abilities?.str?.save}`
        );
        assert(
          Number.isFinite(actor.derived.skills?.prc?.passive),
          `passive perception was ${actor.derived.skills?.prc}`
        );
        same(
          actor.items.map((i) => [i.id, i.name, i.type]),
          [[made.itemId, "e2e scimitar", "weapon"]],
          "items"
        );
        same([actor.itemData[0]._id, actor.itemData[0].type], [made.itemId, "weapon"], "item data");
        same(
          actor.tokens,
          [{ sceneId, sceneName: "foundry-mcp e2e", tokenId: made.tokenId, name: actorName }],
          "tokens"
        );
      }
    );

    await check("get_actor reads the token's own actor by its UUID, with only that token", async () => {
      const uuid = made.linked
        ? `Actor.${made.actorId}`
        : `Scene.${sceneId}.Token.${made.tokenId}.Actor.${made.actorId}`;
      const actor = await tool(client, "get_actor", { actor: uuid });
      same(
        [actor.uuid, actor.name, actor.tokens.map((t) => t.tokenId)],
        [uuid, actorName, [made.tokenId]],
        "token actor"
      );
    });

    await check(
      "get_scene lists the token with its centre in scene pixels and the hit points of its actor",
      async () => {
        const scene = await tool(client, "get_scene", { sceneId });
        const token = scene.tokens.find((t) => t.id === made.tokenId);
        assert(token, `token ${made.tokenId} missing from ${JSON.stringify(scene.tokens)}`);
        same(
          [token.actorId, token.at, token.width, token.height, token.disposition, token.hidden, token.hp],
          [made.actorId, [150, 150], 1, 1, 1, false, { value: 7, max: 7 }],
          "token"
        );
        const listed = (await tool(client, "list_scenes", {})).scenes.find((s) => s.id === sceneId);
        same(listed.tokens, { total: 1, managed: 0 }, "token counts in list_scenes");
      }
    );

    await check("get_scene_image with showTokens outlines the friendly token in green", async () => {
      const { image, frame } = imageContent(await tool(client, "get_scene_image", { sceneId, showTokens: true }));
      same(frame, { width: 1000, height: 800 }, "frame");
      const [[r, g, b]] = (await decode(image, [[0.2, 0.1875]])).pixels;
      assert(
        g > 160 && r < 140 && b < 150,
        `no green outline at the token's right edge, pixel was rgb(${r},${g},${b})`
      );
    });

    await check("get_schema reads the installed dnd5e: types, a field tree, a subtree and a key table", async () => {
      const { types } = await tool(client, "get_schema", { document: "Actor" });
      assert(types.includes("npc") && types.includes("character") && !types.includes("base"), `actor types ${types}`);
      const npc = await tool(client, "get_schema", { document: "Actor", type: "npc" });
      same([npc.fields.items, npc.fields.effects], ["collection of Item", "collection of ActiveEffect"], "collections");
      assert(typeof npc.fields.system.abilities?.$map === "object", "system.abilities is not a map");
      const cr = await tool(client, "get_schema", { document: "Actor", type: "npc", path: "system.details.cr" });
      assert(/^number/.test(cr.fields), `system.details.cr was ${JSON.stringify(cr.fields)}`);
      const weapon = await tool(client, "get_schema", { document: "Item", type: "weapon", path: "system.activities" });
      same(weapon.fields, "collection of Activity", "weapon activities");
      const token = await tool(client, "get_schema", { document: "Token", path: "disposition" });
      assert(/one of -2\|-1\|0\|1/.test(token.fields), `token disposition was ${token.fields}`);
      const activities = await tool(client, "get_schema", { document: "Activity" });
      assert(activities.types.includes("attack"), `activity types ${activities.types}`);
      const attack = await tool(client, "get_schema", { document: "Activity", type: "attack" });
      assert(typeof attack.fields.attack === "object", "the attack activity has no attack fields");
      const { keys } = await tool(client, "get_schema", { document: "Config", type: "abilities" });
      assert(typeof keys.str === "string" && !keys.str.startsWith("DND5E."), `str label was ${keys.str}`);
    });

    const tokenCount = () => page.evaluate((id) => game.scenes.get(id).tokens.size, sceneId);
    let placed;
    await check("place_tokens refuses an unknown token field and writes nothing", async () => {
      const before = await tokenCount();
      await assertRejects(
        tool(client, "place_tokens", {
          sceneId,
          tokens: [
            { actor: made.actorId, at: [250, 350] },
            { actor: made.actorId, at: [450, 350], hiden: true }
          ]
        }),
        /tokens\[1\]: No such field: hiden/
      );
      same(await tokenCount(), before, "tokens in the page");
    });

    await check("place_tokens places two tokens of the npc with their centres on the cells asked for", async () => {
      const result = await tool(client, "place_tokens", {
        sceneId,
        tokens: [
          { actor: made.actorId, at: [250, 350] },
          { actor: made.actorId, at: [440, 360] }
        ]
      });
      same(
        [result.created, result.requested, result.tokens.map((t) => [t.actorId, t.at, t.unapplied])],
        [
          2,
          2,
          [
            [made.actorId, [250, 350], undefined],
            [made.actorId, [450, 350], undefined]
          ]
        ],
        "placed"
      );
      placed = result.tokens.map((t) => t.id);
      const inPage = await page.evaluate(
        (id, ids) =>
          ids.map((tokenId) => {
            const token = game.scenes.get(id).tokens.get(tokenId);
            return [
              token.x,
              token.y,
              token.flags["foundry-mcp"]?.managed,
              token.level === game.scenes.get(id).initialLevel.id,
              token.sort
            ];
          }),
        sceneId,
        placed
      );
      same(
        inPage,
        [
          [500, 500, true, true, 1],
          [700, 500, true, true, 2]
        ],
        "tokens in the page, each stacked above the ones before it"
      );
    });

    await check(
      "update_tokens moves one token as a teleport and hides the other, and a repeat writes nothing",
      async () => {
        const args = {
          sceneId,
          tokens: [
            { id: placed[0], at: [650, 550] },
            { id: placed[1], hidden: true }
          ]
        };
        const result = await tool(client, "update_tokens", args);
        same(
          result.tokens,
          [
            { id: placed[0], at: [650, 550], changed: ["at"] },
            { id: placed[1], at: [450, 350], changed: ["hidden"] }
          ],
          "updated"
        );
        const inPage = await page.evaluate(
          (id, ids) => ids.map((tokenId) => game.scenes.get(id).tokens.get(tokenId)).map((t) => [t.x, t.y, t.hidden]),
          sceneId,
          placed
        );
        same(
          inPage,
          [
            [900, 700, false],
            [700, 500, true]
          ],
          "tokens in the page"
        );
        const again = await tool(client, "update_tokens", args);
        same(
          again.tokens.map((t) => t.changed),
          [[], []],
          "changed on the repeat"
        );
      }
    );

    await check(
      "the token model's refusals stop a write, and so does a value Foundry would store as something else",
      async () => {
        const before = await tokenCount();
        await assertRejects(
          tool(client, "place_tokens", { sceneId, tokens: [{ actor: made.actorId, at: [250, 350], disposition: 5 }] }),
          /tokens\[0\]: Foundry's token model refuses the data/
        );
        same(await tokenCount(), before, "tokens in the page after the refused placement");
        await assertRejects(
          tool(client, "update_tokens", {
            sceneId,
            tokens: [
              { id: placed[0], hidden: true },
              { id: placed[1], light: { dim: "wide" } }
            ]
          }),
          /tokens\[1\]: Foundry's token model refuses the data/
        );
        same(
          await page.evaluate((id, tokenId) => game.scenes.get(id).tokens.get(tokenId).hidden, sceneId, placed[0]),
          false,
          "hidden after the refused update"
        );
        const stored = () =>
          page.evaluate(
            (id, ids) =>
              ids.map((tokenId) => {
                const source = game.scenes.get(id).tokens.get(tokenId)._source;
                return [source.rotation, source.hidden, source.flags["foundry-mcp"]];
              }),
            sceneId,
            placed
          );
        const untouched = await stored();
        same(
          untouched,
          [
            [0, false, { managed: true }],
            [0, true, { managed: true }]
          ],
          "stored before the refused values"
        );
        await assertRejects(
          tool(client, "update_tokens", { sceneId, tokens: [{ id: placed[0], rotation: 370 }] }),
          /tokens\[0\]: Foundry would not store these values as given: rotation: 370 would be stored as 10\./
        );
        await assertRejects(
          tool(client, "update_tokens", { sceneId, tokens: [{ id: placed[1], hidden: "yes" }] }),
          /hidden: "yes" would be stored as false\..*Nothing was written\.$/
        );
        await assertRejects(
          tool(client, "update_tokens", { sceneId, tokens: [{ id: placed[1], light: null }] }),
          /light: null would be stored as \{/
        );
        same(await stored(), untouched, "stored after the refused values: the hidden token is still hidden");
        const colour = () =>
          page.evaluate(
            (id, tokenId) => game.scenes.get(id).tokens.get(tokenId)._source.light.color,
            sceneId,
            placed[0]
          );
        const colourBefore = await colour();
        await assertRejects(
          tool(client, "update_tokens", { sceneId, tokens: [{ id: placed[0], light: { color: "blue" } }] }),
          /light\.color: "blue" would be stored as "#00000b"\..*Nothing was written\.$/
        );
        same(await colour(), colourBefore, "light colour after the refused colour name");
      }
    );

    await check("update_tokens refuses keys Foundry would expand or read as an instruction", async () => {
      for (const flags of [
        { "foundry-mcp.managed": false },
        { "-=foundry-mcp": null },
        { "==foundry-mcp": { managed: false } }
      ]) {
        await assertRejects(
          tool(client, "update_tokens", { sceneId, tokens: [{ id: placed[0], flags }] }),
          /tokens\[0\]: Not a plain key: "[^"]*foundry-mcp[^"]*" in flags\./
        );
      }
      await assertRejects(
        tool(client, "place_tokens", {
          sceneId,
          tokens: [{ actor: made.actorId, at: [250, 350], flags: { "foundry-mcp.managed": false } }]
        }),
        /Not a plain key: "foundry-mcp\.managed" in flags\./
      );
      same(
        await page.evaluate(
          (id, ids) => ids.map((tokenId) => game.scenes.get(id).tokens.get(tokenId)._source.flags["foundry-mcp"]),
          sceneId,
          placed
        ),
        [{ managed: true }, { managed: true }],
        "the bridge's flag after the refused keys"
      );
    });

    await check(
      "update_tokens puts a token of the viewed scene exactly where it is told, with its centre on a wall",
      async () => {
        const [large] = (
          await tool(client, "place_tokens", {
            sceneId,
            tokens: [{ actor: made.actorId, at: [300, 300], width: 2, height: 2 }]
          })
        ).tokens;
        const viewedBefore = await page.evaluate(async (id) => {
          const scene = game.scenes.get(id);
          const before = canvas.scene?.id ?? null;
          await scene.createEmbeddedDocuments("Wall", [{ c: [800, 200, 800, 1000] }]);
          await scene.view();
          return before;
        }, sceneId);
        try {
          same(
            await page.evaluate((id) => [canvas.scene?.id === id, canvas.ready], sceneId),
            [true, true],
            "the scene is viewed"
          );
          const move = { sceneId, tokens: [{ id: large.id, at: [500, 300] }] };
          const moved = await tool(client, "update_tokens", move);
          same(moved.tokens, [{ id: large.id, at: [500, 300], changed: ["at"] }], "moved onto the wall line");
          same(
            await page.evaluate(
              (id, tokenId) => {
                const source = game.scenes.get(id).tokens.get(tokenId)._source;
                return [source.x, source.y];
              },
              sceneId,
              large.id
            ),
            [700, 400],
            "stored corner"
          );
          same(
            (await tool(client, "update_tokens", move)).tokens,
            [{ id: large.id, at: [500, 300], changed: [] }],
            "repeat"
          );
        } finally {
          await page.evaluate(
            async (id, tokenId, before) => {
              const scene = game.scenes.get(id);
              const other = game.scenes.get(before);
              if (other && other.id !== id) await other.view();
              await scene.deleteEmbeddedDocuments("Token", [tokenId]);
              await scene.deleteEmbeddedDocuments(
                "Wall",
                scene.walls.map((wall) => wall.id)
              );
            },
            sceneId,
            large.id,
            viewedBefore
          );
        }
      }
    );

    await check("get_scene reads both tokens back, with their full stored data when asked", async () => {
      const scene = await tool(client, "get_scene", { sceneId, tokens: placed });
      const listed = placed.map((id) => scene.tokens.find((t) => t.id === id));
      same(
        listed.map((t) => [t.at, t.hidden, t.managed]),
        [
          [[650, 550], false, true],
          [[450, 350], true, true]
        ],
        "listed tokens"
      );
      same(
        scene.tokenData.map((t) => [t.id, t.at, t.actorId, t.hidden, "x" in t, "_id" in t, "delta" in t]),
        [
          [placed[0], [650, 550], made.actorId, false, false, false, false],
          [placed[1], [450, 350], made.actorId, true, false, false, false]
        ],
        "token data"
      );
    });

    await check(
      "update_tokens takes tokenData entries back as they were read and writes nothing, also for a token off the grid",
      async () => {
        const nudged = await tool(client, "update_tokens", {
          sceneId,
          tokens: [{ id: placed[0], at: [655, 553], snap: false }]
        });
        same(nudged.tokens, [{ id: placed[0], at: [655, 553], changed: ["at"] }], "moved off the grid");
        const stored = () =>
          page.evaluate(
            (id, ids) => ids.map((tokenId) => JSON.stringify(game.scenes.get(id).tokens.get(tokenId)._source)),
            sceneId,
            placed
          );
        const before = await stored();
        const { tokenData } = await tool(client, "get_scene", { sceneId, tokens: placed });
        same(
          tokenData.map((t) => [t.at, t.actorId, t.flags["foundry-mcp"]]),
          [
            [[655, 553], made.actorId, { managed: true }],
            [[450, 350], made.actorId, { managed: true }]
          ],
          "token data read"
        );
        const result = await tool(client, "update_tokens", { sceneId, tokens: tokenData });
        same(
          result.tokens,
          [
            { id: placed[0], at: [655, 553], changed: [] },
            { id: placed[1], at: [450, 350], changed: [] }
          ],
          "passed back"
        );
        same(await stored(), before, "stored data after the entries were passed back");
      }
    );

    await check("delete_tokens deletes both and ignores an id that is not on the scene", async () => {
      const before = await tokenCount();
      const result = await tool(client, "delete_tokens", { sceneId, ids: [...placed, "notATokenId00000"] });
      same(result.deleted, 2, "deleted");
      same(await tokenCount(), before - 2, "tokens in the page");
    });
  } finally {
    await page
      .evaluate(
        async (id, name) => {
          for (const actor of game.actors.filter((a) => a.name === name)) {
            const tokens = game.scenes.get(id)?.tokens.filter((t) => t.actorId === actor.id) ?? [];
            for (const token of tokens) await token.delete();
            await actor.delete();
          }
        },
        sceneId,
        actorName
      )
      .catch((e) => console.log(`cleanup: actor delete failed: ${e.message}`));
  }

  const actorFolder = `foundry-mcp e2e actors ${Date.now()}`;
  try {
    // The spellings the Foundry server rewrites when it stores HTML: a self-closing tag, single quotes, a style with
    // spaces, entities, a comment, a table without a tbody, and an ampersand that starts no entity.
    const biography =
      "<p class='lair' style=\"color: red\">Cold<br />and &mdash; dark&nbsp;halls<!-- draft --></p>" +
      "<table><tr><td>&Reference[prone]</td></tr></table>";
    const knight = {
      name: "e2e knight",
      type: "npc",
      folder: [actorFolder, "Knights"],
      system: {
        attributes: {
          ac: { flat: 18, calcs: ["natural"] },
          hp: { max: 52 },
          movement: { speeds: { walk: "30" } }
        },
        details: { cr: 0.5, biography: { value: biography } },
        skills: { ath: { value: 1 }, prc: { value: 2 } }
      }
    };
    const storedActor = (id) =>
      page.evaluate((actorId) => {
        const actor = game.actors.get(actorId);
        const { system, flags } = actor._source;
        return {
          hp: [system.attributes.hp.value, system.attributes.hp.max],
          speed: system.attributes.movement.speeds.walk,
          cr: system.details.cr,
          biography: system.details.biography.value,
          tools: Object.keys(system.tools),
          world: flags.world ?? null,
          managed: flags["foundry-mcp"]?.managed === true,
          folder: actor.folder?.name ?? null
        };
      }, id);
    let knightId;
    await check(
      "ensure_actor creates an npc in new folders, and derived shows the armor class, hit points and skills it amounts to",
      async () => {
        const result = await tool(client, "ensure_actor", knight);
        knightId = result.id;
        same(
          [result.created, result.type, result.folder, result.unapplied],
          [true, "npc", [actorFolder, "Knights"], []],
          "result"
        );
        assert(result.changed.includes("system.attributes.hp.value"), `changed was ${result.changed}`);
        const { ac, hp, prof, skills } = result.derived;
        same([ac, hp.value, hp.max], [18, 52, 52], "derived armor class and hit points");
        same([skills.ath.total, skills.prc.total, skills.ste.total], [prof, 2 * prof, 0], "skill totals");
        const stored = await storedActor(knightId);
        same(
          [stored.hp, stored.speed, stored.cr, stored.managed, stored.folder],
          [[52, 52], "30", 0.5, true, "Knights"],
          "stored"
        );
        assert(
          stored.biography !== biography,
          "the server stored the biography as it was given, so the test shows nothing"
        );
        assert(stored.biography.includes("<tbody>") && stored.biography.includes("&amp;Reference"), stored.biography);
        const listed = await tool(client, "list_actors", { folder: [actorFolder] });
        same(
          listed.actors.map((a) => [a.id, a.managed, a.cr]),
          [[knightId, true, 0.5]],
          "listed"
        );
      }
    );

    await check("ensure_actor run again with the same input changes nothing, the biography included", async () => {
      const before = await page.evaluate((id) => JSON.stringify(game.actors.get(id)._source), knightId);
      const again = await tool(client, "ensure_actor", knight);
      same([again.id, again.created, again.changed, again.unapplied], [knightId, false, [], []], "repeat");
      same(await page.evaluate((id) => JSON.stringify(game.actors.get(id)._source), knightId), before, "stored data");
    });

    await check(
      "ensure_actor writes the one value that differs, and a biography that says something else",
      async () => {
        const harder = structuredClone(knight);
        harder.system.details.cr = 3;
        const result = await tool(client, "ensure_actor", harder);
        same(
          [result.changed, result.unapplied, result.derived.xp],
          [["system.details.cr"], [], 700],
          "challenge rating"
        );
        harder.system.details.biography.value = biography.replace("Cold", "Warm");
        const rewritten = await tool(client, "ensure_actor", harder);
        same([rewritten.changed, rewritten.unapplied], [["system.details.biography.value"], []], "biography");
        const stored = await storedActor(knightId);
        assert(stored.biography.startsWith('<p class="lair" style="color:red">Warm<br>and — dark'), stored.biography);
        same((await tool(client, "ensure_actor", harder)).changed, [], "repeat");
      }
    );

    await check("ensure_actor removes a map entry and a flag key, and ignores them once they are gone", async () => {
      const added = await tool(client, "ensure_actor", {
        actor: knightId,
        system: { tools: { thief: { value: 1 } } },
        flags: { world: { note: "x", keep: 1 } }
      });
      assert(added.changed.includes("system.tools.thief.value"), `changed was ${added.changed}`);
      const args = { actor: knightId, remove: ["system.tools.thief", "flags.world.note"] };
      const removed = await tool(client, "ensure_actor", args);
      same([removed.changed, removed.unapplied], [["system.tools.thief", "flags.world.note"], []], "removed");
      const stored = await storedActor(knightId);
      same([stored.tools, stored.world], [[], { keep: 1 }], "stored");
      same((await tool(client, "ensure_actor", args)).changed, [], "repeat");
    });

    await check(
      "ensure_actor refuses what it cannot store, a null that would reset an entry and a hand-made actor of the name",
      async () => {
        const before = await page.evaluate((id) => JSON.stringify(game.actors.get(id)._source), knightId);
        const refuses = (args, pattern) =>
          assertRejects(tool(client, "ensure_actor", { actor: knightId, ...args }), pattern);
        await refuses(
          { system: { attributes: { ac: { value: 20 } } } },
          /No such field: system\.attributes\.ac\.value/
        );
        await refuses(
          { system: { attributes: { ac: { calc: "flat" } } } },
          /Derived, never stored: system\.attributes\.ac\.calc/
        );
        await refuses({ system: { tools: { thief: null } } }, /system\.tools\.thief: null would be stored as \{/);
        await refuses({ system: { details: { cr: "abc" } } }, /Foundry's actor model refuses the data/);
        await refuses({ remove: ["system.details.cr"] }, /Not an entry that can be removed: system\.details\.cr/);
        await refuses({ flags: { "foundry-mcp": { managed: false } } }, /flags\.foundry-mcp cannot be given/);
        await refuses({ name: "renamed", system: { skills: { stealth: { value: 1 } } } }, /the key must be one of acr/);
        same(await page.evaluate((id) => JSON.stringify(game.actors.get(id)._source), knightId), before, "stored data");
        const handMade = await page.evaluate(
          async (name) => (await Actor.implementation.create({ name, type: "npc" })).id,
          `${actorFolder} by hand`
        );
        try {
          await assertRejects(
            tool(client, "ensure_actor", { name: `${actorFolder} by hand`, system: { details: { cr: 9 } } }),
            new RegExp(`was not made by this bridge \\(${handMade}\\)\\. Pass its id as actor`)
          );
          await assertRejects(tool(client, "delete_actors", { ids: [handMade] }), /not made by this bridge/);
          assert(await page.evaluate((id) => game.actors.has(id), handMade), "the hand-made actor was deleted");
          same(
            (await tool(client, "delete_actors", { ids: [handMade], handMade: true })).deleted,
            1,
            "deleted by hand"
          );
        } finally {
          await page.evaluate((id) => game.actors.get(id)?.delete(), handMade);
        }
      }
    );

    const fromPack = await page.evaluate(async () => {
      const index = await game.packs.get("dnd5e.actors24").getIndex();
      const uuid = (type) => index.find((entry) => entry.type === type)?.uuid ?? null;
      // An npc without a portrait, where the pack has one: its img is stored as null.
      const bare = index.find((entry) => entry.type === "npc" && !entry.img);
      // The one pack actor that stores a key outside the skills dnd5e keeps (system.skills.value).
      const dragon = index.find((entry) => entry._id === "mmAncientGoldDra")?.uuid ?? null;
      return { npc: bare?.uuid ?? uuid("npc"), vehicle: uuid("vehicle"), dragon };
    });
    await check(
      "ensure_actor copies a vehicle from dnd5e.actors24, and what get_actor returns of it is taken back unchanged",
      async () => {
        assert(fromPack.vehicle, "dnd5e.actors24 has no vehicle");
        const args = { name: "e2e ship", from: fromPack.vehicle, folder: [actorFolder] };
        const copy = await tool(client, "ensure_actor", args);
        same(
          [copy.created, copy.type, copy.changed, copy.unapplied],
          [true, "vehicle", ["name", "folder"], []],
          "copy"
        );
        same((await tool(client, "ensure_actor", args)).created, false, "the repeat copies nothing");
        const legacy = await page.evaluate((id) => game.actors.get(id)._source.system.attributes.ac.calc, copy.id);
        same(legacy, "flat", "the stored key that dnd5e's model would not store again");
        const read = await tool(client, "get_actor", { actor: copy.id });
        same("calc" in read.system.attributes.ac, false, "get_actor returns the legacy key");
        const { name, img, system, prototypeToken, ownership } = read;
        const back = await tool(client, "ensure_actor", {
          actor: copy.id,
          name,
          img,
          system,
          prototypeToken,
          ownership
        });
        same([back.changed, back.unapplied], [[], []], "passed back");
      }
    );

    await check(
      "what get_actor returns of a pack actor with a key outside a map's fixed keys is taken back by ensure_actor",
      async () => {
        assert(fromPack.dragon, "dnd5e.actors24 has no Ancient Gold Dragon");
        const stray = await page.evaluate(
          async (uuid) => "value" in (await fromUuid(uuid))._source.system.skills,
          fromPack.dragon
        );
        same(stray, true, "the pack actor stores system.skills.value");
        const fromThePack = await tool(client, "get_actor", { actor: fromPack.dragon });
        same("value" in fromThePack.system.skills, false, "get_actor returns the stray key");
        const copy = await tool(client, "ensure_actor", {
          name: "e2e dragon",
          from: fromPack.dragon,
          folder: [actorFolder]
        });
        for (const read of [fromThePack, await tool(client, "get_actor", { actor: copy.id })]) {
          const { system, prototypeToken, ownership } = read;
          const back = await tool(client, "ensure_actor", { actor: copy.id, system, prototypeToken, ownership });
          same([back.changed, back.unapplied], [[], []], `passed back from ${read.uuid}`);
        }
      }
    );

    await check(
      "ensure_actor gives a new character the prototype token it was given in one call, where dnd5e sets its own",
      async () => {
        const args = {
          name: "e2e hero",
          type: "character",
          folder: [actorFolder],
          prototypeToken: { actorLink: false, disposition: -1 }
        };
        const hero = await tool(client, "ensure_actor", args);
        same([hero.created, hero.unapplied], [true, []], "created");
        assert(hero.changed.includes("prototypeToken.actorLink"), `changed was ${hero.changed}`);
        const stored = await page.evaluate((id) => {
          const { actorLink, disposition } = game.actors.get(id)._source.prototypeToken;
          return [actorLink, disposition];
        }, hero.id);
        same(stored, [false, -1], "stored prototype token");
        same((await tool(client, "ensure_actor", args)).changed, [], "repeat");
      }
    );

    let copyId;
    let tokenId;
    await check(
      "ensure_actor copies an npc with given data over it, and changes the actor of its token through the token's UUID",
      async () => {
        assert(fromPack.npc, "dnd5e.actors24 has no npc");
        const source = await page.evaluate(async (uuid) => {
          const actor = await fromUuid(uuid);
          return { items: actor.items.size, cr: actor._source.system.details.cr, img: actor._source.img };
        }, fromPack.npc);
        const copy = await tool(client, "ensure_actor", {
          name: "e2e copy",
          from: fromPack.npc,
          folder: [actorFolder],
          system: { attributes: { hp: { max: 40 } } }
        });
        copyId = copy.id;
        same([copy.created, copy.derived.hp.value, copy.derived.hp.max], [true, 40, 40], "copy");
        const read = await tool(client, "get_actor", { actor: copyId });
        same(
          [read.items.length, read.system.details.cr, read.managed, read.img],
          [source.items, source.cr, true, source.img],
          "what was copied"
        );
        const { name, img, system, prototypeToken, ownership } = read;
        const back = await tool(client, "ensure_actor", {
          actor: copyId,
          name,
          img,
          system,
          prototypeToken,
          ownership
        });
        same([back.changed, back.unapplied], [[], []], "passed back");
        const placed = await tool(client, "place_tokens", {
          sceneId,
          tokens: [{ actor: copyId, at: [550, 150], actorLink: false }]
        });
        tokenId = placed.tokens[0].id;
        const uuid = `Scene.${sceneId}.Token.${tokenId}.Actor.${copyId}`;
        const wounded = { actor: uuid, name: "e2e wounded", system: { attributes: { hp: { value: 7 } } } };
        const result = await tool(client, "ensure_actor", wounded);
        same([result.uuid, result.name, result.folder, result.unapplied], [uuid, "e2e wounded", [], []], "token actor");
        same([result.derived.hp.value, result.derived.hp.max], [7, 40], "derived hit points of the token");
        const inPage = await page.evaluate(
          (scene, token, actor) => {
            const delta = game.scenes.get(scene).tokens.get(token).delta._source;
            const world = game.actors.get(actor);
            return [delta.name, delta.system.attributes.hp.value, world.name, world._source.system.attributes.hp.value];
          },
          sceneId,
          tokenId,
          copyId
        );
        same(inPage, ["e2e wounded", 7, "e2e copy", 40], "the token's own changes, and the world actor");
        same((await tool(client, "ensure_actor", wounded)).changed, [], "repeat");
        await assertRejects(
          tool(client, "ensure_actor", { actor: uuid, folder: [actorFolder] }),
          /is the actor of a token/
        );
      }
    );

    await check(
      "ensure_actor removes what a token's actor added, in one call with a changed value, and the server keeps both calls",
      async () => {
        const uuid = `Scene.${sceneId}.Token.${tokenId}.Actor.${copyId}`;
        // What the server returns for the scene, beside what the page shows: they part when a write is lost.
        const delta = () =>
          page.evaluate(
            async (scene, token) => {
              const [fresh] = await CONFIG.DatabaseBackend.get(getDocumentClass("Scene"), { query: { _id: scene } });
              const pick = (data) => ({
                hp: data?.system?.attributes?.hp?.value ?? null,
                tools: Object.keys(data?.system?.tools ?? {}),
                world: Object.keys(data?.flags?.world ?? {})
              });
              return {
                page: pick(game.scenes.get(scene).tokens.get(token).delta._source),
                server: pick(fresh.tokens.get(token)._source.delta)
              };
            },
            sceneId,
            tokenId
          );
        const added = await tool(client, "ensure_actor", {
          actor: uuid,
          system: { tools: { smith: { value: 1 } } },
          flags: { world: { limp: 1 } }
        });
        assert(added.changed.includes("system.tools.smith.value"), `changed was ${added.changed}`);
        const kept = { hp: 7, tools: ["smith"], world: ["limp"] };
        same(await delta(), { page: kept, server: kept }, "a second call keeps what the first wrote");
        const args = {
          actor: uuid,
          system: { attributes: { hp: { value: 5 } } },
          remove: ["system.tools.smith", "flags.world.limp"]
        };
        const removed = await tool(client, "ensure_actor", args);
        same(
          [removed.changed, removed.unapplied],
          [["system.attributes.hp.value", "system.tools.smith", "flags.world.limp"], []],
          "removed"
        );
        const after = { hp: 5, tools: [], world: [] };
        same(await delta(), { page: after, server: after }, "the token's own changes after the removal");
        same((await tool(client, "ensure_actor", args)).changed, [], "repeat");
        await assertRejects(
          tool(client, "ensure_actor", { actor: uuid, remove: ["system.abilities.str"] }),
          /system\.abilities\.str comes from the world actor e2e copy/
        );
      }
    );

    await check(
      "delete_actors refuses an actor that has a token placed, and deletes it once the token is gone",
      async () => {
        const all = (await tool(client, "list_actors", { folder: [actorFolder] })).actors.map((a) => a.id);
        same(all.length, 5, "actors in the folder");
        await assertRejects(
          tool(client, "delete_actors", { ids: all }),
          /e2e copy \(\w+\) on foundry-mcp e2e\. Delete the tokens first/
        );
        same((await tool(client, "list_actors", { folder: [actorFolder] })).total, 5, "actors after the refusal");
        same((await tool(client, "delete_tokens", { sceneId, ids: [tokenId] })).deleted, 1, "token deleted");
        const result = await tool(client, "delete_actors", { ids: [...all, "notAnActorId00000"] });
        same([result.deleted, [...result.ids].sort()], [5, [...all].sort()], "deleted");
        same(await page.evaluate((ids) => ids.filter((id) => game.actors.has(id)), all), [], "actors left in the page");
      }
    );
  } finally {
    await page
      .evaluate(
        async (id, name) => {
          const top = game.folders.find((f) => f.type === "Actor" && f.name === name && !f.folder);
          const inFolder = (actor) => {
            for (let folder = actor.folder; folder; folder = folder.folder) if (folder === top) return true;
            return false;
          };
          const actors = top ? game.actors.filter(inFolder) : [];
          for (const actor of actors) {
            const tokens = game.scenes.get(id)?.tokens.filter((t) => t.actorId === actor.id) ?? [];
            for (const token of tokens) await token.delete();
          }
          await top?.delete({ deleteSubfolders: true, deleteContents: true });
        },
        sceneId,
        actorFolder
      )
      .catch((e) => console.log(`cleanup: actor folder delete failed: ${e.message}`));
  }

  const itemFolder = `foundry-mcp e2e items ${Date.now()}`;
  try {
    const packs = await page.evaluate(async () => {
      const first = async (pack, type) => {
        const index = await game.packs.get(pack).getIndex();
        return index.find((entry) => entry.type === type)?.uuid ?? null;
      };
      return {
        spell: await first("dnd5e.spells24", "spell"),
        klass: await first("dnd5e.classes24", "class"),
        species: await first("dnd5e.origins24", "race"),
        background: await first("dnd5e.origins24", "background")
      };
    });
    const acBonus = (value) => ({ key: "system.attributes.ac.bonus", type: "add", value });
    const hound = {
      name: "e2e hound",
      type: "npc",
      folder: [itemFolder],
      system: { attributes: { hp: { max: 30 } }, details: { cr: 1 } },
      items: [
        {
          name: "Keen Smell",
          type: "feat",
          system: { description: { value: "<p>Sharp<br />nose &mdash; always</p>" } }
        },
        {
          name: "Bite",
          type: "feat",
          system: {
            activities: {
              bite: {
                type: "attack",
                activation: { type: "action" },
                attack: { flat: true, bonus: "5", type: { value: "melee", classification: "weapon" } },
                damage: {
                  includeBase: false,
                  parts: [{ number: 2, denomination: 6, bonus: "3", types: ["piercing"] }]
                },
                range: { value: "5", units: "ft" },
                description: { value: "<p>Jaws<br />snap</p>" }
              }
            }
          }
        },
        {
          name: "Fire Breath",
          type: "feat",
          system: {
            uses: { max: "1", recovery: [{ period: "recharge", formula: "5", type: "recoverAll" }] },
            activities: {
              breath: {
                type: "save",
                save: { ability: ["dex"], dc: { calculation: "", formula: "13" } },
                damage: { onSave: "half", parts: [{ number: 4, denomination: 6, types: ["fire"] }] },
                consumption: { targets: [{ type: "itemUses", target: "", value: "1" }] },
                effects: [{ _id: "burning" }]
              }
            }
          },
          effects: [{ _id: "burning", name: "Burning", system: { changes: [acBonus("-1")] } }]
        },
        { from: packs.spell, system: { prepared: 2 } }
      ],
      effects: [
        {
          _id: "pack fury",
          name: "Pack Fury",
          description: "<p>Howls<br />loudly</p>",
          system: { changes: [acBonus("1")] }
        }
      ]
    };
    const quiet = (entries) => entries.map((entry) => [entry.created, entry.changed, entry.unapplied]);
    const allQuiet = (count) => Array.from({ length: count }, () => [false, [], []]);
    const stored = (actorRef) =>
      page.evaluate(async (ref) => JSON.stringify((await fromUuid(ref)).toObject()), actorRef);
    let houndId;
    let ids;
    let biteActivity;
    await check(
      "ensure_actor creates an npc with a trait, a fixed-bonus attack, a recharge save with an effect, a copied spell and an effect of its own",
      async () => {
        assert(packs.spell, "dnd5e.spells24 has no spell");
        const result = await tool(client, "ensure_actor", hound);
        houndId = result.id;
        same([result.created, result.unapplied], [true, []], "actor");
        same(
          result.items.map((item) => [item.type, item.created, item.unapplied]),
          [
            ["feat", true, []],
            ["feat", true, []],
            ["feat", true, []],
            ["spell", true, []]
          ],
          "items"
        );
        same(quiet(result.effects), [[true, ["name", "description", "system.changes"], []]], "the actor's effect");
        same(quiet(result.items[2].effects), [[true, ["name", "system.changes"], []]], "the item's effect");
        ids = Object.fromEntries(result.items.map((item) => [item.name, item.id]));
        const read = await tool(client, "get_actor", { actor: houndId, items: result.items.map((item) => item.id) });
        const [smell, bite, breath, spell] = read.itemData;
        const [[biteKey, attack]] = Object.entries(bite.system.activities);
        biteActivity = biteKey;
        assert(/^[a-zA-Z0-9]{16}$/.test(biteKey), `the activity key is ${biteKey}`);
        same(
          [attack._id, attack.type, attack.attack.bonus, attack.damage.parts.length, attack.range.value],
          [biteKey, "attack", "5", 1, "5"],
          "the attack"
        );
        same(
          [smell.system.type.value, smell.flags["foundry-mcp"], smell.system.description.value.includes("<br>")],
          ["monster", { managed: true }, true],
          "the trait, with the type dnd5e gives a feature created on an npc"
        );
        const [save] = Object.values(breath.system.activities);
        same(
          [save.effects.map((effect) => effect._id), breath.system.uses.recovery[0].period, save.save.dc.formula],
          [[breath.effects[0]._id], "recharge", "13"],
          "the save, its effect and its recharge"
        );
        same(
          [spell.type, spell.system.prepared, spell._stats.compendiumSource, spell.flags["foundry-mcp"]],
          ["spell", 2, packs.spell, { managed: true }],
          "the copied spell"
        );
        same(
          read.effects.map((effect) => effect.name),
          ["Pack Fury"],
          "the actor's effects"
        );
        const labels = await page.evaluate(
          (actor, item, activity) => {
            const one = game.actors.get(actor).items.get(item).system.activities.get(activity);
            return [one.labels.toHit, one.labels.damage.map((part) => part.formula)];
          },
          houndId,
          ids.Bite,
          biteKey
        );
        same(labels, ["+5", ["2d6 + 3"]], "what the sheet shows for the attack");
      }
    );

    await check("ensure_actor run again with the same items and effects changes nothing and adds none", async () => {
      const before = await stored(`Actor.${houndId}`);
      const again = await tool(client, "ensure_actor", hound);
      same([again.created, again.changed, again.unapplied], [false, [], []], "actor");
      same(quiet(again.items), allQuiet(4), "items");
      same(quiet(again.effects), allQuiet(1), "effects");
      same(quiet(again.items[2].effects), allQuiet(1), "the item's effect");
      same(await stored(`Actor.${houndId}`), before, "stored data");
    });

    await check("ensure_actor takes back the item and effect data get_actor returns, and writes nothing", async () => {
      const before = await stored(`Actor.${houndId}`);
      const effectIds = (await tool(client, "get_actor", { actor: houndId })).effects.map((effect) => effect.id);
      const read = await tool(client, "get_actor", { actor: houndId, items: Object.values(ids), effects: effectIds });
      const back = await tool(client, "ensure_actor", {
        actor: houndId,
        items: read.itemData.map(({ _id, name, img, system, flags, effects }) => ({
          id: _id,
          name,
          img,
          system,
          flags,
          effects
        })),
        effects: read.effectData
      });
      same(quiet(back.items), allQuiet(4), "items");
      same(quiet(back.effects), allQuiet(1), "effects");
      same(await stored(`Actor.${houndId}`), before, "stored data");
    });

    await check(
      "ensure_actor changes an attack bonus through its label, deletes an activity with remove, and removes an item",
      async () => {
        const stronger = { name: "Bite", type: "feat", system: { activities: { bite: { attack: { bonus: "7" } } } } };
        const changed = await tool(client, "ensure_actor", { actor: houndId, items: [stronger] });
        same(quiet(changed.items), [[false, [`system.activities.${biteActivity}.attack.bonus`], []]], "the bonus");
        const toHit = await page.evaluate(
          (actor, item, activity) =>
            game.actors.get(actor).items.get(item).system.activities.get(activity).labels.toHit,
          houndId,
          ids.Bite,
          biteActivity
        );
        same(toHit, "+7", "what the sheet shows");
        const cut = { name: "Fire Breath", type: "feat", remove: ["system.activities.breath"] };
        const removed = await tool(client, "ensure_actor", { actor: houndId, items: [cut] });
        same(removed.items[0].changed.length, 1, "the removed activity");
        same(removed.items[0].unapplied, [], "unapplied");
        same((await tool(client, "ensure_actor", { actor: houndId, items: [cut] })).items[0].changed, [], "repeat");
        const gone = await tool(client, "ensure_actor", {
          actor: houndId,
          removeItems: [ids["Keen Smell"], "nothingHere000001"],
          removeEffects: ["no such effect"]
        });
        same([gone.removedItems, gone.removedEffects], [1, 0], "removed");
        const left = await page.evaluate((actor) => {
          const document = game.actors.get(actor);
          const breath = document.items.getName("Fire Breath");
          return [document.items.map((item) => item.name).sort(), breath.system.activities.size];
        }, houndId);
        same([left[0].includes("Keen Smell"), left[0].length, left[1]], [false, 3, 0], "what is left");
      }
    );

    await check("ensure_actor refuses a fault in one of several items before anything is written", async () => {
      const before = await stored(`Actor.${houndId}`);
      const refuses = (entry, pattern) =>
        assertRejects(
          tool(client, "ensure_actor", {
            actor: houndId,
            name: "e2e renamed",
            items: [{ name: "Howl", type: "feat" }, entry]
          }),
          pattern
        );
      await refuses(
        { name: "Bite", type: "feat", system: { activities: { bite: { range: { reach: 5 } } } } },
        /items\[1\]: No such field: system\.activities\.\w{16}\.range\.reach/
      );
      await refuses(
        { name: "Bite", type: "feat", system: { activities: { bite: { type: "save" } } } },
        /this activity is of the type attack, and keeps it/
      );
      await refuses(
        { name: "Claw", type: "feat", system: { activities: { claw: { attack: {} } } } },
        /a new activity needs a type, one of attack, cast, check/
      );
      await refuses(
        { name: "Bite", type: "feat", system: { uses: { spent: "lots" } } },
        /items\[1\]: Foundry's item model refuses the data/
      );
      await refuses({ id: "nothingHere000001" }, /items\[1\]: e2e hound has no item with the id nothingHere000001/);
      await refuses(
        { name: "Bite", type: "weapon", from: "Actor.nothing" },
        /Nothing exists at the UUID Actor\.nothing/
      );
      same(await stored(`Actor.${houndId}`), before, "stored data");
    });

    await check(
      "a cast activity gets its spell copy from dnd5e, and the next call takes the copy for no item of its own",
      async () => {
        const wand = {
          name: "Wand",
          type: "feat",
          system: { activities: { zap: { type: "cast", spell: { uuid: packs.spell } } } }
        };
        const made = await tool(client, "ensure_actor", { actor: houndId, items: [wand] });
        same(
          quiet(made.items).map(([created, , unapplied]) => [created, unapplied]),
          [[true, []]],
          "the wand"
        );
        const copies = () =>
          page.evaluate(
            (actor) =>
              game.actors
                .get(actor)
                .items.filter((item) => item.flags.dnd5e?.cachedFor)
                .map((item) => [item.type, item._stats.compendiumSource, item.flags["foundry-mcp"]?.managed ?? null]),
            houndId
          );
        const copy = await eventually(async () => {
          const found = await copies();
          return found.length === 1 ? found : null;
        }, "the spell copy of the cast activity");
        same(copy, [["spell", packs.spell, null]], "the copy dnd5e made");
        const count = await page.evaluate((actor) => game.actors.get(actor).items.size, houndId);
        const again = await tool(client, "ensure_actor", {
          actor: houndId,
          items: [wand, { from: packs.spell, system: { prepared: 2 } }]
        });
        same(quiet(again.items), allQuiet(2), "the wand and the spell given with from");
        same(await page.evaluate((actor) => game.actors.get(actor).items.size, houndId), count, "items");
      }
    );

    await check(
      "a character takes a class, a species and a background copied from the compendiums, and no dialog opens",
      async () => {
        assert(
          packs.klass && packs.species && packs.background,
          `missing in the compendiums: ${JSON.stringify(packs)}`
        );
        const windows = () => page.evaluate(() => foundry.applications.instances.size);
        const open = await windows();
        const hero = {
          name: "e2e adventurer",
          type: "character",
          folder: [itemFolder],
          system: { attributes: { hp: { value: 24, max: 24 } } },
          items: [{ from: packs.klass, system: { levels: 3 } }, { from: packs.species }, { from: packs.background }]
        };
        const result = await tool(client, "ensure_actor", hero);
        same(
          result.items.map((item) => [item.type, item.created, item.unapplied]),
          [
            ["class", true, []],
            ["race", true, []],
            ["background", true, []]
          ],
          "items"
        );
        same([result.derived.level, result.derived.prof, result.derived.hp.value], [3, 2, 24], "level and hit points");
        const details = await eventually(async () => {
          const found = await page.evaluate((id) => {
            const { race, background, originalClass } = game.actors.get(id)._source.system.details;
            return [race, background, originalClass];
          }, result.id);
          return found.every(Boolean) ? found : null;
        }, "dnd5e to note the species, the background and the class on the character");
        same(details, [result.items[1].id, result.items[2].id, result.items[0].id], "what dnd5e noted");
        same(await windows(), open, "open windows");
        const again = await tool(client, "ensure_actor", hero);
        same([again.created, again.changed], [false, []], "repeat");
        same(quiet(again.items), allQuiet(3), "repeat of the items");
        const second = await tool(client, "ensure_actor", {
          actor: result.id,
          items: [{ name: "e2e second species", type: "race" }]
        });
        same([second.items[0].created, "id" in second.items[0]], [false, false], "a second species");
        assert(/^foundry_error: Foundry created nothing/.test(second.items[0].error), second.items[0].error);
      }
    );

    await check(
      "on a token's own actor, items and effects are written for that token, and the server keeps every call",
      async () => {
        const placed = await tool(client, "place_tokens", {
          sceneId,
          tokens: [{ actor: houndId, at: [650, 350], actorLink: false }]
        });
        const tokenId = placed.tokens[0].id;
        const uuid = `Scene.${sceneId}.Token.${tokenId}.Actor.${houndId}`;
        // What the server returns for the scene, beside what the page shows: they part when a write is lost.
        const delta = () =>
          page.evaluate(
            async (scene, token) => {
              const [fresh] = await CONFIG.DatabaseBackend.get(getDocumentClass("Scene"), { query: { _id: scene } });
              const pick = (data) => ({
                hp: data?.system?.attributes?.hp?.value ?? null,
                items: (data?.items ?? [])
                  .map((item) =>
                    item._tombstone
                      ? "tombstone"
                      : `${item.name}: ${Object.values(item.system.activities)
                          .map((activity) => activity.attack?.bonus ?? activity.type)
                          .join(",")}`
                  )
                  .sort(),
                effects: (data?.effects ?? []).map((effect) => effect.name)
              });
              return {
                page: pick(game.scenes.get(scene).tokens.get(token).delta._source),
                server: pick(fresh.tokens.get(token)._source.delta)
              };
            },
            sceneId,
            tokenId
          );
        const worldBite = () =>
          page.evaluate(
            (actor, item) =>
              Object.values(game.actors.get(actor).items.get(item)._source.system.activities)[0].attack.bonus,
            houndId,
            ids.Bite
          );
        await tool(client, "ensure_actor", { actor: uuid, system: { attributes: { hp: { value: 9 } } } });
        const own = {
          actor: uuid,
          items: [
            {
              name: "Net",
              type: "feat",
              system: { activities: { throw: { type: "attack", attack: { bonus: "3" } } } }
            },
            { name: "Bite", type: "feat", system: { activities: { bite: { attack: { bonus: "9" } } } } }
          ],
          effects: [{ _id: "dazed", name: "Dazed" }]
        };
        const written = await tool(client, "ensure_actor", own);
        same(
          written.items.map((item) => [item.name, item.created, item.unapplied]),
          [
            ["Net", true, []],
            ["Bite", false, []]
          ],
          "items"
        );
        same(written.items[1].id, ids.Bite, "the world actor's item, changed for the token");
        const first = { hp: 9, items: ["Bite: 9", "Net: 3"], effects: ["Dazed"] };
        same(await delta(), { page: first, server: first }, "the token's own data after three calls");
        same(await worldBite(), "7", "the world actor's bite");
        const again = await tool(client, "ensure_actor", own);
        same(quiet(again.items), allQuiet(2), "repeat of the items");
        same(quiet(again.effects), allQuiet(1), "repeat of the effect");
        same(await delta(), { page: first, server: first }, "the token's own data after the repeat");
        const mixed = await tool(client, "ensure_actor", {
          actor: uuid,
          system: { attributes: { hp: { value: 8 } } },
          items: [{ name: "Net", type: "feat", system: { activities: { throw: { attack: { bonus: "4" } } } } }]
        });
        same(
          [mixed.changed, mixed.items[0].changed.length, mixed.items[0].unapplied],
          [["system.attributes.hp.value"], 1, []],
          "actor data and an item in one call"
        );
        const both = { hp: 8, items: ["Bite: 9", "Net: 4"], effects: ["Dazed"] };
        same(await delta(), { page: both, server: both }, "the token's own data after actor data and an item together");
        const removed = await tool(client, "ensure_actor", {
          actor: uuid,
          items: [{ name: "Bite", type: "feat", remove: ["system.activities.bite"] }],
          removeItems: [written.items[0].id, ids["Fire Breath"]],
          removeEffects: ["dazed"]
        });
        same(
          [removed.items[0].changed.length, removed.items[0].unapplied, removed.removedItems, removed.removedEffects],
          [1, [], 2, 1],
          "removed"
        );
        const after = { hp: 8, items: ["Bite: ", "tombstone"], effects: [] };
        same(await delta(), { page: after, server: after }, "the token's own data after the removals");
        same(await worldBite(), "7", "the world actor's bite after the removals");
        const read = await tool(client, "get_actor", { actor: uuid });
        same(
          read.items.map((item) => item.name).includes("Fire Breath"),
          false,
          "the token's actor still lists an item removed for it"
        );
        same((await tool(client, "delete_tokens", { sceneId, ids: [tokenId] })).deleted, 1, "token deleted");
      }
    );

    await check("delete_actors deletes the actors with their items and effects", async () => {
      const all = (await tool(client, "list_actors", { folder: [itemFolder] })).actors.map((actor) => actor.id);
      same(all.length, 2, "actors in the folder");
      same((await tool(client, "delete_actors", { ids: all })).deleted, 2, "deleted");
    });
  } finally {
    await page
      .evaluate(
        async (id, name) => {
          const top = game.folders.find((f) => f.type === "Actor" && f.name === name && !f.folder);
          for (const actor of top?.contents ?? []) {
            const tokens = game.scenes.get(id)?.tokens.filter((t) => t.actorId === actor.id) ?? [];
            for (const token of tokens) await token.delete();
          }
          await top?.delete({ deleteSubfolders: true, deleteContents: true });
        },
        sceneId,
        itemFolder
      )
      .catch((e) => console.log(`cleanup: item actor folder delete failed: ${e.message}`));
  }

  const documentFolder = `foundry-mcp e2e documents ${Date.now()}`;
  const worldPack = { label: `foundry-mcp e2e pack ${Date.now()}`, id: null };
  const e2eUser = `foundry-mcp e2e user ${Date.now()}`;
  try {
    await check("the server's list of document types is the running Foundry's own", async () => {
      const { tools } = await client.listTools();
      const listed = tools.find((t) => t.name === "list_documents").inputSchema.properties.type.enum;
      same([...listed].sort(), await page.evaluate(() => [...CONST.ALL_DOCUMENT_TYPES].sort()), "document types");
    });

    await check("get_schema answers for every document type, with its types and a field tree", async () => {
      // The types Foundry's own type field takes for each class (common/data/fields.mjs:4291-4295).
      const classes = await page.evaluate(() =>
        CONST.ALL_DOCUMENT_TYPES.map((name) => {
          const cls = CONFIG[name].documentClass;
          const typed = cls.schema.fields.type instanceof foundry.data.fields.DocumentTypeField;
          const creatable = (type) => type !== "base" || cls.metadata.baseTypeAllowed === true;
          return { name, types: typed ? cls.TYPES.filter(creatable) : null };
        })
      );
      for (const { name, types } of classes) {
        const listed = await tool(client, "get_schema", { document: name });
        if (types) same(listed.types, types, `${name} types`);
        // A typed document none of whose types can be created has no tree to ask for.
        if (types?.length === 0) continue;
        const tree = types ? await tool(client, "get_schema", { document: name, type: types[0] }) : listed;
        assert(tree.fields && typeof tree.fields === "object", `${name}: no field tree in ${JSON.stringify(tree)}`);
      }
      const pageText = await tool(client, "get_schema", {
        document: "JournalEntryPage",
        type: "text",
        path: "text.content"
      });
      same(pageText.fields, "html", "the content of a text page");
    });

    const content = "<p class='lair' style=\"color: red\">Cold<br />halls &mdash; dark</p>";
    let folderId;
    let entry;
    let pageUuid;
    await check(
      "create_documents creates a folder and a journal entry with a text page in it, flagged as bridge-made",
      async () => {
        const folder = await tool(client, "create_documents", {
          type: "Folder",
          documents: [{ name: documentFolder, type: "JournalEntry" }]
        });
        same(
          [folder.created, folder.documents[0].type, folder.documents[0].unapplied],
          [1, "JournalEntry", []],
          "folder"
        );
        folderId = folder.documents[0].id;
        const result = await tool(client, "create_documents", {
          type: "JournalEntry",
          documents: [
            { name: "e2e lore", folder: folderId, pages: [{ name: "Halls", type: "text", text: { content } }] }
          ]
        });
        same(
          [result.requested, result.created, result.documents[0].name, result.documents[0].unapplied],
          [1, 1, "e2e lore", []],
          "result"
        );
        entry = result.documents[0];
        const stored = await page.evaluate((uuid) => {
          const made = fromUuidSync(uuid);
          const [first] = made.pages.contents;
          return {
            managed: made.flags["foundry-mcp"]?.managed === true,
            folder: made.folder?.name ?? null,
            pages: made.pages.size,
            page: [first.name, first.type, first.flags["foundry-mcp"]?.managed === true],
            content: first.text.content,
            pageUuid: first.uuid
          };
        }, entry.uuid);
        same(
          [stored.managed, stored.folder, stored.pages, stored.page],
          [true, documentFolder, 1, ["Halls", "text", true]],
          "stored"
        );
        assert(stored.content !== content, "the server stored the page as it was given, so the test shows nothing");
        pageUuid = stored.pageUuid;
      }
    );

    await check("get_document reads the entry and its page back, and list_documents finds both", async () => {
      const read = await tool(client, "get_document", { uuid: entry.uuid });
      same(
        [read.documentName, read.id, read.name, read.parent, read.pack, read.folder, read.managed],
        ["JournalEntry", entry.id, "e2e lore", null, null, [documentFolder], true],
        "entry"
      );
      same(["pages" in read.data, read.data.folder, read.data.name], [false, folderId, "e2e lore"], "entry data");
      same(
        read.embedded.JournalEntryPage,
        [{ uuid: pageUuid, id: pageUuid.split(".").at(-1), name: "Halls", type: "text" }],
        "pages"
      );
      const readPage = await tool(client, "get_document", { uuid: pageUuid });
      same(
        [readPage.documentName, readPage.type, readPage.parent, "folder" in readPage],
        ["JournalEntryPage", "text", entry.uuid, false],
        "page"
      );
      assert(readPage.data.text.content.includes("Cold"), readPage.data.text.content);
      const listed = await tool(client, "list_documents", { type: "JournalEntry", folder: [documentFolder] });
      same(
        listed.documents,
        [{ uuid: entry.uuid, id: entry.id, name: "e2e lore", folder: [documentFolder], managed: true }],
        "listed entry"
      );
      same(listed.folders, [{ id: folderId, path: [documentFolder] }], "listed folders");
      assert(Array.isArray(listed.packs), `no packs in ${JSON.stringify(Object.keys(listed))}`);
      const pages = await tool(client, "list_documents", {
        type: "JournalEntryPage",
        parent: entry.uuid,
        name: "hALL"
      });
      same(
        pages.documents,
        [{ uuid: pageUuid, id: pageUuid.split(".").at(-1), name: "Halls", type: "text", managed: true }],
        "listed page"
      );
      await assertRejects(
        tool(client, "list_documents", { type: "JournalEntryPage" }),
        /A world has no JournalEntryPage documents of its own\. Pass parent: the UUID of the JournalEntry/
      );
    });

    await check(
      "update_documents writes nothing for data read with get_document and passed back, the page's HTML included",
      async () => {
        const before = await page.evaluate((uuid) => JSON.stringify(fromUuidSync(uuid).toObject()), entry.uuid);
        for (const uuid of [entry.uuid, pageUuid]) {
          const { data } = await tool(client, "get_document", { uuid });
          const result = await tool(client, "update_documents", { documents: [{ uuid, data }] });
          same(result.documents, [{ uuid, changed: [], unapplied: [] }], `round trip of ${uuid}`);
        }
        const given = await tool(client, "update_documents", {
          documents: [{ uuid: pageUuid, data: { text: { content } } }]
        });
        same(given.documents[0].changed, [], "the page text as it was given at first");
        same(
          await page.evaluate((uuid) => JSON.stringify(fromUuidSync(uuid).toObject()), entry.uuid),
          before,
          "stored data"
        );
      }
    );

    await check(
      "update_documents changes the page text and a flag, and the same call again changes nothing",
      async () => {
        const change = {
          documents: [
            { uuid: pageUuid, data: { text: { content: content.replace("Cold", "Warm") } } },
            { uuid: entry.uuid, data: { name: "e2e lore, revised", flags: { world: { note: "x", keep: 1 } } } }
          ]
        };
        const result = await tool(client, "update_documents", change);
        same(
          result.documents,
          [
            { uuid: pageUuid, changed: ["text.content"], unapplied: [] },
            { uuid: entry.uuid, changed: ["name", "flags.world.note", "flags.world.keep"], unapplied: [] }
          ],
          "changed"
        );
        const stored = await page.evaluate((uuid) => {
          const made = fromUuidSync(uuid);
          return [made.name, made.pages.contents[0].text.content, made.flags.world];
        }, entry.uuid);
        same([stored[0], stored[2]], ["e2e lore, revised", { note: "x", keep: 1 }], "stored");
        assert(stored[1].includes("Warm"), stored[1]);
        const again = await tool(client, "update_documents", change);
        same(
          again.documents.map((one) => [one.changed, one.unapplied]),
          [
            [[], []],
            [[], []]
          ],
          "repeat"
        );
        const removed = await tool(client, "update_documents", {
          documents: [{ uuid: entry.uuid, remove: ["flags.world.note"] }]
        });
        same(removed.documents[0], { uuid: entry.uuid, changed: ["flags.world.note"], unapplied: [] }, "removed");
        same(
          await page.evaluate((uuid) => fromUuidSync(uuid).flags.world, entry.uuid),
          { keep: 1 },
          "flags after the removal"
        );
      }
    );

    await check("update_documents refuses what it cannot store before anything is written", async () => {
      const refusals = [
        [{ data: { colour: "red" } }, /No such field: colour/],
        [
          { data: { pages: [{ name: "New" }] } },
          /pages cannot be given: it holds the embedded documents of the JournalEntry/
        ],
        [{ data: { sort: "5" } }, /sort: "5" would be stored as 5/],
        [{ data: { flags: { "foundry-mcp": { managed: false } } } }, /flags\.foundry-mcp cannot be given/],
        [{ remove: ["name"] }, /Not an entry that can be removed: name/]
      ];
      for (const [change, message] of refusals) {
        await assertRejects(
          tool(client, "update_documents", {
            documents: [
              { uuid: pageUuid, data: { name: "must not be written" } },
              { uuid: entry.uuid, ...change }
            ]
          }),
          message
        );
      }
      await assertRejects(
        tool(client, "update_documents", { documents: [{ uuid: pageUuid, data: { type: "image" } }] }),
        /is of the type text, and Foundry cannot change the type of a document/
      );
      same(await page.evaluate((uuid) => fromUuidSync(uuid).name, pageUuid), "Halls", "the page's name");
    });

    await check(
      "create_documents creates a page in the entry, and delete_documents deletes it by its own UUID",
      async () => {
        const made = await tool(client, "create_documents", {
          type: "JournalEntryPage",
          parent: entry.uuid,
          documents: [{ name: "Appendix" }]
        });
        same([made.created, made.documents[0].type, made.documents[0].unapplied], [1, "text", []], "page");
        same(await page.evaluate((uuid) => fromUuidSync(uuid).pages.size, entry.uuid), 2, "pages");
        const gone = await tool(client, "delete_documents", {
          uuids: [made.documents[0].uuid, "JournalEntry.nothinghere00000"]
        });
        same(gone, { deleted: 1, documents: [{ uuid: made.documents[0].uuid, name: "Appendix" }] }, "deleted");
        same((await tool(client, "delete_documents", { uuids: [made.documents[0].uuid] })).deleted, 0, "repeat");
      }
    );

    await check("a playlist with a sound is created and deleted with it", async () => {
      const made = await tool(client, "create_documents", {
        type: "Playlist",
        documents: [
          { name: `${documentFolder} playlist`, sounds: [{ name: "e2e dice", path: "sounds/dice.wav", volume: 0.25 }] }
        ]
      });
      same([made.created, made.documents[0].unapplied], [1, []], "playlist");
      const { uuid } = made.documents[0];
      const read = await tool(client, "get_document", { uuid });
      same(
        read.embedded.PlaylistSound.map((sound) => sound.name),
        ["e2e dice"],
        "sounds"
      );
      const sound = await tool(client, "get_document", { uuid: read.embedded.PlaylistSound[0].uuid });
      same([sound.data.path, sound.data.volume, sound.managed], ["sounds/dice.wav", 0.25, true], "sound");
      same((await tool(client, "delete_documents", { uuids: [uuid] })).deleted, 1, "deleted");
      same(await page.evaluate((id) => game.playlists.has(id), made.documents[0].id), false, "playlist still there");
    });

    await check("a chat message is posted, listed as the newest, and deleted", async () => {
      const made = await tool(client, "create_documents", {
        type: "ChatMessage",
        documents: [{ content: "<p>foundry-mcp e2e: the door creaks</p>", speaker: { alias: "e2e" } }]
      });
      same([made.created, made.documents[0].unapplied, "name" in made.documents[0]], [1, [], false], "message");
      const { uuid, id } = made.documents[0];
      const listed = await tool(client, "list_documents", { type: "ChatMessage" });
      same(listed.documents.at(-1), { uuid, id, type: "base", managed: true }, "newest message");
      same((await tool(client, "delete_documents", { uuids: [uuid] })).deleted, 1, "deleted");
      same(await page.evaluate((messageId) => game.messages.has(messageId), id), false, "message still there");
    });

    await check("a user is created only with a password, which is never read back, and is deleted again", async () => {
      await assertRejects(
        tool(client, "create_documents", { type: "User", documents: [{ name: e2eUser, role: 1 }] }),
        /A new user needs a password that is not blank/
      );
      same(
        await page.evaluate((name) => game.users.getName(name) === undefined, e2eUser),
        true,
        "no user after the refusal"
      );
      const password = randomBytes(18).toString("base64url");
      const made = await tool(client, "create_documents", {
        type: "User",
        documents: [{ name: e2eUser, role: 1, password }]
      });
      same([made.created, made.documents[0].unapplied], [1, []], "user");
      const { uuid } = made.documents[0];
      const read = await tool(client, "get_document", { uuid });
      same(["password" in read.data, "passwordSalt" in read.data, read.data.role], [false, false, 1], "read user");
      assert(!JSON.stringify(read).includes(password), "get_document returned the password");
      assert(
        !(await page.evaluate((id) => JSON.stringify(fromUuidSync(id).toObject()), uuid)).includes(password),
        "the page holds the password as given"
      );
      const next = randomBytes(18).toString("base64url");
      const changed = await tool(client, "update_documents", { documents: [{ uuid, data: { password: next } }] });
      same(changed.documents, [{ uuid, changed: ["password"], unapplied: [] }], "password change");
      await assertRejects(
        tool(client, "update_documents", { documents: [{ uuid, data: { password: "" } }] }),
        /cannot be removed or made blank/
      );
      const self = await page.evaluate(() => game.user.uuid);
      await assertRejects(
        tool(client, "delete_documents", { uuids: [self], handMade: true }),
        /is the user this bridge works as/
      );
      same((await tool(client, "delete_documents", { uuids: [uuid] })).deleted, 1, "deleted");
      same(await page.evaluate((name) => game.users.getName(name) === undefined, e2eUser), true, "user gone");
    });

    await check("delete_documents deletes a hand-made document only with handMade", async () => {
      const uuid = await page.evaluate(
        async (folder) => (await JournalEntry.implementation.create({ name: "e2e by hand", folder })).uuid,
        folderId
      );
      const read = await tool(client, "get_document", { uuid });
      same(read.managed, false, "managed");
      await assertRejects(
        tool(client, "delete_documents", { uuids: [entry.uuid, uuid] }),
        /These documents were not made by this bridge: e2e by hand .*Pass handMade: true/
      );
      same(
        await page.evaluate((ids) => ids.map((id) => fromUuidSync(id) !== null), [entry.uuid, uuid]),
        [true, true],
        "both still there"
      );
      same((await tool(client, "delete_documents", { uuids: [uuid], handMade: true })).deleted, 1, "deleted");
    });

    await check(
      "deleting a folder moves its documents and every folder below it to its parent, as delete_documents says",
      async () => {
        const folder = async (name, parent) =>
          (
            await tool(client, "create_documents", {
              type: "Folder",
              documents: [{ name, type: "JournalEntry", folder: parent }]
            })
          ).documents[0];
        const a = await folder("e2e a", folderId);
        const b = await folder("e2e b", a.id);
        const c = await folder("e2e c", b.id);
        const made = await tool(client, "create_documents", {
          type: "JournalEntry",
          documents: [
            { name: "e2e in a", folder: a.id },
            { name: "e2e in c", folder: c.id }
          ]
        });
        same((await tool(client, "delete_documents", { uuids: [a.uuid] })).deleted, 1, "deleted");
        const after = await page.evaluate(
          (ids) => ({
            a: game.folders.has(ids.a),
            b: game.folders.get(ids.b)?.folder?.id ?? null,
            c: game.folders.get(ids.c)?.folder?.id ?? null,
            inA: game.journal.get(ids.inA)?.folder?.id ?? null,
            inC: game.journal.get(ids.inC)?.folder?.id ?? null
          }),
          { a: a.id, b: b.id, c: c.id, inA: made.documents[0].id, inC: made.documents[1].id }
        );
        same(after, { a: false, b: folderId, c: folderId, inA: folderId, inC: c.id }, "where everything went");
      }
    );

    await check("a world setting can be read and is not written", async () => {
      const listed = await tool(client, "list_documents", { type: "Setting" });
      assert(listed.total > 0, "the world stores no setting to read");
      const { uuid } = listed.documents[0];
      const read = await tool(client, "get_document", { uuid });
      same([read.documentName, typeof read.data.key], ["Setting", "string"], "setting");
      await assertRejects(
        tool(client, "update_documents", { documents: [{ uuid, data: { value: read.data.value } }] }),
        /These tools write no Setting/
      );
      await assertRejects(
        tool(client, "delete_documents", { uuids: [uuid], handMade: true }),
        /These tools write no Setting/
      );
    });

    const pack = await page.evaluate(async (label) => {
      try {
        const made = await foundry.documents.collections.CompendiumCollection.createCompendium({
          label,
          type: "JournalEntry"
        });
        return { id: made.collection };
      } catch (error) {
        return { error: error.message };
      }
    }, worldPack.label);
    if (!pack.id) {
      console.log(
        `SKIP the compendium pack checks: this Foundry made no world compendium from the page (${pack.error})`
      );
    } else {
      worldPack.id = pack.id;
      const setLock = async (locked) => {
        await page.evaluate((id, lock) => game.packs.get(id).configure({ locked: lock }), pack.id, locked);
        await eventually(
          () => page.evaluate((id, lock) => game.packs.get(id).locked === lock, pack.id, locked),
          `the pack to be ${locked ? "locked" : "unlocked"}`
        );
      };
      let packed;
      await check("a document is created in a world compendium, listed from its index and read from it", async () => {
        const made = await tool(client, "create_documents", {
          type: "JournalEntry",
          pack: pack.id,
          documents: [{ name: "e2e packed", pages: [{ name: "Inside" }] }]
        });
        same([made.created, made.documents[0].unapplied], [1, []], "created");
        packed = made.documents[0];
        assert(packed.uuid.startsWith(`Compendium.${pack.id}.JournalEntry.`), packed.uuid);
        const listed = await tool(client, "list_documents", { type: "JournalEntry", pack: pack.id });
        same(
          listed.documents,
          [{ uuid: packed.uuid, id: packed.id, name: "e2e packed", folder: [], managed: true }],
          "index"
        );
        same(
          listed.packs.filter((one) => one.id === pack.id),
          [{ id: pack.id, title: worldPack.label, locked: false }],
          "the pack among the packs of its type"
        );
        const read = await tool(client, "get_document", { uuid: packed.uuid });
        same([read.pack, read.locked, read.embedded.JournalEntryPage.length], [pack.id, false, 1], "read");
      });

      await check(
        "a locked compendium refuses create, update and delete, and takes them again once unlocked",
        async () => {
          await setLock(true);
          const locked = /in the compendium pack .*which is locked\. The Gamemaster unlocks a pack in Foundry/;
          await assertRejects(
            tool(client, "update_documents", {
              documents: [{ uuid: packed.uuid, data: { name: "must not be written" } }]
            }),
            locked
          );
          await assertRejects(
            tool(client, "create_documents", {
              type: "JournalEntry",
              pack: pack.id,
              documents: [{ name: "must not exist" }]
            }),
            locked
          );
          await assertRejects(tool(client, "delete_documents", { uuids: [packed.uuid] }), locked);
          same((await tool(client, "get_document", { uuid: packed.uuid })).locked, true, "locked as get_document says");
          const index = await page.evaluate(
            async (id) => (await game.packs.get(id).getIndex()).map((one) => one.name),
            pack.id
          );
          same(index, ["e2e packed"], "the pack after the refusals");
          await setLock(false);
          const renamed = await tool(client, "update_documents", {
            documents: [{ uuid: packed.uuid, data: { name: "e2e repacked" } }]
          });
          same(renamed.documents, [{ uuid: packed.uuid, changed: ["name"], unapplied: [] }], "renamed");
          same((await tool(client, "delete_documents", { uuids: [packed.uuid] })).deleted, 1, "deleted");
        }
      );
    }

    // A scene of the test's own for the checks that need one: it is not viewed, and the cleanup below deletes it.
    const ownScene = await page.evaluate(async (name) => {
      const scene = await Scene.implementation.create({
        name,
        width: 1000,
        height: 800,
        padding: 0,
        navigation: false
      });
      const [region] = await scene.createEmbeddedDocuments("Region", [{ name: "e2e region" }]);
      return { id: scene.id, uuid: scene.uuid, regionUuid: region.uuid };
    }, `${documentFolder} scene`);

    await check("update_documents renames a scene, and refuses its walls inside the data", async () => {
      const name = `${documentFolder} scene, renamed`;
      const renamed = await tool(client, "update_documents", { documents: [{ uuid: ownScene.uuid, data: { name } }] });
      same(renamed.documents, [{ uuid: ownScene.uuid, changed: ["name"], unapplied: [] }], "renamed");
      await assertRejects(
        tool(client, "update_documents", {
          documents: [
            { uuid: ownScene.uuid, data: { name: `${documentFolder} scene`, walls: [{ c: [0, 0, 100, 0] }] } }
          ]
        }),
        /walls cannot be given: it holds the embedded documents of the Scene, which each have a UUID of their own.*Nothing was written\.$/
      );
      same(
        await page.evaluate((id) => [game.scenes.get(id).name, game.scenes.get(id).walls.size], ownScene.id),
        [name, 0],
        "the stored scene"
      );
    });

    await check(
      "no region behavior that runs code is created or rewritten, alone or with its region, and one that runs none is created",
      async () => {
        const script = {
          type: "executeScript",
          system: { events: ["behaviorActivated"], source: "globalThis.foundryMcpE2eRan = true;" }
        };
        await assertRejects(
          tool(client, "create_documents", {
            type: "RegionBehavior",
            parent: ownScene.regionUuid,
            documents: [script]
          }),
          /documents\[0\]: These tools create no region behavior of the type executeScript: its source is code that Foundry runs by itself, without anyone clicking, in every connected browser, the players' included\. The Gamemaster adds such a behavior in Foundry's own region configuration\. Nothing was written\.$/
        );
        await assertRejects(
          tool(client, "create_documents", {
            type: "Region",
            parent: ownScene.uuid,
            documents: [{ name: "e2e trap", behaviors: [script] }]
          }),
          /documents\[0\]: behaviors\.0: These tools create no region behavior of the type executeScript/
        );
        await assertRejects(
          tool(client, "create_documents", {
            type: "RegionBehavior",
            parent: ownScene.regionUuid,
            documents: [{ type: "executeMacro", system: { events: ["behaviorActivated"], uuid: null, everyone: true } }]
          }),
          /These tools create no region behavior of the type executeMacro: it makes Foundry run a macro by itself/
        );
        same(
          await page.evaluate((id) => {
            const scene = game.scenes.get(id);
            return [scene.regions.size, scene.regions.contents[0].behaviors.size, globalThis.foundryMcpE2eRan === true];
          }, ownScene.id),
          [1, 0, false],
          "regions, behaviors, and whether the script ran"
        );

        // A script behavior written in Foundry, which lists no event and so never runs.
        const written = await page.evaluate(async (uuid) => {
          const region = await fromUuid(uuid);
          const [behavior] = await region.createEmbeddedDocuments("RegionBehavior", [
            { type: "executeScript", disabled: true, system: { events: [], source: "// written in Foundry" } }
          ]);
          return behavior.uuid;
        }, ownScene.regionUuid);
        const read = await tool(client, "get_document", { uuid: written });
        same(read.data.system.source, "// written in Foundry", "the source as read");
        await assertRejects(
          tool(client, "update_documents", {
            documents: [{ uuid: written, data: { system: { source: "globalThis.foundryMcpE2eRan = true;" } } }]
          }),
          /is a region behavior of the type executeScript: .*These tools do not change its source\..*Nothing was written\.$/
        );
        const named = await tool(client, "update_documents", {
          documents: [{ uuid: written, data: { name: "e2e alarm", system: read.data.system } }]
        });
        same(named.documents, [{ uuid: written, changed: ["name"], unapplied: [] }], "its other data changes");
        same(
          await page.evaluate(async (uuid) => (await fromUuid(uuid))._source.system.source, written),
          "// written in Foundry",
          "the stored source"
        );

        const calm = await tool(client, "create_documents", {
          type: "RegionBehavior",
          parent: ownScene.regionUuid,
          documents: [{ type: "pauseGame" }]
        });
        same([calm.created, calm.documents[0].type], [1, "pauseGame"], "a behavior that runs no code");
        same((await tool(client, "delete_documents", { uuids: [written], handMade: true })).deleted, 1, "deleted");
      }
    );

    await check(
      "create_documents copies a bridge-made actor from the data get_document returns, bridge flag on the prototype token and all",
      async () => {
        const made = await tool(client, "ensure_actor", { name: `${documentFolder} actor`, type: "npc" });
        // Foundry's Assign Token copies the flag of a bridge-made token onto the prototype token
        // (client/applications/sheets/token/prototype-config.mjs:278-292).
        await page.evaluate(
          (id) => game.actors.get(id).update({ "prototypeToken.flags.foundry-mcp.managed": true }),
          made.id
        );
        const read = await tool(client, "get_document", { uuid: made.uuid });
        same(read.data.prototypeToken.flags["foundry-mcp"], { managed: true }, "the flag on the prototype token");
        const copied = await tool(client, "create_documents", {
          type: "Actor",
          documents: [{ ...read.data, name: `${documentFolder} actor, copied` }]
        });
        same(copied.created, 1, "copied");
        same(
          await page.evaluate((id) => {
            const actor = game.actors.get(id);
            return [actor.name, actor.flags["foundry-mcp"], actor.prototypeToken.flags["foundry-mcp"] ?? null];
          }, copied.documents[0].id),
          [`${documentFolder} actor, copied`, { managed: true }, null],
          "the copy, its flag, and none on its prototype token"
        );
        const taken = await tool(client, "update_documents", { documents: [{ uuid: made.uuid, data: read.data }] });
        same(taken.documents, [{ uuid: made.uuid, changed: [], unapplied: [] }], "the same data taken back unchanged");
      }
    );

    await check("delete_documents deletes a world actor together with its token of the same call", async () => {
      const actor = await tool(client, "ensure_actor", { name: `${documentFolder} actor to delete`, type: "npc" });
      const placed = await tool(client, "place_tokens", {
        sceneId: ownScene.id,
        tokens: [{ actor: actor.id, at: [150, 150] }]
      });
      const tokenUuid = `${ownScene.uuid}.Token.${placed.tokens[0].id}`;
      await assertRejects(
        tool(client, "delete_documents", { uuids: [actor.uuid] }),
        /still has tokens on .*Delete the tokens first with delete_tokens, or give their UUIDs in the same call\..*Nothing was written\.$/
      );
      const gone = await tool(client, "delete_documents", { uuids: [actor.uuid, tokenUuid] });
      same(
        [gone.deleted, gone.documents.map((one) => one.uuid)],
        [2, [tokenUuid, actor.uuid]],
        "deleted, the token first"
      );
      same(
        await page.evaluate((ids) => [game.actors.has(ids.actor), game.scenes.get(ids.scene).tokens.size], {
          actor: actor.id,
          scene: ownScene.id
        }),
        [false, 0],
        "the actor and its token"
      );
    });

    await check("delete_documents deletes the entry with its page", async () => {
      const gone = await tool(client, "delete_documents", { uuids: [pageUuid, entry.uuid] });
      same(gone, { deleted: 1, documents: [{ uuid: entry.uuid, name: "e2e lore, revised" }] }, "deleted");
      same(await page.evaluate((uuid) => fromUuidSync(uuid), entry.uuid), null, "the entry");
    });
  } finally {
    await page
      .evaluate(
        async (folderName, packId, userName) => {
          const top = game.folders.find((f) => f.type === "JournalEntry" && f.name === folderName && !f.folder);
          await top?.delete({ deleteSubfolders: true, deleteContents: true });
          for (const playlist of game.playlists.filter((one) => one.name.startsWith(folderName)))
            await playlist.delete();
          for (const message of game.messages.filter((one) => one.content.includes("foundry-mcp e2e:")))
            await message.delete();
          await game.users.getName(userName)?.delete();
          for (const scene of game.scenes.filter((one) => one.name.startsWith(folderName))) await scene.delete();
          for (const actor of game.actors.filter((one) => one.name.startsWith(folderName))) await actor.delete();
          delete globalThis.foundryMcpE2eRan;
          const pack = packId ? game.packs.get(packId) : null;
          if (pack?.locked) await pack.configure({ locked: false });
          await pack?.deleteCompendium();
        },
        documentFolder,
        worldPack.id,
        e2eUser
      )
      .catch((e) => console.log(`cleanup: generic documents delete failed: ${e.message}`));
  }

  await check(
    "with a wrong token in the page the module refuses the server and tool calls fail with no bridge",
    async () => {
      await page.evaluate((t) => game.settings.set("foundry-mcp", "token", t), randomBytes(32).toString("base64url"));
      const text = await eventually(async () => {
        const result = await client.callTool({ name: "get_scene", arguments: { sceneId } });
        const first = result.content[0]?.text ?? "";
        return result.isError && first.includes("No Foundry bridge is connected") ? first : null;
      }, "the no-bridge error");
      assert(text, "no no-bridge error");
      await eventually(
        () => pageLog.some((line) => line.includes("did not prove it knows the token")),
        "the page to log the failed server proof"
      );
    }
  );
} catch (error) {
  failed = true;
  if (!error.reported) console.log(`FAIL setup: ${error.stack ?? error}`);
} finally {
  if (page && sceneId) {
    await page
      .evaluate((id) => game.scenes.get(id)?.delete(), sceneId)
      .catch((e) => console.log(`cleanup: scene delete failed: ${e.message}`));
  }
  await browser?.close().catch(() => {});
  await client.close().catch(() => {});
  await rm(tokenDir, { recursive: true, force: true });
}

console.log(failed ? "e2e FAILED" : `e2e passed (${results.length + 1} checks)`);
process.exit(failed ? 1 : 0);
