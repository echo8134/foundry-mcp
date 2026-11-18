import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MethodError, ERROR_CODES as MODULE_ERROR_CODES } from "../module/scripts/errors.mjs";
import { METHODS as MODULE_METHODS, QUEUE_BUDGET_MS } from "../module/scripts/methods.mjs";
import { SURFACE } from "../module/scripts/surface.mjs";
import { timing } from "../module/scripts/world.mjs";
import { ERROR_CODES as PROTOCOL_ERROR_CODES, METHODS as PROTOCOL_METHODS } from "../src/protocol.ts";
import { TOOLS } from "../src/tools.ts";

describe("method list", () => {
  it("is the same in the module registry, the protocol and the tool table", () => {
    const expected = [...PROTOCOL_METHODS].sort();
    assert.deepEqual(Object.keys(MODULE_METHODS).sort(), expected);
    assert.deepEqual(Object.keys(TOOLS).sort(), expected);
  });

  it("has a method surface number that was raised with the last change of the method list", () => {
    assert.deepEqual(
      { surface: SURFACE, methods: [...PROTOCOL_METHODS].sort() },
      {
        surface: 8,
        methods: [
          "create_documents",
          "create_walls",
          "delete_actors",
          "delete_documents",
          "delete_tokens",
          "delete_walls",
          "ensure_actor",
          "ensure_scene",
          "get_actor",
          "get_document",
          "get_scene",
          "get_scene_image",
          "get_schema",
          "list_actors",
          "list_documents",
          "list_scenes",
          "place_tokens",
          "sync_lights",
          "sync_regions",
          "sync_walls",
          "update_documents",
          "update_tokens"
        ]
      },
      "The method list changed: raise SURFACE in module/scripts/surface.mjs and update both here."
    );
  });

  it("derives each tool name from its table key", () => {
    for (const [key, tool] of Object.entries(TOOLS)) assert.equal(tool.name, key);
  });

  it("gives each serialised method a time budget a few seconds below its tool's timeout", () => {
    assert.deepEqual(Object.keys(QUEUE_BUDGET_MS).sort(), [
      "create_documents",
      "create_walls",
      "delete_actors",
      "delete_documents",
      "delete_tokens",
      "delete_walls",
      "ensure_actor",
      "ensure_scene",
      "place_tokens",
      "sync_lights",
      "sync_regions",
      "sync_walls",
      "update_documents",
      "update_tokens"
    ]);
    for (const [name, budget] of Object.entries(QUEUE_BUDGET_MS)) {
      assert.ok(
        budget <= TOOLS[name as keyof typeof TOOLS].timeoutMs - 3000,
        `${name}: ${budget} ms against ${TOOLS[name as keyof typeof TOOLS].timeoutMs} ms`
      );
    }
    assert.ok(timing.textureLoadMs < QUEUE_BUDGET_MS.ensure_scene);
    assert.ok(timing.textureLoadMs < QUEUE_BUDGET_MS.ensure_actor);
    assert.ok(timing.textureLoadMs < QUEUE_BUDGET_MS.create_documents);
    assert.ok(timing.textureLoadMs < QUEUE_BUDGET_MS.update_documents);
    assert.ok(timing.textureLoadMs < TOOLS.get_scene_image.timeoutMs);
  });

  it("has the same error codes in the module and the protocol", () => {
    assert.deepEqual([...MODULE_ERROR_CODES].sort(), [...PROTOCOL_ERROR_CODES].sort());
  });
});

type Method = (params: any) => Promise<any>;
const methods = MODULE_METHODS as { create_walls: Method; delete_walls: Method; get_scene_image: Method };

type Walls = Map<string, { id: string }> & { map: <T>(fn: (wall: { id: string }) => T) => T[] };

