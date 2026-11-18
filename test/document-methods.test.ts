import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeWorld } from "./fake-world.ts";
import { MANAGED, refused, restoreGlobals, viaTool, type World } from "./token-world.ts";

afterEach(restoreGlobals);

const list = (args: Record<string, unknown>) => viaTool("list_documents", args);
const get = (uuid: string) => viaTool("get_document", { uuid });
const names = async (args: Record<string, unknown>) => (await list(args)).documents.map((one: any) => one.name);

describe("list_documents in the world", () => {
  let world: World;
  let lore: any;
  let gods: any;
  beforeEach(() => {
    world = fakeWorld();
    lore = world.addFolder("Lore", null, "JournalEntry");
    gods = world.addFolder("Gods", lore, "JournalEntry");
    world.addFolder("Monsters", null, "Actor");
    world.install();
  });

  it("lists the documents of a type with uuid, id, name, folder path and managed, and the folders of that type", async () => {
    const pelor = world.addDocument("JournalEntry", { name: "Pelor", folder: gods.id, flags: MANAGED });
    const rumours = world.addDocument("JournalEntry", { name: "Rumours" });
    const result = await list({ type: "JournalEntry" });
    assert.deepEqual(result, {
      folders: [
        { id: lore.id, path: ["Lore"] },
        { id: gods.id, path: ["Lore", "Gods"] }
      ],
      documents: [
        { uuid: `JournalEntry.${rumours.id}`, id: rumours.id, name: "Rumours", folder: [], managed: false },
        { uuid: `JournalEntry.${pelor.id}`, id: pelor.id, name: "Pelor", folder: ["Lore", "Gods"], managed: true }
      ],
      total: 2,
      truncated: false,
      packs: []
    });
  });

  it("sorts by folder path, then by name", async () => {
    world.addDocument("JournalEntry", { name: "Zeal", folder: lore.id });
    world.addDocument("JournalEntry", { name: "Asmodeus", folder: gods.id });
    world.addDocument("JournalEntry", { name: "Ages", folder: lore.id });
    world.addDocument("JournalEntry", { name: "Yonder" });
    assert.deepEqual(await names({ type: "JournalEntry" }), ["Yonder", "Ages", "Zeal", "Asmodeus"]);
  });

  it("narrows by folder and everything under it, and by part of the name in any case", async () => {
    world.addDocument("JournalEntry", { name: "The Old Gods", folder: gods.id });
    world.addDocument("JournalEntry", { name: "Old Roads", folder: lore.id });
    world.addDocument("JournalEntry", { name: "Shopping" });
    assert.deepEqual(await names({ type: "JournalEntry", folder: ["Lore"] }), ["Old Roads", "The Old Gods"]);
    assert.deepEqual(await names({ type: "JournalEntry", folder: ["Lore", "Gods"] }), ["The Old Gods"]);
    assert.deepEqual(await names({ type: "JournalEntry", name: "  oLD " }), ["Old Roads", "The Old Gods"]);
    const narrowed = await list({ type: "JournalEntry", folder: ["Lore", "Gods"] });
    assert.deepEqual(
      narrowed.folders.map((one: any) => one.path),
      [["Lore", "Gods"]]
    );
    await assert.rejects(
      list({ type: "JournalEntry", folder: ["Monsters"] }),
      refused("not_found", /No JournalEntry folder at path \["Monsters"\]/)
    );
  });

  it("names the subtype of a document that has subtypes, and narrows by it", async () => {
    world.addDocument("Macro", { name: "Roll", type: "script" });
    world.addDocument("Macro", { name: "Hello" });
    const result = await list({ type: "Macro" });
    assert.deepEqual(
      result.documents.map((one: any) => [one.name, one.type]),
      [
        ["Hello", "chat"],
        ["Roll", "script"]
      ]
    );
    assert.deepEqual(await names({ type: "Macro", subtype: "script" }), ["Roll"]);
    await assert.rejects(
      list({ type: "Macro", subtype: "spell" }),
      refused("invalid_params", /Unknown Macro type "spell"\. Use one of: chat, script\./)
    );
  });

  it("refuses a filter the documents of the type have nothing to match with, and says to leave it out", async () => {
    await assert.rejects(
      list({ type: "JournalEntry", subtype: "text" }),
      refused("invalid_params", /JournalEntry documents have no types\. Leave subtype out\./)
    );
    await assert.rejects(
      list({ type: "ChatMessage", name: "hello" }),
      refused("invalid_params", /ChatMessage documents have no name\. Leave name out\./)
    );
    await assert.rejects(
      list({ type: "User", folder: ["Lore"] }),
      refused("invalid_params", /User documents lie in no folder\. Leave folder out\./)
    );
  });

  it("returns at most 200 documents and says how many matched", async () => {
    for (let i = 0; i < 203; i++) world.addDocument("JournalEntry", { name: `Note ${String(i).padStart(3, "0")}` });
    const result = await list({ type: "JournalEntry" });
    assert.deepEqual([result.documents.length, result.total, result.truncated], [200, 203, true]);
    assert.equal(result.documents.at(-1).name, "Note 199");
  });

  it("lists chat messages by time, oldest first, without a name, and keeps the newest 200", async () => {
    const late = world.addDocument("ChatMessage", { content: "late", timestamp: 3000 });
    const early = world.addDocument("ChatMessage", { content: "early", timestamp: 1000, flags: MANAGED });
    const few = await list({ type: "ChatMessage" });
    assert.deepEqual(few.documents, [
      { uuid: `ChatMessage.${early.id}`, id: early.id, type: "base", managed: true },
      { uuid: `ChatMessage.${late.id}`, id: late.id, type: "base", managed: false }
    ]);
    assert.equal("folders" in few || "packs" in few, false);
    for (let i = 0; i < 200; i++) world.addDocument("ChatMessage", { timestamp: 2000 + i });
    const many = await list({ type: "ChatMessage" });
    assert.deepEqual([many.documents.length, many.total, many.truncated], [200, 202, true]);
    assert.deepEqual([many.documents[0].id === early.id, many.documents.at(-1).id], [false, late.id]);
  });

  it("lists users and settings, which have no folder and no pack, and a setting without name or flag", async () => {
    const user = world.addDocument("User", { name: "Ada", role: 1 });
    const setting = world.addDocument("Setting", { key: "core.time", value: "0" });
    assert.deepEqual(await list({ type: "User" }), {
      documents: [{ uuid: `User.${user.id}`, id: user.id, name: "Ada", managed: false }],
      total: 1,
      truncated: false
    });
    assert.deepEqual((await list({ type: "Setting" })).documents, [
      { uuid: `Setting.${setting.id}`, id: setting.id, managed: false }
    ]);
  });

  it("lists actors like any other type, and names the compendium packs of the type with their lock", async () => {
    const monsters = [...world.folders.values()].find((folder: any) => folder.name === "Monsters");
    const goblin = world.addActor({ name: "Goblin", type: "npc", folder: monsters.id, flags: MANAGED });
    world.addPackActor("dnd5e.monsters", { name: "Owlbear" });
    world.addPack("world.handouts", "JournalEntry", { title: "Handouts" });
    world.addPack("world.heroes", "Actor", { title: "Heroes" });
    const result = await list({ type: "Actor" });
    assert.deepEqual(result.documents, [
      { uuid: `Actor.${goblin.id}`, id: goblin.id, name: "Goblin", type: "npc", folder: ["Monsters"], managed: true }
    ]);
    assert.deepEqual(result.packs, [
      { id: "dnd5e.monsters", title: "dnd5e.monsters", locked: true },
      { id: "world.heroes", title: "Heroes", locked: false }
    ]);
  });

  it("refuses a type the world has no documents of, and says where they are", async () => {
    await assert.rejects(
      list({ type: "JournalEntryPage" }),
      refused(
        "invalid_params",
        /A world has no JournalEntryPage documents of its own\. Pass parent: the UUID of the JournalEntry that holds them\. Nothing was written\.$/
      )
    );
    await assert.rejects(
      list({ type: "Adventure" }),
      refused("invalid_params", /no Adventure documents of its own\. Pass pack: the id of a compendium pack of them\./)
    );
    await assert.rejects(
      list({ type: "Item", parent: "Actor.nobody" }),
      refused("not_found", /Nothing exists at the UUID Actor\.nobody/)
    );
  });

  it("refuses a document type this Foundry has no class for", async () => {
    await assert.rejects(
      list({ type: "RollTable" }),
      refused("invalid_params", /This Foundry has no document class for RollTable/)
    );
  });
});

