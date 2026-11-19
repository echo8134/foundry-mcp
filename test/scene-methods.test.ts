import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MethodError } from "../module/scripts/errors.mjs";
import { METHODS, QUEUE_BUDGET_MS } from "../module/scripts/methods.mjs";
import { timing } from "../module/scripts/world.mjs";
import { TOOLS } from "../src/tools.ts";
import { fakeWorld } from "./fake-world.ts";

type Method = (params: any) => Promise<any>;
const methods = METHODS as unknown as Record<
  | "get_scene"
  | "get_scene_image"
  | "list_scenes"
  | "ensure_scene"
  | "sync_walls"
  | "create_walls"
  | "delete_walls"
  | "sync_lights"
  | "sync_regions",
  Method
>;
const pristine = { budgets: { ...QUEUE_BUDGET_MS }, timing: { ...timing } };

const globals = globalThis as Record<string, unknown>;
const saved = {
  game: globals.game,
  canvas: globals.canvas,
  foundry: globals.foundry,
  CONST: globals.CONST,
  CONFIG: globals.CONFIG
};
afterEach(() => {
  Object.assign(globals, saved);
  Object.assign(QUEUE_BUDGET_MS, pristine.budgets);
  Object.assign(timing, pristine.timing);
});

const viaTool = (name: "ensure_scene" | "list_scenes", args: unknown) => methods[name](TOOLS[name].input.parse(args));

const refused = (code: string, message?: RegExp) => (error: unknown) =>
  error instanceof MethodError && error.code === code && (message?.test(error.message) ?? true);

describe("walls made by the bridge", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    world.install();
  });

  const line = {
    points: [
      [0, 0],
      [10, 0]
    ]
  };

  it("create_walls flags every wall as managed and get_scene reports it next to hand-drawn walls", async () => {
    world.addWall(scene, { c: [5, 5, 6, 6], light: 20, sight: 20, sound: 20, move: 20, door: 0 });
    await methods.create_walls({ sceneId: scene.id, paths: [line] });
    const walls = (await methods.get_scene({ sceneId: scene.id })).walls;
    assert.deepEqual(
      walls.map((wall: any) => wall.managed),
      [false, true]
    );
  });

  it("create_walls and sync_walls set the door state on every segment of a door path", async () => {
    const door = {
      points: [
        [0, 0],
        [10, 0],
        [10, 10]
      ],
      kind: "door",
      state: "locked"
    };
    const open = {
      points: [
        [20, 0],
        [30, 0]
      ],
      kind: "secret-door",
      state: "open"
    };
    const plain = {
      points: [
        [40, 0],
        [50, 0]
      ],
      kind: "door"
    };
    await methods.create_walls({ sceneId: scene.id, paths: [door, open, plain] });
    assert.deepEqual(
      scene.walls.map((wall: any) => [wall.door, wall.ds]),
      [
        [1, 2],
        [1, 2],
        [2, 1],
        [1, undefined]
      ]
    );
    await methods.sync_walls({ sceneId: scene.id, paths: [open] });
    assert.deepEqual(
      scene.walls.map((wall: any) => [wall.door, wall.ds]),
      [[2, 1]]
    );
  });

  it("sync_walls deletes only bridge-made walls and creates the given paths", async () => {
    const byHand = world.addWall(scene);
    await methods.create_walls({
      sceneId: scene.id,
      paths: [
        line,
        {
          points: [
            [0, 5],
            [10, 5]
          ]
        }
      ]
    });
    const result = await methods.sync_walls({
      sceneId: scene.id,
      paths: [
        {
          points: [
            [0, 9],
            [10, 9]
          ]
        }
      ]
    });
    assert.deepEqual(
      { ...result, ids: result.ids.length },
      { deleted: 2, created: 1, ids: 1, skipped: 0, sceneId: scene.id, sceneName: "Cellar" }
    );
    assert.equal(scene.walls.size, 2);
    assert.ok(scene.walls.has(byHand.id));
  });

  it("sync_walls run again with the same input leaves the same walls, also after a crash between delete and create", async () => {
    const input = {
      sceneId: scene.id,
      paths: [
        line,
        {
          points: [
            [0, 5],
            [10, 5]
          ]
        }
      ]
    };
    const shape = () => scene.walls.map((wall: any) => wall.c.join(",")).sort();
    await methods.sync_walls(input);
    const first = shape();
    const again = await methods.sync_walls(input);
    assert.deepEqual([again.deleted, again.created], [2, 2]);
    assert.deepEqual(shape(), first);

    for (const wall of scene.walls.filter((w: any) => w.flags["foundry-mcp"]?.managed)) scene.walls.delete(wall.id);
    await methods.sync_walls(input);
    assert.deepEqual(shape(), first);
  });

  it("sync_walls with no paths only removes the bridge-made walls", async () => {
    world.addWall(scene);
    await methods.create_walls({ sceneId: scene.id, paths: [line] });
    const result = await methods.sync_walls({ sceneId: scene.id, paths: [] });
    assert.deepEqual([result.deleted, result.created, result.ids], [1, 0, []]);
    assert.equal(scene.walls.size, 1);
  });

  it("sync_walls refuses unknown level ids before deleting anything", async () => {
    await methods.create_walls({ sceneId: scene.id, paths: [line] });
    await assert.rejects(
      methods.sync_walls({ sceneId: scene.id, paths: [line], levels: ["ghost"] }),
      refused("invalid_params", /ghost/)
    );
    assert.equal(scene.walls.size, 1);
  });

  it("sync_walls whose create is rejected leaves the walls it already made in place", async () => {
    await methods.sync_walls({ sceneId: scene.id, paths: [line] });
    const before = scene.walls.map((wall: any) => wall.id);
    world.control.wallCreateFails = true;
    await assert.rejects(
      methods.sync_walls({
        sceneId: scene.id,
        paths: [
          {
            points: [
              [0, 5],
              [10, 5]
            ]
          }
        ]
      }),
      /Wall validation failed/
    );
    assert.deepEqual(
      scene.walls.map((wall: any) => wall.id),
      before
    );
    assert.equal(world.log.wallDeletes, 0);
  });

  it("refuses a coordinate Foundry cannot store, for both wall tools, before anything is written", async () => {
    await methods.sync_walls({ sceneId: scene.id, paths: [line] });
    const before = scene.walls.map((wall: any) => wall.id);
    const log = { ...world.log };
    const overflow = {
      points: [
        [0, 0],
        [1e308, 0]
      ]
    };
    await assert.rejects(
      methods.sync_walls({ sceneId: scene.id, paths: [overflow] }),
      refused("invalid_params", /too large/)
    );
    await assert.rejects(
      methods.create_walls({ sceneId: scene.id, paths: [line, overflow] }),
      refused("invalid_params", /too large/)
    );
    await assert.rejects(
      methods.create_walls({
        sceneId: scene.id,
        paths: [
          {
            points: [
              [0, 0],
              [2 ** 60, 0]
            ]
          }
        ]
      }),
      refused("invalid_params")
    );
    assert.deepEqual(
      scene.walls.map((wall: any) => wall.id),
      before
    );
    assert.deepEqual(world.log, log);
  });

  it("sync_walls ends with exactly the new walls after a crash between creating them and deleting the old ones", async () => {
    const shape = () => scene.walls.map((wall: any) => wall.c.join(",")).sort();
    await methods.sync_walls({ sceneId: scene.id, paths: [line] });
    const next = {
      sceneId: scene.id,
      paths: [
        {
          points: [
            [0, 5],
            [10, 5]
          ]
        },
        {
          points: [
            [0, 9],
            [10, 9]
          ]
        }
      ]
    };
    world.control.wallDeleteFails = true;
    await assert.rejects(methods.sync_walls(next), /connection lost/);
    assert.equal(scene.walls.size, 3);
    world.control.wallDeleteFails = false;
    await methods.sync_walls(next);
    assert.deepEqual(shape(), ["0,5,10,5", "0,9,10,9"]);
  });

  it("two sync_walls calls in flight leave one copy of the walls", async () => {
    const slow = fakeWorld({ latency: 2 });
    const slowScene = slow.addScene({ name: "Slow", width: 1000, height: 800 });
    slow.install();
    const input = {
      sceneId: slowScene.id,
      paths: [
        line,
        {
          points: [
            [0, 5],
            [10, 5]
          ]
        }
      ]
    };
    await Promise.all([methods.sync_walls(input), methods.sync_walls(input)]);
    assert.equal(slowScene.walls.size, 2);
  });

  it("get_scene reports navName as an empty string for a scene that never had one", async () => {
    const result = await methods.get_scene({ sceneId: scene.id });
    assert.equal(result.navName, "");
    assert.equal("navName" in JSON.parse(JSON.stringify(result)), true);
  });

  it("get_scene reports navName and the folder path", async () => {
    const chapter = world.addFolder("Chapter 5");
    const holoth = world.addFolder("Holoth", chapter);
    const inside = world.addScene({ name: "Gates", navName: "Tor", folder: holoth.id });
    const result = await methods.get_scene({ sceneId: inside.id });
    assert.deepEqual([result.navName, result.folder], ["Tor", ["Chapter 5", "Holoth"]]);
    assert.deepEqual((await methods.get_scene({ sceneId: scene.id })).folder, []);
  });
});

