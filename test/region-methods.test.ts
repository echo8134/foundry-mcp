import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { METHODS } from "../module/scripts/methods.mjs";
import { fakeWorld } from "./fake-world.ts";

type Method = (params: any) => Promise<any>;
const methods = METHODS as unknown as Record<"get_scene", Method>;

const globals = globalThis as Record<string, unknown>;
const saved = {
  game: globals.game,
  canvas: globals.canvas,
  foundry: globals.foundry,
  CONST: globals.CONST,
  CONFIG: globals.CONFIG
};
afterEach(() => Object.assign(globals, saved));

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
