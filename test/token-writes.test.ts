import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  COLOUR_AND_BLANK_RECASTS,
  MANAGED,
  only,
  refused,
  restoreGlobals,
  setUp,
  viaTool,
  view,
  type World
} from "./token-world.ts";

afterEach(restoreGlobals);

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("place_tokens", () => {
  let world: World;
  let scene: any;
  let goblin: any;
  beforeEach(() => {
    ({ world, scene, goblin } = setUp());
  });

  it("puts a one-cell token's centre on the cell centre it is given, and returns where it is", async () => {
    const result = await viaTool("place_tokens", { sceneId: scene.id, tokens: [{ actor: goblin.id, at: [150, 250] }] });
    const token = only(scene);
    assert.deepEqual([token.x, token.y], [400, 400]);
    assert.deepEqual(result, {
      created: 1,
      requested: 1,
      tokens: [{ id: token.id, name: "Goblin", actorId: goblin.id, at: [150, 250] }],
      sceneId: scene.id,
      sceneName: "Cellar"
    });
  });

  it("centres a two-cell token on the grid vertex it is given", async () => {
    const result = await viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [{ actor: goblin.id, at: [200, 300], width: 2, height: 2 }]
    });
    const token = only(scene);
    assert.deepEqual([token.x, token.y, token.width, token.height], [400, 400, 2, 2]);
    assert.deepEqual(result.tokens[0].at, [200, 300]);
  });

  it("snaps a point off the grid to the cell, as a drop does, and keeps it exact with snap false", async () => {
    await viaTool("place_tokens", { sceneId: scene.id, tokens: [{ actor: goblin.id, at: [130, 260] }] });
    assert.deepEqual([only(scene).x, only(scene).y], [400, 400]);
    scene.tokens.clear();
    const exact = await viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [{ actor: goblin.id, at: [130, 260], snap: false }]
    });
    assert.deepEqual([only(scene).x, only(scene).y], [380, 410]);
    assert.deepEqual(exact.tokens[0].at, [130, 260]);
  });

  it("keeps the elevation it is given when it snaps, although snapping rounds it to the grid distance", async () => {
    await viaTool("place_tokens", { sceneId: scene.id, tokens: [{ actor: goblin.id, at: [130, 260], elevation: 7 }] });
    assert.equal(only(scene).elevation, 7);
  });

  it("places on a gridless scene exactly where it is told", async () => {
    const open = world.addScene({ name: "Field", width: 1000, height: 800, grid: { type: 0, size: 100, distance: 5 } });
    const result = await viaTool("place_tokens", { sceneId: open.id, tokens: [{ actor: goblin.id, at: [130, 260] }] });
    assert.deepEqual([only(open).x, only(open).y], [80, 210]);
    assert.deepEqual(result.tokens[0].at, [130, 260]);
  });

  it("reads at in the given frame and answers in it", async () => {
    const result = await viaTool("place_tokens", {
      sceneId: scene.id,
      frame: { width: 10, height: 8 },
      tokens: [{ actor: goblin.id, at: [1.5, 2.5] }]
    });
    assert.deepEqual([only(scene).x, only(scene).y], [400, 400]);
    assert.deepEqual(result.tokens[0].at, [1.5, 2.5]);
  });

  it("builds the token for the scene it goes to, not the viewed one, and numbers each copy after the ones before", async () => {
    const viewed = world.addScene({ name: "Viewed", width: 1000, height: 800 });
    world.actors.get(goblin.id)._source.prototypeToken.appendNumber = true;
    world.addToken(viewed, { name: "Goblin (1)", actorId: goblin.id });
    view(viewed);
    const result = await viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [
        { actor: goblin.id, at: [150, 250] },
        { actor: goblin.id, at: [250, 250] }
      ]
    });
    assert.deepEqual(
      result.tokens.map((token: any) => token.name),
      ["Goblin (1)", "Goblin (2)"]
    );
    assert.equal(viewed.tokens.size, 1);
  });

  it("puts a token on the scene's initial level at that level's base, or on the level and elevation it is given", async () => {
    scene.initialLevel.elevation.base = 10;
    scene.levels.get("upper").elevation.base = 20;
    await viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [
        { actor: goblin.id, at: [150, 250] },
        { actor: goblin.id, at: [250, 250], level: "upper" },
        { actor: goblin.id, at: [350, 250], level: "upper", elevation: 25 }
      ]
    });
    assert.deepEqual(
      [...scene.tokens.values()].map((token: any) => [token.level, token.elevation]),
      [
        ["lvl1", 10],
        ["upper", 20],
        ["upper", 25]
      ]
    );
  });

  it("flags every token as bridge-made, keeps the caller's flags, and follows the prototype's link unless told", async () => {
    world.actors.get(goblin.id)._source.prototypeToken.flags = { core: { kept: 1 } };
    await viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [
        { actor: goblin.id, at: [150, 250], flags: { dnd5e: { lockSize: true } } },
        { actor: `Actor.${goblin.id}`, at: [250, 250], actorLink: true, hidden: true, disposition: 0 }
      ]
    });
    const [first, second] = [...scene.tokens.values()];
    assert.deepEqual(first.flags, { core: { kept: 1 }, dnd5e: { lockSize: true }, ...MANAGED });
    assert.deepEqual([first.actorLink, second.actorLink, second.hidden, second.disposition], [false, true, true, 0]);
    const listed = (await viaTool("get_scene", { sceneId: scene.id })).tokens;
    assert.deepEqual(
      listed.map((token: any) => token.managed),
      [true, true]
    );
  });

  it("stacks each token above the ones on the scene, and keeps a sort it is given", async () => {
    await viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [
        { actor: goblin.id, at: [150, 250] },
        { actor: goblin.id, at: [250, 250] }
      ]
    });
    await viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [
        { actor: goblin.id, at: [350, 250] },
        { actor: goblin.id, at: [450, 250], sort: 9 }
      ]
    });
    assert.deepEqual(
      [...scene.tokens.values()].map((token: any) => token.sort),
      [0, 1, 2, 9]
    );
  });

  it("gives an actor with wildcard images another image on each call, as a drop does, and a refused call uses none", async () => {
    const images = ["tokens/wolf-a.webp", "tokens/wolf-b.webp"];
    const wolf = world.addActor({
      name: "Wolf",
      tokenImages: images,
      prototypeToken: { name: "Wolf", randomImg: true, texture: { src: "tokens/wolf-*.webp" } }
    });
    const place = (x: number) =>
      viaTool("place_tokens", { sceneId: scene.id, tokens: [{ actor: wolf.id, at: [x, 250] }] });
    await place(150);
    await assert.rejects(
      viaTool("place_tokens", {
        sceneId: scene.id,
        tokens: [
          { actor: wolf.id, at: [450, 250] },
          { actor: wolf.id, at: [550, 250], hiden: true }
        ]
      }),
      refused("invalid_params", /No such field: hiden/)
    );
    await place(250);
    await place(350);
    await viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [
        { actor: wolf.id, at: [150, 350] },
        { actor: wolf.id, at: [250, 350], texture: { src: "tokens/own.webp" } }
      ]
    });
    assert.deepEqual(
      [...scene.tokens.values()].map((token: any) => token.texture.src),
      [images[0], images[1], images[0], images[1], "tokens/own.webp"]
    );
  });

  it("stores a text as Foundry tidies it, does not call that unapplied, and the same values again write nothing", async () => {
    const tidy = { name: "  Grik ", light: { color: "#FF9900" } };
    const result = await viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [{ actor: goblin.id, at: [150, 250], ...tidy }]
    });
    const token = only(scene);
    assert.deepEqual([token.name, token.light.color], ["Grik", "#ff9900"]);
    assert.equal("unapplied" in result.tokens[0], false);
    const again = await viaTool("update_tokens", { sceneId: scene.id, tokens: [{ id: token.id, ...tidy }] });
    assert.deepEqual(again.tokens[0].changed, []);
    assert.deepEqual([world.log.tokenMoves.length, world.log.tokenUpdates.length], [0, 0]);
  });

  it("reports a given value that a hook stored otherwise as unapplied", async () => {
    world.control.filterTokenData = (data) => {
      data.hidden = false;
    };
    const result = await viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [{ actor: goblin.id, at: [150, 250], hidden: true, name: "Grik" }]
    });
    assert.equal(only(scene).hidden, false);
    assert.deepEqual(result.tokens[0].unapplied, ["hidden"]);
  });

  it("keeps the tokens Foundry made when it skips one, and says how many it made", async () => {
    world.control.vetoToken = (data) => data.hidden === true;
    const result = await viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [
        { actor: goblin.id, at: [150, 250] },
        { actor: goblin.id, at: [250, 250], hidden: true }
      ]
    });
    assert.deepEqual([result.created, result.requested, result.tokens.length], [1, 2, 1]);
    assert.equal(only(scene).id, result.tokens[0].id);
  });

  it("names the entry Foundry failed on, its message and the tokens made before it, and stops there", async () => {
    world.control.tokenCreateError = (data) => (data.name === "Second" ? "the socket closed" : undefined);
    const call = viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [
        { actor: goblin.id, at: [150, 250], name: "First" },
        { actor: goblin.id, at: [250, 250], name: "Second" },
        { actor: goblin.id, at: [350, 250], name: "Third" }
      ]
    });
    let message = "";
    await assert.rejects(call, (error: any) => {
      message = error.message;
      return refused("foundry_error")(error);
    });
    const first = only(scene);
    assert.equal(first.name, "First");
    assert.match(message, /^tokens\[1\]: Foundry failed while creating the token \(the socket closed\)\./);
    assert.ok(message.includes(`left on the scene: ${first.id}.`), message);
    assert.match(message, /entries after it were not tried/);
  });

  it("says that none was created when Foundry fails on the first entry", async () => {
    world.control.tokenCreateError = () => "the socket closed";
    await assert.rejects(
      viaTool("place_tokens", { sceneId: scene.id, tokens: [{ actor: goblin.id, at: [150, 250] }] }),
      refused("foundry_error", /^tokens\[0\]: .*\(the socket closed\)\. No token was created before it\./)
    );
    assert.equal(scene.tokens.size, 0);
  });

  const recasts: [string, Record<string, unknown>, RegExp][] = [
    ["a text for a boolean", { hidden: "yes" }, /hidden: "yes" would be stored as false/],
    ["an angle beyond the circle", { rotation: 370 }, /rotation: 370 would be stored as 10/],
    ["null for an object", { light: null }, /light: null would be stored as \{"dim":0/],
    ["null for a code", { disposition: null }, /disposition: null would be stored as -1/],
    ["a text for a size", { width: "2" }, /width: "2" would be stored as 2/],
    ["null for the elevation", { elevation: null }, /elevation: null would be stored as 0/],
    ["a finer step than the field keeps", { light: { dim: 10.123 } }, /light\.dim: 10\.123 would be stored as 10\.12/],
    ...COLOUR_AND_BLANK_RECASTS
  ];
  for (const [label, entry, message] of recasts) {
    it(`refuses ${label}, which Foundry would store as something else, and writes nothing`, async () => {
      await assert.rejects(
        viaTool("place_tokens", {
          sceneId: scene.id,
          tokens: [
            { actor: goblin.id, at: [150, 250] },
            { actor: goblin.id, at: [250, 250], ...entry }
          ]
        }),
        (error: any) =>
          refused("invalid_params", /^tokens\[1\]: Foundry would not store these values as given: /)(error) &&
          message.test(error.message) &&
          /Nothing was written\.$/.test(error.message)
      );
      assert.deepEqual([scene.tokens.size, world.log.tokenCreates], [0, 0]);
    });
  }

  const refusals: [string, Record<string, unknown>, string, RegExp][] = [
    ["an unknown field", { hiden: true }, "invalid_params", /tokens\[1\]: No such field: hiden\./],
    ["an unknown nested field", { light: { dimm: 3 } }, "invalid_params", /No such field: light\.dimm\..*get_schema/],
    ["x and y", { x: 10, y: 10 }, "invalid_params", /x \(give at, the token's centre\), y/],
    ["actorId", { actorId: "other" }, "invalid_params", /actorId \(place_tokens takes actor/],
    ["a key starting with _", { _id: "abc" }, "invalid_params", /_id \(Foundry keeps it itself\)/],
    [
      "the bridge's own flags",
      { flags: { "foundry-mcp": { managed: false } } },
      "invalid_params",
      /flags\.foundry-mcp/
    ],
    [
      "the bridge's flag through a key with a dot",
      { flags: { "foundry-mcp.managed": false } },
      "invalid_params",
      /Not a plain key: "foundry-mcp\.managed" in flags/
    ],
    [
      "the bridge's flags through a deletion key",
      { flags: { "-=foundry-mcp": null } },
      "invalid_params",
      /Not a plain key: "-=foundry-mcp" in flags/
    ],
    [
      "data the token model refuses",
      { disposition: 5 },
      "invalid_params",
      /token model refuses.*5 is not a valid choice/
    ],
    ["an unknown level", { level: "ghost" }, "invalid_params", /no level ghost\. Its levels: lvl1, upper/],
    [
      "a point outside the scene",
      { at: [1001, 10] },
      "invalid_params",
      /outside the scene rectangle, which is 1000 x 800/
    ],
    ["a point on the far edge of the scene", { at: [1000, 10] }, "invalid_params", /outside the scene rectangle/],
    ["a point on its far lower edge", { at: [10, 800] }, "invalid_params", /outside the scene rectangle/],
    ["an actor that does not exist", { actor: "nobody" }, "not_found", /tokens\[1\]: No world actor with id nobody/]
  ];
  for (const [label, entry, code, message] of refusals) {
    it(`refuses ${label} and writes nothing, not even the valid entries`, async () => {
      await assert.rejects(
        viaTool("place_tokens", {
          sceneId: scene.id,
          tokens: [
            { actor: goblin.id, at: [150, 250] },
            { actor: goblin.id, at: [250, 250], ...entry }
          ]
        }),
        (error: any) => refused(code, message)(error) && /Nothing was written\.$/.test(error.message)
      );
      assert.deepEqual([scene.tokens.size, world.log.tokenCreates], [0, 0]);
    });
  }

  it("takes the near edges of the scene rectangle as inside", async () => {
    const result = await viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [{ actor: goblin.id, at: [0, 0], snap: false }]
    });
    assert.deepEqual([only(scene).x, only(scene).y], [250, 150]);
    assert.deepEqual(result.tokens[0].at, [0, 0]);
  });

  it("refuses a point that snaps the token's centre onto the far edge of the canvas, where Foundry moves no token", async () => {
    const bare = world.addScene({ name: "Bare", width: 1000, height: 800, padding: 0 });
    const large = { actor: goblin.id, at: [990, 450], width: 2, height: 2 };
    await assert.rejects(
      viaTool("place_tokens", { sceneId: bare.id, tokens: [large] }),
      refused(
        "invalid_params",
        /centre at canvas pixel \[1000, 500\], on or beyond the edge of the canvas.*snap: false/
      )
    );
    assert.equal(bare.tokens.size, 0);
    await viaTool("place_tokens", { sceneId: scene.id, tokens: [large] });
    assert.deepEqual([only(scene).x, only(scene).y], [1200, 600]);
  });

  it("refuses a compendium actor and a token's actor, saying what to pass instead", async () => {
    const packed = world.addPackActor("dnd5e.monsters", { name: "Ogre" });
    await assert.rejects(
      viaTool("place_tokens", { sceneId: scene.id, tokens: [{ actor: packed.uuid, at: [150, 250] }] }),
      refused("invalid_params", /compendium dnd5e\.monsters\. Import it into the world/)
    );
    const placed = world.addToken(scene, { actorId: goblin.id });
    await assert.rejects(
      viaTool("place_tokens", {
        sceneId: scene.id,
        tokens: [{ actor: `${scene.uuid}.Token.${placed.id}.Actor.${goblin.id}`, at: [150, 250] }]
      }),
      refused("invalid_params", /the actor of a token\. Pass the id of its world actor/)
    );
    assert.equal(scene.tokens.size, 1);
  });
});