describe("list_scenes", () => {
  it("lists scene folders and scenes with their folder path, grid, background, wall, light and token counts", async () => {
    const world = fakeWorld();
    const chapter = world.addFolder("Chapter 5");
    const holoth = world.addFolder("Holoth", chapter);
    world.addFolder("Journals", null, "JournalEntry");
    const gates = world.addScene({
      name: "Gates",
      folder: holoth.id,
      width: 2000,
      height: 1000,
      navName: "Tor",
      active: false
    });
    gates.initialLevel._source.background.src = "maps/gates.webp";
    world.addWall(gates);
    world.addWall(gates, { flags: { "foundry-mcp": { managed: true } } });
    world.addLight(gates);
    world.addLight(gates, { flags: { "foundry-mcp": { managed: true } } });
    world.addToken(gates);
    world.addToken(gates);
    world.addToken(gates, { flags: { "foundry-mcp": { managed: true } } });
    world.addScene({ name: "Hub", grid: { type: 0 } });
    world.install();

    const result = await methods.list_scenes({});
    assert.deepEqual(result.folders, [
      { id: chapter.id, path: ["Chapter 5"] },
      { id: holoth.id, path: ["Chapter 5", "Holoth"] }
    ]);
    const byName = Object.fromEntries(result.scenes.map((s: any) => [s.name, s]));
    assert.deepEqual(byName.Gates, {
      id: gates.id,
      name: "Gates",
      navName: "Tor",
      folder: ["Chapter 5", "Holoth"],
      active: false,
      viewed: false,
      width: 2000,
      height: 1000,
      shiftX: 0,
      shiftY: 0,
      grid: { type: "square", size: 100, distance: 5, units: "ft" },
      background: { src: "maps/gates.webp" },
      walls: { total: 2, managed: 1 },
      lights: { total: 2, managed: 1 },
      tokens: { total: 3, managed: 1 }
    });
    assert.deepEqual([byName.Hub.folder, byName.Hub.grid.type, byName.Hub.background], [[], "gridless", { src: null }]);
  });

  it("reports navName as an empty string for a scene that never had one, and an empty folder path lists everything", async () => {
    const world = fakeWorld();
    const chapter = world.addFolder("Chapter 5");
    world.addScene({ name: "Plain" });
    world.addScene({ name: "Filed", folder: chapter.id });
    world.install();
    const everything = await methods.list_scenes({});
    const root = await methods.list_scenes({ folder: [] });
    assert.deepEqual(root, everything);
    assert.deepEqual(root.scenes.map((s: any) => s.name).sort(), ["Filed", "Plain"]);
    assert.deepEqual(
      root.scenes.map((s: any) => s.navName),
      ["", ""]
    );
    assert.equal(root.folders.length, 1);
    assert.equal(JSON.stringify(root.scenes).includes('"navName":""'), true);
  });

  it("narrows to a folder and everything under it, and refuses a folder that does not exist", async () => {
    const world = fakeWorld();
    const chapter = world.addFolder("Chapter 5");
    const holoth = world.addFolder("Holoth", chapter);
    const other = world.addFolder("Chapter 6");
    world.addScene({ name: "Map", folder: chapter.id });
    world.addScene({ name: "Gates", folder: holoth.id });
    world.addScene({ name: "Elsewhere", folder: other.id });
    world.addScene({ name: "Root" });
    world.install();

    const narrowed = await methods.list_scenes({ folder: ["Chapter 5"] });
    assert.deepEqual(narrowed.scenes.map((s: any) => s.name).sort(), ["Gates", "Map"]);
    assert.deepEqual(
      narrowed.folders.map((f: any) => f.path),
      [["Chapter 5"], ["Chapter 5", "Holoth"]]
    );
    const deeper = await methods.list_scenes({ folder: ["Chapter 5", "Holoth"] });
    assert.deepEqual(
      deeper.scenes.map((s: any) => s.name),
      ["Gates"]
    );
    await assert.rejects(methods.list_scenes({ folder: ["Chapter 7"] }), refused("not_found", /Chapter 7/));
  });
});

