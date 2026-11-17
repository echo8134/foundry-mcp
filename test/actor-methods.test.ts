import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MethodError } from "../module/scripts/errors.mjs";
import { METHODS } from "../module/scripts/methods.mjs";
import { TOOLS } from "../src/tools.ts";
import { fakeWorld } from "./fake-world.ts";

type Name = "list_actors" | "get_actor" | "get_schema";
const viaTool = (name: Name, args: unknown) =>
  (METHODS as unknown as Record<Name, (params: any) => Promise<any>>)[name](TOOLS[name].input.parse(args));

const globals = globalThis as Record<string, unknown>;
const saved = {
  game: globals.game,
  canvas: globals.canvas,
  foundry: globals.foundry,
  CONST: globals.CONST,
  CONFIG: globals.CONFIG
};
afterEach(() => {
  Object.assign(globals, saved);
});

const refused = (code: string, message?: RegExp) => (error: unknown) =>
  error instanceof MethodError && error.code === code && (message?.test(error.message) ?? true);

const managedFlag = { "foundry-mcp": { managed: true } };

describe("list_actors", () => {
  let world: ReturnType<typeof fakeWorld>;
  let monsters: any;
  let drow: any;
  beforeEach(() => {
    world = fakeWorld();
    monsters = world.addFolder("Monsters", null, "Actor");
    drow = world.addFolder("Drow", monsters, "Actor");
    world.addFolder("Maps", null, "Scene");
    world.install();
  });

  it("lists actor folders and actors with folder path, type and managed, cr for an npc and level for a character", async () => {
    const priestess = world.addActor({
      name: "Priestess",
      type: "npc",
      folder: drow.id,
      system: { details: { cr: 8 } },
      flags: managedFlag
    });
    const hero = world.addActor({
      name: "Hero",
      type: "character",
      system: { details: {} },
      prepared: { details: { level: 5, cr: 3 } }
    });
    const cart = world.addActor({ name: "Cart", type: "vehicle", system: { details: { cr: 1 } } });
    const result = await viaTool("list_actors", {});
    assert.deepEqual(result.folders, [
      { id: monsters.id, path: ["Monsters"] },
      { id: drow.id, path: ["Monsters", "Drow"] }
    ]);
    assert.deepEqual(result.actors, [
      { id: cart.id, name: "Cart", type: "vehicle", folder: [], managed: false },
      { id: hero.id, name: "Hero", type: "character", folder: [], managed: false, level: 5 },
      { id: priestess.id, name: "Priestess", type: "npc", folder: ["Monsters", "Drow"], managed: true, cr: 8 }
    ]);
    assert.deepEqual([result.total, result.truncated], [3, false]);
  });

  it("leaves cr out for an npc whose challenge rating is not a number", async () => {
    world.addActor({ name: "Commoner", type: "npc", system: { details: { cr: null } } });
    const [actor] = (await viaTool("list_actors", {})).actors;
    assert.equal("cr" in actor, false);
  });

  it("sorts by folder path, then by name", async () => {
    world.addActor({ name: "Zombie", folder: monsters.id });
    world.addActor({ name: "Archer", folder: drow.id });
    world.addActor({ name: "Bandit", folder: monsters.id });
    world.addActor({ name: "Yeti" });
    const names = (await viaTool("list_actors", {})).actors.map((a: any) => a.name);
    assert.deepEqual(names, ["Yeti", "Bandit", "Zombie", "Archer"]);
  });

  it("narrows by folder and everything under it, by type, and by part of the name in any case", async () => {
    world.addActor({ name: "Drow Elite Warrior", type: "npc", folder: drow.id });
    world.addActor({ name: "Drow Mage", type: "npc", folder: drow.id });
    world.addActor({ name: "Goblin", type: "npc", folder: monsters.id });
    world.addActor({ name: "Drow Ranger", type: "character" });
    const names = async (args: object) => (await viaTool("list_actors", args)).actors.map((a: any) => a.name);
    assert.deepEqual(await names({ folder: ["Monsters"] }), ["Goblin", "Drow Elite Warrior", "Drow Mage"]);
    assert.deepEqual(await names({ folder: ["Monsters", "Drow"] }), ["Drow Elite Warrior", "Drow Mage"]);
    assert.deepEqual(await names({ type: "character" }), ["Drow Ranger"]);
    assert.deepEqual(await names({ name: "  dROW  " }), ["Drow Ranger", "Drow Elite Warrior", "Drow Mage"]);
    assert.deepEqual(await names({ name: "mage", type: "npc", folder: ["Monsters"] }), ["Drow Mage"]);
    const narrowed = await viaTool("list_actors", { folder: ["Monsters", "Drow"] });
    assert.deepEqual(
      narrowed.folders.map((f: any) => f.path),
      [["Monsters", "Drow"]]
    );
  });

  it("refuses a folder path that does not exist, and an actor type the system does not have, naming the valid ones", async () => {
    await assert.rejects(viaTool("list_actors", { folder: ["Maps"] }), refused("not_found", /Maps/));
    await assert.rejects(
      viaTool("list_actors", { type: "monster" }),
      refused("invalid_params", /"monster".*character, npc, vehicle, group\.$/)
    );
    await assert.rejects(viaTool("list_actors", { type: "base" }), refused("invalid_params"));
  });

  it("returns at most 200 actors and says how many matched", async () => {
    for (let i = 0; i < 205; i++) world.addActor({ name: `Kobold ${String(i).padStart(3, "0")}` });
    const result = await viaTool("list_actors", {});
    assert.deepEqual([result.actors.length, result.total, result.truncated], [200, 205, true]);
    assert.equal(result.actors.at(-1).name, "Kobold 199");
  });
});

