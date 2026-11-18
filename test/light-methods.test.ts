import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MethodError } from "../module/scripts/errors.mjs";
import { METHODS } from "../module/scripts/methods.mjs";
import { TOOLS } from "../src/tools.ts";
import { fakeWorld } from "./fake-world.ts";

type Method = (params: any) => Promise<any>;
const methods = METHODS as unknown as Record<"get_scene" | "get_scene_image" | "list_scenes" | "sync_lights", Method>;

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
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

const viaTool = (args: unknown) => methods.sync_lights(TOOLS.sync_lights.input.parse(args));

const refused = (message: RegExp) => (error: unknown) =>
  error instanceof MethodError && error.code === "invalid_params" && message.test(error.message);

const managedFlag = { "foundry-mcp": { managed: true } };
const torch = { at: [10, 10], dim: 20 };
const shape = (scene: any) => scene.lights.map((light: any) => [light.x, light.y]).sort();

describe("lights made by the bridge", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    world.install();
  });

  it("creates the lights flagged as managed, with Foundry's defaults for what was left out, and names its target", async () => {
    const result = await viaTool({ sceneId: scene.id, lights: [torch] });
    assert.deepEqual(
      { ...result, ids: result.ids.length },
      { deleted: 0, created: 1, ids: 1, sceneId: scene.id, sceneName: "Cellar" }
    );
    const [light] = scene.lights.values();
    assert.deepEqual(light.flags, managedFlag);
    assert.deepEqual(
      [
        light.config.dim,
        light.config.bright,
        light.config.alpha,
        light.walls,
        light.vision,
        light.hidden,
        light.config.angle
      ],
      [20, 0, 0.5, true, false, false, 360]
    );
    assert.deepEqual(light.config.animation, { type: null, speed: 5, intensity: 5, reverse: false });
  });

  it("converts a point in the given frame to canvas pixels from the scene origin, and reads it back in scene pixels", async () => {
    const padded = world.addScene({ name: "Padded", width: 1000, height: 800, padding: 0.25 });
    assert.deepEqual([padded.dimensions.sceneX, padded.dimensions.sceneY], [300, 200]);
    await viaTool({ sceneId: padded.id, frame: { width: 100, height: 80 }, lights: [{ at: [50, 40], dim: 20 }] });
    assert.deepEqual(shape(padded), [[800, 600]]);
    const [light] = (await methods.get_scene({ sceneId: padded.id })).lights;
    assert.deepEqual(light.at, [500, 400]);
  });

  it("stores what Foundry keeps of the values: trimmed name, radii on their step, rotation modulo 360, colour in lower case", async () => {
    await viaTool({
      sceneId: scene.id,
      lights: [{ at: [1, 1], bright: 5.5, dim: 12.25, name: " Brazier ", rotation: 360, color: "#FFAA00" }]
    });
    const [light] = (await methods.get_scene({ sceneId: scene.id })).lights;
    assert.deepEqual(
      [light.name, light.bright, light.dim, light.rotation, light.color],
      ["Brazier", 5.5, 12.25, 0, "#ffaa00"]
    );
  });

  it("get_scene reports hand-placed and bridge-made lights in the tool vocabulary, each with its managed flag", async () => {
    const byHand = world.addLight(scene, { x: 300, y: 400, config: { dim: 30, color: "#00ff00" } });
    await viaTool({
      sceneId: scene.id,
      lights: [
        {
          at: [50, 60],
          bright: 5,
          dim: 10,
          animation: { type: "flame", speed: 7 },
          darkness: { min: 0.4, max: 1 },
          walls: false
        }
      ]
    });
    const lights = (await methods.get_scene({ sceneId: scene.id })).lights;
    assert.equal(lights.length, 2);
    const hand = lights.find((light: any) => light.id === byHand.id);
    assert.deepEqual(hand, {
      id: byHand.id,
      at: [300, 400],
      levels: [],
      bright: 0,
      dim: 30,
      color: "#00ff00",
      alpha: 0.5,
      angle: 360,
      rotation: 0,
      walls: true,
      vision: false,
      hidden: false,
      darkness: { min: 0, max: 1 },
      negative: false,
      managed: false
    });
    const made = lights.find((light: any) => light.id !== byHand.id);
    assert.deepEqual(
      [made.at, made.managed, made.animation, made.darkness, made.walls, "color" in made],
      [[50, 60], true, { type: "flame", speed: 7, intensity: 5, reverse: false }, { min: 0.4, max: 1 }, false, false]
    );
  });

  it("what get_scene reads can be given back to sync_lights and ends with the same lights", async () => {
    await viaTool({
      sceneId: scene.id,
      lights: [
        {
          at: [50, 60],
          bright: 5,
          dim: 10,
          color: "#ff0000",
          animation: { type: "torch" },
          negative: false,
          hidden: true
        },
        torch
      ]
    });
    const read = async () =>
      (await methods.get_scene({ sceneId: scene.id })).lights
        .map(({ id, managed, ...light }: any) => light)
        .sort((a: any, b: any) => a.at[0] - b.at[0]);
    const before = await read();
    await viaTool({ sceneId: scene.id, lights: before });
    assert.deepEqual(await read(), before);
  });

  it("sync_lights deletes only bridge-made lights and creates the given ones", async () => {
    const byHand = world.addLight(scene);
    await viaTool({ sceneId: scene.id, lights: [torch, { at: [20, 20], dim: 10 }] });
    const result = await viaTool({ sceneId: scene.id, lights: [{ at: [30, 30], dim: 10 }] });
    assert.deepEqual([result.deleted, result.created, result.ids.length], [2, 1, 1]);
    assert.equal(scene.lights.size, 2);
    assert.ok(scene.lights.has(byHand.id));
  });

  it("a rerun with the same input ends with exactly the new set, also after the managed lights were removed by hand", async () => {
    const input = { sceneId: scene.id, lights: [torch, { at: [20, 20], dim: 10 }] };
    await viaTool(input);
    const first = shape(scene);
    const again = await viaTool(input);
    assert.deepEqual([again.deleted, again.created], [2, 2]);
    assert.deepEqual(shape(scene), first);
    for (const light of scene.lights.filter((l: any) => l.flags["foundry-mcp"]?.managed)) scene.lights.delete(light.id);
    await viaTool(input);
    assert.deepEqual(shape(scene), first);
  });

  it("an empty list only removes the bridge-made lights", async () => {
    world.addLight(scene);
    await viaTool({ sceneId: scene.id, lights: [torch] });
    const result = await viaTool({ sceneId: scene.id, lights: [] });
    assert.deepEqual([result.deleted, result.created, result.ids], [1, 0, []]);
    assert.equal(scene.lights.size, 1);
  });

  it("a create Foundry rejects leaves the lights that were there, and deletes nothing", async () => {
    await viaTool({ sceneId: scene.id, lights: [torch] });
    const before = [...scene.lights.keys()];
    world.control.lightCreateFails = true;
    await assert.rejects(
      viaTool({ sceneId: scene.id, lights: [{ at: [90, 90], dim: 5 }] }),
      /AmbientLight validation failed/
    );
    assert.deepEqual([...scene.lights.keys()], before);
    assert.equal(world.log.lightDeletes, 0);
  });

  it("ends with exactly the new lights after a crash between creating them and deleting the old ones", async () => {
    await viaTool({ sceneId: scene.id, lights: [torch] });
    const next = {
      sceneId: scene.id,
      lights: [
        { at: [50, 50], dim: 5 },
        { at: [60, 60], dim: 5 }
      ]
    };
    world.control.lightDeleteFails = true;
    await assert.rejects(viaTool(next), /connection lost/);
    assert.equal(scene.lights.size, 3);
    world.control.lightDeleteFails = false;
    await viaTool(next);
    assert.deepEqual(shape(scene), [
      [50, 50],
      [60, 60]
    ]);
  });

  it("refuses unknown level ids, unknown animations and unstorable positions before it writes anything", async () => {
    await viaTool({ sceneId: scene.id, lights: [torch] });
    const before = [...scene.lights.keys()];
    const log = { ...world.log };
    await assert.rejects(viaTool({ sceneId: scene.id, lights: [torch], levels: ["ghost"] }), refused(/ghost/));
    await assert.rejects(
      viaTool({ sceneId: scene.id, lights: [{ ...torch, animation: { type: "hologram" } }] }),
      refused(/Unknown animation "hologram".*flame, torch, pulse/)
    );
    await assert.rejects(
      viaTool({ sceneId: scene.id, lights: [torch, { at: [1e308, 0], dim: 5 }] }),
      refused(/too large/)
    );
    assert.deepEqual([...scene.lights.keys()], before);
    assert.deepEqual(world.log, log);
  });

  it("checks an animation against the table of its kind and not against inherited names", async () => {
    await assert.rejects(
      viaTool({ sceneId: scene.id, lights: [{ ...torch, animation: { type: "magicalGloom" } }] }),
      refused(/Unknown animation "magicalGloom" for a light/)
    );
    await assert.rejects(
      viaTool({ sceneId: scene.id, lights: [{ ...torch, negative: true, animation: { type: "flame" } }] }),
      refused(/Unknown animation "flame" for a darkness source.*magicalGloom/)
    );
    await assert.rejects(
      viaTool({ sceneId: scene.id, lights: [{ ...torch, animation: { type: "toString" } }] }),
      refused(/Unknown animation "toString"/)
    );
    await viaTool({ sceneId: scene.id, lights: [{ ...torch, negative: true, animation: { type: "magicalGloom" } }] });
    assert.equal(scene.lights.size, 1);
  });

  it("two sync_lights calls in flight leave one copy of the lights", async () => {
    const slow = fakeWorld({ latency: 2 });
    const slowScene = slow.addScene({ name: "Slow", width: 1000, height: 800 });
    slow.install();
    const input = { sceneId: slowScene.id, lights: [torch, { at: [20, 20], dim: 10 }] };
    await Promise.all([viaTool(input), viaTool(input)]);
    assert.equal(slowScene.lights.size, 2);
  });

  it("answers not_found for an unknown scene", async () => {
    await assert.rejects(
      viaTool({ sceneId: "nope", lights: [] }),
      (error: unknown) => error instanceof MethodError && error.code === "not_found"
    );
  });
});

