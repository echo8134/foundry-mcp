import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { idFromLabel } from "../module/scripts/labels.mjs";
import { fakeWorld } from "./fake-world.ts";
import { MANAGED, refused, restoreGlobals, viaTool } from "./token-world.ts";

afterEach(restoreGlobals);

type World = ReturnType<typeof fakeWorld>;

const BITE = idFromLabel("bite");
const ensure = (args: Record<string, unknown>) => viaTool("ensure_actor", args);
const writes = (world: World) => world.log.embedded.map((write) => [write.action, write.document, write.parent]);
const only = (world: World) => {
  assert.equal(world.actors.size, 1);
  return [...world.actors.values()][0];
};
const named = (actor: any, name: string) => actor.items.find((item: any) => item.name === name);

const bite = (bonus = "5") => ({
  name: "Bite",
  type: "feat",
  system: {
    activities: {
      bite: {
        type: "attack",
        attack: { flat: true, bonus },
        damage: { includeBase: false, parts: [{ number: 2, denomination: 6, bonus: "3", types: ["piercing"] }] }
      }
    }
  }
});
const keenSmell = { name: "Keen Smell", type: "feat", system: { description: { value: "<p>Sharp<br />nose</p>" } } };

describe("ensure_actor creating an actor with items", () => {
  let world: World;
  beforeEach(() => {
    world = fakeWorld();
    world.install();
  });
  const wolf = { name: "Wolf", type: "npc", items: [bite(), keenSmell] };

  it("creates the actor first and its items after it, as bridge-made items with the defaults dnd5e gives a new item", async () => {
    const result = await ensure(wolf);
    const actor = only(world);
    assert.deepEqual(
      world.log.actorCreates.map((data) => "items" in data),
      [false]
    );
    assert.deepEqual(writes(world), [["create", "Item", `Actor.${actor.id}`]]);
    assert.deepEqual(
      actor.items.map((item: any) => [item.name, item.type, item._source.flags, item._source.system.type.value]),
      [
        ["Bite", "feat", MANAGED, "monster"],
        ["Keen Smell", "feat", MANAGED, "monster"]
      ]
    );
    const at = `system.activities.${BITE}`;
    assert.deepEqual(result.items, [
      {
        id: named(actor, "Bite").id,
        name: "Bite",
        type: "feat",
        created: true,
        changed: [
          "name",
          `${at}.type`,
          `${at}.attack.flat`,
          `${at}.attack.bonus`,
          `${at}.damage.includeBase`,
          `${at}.damage.parts`,
          `${at}._id`
        ],
        unapplied: []
      },
      {
        id: named(actor, "Keen Smell").id,
        name: "Keen Smell",
        type: "feat",
        created: true,
        changed: ["name", "system.description.value"],
        unapplied: []
      }
    ]);
    assert.deepEqual(Object.keys(result).includes("effects"), false);
  });

  it("changes nothing and adds nothing when it runs again with the same input", async () => {
    await ensure(wolf);
    const stored = only(world).toObject();
    const again = await ensure(wolf);
    assert.deepEqual(
      again.items.map((item: any) => [item.name, item.created, item.changed, item.unapplied]),
      [
        ["Bite", false, [], []],
        ["Keen Smell", false, [], []]
      ]
    );
    assert.deepEqual([only(world).toObject(), writes(world).length], [stored, 1]);
  });

  it("adds an item to an actor that exists, and leaves the others as they are", async () => {
    await ensure(wolf);
    const result = await ensure({ name: "Wolf", items: [{ name: "Pack Tactics", type: "feat" }] });
    assert.deepEqual(
      [result.created, result.items.map((item: any) => [item.name, item.created])],
      [false, [["Pack Tactics", true]]]
    );
    assert.deepEqual(
      only(world).items.map((item: any) => item.name),
      ["Bite", "Keen Smell", "Pack Tactics"]
    );
  });

  it("gives a class made from nothing the advancement dnd5e starts it with, which a given id would cost it", async () => {
    await ensure({ name: "Veteran", type: "npc", items: [{ name: "Fighter", type: "class", system: { levels: 3 } }] });
    const fighter = named(only(world), "Fighter");
    assert.deepEqual([fighter._source.system.levels, Object.keys(fighter._source.system.advancement).length], [3, 1]);
  });

  it("refuses the whole call for a fault in the third of five items, and creates nothing, not even the actor", async () => {
    const items = [
      bite(),
      keenSmell,
      { name: "Howl", type: "feat", system: { activities: { howl: { type: "save", save: { dcc: 12 } } } } },
      { name: "Pounce", type: "feat" },
      { name: "Trip", type: "feat" }
    ];
    await assert.rejects(
      ensure({ name: "Wolf", type: "npc", folder: ["Beasts"], items }),
      refused(
        "invalid_params",
        new RegExp(
          `^items\\[2\\]: No such field: system\\.activities\\.${idFromLabel("howl")}\\.save\\.dcc\\. .*Those of an activity are listed with document Activity\\. Nothing was written\\.$`
        )
      )
    );
    assert.deepEqual([world.actors.size, world.folders.size, world.log.embedded.length], [0, 0, 0]);
  });

  it("names the entry Foundry created nothing for, and keeps what it did create", async () => {
    const result = await ensure({
      name: "Party",
      type: "group",
      items: [
        { name: "Banner", type: "weapon" },
        { name: "Morale", type: "feat" }
      ]
    });
    const party = only(world);
    assert.deepEqual(
      party.items.map((item: any) => item.name),
      ["Banner"]
    );
    assert.deepEqual(result.items[0], {
      id: named(party, "Banner").id,
      name: "Banner",
      type: "weapon",
      created: true,
      changed: ["name"],
      unapplied: []
    });
    const { error, ...missing } = result.items[1];
    assert.deepEqual(missing, { name: "Morale", type: "feat", created: false });
    assert.match(error, /^foundry_error: Foundry created nothing for this entry and reported no error/);
  });

  it("says from the stored data what was written when Foundry fails while creating the items", async () => {
    world.control.embeddedError = (action, document) =>
      action === "create" && document === "Item" ? "socket closed" : undefined;
    await assert.rejects(ensure({ ...wolf, folder: ["Beasts"] }), (error: any) => {
      const actor = only(world);
      assert.equal(error.code, "foundry_error");
      assert.equal(
        error.message,
        `Foundry failed while creating the items of Wolf (socket closed). Written before that, as the stored data shows: item Bite (${named(actor, "Bite").id}) created; item Keen Smell (${named(actor, "Keen Smell").id}) created. Running the call again writes what still differs. The actor Wolf (${actor.id}) was created before that and stays. The actor folders ["Beasts"] were made for this call and stay: running it again uses them.`
      );
      return true;
    });
  });

  it("reports a value the system stored otherwise as unapplied", async () => {
    world.control.filterEmbeddedData = (_document, source) => {
      source.system.type.value = "monster";
    };
    const result = await ensure({
      name: "Wolf",
      type: "npc",
      items: [{ name: "Gift", type: "feat", system: { type: { value: "race" } } }]
    });
    assert.deepEqual(result.items[0].unapplied, ["system.type.value"]);
  });
});

