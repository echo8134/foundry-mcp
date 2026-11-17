import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeWorld } from "./fake-world.ts";
import { MANAGED, refused, restoreGlobals, viaTool } from "./token-world.ts";

afterEach(restoreGlobals);

type World = ReturnType<typeof fakeWorld>;

const only = (world: World) => {
  assert.equal(world.actors.size, 1);
  return [...world.actors.values()][0];
};
const writes = (world: World) => [
  world.log.actorCreates.length,
  world.log.actorUpdates.length,
  world.log.folderCreates
];
const ensure = (args: Record<string, unknown>) => viaTool("ensure_actor", args);

describe("ensure_actor creating an actor", () => {
  let world: World;
  beforeEach(() => {
    world = fakeWorld();
    world.install();
  });

  const bandit = {
    name: "Bandit",
    type: "npc",
    folder: ["Monsters", "Humans"],
    system: { attributes: { ac: { flat: 12, calcs: ["natural"] }, hp: { value: 9, max: 11 } }, details: { cr: 0.125 } }
  };

  it("creates the actor by name in the folder, makes the missing folders, flags it and says what it stored", async () => {
    const result = await ensure(bandit);
    const actor = only(world);
    const folders = world.folders.map((folder: any) => [folder.name, folder.type, folder.folder?.name ?? null]);
    assert.deepEqual(folders, [
      ["Monsters", "Actor", null],
      ["Humans", "Actor", "Monsters"]
    ]);
    assert.deepEqual(
      [actor.name, actor.type, actor.folder.name, actor._source.flags, actor._source.system.attributes.ac],
      ["Bandit", "npc", "Humans", MANAGED, { flat: 12, calcs: ["natural"] }]
    );
    assert.deepEqual(result, {
      id: actor.id,
      uuid: `Actor.${actor.id}`,
      name: "Bandit",
      type: "npc",
      folder: ["Monsters", "Humans"],
      created: true,
      changed: [
        "name",
        "system.attributes.ac.flat",
        "system.attributes.ac.calcs",
        "system.attributes.hp.value",
        "system.attributes.hp.max",
        "system.details.cr",
        "folder"
      ],
      unapplied: [],
      derived: { hp: { value: 9, max: 11, temp: null }, abilities: {}, skills: {} }
    });
  });

  it("changes nothing when it runs again with the same input", async () => {
    const first = await ensure(bandit);
    const stored = structuredClone(only(world)._source);
    const again = await ensure(bandit);
    assert.deepEqual([again.id, again.created, again.changed, again.unapplied], [first.id, false, [], []]);
    assert.deepEqual(only(world)._source, stored);
    assert.deepEqual(writes(world), [1, 0, 2]);
  });

  it("creates at the root without a folder, and does not list a folder nobody gave as changed", async () => {
    const result = await ensure({ name: "Bandit", type: "npc" });
    assert.deepEqual([only(world)._source.folder, result.folder, result.changed], [null, [], ["name"]]);
  });

  it("gives a new npc that has a hit point maximum and no hit points the maximum as its hit points", async () => {
    const result = await ensure({ name: "Ogre", type: "npc", system: { attributes: { hp: { max: 59 } } } });
    assert.deepEqual(only(world)._source.system.attributes.hp, { value: 59, max: 59, temp: null });
    assert.deepEqual(result.changed, ["name", "system.attributes.hp.max", "system.attributes.hp.value"]);
    assert.deepEqual(result.derived.hp, { value: 59, max: 59, temp: null });
  });

  it("keeps given hit points, and gives another actor type none", async () => {
    await ensure({ name: "Hurt", type: "npc", system: { attributes: { hp: { value: 3, max: 59 } } } });
    await ensure({ name: "Cart", type: "vehicle", system: { attributes: { hp: { max: 40 } } } });
    const hp = world.actors.map((actor: any) => [actor.name, actor._source.system.attributes.hp.value]);
    assert.deepEqual(hp, [
      ["Hurt", 3],
      ["Cart", null]
    ]);
  });

  it("does not give the hit points again to an actor that exists, where they were changed since", async () => {
    const ogre = { name: "Ogre", type: "npc", system: { attributes: { hp: { max: 59 } } } };
    await ensure(ogre);
    only(world)._source.system.attributes.hp.value = 20;
    const again = await ensure(ogre);
    assert.deepEqual([again.changed, only(world)._source.system.attributes.hp.value], [[], 20]);
  });

  it("needs a type or an actor to copy, and refuses a type the system does not have, naming its types", async () => {
    await assert.rejects(ensure({ name: "Nobody" }), refused("invalid_params", /needs a type, or from/));
    await assert.rejects(
      ensure({ name: "Nobody", type: "monster" }),
      refused("invalid_params", /"monster".*character, npc, vehicle, group/)
    );
    await assert.rejects(ensure({ name: "Nobody", type: "base" }), refused("invalid_params"));
    assert.deepEqual([world.actors.size, ...writes(world)], [0, 0, 0, 0]);
  });

  const refusals: [string, Record<string, unknown>, RegExp][] = [
    [
      "an unknown field",
      { system: { attributes: { hp: { maxx: 5 } } } },
      /No such field: system\.attributes\.hp\.maxx\./
    ],
    [
      "a derived field",
      { system: { attributes: { ac: { value: 15 } } } },
      /Derived, never stored: system\.attributes\.ac\.value/
    ],
    [
      "a key outside the keys a map keeps",
      { system: { skills: { stealth: { value: 1 } } } },
      /system\.skills\.stealth: the key must be one of acr, prc, ste\./
    ],
    ["the bridge's own flag", { flags: { "foundry-mcp": { managed: false } } }, /flags\.foundry-mcp cannot be given/],
    [
      "the bridge's own flag on the prototype token",
      { prototypeToken: { flags: { "foundry-mcp": { managed: true } } } },
      /prototypeToken\.flags\.foundry-mcp cannot be given/
    ],
    ["the bridge's own flag as a key with a dot", { flags: { "foundry-mcp.managed": false } }, /Not a plain key/],
    ["an ownership level that is none", { ownership: { default: 9 } }, /refuses the data: .*ownership/],
    [
      "data the model refuses",
      { system: { details: { cr: "high" } } },
      /Foundry's actor model refuses the data: .*cr: must be a number/
    ],
    [
      "a number outside its field's range, which Foundry would bring into it",
      { system: { details: { cr: -1 } } },
      /system\.details\.cr: -1 would be stored as 0/
    ],
    [
      "a value Foundry would store as something else",
      { system: { details: { cr: "2" } } },
      /system\.details\.cr: "2" would be stored as 2\. Give each value as Foundry stores it\./
    ],
    [
      "null for an entry of a keyed map, which would reset it",
      { system: { tools: { thief: null } } },
      /system\.tools\.thief: null would be stored as \{"value":1,"ability":"int"\}/
    ]
  ];
  for (const [label, data, message] of refusals) {
    it(`refuses ${label} and creates nothing, not even a folder`, async () => {
      await assert.rejects(
        ensure({ name: "Bandit", type: "npc", folder: ["Monsters"], ...data }),
        refused("invalid_params", message)
      );
      assert.deepEqual([world.actors.size, ...writes(world)], [0, 0, 0, 0]);
    });
  }

  it("refuses an image that does not load, and takes one that does", async () => {
    world = fakeWorld({ unloadable: ["art/missing.webp"] });
    world.install();
    await assert.rejects(
      ensure({ name: "Bandit", type: "npc", img: "art/missing.webp" }),
      refused("invalid_params", /The image art\/missing\.webp could not be loaded\. Nothing was written\./)
    );
    assert.equal(world.actors.size, 0);
    const result = await ensure({ name: "Bandit", type: "npc", img: "art/bandit.webp" });
    assert.deepEqual([only(world).img, result.changed], ["art/bandit.webp", ["name", "img"]]);
  });

  it("writes once more what the creation did not keep, so that one call ends where a second would", async () => {
    // As dnd5e links the prototype token of a new character to it, whatever was given.
    world.control.filterActorData = (source) => {
      source.prototypeToken.actorLink = true;
    };
    const args = { name: "Hero", type: "npc", prototypeToken: { actorLink: false } };
    const result = await ensure(args);
    const hero = only(world);
    assert.deepEqual(world.log.actorUpdates, [{ id: hero.id, changes: { prototypeToken: { actorLink: false } } }]);
    assert.deepEqual(
      [result.created, result.changed, result.unapplied, hero._source.prototypeToken.actorLink],
      [true, ["name", "prototypeToken.actorLink"], [], false]
    );
    assert.deepEqual([(await ensure(args)).changed, ...writes(world)], [[], 1, 1, 0]);
  });

  it("reports a value a hook or the system stores otherwise also when it is written again as unapplied", async () => {
    world.control.filterActorData = (source) => {
      source.prototypeToken.name = "Someone";
      source.system.details.cr = 1;
    };
    world.control.filterActorChanges = (changes) => {
      delete changes.prototypeToken;
      delete changes.system;
    };
    const result = await ensure({
      name: "Bandit",
      type: "npc",
      system: { details: { cr: 0.5 } },
      prototypeToken: { name: "Bandit" }
    });
    assert.deepEqual(result.unapplied, ["system.details.cr", "prototypeToken.name"]);
    assert.deepEqual([result.created, result.changed], [true, ["name", "system.details.cr", "prototypeToken.name"]]);
    assert.equal(world.log.actorUpdates.length, 1);
  });

  it("answers with a Foundry error when Foundry skips the actor without one, and names the folders it made", async () => {
    world.control.vetoActor = () => true;
    await assert.rejects(
      ensure({ name: "Bandit", type: "npc", folder: ["Monsters", "Humans"] }),
      refused(
        "foundry_error",
        /Foundry created no actor and reported no error.*No actor was written\. The actor folders \["Monsters","Humans"\] were made for this call and stay: running it again uses them\./
      )
    );
    assert.deepEqual([world.actors.size, world.folders.size], [0, 2]);
    await assert.rejects(
      ensure({ name: "Bandit", type: "npc", folder: ["Monsters", "Humans"] }),
      refused("foundry_error", /No actor was written\.$/)
    );
    assert.equal(world.folders.size, 2);
  });

  it("answers with a Foundry error that carries the reason when the creation throws", async () => {
    world.control.actorCreateError = "socket closed";
    await assert.rejects(
      ensure({ name: "Bandit", type: "npc" }),
      refused("foundry_error", /Foundry failed while creating the actor \(socket closed\)\. list_actors shows/)
    );
  });

  it("stores HTML as the server spells it, and takes the given text as the same content", async () => {
    const lair = {
      name: "Lich",
      type: "npc",
      system: { details: { biography: { value: "<p class='lair'>Cold<br />and &mdash; dark<!-- draft --></p>" } } }
    };
    const result = await ensure(lair);
    assert.equal(only(world)._source.system.details.biography.value, '<p class="lair">Cold<br>and — dark</p>');
    assert.deepEqual([result.unapplied, result.changed], [[], ["name", "system.details.biography.value"]]);
    const again = await ensure(lair);
    assert.deepEqual([again.changed, again.unapplied, ...writes(world)], [[], [], 1, 0, 0]);
  });
});

