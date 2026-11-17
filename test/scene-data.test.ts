import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canvasOverflow,
  planSceneChanges,
  scenesNamed,
  touchesGeometry,
  touchesThumbnail,
  unknownSceneFields
} from "../module/scripts/scene-data.mjs";

const empty = { scene: {}, level: {} };

const stored = {
  scene: {
    name: "Cellar",
    folder: "f1",
    width: 1000,
    height: 800,
    padding: 0.25,
    navName: "",
    navigation: true,
    tokenVision: true,
    weather: "",
    grid: { type: 1, size: 100, distance: 5, units: "ft" },
    fog: { mode: 1 },
    environment: { darknessLevel: 0, globalLight: { enabled: false } }
  },
  level: { background: { src: "maps/cellar.webp" } }
};

describe("planSceneChanges on create", () => {
  it("writes every given field to its place in the Foundry documents", () => {
    const plan = planSceneChanges(
      {
        name: "Cellar",
        folder: "f1",
        width: 1000,
        height: 800,
        padding: 0.1,
        grid: { type: "gridless", size: 50, distance: 10, units: "m" },
        navName: "Keller",
        navigation: false,
        tokenVision: false,
        fogExploration: true,
        globalLight: true,
        darkness: 0.4,
        weather: "rain",
        background: { src: "maps/cellar.webp" }
      },
      empty
    );
    assert.deepEqual(plan.scene, {
      name: "Cellar",
      folder: "f1",
      width: 1000,
      height: 800,
      padding: 0.1,
      grid: { type: 0, size: 50, distance: 10, units: "m" },
      navName: "Keller",
      navigation: false,
      tokenVision: false,
      fog: { mode: 1 },
      environment: { globalLight: { enabled: true }, darknessLevel: 0.4 },
      weather: "rain"
    });
    assert.deepEqual(plan.level, { background: { src: "maps/cellar.webp" } });
    assert.equal(plan.changed.length, 17);
  });

  it("names the input fields, nested ones with a dot, and skips fields that were not given", () => {
    const plan = planSceneChanges({ name: "A", grid: { size: 70 }, background: { src: "a.webp" } }, empty);
    assert.deepEqual(plan.changed.sort(), ["background.src", "grid.size", "name"]);
    assert.deepEqual(plan.scene, { name: "A", grid: { size: 70 } });
  });

  it("writes a null folder for the root", () => {
    assert.deepEqual(planSceneChanges({ folder: null }, empty).scene, { folder: null });
  });
});

describe("planSceneChanges on update", () => {
  it("is empty when the input equals what is stored", () => {
    const plan = planSceneChanges(
      {
        name: "Cellar",
        folder: "f1",
        width: 1000,
        height: 800,
        padding: 0.25,
        grid: { type: "square", size: 100, distance: 5, units: "ft" },
        navName: "",
        navigation: true,
        tokenVision: true,
        fogExploration: true,
        globalLight: false,
        darkness: 0,
        weather: "",
        background: { src: "maps/cellar.webp" }
      },
      stored
    );
    assert.deepEqual(plan, { scene: {}, level: {}, changed: [] });
  });

  it("writes only the fields that differ, nested fields as partial objects", () => {
    const plan = planSceneChanges(
      { width: 1000, grid: { type: "square", size: 140 }, globalLight: true, background: { src: "maps/new.webp" } },
      stored
    );
    assert.deepEqual(plan.scene, { grid: { size: 140 }, environment: { globalLight: { enabled: true } } });
    assert.deepEqual(plan.level, { background: { src: "maps/new.webp" } });
    assert.deepEqual(plan.changed.sort(), ["background.src", "globalLight", "grid.size"]);
  });

  it("treats a hex grid as different from both tool grid types", () => {
    const hex = { ...stored, scene: { ...stored.scene, grid: { ...stored.scene.grid, type: 2 } } };
    assert.deepEqual(planSceneChanges({ grid: { type: "square" } }, hex).scene, { grid: { type: 1 } });
  });

  it("keeps shared fog exploration when fogExploration is true and turns it off for false", () => {
    const shared = { ...stored, scene: { ...stored.scene, fog: { mode: 2 } } };
    assert.deepEqual(planSceneChanges({ fogExploration: true }, shared).changed, []);
    assert.deepEqual(planSceneChanges({ fogExploration: false }, shared).scene, { fog: { mode: 0 } });
  });

  it("detects a move out of a folder to the root", () => {
    assert.deepEqual(planSceneChanges({ folder: null }, stored).scene, { folder: null });
  });
});

