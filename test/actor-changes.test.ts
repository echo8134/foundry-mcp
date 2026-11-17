import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ForcedDeletion } from "./fake-model.ts";
import { fakeWorld } from "./fake-world.ts";
import { MANAGED, refused, restoreGlobals, viaTool } from "./token-world.ts";

afterEach(restoreGlobals);

type World = ReturnType<typeof fakeWorld>;

const GONE = new ForcedDeletion();
const ensure = (args: Record<string, unknown>) => viaTool("ensure_actor", args);

const goblinData = () => ({
  name: "Goblin",
  type: "npc",
  img: "art/goblin.webp",
  flags: { ...MANAGED, world: { note: "sneaky", seen: { by: "Ada", on: 3 } } },
  ownership: { default: 0, ada: 3 },
  prototypeToken: { name: "Goblin", actorLink: false },
  system: {
    attributes: {
      hp: { value: 7, max: 7, temp: null },
      ac: { flat: 15, calcs: ["natural"] },
      senses: { ranges: { darkvision: 60 } },
      movement: { speeds: { walk: "30" } }
    },
    details: { cr: 0.25, biography: { value: "<p>Small<br>and mean</p>", public: "" } },
    skills: { ste: { value: 2 } },
    tools: { thief: { value: 1, ability: "dex" }, smith: { value: 1, ability: "int" } }
  }
});