describe("ensure_scene", () => {
  const create = {
    name: "Gates",
    folder: ["Chapter 5", "Holoth"],
    width: 2000,
    height: 1000,
    background: { src: "maps/gates.webp" }
  };

  it("creates the scene and the missing folders, not active, with a thumbnail from its background", async () => {
    const world = fakeWorld();
    world.addFolder("Chapter 5");
    world.install();
    const result = await methods.ensure_scene({ ...create, grid: { size: 50 }, globalLight: true, weather: "rain" });
    assert.deepEqual(result, {
      id: result.id,
      name: "Gates",
      folder: ["Chapter 5", "Holoth"],
      created: true,
      changed: ["name", "folder", "width", "height", "grid.size", "globalLight", "weather", "background.src"],
      unapplied: []
    });
    const scene = world.scenes.get(result.id);
    assert.equal(scene._source.active, false);
    assert.equal(scene._source.environment.globalLight.enabled, true);
    assert.equal(scene.initialLevel._source.background.src, "maps/gates.webp");
    assert.equal(scene.thumb, "thumb-of:maps/gates.webp:2000x1000");
    assert.equal(world.folders.size, 2);
    assert.equal(world.log.folderCreates, 1);
  });

  it("changes nothing when run a second time with the same input", async () => {
    const world = fakeWorld();
    world.install();
    const input = {
      ...create,
      grid: { type: "square", size: 50 },
      fogExploration: true,
      darkness: 0.5,
      navName: "Tor"
    };
    const first = await methods.ensure_scene(input);
    const before = JSON.stringify([...world.scenes.values()].map((s) => [s._source, s.initialLevel._source]));
    const log = { ...world.log };
    const second = await methods.ensure_scene(input);
    assert.deepEqual(second, { ...first, created: false, changed: [], unapplied: [] });
    assert.deepEqual(world.log, log);
    assert.equal(JSON.stringify([...world.scenes.values()].map((s) => [s._source, s.initialLevel._source])), before);
  });

  it("updates only what differs and renders the thumbnail only when the picture or size changed", async () => {
    const world = fakeWorld();
    world.install();
    const first = await methods.ensure_scene({ ...create, navName: "Tor" });
    const thumbnails = world.log.thumbnails;

    const named = await methods.ensure_scene({ ...create, navName: "Tor II", tokenVision: false });
    assert.deepEqual(named.changed, ["navName", "tokenVision"]);
    assert.equal(world.log.thumbnails, thumbnails);
    assert.equal(world.log.sceneCreates, 1);

    const repainted = await methods.ensure_scene({ ...create, background: { src: "maps/new.webp" } });
    assert.deepEqual([repainted.id, repainted.changed], [first.id, ["background.src"]]);
    assert.equal(world.log.thumbnails, thumbnails + 1);
    assert.equal(world.scenes.get(first.id).thumb, "thumb-of:maps/new.webp:2000x1000");

    await methods.ensure_scene({ ...create, background: { src: "maps/new.webp" }, width: 2400 });
    assert.equal(world.scenes.get(first.id).thumb, "thumb-of:maps/new.webp:2400x1000");
  });

  it("renders the missing thumbnail of an existing scene that has a background", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Old", width: 10, height: 10 });
    scene.initialLevel._source.background.src = "maps/old.webp";
    world.install();
    const result = await methods.ensure_scene({ sceneId: scene.id, name: "Old" });
    assert.deepEqual(result.changed, []);
    assert.equal(scene.thumb, "thumb-of:maps/old.webp:10x10");
  });

  it("rerun with a padded scene name and padded folder names changes nothing", async () => {
    const world = fakeWorld();
    world.install();
    const input = {
      name: "Gates ",
      folder: [" Chapter 5", "Holoth "],
      width: 2000,
      height: 1000,
      navName: " Tor ",
      grid: { units: "ft " }
    };
    const first = await viaTool("ensure_scene", input);
    const log = { ...world.log };
    for (let run = 0; run < 2; run++) {
      const again = await viaTool("ensure_scene", input);
      assert.deepEqual([again.id, again.created, again.changed, again.unapplied], [first.id, false, [], []]);
    }
    assert.deepEqual(world.log, log);
    assert.deepEqual([world.scenes.size, world.folders.size], [1, 2]);
    assert.deepEqual(
      [...world.scenes.values()].map((s) => s.name),
      ["Gates"]
    );
  });

  it("refuses a blank scene name before any folder is created", async () => {
    const world = fakeWorld();
    world.install();
    assert.throws(() => viaTool("ensure_scene", { name: " ", folder: ["New", "Deep"], width: 10, height: 10 }), /name/);
    assert.deepEqual([world.folders.size, world.scenes.size, world.log.folderCreates], [0, 0, 0]);
  });

  it("renders the thumbnail again on the next run when the render failed after a background change", async () => {
    const world = fakeWorld();
    world.install();
    const first = await methods.ensure_scene({ ...create, background: { src: "maps/old.webp" } });
    const scene = world.scenes.get(first.id);
    assert.equal(scene.flags["foundry-mcp"].thumbnailPending, false);
    assert.equal(scene.thumb, "thumb-of:maps/old.webp:2000x1000");

    world.control.thumbnailFails = true;
    await assert.rejects(
      methods.ensure_scene({ ...create, background: { src: "maps/new.webp" } }),
      refused("foundry_error", /no upload permission/)
    );
    assert.equal(scene.thumb, "thumb-of:maps/old.webp:2000x1000");
    assert.equal(scene.flags["foundry-mcp"].thumbnailPending, true);

    world.control.thumbnailFails = false;
    const retry = await methods.ensure_scene({ ...create, background: { src: "maps/new.webp" } });
    assert.deepEqual([retry.created, retry.changed], [false, []]);
    assert.equal(scene.thumb, "thumb-of:maps/new.webp:2000x1000");
    assert.equal(scene.flags["foundry-mcp"].thumbnailPending, false);
    const renders = world.log.thumbnails;
    await methods.ensure_scene({ ...create, background: { src: "maps/new.webp" } });
    assert.equal(world.log.thumbnails, renders);
  });

  it("marks the thumbnail pending in the same scene write as a size change, and also when only the background changes", async () => {
    const world = fakeWorld();
    world.install();
    const first = await methods.ensure_scene(create);
    const scene = world.scenes.get(first.id);
    world.control.thumbnailFails = true;
    await assert.rejects(methods.ensure_scene({ ...create, width: 2400 }), refused("foundry_error"));
    assert.deepEqual([scene._source.width, scene.flags["foundry-mcp"].thumbnailPending], [2400, true]);
    world.control.thumbnailFails = false;
    await methods.ensure_scene({ ...create, width: 2400 });
    assert.equal(scene.thumb, "thumb-of:maps/gates.webp:2400x1000");

    world.control.thumbnailFails = true;
    await assert.rejects(
      methods.ensure_scene({ ...create, width: 2400, background: { src: "maps/b.webp" } }),
      refused("foundry_error")
    );
    assert.equal(scene.flags["foundry-mcp"].thumbnailPending, true);
  });

  it("two overlapping calls into a new folder create it once, and the same call twice in flight creates one scene", async () => {
    const world = fakeWorld({ latency: 2 });
    world.install();
    const [gates, tower] = await Promise.all([
      methods.ensure_scene({ name: "Gates", folder: ["Chapter 5"], width: 100, height: 100 }),
      methods.ensure_scene({ name: "Tower", folder: ["Chapter 5"], width: 100, height: 100 })
    ]);
    assert.deepEqual([gates.folder, tower.folder, world.folders.size], [["Chapter 5"], ["Chapter 5"], 1]);

    const input = { name: "Hall", width: 100, height: 100, background: { src: "maps/a.webp" } };
    const [a, b] = await Promise.all([methods.ensure_scene(input), methods.ensure_scene(input)]);
    assert.deepEqual([a.created, b.created, a.id === b.id], [true, false, true]);
    assert.equal(world.scenes.size, 3);
  });

  it("a refused call does not stall the calls queued behind it, and reads do not wait for writes", async () => {
    const world = fakeWorld({ unloadable: ["maps/missing.webp"] });
    world.addScene({ name: "Existing", width: 10, height: 10 });
    let release!: () => void;
    world.control.textureGate = new Promise<void>((resolve) => (release = resolve));
    world.install();
    const stuck = methods.ensure_scene({ ...create, background: { src: "maps/missing.webp" } });
    const queued = methods.ensure_scene({ name: "Existing", navName: "x" });
    const listed = await methods.list_scenes({});
    assert.deepEqual(
      listed.scenes.map((s: any) => s.name),
      ["Existing"]
    );
    release();
    await assert.rejects(stuck, refused("invalid_params"));
    assert.equal((await queued).created, false);
  });

  it("passes the reposition option exactly when width, height, padding, shift or grid size change on an existing scene", async () => {
    const world = fakeWorld();
    world.install();
    const { id } = await methods.ensure_scene({ ...create, padding: 0.25, grid: { size: 100 } });
    assert.deepEqual(
      world.log.updateOptions.filter((o) => o?.autoReposition),
      []
    );
    const updateWith = async (fields: Record<string, unknown>) => {
      const before = world.log.updateOptions.length;
      const result = await methods.ensure_scene({ sceneId: id, ...fields });
      assert.equal(result.changed.length > 0, true);
      return world.log.updateOptions
        .slice(before)
        .filter((o) => !o || !("diff" in o))
        .map((o) => o?.autoReposition === true);
    };
    for (const fields of [
      { width: 2400 },
      { height: 1200 },
      { padding: 0.1 },
      { shiftX: 30 },
      { shiftY: -20 },
      { grid: { size: 50 } }
    ]) {
      assert.deepEqual(await updateWith(fields), [true], JSON.stringify(fields));
    }
    for (const fields of [
      { navName: "Tor" },
      { darkness: 0.5 },
      { tokenVision: false },
      { background: { src: "maps/b.webp" } },
      { name: "Renamed" }
    ]) {
      assert.deepEqual(await updateWith(fields), [false], JSON.stringify(fields));
    }
  });

  it("reports a darkness change that Foundry dropped under a darkness lock as unapplied, not changed", async () => {
    const world = fakeWorld();
    world.install();
    const { id } = await methods.ensure_scene({ ...create, darkness: 0.2 });
    world.scenes.get(id)._source.environment.darknessLock = true;
    const locked = await methods.ensure_scene({ ...create, darkness: 0.9, navName: "Tor" });
    assert.deepEqual([locked.changed, locked.unapplied], [["navName"], ["darkness"]]);
    assert.equal(world.scenes.get(id)._source.environment.darknessLevel, 0.2);
    world.scenes.get(id)._source.environment.darknessLock = false;
    const open = await methods.ensure_scene({ ...create, darkness: 0.9, navName: "Tor" });
    assert.deepEqual([open.changed, open.unapplied], [["darkness"], []]);
  });

  it("stores padding in the steps Foundry rounds to and reports nothing as changed on the rerun", async () => {
    const world = fakeWorld();
    world.install();
    for (const padding of [0.15, 0.35]) {
      await methods.ensure_scene({ ...create, padding });
      assert.equal([...world.scenes.values()][0]._source.padding, padding);
      assert.deepEqual((await methods.ensure_scene({ ...create, padding })).changed, []);
    }
  });

  it("finds a scene by exact name inside exactly the given folder", async () => {
    const world = fakeWorld();
    const chapter = world.addFolder("Chapter 5");
    const inFolder = world.addScene({ name: "Gates", folder: chapter.id, width: 10, height: 10 });
    const atRoot = world.addScene({ name: "Gates", width: 10, height: 10 });
    world.install();
    const a = await methods.ensure_scene({ name: "Gates", folder: ["Chapter 5"], navName: "A" });
    const b = await methods.ensure_scene({ name: "Gates", navName: "B" });
    assert.deepEqual([a.id, a.created, b.id, b.created], [inFolder.id, false, atRoot.id, false]);
    assert.deepEqual([inFolder.navName, atRoot.navName], ["A", "B"]);
  });

  it("refuses an ambiguous name and points to sceneId, and writes nothing", async () => {
    const world = fakeWorld();
    world.addScene({ name: "Gates" });
    world.addScene({ name: "Gates" });
    world.install();
    await assert.rejects(
      methods.ensure_scene({ name: "Gates", navName: "x" }),
      refused("invalid_params", /Pass a sceneId/)
    );
    assert.equal(world.log.sceneUpdates, 0);
  });

  it("refuses two same-named folders on the path", async () => {
    const world = fakeWorld();
    world.addFolder("Chapter 5");
    world.addFolder("Chapter 5");
    world.install();
    await assert.rejects(methods.ensure_scene({ ...create }), refused("invalid_params", /Chapter 5/));
    assert.equal(world.log.sceneCreates, 0);
  });

  it("renames and moves the scene it is given by id", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Draft", width: 10, height: 10 });
    world.install();
    const result = await methods.ensure_scene({ sceneId: scene.id, name: "Final", folder: ["Done"] });
    assert.deepEqual(result, {
      id: scene.id,
      name: "Final",
      folder: ["Done"],
      created: false,
      changed: ["name", "folder"],
      unapplied: []
    });
    const root = await methods.ensure_scene({ sceneId: scene.id, folder: [] });
    assert.deepEqual([root.folder, root.changed], [[], ["folder"]]);
    assert.equal(world.log.sceneCreates, 0);
  });

  it("answers not_found for an unknown sceneId", async () => {
    fakeWorld().install();
    await assert.rejects(methods.ensure_scene({ sceneId: "nope" }), refused("not_found"));
  });

  it("needs width and height to create but not to update", async () => {
    const world = fakeWorld();
    world.install();
    await assert.rejects(
      methods.ensure_scene({ name: "New", width: 100 }),
      refused("invalid_params", /width and height/)
    );
    assert.equal(world.scenes.size, 0);
    const scene = world.addScene({ name: "Old", width: 10, height: 10 });
    assert.equal((await methods.ensure_scene({ name: "Old", navName: "x" })).id, scene.id);
  });

  it("refuses a folder path deeper than Foundry's limit, an unknown weather key and an unloadable image, before writing", async () => {
    const world = fakeWorld({ unloadable: ["maps/missing.webp"] });
    world.install();
    await assert.rejects(
      methods.ensure_scene({ ...create, folder: ["a", "b", "c", "d", "e"] }),
      refused("invalid_params", /at most 4/)
    );
    await assert.rejects(
      methods.ensure_scene({ ...create, weather: "lava" }),
      refused("invalid_params", /lava.*rain, fog/)
    );
    await assert.rejects(methods.ensure_scene({ ...create, weather: "constructor" }), refused("invalid_params"));
    await assert.rejects(
      methods.ensure_scene({ ...create, background: { src: "maps/missing.webp" } }),
      refused("invalid_params", /maps\/missing\.webp/)
    );
    assert.deepEqual([world.scenes.size, world.folders.size], [0, 0]);
    await methods.ensure_scene({ ...create, folder: ["a", "b", "c", "d"], weather: "" });
    assert.equal(world.folders.size, 4);
  });

  it("reports a failed thumbnail as foundry_error after the scene was saved, and a rerun does not duplicate it", async () => {
    const world = fakeWorld({ thumbnailFails: true });
    world.install();
    await assert.rejects(
      methods.ensure_scene(create),
      refused("foundry_error", /scene was saved.*no upload permission/)
    );
    const again = await methods.ensure_scene({ ...create }).catch(() => null);
    assert.equal(again, null);
    assert.equal(world.log.sceneCreates, 1);
    assert.equal(world.scenes.size, 1);
  });
});

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<void>(() => {});
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};