describe("get_actor", () => {
  let world: ReturnType<typeof fakeWorld>;
  let scene: any;
  let other: any;
  let goblin: any;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar" });
    other = world.addScene({ name: "Road" });
    const folder = world.addFolder("Monsters", null, "Actor");
    goblin = world.addActor({
      name: "Goblin",
      type: "npc",
      img: "goblin.webp",
      folder: folder.id,
      flags: managedFlag,
      system: { attributes: { hp: { value: 7, max: 7 }, ac: { flat: 15, calc: "flat" } }, details: { cr: 0.25 } },
      prepared: {
        attributes: { hp: { value: 7, max: 7, temp: 0 }, ac: { flat: 15, calc: "flat", value: 15 }, prof: 2 },
        details: { cr: 0.25, xp: { value: 50 } },
        abilities: { dex: { value: 14, mod: 2, save: { value: 2 } } }
      },
      items: [
        { name: "Scimitar", type: "weapon", system: { damage: { base: { number: 1, denomination: 6 } } } },
        { name: "Nimble Escape", type: "feat", flags: managedFlag }
      ],
      effects: [{ name: "Poisoned", disabled: true }]
    });
    world.install();
  });

  it("returns the stored data, the derived numbers, short lists of items and effects, and the placed tokens", async () => {
    const linked = world.addToken(scene, { name: "Goblin Boss", actorId: goblin.id, actorLink: true });
    const unlinked = world.addToken(other, { name: "Goblin", actorId: goblin.id });
    world.addToken(other, { name: "Someone else" });
    const [scimitar, nimble] = goblin.items.values();
    const [poisoned] = goblin.effects.values();
    const result = await viaTool("get_actor", { actor: goblin.id });
    assert.deepEqual(result, {
      id: goblin.id,
      uuid: `Actor.${goblin.id}`,
      name: "Goblin",
      type: "npc",
      img: "goblin.webp",
      folder: ["Monsters"],
      managed: true,
      system: { attributes: { hp: { value: 7, max: 7 }, ac: { flat: 15 } }, details: { cr: 0.25 } },
      prototypeToken: { name: "Goblin", actorLink: false },
      ownership: { default: 0 },
      derived: {
        ac: 15,
        hp: { value: 7, max: 7, temp: 0 },
        prof: 2,
        xp: 50,
        abilities: { dex: { mod: 2, save: 2 } }
      },
      items: [
        { id: scimitar.id, name: "Scimitar", type: "weapon", managed: false },
        { id: nimble.id, name: "Nimble Escape", type: "feat", managed: true }
      ],
      itemData: [],
      effects: [{ id: poisoned.id, name: "Poisoned", disabled: true }],
      effectData: [],
      tokens: [
        { sceneId: scene.id, sceneName: "Cellar", tokenId: linked.id, name: "Goblin Boss" },
        { sceneId: other.id, sceneName: "Road", tokenId: unlinked.id, name: "Goblin" }
      ]
    });
  });

  it("leaves out a stored key the model would not store again, and returns the other values as they are stored", async () => {
    const airship = world.addActor({
      name: "Airship",
      type: "vehicle",
      system: { attributes: { hp: { value: 300, max: 300 }, ac: { flat: 13, override: null, calc: "flat" } } }
    });
    const result = await viaTool("get_actor", { actor: airship.id });
    assert.deepEqual(result.system, { attributes: { hp: { value: 300, max: 300 }, ac: { flat: 13, override: null } } });
    assert.deepEqual(airship._source.system.attributes.ac, { flat: 13, override: null, calc: "flat" });
  });

  it("reads an actor whose stored data the model would refuse, as it is stored", async () => {
    const broken = world.addActor({ name: "Broken", type: "npc", system: { details: { cr: "high" } } });
    const result = await viaTool("get_actor", { actor: broken.id });
    assert.deepEqual(result.system, { details: { cr: "high" } });
  });

  it("returns the full stored data of the items asked for, and refuses an id the actor does not have", async () => {
    const [scimitar] = goblin.items.values();
    const result = await viaTool("get_actor", { actor: goblin.id, items: [scimitar.id] });
    assert.deepEqual(result.itemData, [
      {
        _id: scimitar.id,
        name: "Scimitar",
        type: "weapon",
        system: { damage: { base: { number: 1, denomination: 6 } } },
        effects: [],
        flags: {}
      }
    ]);
    await assert.rejects(
      viaTool("get_actor", { actor: goblin.id, items: [scimitar.id, "ghost", "phantom"] }),
      refused("not_found", /Goblin has no item with the id ghost, phantom/)
    );
  });

  it("finds the same world actor by its UUID", async () => {
    const byId = await viaTool("get_actor", { actor: goblin.id });
    assert.deepEqual(await viaTool("get_actor", { actor: `Actor.${goblin.id}` }), byId);
  });

  it("reads an unlinked token's actor: the base actor merged with the token's changes, and only that token", async () => {
    const token = world.addToken(scene, {
      name: "Wounded Goblin",
      actorId: goblin.id,
      delta: { name: "Wounded Goblin", system: { attributes: { hp: { value: 2 } } } }
    });
    const uuid = `${scene.uuid}.Token.${token.id}.Actor.${goblin.id}`;
    const result = await viaTool("get_actor", { actor: uuid });
    assert.deepEqual(
      [result.uuid, result.name, result.folder, result.system.attributes.hp, result.derived.hp],
      [uuid, "Wounded Goblin", [], { value: 2, max: 7 }, { value: 2, max: 7, temp: 0 }]
    );
    assert.deepEqual(result.tokens, [
      { sceneId: scene.id, sceneName: "Cellar", tokenId: token.id, name: "Wounded Goblin" }
    ]);
  });

  it("reads a compendium actor, with no folder path and no tokens", async () => {
    const owlbear = world.addPackActor("dnd5e.monsters", {
      name: "Owlbear",
      type: "npc",
      folder: world.addFolder("Beasts", null, "Actor").id,
      system: { details: { cr: 3 } }
    });
    const result = await viaTool("get_actor", { actor: `Compendium.dnd5e.monsters.Actor.${owlbear.id}` });
    assert.deepEqual(
      [result.id, result.name, result.uuid, result.folder, result.tokens, result.system],
      [owlbear.id, "Owlbear", `Compendium.dnd5e.monsters.Actor.${owlbear.id}`, [], [], { details: { cr: 3 } }]
    );
  });

  it("answers not_found for an id or UUID that leads nowhere, and invalid_params for a UUID of another document", async () => {
    await assert.rejects(
      viaTool("get_actor", { actor: "nobody" }),
      refused("not_found", /No world actor with id nobody/)
    );
    await assert.rejects(viaTool("get_actor", { actor: "Actor.nobody" }), refused("not_found", /Actor\.nobody/));
    await assert.rejects(
      viaTool("get_actor", { actor: "Broken.unexpected input" }),
      refused("not_found", /could not resolve the UUID Broken\.unexpected input: unexpected input/)
    );
    const [scimitar] = goblin.items.values();
    await assert.rejects(
      viaTool("get_actor", { actor: scimitar.uuid }),
      refused("invalid_params", /is a Item, not an Actor/)
    );
  });
});