describe("ensure_actor finding the actor", () => {
  let world: World;
  let monsters: any;
  beforeEach(() => {
    world = fakeWorld();
    monsters = world.addFolder("Monsters", null, "Actor");
    world.install();
  });

  it("updates the one bridge-made actor of that name in that folder", async () => {
    const goblin = world.addActor({
      name: "Goblin",
      folder: monsters.id,
      flags: MANAGED,
      system: { details: { cr: 1 } }
    });
    const result = await ensure({ name: "Goblin", folder: ["Monsters"], system: { details: { cr: 2 } } });
    assert.deepEqual([result.id, result.created, result.changed], [goblin.id, false, ["system.details.cr"]]);
    assert.deepEqual([world.actors.size, goblin._source.system.details.cr], [1, 2]);
  });

  it("looks in exactly the given folder: the same name elsewhere is another actor", async () => {
    const inFolder = world.addActor({ name: "Goblin", folder: monsters.id, flags: MANAGED });
    const atRoot = await ensure({ name: "Goblin", type: "npc" });
    assert.deepEqual([atRoot.created, atRoot.folder, world.actors.size], [true, [], 2]);
    const deeper = await ensure({ name: "Goblin", type: "npc", folder: ["Monsters", "Cave"] });
    assert.deepEqual([deeper.created, deeper.folder, world.actors.size], [true, ["Monsters", "Cave"], 3]);
    assert.notEqual(atRoot.id, inFolder.id);
  });

  it("refuses several bridge-made actors of that name with their ids, and writes nothing", async () => {
    const one = world.addActor({ name: "Goblin", flags: MANAGED });
    const two = world.addActor({ name: "Goblin", flags: MANAGED });
    await assert.rejects(
      ensure({ name: "Goblin", system: { details: { cr: 2 } } }),
      refused(
        "invalid_params",
        new RegExp(
          `2 bridge-made actors are named "Goblin" in the root \\(${one.id}, ${two.id}\\)\\. Pass the id of one as actor\\.`
        )
      )
    );
    assert.deepEqual(writes(world), [0, 0, 0]);
  });

  it("refuses a name that only a hand-made actor has, with its id, and never takes that actor over", async () => {
    const mine = world.addActor({ name: "Strahd", folder: monsters.id, system: { details: { cr: 15 } } });
    await assert.rejects(
      ensure({ name: "Strahd", type: "npc", folder: ["Monsters"], system: { details: { cr: 1 } } }),
      refused(
        "invalid_params",
        new RegExp(
          `named "Strahd" in folder \\["Monsters"\\] was not made by this bridge \\(${mine.id}\\)\\. Pass its id as actor`
        )
      )
    );
    assert.deepEqual([world.actors.size, mine._source.system.details.cr, ...writes(world)], [1, 15, 0, 0, 0]);
  });

  it("updates the bridge-made actor of a name a hand-made one has too", async () => {
    const mine = world.addActor({ name: "Goblin", system: { details: { cr: 1 } } });
    const made = world.addActor({ name: "Goblin", flags: MANAGED, system: { details: { cr: 1 } } });
    const result = await ensure({ name: "Goblin", system: { details: { cr: 3 } } });
    assert.deepEqual([result.id, mine._source.system.details.cr, made._source.system.details.cr], [made.id, 1, 3]);
  });

  it("changes the actor named by id or by UUID, hand-made or not, with a new name and folder", async () => {
    const mine = world.addActor({ name: "Strahd", system: { details: { cr: 15 } } });
    const byId = await ensure({ actor: mine.id, name: "Strahd von Zarovich", folder: ["Monsters", "Undead"] });
    assert.deepEqual(
      [byId.id, byId.created, byId.name, byId.folder, byId.changed],
      [mine.id, false, "Strahd von Zarovich", ["Monsters", "Undead"], ["name", "folder"]]
    );
    assert.equal(mine.folder.name, "Undead");
    const byUuid = await ensure({ actor: `Actor.${mine.id}`, system: { details: { cr: 16 } }, folder: [] });
    assert.deepEqual(
      [byUuid.changed, mine._source.system.details.cr, mine._source.folder],
      [["system.details.cr", "folder"], 16, null]
    );
    assert.equal(world.actors.size, 1);
    assert.equal("foundry-mcp" in mine._source.flags, false, "an actor changed by id is not flagged as bridge-made");
  });

  it("answers not_found for an actor that is not there, and refuses an ambiguous or too deep folder path", async () => {
    await assert.rejects(ensure({ actor: "nobody", name: "X" }), refused("not_found", /No world actor with id nobody/));
    world.addFolder("Monsters", null, "Actor");
    await assert.rejects(
      ensure({ name: "Goblin", type: "npc", folder: ["Monsters"] }),
      refused("invalid_params", /Two actor folders share the path \["Monsters"\]/)
    );
    await assert.rejects(
      ensure({ name: "Goblin", type: "npc", folder: ["a", "b", "c", "d", "e"] }),
      refused("invalid_params", /at most 4 levels deep, the path has 5/)
    );
    assert.deepEqual(writes(world), [0, 0, 0]);
  });

  it("finds the actor an earlier call made that was still running when this one was given", async () => {
    world = fakeWorld({ latency: 5 });
    world.install();
    const args = { name: "Twin", type: "npc", folder: ["Pairs"], system: { details: { cr: 2 } } };
    const [first, second] = await Promise.all([ensure(args), ensure(args)]);
    assert.deepEqual([first.created, second.created, second.id, second.changed], [true, false, first.id, []]);
    assert.deepEqual([world.actors.size, world.folders.size], [1, 1]);
  });
});