describe("ensure_scene and the grid", () => {
  const input = {
    name: "Gates",
    width: 2000,
    height: 1000,
    grid: { size: 100 },
    background: { src: "maps/gates.webp" }
  };

  it("keeps the grid size when width grows and grid.size is given unchanged, writes once and then nothing", async () => {
    const world = fakeWorld();
    world.install();
    const { id } = await methods.ensure_scene(input);
    const scene = world.scenes.get(id);
    const wider = { ...input, width: 2400 };
    const runs = [];
    for (let run = 0; run < 3; run++) {
      const before = world.log.sceneUpdates;
      const result = await methods.ensure_scene(wider);
      runs.push({
        changed: result.changed,
        unapplied: result.unapplied,
        grid: scene._source.grid.size,
        writes: world.log.sceneUpdates - before
      });
    }
    assert.deepEqual(
      runs.map(({ changed, unapplied, grid }) => [changed, unapplied, grid]),
      [
        [["width"], [], 100],
        [[], [], 100],
        [[], [], 100]
      ]
    );
    assert.equal(runs[0]!.writes > 0, true);
    assert.deepEqual(
      runs.slice(1).map((run) => run.writes),
      [0, 0]
    );
  });

  it("changes the grid size only when a different one is given, and never as a side effect of the map size", async () => {
    const world = fakeWorld();
    world.install();
    const { id } = await methods.ensure_scene(input);
    const scene = world.scenes.get(id);
    await methods.ensure_scene({ sceneId: id, height: 1500 });
    assert.deepEqual([scene._source.height, scene._source.grid.size], [1500, 100]);
    const resized = await methods.ensure_scene({ sceneId: id, width: 3000, grid: { size: 150 } });
    assert.deepEqual([resized.changed, resized.unapplied, scene._source.grid.size], [["width", "grid.size"], [], 150]);
  });

  it("creates a scene of every grid type through the tool, reads the type back by name, and a rerun writes nothing", async () => {
    const world = fakeWorld();
    world.install();
    const types = ["gridless", "square", "hexOddR", "hexEvenR", "hexOddQ", "hexEvenQ"];
    for (const [code, type] of types.entries()) {
      const typed = { ...input, name: `Map ${type}`, grid: { type, size: 100 } };
      const { id, created } = await viaTool("ensure_scene", typed);
      const scene = world.scenes.get(id);
      const listed = (await viaTool("list_scenes", {})).scenes.find((entry: any) => entry.id === id);
      const writes = world.log.sceneUpdates;
      const again = await viaTool("ensure_scene", typed);
      assert.deepEqual(
        [
          created,
          scene._source.grid.type,
          (await methods.get_scene({ sceneId: id })).grid.type,
          listed.grid.type,
          again.changed,
          world.log.sceneUpdates - writes
        ],
        [true, code, type, type, [], 0],
        type
      );
    }
  });

  it("turns a square scene into a hex one by writing only grid.type, and refuses a grid type Foundry does not have", async () => {
    const world = fakeWorld();
    world.install();
    const { id } = await methods.ensure_scene({ ...input, grid: { type: "square", size: 100 } });
    const scene = world.scenes.get(id);
    const hex = await viaTool("ensure_scene", { sceneId: id, grid: { type: "hexOddQ", size: 100 } });
    assert.deepEqual([hex.changed, hex.unapplied, scene._source.grid.type], [["grid.type"], [], 4]);
    assert.throws(() => viaTool("ensure_scene", { sceneId: id, grid: { type: "hex" } }), /grid/);
  });

  it("moves what is placed on the scene with the map and keeps it in the same place on it", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Hall", width: 1000, height: 800, padding: 0.25 });
    world.install();
    await methods.sync_walls({
      sceneId: scene.id,
      paths: [
        {
          points: [
            [100, 100],
            [900, 100]
          ]
        }
      ]
    });
    await methods.sync_lights({ sceneId: scene.id, lights: [{ at: [500, 400], dim: 20 }] });
    const read = async () => {
      const { walls, lights } = await methods.get_scene({ sceneId: scene.id });
      return { wall: walls[0].c, light: lights[0].at, grid: scene._source.grid.size };
    };
    assert.deepEqual(await read(), { wall: [100, 100, 900, 100], light: [500, 400], grid: 100 });
    await methods.ensure_scene({ sceneId: scene.id, width: 2000, grid: { size: 100 } });
    assert.deepEqual(await read(), { wall: [200, 100, 1800, 100], light: [1000, 400], grid: 100 });
  });
});