function stubDrawing() {
  const calls: [string, ...unknown[]][] = [];
  const state = { strokeStyle: "", fillStyle: "", lineWidth: 0 };
  const context = {
    set strokeStyle(value: string) {
      state.strokeStyle = value;
    },
    set fillStyle(value: string) {
      state.fillStyle = value;
    },
    set lineWidth(value: number) {
      state.lineWidth = value;
    },
    fillRect() {},
    drawImage() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc(x: number, y: number, radius: number) {
      calls.push(["arc", x, y, radius, state.strokeStyle, state.fillStyle]);
    },
    stroke() {},
    fill() {}
  };
  globals.document = {
    createElement: () => ({ getContext: () => context, toDataURL: () => "data:image/webp;base64,AAAA" })
  };
  globals.Image = class {
    onload: () => void = () => {};
    set src(_value: string) {
      queueMicrotask(() => this.onload());
    }
  };
  return calls;
}

describe("get_scene_image showLights", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    world.install();
  });

  it("draws a dot and a ring at the reach of every light, hand-placed ones too, scaled to the image", async () => {
    const calls = stubDrawing();
    world.addLight(scene, { x: 500, y: 400, config: { dim: 20 } });
    await viaTool({ sceneId: scene.id, lights: [{ at: [100, 100], bright: 30, dim: 10 }] });
    const result = await methods.get_scene_image({ sceneId: scene.id, maxSize: 500, showLights: true });
    assert.deepEqual(result.frame, { width: 500, height: 400 });
    const rings = calls.filter(([, , , radius]) => (radius as number) > 20);
    assert.deepEqual(
      new Set(rings.map(([, x, y, radius]) => [x, y, radius].join(","))),
      new Set(["250,200,200", "50,50,300"])
    );
    assert.equal(calls.length, 6, "a black and a coloured ring and a dot for each of the two lights");
  });

  it("draws nothing for lights unless asked, and draws a darkness source in another colour", async () => {
    const calls = stubDrawing();
    world.addLight(scene, { x: 500, y: 400, config: { dim: 20 } });
    await methods.get_scene_image({ sceneId: scene.id });
    assert.equal(calls.length, 0);
    world.addLight(scene, { x: 100, y: 100, config: { dim: 10, negative: true } });
    await methods.get_scene_image({ sceneId: scene.id, showLights: true });
    const colours = new Set(calls.filter(([, , , radius]) => (radius as number) > 20).map((call) => call[4]));
    assert.deepEqual([...colours].sort(), ["#000000", "#c04dff", "#ffd400"]);
  });
});