describe("list_documents in a parent and in a compendium pack", () => {
  let world: World;
  let entry: any;
  beforeEach(() => {
    world = fakeWorld();
    world.install();
    entry = world.addDocument("JournalEntry", {
      name: "Lore",
      pages: [
        { name: "Zin", type: "image" },
        { name: "The Old Gods", flags: MANAGED }
      ]
    });
  });

  it("lists the embedded documents of a parent, by name, with their subtype and without a folder", async () => {
    const [zin, gods] = [...entry.pages.values()];
    const result = await list({ type: "JournalEntryPage", parent: entry.uuid });
    assert.deepEqual(result, {
      documents: [
        {
          uuid: `${entry.uuid}.JournalEntryPage.${gods.id}`,
          id: gods.id,
          name: "The Old Gods",
          type: "text",
          managed: true
        },
        { uuid: `${entry.uuid}.JournalEntryPage.${zin.id}`, id: zin.id, name: "Zin", type: "image", managed: false }
      ],
      total: 2,
      truncated: false
    });
    assert.deepEqual(await names({ type: "JournalEntryPage", parent: entry.uuid, subtype: "image" }), ["Zin"]);
  });

  it("lists the items of an actor through its UUID", async () => {
    const goblin = world.addActor({ name: "Goblin", items: [{ name: "Scimitar", type: "weapon" }] });
    const [scimitar] = [...goblin.items.values()];
    const result = await list({ type: "Item", parent: `Actor.${goblin.id}` });
    assert.deepEqual(result.documents, [
      {
        uuid: `Actor.${goblin.id}.Item.${scimitar.id}`,
        id: scimitar.id,
        name: "Scimitar",
        type: "weapon",
        managed: false
      }
    ]);
  });

  it("refuses a parent that holds no documents of the type, naming what it holds and where the type is found", async () => {
    await assert.rejects(
      list({ type: "PlaylistSound", parent: entry.uuid }),
      refused(
        "invalid_params",
        /is a JournalEntry, which holds no PlaylistSound documents\. It holds: JournalEntryCategory, JournalEntryPage\. For PlaylistSound pass parent: the UUID of the Playlist that holds them\./
      )
    );
    const [page] = [...entry.pages.values()];
    await assert.rejects(
      list({ type: "JournalEntry", parent: page.uuid }),
      refused("invalid_params", /It holds no embedded documents\. For JournalEntry pass pack/)
    );
    await assert.rejects(
      list({ type: "JournalEntryPage", parent: entry.uuid, folder: ["Lore"] }),
      refused("invalid_params", /JournalEntryPage documents lie in no folder/)
    );
    await assert.rejects(
      list({ type: "Item", parent: entry.uuid, pack: "dnd5e.items" }),
      refused("invalid_params", /Give parent or pack, not both/)
    );
  });

  it("lists a pack from its index with the pack's own folders, and loads none of its documents", async () => {
    world.addPack("world.handouts", "JournalEntry", { title: "Handouts" });
    const maps = world.addPackFolder("world.handouts", "JournalEntry", "Maps");
    const cellar = world.addDocument(
      "JournalEntry",
      { name: "Cellar", folder: maps.id, flags: MANAGED },
      { pack: "world.handouts" }
    );
    const letter = world.addDocument(
      "JournalEntry",
      { name: "Letter", pages: [{ name: "Page" }] },
      { pack: "world.handouts" }
    );
    const result = await list({ type: "JournalEntry", pack: "world.handouts" });
    assert.deepEqual(result, {
      folders: [{ id: maps.id, path: ["Maps"] }],
      documents: [
        {
          uuid: `Compendium.world.handouts.JournalEntry.${letter.id}`,
          id: letter.id,
          name: "Letter",
          folder: [],
          managed: false
        },
        {
          uuid: `Compendium.world.handouts.JournalEntry.${cellar.id}`,
          id: cellar.id,
          name: "Cellar",
          folder: ["Maps"],
          managed: true
        }
      ],
      total: 2,
      truncated: false,
      packs: [{ id: "world.handouts", title: "Handouts", locked: false }]
    });
    assert.deepEqual(world.log.packLoads, []);
    assert.equal(world.log.packIndexes.length, 1);
    assert.deepEqual(await names({ type: "JournalEntry", pack: "world.handouts", folder: ["Maps"] }), ["Cellar"]);
  });

  it("asks the index for the subtype of a typed document, which the index of its class may leave out", async () => {
    world.addDocument("Macro", { name: "Roll", type: "script" }, { pack: "world.macros" });
    const result = await list({ type: "Macro", pack: "world.macros", subtype: "script" });
    assert.deepEqual(
      result.documents.map((one: any) => [one.name, one.type]),
      [["Roll", "script"]]
    );
  });

  it("lists the documents inside a compendium document through its UUID as parent", async () => {
    const letter = world.addDocument(
      "JournalEntry",
      { name: "Letter", pages: [{ name: "Page" }] },
      { pack: "world.handouts" }
    );
    assert.deepEqual(await names({ type: "JournalEntryPage", parent: letter.uuid }), ["Page"]);
  });

  it("refuses a pack that is not there, naming the packs of the type, and a pack of another type", async () => {
    world.addPack("world.handouts", "JournalEntry");
    await assert.rejects(
      list({ type: "JournalEntry", pack: "world.lore" }),
      refused(
        "not_found",
        /No compendium pack with the id world\.lore\. The packs of JournalEntry documents: world\.handouts\./
      )
    );
    await assert.rejects(
      list({ type: "Macro", pack: "world.lore" }),
      refused("not_found", /This world has no pack of Macro documents\./)
    );
    await assert.rejects(
      list({ type: "Macro", pack: "world.handouts" }),
      refused(
        "invalid_params",
        /The pack world\.handouts holds JournalEntry documents, not Macro\. Pass type JournalEntry/
      )
    );
  });
});