describe("ensure_actor finding an item", () => {
  let world: World;
  let goblin: any;
  beforeEach(() => {
    world = fakeWorld({ unloadable: ["art/missing.webp"] });
    goblin = world.addActor({
      name: "Goblin",
      items: [
        { name: "Scimitar", type: "weapon", system: { damage: { base: "1d6" } } },
        { name: "Nimble Escape", type: "feat", flags: MANAGED, system: { type: { value: "monster" } } },
        { name: "Twin", type: "feat", flags: MANAGED },
        { name: "Twin", type: "feat", flags: MANAGED },
        { name: "Fire Bolt", type: "spell", flags: { dnd5e: { cachedFor: ".Item.x.Activity.y" } } }
      ]
    });
    world.install();
  });
  const change = (items: unknown[], more: Record<string, unknown> = {}) => ensure({ actor: goblin.id, items, ...more });
  const sent = () => world.log.embedded.map((write) => [write.action, write.data]);

  it("changes the item of an id, also one made by hand, and sends only what differs", async () => {
    const scimitar = named(goblin, "Scimitar");
    const result = await change([{ id: scimitar.id, name: "Rusty Scimitar", system: { damage: { base: "1d6" } } }]);
    assert.deepEqual(sent(), [["update", [{ _id: scimitar.id, name: "Rusty Scimitar" }]]]);
    assert.deepEqual(result.items, [
      { id: scimitar.id, name: "Rusty Scimitar", type: "weapon", created: false, changed: ["name"], unapplied: [] }
    ]);
  });

  it("changes the bridge-made item of exactly that name and type", async () => {
    const result = await change([{ name: "Nimble Escape", type: "feat", system: { type: { value: "class" } } }]);
    const nimble = named(goblin, "Nimble Escape");
    assert.deepEqual(sent(), [["update", [{ _id: nimble.id, system: { type: { value: "class" } } }]]]);
    assert.deepEqual(
      [result.items[0].id, result.items[0].created, result.items[0].changed],
      [nimble.id, false, ["system.type.value"]]
    );
  });

  it("creates a new item where the name is taken by an item of another type only", async () => {
    const result = await change([{ name: "Scimitar", type: "feat" }]);
    assert.deepEqual(
      [result.items[0].created, goblin.items.filter((item: any) => item.name === "Scimitar").length],
      [true, 2]
    );
  });

  it("refuses several bridge-made items of the name and type with their ids", async () => {
    const twins = goblin.items.filter((item: any) => item.name === "Twin").map((item: any) => item.id);
    await assert.rejects(
      change([{ name: "Twin", type: "feat", system: { type: { value: "class" } } }]),
      refused(
        "invalid_params",
        new RegExp(
          `^items\\[0\\]: 2 bridge-made items of Goblin are a feat named "Twin" \\(${twins.join(", ")}\\)\\. Pass the id of one as id\\. Nothing was written\\.$`
        )
      )
    );
    assert.deepEqual(sent(), []);
  });

  it("refuses a name and type that only an item made by hand has, with its id, and never takes that item over", async () => {
    const scimitar = named(goblin, "Scimitar");
    await assert.rejects(
      change([{ name: "Scimitar", type: "weapon", system: { damage: { base: "9d9" } } }]),
      refused(
        "invalid_params",
        new RegExp(
          `Goblin has a weapon named "Scimitar" that this bridge did not make \\(${scimitar.id}\\)\\. Pass its id as id`
        )
      )
    );
    assert.deepEqual([sent(), scimitar._source.system.damage.base], [[], "1d6"]);
  });

  it("does not take the spell copy dnd5e keeps for a cast activity for an item of that name", async () => {
    const result = await change([{ name: "Fire Bolt", type: "spell" }]);
    assert.deepEqual(
      [result.items[0].created, goblin.items.filter((item: any) => item.name === "Fire Bolt").length],
      [true, 2]
    );
  });

  it("answers not_found for an id the actor does not have, and writes nothing of the call", async () => {
    await assert.rejects(
      change([{ name: "Trap Sense", type: "feat" }, { id: "nothingHere000001" }], { system: { details: { cr: 3 } } }),
      refused(
        "not_found",
        /^items\[1\]: Goblin has no item with the id nothingHere000001\. Nothing was written\. get_actor lists its items\.$/
      )
    );
    assert.deepEqual([sent(), world.log.actorUpdates.length, goblin.items.size], [[], 0, 5]);
  });

  it("refuses two entries that lead to one item, by id and by name or as two new items", async () => {
    const nimble = named(goblin, "Nimble Escape");
    await assert.rejects(
      change([
        { id: nimble.id, name: "Nimble Escape" },
        { name: "Nimble Escape", type: "feat" }
      ]),
      refused(
        "invalid_params",
        /^items\[0\] and items\[1\] lead to the same item\. Give it once, with all its changes\./
      )
    );
    await assert.rejects(
      change([
        { name: "Trap Sense", type: "feat" },
        { name: "Trap Sense", type: "feat" }
      ]),
      refused("invalid_params", /^items\[0\] and items\[1\] lead to the same item/)
    );
    assert.deepEqual(sent(), []);
  });

  const refusals: [string, Record<string, unknown>, RegExp][] = [
    [
      "a type the system does not have",
      { name: "Trap Sense", type: "trick" },
      /^items\[0\]: Unknown item type "trick"\. Use one of: weapon, feat, spell, class\./
    ],
    [
      "an unknown field",
      { name: "Nimble Escape", type: "feat", system: { typo: 1 } },
      /^items\[0\]: No such field: system\.typo\. get_schema with document Item and type feat lists the stored fields\./
    ],
    [
      "a value Foundry would store as something else, also inside an activity",
      {
        name: "Nimble Escape",
        type: "feat",
        system: { activities: { dodge: { type: "attack", attack: { flat: "yes" } } } }
      },
      /^items\[0\]: .*\.attack\.flat: "yes" would be stored as false\. Give each value as Foundry stores it\./
    ],
    [
      "data the item model refuses",
      { name: "Nimble Escape", type: "feat", system: { type: { value: true } } },
      /^items\[0\]: Foundry's item model refuses the data: .*system\.type\.value: must be a string/
    ],
    [
      "the bridge's own flag with another value",
      { name: "Nimble Escape", type: "feat", flags: { "foundry-mcp": { managed: false } } },
      /^items\[0\]: flags\.foundry-mcp cannot be given/
    ],
    [
      "an image that does not load",
      { name: "Nimble Escape", type: "feat", img: "art/missing.webp" },
      /^items\[0\]: The image art\/missing\.webp could not be loaded\./
    ],
    [
      "a path to remove that names a field",
      { name: "Nimble Escape", type: "feat", remove: ["system.type.value"] },
      /^items\[0\]: remove: Not an entry that can be removed: system\.type\.value\./
    ]
  ];
  for (const [label, entry, message] of refusals) {
    it(`refuses ${label} and writes nothing`, async () => {
      await assert.rejects(change([entry]), refused("invalid_params", message));
      assert.deepEqual(sent(), []);
    });
  }

  it("refuses another type for an item that exists", async () => {
    await assert.rejects(
      change([{ id: named(goblin, "Scimitar").id, type: "feat" }]),
      refused("invalid_params", /^items\[0\]: Scimitar is a weapon, and Foundry cannot change the type of an item\./)
    );
    assert.deepEqual(sent(), []);
  });

  it("takes the bridge's own flag while it equals the stored one, as get_actor returns it", async () => {
    const result = await change([{ name: "Nimble Escape", type: "feat", flags: { ...MANAGED, world: { note: "x" } } }]);
    assert.deepEqual(result.items[0].changed, ["flags.world.note"]);
    assert.deepEqual(named(goblin, "Nimble Escape")._source.flags, { ...MANAGED, world: { note: "x" } });
  });

  it("removes items by id, ignores ids the actor does not have, and counts what it removed", async () => {
    const [scimitar, nimble] = [named(goblin, "Scimitar").id, named(goblin, "Nimble Escape").id];
    const args = { actor: goblin.id, removeItems: [scimitar, "nothingHere000001", nimble, scimitar] };
    const result = await ensure(args);
    assert.deepEqual(sent(), [["delete", [scimitar, nimble]]]);
    assert.deepEqual([result.removedItems, goblin.items.size, "items" in result], [2, 3, false]);
    assert.deepEqual([(await ensure(args)).removedItems, sent().length], [0, 1]);
  });

  it("creates and changes before it removes, each kind in one request", async () => {
    const scimitar = named(goblin, "Scimitar").id;
    await change(
      [
        { name: "Trap Sense", type: "feat" },
        { name: "Nimble Escape", type: "feat", system: { type: { value: "class" } } },
        { name: "Sneak", type: "feat" }
      ],
      { removeItems: [scimitar] }
    );
    assert.deepEqual(
      world.log.embedded.map((write) => [write.action, write.data.length]),
      [
        ["create", 2],
        ["update", 1],
        ["delete", 1]
      ]
    );
  });

  it("refuses an item that the same call changes and removes", async () => {
    const nimble = named(goblin, "Nimble Escape").id;
    await assert.rejects(
      change([{ name: "Nimble Escape", type: "feat", system: { type: { value: "class" } } }], {
        removeItems: [nimble]
      }),
      refused(
        "invalid_params",
        new RegExp(
          `^items\\[0\\] \\(${nimble}\\): removeItems deletes the same item in this call\\. Do one of the two\\.`
        )
      )
    );
    assert.deepEqual([sent(), goblin.items.size], [[], 5]);
  });

  it("says from the stored data what was written when Foundry fails while updating the items", async () => {
    world.control.embeddedError = (action) => (action === "update" ? "socket closed" : undefined);
    const nimble = named(goblin, "Nimble Escape").id;
    await assert.rejects(
      change(
        [
          { name: "Trap Sense", type: "feat" },
          { name: "Nimble Escape", type: "feat", system: { type: { value: "class" } } }
        ],
        { name: "Goblin Boss" }
      ),
      refused(
        "foundry_error",
        new RegExp(
          `^Foundry failed while updating the items of Goblin Boss \\(socket closed\\)\\. Written before that, as the stored data shows: item Trap Sense \\(\\w{16}\\) created; item Nimble Escape \\(${nimble}\\) changed \\(system\\.type\\.value\\)\\. Running the call again writes what still differs\\. The actor's own data was changed before that \\(name\\)\\.$`
        )
      )
    );
  });
});