describe("sync_lights and what get_scene returns", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld({ extraLevels: ["lvl2"] });
    scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    world.install();
  });

  const stored = () =>
    scene.lights
      .map((light: any) =>
        JSON.stringify([
          light._source.x,
          light._source.y,
          light.levels,
          light.name,
          light.config.bright,
          light.config.dim,
          light.config.animation.type,
          light.flags["foundry-mcp"]?.managed === true
        ])
      )
      .sort();
  const idsOf = (managed: boolean): string[] =>
    scene.lights
      .filter((light: any) => (light.flags["foundry-mcp"]?.managed === true) === managed)
      .map((light: any) => light.id)
      .sort();
  const read = async () => (await methods.get_scene({ sceneId: scene.id })).lights;

  function populate() {
    const byHand = world.addLight(scene, {
      x: 300,
      y: 400,
      name: "Brazier",
      config: { bright: 0, dim: 0, animation: { type: "oldModuleFlame" } }
    });
    return { byHand };
  }

  it("passing get_scene's lights back is a no-op in effect: a hand-placed light, a level-bound one and an off-canvas one end as they were", async () => {
    const { byHand } = populate();
    await viaTool({ sceneId: scene.id, levels: ["lvl2"], lights: [{ at: [50, 60], dim: 10, name: "Upstairs" }] });
    await viaTool({
      sceneId: scene.id,
      lights: [
        { at: [10, 10], dim: 20 },
        { at: [-500, -300], dim: 10, name: "Off the map" },
        { at: [5000, 4000], bright: 5 }
      ]
    });
    const before = stored();
    const handId = byHand.id;
    const levelBound = idsOf(true).filter((id) => scene.lights.get(id).levels.length > 0);

    const result = await viaTool({ sceneId: scene.id, lights: await read() });
    assert.deepEqual([result.deleted, result.created], [3, 3]);
    assert.deepEqual(stored(), before);
    assert.ok(scene.lights.has(handId));
    assert.deepEqual(
      idsOf(true).filter((id) => scene.lights.get(id).levels.length > 0),
      levelBound
    );
    assert.deepEqual(world.log.notifications, []);
  });

  it("with levels it replaces only the lights of that level set, whatever else the list holds", async () => {
    populate();
    await viaTool({ sceneId: scene.id, levels: ["lvl2"], lights: [{ at: [50, 60], dim: 10, name: "Upstairs" }] });
    await viaTool({ sceneId: scene.id, lights: [{ at: [10, 10], dim: 20 }] });
    const before = stored();
    const result = await viaTool({ sceneId: scene.id, levels: ["lvl2"], lights: await read() });
    assert.deepEqual([result.deleted, result.created], [1, 1]);
    assert.deepEqual(stored(), before);
  });

  it("reads an off-canvas light where it was written, and the derived position is the clamped one", async () => {
    const light = world.addLight(scene, { x: -50, y: 5000 });
    assert.deepEqual([light.x, light.y, light._source.x, light._source.y], [0, 800, -50, 5000]);
    assert.deepEqual((await read())[0].at, [-50, 5000]);
  });

  it("does not validate a hand-placed light, and does validate every other one, also one of another level set", async () => {
    const hand = {
      id: "light9",
      managed: false,
      levels: [],
      at: [1, 1],
      bright: 0,
      dim: 0,
      animation: { type: "oldModuleFlame" },
      speed: 99
    };
    const otherLevel = { id: "light8", managed: true, levels: ["lvl2"], at: [1, 1], dim: 3 };
    const result = await viaTool({ sceneId: scene.id, lights: [hand, otherLevel, { at: [20, 20], dim: 5 }] });
    assert.deepEqual([result.deleted, result.created], [0, 1]);
    assert.throws(
      () =>
        TOOLS.sync_lights.input.parse({
          lights: [{ id: "light7", managed: true, levels: [], at: [1, 1], bright: 0, dim: 0 }]
        }),
      /bright or a dim radius above 0/
    );
    assert.throws(
      () =>
        TOOLS.sync_lights.input.parse({ lights: [{ id: "light7", managed: true, at: [1, 1], dim: 5, colour: "red" }] }),
      /colour/
    );
    assert.throws(
      () =>
        TOOLS.sync_lights.input.parse({
          lights: [{ id: "light8", managed: true, levels: ["lvl2"], at: [1, 1], dim: -3 }]
        }),
      /Too small/
    );
  });

  it("accepts the read-only keys of a get_scene light, drops id, and sends on its own levels and that it is hand-placed", () => {
    const parsed = TOOLS.sync_lights.input.parse({
      levels: ["lvl2"],
      lights: [
        { id: "light1", managed: true, levels: ["lvl2"], at: [1, 1], dim: 5 },
        { id: "light2", managed: false, levels: [], at: [2, 2] }
      ]
    });
    assert.deepEqual(parsed, {
      levels: ["lvl2"],
      lights: [{ levels: ["lvl2"], at: [1, 1], dim: 5 }, { managed: false }]
    });
  });
});