describe("ensure_scene and the map shift", () => {
  it("moves placed walls and lights with the map on a shift-only change, and reads the shift back", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Hall", width: 1000, height: 800, padding: 0.25 });
    world.install();
    await methods.sync_walls({
      sceneId: scene.id,
      paths: [
        {
          points: [
            [100, 100],
            [900, 100]
          ]
        }
      ]
    });
    await methods.sync_lights({ sceneId: scene.id, lights: [{ at: [500, 400], dim: 20 }] });
    assert.deepEqual([[...scene.walls.values()][0].c, [...scene.lights.values()][0].x], [[400, 300, 1200, 300], 800]);

    const result = await methods.ensure_scene({ sceneId: scene.id, shiftX: 30, shiftY: -20 });
    assert.deepEqual([result.changed, result.unapplied], [["shiftX", "shiftY"], []]);
    assert.equal(world.log.updateOptions.at(-1).autoReposition, true);
    const read = await methods.get_scene({ sceneId: scene.id });
    assert.deepEqual([read.shiftX, read.shiftY], [30, -20]);
    assert.deepEqual(
      [read.walls[0].c, read.lights[0].at],
      [
        [100, 100, 900, 100],
        [500, 400]
      ]
    );
    assert.deepEqual([...scene.walls.values()][0].c, [370, 320, 1170, 320]);
    assert.deepEqual((await methods.ensure_scene({ sceneId: scene.id, shiftX: 30, shiftY: -20 })).changed, []);
    const listed = (await methods.list_scenes({})).scenes[0];
    assert.deepEqual([listed.shiftX, listed.shiftY], [30, -20]);
  });

  it("reports a shift that Foundry stores as null as 0, and treats an ensure of 0 as already set, on either axis", async () => {
    const world = fakeWorld();
    const x = world.addScene({ name: "Hall X", width: 1000, height: 800, padding: 0.25, shiftX: null });
    const y = world.addScene({ name: "Hall Y", width: 1000, height: 800, padding: 0.25, shiftY: null });
    world.install();
    for (const scene of [x, y]) {
      const read = await methods.get_scene({ sceneId: scene.id });
      const listed = (await methods.list_scenes({})).scenes.find((entry: any) => entry.id === scene.id);
      assert.deepEqual([read.shiftX, read.shiftY, listed.shiftX, listed.shiftY], [0, 0, 0, 0], scene.name);
      assert.deepEqual(
        (await methods.ensure_scene({ sceneId: scene.id, shiftX: 0, shiftY: 0 })).changed,
        [],
        scene.name
      );
    }
    assert.equal(world.log.sceneUpdates, 0);
  });

  it("refuses a shift beyond the padding without writing, on update and on create", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Hall", width: 1000, height: 800, padding: 0 });
    world.install();
    const message =
      /shiftX 30 would leave 30 px of the map outside the canvas.*shiftX can be from 0 to 0.*raise padding/;
    await assert.rejects(methods.ensure_scene({ sceneId: scene.id, shiftX: 30 }), refused("invalid_params", message));
    await assert.rejects(
      methods.ensure_scene({ sceneId: scene.id, shiftY: -5 }),
      refused("invalid_params", /shiftY -5 would leave 5 px/)
    );
    await assert.rejects(
      methods.ensure_scene({ name: "New", folder: ["Fresh"], width: 1000, height: 800, padding: 0, shiftX: 30 }),
      refused("invalid_params", message)
    );
    assert.deepEqual(
      [scene.shiftX, world.log.sceneUpdates, world.log.sceneCreates, world.log.folderCreates],
      [0, 0, 0, 0]
    );
  });

  it("allows the same shift once the padding covers it", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Hall", width: 1000, height: 800, padding: 0 });
    world.install();
    const result = await methods.ensure_scene({ sceneId: scene.id, shiftX: 30, padding: 0.25 });
    assert.deepEqual([result.changed, scene.shiftX], [["padding", "shiftX"], 30]);
    assert.equal((await methods.ensure_scene({ name: "New", width: 1000, height: 800, shiftX: -300 })).created, true);
    await assert.rejects(
      methods.ensure_scene({ name: "Other", width: 1000, height: 800, shiftX: 301 }),
      refused("invalid_params", /shiftX 301 would leave 1 px.*shiftX can be from -300 to 300/)
    );
  });

  it("refuses a padding change that would put a stored shift outside the canvas", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Hall", width: 1000, height: 800, padding: 0.25, shiftX: 200 });
    world.install();
    await assert.rejects(
      methods.ensure_scene({ sceneId: scene.id, padding: 0.05 }),
      refused("invalid_params", /shiftX 200 would leave 100 px.*shiftX can be from -100 to 100/)
    );
    assert.equal(scene._source.padding, 0.25);
    assert.equal((await methods.ensure_scene({ sceneId: scene.id, padding: 0.2 })).created, false);
  });

  it("checks a stored shift against the grid size, width and height of the call", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Hall", width: 1000, height: 800, padding: 0.25, shiftX: 280, shiftY: 180 });
    world.install();
    const cases: [Record<string, any>, RegExp][] = [
      [{ grid: { size: 50 } }, /shiftX 280 would leave 30 px.*shiftX can be from -250 to 250/],
      [{ width: 600 }, /shiftX 280 would leave 80 px.*shiftX can be from -200 to 200/],
      [{ height: 400 }, /shiftY 180 would leave 80 px.*shiftY can be from -100 to 100/]
    ];
    for (const [fields, message] of cases) {
      await assert.rejects(
        methods.ensure_scene({ sceneId: scene.id, ...fields }),
        refused("invalid_params", message),
        JSON.stringify(fields)
      );
    }
    assert.equal(world.log.sceneUpdates, 0);
    assert.deepEqual((await methods.ensure_scene({ sceneId: scene.id, grid: { size: 100 } })).changed, []);
  });

  it("builds the probe from the stored-form change: a grid type given by name is encoded, and an unusable one is a foundry_error", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Hall", width: 1000, height: 800, padding: 0.25 });
    const broken = world.addScene({ name: "Broken", width: 1000, height: 800, grid: { type: "broken" } });
    world.install();
    assert.deepEqual(
      (await methods.ensure_scene({ sceneId: scene.id, grid: { type: "gridless" }, shiftX: 10 })).changed,
      ["shiftX", "grid.type"]
    );
    assert.equal(
      (await methods.ensure_scene({ name: "New", width: 1000, height: 800, grid: { type: "gridless" } })).created,
      true
    );
    await assert.rejects(
      methods.ensure_scene({ sceneId: broken.id, shiftX: 1 }),
      refused("foundry_error", /could not work out the scene dimensions.*Nothing was changed/)
    );
    assert.equal(broken._source.shiftX, 0);
  });

  it("does not hold an unrelated change against a shift that already clips", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Hall", width: 1000, height: 800, padding: 0, shiftX: 30 });
    world.install();
    assert.deepEqual((await methods.ensure_scene({ sceneId: scene.id, navName: "Saal" })).changed, ["navName"]);
  });

  it("refuses ensure_scene fields it does not know, naming them, before anything is written", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Hall", width: 1000, height: 800 });
    world.install();
    await assert.rejects(
      methods.ensure_scene({ sceneId: scene.id, shiftZ: 30 }),
      refused("invalid_params", /does not know the ensure_scene field shiftZ.*reload Foundry/)
    );
    await assert.rejects(
      methods.ensure_scene({ name: "N", width: 1, height: 1, grid: { shape: 1, size: 50 }, rotation: 3 }),
      refused("invalid_params", /fields grid\.shape, rotation/)
    );
    assert.deepEqual([world.log.sceneUpdates, world.log.sceneCreates], [0, 0]);
    assert.deepEqual(
      (await methods.ensure_scene({ sceneId: scene.id, grid: { size: 100 }, background: { src: "a.webp" } })).unapplied,
      []
    );
  });

  it("puts frame coordinates on the shifted map", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Hall", width: 1000, height: 800, padding: 0.25, shiftX: 30, shiftY: -20 });
    world.install();
    await methods.sync_walls({
      sceneId: scene.id,
      paths: [
        {
          points: [
            [0, 0],
            [1000, 0]
          ]
        }
      ]
    });
    assert.deepEqual([...scene.walls.values()][0].c, [270, 220, 1270, 220]);
  });
});

