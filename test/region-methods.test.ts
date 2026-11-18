import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MethodError } from "../module/scripts/errors.mjs";
import { METHODS } from "../module/scripts/methods.mjs";
import { fakeWorld } from "./fake-world.ts";

type Method = (params: any) => Promise<any>;
const methods = METHODS as unknown as Record<"get_scene" | "get_scene_image", Method>;

const globals = globalThis as Record<string, unknown>;
const saved = {
  game: globals.game,
  canvas: globals.canvas,
  foundry: globals.foundry,
  CONST: globals.CONST,
  CONFIG: globals.CONFIG,
  document: globals.document,
  Image: globals.Image
};
afterEach(() => Object.assign(globals, saved));

const refused = (code: string, message?: RegExp) => (error: unknown) =>
  error instanceof MethodError && error.code === code && (message?.test(error.message) ?? true);

type Drawn = { op: string; args: any[]; fillStyle: unknown; strokeStyle: unknown; globalAlpha: number };

/** Stands in for the 2D canvas the image is drawn on, and records each drawing call with the styles it was made under. */
function stubCanvas() {
  const drawn: Drawn[] = [];
  const context: Record<string, any> = { globalAlpha: 1 };
  const calls =
    "fillRect drawImage beginPath closePath moveTo lineTo arc ellipse fill stroke setLineDash fillText strokeText";
  for (const op of calls.split(" ")) {
    context[op] = (...args: any[]) => {
      const { fillStyle, strokeStyle, globalAlpha } = context;
      drawn.push({ op, args, fillStyle, strokeStyle, globalAlpha });
    };
  }
  globals.document = {
    createElement: () => ({ getContext: () => context, toDataURL: () => "data:image/webp;base64,AAAA" })
  };
  globals.Image = class {
    onload: () => void = () => {};
    set src(_value: string) {
      queueMicrotask(() => this.onload());
    }
  };
  return { drawn, count: (op: string) => drawn.filter((call) => call.op === op).length };
}

const MANAGED = { "foundry-mcp": { managed: true } };

describe("get_scene and the levels of a scene", () => {
  it("reports each level with its elevation, its images and how they are placed, and marks the initial one", async () => {
    const world = fakeWorld();
    const scene = world.addScene({ name: "Cathedral", width: 1000, height: 800 });
    world.addLevel(scene, "tower", {
      name: "Bell tower",
      sort: 200,
      elevation: { bottom: 40, top: null },
      background: { src: "maps/tower.webp", color: "#101010" },
      foreground: { src: "maps/tower-roof.webp" },
      textures: { offsetX: 40, offsetY: -20, fit: "width" },
      visibility: { levels: ["lvl1"] }
    });
    world.install();
    const { levels } = await methods.get_scene({ sceneId: scene.id });
    assert.deepEqual(levels, [
      {
        id: "lvl1",
        name: "Level",
        sort: 0,
        initial: true,
        elevation: { bottom: 0, top: 20 },
        background: { src: null, color: "#999999" },
        foreground: { src: null },
        textures: {
          anchorX: 0.5,
          anchorY: 0.5,
          offsetX: 0,
          offsetY: 0,
          fit: "fill",
          scaleX: 1,
          scaleY: 1,
          rotation: 0
        },
        visibility: { levels: [] }
      },
      {
        id: "tower",
        name: "Bell tower",
        sort: 200,
        initial: false,
        elevation: { bottom: 40, top: null },
        background: { src: "maps/tower.webp", color: "#101010" },
        foreground: { src: "maps/tower-roof.webp" },
        textures: {
          anchorX: 0.5,
          anchorY: 0.5,
          offsetX: 40,
          offsetY: -20,
          fit: "width",
          scaleX: 1,
          scaleY: 1,
          rotation: 0
        },
        visibility: { levels: ["lvl1"] }
      }
    ]);
  });
});