function stubScene(options: { levels?: string[]; walls?: string[]; src?: string | null } = {}) {
  const walls = new Map((options.walls ?? []).map((id) => [id, { id }])) as Walls;
  walls.map = (fn) => [...walls.values()].map(fn);
  const created: unknown[][] = [];
  const scene = {
    id: "scene1",
    name: "Cellar",
    dimensions: { sceneX: 0, sceneY: 0, sceneWidth: 1000, sceneHeight: 800 },
    grid: { distance: 5 },
    levels: new Map((options.levels ?? ["lvl1"]).map((id) => [id, { id }])),
    initialLevel: {
      id: "lvl1",
      background: { src: options.src ?? null, color: "#999999" },
      foreground: { src: null },
      visibility: { levels: [] }
    },
    walls,
    async createEmbeddedDocuments(_name: string, data: unknown[]) {
      created.push(data);
      return data.map((_, i) => ({ id: `w${i}` }));
    },
    async deleteEmbeddedDocuments(_name: string, ids: string[]) {
      return ids.map((id) => ({ id }));
    },
    createThumbnail: async () => {
      throw new Error("render stub");
    }
  };
  return { scene, created };
}

describe("module methods against a stubbed scene", () => {
  const globals = globalThis as Record<string, unknown>;
  const saved = { game: globals.game, canvas: globals.canvas, foundry: globals.foundry };
  let texturesRequested: string[] = [];

  function install(scene: object, loadTexture: (src: string) => Promise<unknown> = async () => ({})) {
    texturesRequested = [];
    globals.game = { scenes: { get: (id: string) => (id === "scene1" ? scene : undefined), active: null } };
    globals.canvas = { scene: null };
    globals.foundry = {
      canvas: {
        loadTexture: async (src: string) => {
          texturesRequested.push(src);
          return loadTexture(src);
        }
      }
    };
  }

  afterEach(() => {
    Object.assign(globals, saved);
  });

  const path = {
    points: [
      [0, 0],
      [10, 0]
    ]
  };

  it("create_walls names its target scene in the result", async () => {
    const { scene } = stubScene();
    install(scene);
    const result = await methods.create_walls({ sceneId: "scene1", paths: [path] });
    assert.deepEqual(result, {
      created: 1,
      requested: 1,
      ids: ["w0"],
      skipped: 0,
      sceneId: "scene1",
      sceneName: "Cellar"
    });
    const nothing = await methods.create_walls({
      sceneId: "scene1",
      paths: [
        {
          points: [
            [1, 1],
            [1, 1]
          ]
        }
      ]
    });
    assert.deepEqual(nothing, {
      created: 0,
      requested: 0,
      ids: [],
      skipped: 1,
      sceneId: "scene1",
      sceneName: "Cellar"
    });
  });

  it("delete_walls names its target scene in the result", async () => {
    const { scene } = stubScene({ walls: ["a", "b"] });
    install(scene);
    assert.deepEqual(await methods.delete_walls({ sceneId: "scene1", all: true }), {
      deleted: 2,
      sceneId: "scene1",
      sceneName: "Cellar"
    });
    assert.deepEqual(await methods.delete_walls({ sceneId: "scene1", ids: ["zzz"] }), {
      deleted: 0,
      sceneId: "scene1",
      sceneName: "Cellar"
    });
  });

  it("create_walls refuses level ids the scene does not have and creates nothing", async () => {
    const { scene, created } = stubScene({ levels: ["lvl1"] });
    install(scene);
    await assert.rejects(
      methods.create_walls({ sceneId: "scene1", paths: [path], levels: ["lvl1", "ghost", "phantom"] }),
      (error: unknown) =>
        error instanceof MethodError && error.code === "invalid_params" && /ghost, phantom/.test(error.message)
    );
    assert.equal(created.length, 0);
    await methods.create_walls({ sceneId: "scene1", paths: [path], levels: ["lvl1"] });
    assert.equal(created.length, 1);
  });

  it("get_scene_image answers foundry_error naming the src when the background cannot be loaded", async () => {
    const { scene } = stubScene({ src: "maps/missing.webp" });
    install(scene, async () => null);
    await assert.rejects(
      methods.get_scene_image({ sceneId: "scene1" }),
      (error: unknown) =>
        error instanceof MethodError && error.code === "foundry_error" && error.message.includes("maps/missing.webp")
    );
    assert.deepEqual(texturesRequested, ["maps/missing.webp"]);
  });

  it("get_scene_image loads no texture for a scene without a background image and goes on to render it", async () => {
    const { scene } = stubScene({ src: null });
    install(scene);
    await assert.rejects(
      methods.get_scene_image({ sceneId: "scene1" }),
      /Foundry could not render the scene: render stub/
    );
    assert.deepEqual(texturesRequested, []);
  });
});