describe("the level rule of sync_lights, one for the server's input and the module", () => {
  const at = (n: number) => ({ at: [n, n], dim: 20 });
  const setup = (extraLevels: string[]) => {
    const world = fakeWorld({ extraLevels });
    const scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    world.install();
    const positions = () => scene.lights.map((light: any) => light.x).sort((x: number, y: number) => x - y);
    const read = async () => (await methods.get_scene({ sceneId: scene.id })).lights;
    return { world, scene, positions, read };
  };

  for (const [label, extraLevels, all] of [
    ["a one-level scene", [], ["lvl1"]],
    ["a two-level scene", ["lvl2"], ["lvl1", "lvl2"]]
  ] as const) {
    describe(label, () => {
      it("read back with levels [] and given with the call's levels naming every level, replaces them and leaves none out", async () => {
        const { scene, positions, read } = setup([...extraLevels]);
        await viaTool({ sceneId: scene.id, lights: [at(10), at(20)] });
        const result = await viaTool({ sceneId: scene.id, levels: [...all], lights: [...(await read()), at(30)] });
        assert.deepEqual([result.deleted, result.created], [2, 3]);
        assert.deepEqual(positions(), [10, 20, 30]);
      });

      it("stored with the levels naming every level and given without levels, replaces them and leaves none out", async () => {
        const { scene, positions, read } = setup([...extraLevels]);
        await viaTool({ sceneId: scene.id, levels: [...all], lights: [at(10), at(20)] });
        const result = await viaTool({ sceneId: scene.id, lights: [...(await read()), at(30)] });
        assert.deepEqual([result.deleted, result.created], [2, 3]);
        assert.deepEqual(positions(), [10, 20, 30]);
      });

      it("accepts the pure round trip with the call's levels naming every level, and ends with the same lights", async () => {
        const { scene, positions, read } = setup([...extraLevels]);
        await viaTool({ sceneId: scene.id, lights: [at(10)] });
        const result = await viaTool({ sceneId: scene.id, levels: [...all], lights: await read() });
        assert.deepEqual([result.deleted, result.created], [1, 1]);
        assert.deepEqual(positions(), [10]);
      });
    });
  }

  it("on a two-level scene, leaves out a light of another level set, neither writing nor deleting it", async () => {
    const { scene, positions, read } = setup(["lvl2"]);
    await viaTool({ sceneId: scene.id, levels: ["lvl1"], lights: [at(10)] });
    await viaTool({ sceneId: scene.id, levels: ["lvl2"], lights: [at(20)] });
    const result = await viaTool({ sceneId: scene.id, levels: ["lvl2"], lights: [...(await read()), at(30)] });
    assert.deepEqual([result.deleted, result.created], [1, 2]);
    assert.deepEqual(positions(), [10, 20, 30]);
    assert.deepEqual(scene.lights.map((light: any) => [light.x, [...light.levels]]).sort(), [
      [10, ["lvl1"]],
      [20, ["lvl2"]],
      [30, ["lvl2"]]
    ]);
  });

  it("writes the call's levels, never a light's own", async () => {
    const { scene } = setup(["lvl2"]);
    await viaTool({ sceneId: scene.id, levels: ["lvl2"], lights: [{ ...at(10), levels: ["lvl2"] }, at(20)] });
    await viaTool({
      sceneId: scene.id,
      levels: ["lvl1", "lvl2"],
      lights: [
        { ...at(30), levels: [] },
        { ...at(40), levels: ["lvl2", "lvl1"] }
      ]
    });
    assert.deepEqual(scene.lights.map((light: any) => [light.x, [...light.levels]]).sort(), [
      [10, ["lvl2"]],
      [20, ["lvl2"]],
      [30, ["lvl1", "lvl2"]],
      [40, ["lvl1", "lvl2"]]
    ]);
  });

  describe("a call that gave lights and ends with none to write is refused before any write", () => {
    const seed = async () => {
      const ctx = setup(["lvl2"]);
      await viaTool({ sceneId: ctx.scene.id, lights: [at(10), at(20)] });
      ctx.world.addLight(ctx.scene);
      return { ...ctx, before: ctx.positions(), log: { ...ctx.world.log } };
    };
    const hand = { ...at(50), managed: false };
    const lvl2 = { ...at(60), levels: ["lvl2"] };

    for (const [why, lights] of [
      ["every light was hand-placed", [hand, hand]],
      ["every light was on another level set", [lvl2, lvl2]],
      ["some were hand-placed and the rest on another level set", [hand, lvl2]]
    ] as const) {
      it(`when ${why}`, async () => {
        const { scene, positions, before, world, log } = await seed();
        await assert.rejects(
          viaTool({ sceneId: scene.id, lights }),
          refused(
            /^All 2 given lights were left out: each is marked managed: false, .*or has levels of its own that are another level set than this call's \(none, which means all levels\)\. .*lights: \[\] to remove the bridge-made lights of this level set\. Nothing was written\.$/
          )
        );
        assert.deepEqual([positions(), world.log], [before, log]);
      });
    }

    it("and a hand-placed light that the light schema would refuse is left out unchecked beside one that is written", async () => {
      const { scene, positions } = await seed();
      const result = await viaTool({ sceneId: scene.id, lights: [{ managed: false, at: "nowhere" }, at(70)] });
      assert.deepEqual([result.deleted, result.created], [2, 1]);
      assert.ok(positions().includes(70));
    });
  });

  it("a literally empty list removes only the bridge-made lights of the call's level set", async () => {
    const { world, scene, positions } = setup(["lvl2"]);
    const hand = world.addLight(scene, { x: 5, y: 5 });
    await viaTool({ sceneId: scene.id, lights: [at(10)] });
    await viaTool({ sceneId: scene.id, levels: ["lvl1"], lights: [at(20)] });
    await viaTool({ sceneId: scene.id, levels: ["lvl2"], lights: [at(30)] });
    const result = await viaTool({ sceneId: scene.id, levels: ["lvl2"], lights: [] });
    assert.deepEqual([result.deleted, result.created], [1, 0]);
    assert.deepEqual(positions(), [5, 10, 20]);
    assert.ok(scene.lights.has(hand.id));
  });
});