describe("ensure_actor copying an actor", () => {
  let world: World;
  let owlbear: any;
  beforeEach(() => {
    world = fakeWorld();
    owlbear = world.addPackActor("dnd5e.actors24", {
      name: "Owlbear",
      type: "npc",
      img: "owlbear.webp",
      folder: world.addFolder("Beasts", null, "Actor").id,
      ownership: { default: 2, someone: 3 },
      system: {
        attributes: { hp: { value: 59, max: 59 }, ac: { flat: 13, calcs: ["natural"] } },
        details: { cr: 3 },
        tools: { thief: { value: 1, ability: "dex" } }
      },
      flags: { dnd5e: { art: "x" } },
      items: [{ name: "Beak", type: "weapon" }],
      effects: [{ _id: "keensight", name: "Keen Sight" }]
    });
    world.install();
  });
  const uuid = () => `Compendium.dnd5e.actors24.Actor.${owlbear.id}`;

  it("copies a compendium actor with its items and effects, under the given name and folder", async () => {
    const result = await ensure({ name: "Old Owlbear", from: uuid(), folder: ["Forest"] });
    const copy = world.actors.get(result.id);
    assert.deepEqual(
      [result.created, result.type, result.folder, result.changed],
      [true, "npc", ["Forest"], ["name", "folder"]]
    );
    assert.deepEqual(
      [copy.name, copy.img, copy._source.system.details.cr, copy._source.system.attributes.hp.value],
      ["Old Owlbear", "owlbear.webp", 3, 59]
    );
    assert.deepEqual(
      copy.items.map((item: any) => [item.name, item.type]),
      [["Beak", "weapon"]]
    );
    assert.deepEqual(
      copy.effects.map((effect: any) => [effect.id, effect.name]),
      [["keensight", "Keen Sight"]]
    );
    assert.deepEqual(
      [copy._source.flags, copy._source.ownership, copy._source._stats.compendiumSource],
      [{ dnd5e: { art: "x" }, ...MANAGED }, { default: 0, user1: 3 }, uuid()]
    );
    assert.notEqual(copy.id, owlbear.id);
  });

  it("merges the given data over the copy: objects merge and a list is replaced whole", async () => {
    const result = await ensure({
      name: "Tough Owlbear",
      from: uuid(),
      system: { attributes: { hp: { max: 80 }, ac: { calcs: ["armored"] } } }
    });
    const { attributes, details } = world.actors.get(result.id)._source.system;
    assert.deepEqual(attributes.ac, { flat: 13, calcs: ["armored"] });
    assert.deepEqual([attributes.hp, details.cr], [{ value: 80, max: 80, temp: null }, 3]);
    assert.deepEqual(result.changed, [
      "name",
      "system.attributes.hp.max",
      "system.attributes.hp.value",
      "system.attributes.ac.calcs"
    ]);
  });

  it("does not copy again when it runs again, and leaves what was changed since as it is", async () => {
    const args = { name: "Old Owlbear", from: uuid(), system: { details: { cr: 4 } } };
    const first = await ensure(args);
    const copy = world.actors.get(first.id);
    copy._source.system.attributes.hp.value = 12;
    const again = await ensure(args);
    assert.deepEqual([again.id, again.created, again.changed], [first.id, false, []]);
    assert.deepEqual([copy._source.system.attributes.hp.value, world.actors.size, ...writes(world)], [12, 1, 1, 0, 0]);
  });

  it("copies a world actor by id, without a compendium source", async () => {
    const hero = world.addActor({
      name: "Hero",
      type: "character",
      system: { details: {} },
      items: [{ name: "Sword", type: "weapon" }]
    });
    const result = await ensure({ name: "Hero's Twin", from: hero.id });
    const twin = world.actors.get(result.id);
    assert.deepEqual(
      [twin.type, twin.items.size, twin._source._stats, twin._source.flags],
      ["character", 1, {}, MANAGED]
    );
  });

  it("removes an entry of the copy as it is created, and changes nothing when it runs again", async () => {
    const args = { name: "Clumsy Owlbear", from: uuid(), remove: ["system.tools.thief", "system.tools.smith"] };
    const first = await ensure(args);
    const copy = world.actors.get(first.id);
    assert.deepEqual([copy._source.system.tools, first.unapplied], [{}, []]);
    const again = await ensure(args);
    assert.deepEqual([again.changed, again.unapplied, ...writes(world)], [[], [], 1, 0, 0]);
  });

  it("refuses a type that is not the source's, a source that is not there, and the actor of a token", async () => {
    await assert.rejects(
      ensure({ name: "Odd", type: "vehicle", from: uuid() }),
      refused("invalid_params", /is a npc, not a vehicle\. Leave type out, or pass npc\./)
    );
    await assert.rejects(
      ensure({ name: "Odd", from: "Compendium.dnd5e.actors24.Actor.nobody" }),
      refused("not_found", /Nothing exists at the UUID/)
    );
    const scene = world.addScene({ name: "Cellar" });
    const goblin = world.addActor({ name: "Goblin" });
    const token = world.addToken(scene, { actorId: goblin.id });
    await assert.rejects(
      ensure({ name: "Odd", from: `${scene.uuid}.Token.${token.id}.Actor.${goblin.id}` }),
      refused("invalid_params", /is the actor of a token\. Pass a world actor or a compendium actor as from\./)
    );
    assert.deepEqual([world.actors.size, ...writes(world)], [1, 0, 0, 0]);
  });

  it("refuses from together with actor, where nothing is created", async () => {
    const goblin = world.addActor({ name: "Goblin" });
    await assert.rejects(
      ensure({ actor: goblin.id, from: uuid() }),
      refused("invalid_params", /from copies an actor when a new one is created/)
    );
  });
});