describe("get_document", () => {
  let world: World;
  beforeEach(() => {
    world = fakeWorld();
    world.install();
  });

  it("returns what the document is, its stored data without the embedded documents, and those as short lists", async () => {
    const lore = world.addFolder("Lore", null, "JournalEntry");
    const entry = world.addDocument("JournalEntry", {
      name: "Pelor",
      folder: lore.id,
      flags: { ...MANAGED, world: { note: "x" } },
      pages: [{ name: "Dogma", text: { content: "<p>Light</p>" } }]
    });
    const [page] = [...entry.pages.values()];
    assert.deepEqual(await get(entry.uuid), {
      uuid: `JournalEntry.${entry.id}`,
      documentName: "JournalEntry",
      id: entry.id,
      name: "Pelor",
      parent: null,
      pack: null,
      folder: ["Lore"],
      managed: true,
      data: {
        _id: entry.id,
        name: "Pelor",
        folder: lore.id,
        sort: 0,
        ownership: { default: 0 },
        flags: { ...MANAGED, world: { note: "x" } }
      },
      embedded: {
        JournalEntryCategory: [],
        JournalEntryPage: [{ uuid: page.uuid, id: page.id, name: "Dogma", type: "text" }]
      }
    });
  });

  it("reads an embedded document by its own UUID, with its parent and its subtype", async () => {
    const entry = world.addDocument("JournalEntry", {
      name: "Pelor",
      pages: [{ name: "Dogma", text: { content: "<p>Light</p>" } }]
    });
    const [page] = [...entry.pages.values()];
    const result = await get(page.uuid);
    assert.deepEqual(
      [
        result.documentName,
        result.type,
        result.parent,
        result.pack,
        "folder" in result,
        result.managed,
        result.embedded
      ],
      ["JournalEntryPage", "text", entry.uuid, null, false, false, {}]
    );
    assert.deepEqual([result.data.name, result.data.text], ["Dogma", { content: "<p>Light</p>", format: 1 }]);
  });

  it("loads a compendium document, and says which pack it lies in, whether that is locked, and its folder there", async () => {
    world.addPack("dnd5e.rules", "JournalEntry");
    const chapters = world.addPackFolder("dnd5e.rules", "JournalEntry", "Chapters");
    const rules = world.addDocument("JournalEntry", { name: "Combat", folder: chapters.id }, { pack: "dnd5e.rules" });
    const result = await get(`Compendium.dnd5e.rules.JournalEntry.${rules.id}`);
    assert.deepEqual(
      [result.uuid, result.pack, result.locked, result.folder, result.parent],
      [rules.uuid, "dnd5e.rules", true, ["Chapters"], null]
    );
    assert.deepEqual(world.log.packLoads, [`dnd5e.rules.${rules.id}`]);
  });

  it("never returns the password or the salt of a user, whatever the stored data holds", async () => {
    const user = world.addDocument("User", { name: "Ada", role: 2 });
    Object.assign(user._source, { password: "a-hash", passwordSalt: "a-salt" });
    const result = await get(user.uuid);
    assert.deepEqual(Object.keys(result.data).sort(), ["_id", "color", "flags", "name", "role"]);
    assert.equal(JSON.stringify(result).includes("a-hash") || JSON.stringify(result).includes("a-salt"), false);
  });

  it("reads a world setting as it is stored", async () => {
    const setting = world.addDocument("Setting", { key: "core.time", value: "42" });
    const result = await get(setting.uuid);
    assert.deepEqual(
      [result.documentName, result.managed, result.data],
      ["Setting", false, { _id: setting.id, key: "core.time", value: "42" }]
    );
  });

  it("reads an actor like any other document: its own data, and its items and effects by UUID", async () => {
    const folder = world.addFolder("Monsters", null, "Actor");
    const goblin = world.addActor({
      name: "Goblin",
      type: "npc",
      folder: folder.id,
      system: { details: { cr: 0.25 } },
      items: [{ name: "Scimitar", type: "weapon" }],
      effects: [{ name: "Poisoned" }]
    });
    const [scimitar] = [...goblin.items.values()];
    const [poisoned] = [...goblin.effects.values()];
    const result = await get(`Actor.${goblin.id}`);
    assert.deepEqual([result.documentName, result.type, result.folder], ["Actor", "npc", ["Monsters"]]);
    assert.deepEqual(
      [result.data.system, "items" in result.data, "effects" in result.data],
      [{ details: { cr: 0.25 } }, false, false]
    );
    assert.deepEqual(result.embedded, {
      ActiveEffect: [
        { uuid: `Actor.${goblin.id}.ActiveEffect.${poisoned.id}`, id: poisoned.id, name: "Poisoned", type: "base" }
      ],
      Item: [{ uuid: `Actor.${goblin.id}.Item.${scimitar.id}`, id: scimitar.id, name: "Scimitar", type: "weapon" }]
    });
  });

  it("reads an adventure with the documents it holds, each checked by its own type, and takes them back unchanged", async () => {
    const adventure = world.addDocument(
      "Adventure",
      {
        name: "Lost Mine",
        actors: [
          { name: "Goblin", type: "npc", system: { details: { cr: 0.25 } }, items: [{ name: "Bite", type: "feat" }] }
        ],
        scenes: [{ name: "Cave", regions: [{ name: "Pit", behaviors: [{ type: "pauseGame" }] }] }]
      },
      { pack: "world.adventures" }
    );
    const result = await get(adventure.uuid);
    assert.deepEqual([result.documentName, result.pack, result.embedded], ["Adventure", "world.adventures", {}]);
    assert.deepEqual(
      [result.data.actors[0].name, result.data.actors[0].system, result.data.actors[0].items],
      ["Goblin", { details: { cr: 0.25 } }, [{ name: "Bite", type: "feat" }]]
    );
    assert.deepEqual(result.data.scenes[0].regions, [{ name: "Pit", behaviors: [{ type: "pauseGame" }] }]);
    const taken = await viaTool("update_documents", { documents: [{ uuid: adventure.uuid, data: result.data }] });
    assert.deepEqual(taken.documents, [{ uuid: adventure.uuid, changed: [], unapplied: [] }]);
    assert.deepEqual(world.log.documentWrites, []);
  });

  it("lists at most 200 embedded documents of a type, and says how many there are", async () => {
    const pages = Array.from({ length: 203 }, (_, i) => ({ name: `Page ${i}` }));
    const entry = world.addDocument("JournalEntry", { name: "Long", pages });
    const result = await get(entry.uuid);
    assert.deepEqual(
      [result.embedded.JournalEntryPage.length, result.embeddedTotals],
      [200, { JournalEntryPage: 203 }]
    );
    assert.equal("embeddedTotals" in (await get([...entry.pages.values()][0].uuid)), false);
  });

  it("answers not_found for a UUID nothing exists at, and for one Foundry cannot read", async () => {
    await assert.rejects(
      get("JournalEntry.nobody"),
      refused("not_found", /Nothing exists at the UUID JournalEntry\.nobody\. list_documents/)
    );
    await assert.rejects(get("Compendium.world.none.JournalEntry.x"), refused("not_found"));
    await assert.rejects(get("Broken.parse"), refused("not_found", /Nothing exists at the UUID Broken\.parse/));
  });
});