describe("a create that resolves with fewer lights than asked", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    world.install();
  });
  const lights = [
    { at: [10, 10], dim: 5 },
    { at: [20, 20], dim: 5 }
  ];

  it("deletes the lights it just made, leaves the old ones and says how many Foundry created", async () => {
    await viaTool({ sceneId: scene.id, lights: [torch] });
    const before = [...scene.lights.keys()];
    world.control.vetoLight = (light) => light.x === 20;
    await assert.rejects(
      viaTool({ sceneId: scene.id, lights }),
      (error: unknown) =>
        error instanceof MethodError &&
        error.code === "foundry_error" &&
        /created 1 of 2 lights.*deleted again.*existing lights were left/.test(error.message)
    );
    assert.deepEqual([...scene.lights.keys()], before);
  });

  it("treats a light that fails Foundry's own validation the same way", async () => {
    await viaTool({ sceneId: scene.id, lights: [torch] });
    const before = [...scene.lights.keys()];
    const invalid = { at: [30, 30], dim: 5, animation: { type: "flame", speed: 99 } };
    await assert.rejects(
      methods.sync_lights({ sceneId: scene.id, lights: [lights[0], invalid] }),
      /created 1 of 2 lights/
    );
    assert.deepEqual([...scene.lights.keys()], before);
    assert.equal(world.log.notifications.length, 1);
  });

  it("says how many of the new lights were really removed when Foundry deletes fewer than asked", async () => {
    await viaTool({ sceneId: scene.id, lights: [torch] });
    world.control.vetoLight = (light) => light.x === 30;
    const realDelete = scene.deleteEmbeddedDocuments;
    scene.deleteEmbeddedDocuments = (name: string, ids: string[]) => realDelete.call(scene, name, ids.slice(0, 1));
    const three = [...lights, { at: [30, 30], dim: 5 }];
    await assert.rejects(
      viaTool({ sceneId: scene.id, lights: three }),
      (error: unknown) =>
        error instanceof MethodError &&
        /created 2 of 3 lights.*Only 1 of the 2 it did create were deleted again.*1 remain.*flagged as bridge-made/.test(
          error.message
        )
    );
    assert.equal(scene.lights.size, 2);
    scene.deleteEmbeddedDocuments = realDelete;
    world.control.vetoLight = null;
    await viaTool({ sceneId: scene.id, lights: three });
    assert.equal(scene.lights.size, 3);
  });

  it("keeps the old lights when Foundry creates none", async () => {
    await viaTool({ sceneId: scene.id, lights: [torch] });
    const before = [...scene.lights.keys()];
    world.control.vetoLight = () => true;
    await assert.rejects(viaTool({ sceneId: scene.id, lights }), /created 0 of 2 lights/);
    assert.deepEqual([...scene.lights.keys()], before);
  });
});

