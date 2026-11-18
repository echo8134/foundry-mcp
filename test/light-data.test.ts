import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIGHT_FIELDS, lightData, lightFields, lightMarkers } from "../module/scripts/light-data.mjs";
import { lightSchema } from "../src/scene-tools.ts";

const flags = { "foundry-mcp": { managed: true } };

describe("lightData", () => {
  it("sends only what was given, so everything else keeps Foundry's default", () => {
    assert.deepEqual(lightData({ at: [1, 2], dim: 20 }, [100, 200], [], flags), {
      x: 100,
      y: 200,
      levels: [],
      flags,
      config: { dim: 20 }
    });
  });

  it("writes every tool field to its place in the AmbientLight document", () => {
    const light = {
      at: [0, 0],
      name: "Brazier",
      bright: 10,
      dim: 20,
      color: "#ff8800",
      alpha: 0.7,
      angle: 90,
      rotation: 45,
      animation: { type: "flame", speed: 3, intensity: 8, reverse: true },
      walls: false,
      vision: true,
      hidden: true,
      darkness: { min: 0.5, max: 1 },
      negative: false
    };
    assert.deepEqual(lightData(light, [5, 6], ["lvl"], flags), {
      x: 5,
      y: 6,
      levels: ["lvl"],
      flags,
      name: "Brazier",
      rotation: 45,
      walls: false,
      vision: true,
      hidden: true,
      config: {
        bright: 10,
        dim: 20,
        color: "#ff8800",
        alpha: 0.7,
        angle: 90,
        animation: { type: "flame", speed: 3, intensity: 8, reverse: true },
        darkness: { min: 0.5, max: 1 },
        negative: false
      }
    });
  });

  it("keeps a given false and a given 0, which are not the same as left out", () => {
    const data = lightData({ at: [0, 0], dim: 5, hidden: false, alpha: 0, rotation: 0 }, [0, 0], [], flags);
    assert.deepEqual([data.hidden, data.config.alpha, data.rotation], [false, 0, 0]);
  });

  it("has one table row for every field the schema takes, and none for anything else", () => {
    const schemaFields = Object.keys(lightSchema.shape)
      .filter((key) => key !== "at")
      .sort();
    const tableFields = [...new Set(Object.keys(LIGHT_FIELDS).map((key) => key.split(".")[0]))].sort();
    assert.deepEqual(tableFields, schemaFields);
    const animation = Object.keys((lightSchema.shape.animation.unwrap() as any).shape).sort();
    assert.deepEqual(
      Object.keys(LIGHT_FIELDS)
        .filter((key) => key.startsWith("animation."))
        .map((key) => key.slice(10))
        .sort(),
      animation
    );
  });
});

describe("lightFields", () => {
  const stored = {
    name: "Brazier",
    x: 1,
    y: 2,
    rotation: 45,
    walls: true,
    vision: false,
    hidden: false,
    locked: false,
    config: {
      negative: false,
      priority: 0,
      alpha: 0.5,
      angle: 360,
      bright: 10,
      color: "#ff8800",
      dim: 20,
      animation: { type: "torch", speed: 5, intensity: 5, reverse: false },
      darkness: { min: 0, max: 1 }
    }
  };

  it("reads a stored light back in the tool vocabulary and not the other document fields", () => {
    assert.deepEqual(lightFields(stored), {
      name: "Brazier",
      bright: 10,
      dim: 20,
      color: "#ff8800",
      alpha: 0.5,
      angle: 360,
      rotation: 45,
      animation: { type: "torch", speed: 5, intensity: 5, reverse: false },
      walls: true,
      vision: false,
      hidden: false,
      darkness: { min: 0, max: 1 },
      negative: false
    });
  });

  it("leaves out the colour, the name and the whole animation when Foundry holds none", () => {
    const plain = {
      ...stored,
      name: "",
      config: { ...stored.config, color: null, animation: { type: null, speed: 5, intensity: 5, reverse: false } }
    };
    const light = lightFields(plain);
    for (const key of ["name", "color", "animation"]) assert.equal(key in light, false, key);
  });

  it("round-trips: what it reads is accepted by the schema and writes the same fields again", () => {
    const light = lightFields(stored);
    const parsed = lightSchema.parse({ at: [0, 0], ...light });
    assert.deepEqual(lightFields(lightData(parsed, [1, 2], [], flags)), light);
  });
});

describe("lightMarkers", () => {
  const rect = { x: 200, y: 100, width: 1000, height: 800 };
  const grid = { size: 100, distance: 5 };
  const light = (x: number, y: number, config: object) => ({ x, y, config: { dim: 0, bright: 0, ...config } });

  it("puts the centre and the reach on the image, in pixels scaled from the scene", () => {
    const [marker] = lightMarkers([light(700, 500, { dim: 20 })], rect, grid, { width: 500, height: 400 });
    assert.deepEqual(marker, { x: 250, y: 200, radius: 200, negative: false });
  });

  it("uses the larger of dim and bright, as Foundry does", () => {
    const markers = lightMarkers(
      [light(0, 0, { dim: 5, bright: 15 }), light(0, 0, { dim: 15, bright: 5 })],
      rect,
      grid,
      { width: 1000, height: 800 }
    );
    assert.deepEqual(
      markers.map((marker) => marker.radius),
      [300, 300]
    );
  });

  it("scales by the grid distance, so a metre grid draws differently from a foot grid", () => {
    const [feet] = lightMarkers(
      [light(0, 0, { dim: 10 })],
      rect,
      { size: 100, distance: 5 },
      { width: 1000, height: 800 }
    );
    const [metres] = lightMarkers(
      [light(0, 0, { dim: 10 })],
      rect,
      { size: 100, distance: 1.5 },
      { width: 1000, height: 800 }
    );
    assert.deepEqual([feet!.radius, metres!.radius], [200, 100 * (10 / 1.5)]);
  });

  it("marks a darkness source", () => {
    const [marker] = lightMarkers([light(0, 0, { dim: 5, negative: true })], rect, grid, { width: 1000, height: 800 });
    assert.equal(marker!.negative, true);
  });
});
