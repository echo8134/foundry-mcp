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