describe("scenesNamed", () => {
  it("finds scenes by exact name inside exactly one folder", () => {
    const scenes = [
      { name: "Gates", folderId: "b" },
      { name: "Gates", folderId: null },
      { name: "Gates ", folderId: "b" }
    ];
    assert.deepEqual(scenesNamed(scenes, "Gates", "b"), [scenes[0]]);
    assert.deepEqual(scenesNamed(scenes, "Gates", null), [scenes[1]]);
    assert.deepEqual(scenesNamed(scenes, "Gates", "zzz"), []);
  });
});

describe("which changed fields touch the thumbnail and the scene geometry", () => {
  it("names the fields the thumbnail is rendered from and the ones that move the scene origin", () => {
    assert.deepEqual(
      ["background.src", "width", "height", "padding", "grid.size", "navName"].map((k) => touchesThumbnail([k])),
      [true, true, true, false, false, false]
    );
    assert.deepEqual(
      ["background.src", "width", "height", "padding", "shiftX", "shiftY", "grid.size", "grid.type", "navName"].map(
        (k) => touchesGeometry([k])
      ),
      [false, true, true, true, true, true, true, true, false]
    );
    assert.equal(touchesGeometry([]), false);
  });
});

describe("shift", () => {
  it("reads a null shift as 0 when comparing", () => {
    const current = { scene: { ...stored.scene, shiftX: null, shiftY: null }, level: stored.level };
    assert.deepEqual(planSceneChanges({ shiftX: 0, shiftY: 0 }, current).changed, []);
    assert.deepEqual(planSceneChanges({ shiftX: 3, shiftY: 4 }, current).changed, ["shiftX", "shiftY"]);
  });
});

describe("canvasOverflow", () => {
  const dims = (sceneX: number, sceneY: number) => ({
    sceneX,
    sceneY,
    sceneWidth: 1000,
    sceneHeight: 800,
    width: 1200,
    height: 1000
  });
  const none = { x: 0, y: 0 };
  it("is empty while the scene rectangle lies inside the canvas, edges included", () => {
    assert.deepEqual(canvasOverflow(dims(100, 100), none), []);
    assert.deepEqual([canvasOverflow(dims(0, 0), none), canvasOverflow(dims(200, 200), none)], [[], []]);
  });
  it("names the axis, the shift, the hidden pixels and the shifts that fit, on either side", () => {
    assert.deepEqual(canvasOverflow(dims(-30, 100), { x: 30, y: 0 }), [
      { axis: "x", shift: 30, over: 30, min: -200, max: 0 }
    ]);
    assert.deepEqual(canvasOverflow(dims(100, 250), { x: 0, y: -150 }), [
      { axis: "y", shift: -150, over: 50, min: -100, max: 100 }
    ]);
  });
  it("gives the range around the shift the scene has, which is not symmetric on a hexagonal grid", () => {
    // Foundry's HexagonalGrid#calculateDimensions(1000, 800, 0.25) with a size of 100 and flat-topped hexes: x 259.8076, width 1587.7132.
    const hex = {
      sceneX: 259.8076211353316 - 300,
      sceneY: 250,
      sceneWidth: 1000,
      sceneHeight: 800,
      width: 1587.713240271471,
      height: 1300
    };
    const overflow = canvasOverflow(hex, { x: 300, y: 0 });
    assert.deepEqual(
      overflow.map(({ axis, shift, min, max }) => ({ axis, shift, min, max })),
      [{ axis: "x", shift: 300, min: -327, max: 259 }]
    );
    assert.ok(Math.abs(overflow[0]!.over - 40.1924) < 1e-4);
  });
});

describe("unknownSceneFields", () => {
  it("lists what is not a tool field, nested ones dotted, and lets sceneId and every known field through", () => {
    assert.deepEqual(
      unknownSceneFields({
        sceneId: "s",
        name: "A",
        shiftX: 1,
        grid: { type: "square", size: 1 },
        background: { src: "a" }
      }),
      []
    );
    assert.deepEqual(
      unknownSceneFields({ shiftZ: 1, grid: { shape: 1, size: 2 }, background: { tint: 1 }, name: "A" }),
      ["shiftZ", "grid.shape", "background.tint"]
    );
  });
});
