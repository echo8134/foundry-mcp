import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { BridgeError } from "../src/hub.ts";
import { lightSchema } from "../src/scene-tools.ts";
import { TOOLS } from "../src/tools.ts";
import { connect, text } from "./tool-client.ts";

describe("MCP tools", () => {
  it("lists exactly its tools with model-facing descriptions", async () => {
    const { client } = await connect(() => ({}));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
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
    ]);
    const createWalls = tools.find((t) => t.name === "create_walls")!;
    assert.match(createWalls.description ?? "", /paths/);
    assert.match(createWalls.description ?? "", /frame/);
    assert.match(tools.find((t) => t.name === "get_scene_image")!.description ?? "", /frame/);
  });

  it("sends create_walls arguments to the bridge unchanged as one request", async () => {
    const { client, calls } = await connect(() => ({ created: 4, ids: ["a", "b", "c", "d"], skipped: 0 }));
    const args = {
      sceneId: "scene1",
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
            [0, 0],
            [5, 0]
          ],
          kind: "door"
        }
      ],
      levels: ["lvl"]
    };
    const result = await client.callTool({ name: "create_walls", arguments: args });
    assert.notEqual(result.isError, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "create_walls");
    assert.deepEqual(calls[0]!.params, args);
    assert.deepEqual(JSON.parse(text(result)), { created: 4, ids: ["a", "b", "c", "d"], skipped: 0 });
  });

  const refused: [string, string, Record<string, unknown>, RegExp][] = [
    ["a single-point path", "create_walls", { paths: [{ points: [[1, 1]] }] }, /at paths\[0\]\.points/],
    [
      "a closed path of two points",
      "create_walls",
      {
        paths: [
          {
            points: [
              [1, 1],
              [2, 2]
            ],
            closed: true
          }
        ]
      },
      /closed path needs at least 3 points/
    ],
    [
      "an unknown wall kind",
      "create_walls",
      {
        paths: [
          {
            points: [
              [1, 1],
              [2, 2]
            ],
            kind: "lava"
          }
        ]
      },
      /at paths\[0\]\.kind/
    ],
    [
      "a non-positive frame",
      "create_walls",
      {
        frame: { width: 0, height: 5 },
        paths: [
          {
            points: [
              [1, 1],
              [2, 2]
            ]
          }
        ]
      },
      /at frame\.width/
    ],
    ["delete_walls with both ids and all", "delete_walls", { ids: ["a"], all: true }, /exactly one of ids/],
    ["delete_walls with neither ids nor all", "delete_walls", {}, /exactly one of ids/],
    ["delete_walls with empty ids", "delete_walls", { ids: [] }, /at ids/],
    ["delete_walls with all: false", "delete_walls", { all: false }, /at all/],
    [
      "a door state on a wall path",
      "create_walls",
      {
        paths: [
          {
            points: [
              [1, 1],
              [2, 2]
            ],
            state: "open"
          }
        ]
      },
      /door state needs kind door/
    ],
    [
      "a door state on a window",
      "sync_walls",
      {
        paths: [
          {
            points: [
              [1, 1],
              [2, 2]
            ],
            kind: "window",
            state: "open"
          }
        ]
      },
      /door state needs kind door/
    ],
    [
      "an unknown door state",
      "create_walls",
      {
        paths: [
          {
            points: [
              [1, 1],
              [2, 2]
            ],
            kind: "door",
            state: "ajar"
          }
        ]
      },
      /at paths\[0\]\.state/
    ],
    ["create_walls with no paths", "create_walls", { paths: [] }, /at paths/],
    ["sync_walls without paths", "sync_walls", {}, /at paths/],
    ["sync_walls with a single-point path", "sync_walls", { paths: [{ points: [[1, 1]] }] }, /at paths\[0\]\.points/],
    ["sync_lights without lights", "sync_lights", {}, /at lights/],
    ["a light without a position", "sync_lights", { lights: [{ dim: 20 }] }, /at lights\[0\]\.at/],
    ["a light without a radius", "sync_lights", { lights: [{ at: [1, 1] }] }, /bright or a dim radius above 0/],
    [
      "a light whose radii are both 0",
      "sync_lights",
      { lights: [{ at: [1, 1], bright: 0, dim: 0 }] },
      /bright or a dim radius above 0/
    ],
    ["a negative radius", "sync_lights", { lights: [{ at: [1, 1], dim: -5 }] }, /at lights\[0\]\.dim/],
    ["a radius off Foundry's 0.01 step", "sync_lights", { lights: [{ at: [1, 1], dim: 0.004 }] }, /multiple of 0\.01/],
    [
      "a colour that is not #rrggbb",
      "sync_lights",
      { lights: [{ at: [1, 1], dim: 5, color: "orange" }] },
      /at lights\[0\]\.color/
    ],
    ["a short hex colour", "sync_lights", { lights: [{ at: [1, 1], dim: 5, color: "#f80" }] }, /at lights\[0\]\.color/],
    ["alpha above 1", "sync_lights", { lights: [{ at: [1, 1], dim: 5, alpha: 1.5 }] }, /at lights\[0\]\.alpha/],
    ["an angle above 360", "sync_lights", { lights: [{ at: [1, 1], dim: 5, angle: 400 }] }, /at lights\[0\]\.angle/],
    [
      "a negative rotation",
      "sync_lights",
      { lights: [{ at: [1, 1], dim: 5, rotation: -1 }] },
      /at lights\[0\]\.rotation/
    ],
    [
      "a darkness range with min above max",
      "sync_lights",
      { lights: [{ at: [1, 1], dim: 5, darkness: { min: 0.8, max: 0.2 } }] },
      /min may not be above darkness\.max/
    ],
    [
      "a darkness range above 1",
      "sync_lights",
      { lights: [{ at: [1, 1], dim: 5, darkness: { min: 0, max: 2 } }] },
      /at lights\[0\]\.darkness\.max/
    ],
    ["a blank light name", "sync_lights", { lights: [{ at: [1, 1], dim: 5, name: "  " }] }, /at lights\[0\]\.name/],
    [
      "a blank animation type",
      "sync_lights",
      { lights: [{ at: [1, 1], dim: 5, animation: { type: " " } }] },
      /at lights\[0\]\.animation\.type/
    ],
    [
      "an animation speed above 10",
      "sync_lights",
      { lights: [{ at: [1, 1], dim: 5, animation: { type: "flame", speed: 11 } }] },
      /at lights\[0\]\.animation\.speed/
    ],
    [
      "an animation intensity of 0",
      "sync_lights",
      { lights: [{ at: [1, 1], dim: 5, animation: { type: "flame", intensity: 0 } }] },
      /at lights\[0\]\.animation\.intensity/
    ],
    ["an unknown light field", "sync_lights", { lights: [{ at: [1, 1], dim: 5, flicker: true }] }, /flicker/],
    ["list_scenes with an empty folder name", "list_scenes", { folder: [""] }, /at folder/],
    [
      "ensure_scene with neither name nor sceneId",
      "ensure_scene",
      { width: 10, height: 10 },
      /Give a name, or a sceneId/
    ],
    ["ensure_scene with an unknown grid type", "ensure_scene", { name: "A", grid: { type: "hex" } }, /at grid\.type/],
    [
      "ensure_scene with a grid size below Foundry's minimum",
      "ensure_scene",
      { name: "A", grid: { size: 10 } },
      /at grid\.size/
    ],
    ["ensure_scene with darkness above 1", "ensure_scene", { name: "A", darkness: 1.5 }, /at darkness/],
    ["ensure_scene with padding above 0.5", "ensure_scene", { name: "A", padding: 0.6 }, /at padding/],
    ["ensure_scene with a fractional width", "ensure_scene", { name: "A", width: 10.5 }, /at width/],
    [
      "ensure_scene with an empty background path",
      "ensure_scene",
      { name: "A", background: { src: "" } },
      /at background\.src/
    ],
    ["ensure_scene with an empty folder name", "ensure_scene", { name: "A", folder: ["a", ""] }, /at folder/],
    [
      "ensure_scene with a blank name, which Foundry would trim to nothing",
      "ensure_scene",
      { name: "  ", folder: ["New"] },
      /at name/
    ],
    ["ensure_scene with a blank folder name", "ensure_scene", { name: "A", folder: ["Chapter 5", " "] }, /at folder/],
    [
      "ensure_scene with a blank background path",
      "ensure_scene",
      { name: "A", background: { src: " " } },
      /at background\.src/
    ],
    ["ensure_scene with a fractional shiftX", "ensure_scene", { name: "A", shiftX: 2.5 }, /at shiftX/],
    ["ensure_scene with a fractional shiftY", "ensure_scene", { name: "A", shiftY: 0.5 }, /at shiftY/],
    [
      "ensure_scene with padding off Foundry's 0.05 step",
      "ensure_scene",
      { name: "A", padding: 0.12 },
      /multiple of 0\.05/
    ],
    ["list_scenes with a blank folder name", "list_scenes", { folder: [" "] }, /at folder/],
    [
      "ensure_scene with a data: URL background",
      "ensure_scene",
      { name: "A", background: { src: "data:image/png;base64,iVBORw0KGgo=" } },
      /data: URL is refused/
    ],
    [
      "ensure_scene with a padded, upper-case data: URL background",
      "ensure_scene",
      { name: "A", background: { src: " DATA:image/png;base64,AAAA" } },
      /data: URL is refused/
    ]
  ];
  for (const [label, name, args, message] of refused) {
    it(`refuses ${label} before any request is sent`, async () => {
      const { client, calls } = await connect(() => ({}));
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.match(text(result), message);
      assert.equal(calls.length, 0);
    });
  }

  it("uses a 90 s timeout for get_scene_image and 30 s for the other tools", async () => {
    const { client, calls } = await connect((call) =>
      call.method === "get_scene_image"
        ? { mimeType: "image/webp", data: "AAAA", frame: { width: 1, height: 1 }, background: true }
        : {}
    );
    await client.callTool({ name: "get_scene", arguments: {} });
    await client.callTool({ name: "get_scene_image", arguments: {} });
    await client.callTool({
      name: "create_walls",
      arguments: {
        paths: [
          {
            points: [
              [0, 0],
              [1, 1]
            ]
          }
        ]
      }
    });
    await client.callTool({ name: "delete_walls", arguments: { all: true } });
    await client.callTool({ name: "sync_walls", arguments: { paths: [] } });
    await client.callTool({ name: "sync_lights", arguments: { lights: [] } });
    await client.callTool({ name: "list_scenes", arguments: {} });
    await client.callTool({ name: "ensure_scene", arguments: { name: "A" } });
    assert.deepEqual(
      calls.map((c) => [c.method, c.timeoutMs]),
      [
        ["get_scene", 30_000],
        ["get_scene_image", 90_000],
        ["create_walls", 30_000],
        ["delete_walls", 30_000],
        ["sync_walls", 30_000],
        ["sync_lights", 30_000],
        ["list_scenes", 30_000],
        ["ensure_scene", 90_000]
      ]
    );
  });

  it("sends sync_walls with no paths and a door state to the bridge unchanged", async () => {
    const { client, calls } = await connect(() => ({ deleted: 3, created: 0, ids: [], skipped: 0 }));
    await client.callTool({ name: "sync_walls", arguments: { sceneId: "s", paths: [] } });
    const door = {
      points: [
        [0, 0],
        [5, 0]
      ],
      kind: "secret-door",
      state: "locked"
    };
    await client.callTool({ name: "sync_walls", arguments: { sceneId: "s", paths: [door] } });
    assert.deepEqual(
      calls.map((c) => c.params),
      [
        { sceneId: "s", paths: [] },
        { sceneId: "s", paths: [door] }
      ]
    );
  });

  it("trims every string that Foundry trims before it reaches the bridge", async () => {
    const { client, calls } = await connect(() => ({}));
    await client.callTool({
      name: "ensure_scene",
      arguments: {
        name: " Gates ",
        folder: [" Chapter 5", "Holoth "],
        background: { src: " maps/a.webp " },
        grid: { units: " ft " },
        navName: " Tor ",
        weather: " rain "
      }
    });
    await client.callTool({ name: "list_scenes", arguments: { folder: [" Chapter 5 "] } });
    assert.deepEqual(calls[0]!.params, {
      name: "Gates",
      folder: ["Chapter 5", "Holoth"],
      background: { src: "maps/a.webp" },
      grid: { units: "ft" },
      navName: "Tor",
      weather: "rain"
    });
    assert.deepEqual(calls[1]!.params, { folder: ["Chapter 5"] });
  });

  it("sends sync_lights to the bridge with the colour in lower case and the name trimmed, and everything else as given", async () => {
    const { client, calls } = await connect(() => ({ deleted: 0, created: 1, ids: ["l"] }));
    const light = {
      at: [10, 20],
      bright: 5,
      dim: 20,
      alpha: 0,
      animation: { type: "torch", speed: 0 },
      walls: false,
      hidden: false,
      darkness: { min: 0.2, max: 0.2 }
    };
    const result = await client.callTool({
      name: "sync_lights",
      arguments: {
        sceneId: "s",
        frame: { width: 100, height: 80 },
        lights: [{ ...light, color: "#FF8800", name: " Brazier " }],
        levels: ["lvl"]
      }
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls[0]!.params, {
      sceneId: "s",
      frame: { width: 100, height: 80 },
      lights: [{ ...light, color: "#ff8800", name: "Brazier" }],
      levels: ["lvl"]
    });
    await client.callTool({ name: "sync_lights", arguments: { lights: [] } });
    assert.deepEqual(calls[1]!.params, { lights: [] });
  });

  it("sends token entries to the bridge with every token field they carry, for the module to check", async () => {
    const { client, calls } = await connect(() => ({}));
    const place = {
      sceneId: "scene1",
      frame: { width: 10, height: 8 },
      tokens: [{ actor: "a1", at: [1.5, 2.5], snap: false, hidden: true, light: { dim: 20 }, hiden: 1 }]
    };
    const update = { tokens: [{ id: "t1", at: [3, 4], rotation: 90, flags: { dnd5e: { lockSize: true } } }] };
    for (const [name, args] of [
      ["place_tokens", place],
      ["update_tokens", update],
      ["delete_tokens", { ids: ["t1"] }],
      ["get_scene", { tokens: ["t1"] }]
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, name);
    }
    assert.deepEqual(
      calls.map((call) => [call.method, call.params, call.timeoutMs]),
      [
        ["place_tokens", place, 30_000],
        ["update_tokens", update, 30_000],
        ["delete_tokens", { ids: ["t1"] }, 30_000],
        ["get_scene", { tokens: ["t1"] }, 30_000]
      ]
    );
  });

  for (const [label, name, args, message] of [
    ["place_tokens without tokens", "place_tokens", { tokens: [] }, />=1 items at tokens$/],
    [
      "a token to place without at",
      "place_tokens",
      { tokens: [{ actor: "a1" }] },
      /expected tuple.* at tokens\[0\]\.at$/
    ],
    ["update_tokens with snap but no at", "update_tokens", { tokens: [{ id: "t1", snap: false }] }, /snap needs at/],
    ["delete_tokens without ids", "delete_tokens", { ids: [] }, />=1 items at ids$/]
  ] as const) {
    it(`refuses ${label} before any request is sent`, async () => {
      const { client, calls } = await connect(() => ({}));
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.match(text(result), message);
      assert.equal(calls.length, 0);
    });
  }

  it("tells a caller of the token tools what at, snap, disposition, movement and size mean", async () => {
    const { client } = await connect(() => ({}));
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((t) => t.name === name)!.description ?? "";
    for (const name of ["place_tokens", "update_tokens"]) {
      assert.match(description(name), /`at` is the token's centre/, name);
      assert.match(description(name), /-2 secret, -1 hostile, 0 neutral, 1 friendly/, name);
      assert.match(description(name), /flags\.dnd5e\.lockSize/, name);
      assert.match(description(name), /unapplied/, name);
    }
    assert.match(description("place_tokens"), /Not safe to repeat/);
    assert.match(description("place_tokens"), /prototype token/);
    assert.match(description("update_tokens"), /teleport: no wall stops it/);
    assert.match(description("update_tokens"), /nothing is written/);
    assert.match(description("delete_tokens"), /combats/);
    assert.match(description("delete_tokens"), /unlinked token's own actor data/);
    assert.match(description("get_scene"), /tokenData/);
    const snap = (TOOLS.place_tokens.input as any).shape.tokens.element.shape.snap.description;
    assert.match(snap, /Default true/);
  });

  it("tells a caller of the token tools what dnd5e and Foundry do with a token's data, as measured", async () => {
    const { client } = await connect(() => ({}));
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((t) => t.name === name)!.description ?? "";
    for (const name of ["place_tokens", "update_tokens"]) {
      assert.match(description(name), /size from its actor's size when the actor's size changes/, name);
      assert.match(description(name), /whose far edges are outside/, name);
      assert.match(description(name), /keys with a dot or a leading -= or == are refused/, name);
      assert.match(description(name), /a value Foundry would store as something else/, name);
    }
    for (const name of ["place_tokens", "update_tokens", "get_scene"]) {
      assert.match(description(name), /senseVisionSync setting is on \(its default\)/, name);
      assert.match(description(name), /set vision range on the actor/, name);
      assert.doesNotMatch(description(name), /whenever the actor changes/, name);
    }
    assert.match(description("get_scene"), /resets them when the actor's size changes/);
    assert.match(description("get_scene"), /An entry passed back unchanged writes nothing/);
    assert.match(description("place_tokens"), /the error names it and the tokens created before it/);
    assert.match(description("update_tokens"), /A level change keeps the elevation, so give elevation with level/);
    assert.match(description("update_tokens"), /falling, and records the move on the token's actor/);
    assert.match(description("update_tokens"), /tokenData can be passed back as it is/);
    assert.match(description("update_tokens"), /an at equal to the token's centre moves nothing, whatever snap says/);
    assert.match(description("update_tokens"), /changed \(the field paths whose stored value changed\)/);
    assert.doesNotMatch(description("update_tokens"), /on any scene/);
  });

  for (const tool of ["place_tokens", "update_tokens", "delete_tokens"] as const) {
    it(`a timeout on ${tool} warns that it may have been applied, and says how to go on`, async () => {
      const { client } = await connect(() => {
        throw new BridgeError("timeout", "Foundry did not answer.");
      });
      const args = {
        place_tokens: { tokens: [{ actor: "a1", at: [0, 0] }] },
        update_tokens: { tokens: [{ id: "t1", hidden: true }] },
        delete_tokens: { ids: ["t1"] }
      }[tool];
      const result = await client.callTool({ name: tool, arguments: args });
      assert.match(text(result), /may still have been applied in Foundry/);
      assert.match(text(result), tool === "update_tokens" ? /same call again is safe/ : /get_scene before retrying/);
    });
  }

  it("sends a sync_regions entry to the bridge with the fields only the module can check, its names trimmed", async () => {
    const { client, calls } = await connect(() => ({}));
    const region = {
      name: " Stair ",
      shapes: [
        {
          type: "polygon",
          points: [
            [0, 0],
            [5, 0],
            [5, 5]
          ],
          hole: true
        }
      ],
      elevation: { bottom: 0, top: null },
      behaviors: [{ type: " teleportToken ", name: " Up ", system: { destinations: [{ region: "Landing" }] } }],
      id: "region0000000001",
      managed: true,
      levels: ["upper"]
    };
    await client.callTool({
      name: "sync_regions",
      arguments: { sceneId: "s", frame: { width: 10, height: 8 }, levels: ["upper"], regions: [region] }
    });
    assert.deepEqual(calls[0]!.params, {
      sceneId: "s",
      frame: { width: 10, height: 8 },
      levels: ["upper"],
      regions: [
        {
          ...region,
          name: "Stair",
          behaviors: [{ type: "teleportToken", name: "Up", system: { destinations: [{ region: "Landing" }] } }]
        }
      ]
    });
    await client.callTool({ name: "sync_regions", arguments: { regions: [] } });
    assert.deepEqual(calls[1]!.params, { regions: [] });
    for (const bad of [{ shapes: [] }, { name: " ", shapes: [] }, { name: "A" }, { name: "A", shapes: [{ x: 1 }] }]) {
      const refused = await client.callTool({ name: "sync_regions", arguments: { regions: [bad] } });
      assert.equal(refused.isError, true, JSON.stringify(bad));
    }
    assert.equal(calls.length, 2);
  });

  it("a timeout on sync_regions warns that it may have been applied, and that the same call again is safe", async () => {
    const { client } = await connect(() => {
      throw new BridgeError("timeout", "Foundry did not answer.");
    });
    const result = await client.callTool({ name: "sync_regions", arguments: { regions: [] } });
    assert.match(text(result), /may still have been applied in Foundry\. Running the same call again is safe/);
  });

  it("describes what sync_regions owns, what it never touches and how a pair of stairs is built", async () => {
    const { client } = await connect(() => ({}));
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === "sync_regions")!.description ?? "";
    for (const promise of [
      /updated in place where it exists, so it keeps its id and its UUID/,
      /Regions made by hand carry no flag and are never touched/,
      /only the bridge-made regions of exactly that level set/,
      /Behaviors someone added in\s+Foundry are never touched/,
      /a second run writes nothing/,
      /reported as pending/,
      /executeScript and executeMacro are refused/
    ]) {
      assert.match(description, promise);
    }
  });

  it("sends showLights to the bridge for get_scene_image", async () => {
    const { client, calls } = await connect(() => ({
      mimeType: "image/webp",
      data: "AAAA",
      frame: { width: 1, height: 1 },
      background: true
    }));
    await client.callTool({ name: "get_scene_image", arguments: { showLights: true } });
    assert.deepEqual(calls[0]!.params, { showLights: true });
  });

  it("sends the level and showRegions to the bridge for get_scene_image, and refuses an empty level id", async () => {
    const { client, calls } = await connect(() => ({
      mimeType: "image/webp",
      data: "AAAA",
      frame: { width: 1, height: 1 },
      background: true
    }));
    await client.callTool({ name: "get_scene_image", arguments: { level: "lvlTower", showRegions: true } });
    assert.deepEqual(calls[0]!.params, { level: "lvlTower", showRegions: true });
    const refused = await client.callTool({ name: "get_scene_image", arguments: { level: "" } });
    assert.equal(refused.isError, true);
    assert.equal(calls.length, 1);
  });

  it("describes what sync_lights promises about repeating it, and that radii are not pixels", async () => {
    const { client } = await connect(() => ({}));
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === "sync_lights")!.description ?? "";
    assert.match(description, /Safe to run again/);
    assert.match(description, /never touched/);
    assert.match(description, /grid distance units/);
    assert.match(description, /larger of the two/);
  });

  it("accepts padding in steps of 0.05, including the ones that are not exact in floating point", async () => {
    const { client, calls } = await connect(() => ({}));
    for (const padding of [0, 0.05, 0.15, 0.25, 0.35, 0.5]) {
      const result = await client.callTool({ name: "ensure_scene", arguments: { name: "A", padding } });
      assert.notEqual(result.isError, true, `padding ${padding}`);
    }
    assert.deepEqual(
      calls.map((c) => c.params.padding),
      [0, 0.05, 0.15, 0.25, 0.35, 0.5]
    );
  });

  it("accepts negative integer shifts and says in which direction a positive one moves the map", async () => {
    const { client, calls } = await connect(() => ({}));
    const result = await client.callTool({ name: "ensure_scene", arguments: { name: "A", shiftX: -30, shiftY: 20 } });
    assert.notEqual(result.isError, true);
    assert.deepEqual([calls[0]!.params.shiftX, calls[0]!.params.shiftY], [-30, 20]);
    const text = JSON.stringify((await client.listTools()).tools.find((t) => t.name === "ensure_scene")!);
    assert.match(text, /positive value moves the map left/);
  });

  it("accepts an empty folder path for list_scenes and ensure_scene, meaning the root", async () => {
    const { client, calls } = await connect(() => ({}));
    assert.notEqual((await client.callTool({ name: "list_scenes", arguments: { folder: [] } })).isError, true);
    assert.notEqual(
      (await client.callTool({ name: "ensure_scene", arguments: { name: "A", folder: [] } })).isError,
      true
    );
    assert.deepEqual(
      calls.map((c) => c.params.folder),
      [[], []]
    );
  });

  it("sends ensure_scene fields to the bridge unchanged", async () => {
    const { client, calls } = await connect(() => ({ id: "s", name: "A", folder: [], created: true, changed: [] }));
    const args = {
      name: "A",
      folder: ["Chapter 5", "Holoth"],
      background: { src: "maps/a.webp" },
      width: 2000,
      height: 1000,
      grid: { type: "gridless", size: 50, distance: 5, units: "ft" },
      darkness: 0,
      weather: ""
    };
    const result = await client.callTool({ name: "ensure_scene", arguments: args });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls[0]!.params, args);
  });

  it("serialises a bridge answer without a result as null instead of failing the call", async () => {
    const { client } = await connect(() => undefined);
    const result = await client.callTool({ name: "delete_walls", arguments: { all: true } });
    assert.notEqual(result.isError, true);
    assert.equal(text(result), "null");
  });

  for (const tool of ["create_walls", "delete_walls", "sync_walls", "sync_lights", "sync_regions"]) {
    it(`${tool} advises passing the sceneId from get_scene`, async () => {
      const { client } = await connect(() => ({}));
      const { tools } = await client.listTools();
      assert.match(tools.find((t) => t.name === tool)!.description ?? "", /Pass the sceneId from get_scene/);
    });
  }

  it("describes what ensure_scene and sync_walls promise about repeating them", async () => {
    const { client } = await connect(() => ({}));
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((t) => t.name === name)!.description ?? "";
    assert.match(description("ensure_scene"), /changes nothing/);
    assert.match(description("ensure_scene"), /sceneId/);
    assert.match(description("ensure_scene"), /unapplied/);
    assert.match(description("ensure_scene"), /moves everything already placed/);
    assert.match(description("sync_walls"), /never touched/);
    assert.match(description("list_scenes"), /id for ensure_scene/);
  });

  it("names what get_scene returns for a scene, a wall and a light, and what hidden does", async () => {
    const { client } = await connect(() => ({}));
    const { tools } = await client.listTools();
    const description = tools.find((t) => t.name === "get_scene")!.description ?? "";
    for (const word of ["navName", "folder", "managed", "levels", "lights"])
      assert.match(description, new RegExp(word));
    const hidden = lightSchema.shape.hidden.description ?? "";
    assert.match(hidden, /off for everyone/);
    assert.doesNotMatch(hidden, /Hidden from players/);
    assert.match(tools.find((t) => t.name === "sync_lights")!.description ?? "", /not hide it from players only/);
  });

  describe("sync_lights input", () => {
    const parse = (args: unknown) => TOOLS.sync_lights.input.safeParse(args);
    const issues = (args: unknown) => {
      const result = parse(args);
      assert.equal(result.success, false);
      return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    };

    it("sends a hand-placed light on as no more than that, unchecked, for the module to leave out", () => {
      assert.deepEqual(
        parse({
          lights: [
            { at: [1, 1], dim: 10, managed: false },
            { managed: false, at: "x" }
          ]
        }).data,
        {
          lights: [{ managed: false }, { managed: false }]
        }
      );
    });

    it("lets a literally empty list through, and sends a light's own levels on for the module to compare", () => {
      assert.deepEqual(parse({ lights: [] }).data, { lights: [] });
      const mixed = parse({
        lights: [
          { at: [50, 50], dim: 10, levels: ["lvl2"] },
          { at: [2, 2], dim: 5 },
          { at: [3, 3], dim: 5, managed: false }
        ]
      });
      assert.deepEqual(mixed.data, {
        lights: [{ at: [50, 50], dim: 10, levels: ["lvl2"] }, { at: [2, 2], dim: 5 }, { managed: false }]
      });
      assert.deepEqual(
        parse({ levels: ["lvl1"], lights: [{ id: "l", managed: true, levels: [], at: [1, 1], dim: 5 }] }).data,
        { levels: ["lvl1"], lights: [{ levels: [], at: [1, 1], dim: 5 }] }
      );
    });

    it("validates a light's own levels as a list of strings instead of throwing or reading a string as characters", () => {
      for (const levels of [5, "lvl2", {}, null, [1], [""]]) {
        const found = issues({ lights: [{ at: [1, 1], dim: 10, levels }] });
        assert.match(found.join("\n"), /^lights\.0\.levels/, JSON.stringify(levels));
      }
      assert.deepEqual(parse({ lights: [{ at: [1, 1], dim: 10, levels: [] }] }).data, {
        lights: [{ at: [1, 1], dim: 10, levels: [] }]
      });
    });

    it("publishes a light schema that a real light satisfies under draft-07, the dialect the tool schema declares", async () => {
      const { client } = await connect(() => ({}));
      const { tools } = await client.listTools();
      const published = tools.find((t) => t.name === "sync_lights")!.inputSchema;
      assert.equal(published.$schema, "http://json-schema.org/draft-07/schema#");
      const validate = new AjvJsonSchemaValidator().getValidator(published);
      const light = {
        id: "l1",
        at: [10, 20],
        levels: [],
        managed: true,
        dim: 5,
        animation: { type: "torch" },
        darkness: { min: 0, max: 1 }
      };
      assert.equal(validate({ lights: [light] }).valid, true);
      assert.equal(
        validate({ sceneId: "s", frame: { width: 10, height: 10 }, lights: [], levels: ["lvl1"] }).valid,
        true
      );
      assert.equal(validate({ lights: [{ dim: 5 }] }).valid, false, "at is required");
      assert.equal(validate({ lights: [{ at: [10], dim: 5 }] }).valid, false, "at takes two numbers");
      assert.equal(validate({ lights: [{ at: [10, 20, 30], dim: 5 }] }).valid, false, "at takes only two numbers");
      assert.equal(validate({ lights: [{ ...light, flicker: true }] }).valid, false, "unknown fields are refused");
      const at = (published.properties as any).lights.items.properties.at;
      assert.equal(
        JSON.stringify(at.items),
        JSON.stringify([{ type: "number" }, { type: "number" }]),
        "the tuple is written as draft-07 items"
      );
      assert.equal(at.prefixItems, undefined);
    });

    it("publishes the real fields of a light, not any object, and says what managed and levels do", async () => {
      const { client } = await connect(() => ({}));
      const { tools } = await client.listTools();
      const lights = (tools.find((t) => t.name === "sync_lights")!.inputSchema.properties as any).lights;
      assert.equal(lights.type, "array");
      assert.equal(lights.items.anyOf, undefined);
      assert.equal(lights.items.additionalProperties, false);
      assert.deepEqual(lights.items.required, ["at"]);
      for (const field of [
        "at",
        "bright",
        "dim",
        "color",
        "animation",
        "darkness",
        "negative",
        "id",
        "managed",
        "levels"
      ])
        assert.ok(lights.items.properties[field], field);
      assert.doesNotMatch(lights.items.properties.managed.description, /Ignored/);
      assert.doesNotMatch(lights.items.properties.levels.description, /Ignored/);
      assert.match(lights.items.properties.managed.description, /left out/);
      assert.match(lights.items.properties.levels.description, /left out/);
    });
  });

  it("explains how to compare wall coordinates with an image only through the scale factor", async () => {
    const { client } = await connect(() => ({}));
    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === "get_scene")!.description ?? "", /multiply by imageFrame \/ sceneFrame/);
  });

  for (const code of ["timeout", "bridge_closed"] as const) {
    const argsFor = {
      create_walls: {
        paths: [
          {
            points: [
              [0, 0],
              [1, 1]
            ]
          }
        ]
      },
      delete_walls: { all: true },
      sync_walls: { paths: [] },
      sync_lights: { lights: [] },
      ensure_scene: { name: "A" }
    };
    for (const tool of ["create_walls", "delete_walls", "sync_walls", "sync_lights", "ensure_scene"] as const) {
      it(`a ${code} on ${tool} warns that it may have been applied`, async () => {
        const { client } = await connect(() => {
          throw new BridgeError(code, "Foundry did not answer.");
        });
        const args = argsFor[tool];
        const result = await client.callTool({ name: tool, arguments: args });
        assert.equal(result.isError, true);
        assert.match(text(result), /may still have been applied in Foundry/);
        assert.match(
          text(result),
          tool === "ensure_scene" ? /list_scenes before retrying/ : /get_scene before retrying/
        );
      });
    }
  }

  it("does not add the warning to read-only tools or to failures that never reached Foundry", async () => {
    const timeout = await connect(() => {
      throw new BridgeError("timeout", "Foundry did not answer.");
    });
    assert.doesNotMatch(
      text(await timeout.client.callTool({ name: "get_scene", arguments: {} })),
      /may still have been applied/
    );
    assert.doesNotMatch(
      text(await timeout.client.callTool({ name: "list_scenes", arguments: {} })),
      /may still have been applied/
    );
    const absent = await connect(() => {
      throw new BridgeError("no_bridge", "No Foundry bridge is connected.");
    });
    assert.doesNotMatch(
      text(await absent.client.callTool({ name: "delete_walls", arguments: { all: true } })),
      /may still have been applied/
    );
  });

  it("turns a bridge error into an isError result", async () => {
    const { client } = await connect(() => {
      throw new BridgeError("not_found", "No scene to work on.");
    });
    const result = await client.callTool({ name: "get_scene", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(text(result), "Foundry reported not_found: No scene to work on.");
  });

  it("turns a missing bridge into an isError result carrying the instructions", async () => {
    const { client } = await connect(() => {
      throw new BridgeError("no_bridge", "No Foundry bridge is connected. Open the world as Gamemaster.");
    });
    const result = await client.callTool({ name: "get_scene", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(text(result), /Open the world as Gamemaster/);
  });

  it("returns get_scene_image as an image block plus the frame as JSON", async () => {
    const { client } = await connect(() => ({
      mimeType: "image/webp",
      data: "AAAA",
      frame: { width: 800, height: 640 },
      background: true
    }));
    const result = await client.callTool({ name: "get_scene_image", arguments: { showWalls: true } });
    const content = result.content as { type: string; data?: string; mimeType?: string; text?: string }[];
    assert.equal(content.length, 2);
    assert.deepEqual(content[0], { type: "image", data: "AAAA", mimeType: "image/webp" });
    assert.deepEqual(JSON.parse(content[1]!.text!), { frame: { width: 800, height: 640 }, background: true });
  });

  it("reports a malformed image answer from the bridge as an error result", async () => {
    const { client } = await connect(() => ({ nonsense: true }));
    const result = await client.callTool({ name: "get_scene_image", arguments: {} });
    assert.equal(result.isError, true);
  });
});