describe("get_schema", () => {
  beforeEach(() => {
    fakeWorld().install();
  });

  it("lists the types of each typed document, keeping base only where the system models it", async () => {
    const types = async (document: string) => (await viaTool("get_schema", { document })).types;
    assert.deepEqual(await types("Actor"), ["character", "npc", "vehicle", "group"]);
    assert.deepEqual(await types("Item"), ["weapon", "feat", "spell", "class"]);
    assert.deepEqual(await types("ActiveEffect"), ["base", "enchantment"]);
    assert.deepEqual(await types("Activity"), ["attack", "save", "cast", "heal"]);
    assert.deepEqual(await types("Advancement"), ["HitPoints"]);
  });

  it("opens an advancement type with the models of its configuration and value, where the type has them", async () => {
    const { fields } = await viaTool("get_schema", { document: "Advancement", type: "HitPoints" });
    assert.deepEqual(fields, { level: "integer, min 0", configuration: "object", value: { hint: "string" } });
  });

  it("returns the field tree of a type with its system expanded, collections named and derived fields left out", async () => {
    const { fields } = await viaTool("get_schema", { document: "Actor", type: "character" });
    assert.deepEqual(Object.keys(fields), [
      "_id",
      "name",
      "type",
      "img",
      "system",
      "prototypeToken",
      "items",
      "effects",
      "folder",
      "ownership",
      "flags",
      "_stats"
    ]);
    assert.deepEqual(
      [fields.items, fields.effects, fields.folder, fields.ownership, fields.flags],
      ["collection of Item", "collection of ActiveEffect", "id of Folder, nullable", "object", { $map: "object" }]
    );
    assert.deepEqual(fields.prototypeToken, {
      name: 'string, default ""',
      actorLink: "boolean, default false",
      flags: { $map: "object" }
    });
    assert.deepEqual(fields.system.abilities, { $map: { value: "integer, min 0, default 10" }, $keys: ["str", "dex"] });
    assert.deepEqual(fields.system.details, {}, "a character's level is derived, not stored");
    const npc = await viaTool("get_schema", { document: "Actor", type: "npc" });
    assert.deepEqual(npc.fields.system.details, {
      cr: "number, min 0, nullable, default 1",
      biography: { value: 'html, default ""', public: 'html, default ""' }
    });
  });

  it("returns the tree of an item type, an activity type and the token", async () => {
    const weapon = await viaTool("get_schema", { document: "Item", type: "weapon" });
    assert.deepEqual(weapon.fields.system, { damage: { base: "formula" }, activities: "collection of Activity" });
    const heal = await viaTool("get_schema", { document: "Activity", type: "heal" });
    assert.deepEqual(heal.fields, { healing: {} });
    const attack = await viaTool("get_schema", { document: "Activity", type: "attack", path: "attack" });
    assert.deepEqual(attack.fields, { bonus: 'formula, default ""', flat: "boolean, default false" });
    const token = await viaTool("get_schema", { document: "Token" });
    const radius = "number, min 0, step 0.01, default 0";
    assert.deepEqual(token.fields, {
      _id: "document id, nullable, default null",
      name: 'string, default ""',
      actorId: "document id, nullable, default null",
      actorLink: "boolean, default false",
      delta: "object",
      x: "integer, default 0",
      y: "integer, default 0",
      elevation: "number, default 0",
      width: "number, positive, default 1",
      height: "number, positive, default 1",
      depth: "number, min 0, default 1",
      shape: "integer, one of 0|1|2|3|4|5, default 4",
      level: "document id",
      sort: "integer, default 0",
      rotation: "number, default 0",
      hidden: "boolean, default false",
      disposition: "integer, one of -2|-1|0|1, default -1",
      texture: { src: 'file path, nullable, default "icons/svg/mystery-man.svg"' },
      light: { dim: radius, bright: radius, color: "color, nullable, default null" },
      detectionModes: {
        $map: { enabled: "boolean, default true", range: "number, min 0, step 0.01, nullable, default null" }
      },
      flags: { $map: "object" },
      _movementHistory: { $array: "object" },
      _regions: { $array: "document id" }
    });
  });

  it("picks a subtree by path, and answers not_found for a path that is not there", async () => {
    const { fields } = await viaTool("get_schema", { document: "Actor", type: "npc", path: "system.attributes.hp" });
    assert.deepEqual(Object.keys(fields), ["value", "max", "temp"]);
    const leaf = await viaTool("get_schema", { document: "Actor", type: "npc", path: "system.abilities.str.value" });
    assert.equal(leaf.fields, "integer, min 0, default 10");
    await assert.rejects(
      viaTool("get_schema", { document: "Actor", type: "npc", path: "system.attributes.spellcasting" }),
      refused("not_found", /system\.attributes\.spellcasting in the npc Actor/)
    );
  });

  it("refuses an unknown type naming the valid ones, a type for the token, and a path where there is no tree", async () => {
    await assert.rejects(
      viaTool("get_schema", { document: "Item", type: "sword" }),
      refused("invalid_params", /"sword".*weapon, feat, spell/)
    );
    await assert.rejects(viaTool("get_schema", { document: "Actor", type: "base" }), refused("invalid_params"));
    await assert.rejects(
      viaTool("get_schema", { document: "Token", type: "npc" }),
      refused("invalid_params", /no types/)
    );
    await assert.rejects(
      viaTool("get_schema", { document: "Actor", path: "system" }),
      refused("invalid_params", /Pass type to get a field tree/)
    );
    assert.throws(() => TOOLS.get_schema.input.parse({ document: "Scene" }));
  });

  it("refuses a document the module does not know, also one that names an inherited property", async () => {
    const direct = (METHODS as unknown as Record<string, (params: any) => Promise<any>>).get_schema!;
    await assert.rejects(
      direct({ document: "constructor" }),
      refused("invalid_params", /"constructor".*Actor, Item, ActiveEffect, Token, Activity, Advancement, Config/)
    );
  });

  it("lists the dnd5e key tables, returns a table's keys with their labels, and refuses a table not on the list", async () => {
    const { types } = await viaTool("get_schema", { document: "Config" });
    assert.ok(types.includes("abilities") && types.includes("toolIds") && types.includes("currencies"), types);
    assert.deepEqual(await viaTool("get_schema", { document: "Config", type: "languages" }), {
      keys: { standard: { label: "Standard", children: { common: "Common", elvish: "Elvish" } }, cant: "Thieves' Cant" }
    });
    await assert.rejects(
      viaTool("get_schema", { document: "Config", type: "activityTypes" }),
      refused("invalid_params", /"activityTypes"/)
    );
    await assert.rejects(
      viaTool("get_schema", { document: "Config", type: "abilities", path: "str" }),
      refused("invalid_params", /Leave path out/)
    );
  });

  it("reports a listed table that the installed dnd5e does not have as a Foundry error", async () => {
    await assert.rejects(
      viaTool("get_schema", { document: "Config", type: "habitats" }),
      refused("foundry_error", /CONFIG\.DND5E\.habitats/)
    );
  });
});