describe("ensure_actor changing an actor", () => {
  let world: World;
  let goblin: any;
  beforeEach(() => {
    world = fakeWorld({ unloadable: ["art/missing.webp", "art/goblin.webp"] });
    goblin = world.addActor(goblinData());
    world.install();
  });
  const change = (args: Record<string, unknown>) => ensure({ actor: goblin.id, ...args });
  const sent = () => world.log.actorUpdates.map((update) => update.changes);

  it("sends only the leaves that differ, as one nested object, and names them", async () => {
    const result = await change({
      name: "Goblin",
      system: {
        attributes: { hp: { value: 3, max: 7 }, ac: { flat: 15 }, movement: { speeds: { walk: "30", fly: "40" } } },
        details: { cr: 0.5 },
        skills: { ste: { value: 2 }, prc: { value: 1 } }
      }
    });
    assert.deepEqual(sent(), [
      {
        system: {
          attributes: { hp: { value: 3 }, movement: { speeds: { fly: "40" } } },
          details: { cr: 0.5 },
          skills: { prc: { value: 1 } }
        }
      }
    ]);
    assert.deepEqual(result.changed, [
      "system.attributes.hp.value",
      "system.attributes.movement.speeds.fly",
      "system.details.cr",
      "system.skills.prc.value"
    ]);
    assert.deepEqual(
      [result.created, result.unapplied, result.derived.hp],
      [false, [], { value: 3, max: 7, temp: null }]
    );
    assert.deepEqual(goblin._source.system.attributes.ac, { flat: 15, calcs: ["natural"] });
  });

  it("writes nothing when every given value is the stored one", async () => {
    const { name, img, system, prototypeToken, ownership } = goblinData();
    const result = await change({ name, img, system, prototypeToken, ownership, flags: { world: { note: "sneaky" } } });
    assert.deepEqual([result.changed, result.unapplied, sent()], [[], [], []]);
  });

  it("replaces a list whole", async () => {
    const result = await change({ system: { attributes: { ac: { calcs: ["armored", "natural"] } } } });
    assert.deepEqual(sent(), [{ system: { attributes: { ac: { calcs: ["armored", "natural"] } } } }]);
    assert.deepEqual(result.changed, ["system.attributes.ac.calcs"]);
    assert.deepEqual(goblin._source.system.attributes.ac.calcs, ["armored", "natural"]);
    assert.deepEqual((await change({ system: { attributes: { ac: { calcs: ["armored", "natural"] } } } })).changed, []);
  });

  it("merges an object into what is stored, and keeps what it does not name", async () => {
    await change({ flags: { world: { seen: { on: 4 } }, core: { sheetLock: true } }, ownership: { bob: 2 } });
    assert.deepEqual(goblin._source.flags, {
      ...MANAGED,
      world: { note: "sneaky", seen: { by: "Ada", on: 4 } },
      core: { sheetLock: true }
    });
    assert.deepEqual(goblin._source.ownership, { default: 0, ada: 3, bob: 2 });
  });

  it("keeps null as a value where the map's entries take it", async () => {
    const result = await change({ system: { attributes: { senses: { ranges: { darkvision: null } } } } });
    assert.deepEqual(result.changed, ["system.attributes.senses.ranges.darkvision"]);
    assert.deepEqual(goblin._source.system.attributes.senses.ranges, { darkvision: null });
  });

  it("refuses null for an entry it would only reset, and names what Foundry would store", async () => {
    await assert.rejects(
      change({ system: { tools: { thief: null } } }),
      refused("invalid_params", /system\.tools\.thief: null would be stored as \{"value":1,"ability":"int"\}/)
    );
    assert.deepEqual([sent(), goblin._source.system.tools.thief], [[], { value: 1, ability: "dex" }]);
  });

  it("removes the entries named in remove with Foundry's deletion operator, in the same update as the changes", async () => {
    const result = await change({
      system: { details: { cr: 1 } },
      remove: ["system.tools.thief", "flags.world.seen.by", "flags.core"]
    });
    assert.deepEqual(sent(), [
      { system: { details: { cr: 1 }, tools: { thief: GONE } }, flags: { world: { seen: { by: GONE } } } }
    ]);
    assert.deepEqual(result.changed, ["system.details.cr", "system.tools.thief", "flags.world.seen.by"]);
    assert.deepEqual(result.unapplied, []);
    assert.deepEqual(goblin._source.system.tools, { smith: { value: 1, ability: "int" } });
    assert.deepEqual(goblin._source.flags.world, { note: "sneaky", seen: { on: 3 } });
  });

  it("removes an entry of a map whose entries are numbers, where an empty object in its place would be refused", async () => {
    const result = await change({ remove: ["system.attributes.senses.ranges.darkvision"] });
    assert.deepEqual(result.changed, ["system.attributes.senses.ranges.darkvision"]);
    assert.deepEqual(goblin._source.system.attributes.senses.ranges, {});
  });

  it("ignores an entry that is not there, so the same call again writes nothing", async () => {
    const args = { remove: ["system.tools.thief", "system.tools.herbalism"] };
    assert.deepEqual((await change(args)).changed, ["system.tools.thief"]);
    assert.deepEqual([(await change(args)).changed, sent().length], [[], 1]);
  });

  it("removes a whole flags scope, and one entry where two are named of which one lies in the other", async () => {
    const result = await change({ remove: ["flags.world.seen.on", "flags.world", "flags.world"] });
    assert.deepEqual(sent(), [{ flags: { world: GONE } }]);
    assert.deepEqual(result.changed, ["flags.world.seen.on", "flags.world"]);
    assert.deepEqual(goblin._source.flags, MANAGED);
  });

  const badRemovals: [string, Record<string, unknown>, RegExp][] = [
    ["a field", { remove: ["system.details.cr"] }, /remove: Not an entry that can be removed: system\.details\.cr\./],
    [
      "a part of an entry",
      { remove: ["system.tools.thief.value"] },
      /Not an entry that can be removed: system\.tools\.thief\.value/
    ],
    ["an element of a list", { remove: ["system.attributes.ac.calcs.0"] }, /Not an entry that can be removed/],
    ["a whole map", { remove: ["system.tools"] }, /Not an entry that can be removed: system\.tools\./],
    [
      "a path the schema does not have",
      { remove: ["system.tols.thief"] },
      /remove: No such field: system\.tols\.thief\./
    ],
    [
      "a field that is not stored",
      { remove: ["system.attributes.ac.value"] },
      /No such field: system\.attributes\.ac\.value/
    ],
    [
      "the bridge's own flag",
      { remove: ["flags.foundry-mcp"] },
      /flags\.foundry-mcp is the bridge's own flag, which stays/
    ],
    ["a key of the bridge's own flag", { remove: ["flags.foundry-mcp.managed"] }, /is the bridge's own flag/],
    [
      "the bridge's own flag on the prototype token",
      { remove: ["prototypeToken.flags.foundry-mcp.managed"] },
      /prototypeToken\.flags\.foundry-mcp\.managed is the bridge's own flag/
    ],
    [
      "a key Foundry reads as an instruction",
      { remove: ["flags.world.-=note"] },
      /Not a path of plain keys: flags\.world\.-=note/
    ],
    [
      "an entry that is given a value in the same call",
      { remove: ["system.tools.thief"], system: { tools: { thief: { value: 2 } } } },
      /system\.tools\.thief is named in remove and given a value in the same call/
    ],
    [
      "an entry below a value given in the same call",
      { remove: ["flags.world.seen.by"], flags: { world: { seen: { by: "Bob" } } } },
      /flags\.world\.seen\.by is named in remove and given a value/
    ]
  ];
  for (const [label, args, message] of badRemovals) {
    it(`refuses to remove ${label}, and writes nothing of the call`, async () => {
      const before = structuredClone(goblin._source);
      await assert.rejects(change({ system: { details: { cr: 9 } }, ...args }), refused("invalid_params", message));
      assert.deepEqual([sent(), goblin._source], [[], before]);
    });
  }

  it("refuses a removal Foundry's model would refuse, with the model's reason, before anything is written", async () => {
    const before = structuredClone(goblin._source);
    await assert.rejects(
      change({ system: { details: { cr: 9 } }, remove: ["ownership.ada"] }),
      refused(
        "invalid_params",
        /Foundry's actor model refuses the removal: .*ownership: is not a mapping of user IDs.* To take a user's level away, give it as -1 in ownership instead\./
      )
    );
    assert.deepEqual([sent(), goblin._source], [[], before]);
    await change({ ownership: { ada: -1 } });
    assert.deepEqual(goblin._source.ownership, { default: 0, ada: -1 });
  });

  const refusals: [string, Record<string, unknown>, RegExp][] = [
    ["an unknown field", { system: { atributes: {} } }, /No such field: system\.atributes\./],
    [
      "a derived field",
      { system: { attributes: { ac: { value: 18 } } } },
      /Derived, never stored: system\.attributes\.ac\.value/
    ],
    [
      "a key outside the keys a map keeps",
      { system: { attributes: { senses: { ranges: { smell: 30 } } } } },
      /senses\.ranges\.smell: the key must be one of darkvision, blindsight/
    ],
    [
      "the bridge's own flag",
      { flags: { "foundry-mcp": {} } },
      /flags\.foundry-mcp cannot be given: it is the bridge's own flag/
    ],
    [
      "the bridge's own flag on the prototype token",
      { prototypeToken: { flags: { "foundry-mcp": { managed: true } } } },
      /prototypeToken\.flags\.foundry-mcp cannot be given: it is the bridge's own flag/
    ],
    [
      "data the model refuses",
      { system: { skills: { ste: { value: 5 } } } },
      /refuses the data: .*system\.skills\.ste\.value: must be at most 2/
    ],
    [
      "a value Foundry would store as something else",
      { system: { attributes: { hp: { value: 3.6 } } } },
      /hp\.value: 3\.6 would be stored as 4/
    ],
    ["another type", { type: "character" }, /Goblin is a npc, and Foundry cannot change the type of an actor/]
  ];
  for (const [label, args, message] of refusals) {
    it(`refuses ${label} and writes nothing`, async () => {
      const before = structuredClone(goblin._source);
      await assert.rejects(change({ name: "Renamed", ...args }), refused("invalid_params", message));
      assert.deepEqual([sent(), goblin._source], [[], before]);
    });
  }

  it("takes the type of the actor when it is given", async () => {
    assert.deepEqual((await change({ type: "npc", system: { details: { cr: 1 } } })).changed, ["system.details.cr"]);
  });

  it("refuses a compendium actor as the one to change", async () => {
    const owlbear = world.addPackActor("dnd5e.actors24", { name: "Owlbear" });
    await assert.rejects(
      ensure({ actor: `Compendium.dnd5e.actors24.Actor.${owlbear.id}`, name: "Mine" }),
      refused("invalid_params", /is an actor in the compendium dnd5e\.actors24, and this tool writes no compendium/)
    );
    assert.equal(owlbear.name, "Owlbear");
  });

  it("checks an image only when it would be written", async () => {
    assert.deepEqual((await change({ img: "art/goblin.webp", system: { details: { cr: 1 } } })).changed, [
      "system.details.cr"
    ]);
    await assert.rejects(
      change({ img: "art/missing.webp" }),
      refused("invalid_params", /art\/missing\.webp could not be loaded/)
    );
    assert.deepEqual((await change({ img: "art/boss.webp" })).changed, ["img"]);
    assert.equal(goblin.img, "art/boss.webp");
  });

  it("takes null as no image: one read as null is passed back unchanged, and null is written for an image", async () => {
    const faceless = world.addActor({ name: "Faceless", img: null });
    const read = await viaTool("get_actor", { actor: faceless.id });
    assert.equal(read.img, null);
    assert.deepEqual((await ensure({ actor: faceless.id, img: read.img })).changed, []);
    assert.deepEqual((await change({ img: null })).changed, ["img"]);
    assert.equal(goblin.img, null);
  });

  it("takes two spellings of one HTML content as the same, and writes neither again", async () => {
    const result = await change({
      system: {
        details: { biography: { value: "<P>Small<br />and mean<!-- todo --></P>" } },
        attributes: { hp: { value: 5 } }
      }
    });
    assert.deepEqual(sent(), [{ system: { attributes: { hp: { value: 5 } } } }]);
    assert.deepEqual([result.changed, result.unapplied], [["system.attributes.hp.value"], []]);
    assert.equal(goblin._source.system.details.biography.value, "<p>Small<br>and mean</p>");
  });

  it("writes HTML that says something else as it was given, and does not report the server's spelling as unapplied", async () => {
    const biography = { value: "<p style='color: red'>Small &amp; mean</p>" };
    const result = await change({ system: { details: { biography } } });
    assert.deepEqual(sent(), [{ system: { details: { biography } } }]);
    assert.equal(goblin._source.system.details.biography.value, '<p style="color:red">Small &amp; mean</p>');
    assert.deepEqual([result.changed, result.unapplied], [["system.details.biography.value"], []]);
    assert.deepEqual([(await change({ system: { details: { biography } } })).changed, sent().length], [[], 1]);
  });

  it("takes a style attribute without a declaration as none, as the server stores it", async () => {
    const biography = { value: '<p style="">Small<br>and <b style=" ; ">mean</b></p>' };
    const result = await change({ system: { details: { biography } } });
    assert.equal(goblin._source.system.details.biography.value, "<p>Small<br>and <b>mean</b></p>");
    assert.deepEqual([result.changed, result.unapplied], [["system.details.biography.value"], []]);
    assert.deepEqual([(await change({ system: { details: { biography } } })).changed, sent().length], [[], 1]);
  });

  it("tells apart HTML that differs in a text, an attribute or a style the parser does not know", async () => {
    const write = async (value: string) =>
      (await change({ system: { details: { biography: { value } } } })).changed.length;
    assert.equal(await write("<p>Small<br>and meaner</p>"), 1);
    assert.equal(await write('<p class="x">Small<br>and meaner</p>'), 1);
    assert.equal(await write('<p class="x" style="frobnicate: 3">Small<br>and meaner</p>'), 1);
    assert.equal(await write('<p class="x" style="frobnicate: 4">Small<br>and meaner</p>'), 1);
    assert.equal(await write('<p style="frobnicate:4" class="x">Small<br>and meaner</p>'), 0);
  });

  it("reports a value a hook dropped as unapplied and not as changed", async () => {
    world.control.filterActorChanges = (changes) => {
      delete changes.system.details.cr;
    };
    const result = await change({ system: { details: { cr: 2 }, attributes: { hp: { value: 4 } } } });
    assert.deepEqual([result.changed, result.unapplied], [["system.attributes.hp.value"], ["system.details.cr"]]);
  });

  it("reports a value a hook stored otherwise as changed and as unapplied", async () => {
    world.control.filterActorChanges = (changes) => {
      changes.system.details.cr = 5;
    };
    const result = await change({ system: { details: { cr: 2 } } });
    assert.deepEqual([result.changed, result.unapplied], [["system.details.cr"], ["system.details.cr"]]);
  });

  it("reports an entry that was not removed as unapplied", async () => {
    world.control.filterActorChanges = (changes) => {
      delete changes.system.tools.thief;
    };
    const result = await change({ remove: ["system.tools.thief", "system.tools.smith"] });
    assert.deepEqual([result.changed, result.unapplied], [["system.tools.smith"], ["system.tools.thief"]]);
  });

  it("says from the stored data what was written when Foundry fails during the update", async () => {
    world.control.actorUpdateError = "a hook threw";
    await assert.rejects(
      change({ system: { details: { cr: 2 } }, remove: ["system.tools.thief"] }),
      refused(
        "foundry_error",
        /Foundry failed while updating Goblin \(a hook threw\)\. Changed in the stored data: system\.details\.cr, system\.tools\.thief\. Running the call again writes what still differs\./
      )
    );
  });

  it("names the folders it made when Foundry fails during the update, which stay", async () => {
    world.control.actorUpdateError = "a hook threw";
    await assert.rejects(
      change({ folder: ["Lair", "Deep"], system: { details: { cr: 2 } } }),
      refused(
        "foundry_error",
        /Running the call again writes what still differs\. The actor folders \["Lair","Deep"\] were made for this call and stay: running it again uses them\./
      )
    );
    assert.deepEqual(
      world.folders.map((folder: any) => folder.name),
      ["Lair", "Deep"]
    );
  });

  it("takes back what get_actor returned, and writes nothing", async () => {
    const airship = world.addActor({
      name: "Airship",
      type: "vehicle",
      system: {
        attributes: { hp: { value: 300, max: 300, temp: null }, ac: { flat: 13, override: null, calc: "flat" } }
      }
    });
    // A key outside the skills dnd5e keeps, as one pack actor stores it, and the bridge's flag on the prototype token,
    // as assigning a bridge-made token to it brings along.
    const dragon = world.addActor({ name: "Dragon", system: { skills: { ste: { value: 1 }, value: { value: 0 } } } });
    const captain = world.addActor({
      name: "Captain",
      prototypeToken: { name: "Captain", actorLink: true, flags: { ...MANAGED, world: { rank: 2 } } }
    });
    for (const actor of [goblin, airship, dragon, captain]) {
      const { system, prototypeToken, ownership, name, img } = await viaTool("get_actor", { actor: actor.id });
      const result = await ensure({ actor: actor.id, name, img, system, prototypeToken, ownership });
      assert.deepEqual([result.changed, result.unapplied], [[], []], actor.name);
    }
    assert.deepEqual(sent(), []);
    const read = (actor: any) => viaTool("get_actor", { actor: actor.id });
    assert.deepEqual((await read(dragon)).system.skills, { ste: { value: 1 } });
    assert.deepEqual((await read(captain)).prototypeToken.flags, { world: { rank: 2 } });
    await assert.rejects(
      ensure({ actor: airship.id, system: { attributes: { ac: { calc: "flat" } } } }),
      refused("invalid_params", /system\.attributes\.ac\.calc: "flat" would not be stored/)
    );
  });
});

describe("ensure_actor on the actor of a token", () => {
  let world: World;
  let scene: any;
  let goblin: any;
  let token: any;
  let uuid: string;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar" });
    goblin = world.addActor(goblinData());
    token = world.addToken(scene, { name: "Goblin", actorId: goblin.id });
    uuid = `${scene.uuid}.Token.${token.id}.Actor.${goblin.id}`;
    world.install();
  });
  const writes = () => [world.log.actorUpdates.length, world.log.tokenUpdates.length];

  it("writes into the token's own changes and leaves the world actor as it was", async () => {
    const before = structuredClone(goblin._source);
    const result = await ensure({
      actor: uuid,
      name: "Wounded Goblin",
      system: { attributes: { hp: { value: 2 } }, tools: { herb: { value: 1 } } },
      flags: { world: { note: "limping" } }
    });
    assert.deepEqual(token._source.delta, {
      name: "Wounded Goblin",
      system: { attributes: { hp: { value: 2 } }, tools: { herb: { value: 1, ability: "int" } } },
      flags: { world: { note: "limping" } }
    });
    assert.deepEqual(goblin._source, before);
    assert.deepEqual(
      [result.id, result.uuid, result.name, result.folder, result.created, result.derived.hp],
      [goblin.id, uuid, "Wounded Goblin", [], false, { value: 2, max: 7, temp: null }]
    );
    assert.deepEqual(result.changed, [
      "name",
      "system.attributes.hp.value",
      "system.tools.herb.value",
      "system.tools.herb.ability",
      "flags.world.note"
    ]);
    const again = await ensure({ actor: uuid, name: "Wounded Goblin", system: { attributes: { hp: { value: 2 } } } });
    assert.deepEqual([again.changed, writes()], [[], [0, 1]]);
  });

  it("keeps what an earlier call changed on the token when a later call changes something else", async () => {
    await ensure({ actor: uuid, system: { attributes: { hp: { value: 2 } } } });
    const result = await ensure({ actor: uuid, system: { details: { cr: 1 } } });
    assert.deepEqual([result.changed, result.unapplied], [["system.details.cr"], []]);
    assert.deepEqual(token._source.delta, { system: { attributes: { hp: { value: 2 } }, details: { cr: 1 } } });
  });

  it("removes an entry the token added through the token, in the same write as a changed value", async () => {
    await ensure({ actor: uuid, system: { tools: { herb: { value: 1 } } }, flags: { world: { limp: true } } });
    const args = { actor: uuid, system: { details: { cr: 2 } }, remove: ["system.tools.herb", "flags.world.limp"] };
    const result = await ensure(args);
    assert.deepEqual(world.log.tokenUpdates.at(-1), [
      {
        _id: token.id,
        delta: { system: { details: { cr: 2 }, tools: { herb: GONE } }, flags: { world: { limp: GONE } } }
      }
    ]);
    assert.deepEqual(
      [result.changed, result.unapplied],
      [["system.details.cr", "system.tools.herb", "flags.world.limp"], []]
    );
    assert.deepEqual(token._source.delta, { system: { tools: {}, details: { cr: 2 } }, flags: { world: {} } });
    assert.deepEqual([(await ensure(args)).changed, writes()], [[], [0, 2]]);
  });

  it("refuses to remove an entry the world actor has, also one the token changed, and writes nothing", async () => {
    await ensure({ actor: uuid, system: { tools: { thief: { value: 2 } } } });
    const delta = structuredClone(token._source.delta);
    for (const path of ["system.tools.thief", "system.tools.smith", "flags.world.seen.by"]) {
      const escaped = path.replaceAll(".", "\\.");
      await assert.rejects(
        ensure({ actor: uuid, system: { details: { cr: 2 } }, remove: [path, "system.tools.herb"] }),
        refused(
          "invalid_params",
          new RegExp(
            `remove: ${escaped} comes from the world actor Goblin \\(${goblin.id}\\), and on the actor of a token only what that token changed can be removed\\.`
          )
        )
      );
    }
    assert.deepEqual([token._source.delta, writes()], [delta, [0, 1]]);
  });

  for (const [key, value] of [
    ["folder", ["Monsters"]],
    ["prototypeToken", { name: "Boss" }]
  ] as const) {
    it(`refuses ${key} for a token's actor, and writes nothing`, async () => {
      await assert.rejects(
        ensure({ actor: uuid, name: "Renamed", [key]: value }),
        refused("invalid_params", new RegExp(`is the actor of a token\\..*have no ${key}\\. Leave ${key} out`))
      );
      assert.deepEqual([token._source.delta, world.folders.size, writes()], [{}, 0, [0, 0]]);
    });
  }

  it("takes back what get_actor returns for the token's actor, which has no prototype token", async () => {
    await ensure({ actor: uuid, name: "Wounded Goblin", system: { attributes: { hp: { value: 2 } } } });
    const read = await viaTool("get_actor", { actor: uuid });
    assert.equal("prototypeToken" in read, false);
    const { name, img, system, prototypeToken, ownership } = read;
    const result = await ensure({ actor: uuid, name, img, system, prototypeToken, ownership });
    assert.deepEqual([result.changed, result.unapplied, writes()], [[], [], [0, 1]]);
  });

  it("changes the world actor through the UUID of a token linked to it", async () => {
    const linked = world.addToken(scene, { name: "Goblin", actorId: goblin.id, actorLink: true });
    const result = await ensure({
      actor: `${scene.uuid}.Token.${linked.id}.Actor.${goblin.id}`,
      system: { attributes: { hp: { value: 1 } } }
    });
    assert.deepEqual(
      [result.uuid, goblin._source.system.attributes.hp.value, linked._source.delta, writes()],
      [`Actor.${goblin.id}`, 1, {}, [1, 0]]
    );
  });
});