describe("level sets of bridge-made lights", () => {
  it("a sync replaces the lights of its own level set and leaves the other level sets alone", async () => {
    const world = fakeWorld({ extraLevels: ["lvl2"] });
    const scene = world.addScene({ name: "Tower", width: 1000, height: 800 });
    world.install();
    const at = (x: number) => [{ at: [x, 10], dim: 5 }];
    await viaTool({ sceneId: scene.id, levels: ["lvl1"], lights: at(1) });
    await viaTool({ sceneId: scene.id, levels: ["lvl2"], lights: at(2) });
    await viaTool({ sceneId: scene.id, lights: at(3) });
    const byLevels = () => scene.lights.map((light: any) => `${light.levels.join("+") || "all"}:${light.x}`).sort();
    assert.deepEqual(byLevels(), ["all:3", "lvl1:1", "lvl2:2"]);
    const result = await viaTool({ sceneId: scene.id, levels: ["lvl1"], lights: at(4) });
    assert.deepEqual([result.deleted, result.created], [1, 1]);
    assert.deepEqual(byLevels(), ["all:3", "lvl1:4", "lvl2:2"]);
    await viaTool({ sceneId: scene.id, lights: [] });
    assert.deepEqual(byLevels(), ["lvl1:4", "lvl2:2"]);
    assert.deepEqual((await methods.get_scene({ sceneId: scene.id })).lights.map((light: any) => light.levels).sort(), [
      ["lvl1"],
      ["lvl2"]
    ]);
  });
});