describe("ensure_scene and thumbnails", () => {
  const create = { name: "Gates", width: 100, height: 100 };

  it("does not store a thumbnail rendered without its background, and keeps the call retryable", async () => {
    const world = fakeWorld({ unloadable: ["maps/gone.webp"] });
    const scene = world.addScene({
      name: "Old",
      width: 10,
      height: 10,
      flags: { "foundry-mcp": { thumbnailPending: true } }
    });
    scene.initialLevel._source.background.src = "maps/gone.webp";
    world.install();
    await assert.rejects(
      methods.ensure_scene({ sceneId: scene.id, navName: "x" }),
      refused("foundry_error", /maps\/gone\.webp.*could not be loaded/)
    );
    assert.deepEqual([scene.thumb, scene.flags["foundry-mcp"].thumbnailPending, world.log.thumbnails], [null, true, 0]);
  });

  it("does not mark a scene without a background as pending, so a rerun writes nothing", async () => {
    const world = fakeWorld();
    world.install();
    const { id } = await methods.ensure_scene(create);
    const scene = world.scenes.get(id);
    assert.equal(scene.flags["foundry-mcp"]?.thumbnailPending, undefined);
    await methods.ensure_scene({ ...create, width: 200 });
    assert.equal(scene.flags["foundry-mcp"]?.thumbnailPending, undefined);
    const before = world.log.sceneUpdates;
    const again = await methods.ensure_scene({ ...create, width: 200 });
    assert.deepEqual([again.changed, world.log.thumbnails, world.log.sceneUpdates - before], [[], 0, 0]);
  });

  it("marks a scene pending when only the size changes and the background is already stored", async () => {
    const world = fakeWorld({ thumbnailFails: true });
    const scene = world.addScene({ name: "Old", width: 100, height: 100 });
    scene.initialLevel._source.background.src = "maps/stored.webp";
    scene._source.thumb = "thumb-before";
    world.install();
    await assert.rejects(
      methods.ensure_scene({ sceneId: scene.id, width: 200 }),
      refused("foundry_error", /could not render its thumbnail/)
    );
    assert.equal(scene.flags["foundry-mcp"].thumbnailPending, true);
    world.control.thumbnailFails = false;
    const again = await methods.ensure_scene({ sceneId: scene.id, width: 200 });
    assert.deepEqual(
      [again.changed, world.log.thumbnails, scene.flags["foundry-mcp"].thumbnailPending, scene.thumb],
      [[], 1, false, "thumb-of:maps/stored.webp:200x100"]
    );
  });

  it("renders the thumbnail again when only the size changes and the background is already stored", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Old", width: 100, height: 100 });
    scene.initialLevel._source.background.src = "maps/stored.webp";
    scene._source.thumb = "thumb-before";
    world.install();
    await methods.ensure_scene({ sceneId: scene.id, width: 200 });
    assert.deepEqual(
      [world.log.thumbnails, scene.thumb, scene.flags["foundry-mcp"].thumbnailPending],
      [1, "thumb-of:maps/stored.webp:200x100", false]
    );
  });

  it("still marks a scene pending when a background is given with the first write", async () => {
    const world = fakeWorld({ thumbnailFails: true });
    world.install();
    await assert.rejects(
      methods.ensure_scene({ ...create, background: { src: "maps/a.webp" } }),
      refused("foundry_error")
    );
    assert.equal([...world.scenes.values()][0].flags["foundry-mcp"].thumbnailPending, true);
  });
});

describe("the write queue", () => {
  const line = {
    points: [
      [0, 0],
      [10, 0]
    ]
  };
  const stair = { name: "Stair", shapes: [{ type: "rectangle", x: 0, y: 0, width: 100, height: 100 }] };
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  const open: (() => void)[] = [];
  /** A gate that afterEach opens, so that a call a test left running settles and the shared queue is idle again. */
  const held = () => {
    const held = gate();
    open.push(held.open);
    return held;
  };
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    world.install();
  });
  afterEach(async () => {
    for (const release of open.splice(0)) release();
    await pause(20);
  });

  function occupy() {
    const hold = held();
    world.control.thumbnailGate = hold.promise;
    return { hold, running: methods.ensure_scene({ sceneId: scene.id, background: { src: "maps/a.webp" } }) };
  }

  it("runs writes in the order their requests arrived, also when the first one's prepare is slow: a resize and then walls in the new pixels", async () => {
    scene.initialLevel._source.background.src = "maps/hall.webp";
    scene._source.thumb = "x";
    const slowImage = held();
    world.control.textureGate = slowImage.promise;
    const resized = methods.ensure_scene({
      sceneId: scene.id,
      width: 2000,
      height: 1600,
      grid: { size: 200 },
      background: { src: "maps/hall@2x.webp" }
    });
    const walls = methods.sync_walls({
      sceneId: scene.id,
      paths: [
        {
          points: [
            [100, 100],
            [1900, 100]
          ]
        }
      ]
    });
    await pause(10);
    slowImage.open();
    await Promise.all([resized, walls]);
    assert.deepEqual(
      scene.walls.map((wall: any) => wall.c),
      [[100, 100, 1900, 100]]
    );
  });

  it("finds the scene it just created when a rename arrives right behind the create, even though the create has a slow background to load", async () => {
    const slowImage = held();
    world.control.textureGate = slowImage.promise;
    const created = methods.ensure_scene({
      name: "Gates",
      width: 100,
      height: 100,
      background: { src: "maps/a.webp" }
    });
    const renamed = methods.ensure_scene({ name: "Gates", navName: "Tor" });
    await pause(10);
    slowImage.open();
    const [first, second] = await Promise.all([created, renamed]);
    assert.deepEqual([first.created, second.created, first.id === second.id], [true, false, true]);
    assert.deepEqual(
      [...world.scenes.values()].filter((s: any) => s.name === "Gates").map((s: any) => s.navName),
      ["Tor"]
    );
  });

  it("never runs three calls into a new folder side by side after a hang, and creates the folder once", async () => {
    world = fakeWorld({ latency: 20 });
    const old = world.addScene({ name: "Old", width: 1000, height: 800 });
    old.initialLevel._source.background.src = "maps/old.webp";
    world.install();
    QUEUE_BUDGET_MS.ensure_scene = 200;
    const hang = held();
    old.createThumbnail = () => hang.promise.then(() => ({ thumb: "late" }));
    const hung = methods.ensure_scene({ sceneId: old.id, width: 1001 });
    await pause(30);
    const batch = [];
    for (const name of ["Gates", "Tower", "Bridge"]) {
      batch.push(methods.ensure_scene({ name, folder: ["Chapter 5"], width: 100, height: 100 }));
      await pause(5);
    }
    const outcomes = await Promise.allSettled([hung, ...batch]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["rejected", "rejected", "rejected", "rejected"]
    );
    assert.deepEqual([world.folders.size, world.log.folderCreates], [0, 0]);
    hang.open();
    await pause(30);
    const rerun = await Promise.all(
      ["Gates", "Tower", "Bridge"].map((name) =>
        methods.ensure_scene({ name, folder: ["Chapter 5"], width: 100, height: 100 })
      )
    );
    assert.deepEqual(
      [world.folders.size, rerun.map((r: any) => r.folder.join("/"))],
      [1, ["Chapter 5", "Chapter 5", "Chapter 5"]]
    );
  });

  it("answers a waiting call at its own deadline, with nothing written", async () => {
    QUEUE_BUDGET_MS.create_walls = 60;
    const { hold, running } = occupy();
    const arrived = Date.now();
    await assert.rejects(
      methods.create_walls({ sceneId: scene.id, paths: [line] }),
      refused("foundry_error", /create_walls expired in the queue.*was not applied/)
    );
    const waited = Date.now() - arrived;
    assert.ok(waited >= 50 && waited < 300, `answered after ${waited} ms`);
    assert.equal(world.control.thumbnailGate, hold.promise);
    hold.open();
    await running;
    assert.deepEqual([scene.walls.size, world.log.wallCreates], [0, 0]);
  });

  it("does not start a call that has less than half of its budget left when its turn comes", async () => {
    QUEUE_BUDGET_MS.create_walls = 100;
    const { hold, running } = occupy();
    const late = methods.create_walls({ sceneId: scene.id, paths: [line] });
    await pause(70);
    hold.open();
    await running;
    await assert.rejects(
      late,
      refused("foundry_error", /create_walls waited.*less than half of its.*not started and was not applied/)
    );
    assert.deepEqual([scene.walls.size, world.log.wallCreates], [0, 0]);
    assert.equal((await methods.create_walls({ sceneId: scene.id, paths: [line] })).created, 1);
  });

  describe("when a running call overruns its budget", () => {
    it("answers it at its deadline, refuses new writes at once naming it, still answers reads, and goes on when it ends", async () => {
      QUEUE_BUDGET_MS.ensure_scene = 40;
      const { hold, running } = occupy();
      await assert.rejects(
        running,
        refused("foundry_error", /ensure_scene did not finish within.*may still be running.*starts no other write/)
      );

      const arrived = Date.now();
      await assert.rejects(
        methods.create_walls({ sceneId: scene.id, paths: [line] }),
        refused(
          "foundry_error",
          /create_walls was refused at once and was not applied: ensure_scene has been running for .*Gamemaster should reload Foundry/
        )
      );
      assert.ok(Date.now() - arrived < 30);
      await assert.rejects(
        methods.sync_lights({ sceneId: scene.id, lights: [] }),
        refused("foundry_error", /sync_lights was refused at once.*ensure_scene/)
      );
      assert.equal((await methods.get_scene({ sceneId: scene.id })).id, scene.id);
      assert.equal((await methods.list_scenes({})).scenes.length, 1);

      hold.open();
      await pause(20);
      assert.equal((await methods.create_walls({ sceneId: scene.id, paths: [line] })).created, 1);
    });

    it("answers a call that waits behind it at its own deadline with the same refusal", async () => {
      QUEUE_BUDGET_MS.ensure_scene = 40;
      QUEUE_BUDGET_MS.sync_walls = 120;
      const { running } = occupy();
      const waiting = methods.sync_walls({ sceneId: scene.id, paths: [line] });
      await assert.rejects(running, refused("foundry_error", /did not finish within/));
      await assert.rejects(
        waiting,
        refused("foundry_error", /sync_walls expired in the queue and was not applied: ensure_scene has been running/)
      );
      assert.equal(scene.walls.size, 0);
    });

    it("leaves no documents beside a later successful sync: the late call finishes before any other sync runs", async () => {
      world = fakeWorld({ latency: 5 });
      scene = world.addScene({ name: "Hall", width: 1000, height: 800 });
      world.install();
      QUEUE_BUDGET_MS.sync_walls = 120;
      const at = (y: number) => [
        {
          points: [
            [0, y],
            [10, y]
          ]
        }
      ];
      await methods.sync_walls({ sceneId: scene.id, paths: at(0) });
      const realCreate = scene.createEmbeddedDocuments;
      const slow = held();
      let slowOnce = true;
      scene.createEmbeddedDocuments = async (name: string, data: any[]) => {
        if (slowOnce) {
          slowOnce = false;
          await slow.promise;
        }
        return realCreate.call(scene, name, data);
      };
      await assert.rejects(
        methods.sync_walls({ sceneId: scene.id, paths: at(1) }),
        refused("foundry_error", /did not finish within/)
      );
      await assert.rejects(
        methods.sync_walls({ sceneId: scene.id, paths: at(2) }),
        refused("foundry_error", /refused at once/)
      );
      slow.open();
      await pause(40);
      assert.deepEqual(
        scene.walls.map((wall: any) => wall.c[1]),
        [1]
      );
      await methods.sync_walls({ sceneId: scene.id, paths: at(2) });
      await pause(40);
      assert.deepEqual(
        scene.walls.map((wall: any) => wall.c[1]),
        [2]
      );
    });
  });

  it("runs the checks that need no lock when the request arrives, while another write still holds the queue", async () => {
    world = fakeWorld({ unloadable: ["maps/missing.webp"] });
    scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    world.install();
    const { hold, running } = occupy();
    const unknownLevel = methods.create_walls({ sceneId: scene.id, paths: [line], levels: ["ghost"] });
    const unknownWeather = methods.ensure_scene({ name: "Other", weather: "plague" });
    const unknownImage = methods.ensure_scene({
      name: "Other",
      width: 10,
      height: 10,
      background: { src: "maps/missing.webp" }
    });
    const unknownAnimation = methods.sync_lights({
      sceneId: scene.id,
      lights: [{ at: [1, 1], dim: 5, animation: { type: "nope" } }]
    });
    const deep = methods.ensure_scene({ name: "Deep", folder: ["1", "2", "3", "4", "5"], width: 10, height: 10 });
    const seen = await Promise.race([
      Promise.allSettled([unknownLevel, unknownWeather, unknownImage, unknownAnimation, deep]),
      pause(300).then(() => "still waiting for the turn")
    ]);
    assert.notEqual(seen, "still waiting for the turn");
    assert.ok(Array.isArray(seen));
    assert.deepEqual(
      seen.map((outcome) => outcome.status),
      Array(5).fill("rejected")
    );
    assert.deepEqual(
      seen.map((outcome) => (outcome as PromiseRejectedResult).reason.code),
      Array(5).fill("invalid_params")
    );
    hold.open();
    await running;
  });

  it("makes every world-changing method wait behind a running write, delete_walls included", async () => {
    const wall = world.addWall(scene);
    const calls: [string, () => Promise<any>][] = [
      ["create_walls", () => methods.create_walls({ sceneId: scene.id, paths: [line] })],
      ["delete_walls", () => methods.delete_walls({ sceneId: scene.id, ids: [wall.id] })],
      ["sync_walls", () => methods.sync_walls({ sceneId: scene.id, paths: [line] })],
      ["sync_lights", () => methods.sync_lights({ sceneId: scene.id, lights: [{ at: [10, 10], dim: 5 }] })],
      ["sync_regions", () => methods.sync_regions({ sceneId: scene.id, regions: [stair] })]
    ];
    const writes = () => [
      world.log.wallCreates,
      world.log.wallDeletes,
      world.log.lightCreates,
      world.log.lightDeletes,
      world.log.documentWrites.length
    ];
    for (const [name, call] of calls) {
      const hold = held();
      world.control.thumbnailGate = hold.promise;
      const running = methods.ensure_scene({ sceneId: scene.id, background: { src: `maps/${name}.webp` } });
      await pause(20);
      const before = writes();
      const queued = call();
      await pause(40);
      assert.deepEqual(writes(), before, `${name} wrote while another write was running`);
      hold.open();
      await Promise.all([running, queued]);
      assert.notDeepEqual(writes(), before, `${name} wrote once its turn came`);
    }
  });

  it("fixes the scene a call without sceneId means when the request arrives, not when its turn comes", async () => {
    const other = world.addScene({ name: "Other", width: 1000, height: 800 });
    const calls: [string, () => Promise<any>][] = [
      ["create_walls", () => methods.create_walls({ paths: [line] })],
      ["sync_walls", () => methods.sync_walls({ paths: [line] })],
      ["sync_lights", () => methods.sync_lights({ lights: [{ at: [10, 10], dim: 5 }] })],
      ["sync_regions", () => methods.sync_regions({ regions: [stair] })],
      ["delete_walls", () => methods.delete_walls({ all: true })]
    ];
    for (const [name, call] of calls) {
      const slow = held();
      world.control.thumbnailGate = slow.promise;
      (globals.canvas as any).scene = scene;
      const running = methods.ensure_scene({ sceneId: scene.id, background: { src: `maps/${name}.webp` } });
      await pause(20);
      const queued = call();
      (globals.canvas as any).scene = other;
      slow.open();
      await running;
      assert.equal((await queued).sceneId, scene.id, name);
      assert.deepEqual([other.walls.size, other.lights.size, other.regions.size], [0, 0, 0], name);
    }
  });

  it("gives up on a background image that does not load in time, before anything is written", async () => {
    timing.textureLoadMs = 30;
    world.control.textureGate = never();
    await assert.rejects(
      methods.ensure_scene({ name: "New", width: 10, height: 10, background: { src: "maps/slow.webp" } }),
      refused("foundry_error", /maps\/slow\.webp did not load within/)
    );
    assert.deepEqual([world.log.sceneCreates, world.log.folderCreates], [0, 0]);
    scene.initialLevel._source.background.src = "maps/slow.webp";
    await assert.rejects(
      methods.get_scene_image({ sceneId: scene.id }),
      refused("foundry_error", /maps\/slow\.webp did not load within/)
    );
  });
});