describe("delete_actors", () => {
  let world: World;
  let scene: any;
  let made: any;
  let other: any;
  let mine: any;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar", width: 1000, height: 800 });
    made = world.addActor({ name: "Goblin", flags: MANAGED });
    other = world.addActor({ name: "Orc", flags: MANAGED });
    mine = world.addActor({ name: "Strahd" });
    world.install();
  });
  const remove = (args: Record<string, unknown>) => viaTool("delete_actors", args);
  const names = () => world.actors.map((actor: any) => actor.name);

  it("deletes bridge-made actors by id and says which", async () => {
    const result = await remove({ ids: [made.id, other.id] });
    assert.deepEqual(result, { deleted: 2, ids: [made.id, other.id], names: ["Goblin", "Orc"] });
    assert.deepEqual(names(), ["Strahd"]);
  });

  it("ignores ids that are no world actor, and an id given twice", async () => {
    const result = await remove({ ids: ["nobody", made.id, `Actor.${other.id}`, made.id] });
    assert.deepEqual(result, { deleted: 1, ids: [made.id], names: ["Goblin"] });
    assert.deepEqual(await remove({ ids: ["nobody"] }), { deleted: 0, ids: [], names: [] });
    assert.deepEqual([names(), world.log.actorDeletes], [["Orc", "Strahd"], [[made.id]]]);
  });

  it("refuses a hand-made actor without the switch, names it, and deletes nothing of the call", async () => {
    await assert.rejects(
      remove({ ids: [made.id, mine.id] }),
      refused(
        "invalid_params",
        new RegExp(`not made by this bridge: Strahd \\(${mine.id}\\)\\..*Pass handMade: true.*Nothing was written\\.`)
      )
    );
    assert.deepEqual([names(), world.log.actorDeletes], [["Goblin", "Orc", "Strahd"], []]);
  });

  it("deletes a hand-made actor with the switch", async () => {
    const result = await remove({ ids: [made.id, mine.id], handMade: true });
    assert.deepEqual([result.deleted, result.names, names()], [2, ["Goblin", "Strahd"], ["Orc"]]);
  });

  it("refuses an actor that still has tokens on a scene, names the scenes, and deletes nothing of the call", async () => {
    const road = world.addScene({ name: "Road" });
    world.addToken(scene, { actorId: made.id });
    world.addToken(scene, { actorId: made.id, actorLink: true });
    world.addToken(road, { actorId: made.id });
    await assert.rejects(
      remove({ ids: [other.id, made.id] }),
      refused(
        "invalid_params",
        new RegExp(
          `still have tokens on a scene.*: Goblin \\(${made.id}\\) on Cellar, Road\\. Delete the tokens first with delete_tokens`
        )
      )
    );
    assert.deepEqual([names(), world.log.actorDeletes], [["Goblin", "Orc", "Strahd"], []]);
  });

  it("deletes an actor once its tokens are gone, although placing them built tokens that were never stored", async () => {
    const placed = await viaTool("place_tokens", { sceneId: scene.id, tokens: [{ actor: made.id, at: [150, 250] }] });
    await assert.rejects(remove({ ids: [made.id] }), refused("invalid_params", /still have tokens/));
    await viaTool("delete_tokens", { sceneId: scene.id, ids: [placed.tokens[0].id] });
    assert.ok(
      made.getDependentTokens().length > 0,
      "the fake keeps the unsaved tokens with the actor, as Foundry does"
    );
    assert.deepEqual((await remove({ ids: [made.id] })).deleted, 1);
  });

  it("reports the actors Foundry did delete when a hook refuses one", async () => {
    world.control.vetoActorDelete = (actor) => actor.name === "Orc";
    const result = await remove({ ids: [made.id, other.id] });
    assert.deepEqual(result, { deleted: 1, ids: [made.id], names: ["Goblin"] });
    assert.deepEqual(names(), ["Orc", "Strahd"]);
  });
});