describe("place_tokens behind a queued write", () => {
  let world: World;
  let scene: any;
  let goblin: any;
  beforeEach(() => {
    ({ world, goblin } = setUp({ latency: 20 }));
    scene = world.addScene({ name: "Bare", width: 1000, height: 800, padding: 0 });
  });

  /** Starts the slow scene change, then the placement, and returns once the placement was prepared beside it. */
  async function queuedBehindPadding(entry: Record<string, unknown>) {
    const padding = viaTool("ensure_scene", { sceneId: scene.id, padding: 0.25 });
    const placing = viaTool("place_tokens", {
      sceneId: scene.id,
      tokens: [{ actor: goblin.id, at: [150, 250], ...entry }]
    });
    await pause(1);
    return { padding, placing };
  }

  it("measures at in the scene rectangle the scene has when the placement runs", async () => {
    const { padding, placing } = await queuedBehindPadding({});
    const [, placed] = await Promise.all([padding, placing]);
    assert.deepEqual([scene.dimensions.sceneX, scene.dimensions.sceneY], [300, 200]);
    assert.deepEqual([only(scene).x, only(scene).y], [400, 400]);
    assert.deepEqual(placed.tokens[0].at, [150, 250]);
    const read = await viaTool("get_scene", { sceneId: scene.id });
    assert.deepEqual(read.tokens[0].at, [150, 250]);
  });

  it("refuses when the actor was deleted while the placement waited, and writes nothing", async () => {
    const { padding, placing } = await queuedBehindPadding({});
    world.actors.delete(goblin.id);
    await padding;
    await assert.rejects(
      placing,
      refused("not_found", /tokens\[0\]: No world actor with id .* Nothing was written\.$/)
    );
    assert.equal(scene.tokens.size, 0);
  });

  it("refuses when the level was removed while the placement waited, and writes nothing", async () => {
    const { padding, placing } = await queuedBehindPadding({ level: "upper" });
    scene.levels.delete("upper");
    await padding;
    await assert.rejects(placing, refused("invalid_params", /The scene has no level upper.* Nothing was written\.$/));
    assert.equal(scene.tokens.size, 0);
  });
});

describe("delete_tokens", () => {
  it("deletes the given tokens and ignores ids that are not on the scene", async () => {
    const { world, scene } = setUp();
    const kept = world.addToken(scene, { name: "kept" });
    const gone = world.addToken(scene, { name: "gone" });
    const result = await viaTool("delete_tokens", { sceneId: scene.id, ids: [gone.id, "ghost", gone.id] });
    assert.deepEqual(result, { deleted: 1, sceneId: scene.id, sceneName: "Cellar" });
    assert.deepEqual([...scene.tokens.keys()], [kept.id]);
    assert.deepEqual(await viaTool("delete_tokens", { sceneId: scene.id, ids: ["ghost"] }), {
      deleted: 0,
      sceneId: scene.id,
      sceneName: "Cellar"
    });
    assert.equal(world.log.tokenDeletes, 1);
  });
});