describe("walls that cannot be stored or drawn", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    world.install();
  });
  const line = {
    points: [
      [0, 0],
      [10, 0]
    ]
  };

  it("refuses points that overflow to the same Infinity instead of counting the segment as skipped", async () => {
    await methods.sync_walls({ sceneId: scene.id, paths: [line] });
    const before = scene.walls.map((wall: any) => wall.id);
    const log = { ...world.log };
    const overflow = {
      points: [
        [1e308, 0],
        [1.5e308, 0]
      ]
    };
    await assert.rejects(
      methods.sync_walls({ sceneId: scene.id, paths: [overflow] }),
      refused("invalid_params", /too large/)
    );
    await assert.rejects(
      methods.create_walls({ sceneId: scene.id, paths: [overflow] }),
      refused("invalid_params", /too large/)
    );
    await assert.rejects(
      methods.sync_walls({
        sceneId: scene.id,
        paths: [
          {
            points: [
              [5, 5],
              [5, 5]
            ]
          },
          overflow
        ]
      }),
      refused("invalid_params", /too large/)
    );
    assert.deepEqual(
      scene.walls.map((wall: any) => wall.id),
      before
    );
    assert.deepEqual(world.log, log);
  });

  it("refuses a sync whose given paths all collapse to points, and still removes the walls for empty paths", async () => {
    await methods.sync_walls({ sceneId: scene.id, paths: [line] });
    const before = scene.walls.map((wall: any) => wall.id);
    const log = { ...world.log };
    const tooBig = {
      frame: { width: 1e7, height: 1e7 },
      paths: [
        {
          points: [
            [10, 10],
            [900, 10],
            [900, 700]
          ]
        }
      ]
    };
    await assert.rejects(
      methods.sync_walls({ sceneId: scene.id, ...tooBig }),
      refused("invalid_params", /collapses to a point/)
    );
    assert.deepEqual(
      scene.walls.map((wall: any) => wall.id),
      before
    );
    assert.deepEqual(world.log, log);
    assert.equal((await methods.create_walls({ sceneId: scene.id, ...tooBig })).created, 0);
    assert.equal((await methods.sync_walls({ sceneId: scene.id, paths: [] })).deleted, 1);
  });
});

