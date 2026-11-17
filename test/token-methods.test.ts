import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
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
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

const managedFlag = { "foundry-mcp": { managed: true } };

describe("get_scene tokens", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar", width: 1000, height: 800, padding: 0.25 });
    world.install();
  });

  it("lists every token with its centre in scene pixels, its size in grid units and its stored codes", async () => {
    assert.deepEqual([scene.dimensions.sceneX, scene.dimensions.sceneY], [300, 200]);
    const goblin = world.addActor({ name: "Goblin", type: "npc" });
    const token = world.addToken(scene, {
      name: "Goblin",
      actorId: goblin.id,
      x: 500,
      y: 400,
      width: 2,
      height: 2,
      elevation: 10,
      hidden: true,
      disposition: -1,
      rotation: 90
    });
    const [entry] = (await methods.get_scene({ sceneId: scene.id })).tokens;
    assert.deepEqual(entry, {
      id: token.id,
      name: "Goblin",
      actorId: goblin.id,
      actorLink: false,
      at: [300, 300],
      width: 2,
      height: 2,
      elevation: 10,
      level: "lvl1",
      hidden: true,
      disposition: -1,
      rotation: 90,
      managed: false
    });
  });

  it("reports hit points from the linked actor, from an unlinked token's own actor, and none without them", async () => {
    const hp = { value: 7, max: 7, temp: 0 };
    const goblin = world.addActor({ name: "Goblin", system: { attributes: { hp } } });
    const party = world.addActor({ name: "Party", type: "group", system: { members: [] } });
    world.addToken(scene, { name: "linked", actorId: goblin.id, actorLink: true });
    world.addToken(scene, {
      name: "unlinked",
      actorId: goblin.id,
      delta: { system: { attributes: { hp: { value: 3 } } } }
    });
    world.addToken(scene, { name: "orphan", actorId: "deletedActor" });
    world.addToken(scene, { name: "group", actorId: party.id, actorLink: true });
    world.addToken(scene, { name: "no actor" });
    const tokens = (await methods.get_scene({ sceneId: scene.id })).tokens;
    const byName = Object.fromEntries(tokens.map((t: any) => [t.name, t]));
    assert.deepEqual(byName.linked.hp, { value: 7, max: 7 });
    assert.deepEqual(byName.unlinked.hp, { value: 3, max: 7 });
    for (const name of ["orphan", "group", "no actor"]) assert.equal("hp" in byName[name], false, name);
  });

  it("marks bridge-made tokens as managed", async () => {
    world.addToken(scene, { name: "by hand" });
    world.addToken(scene, { name: "bridge", flags: managedFlag });
    const tokens = (await methods.get_scene({ sceneId: scene.id })).tokens;
    assert.deepEqual(
      tokens.map((t: any) => [t.name, t.managed]),
      [
        ["by hand", false],
        ["bridge", true]
      ]
    );
  });

  it("returns an empty list for a scene without tokens", async () => {
    assert.deepEqual((await methods.get_scene({ sceneId: scene.id })).tokens, []);
  });

  it("returns the stored data of the tokens asked for, with id and the centre at in place of _id, x and y", async () => {
    const token = world.addToken(scene, {
      name: "Goblin",
      x: 500,
      y: 400,
      hidden: true,
      light: { dim: 20, bright: 10 },
      flags: { dnd5e: { lockSize: true } },
      delta: { system: { attributes: { hp: { value: 3 } } } }
    });
    world.addToken(scene, { name: "other" });
    const { tokenData } = await methods.get_scene({ sceneId: scene.id, tokens: [token.id] });
    assert.equal(tokenData.length, 1);
    const [data] = tokenData;
    assert.deepEqual(
      [data.id, data.at, data.name, data.hidden, data.light, data.flags],
      [token.id, [250, 250], "Goblin", true, { dim: 20, bright: 10, color: null }, { dnd5e: { lockSize: true } }]
    );
    for (const key of ["_id", "x", "y", "delta", "_movementHistory", "_regions"]) assert.equal(key in data, false, key);
    const { at: _at, id: _id, ...stored } = data;
    const { _id: _storedId, x: _x, y: _y, delta: _delta, _movementHistory, _regions, ...expected } = token._source;
    assert.deepEqual(stored, expected);
  });

  it("measures a token's centre from its stored position, not from one the document shows while it animates", async () => {
    const token = world.addToken(scene, { name: "Goblin", x: 500, y: 400 });
    token.prepared.x = 533;
    token.prepared.y = 441;
    const read = await methods.get_scene({ sceneId: scene.id, tokens: [token.id] });
    assert.deepEqual(
      [read.tokens[0].at, read.tokenData[0].at],
      [
        [250, 250],
        [250, 250]
      ]
    );
  });

  it("returns no token data unless asked, and answers not_found for an id that is not on the scene", async () => {
    world.addToken(scene, { name: "Goblin" });
    assert.deepEqual((await methods.get_scene({ sceneId: scene.id })).tokenData, []);
    await assert.rejects(
      methods.get_scene({ sceneId: scene.id, tokens: ["ghost"] }),
      (error: any) => error.code === "not_found" && /no token with the id ghost/.test(error.message)
    );
  });
});