describe("get_scene and the regions of a scene", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld({ extraLevels: ["upper"] });
    // Padding puts the scene rectangle at 300,200 on the canvas.
    scene = world.addScene({ name: "Cathedral", width: 1000, height: 800, padding: 0.25 });
    world.install();
  });

  it("reports a region's shapes in scene pixels, a polygon's points as pairs and a hole as a hole", async () => {
    world.addDocument(
      "Region",
      {
        name: "Nave",
        color: "#aa3366",
        levels: ["upper"],
        elevation: { bottom: 0, top: 20 },
        shapes: [
          { type: "rectangle", x: 400, y: 300, width: 200, height: 100 },
          { type: "polygon", points: [300, 200, 500, 200, 500, 400], hole: true },
          { type: "ellipse", x: 800, y: 600, radiusX: 60, radiusY: 30, rotation: 90 }
        ]
      },
      { parent: scene }
    );
    const { regions, frame } = await methods.get_scene({ sceneId: scene.id });
    assert.deepEqual(frame, { width: 1000, height: 800 });
    assert.deepEqual(regions, [
      {
        id: regions[0].id,
        name: "Nave",
        levels: ["upper"],
        elevation: { bottom: 0, top: 20, topInclusive: false },
        shapes: [
          {
            type: "rectangle",
            hole: false,
            x: 100,
            y: 100,
            width: 200,
            height: 100,
            anchorX: 0,
            anchorY: 0,
            rotation: 0,
            gridBased: false
          },
          {
            type: "polygon",
            hole: true,
            points: [
              [0, 0],
              [200, 0],
              [200, 200]
            ],
            origin: null
          },
          { type: "ellipse", hole: false, x: 500, y: 400, radiusX: 60, radiusY: 30, rotation: 90, gridBased: false }
        ],
        color: "#aa3366",
        visibility: 4,
        hidden: false,
        behaviors: [],
        managed: false
      }
    ]);
  });

  it("reports an elevation without a bound as null, a restriction while it is enabled and the token a region is attached to", async () => {
    world.addDocument("Region", { name: "Open" }, { parent: scene });
    world.addDocument(
      "Region",
      {
        name: "Barrier",
        hidden: true,
        visibility: 2,
        restriction: { enabled: true, type: "sight", priority: 3 },
        attachment: { token: "token00000000001" },
        flags: MANAGED
      },
      { parent: scene }
    );
    const [open, barrier] = (await methods.get_scene({ sceneId: scene.id })).regions;
    assert.deepEqual(open.elevation, { bottom: null, top: null, topInclusive: false });
    assert.deepEqual([open.restriction, open.attachment, open.levels], [undefined, undefined, []]);
    assert.deepEqual(
      [barrier.hidden, barrier.visibility, barrier.restriction, barrier.attachment, barrier.managed],
      [true, 2, { enabled: true, type: "sight", priority: 3 }, { token: "token00000000001" }, true]
    );
  });

  it("reports a region's behaviors with their stored data, and a destination Foundry stored relative as the UUID it names", async () => {
    const elsewhere = world.addScene({ name: "Crypt" });
    const far = world.addDocument("Region", { name: "Crypt door" }, { parent: elsewhere });
    const landing = world.addDocument("Region", { name: "Landing" }, { parent: scene });
    world.addDocument(
      "Region",
      {
        name: "Stair",
        behaviors: [
          {
            type: "teleportToken",
            name: "Up",
            // As Foundry stores them: relative to the behavior, a region of another scene from the scene up.
            system: { destinations: [`..${landing.id}`, `...${elsewhere.id}.Region.${far.id}`], choice: true },
            flags: MANAGED
          },
          { type: "changeLevel", disabled: true, system: { movementActions: ["walk"] } },
          { type: "executeScript", system: { events: ["tokenEnter"], source: "ui.notifications.info('hi')" } }
        ]
      },
      { parent: scene }
    );
    const stair = (await methods.get_scene({ sceneId: scene.id })).regions.find(
      (region: any) => region.name === "Stair"
    );
    const [teleport, change, script] = stair.behaviors;
    assert.deepEqual(teleport, {
      id: teleport.id,
      type: "teleportToken",
      name: "Up",
      disabled: false,
      system: {
        destinations: [landing.uuid, far.uuid],
        placement: "random",
        snap: true,
        choice: true,
        revealed: false,
        dialog: { revealed: null, unrevealed: null },
        transition: { type: null, duration: 1500 }
      },
      managed: true
    });
    assert.deepEqual(
      [change.type, change.name, change.disabled, change.system, change.managed],
      ["changeLevel", "", true, { movementActions: ["walk"] }, false]
    );
    assert.equal(script.system.source, "ui.notifications.info('hi')");
  });
});

