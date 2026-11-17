import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  COLOUR_AND_BLANK_RECASTS,
  MANAGED,
  refused,
  restoreGlobals,
  setUp,
  viaTool,
  view,
  type World
} from "./token-world.ts";

afterEach(restoreGlobals);

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("update_tokens", () => {
  let world: World;
  let scene: any;
  let goblin: any;
  let token: any;
  beforeEach(() => {
    ({ world, scene, goblin } = setUp());
    token = world.addToken(scene, { name: "Goblin", actorId: goblin.id, x: 400, y: 400, flags: MANAGED });
  });

  const update = (entry: Record<string, unknown>) =>
    viaTool("update_tokens", { sceneId: scene.id, tokens: [{ id: token.id, ...entry }] });
  const writes = () => [world.log.tokenMoves.length, world.log.tokenUpdates.length];

  it("writes nothing when every given value equals the stored one", async () => {
    const result = await update({ at: [150, 250], hidden: false, name: "Goblin" });
    assert.deepEqual(result, {
      tokens: [{ id: token.id, at: [150, 250], changed: [] }],
      sceneId: scene.id,
      sceneName: "Cellar"
    });
    assert.deepEqual(writes(), [0, 0]);
  });

  it("takes an object without keys as asking for nothing, and removes no key", async () => {
    const lit = world.addToken(scene, { light: { dim: 30, bright: 10 }, flags: { core: { kept: 1 } } });
    const before = structuredClone(lit._source);
    const result = await viaTool("update_tokens", {
      sceneId: scene.id,
      tokens: [{ id: lit.id, light: {}, flags: {} }]
    });
    assert.deepEqual(result.tokens[0].changed, []);
    assert.deepEqual(lit._source, before);
    assert.deepEqual(writes(), [0, 0]);
  });

  it("moves a token as a displacement that ignores walls and cost, without animation, to the cell it is given", async () => {
    const result = await update({ at: [350, 450] });
    assert.deepEqual([token.x, token.y], [600, 600]);
    assert.deepEqual(result.tokens, [{ id: token.id, at: [350, 450], changed: ["at"] }]);
    assert.deepEqual(world.log.tokenMoves, [
      {
        instructions: {
          [token.id]: {
            destination: { x: 600, y: 600, action: "displace" },
            constrainOptions: { ignoreWalls: true, ignoreCost: true }
          }
        },
        options: { animate: false }
      }
    ]);
    assert.deepEqual(writes(), [1, 0]);
  });

  it("puts a token of the viewed scene exactly where it is told, also with its centre on a wall", async () => {
    view(scene);
    world.addWall(scene, { c: [800, 200, 800, 1000] });
    const large = world.addToken(scene, { actorId: goblin.id, x: 500, y: 400, width: 2, height: 2 });
    const move = { sceneId: scene.id, tokens: [{ id: large.id, at: [500, 300] }] };
    const result = await viaTool("update_tokens", move);
    assert.deepEqual([large._source.x, large._source.y], [700, 400]);
    assert.deepEqual(result.tokens, [{ id: large.id, at: [500, 300], changed: ["at"] }]);
    assert.deepEqual((await viaTool("update_tokens", move)).tokens, [{ id: large.id, at: [500, 300], changed: [] }]);
  });

  it("updates other fields with a plain update, sending only those that differ", async () => {
    const result = await update({ hidden: true, name: "Goblin", disposition: 0 });
    assert.deepEqual([token.hidden, token.disposition], [true, 0]);
    assert.deepEqual(result.tokens[0].changed, ["hidden", "disposition"]);
    assert.deepEqual(world.log.tokenUpdates, [[{ _id: token.id, hidden: true, disposition: 0 }]]);
    assert.deepEqual(writes(), [0, 1]);
  });

  it("sends the other changed fields along with a move, in one write", async () => {
    const result = await update({ at: [350, 450], hidden: true, elevation: 5, light: { dim: 20 } });
    assert.deepEqual([token.x, token.y, token.hidden, token.elevation, token.light.dim], [600, 600, true, 5, 20]);
    assert.deepEqual(result.tokens[0].changed, ["hidden", "elevation", "light.dim", "at"]);
    assert.deepEqual(world.log.tokenMoves[0]!.instructions[token.id].destination, {
      hidden: true,
      elevation: 5,
      light: { dim: 20 },
      x: 600,
      y: 600,
      action: "displace"
    });
    assert.deepEqual(writes(), [1, 0]);
  });

  it("measures at with the size the token has after the change", async () => {
    const result = await update({ at: [200, 300], width: 2, height: 2 });
    assert.deepEqual([token.x, token.y, token.width, token.height], [400, 400, 2, 2]);
    assert.deepEqual(result.tokens[0], { id: token.id, at: [200, 300], changed: ["width", "height"] });
    assert.deepEqual(writes(), [1, 0]);
  });

  it("moves to another level of the scene as a movement, and refuses one the scene does not have", async () => {
    await update({ level: "upper" });
    assert.equal(token.level, "upper");
    assert.deepEqual(world.log.tokenMoves[0]!.instructions[token.id].destination, {
      level: "upper",
      action: "displace"
    });
    await assert.rejects(update({ level: "ghost" }), refused("invalid_params", /no level ghost/));
    assert.equal(token.level, "upper");
  });

  it("stores a text as Foundry tidies it and a number as the text of it, and a repeat writes nothing", async () => {
    const tidy = { name: "  Grik ", light: { color: "#FF8800" } };
    const result = await update(tidy);
    assert.deepEqual([token.name, token.light.color], ["Grik", "#ff8800"]);
    assert.deepEqual(result.tokens[0], { id: token.id, at: [150, 250], changed: ["name", "light.color"] });
    assert.deepEqual((await update(tidy)).tokens[0].changed, []);
    assert.deepEqual((await update({ name: 7 })).tokens[0].changed, ["name"]);
    assert.equal(token.name, "7");
    assert.deepEqual((await update({ name: 7 })).tokens[0].changed, []);
    assert.deepEqual(writes(), [0, 2]);
  });

  it("writes a new entry of a keyed map with the defaults Foundry fills in, and a repeat writes nothing", async () => {
    const modes = { detectionModes: { seeAll: { range: 30 } } };
    const result = await update(modes);
    assert.deepEqual(token.detectionModes, { seeAll: { range: 30, enabled: true } });
    assert.deepEqual(result.tokens[0].changed, ["detectionModes.seeAll.range", "detectionModes.seeAll.enabled"]);
    assert.deepEqual(await update(modes), {
      tokens: [{ id: token.id, at: [150, 250], changed: [] }],
      sceneId: scene.id,
      sceneName: "Cellar"
    });
    assert.deepEqual(writes(), [0, 1]);
  });

  const recasts: [string, Record<string, unknown>, RegExp][] = [
    ["a text for a boolean", { hidden: "yes" }, /hidden: "yes" would be stored as false/],
    ["a number for a boolean", { hidden: 1 }, /hidden: 1 would be stored as true/],
    ["null for an object", { light: null }, /light: null would be stored as \{"dim":0/],
    ["null for a code", { disposition: null }, /disposition: null would be stored as -1/],
    ["an angle beyond the circle", { rotation: 370 }, /rotation: 370 would be stored as 10/],
    ["a text for a size", { width: "2" }, /width: "2" would be stored as 2/],
    ["null for the elevation", { elevation: null }, /elevation: null would be stored as 0/],
    ["a full turn, which Foundry stores as no rotation", { rotation: 360 }, /rotation: 360 would be stored as 0/],
    ...COLOUR_AND_BLANK_RECASTS
  ];
  for (const [label, entry, message] of recasts) {
    it(`refuses ${label}, which Foundry would store as something else, and writes nothing`, async () => {
      const lit = world.addToken(scene, { hidden: true, disposition: 1, rotation: 90, light: { dim: 30, bright: 10 } });
      const before = structuredClone(lit._source);
      await assert.rejects(
        viaTool("update_tokens", {
          sceneId: scene.id,
          tokens: [
            { id: token.id, name: "Grik" },
            { id: lit.id, ...entry }
          ]
        }),
        (error: any) =>
          refused("invalid_params", /^tokens\[1\]: Foundry would not store these values as given: /)(error) &&
          message.test(error.message) &&
          /Nothing was written\.$/.test(error.message)
      );
      assert.deepEqual(lit._source, before);
      assert.equal(token.name, "Goblin");
      assert.deepEqual(writes(), [0, 0]);
    });
  }

  for (const [label, flags] of [
    ["a key with a dot", { "foundry-mcp.managed": false }],
    ["a deletion key", { "-=foundry-mcp": null }],
    ["a replacement key", { "==foundry-mcp": { managed: false } }],
    ["an operator", { other: { __$OPERATOR$__: "ForcedDeletion" } }]
  ] as const) {
    it(`refuses ${label} in flags, and the token stays flagged as bridge-made`, async () => {
      await assert.rejects(
        update({ hidden: true, flags }),
        refused("invalid_params", /^tokens\[0\]: Not a plain key: "/)
      );
      assert.deepEqual(token.flags, MANAGED);
      assert.equal(token.hidden, false);
      assert.deepEqual(writes(), [0, 0]);
    });
  }

  it("reports as changed what changed in storage, also where a hook stored another value than asked", async () => {
    world.control.filterTokenChanges = (changes) => {
      if ("name" in changes) changes.name = "Renamed by a hook";
      delete changes.hidden;
    };
    const result = await update({ name: "Grik", hidden: true, disposition: 0 });
    assert.deepEqual([token.name, token.hidden, token.disposition], ["Renamed by a hook", false, 0]);
    assert.deepEqual(result.tokens[0], {
      id: token.id,
      at: [150, 250],
      changed: ["name", "disposition"],
      unapplied: ["name", "hidden"]
    });
  });

  it("reports a move that a hook dropped as an unapplied at, with the centre where the token stayed", async () => {
    world.control.filterTokenChanges = (changes) => {
      delete changes.x;
      delete changes.y;
    };
    const result = await update({ at: [350, 450], hidden: true });
    assert.deepEqual(result.tokens[0], { id: token.id, at: [150, 250], changed: ["hidden"], unapplied: ["at"] });
  });

  it("answers with the stored centre, not a position the document shows while it animates", async () => {
    token.prepared.x = 455;
    const result = await update({ hidden: true });
    assert.deepEqual(result.tokens[0].at, [150, 250]);
    const read = await viaTool("get_scene", { sceneId: scene.id, tokens: [token.id] });
    assert.deepEqual(
      [read.tokens[0].at, read.tokenData[0].at],
      [
        [150, 250],
        [150, 250]
      ]
    );
  });

  it("names the tokens and what the stored data shows when Foundry throws on the move, and skips the rest", async () => {
    const other = world.addToken(scene, { name: "Other" });
    world.control.tokenMoveError = "level must exist";
    let message = "";
    await assert.rejects(
      viaTool("update_tokens", {
        sceneId: scene.id,
        tokens: [
          { id: token.id, at: [350, 450] },
          { id: other.id, hidden: true }
        ]
      }),
      (error: any) => {
        message = error.message;
        return refused("foundry_error")(error);
      }
    );
    assert.equal(
      message,
      `Foundry failed while moving the tokens ${token.id} (level must exist). None of the given tokens was changed. Running the call again writes what still differs.`
    );
    assert.deepEqual([token.x, other.hidden], [400, false]);
    assert.deepEqual(writes(), [1, 0]);
  });

  it("says that the moves were applied when Foundry throws on the plain update after them", async () => {
    const other = world.addToken(scene, { name: "Other" });
    world.control.tokenUpdateError = "the socket closed";
    await assert.rejects(
      viaTool("update_tokens", {
        sceneId: scene.id,
        tokens: [
          { id: token.id, at: [350, 450], hidden: true },
          { id: other.id, hidden: true }
        ]
      }),
      refused(
        "foundry_error",
        new RegExp(
          `^Foundry failed while updating the tokens ${other.id} \\(the socket closed\\)\\. Changed in the stored data: ${token.id} \\(hidden, at\\)\\. Not changed: ${other.id}\\.`
        )
      )
    );
    assert.deepEqual([token.x, token.hidden, other.hidden], [600, true, false]);
  });

  it("writes nothing when an id is not on the scene, and names the missing ids", async () => {
    await assert.rejects(
      viaTool("update_tokens", {
        sceneId: scene.id,
        tokens: [
          { id: token.id, hidden: true },
          { id: "ghost1", hidden: true },
          { id: "ghost2", at: [10, 10] }
        ]
      }),
      refused("not_found", /no token with the id ghost1, ghost2\. Nothing was written/)
    );
    assert.equal(token.hidden, false);
    assert.deepEqual(writes(), [0, 0]);
  });

  it("refuses the same id twice", async () => {
    await assert.rejects(
      viaTool("update_tokens", {
        sceneId: scene.id,
        tokens: [
          { id: token.id, hidden: true },
          { id: token.id, name: "B" }
        ]
      }),
      refused("invalid_params", /given more than once/)
    );
    assert.deepEqual(writes(), [0, 0]);
  });

  for (const [label, entry, message] of [
    ["an unknown field", { hiden: true }, /No such field: hiden/],
    ["x", { x: 0 }, /x \(give at/],
    ["delta", { delta: { system: {} } }, /delta \(the token's own actor data/],
    ["another actorId than the stored one", { actorId: "someoneElse" }, /actorId cannot be changed/],
    ["null for the flags", { flags: null }, /flags \(must be an object\)/],
    ["data the token model refuses", { width: -1 }, /token model refuses.*width: must be a positive number/],
    ["a point outside the scene", { at: [-1, 10] }, /outside the scene rectangle/],
    ["a point on the far edge of the scene", { at: [1000, 10] }, /outside the scene rectangle/]
  ] as const) {
    it(`refuses ${label} and writes nothing, not even the valid entries`, async () => {
      const other = world.addToken(scene, {});
      await assert.rejects(
        viaTool("update_tokens", {
          sceneId: scene.id,
          tokens: [
            { id: token.id, hidden: true },
            { id: other.id, ...entry }
          ]
        }),
        (error: any) => refused("invalid_params", message)(error) && /Nothing was written\.$/.test(error.message)
      );
      assert.equal(token.hidden, false);
      assert.deepEqual(writes(), [0, 0]);
    });
  }

  it("refuses a move that would put a token's centre on the far edge of the canvas", async () => {
    const bare = world.addScene({ name: "Bare", width: 1000, height: 800, padding: 0 });
    const large = world.addToken(bare, { x: 400, y: 400, width: 2, height: 2 });
    view(bare);
    await assert.rejects(
      viaTool("update_tokens", { sceneId: bare.id, tokens: [{ id: large.id, at: [990, 450] }] }),
      refused("invalid_params", /on or beyond the edge of the canvas/)
    );
    assert.deepEqual([large.x, large.y], [400, 400]);
    assert.deepEqual(writes(), [0, 0]);
  });
});

describe("update_tokens with data read from get_scene", () => {
  let world: World;
  let scene: any;
  let token: any;
  beforeEach(() => {
    let goblin: any;
    ({ world, scene, goblin } = setUp());
    // Off the grid and with a centre on half a pixel: a round trip through whole pixels or the grid would move it.
    token = world.addToken(scene, {
      name: "Goblin",
      actorId: goblin.id,
      x: 431,
      y: 410,
      width: 0.75,
      height: 0.75,
      hidden: true,
      light: { dim: 20, bright: 10 },
      detectionModes: { basicSight: { enabled: true, range: 30 } },
      flags: { ...MANAGED, dnd5e: { lockSize: true } }
    });
  });
  const writes = () => [world.log.tokenMoves.length, world.log.tokenUpdates.length];
  const read = async () => (await viaTool("get_scene", { sceneId: scene.id, tokens: [token.id] })).tokenData[0];

  it("takes a tokenData entry back unchanged and writes nothing, whatever the grid says", async () => {
    const entry = await read();
    assert.deepEqual(entry.at, [168.5, 247.5]);
    const before = structuredClone(token._source);
    const result = await viaTool("update_tokens", { sceneId: scene.id, tokens: [entry] });
    assert.deepEqual(result.tokens, [{ id: token.id, at: [168.5, 247.5], changed: [] }]);
    assert.deepEqual(token._source, before);
    assert.deepEqual(writes(), [0, 0]);
  });

  it("writes only the value that was changed in an entry read from tokenData", async () => {
    const entry = await read();
    const result = await viaTool("update_tokens", {
      sceneId: scene.id,
      tokens: [{ ...entry, hidden: false }]
    });
    assert.deepEqual(result.tokens[0].changed, ["hidden"]);
    assert.deepEqual([token.x, token.y, token.hidden], [431, 410, false]);
    assert.deepEqual(world.log.tokenUpdates, [[{ _id: token.id, hidden: false }]]);
  });

  it("refuses the bridge's own flag when it is another value than the stored one", async () => {
    const entry = await read();
    for (const own of [{ managed: false }, { managed: true, extra: 1 }, {}]) {
      await assert.rejects(
        viaTool("update_tokens", {
          sceneId: scene.id,
          tokens: [{ ...entry, flags: { ...entry.flags, "foundry-mcp": own } }]
        }),
        refused("invalid_params", /flags\.foundry-mcp \(the bridge sets it\)/)
      );
    }
    assert.deepEqual(token.flags, { ...MANAGED, dnd5e: { lockSize: true } });
    assert.deepEqual(writes(), [0, 0]);
  });

  it("still snaps a token whose at is another point than its centre", async () => {
    const offGrid = world.addToken(scene, { x: 430, y: 410 });
    const result = await viaTool("update_tokens", { sceneId: scene.id, tokens: [{ id: offGrid.id, at: [181, 260] }] });
    assert.deepEqual(result.tokens[0], { id: offGrid.id, at: [150, 250], changed: ["at"] });
    assert.deepEqual([offGrid.x, offGrid.y], [400, 400]);
  });
});

describe("update_tokens behind a queued write", () => {
  let world: World;
  let scene: any;
  let token: any;
  beforeEach(() => {
    ({ world } = setUp({ latency: 20 }));
    scene = world.addScene({ name: "Bare", width: 1000, height: 800, padding: 0 });
    token = world.addToken(scene, { name: "Mover", x: 0, y: 0 });
  });

  /** Starts the slow scene change, then the update, and returns once the update was prepared beside it. */
  async function queuedBehindPadding(entry: Record<string, unknown>) {
    const padding = viaTool("ensure_scene", { sceneId: scene.id, padding: 0.25 });
    const updating = viaTool("update_tokens", { sceneId: scene.id, tokens: [{ id: token.id, ...entry }] });
    await pause(1);
    return { padding, updating };
  }

  it("measures at in the scene rectangle the scene has when the update runs", async () => {
    const { padding, updating } = await queuedBehindPadding({ at: [350, 250] });
    const [, moved] = await Promise.all([padding, updating]);
    assert.deepEqual([token.x, token.y], [600, 400]);
    assert.deepEqual(moved.tokens[0], { id: token.id, at: [350, 250], changed: ["at"] });
    assert.deepEqual((await viaTool("get_scene", { sceneId: scene.id })).tokens[0].at, [350, 250]);
  });

  it("refuses when the level was removed while the update waited, and writes nothing", async () => {
    const { padding, updating } = await queuedBehindPadding({ level: "upper", hidden: true });
    scene.levels.delete("upper");
    await padding;
    await assert.rejects(updating, refused("invalid_params", /The scene has no level upper.* Nothing was written\.$/));
    assert.deepEqual([token.level, token.hidden], ["lvl1", false]);
  });

  it("refuses when the token was deleted while the update waited, and writes nothing", async () => {
    const { padding, updating } = await queuedBehindPadding({ hidden: true });
    scene.tokens.delete(token.id);
    await padding;
    await assert.rejects(updating, refused("not_found", /no token with the id .* Nothing was written/));
    assert.deepEqual([world.log.tokenMoves.length, world.log.tokenUpdates.length], [0, 0]);
  });
});