describe("ensure_actor copying an item", () => {
  let world: World;
  let goblin: any;
  let longsword: any;
  beforeEach(() => {
    world = fakeWorld();
    goblin = world.addActor({ name: "Goblin" });
    longsword = world.addPackItem("dnd5e.equipment24", {
      name: "Longsword",
      type: "weapon",
      folder: "f1",
      sort: 300,
      ownership: { default: 2 },
      system: {
        damage: { base: "1d8" },
        activities: { swing00000000001: { _id: "swing00000000001", type: "attack" } }
      },
      flags: { dnd5e: { riders: 1 } },
      effects: [{ _id: "sharpness0000001", name: "Sharp" }]
    });
    world.install();
  });
  const uuid = () => `Compendium.dnd5e.equipment24.Item.${longsword.id}`;
  const give = (entry: Record<string, unknown>) => ensure({ actor: goblin.id, items: [entry] });

  it("copies a compendium item with its effects, under the source's name, with the given data merged over it", async () => {
    const result = await give({
      from: uuid(),
      system: { damage: { base: "1d10" }, activities: { swing00000000001: { attack: { bonus: "1" } } } }
    });
    const [copy] = goblin.items.values();
    const { system, flags, effects, ownership, _stats } = copy._source;
    assert.deepEqual(
      [copy.name, copy.type, system.damage.base, flags, ownership, _stats.compendiumSource],
      ["Longsword", "weapon", "1d10", { dnd5e: { riders: 1 }, ...MANAGED }, { default: 0, user1: 3 }, uuid()]
    );
    assert.deepEqual(
      [system.activities.swing00000000001.type, system.activities.swing00000000001.attack.bonus],
      ["attack", "1"]
    );
    assert.deepEqual(
      effects.map((effect: any) => [effect._id, effect.name]),
      [["sharpness0000001", "Sharp"]]
    );
    assert.deepEqual(
      [copy.id === longsword.id, "folder" in world.log.embedded[0]!.data[0], "sort" in world.log.embedded[0]!.data[0]],
      [false, false, false]
    );
    assert.deepEqual(
      [result.items[0].created, result.items[0].changed.includes("system.damage.base"), result.items[0].unapplied],
      [true, true, []]
    );
  });

  it("does not copy again when it runs again, and writes only the given data that differs", async () => {
    await give({ from: uuid() });
    const [copy] = goblin.items.values();
    copy._source.system.damage.base = "2d6";
    const again = await give({ from: uuid() });
    assert.deepEqual([again.items[0].id, again.items[0].created, again.items[0].changed], [copy.id, false, []]);
    assert.deepEqual([goblin.items.size, copy._source.system.damage.base, world.log.embedded.length], [1, "2d6", 1]);
  });

  it("copies under another name, a world item, and an item of another actor", async () => {
    const world_item = world.addItem({ name: "Amulet", type: "weapon" });
    const owner = world.addActor({ name: "Owner", items: [{ name: "Dagger", type: "weapon" }] });
    const [dagger] = owner.items.values();
    const result = await ensure({
      actor: goblin.id,
      items: [
        { from: uuid(), name: "Heirloom" },
        { from: `Item.${world_item.id}` },
        { from: dagger.uuid, type: "weapon" }
      ]
    });
    assert.deepEqual(
      result.items.map((item: any) => [item.name, item.type, item.created]),
      [
        ["Heirloom", "weapon", true],
        ["Amulet", "weapon", true],
        ["Dagger", "weapon", true]
      ]
    );
    assert.equal(named(goblin, "Dagger")._source._stats?.compendiumSource, undefined);
  });

  it("changes an effect the copy brings and adds one, in the data the item is created from", async () => {
    const result = await give({
      from: uuid(),
      effects: [
        { _id: "sharpness0000001", disabled: true },
        { _id: "glow", name: "Glow" }
      ]
    });
    const [copy] = goblin.items.values();
    assert.deepEqual(
      copy._source.effects.map((effect: any) => [effect._id, effect.name, effect.disabled, effect.flags]),
      [
        ["sharpness0000001", "Sharp", true, {}],
        [idFromLabel("glow"), "Glow", false, MANAGED]
      ]
    );
    assert.deepEqual(result.items[0].effects, [
      { id: "sharpness0000001", name: "Sharp", created: false, changed: ["disabled"], unapplied: [] },
      { id: idFromLabel("glow"), name: "Glow", created: true, changed: ["name"], unapplied: [] }
    ]);
    assert.deepEqual(writes(world), [["create", "Item", `Actor.${goblin.id}`]]);
  });

  it("removes an entry and an effect of the copy as it is created", async () => {
    const result = await give({
      from: uuid(),
      remove: ["system.activities.swing00000000001"],
      removeEffects: ["sharpness0000001", "nothingHere000001"]
    });
    const [copy] = goblin.items.values();
    assert.deepEqual([copy._source.system.activities, copy._source.effects], [{}, []]);
    assert.deepEqual([result.items[0].removedEffects, world.log.embedded.length], [1, 1]);
  });

  it("refuses a type that is not the source's, a source that is not there or is no item, and from for an item that exists", async () => {
    const [owner] = [world.addActor({ name: "Owner" })];
    await assert.rejects(
      give({ from: uuid(), type: "feat" }),
      refused("invalid_params", /^items\[0\]: Compendium\.\S+ is a weapon, not a feat\./)
    );
    await assert.rejects(
      give({ from: "Compendium.dnd5e.equipment24.Item.nothing" }),
      refused("not_found", /^items\[0\]: Nothing exists at the UUID Compendium\.dnd5e\.equipment24\.Item\.nothing\./)
    );
    await assert.rejects(
      give({ from: `Actor.${owner.id}` }),
      refused("invalid_params", /^items\[0\]: The UUID Actor\.\w+ is a Actor, not an Item\./)
    );
    await give({ from: uuid() });
    const [copy] = goblin.items.values();
    await assert.rejects(
      give({ id: copy.id, from: uuid() }),
      refused("invalid_params", /^items\[0\]: from copies an item when a new one is created/)
    );
    assert.equal(world.log.embedded.length, 1);
  });
});