describe("get_scene_image of one level", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld({ unloadable: ["maps/missing.webp"] });
    scene = world.addScene({ name: "Cathedral", width: 1000, height: 800 });
    world.addLevel(scene, "upper", {
      name: "Gallery",
      background: { src: "maps/gallery.webp", color: "#102030" },
      foreground: { src: "maps/roof.webp" }
    });
    world.install();
  });

  it("renders the level it is given over that level's background colour, and says whether the level has a map", async () => {
    const { drawn } = stubCanvas();
    const result = await methods.get_scene_image({ sceneId: scene.id, maxSize: 500, level: "upper" });
    assert.deepEqual(world.log.thumbnailLevels, ["upper"]);
    assert.deepEqual([result.frame, result.background], [{ width: 500, height: 400 }, true]);
    assert.equal(drawn.find((call) => call.op === "fillRect")!.fillStyle, "#102030");
    world.addLevel(scene, "crypt");
    assert.equal((await methods.get_scene_image({ sceneId: scene.id, level: "crypt" })).background, false);
  });

  it("renders the scene's initial level when no level is given", async () => {
    const { drawn } = stubCanvas();
    const result = await methods.get_scene_image({ sceneId: scene.id });
    assert.deepEqual(world.log.thumbnailLevels, ["lvl1"]);
    assert.equal(result.background, false);
    assert.equal(drawn.find((call) => call.op === "fillRect")!.fillStyle, "#999999");
  });

  it("refuses a level whose foreground image does not load, given or not, and a level the scene does not have, before rendering", async () => {
    stubCanvas();
    scene.levels.get("upper")._source.foreground.src = "maps/missing.webp";
    scene.levels.get("lvl1")._source.foreground.src = "maps/missing.webp";
    for (const level of ["upper", undefined]) {
      await assert.rejects(
        methods.get_scene_image({ sceneId: scene.id, ...(level && { level }) }),
        refused("foundry_error", /^The scene's foreground image maps\/missing\.webp could not be loaded\.$/)
      );
    }
    await assert.rejects(
      methods.get_scene_image({ sceneId: scene.id, level: "attic" }),
      refused("invalid_params", /Unknown level ids .*attic/)
    );
    assert.deepEqual(world.log.thumbnailLevels, []);
  });

  it("refuses an image that does not load of a level shown with the rendered one, and loads no image of a level that is not", async () => {
    stubCanvas();
    world.addLevel(scene, "crypt", { name: "Crypt", background: { src: "maps/missing.webp" } });
    await methods.get_scene_image({ sceneId: scene.id, level: "upper" });
    scene.levels.get("upper")._source.visibility.levels = ["crypt", "upper"];
    await assert.rejects(
      methods.get_scene_image({ sceneId: scene.id, level: "upper" }),
      refused(
        "foundry_error",
        /^The background image of the level Crypt, which is shown with it, maps\/missing\.webp could not be loaded\.$/
      )
    );
    assert.deepEqual(world.log.thumbnailLevels, ["upper"]);
  });

  it("draws the walls, lights and regions on the level and those on every level, and the tokens whose level it is", async () => {
    world.addWall(scene, { c: [0, 0, 100, 0], levels: ["upper"] });
    world.addWall(scene, { c: [0, 50, 100, 50], levels: ["lvl1"] });
    world.addWall(scene, { c: [0, 90, 100, 90] });
    world.addLight(scene, { x: 100, y: 100, levels: ["upper"] });
    world.addLight(scene, { x: 300, y: 300, levels: ["lvl1"] });
    world.addToken(scene, { x: 200, y: 200, level: "upper" });
    world.addToken(scene, { x: 400, y: 400, level: "lvl1" });
    const square = (x: number) => [{ type: "rectangle", x, y: 500, width: 100, height: 100 }];
    world.addDocument("Region", { name: "Loft", levels: ["upper"], shapes: square(100) }, { parent: scene });
    world.addDocument("Region", { name: "Cellar", levels: ["lvl1"], shapes: square(300) }, { parent: scene });
    world.addDocument("Region", { name: "Stair", levels: ["lvl1", "upper"], shapes: square(500) }, { parent: scene });
    world.addDocument("Region", { name: "Everywhere", shapes: square(700) }, { parent: scene });

    const draw = async (show: string, level?: string) => {
      const canvas = stubCanvas();
      await methods.get_scene_image({ sceneId: scene.id, [show]: true, ...(level && { level }) });
      return canvas;
    };
    // A wall is one line, a light two rings and a dot, a token one ellipse.
    assert.deepEqual(
      [(await draw("showWalls", "upper")).count("moveTo"), (await draw("showWalls")).count("moveTo")],
      [2, 3]
    );
    assert.deepEqual(
      [(await draw("showLights", "upper")).count("arc"), (await draw("showLights")).count("arc")],
      [3, 6]
    );
    assert.deepEqual(
      [(await draw("showTokens", "upper")).count("ellipse"), (await draw("showTokens")).count("ellipse")],
      [1, 2]
    );
    const names = (canvas: ReturnType<typeof stubCanvas>) =>
      canvas.drawn.filter((call) => call.op === "fillText").map((call) => call.args[0]);
    assert.deepEqual(names(await draw("showRegions", "upper")), ["Loft", "Stair", "Everywhere"]);
    assert.deepEqual(names(await draw("showRegions", "lvl1")), ["Cellar", "Stair", "Everywhere"]);
    assert.deepEqual(names(await draw("showRegions")), ["Loft", "Cellar", "Stair", "Everywhere"]);
  });
});