describe("a create that resolves with fewer walls than asked", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    world.install();
  });
  const paths = [
    {
      points: [
        [0, 5],
        [10, 5]
      ]
    },
    {
      points: [
        [0, 9],
        [10, 9]
      ]
    }
  ];

  it("sync_walls deletes the walls it just made, leaves the old ones and says how many Foundry created", async () => {
    await methods.sync_walls({
      sceneId: scene.id,
      paths: [
        {
          points: [
            [0, 0],
            [10, 0]
          ]
        }
      ]
    });
    const before = scene.walls.map((wall: any) => wall.id);
    world.control.vetoWall = (wall) => wall.c[1] === 9;
    await assert.rejects(
      methods.sync_walls({ sceneId: scene.id, paths }),
      refused("foundry_error", /created 1 of 2 walls.*deleted again.*existing walls were left/)
    );
    assert.deepEqual(
      scene.walls.map((wall: any) => wall.id),
      before
    );
    world.control.vetoWall = () => true;
    await assert.rejects(
      methods.sync_walls({ sceneId: scene.id, paths }),
      refused("foundry_error", /created 0 of 2 walls/)
    );
    assert.deepEqual(
      scene.walls.map((wall: any) => wall.id),
      before
    );
  });

  it("says so when the partial set cannot be deleted either, and the next sync clears it up", async () => {
    await methods.sync_walls({
      sceneId: scene.id,
      paths: [
        {
          points: [
            [0, 0],
            [10, 0]
          ]
        }
      ]
    });
    world.control.vetoWall = (wall) => wall.c[1] === 9;
    world.control.wallDeleteFails = true;
    await assert.rejects(
      methods.sync_walls({ sceneId: scene.id, paths }),
      refused("foundry_error", /could not be deleted again \(connection lost\)/)
    );
    assert.equal(scene.walls.size, 2);
    world.control.vetoWall = null;
    world.control.wallDeleteFails = false;
    await methods.sync_walls({ sceneId: scene.id, paths });
    assert.deepEqual(scene.walls.map((wall: any) => wall.c.join(",")).sort(), ["0,5,10,5", "0,9,10,9"]);
  });

  it("create_walls reports the number Foundry created next to the number asked", async () => {
    world.control.vetoWall = (wall) => wall.c[1] === 9;
    const result = await methods.create_walls({ sceneId: scene.id, paths });
    assert.deepEqual([result.created, result.requested, result.ids.length], [1, 2, 1]);
    world.control.vetoWall = null;
    assert.deepEqual([(await methods.create_walls({ sceneId: scene.id, paths })).requested, scene.walls.size], [2, 3]);
  });

  it("says how many of the new walls were really removed when Foundry deletes fewer than asked, and the next sync clears the rest", async () => {
    const at = (y: number) => ({
      points: [
        [0, y],
        [10, y]
      ]
    });
    await methods.sync_walls({ sceneId: scene.id, paths: [at(0)] });
    world.control.vetoWall = (wall) => wall.c[1] === 9;
    const realDelete = scene.deleteEmbeddedDocuments;
    scene.deleteEmbeddedDocuments = (name: string, ids: string[]) => realDelete.call(scene, name, ids.slice(0, 1));
    const oldIds = new Set(scene.walls.keys());
    const error = await methods.sync_walls({ sceneId: scene.id, paths: [at(5), at(7), at(9)] }).then(
      () => assert.fail("expected a refusal"),
      (e: Error) => e
    );
    assert.match(
      error.message,
      /created 2 of 3 walls.*Only 1 of the 2 it did create were deleted again.*1 remain.*flagged as bridge-made.*next sync of the same level set removes them \(ids wall\d+\)/
    );
    const remaining = scene.walls.map((wall: any) => wall.id).filter((id: string) => !oldIds.has(id));
    assert.equal(remaining.length, 1);
    assert.match(error.message, new RegExp(`\\(ids ${remaining[0]}\\)`));
    assert.equal(scene.walls.size, 2);
    scene.deleteEmbeddedDocuments = realDelete;
    world.control.vetoWall = null;
    await methods.sync_walls({ sceneId: scene.id, paths: [at(5), at(7), at(9)] });
    assert.deepEqual(scene.walls.map((wall: any) => wall.c[1]).sort(), [5, 7, 9]);
  });
});

describe("the test world's delete", () => {
  it("throws for an unknown id before it deletes anything, as Foundry does (client-backend.mjs, #preDeleteDocumentArray)", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    world.install();
    const wall = world.addWall(scene);
    const light = world.addLight(scene);
    await assert.rejects(scene.deleteEmbeddedDocuments("Wall", [wall.id, "nope"]), /does not exist/);
    await assert.rejects(scene.deleteEmbeddedDocuments("AmbientLight", [light.id, "nope"]), /does not exist/);
    assert.deepEqual([scene.walls.size, scene.lights.size], [1, 1]);
  });
});

describe("a level set that names every level of the scene", () => {
  const at = (y: number) => [
    {
      points: [
        [0, y],
        [10, y]
      ]
    }
  ];

  it("is the same as no level set for sync_walls, whichever way the walls were made", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    world.install();
    await methods.sync_walls({ sceneId: scene.id, levels: ["lvl1"], paths: at(1) });
    const without = await methods.sync_walls({ sceneId: scene.id, paths: at(2) });
    assert.deepEqual([without.deleted, scene.walls.map((wall: any) => wall.c[1])], [1, [2]]);
    const named = await methods.sync_walls({ sceneId: scene.id, levels: ["lvl1"], paths: at(3) });
    assert.deepEqual([named.deleted, scene.walls.map((wall: any) => wall.c[1])], [1, [3]]);
    assert.deepEqual(
      scene.walls.map((wall: any) => wall.levels),
      [["lvl1"]]
    );
  });

  it("is the same as no level set for sync_lights, and still differs from one level of two", async () => {
    const world = fakeWorld({ extraLevels: ["lvl2"] });
    const scene = world.addScene({ name: "Tower", width: 1000, height: 800 });
    world.install();
    const light = (x: number) => [{ at: [x, 10], dim: 5 }];
    await methods.sync_lights({ sceneId: scene.id, levels: ["lvl2", "lvl1"], lights: light(1) });
    await methods.sync_lights({ sceneId: scene.id, levels: ["lvl2"], lights: light(2) });
    const result = await methods.sync_lights({ sceneId: scene.id, lights: light(3) });
    assert.deepEqual(
      [result.deleted, scene.lights.map((l: any) => [l.x, l.levels.join("+") || "all"]).sort()],
      [
        1,
        [
          [2, "lvl2"],
          [3, "all"]
        ]
      ]
    );
  });
});

describe("level sets of bridge-made walls", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld({ extraLevels: ["lvl2"] });
    scene = world.addScene({ name: "Tower", width: 1000, height: 800 });
    world.install();
  });
  const at = (y: number) => [
    {
      points: [
        [0, y],
        [10, y]
      ]
    }
  ];
  const byLevels = () => scene.walls.map((wall: any) => `${wall.levels.join("+") || "all"}:${wall.c[1]}`).sort();

  it("a sync replaces the walls of its own level set and leaves the other level sets alone", async () => {
    await methods.sync_walls({ sceneId: scene.id, levels: ["lvl1"], paths: at(1) });
    await methods.sync_walls({ sceneId: scene.id, levels: ["lvl2"], paths: at(2) });
    await methods.sync_walls({ sceneId: scene.id, paths: at(3) });
    assert.deepEqual(byLevels(), ["all:3", "lvl1:1", "lvl2:2"]);
    const result = await methods.sync_walls({ sceneId: scene.id, levels: ["lvl1"], paths: at(4) });
    assert.deepEqual([result.deleted, result.created], [1, 1]);
    assert.deepEqual(byLevels(), ["all:3", "lvl1:4", "lvl2:2"]);
    await methods.sync_walls({ sceneId: scene.id, paths: at(5) });
    assert.deepEqual(byLevels(), ["all:5", "lvl1:4", "lvl2:2"]);
    await methods.sync_walls({ sceneId: scene.id, levels: ["lvl2"], paths: [] });
    assert.deepEqual(byLevels(), ["all:5", "lvl1:4"]);
  });

  it("compares level sets as sets, and get_scene reports the levels of each wall", async () => {
    await methods.sync_walls({ sceneId: scene.id, levels: ["lvl1", "lvl2"], paths: at(1) });
    const result = await methods.sync_walls({ sceneId: scene.id, levels: ["lvl2", "lvl1"], paths: at(2) });
    assert.deepEqual([result.deleted, scene.walls.size], [1, 1]);
    assert.deepEqual(
      (await methods.get_scene({ sceneId: scene.id })).walls.map((wall: any) => wall.levels),
      [["lvl2", "lvl1"]]
    );
  });
});