function stubDrawing() {
  const calls: { op: string; args: number[]; strokeStyle: string; fillStyle: string; globalAlpha: number }[] = [];
  const state = { strokeStyle: "", fillStyle: "", globalAlpha: 1, lineWidth: 0 };
  const record =
    (op: string) =>
    (...args: number[]) =>
      calls.push({ op, args, ...state });
  const context = Object.assign(state, {
    fillRect() {},
    drawImage() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc: record("arc"),
    ellipse: record("ellipse"),
    stroke: record("stroke"),
    fill: record("fill")
  });
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

describe("get_scene_image showTokens", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar", width: 1000, height: 800, padding: 0.25 });
    world.install();
  });

  it("draws each token as an ellipse over its footprint, scaled to the image, filled unless hidden", async () => {
    const calls = stubDrawing();
    world.addToken(scene, { x: 500, y: 400, width: 2, height: 1, disposition: 1 });
    world.addToken(scene, { x: 300, y: 200, disposition: -1, hidden: true });
    const result = await methods.get_scene_image({ sceneId: scene.id, maxSize: 500, showTokens: true });
    assert.deepEqual(result.frame, { width: 500, height: 400 });
    const ellipses = calls.filter((call) => call.op === "ellipse").map((call) => call.args.slice(0, 4));
    assert.deepEqual(ellipses, [
      [150, 125, 50, 25],
      [25, 25, 25, 25]
    ]);
    const fills = calls.filter((call) => call.op === "fill");
    assert.equal(fills.length, 1, "only the token that is not hidden is filled");
    assert.ok(fills[0]!.globalAlpha < 1, "the fill is translucent");
    const strokes = calls.filter((call) => call.op === "stroke").map((call) => call.strokeStyle);
    assert.equal(strokes.length, 4, "a black and a coloured outline for each token");
    assert.deepEqual([strokes[0], strokes[2]], ["#000000", "#000000"]);
    assert.notEqual(strokes[1], strokes[3], "friendly and hostile tokens differ in colour");
    assert.equal(fills[0]!.fillStyle, strokes[1]);
  });

  it("draws a token where it is stored, not where the document shows it while it animates", async () => {
    const calls = stubDrawing();
    const token = world.addToken(scene, { x: 500, y: 400 });
    token.prepared.x = 900;
    token.prepared.width = 3;
    await methods.get_scene_image({ sceneId: scene.id, maxSize: 500, showTokens: true });
    const [ellipse] = calls.filter((call) => call.op === "ellipse").map((call) => call.args.slice(0, 4));
    assert.deepEqual(ellipse, [125, 125, 25, 25]);
  });

  it("gives each disposition its own colour, none of them a wall, door, light or darkness colour", async () => {
    const calls = stubDrawing();
    for (const disposition of [-2, -1, 0, 1]) world.addToken(scene, { disposition });
    await methods.get_scene_image({ sceneId: scene.id, showTokens: true });
    const colours = calls
      .filter((call) => call.op === "stroke" && call.strokeStyle !== "#000000")
      .map((call) => call.strokeStyle);
    assert.equal(new Set(colours).size, 4);
    for (const used of ["#ff2d2d", "#2d7bff", "#ffd400", "#c04dff"]) assert.equal(colours.includes(used), false, used);
  });

  it("draws no tokens unless asked", async () => {
    const calls = stubDrawing();
    world.addToken(scene, { x: 500, y: 400 });
    await methods.get_scene_image({ sceneId: scene.id });
    assert.deepEqual(calls, []);
  });
});