describe("ensure_actor copying an actor and giving it items in one call", () => {
  let world: World;
  let owlbear: any;
  beforeEach(() => {
    world = fakeWorld();
    owlbear = world.addPackActor("dnd5e.actors24", {
      name: "Owlbear",
      type: "npc",
      items: [
        { name: "Beak", type: "weapon", system: { damage: { base: "1d10" } } },
        { name: "Keen Sight", type: "feat", flags: MANAGED }
      ]
    });
    world.install();
  });
  const copy = (items: unknown[]) =>
    ensure({ name: "Old Owlbear", from: `Compendium.dnd5e.actors24.Actor.${owlbear.id}`, folder: ["Forest"], items });

  it("changes an item the copy brings by its id, takes a bridge-made one by its name, and adds a new one", async () => {
    const beak = named(owlbear, "Beak");
    const result = await copy([
      { id: beak.id, system: { damage: { base: "2d10" } } },
      { name: "Keen Sight", type: "feat", system: { type: { value: "monster" } } },
      { name: "Claws", type: "feat" }
    ]);
    const actor = only(world);
    assert.deepEqual(
      result.items.map((item: any) => [item.name, item.created, item.changed]),
      [
        ["Beak", false, ["system.damage.base"]],
        ["Keen Sight", false, ["system.type.value"]],
        ["Claws", true, ["name"]]
      ]
    );
    assert.deepEqual(
      [actor.items.size, named(actor, "Beak")._source.system.damage.base, beak._source.system.damage.base],
      [3, "2d10", "1d10"]
    );
  });

  it("refuses a name that an item of the source has which the bridge did not make, and creates no actor", async () => {
    await assert.rejects(
      copy([{ name: "Beak", type: "weapon", system: { damage: { base: "2d10" } } }]),
      refused("invalid_params", /^items\[0\]: Old Owlbear has a weapon named "Beak" that this bridge did not make/)
    );
    assert.deepEqual([world.actors.size, world.folders.size, world.log.embedded.length], [0, 0, 0]);
  });
});