describe("get_scene_image showRegions", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cathedral", width: 1000, height: 800 });
    world.install();
  });

  it("fills a region's area lightly in its colour and leaves a hole open, outlines it and writes its name in the middle", async () => {
    world.addDocument(
      "Region",
      {
        name: "Nave",
        color: "#aa3366",
        shapes: [
          { type: "rectangle", x: 200, y: 200, width: 400, height: 200 },
          { type: "polygon", points: [300, 250, 400, 250, 400, 300], hole: true }
        ]
      },
      { parent: scene }
    );
    const { drawn } = stubCanvas();
    await methods.get_scene_image({ sceneId: scene.id, maxSize: 500, showRegions: true });
    const path = drawn.filter((call) => ["moveTo", "lineTo", "closePath"].includes(call.op));
    assert.deepEqual(
      path.map((call) => [call.op, ...call.args]),
      [
        ["moveTo", 100, 100],
        ["lineTo", 300, 100],
        ["lineTo", 300, 200],
        ["lineTo", 100, 200],
        ["closePath"],
        ["moveTo", 150, 125],
        ["lineTo", 200, 125],
        ["lineTo", 200, 150],
        ["closePath"]
      ]
    );
    const [fill] = drawn.filter((call) => call.op === "fill");
    assert.deepEqual([fill!.args, fill!.fillStyle], [["evenodd"], "#aa3366"]);
    assert.ok(fill!.globalAlpha > 0 && fill!.globalAlpha < 0.5, "the fill lets the map show through");
    const strokes = drawn.filter((call) => call.op === "stroke");
    assert.deepEqual(
      strokes.map((call) => [call.strokeStyle, call.globalAlpha]),
      [
        ["#000000", 1],
        ["#aa3366", 1]
      ]
    );
    const [label] = drawn.filter((call) => call.op === "fillText");
    assert.deepEqual(label!.args, ["Nave", 200, 150]);
  });

  it("draws no regions unless asked", async () => {
    world.addDocument(
      "Region",
      { name: "Nave", shapes: [{ type: "rectangle", x: 0, y: 0, width: 10, height: 10 }] },
      { parent: scene }
    );
    const { count } = stubCanvas();
    await methods.get_scene_image({ sceneId: scene.id });
    assert.deepEqual([count("fill"), count("stroke"), count("fillText")], [0, 0, 0]);
  });
});
