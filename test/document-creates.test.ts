import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeWorld } from "./fake-world.ts";
import { MANAGED, refused, restoreGlobals, viaTool, type World } from "./token-world.ts";

afterEach(restoreGlobals);

const create = (args: Record<string, unknown>) => viaTool("create_documents", args);
const inWorld = (type: string): any[] => [...(globalThis as any).game.collections.get(type).values()];
const writes = (world: World) => world.log.documentWrites.map((write) => `${write.action} ${write.document}`);
const NOT_WRITTEN = /Nothing was written\.$/;

describe("create_documents", () => {
  let world: World;
  beforeEach(() => {
    world = fakeWorld({ unloadable: ["icons/missing.webp"] });
    world.install();
  });

  it("creates a journal entry with its pages in one call, flags all of them as bridge-made and says what it made", async () => {
    const lore = world.addFolder("Lore", null, "JournalEntry");
    const result = await create({
      type: "JournalEntry",
      documents: [
        {
          name: "Pelor",
          folder: lore.id,
          flags: { world: { note: "x" } },
          pages: [
            { name: "Dogma", text: { content: "<p>Light</p>" } },
            { name: "Symbol", type: "image", src: "sun.webp" }
          ]
        }
      ]
    });
    const [entry] = inWorld("JournalEntry");
    const pages = [...entry.pages.values()];
    assert.deepEqual(result, {
      requested: 1,
      created: 1,
      documents: [{ uuid: `JournalEntry.${entry.id}`, id: entry.id, name: "Pelor", unapplied: [] }]
    });
    assert.deepEqual(
      [entry.name, entry.folder.name, entry._source.flags],
      ["Pelor", "Lore", { world: { note: "x" }, ...MANAGED }]
    );
    assert.deepEqual(
      pages.map((page: any) => [page.name, page.type, page._source.text.content, page._source.src, page._source.flags]),
      [
        ["Dogma", "text", "<p>Light</p>", null, MANAGED],
        ["Symbol", "image", "", "sun.webp", MANAGED]
      ]
    );
    assert.deepEqual(writes(world), ["create JournalEntry"]);
  });

  it("creates embedded documents in a parent, each with the subtype it names or the one Foundry fills in", async () => {
    const entry = world.addDocument("JournalEntry", { name: "Pelor" });
    const result = await create({
      type: "JournalEntryPage",
      parent: entry.uuid,
      documents: [{ name: "Dogma" }, { name: "Rule", type: "rule", system: { tooltip: "<p>Tip</p>" } }]
    });
    const [dogma, rule] = [...entry.pages.values()];
    assert.deepEqual(result.documents, [
      { uuid: `${entry.uuid}.JournalEntryPage.${dogma.id}`, id: dogma.id, name: "Dogma", type: "text", unapplied: [] },
      { uuid: `${entry.uuid}.JournalEntryPage.${rule.id}`, id: rule.id, name: "Rule", type: "rule", unapplied: [] }
    ]);
    assert.deepEqual([rule._source.system, rule._source.flags], [{ tooltip: "<p>Tip</p>" }, MANAGED]);
  });

  it("creates in an unlocked compendium pack, and in a document that lies in one", async () => {
    world.addPack("world.handouts", "JournalEntry");
    const result = await create({ type: "JournalEntry", pack: "world.handouts", documents: [{ name: "Letter" }] });
    const [letter] = [...world.packs.get("world.handouts").documents.values()];
    assert.deepEqual(result.documents, [
      { uuid: `Compendium.world.handouts.JournalEntry.${letter.id}`, id: letter.id, name: "Letter", unapplied: [] }
    ]);
    const paged = await create({ type: "JournalEntryPage", parent: letter.uuid, documents: [{ name: "Page" }] });
    assert.equal(paged.documents[0].uuid, `${letter.uuid}.JournalEntryPage.${[...letter.pages.values()][0].id}`);
    assert.equal(inWorld("JournalEntry").length, 0);
  });

  it("refuses a locked pack, and a parent that lies in one, and says who unlocks it", async () => {
    const rules = world.addDocument("JournalEntry", { name: "Combat" }, { pack: "dnd5e.rules" });
    await assert.rejects(
      create({ type: "JournalEntry", pack: "dnd5e.rules", documents: [{ name: "Mine" }] }),
      refused(
        "invalid_params",
        /The new documents would lie in the compendium pack dnd5e\.rules \(dnd5e\.rules\), which is locked\. The Gamemaster unlocks a pack in Foundry.*Toggle Edit Lock\. Nothing was written\.$/
      )
    );
    await assert.rejects(
      create({ type: "JournalEntryPage", parent: rules.uuid, documents: [{ name: "Page" }] }),
      refused("invalid_params", /lies in the compendium pack dnd5e\.rules.*which is locked/)
    );
    world.packs.get("dnd5e.rules").config.locked = false;
    assert.equal(
      (await create({ type: "JournalEntry", pack: "dnd5e.rules", documents: [{ name: "Mine" }] })).created,
      1
    );
  });

  it("refuses a place that cannot hold the type, with what to pass instead", async () => {
    const entry = world.addDocument("JournalEntry", { name: "Pelor" });
    world.addPack("world.handouts", "JournalEntry");
    const refusals: [Record<string, unknown>, RegExp][] = [
      [
        { type: "JournalEntryPage" },
        /A world has no JournalEntryPage documents of its own\. Pass parent: the UUID of the JournalEntry/
      ],
      [{ type: "Adventure" }, /no Adventure documents of its own\. Pass pack/],
      [{ type: "PlaylistSound", parent: entry.uuid }, /is a JournalEntry, which holds no PlaylistSound documents/],
      [{ type: "Macro", pack: "world.handouts" }, /holds JournalEntry documents, not Macro/],
      [{ type: "JournalEntry", parent: entry.uuid, pack: "world.handouts" }, /Give parent or pack, not both/]
    ];
    for (const [target, message] of refusals) {
      await assert.rejects(create({ ...target, documents: [{ name: "X" }] }), refused("invalid_params", message));
    }
    await assert.rejects(
      create({ type: "JournalEntryPage", parent: "JournalEntry.nobody", documents: [{ name: "X" }] }),
      refused("not_found", /Nothing exists at the UUID JournalEntry\.nobody\. Nothing was written\./)
    );
    assert.deepEqual(writes(world), []);
  });

  it("needs a subtype where Foundry fills none in, and refuses one the type does not have, naming its subtypes", async () => {
    await assert.rejects(
      create({ type: "Folder", documents: [{ name: "Lore" }] }),
      refused(
        "invalid_params",
        /documents\[0\]: A new Folder needs a type, one of ActiveEffect, Actor, Adventure, Item.*get_schema with document Folder/
      )
    );
    await assert.rejects(
      create({ type: "Macro", documents: [{ name: "Roll", type: "spell" }] }),
      refused(
        "invalid_params",
        /documents\[0\]: Unknown Macro type "spell"\. Use one of: chat, script\. Nothing was written\.$/
      )
    );
    const made = await create({ type: "Folder", documents: [{ name: "Lore", type: "JournalEntry" }] });
    assert.deepEqual([made.documents[0].name, made.documents[0].type], ["Lore", "JournalEntry"]);
  });

  const refusals: [string, string, Record<string, unknown>, RegExp][] = [
    [
      "an unknown field",
      "JournalEntry",
      { name: "A", colour: "red" },
      /No such field: colour\. get_schema with document JournalEntry lists/
    ],
    [
      "an unknown field of an embedded document",
      "JournalEntry",
      { name: "A", pages: [{ name: "P" }, { name: "Q", text: { contnet: "x" } }] },
      /No such field: pages\.1\.text\.contnet\./
    ],
    [
      "system data of an embedded document whose subtype has no data model",
      "JournalEntry",
      { name: "A", pages: [{ name: "P", system: { tooltip: "x" } }] },
      /pages\.0\.system: the type text has no data model to check it against/
    ],
    [
      "a key Foundry would read as an instruction",
      "JournalEntry",
      { name: "A", flags: { "-=world": null } },
      /Not a plain key/
    ],
    [
      "the bridge's own flag with another value",
      "JournalEntry",
      { name: "A", flags: { "foundry-mcp": { managed: false } } },
      /flags\.foundry-mcp cannot be given: it is the bridge's own flag/
    ],
    [
      "the bridge's own flag with another value on an embedded document",
      "JournalEntry",
      { name: "A", pages: [{ name: "P", flags: { "foundry-mcp": { managed: true, more: 1 } } }] },
      /pages\.0\.flags\.foundry-mcp cannot be given/
    ],
    [
      "data Foundry's model refuses",
      "JournalEntry",
      { folder: null },
      /Foundry's JournalEntry model refuses the data: .*name/
    ],
    [
      "an embedded document Foundry's model refuses",
      "JournalEntry",
      { name: "A", pages: [{ text: { content: "nameless" } }] },
      /Foundry's JournalEntry model refuses the data: .*pages: 0: .*name/
    ],
    [
      "a value Foundry would store as another",
      "JournalEntry",
      { name: "A", sort: "5" },
      /sort: "5" would be stored as 5/
    ],
    [
      "a value of an embedded document Foundry would store as another",
      "Playlist",
      { name: "A", sounds: [{ name: "Fire", volume: 0.555 }] },
      /sounds\.0\.volume: 0\.555 would be stored as 0\.56/
    ],
    [
      "an image that does not load",
      "Macro",
      { name: "Roll", img: "icons/missing.webp" },
      /The image icons\/missing\.webp could not be loaded/
    ]
  ];
  for (const [label, type, data, message] of refusals) {
    it(`refuses ${label}, names the entry, and creates none of the documents of the call`, async () => {
      await assert.rejects(
        create({ type, documents: [{ name: "Fine" }, data] }),
        (error: unknown) =>
          refused("invalid_params", message)(error) &&
          /^documents\[1\]: /.test((error as Error).message) &&
          NOT_WRITTEN.test((error as Error).message)
      );
      assert.deepEqual([writes(world), inWorld(type).length], [[], 0]);
    });
  }

  it("takes the data get_document returns to make a copy, and reports the id Foundry gave in place of the given one", async () => {
    const source = world.addDocument("JournalEntry", {
      name: "Pelor",
      flags: MANAGED,
      pages: [{ name: "Dogma", flags: MANAGED }]
    });
    const read = await viaTool("get_document", { uuid: source.uuid });
    const page = await viaTool("get_document", { uuid: [...source.pages.values()][0].uuid });
    const result = await create({
      type: "JournalEntry",
      documents: [{ ...read.data, name: "Pelor again", pages: [page.data] }]
    });
    const copy = inWorld("JournalEntry").find((entry: any) => entry.name === "Pelor again");
    assert.notEqual(copy.id, source.id);
    assert.deepEqual(result.documents[0].unapplied, ["_id"]);
    assert.deepEqual(
      [...copy.pages.values()].map((one: any) => [one.name, one._source.flags]),
      [["Dogma", MANAGED]]
    );
  });

  it("stores HTML as the server spells it and does not call that a difference", async () => {
    const result = await create({
      type: "JournalEntry",
      documents: [{ name: "Pelor", pages: [{ name: "Dogma", text: { content: "<p class='creed'>Light<br /></p>" } }] }]
    });
    const [page] = [...inWorld("JournalEntry")[0].pages.values()];
    assert.notEqual(page._source.text.content, "<p class='creed'>Light<br /></p>");
    assert.deepEqual(result.documents[0].unapplied, []);
  });

  it("names the given fields that a hook or the system stored otherwise, also inside an embedded document", async () => {
    world.control.filterDocumentData = (_name, source) => {
      source.sort = 100;
      source.pages[1].name = "Renamed";
    };
    const result = await create({
      type: "JournalEntry",
      documents: [{ name: "Pelor", sort: 5, pages: [{ name: "One" }, { name: "Two" }] }]
    });
    assert.deepEqual(result.documents[0].unapplied, ["sort", "pages.1.name"]);
  });

  it("gives an entry Foundry created nothing for an error in place of its uuid, and creates the others", async () => {
    world.control.vetoDocument = (_name, data) => data.name === "Forbidden";
    const result = await create({
      type: "JournalEntry",
      documents: [{ name: "One" }, { name: "Forbidden" }, { name: "Three" }]
    });
    assert.deepEqual([result.requested, result.created], [3, 2]);
    assert.deepEqual(
      result.documents.map((one: any) => [one.name, typeof one.uuid, one.error?.slice(0, 44)]),
      [
        ["One", "string", undefined],
        ["Forbidden", "undefined", "foundry_error: Foundry created nothing for t"],
        ["Three", "string", undefined]
      ]
    );
    assert.deepEqual(
      inWorld("JournalEntry").map((entry: any) => entry.name),
      ["One", "Three"]
    );
  });

  it("stops at an entry Foundry fails on, and names it and the documents created before it", async () => {
    world.control.documentError = (_action, _name, data) => (data?.name === "Two" ? "socket closed" : undefined);
    const call = create({ type: "JournalEntry", documents: [{ name: "One" }, { name: "Two" }, { name: "Three" }] });
    await assert.rejects(call, (error: unknown) => {
      const [one] = inWorld("JournalEntry");
      return refused(
        "foundry_error",
        new RegExp(
          `^documents\\[1\\]: Foundry failed while creating the JournalEntry \\(socket closed\\)\\. Created before it, and left in place: JournalEntry\\.${one.id}\\. The entries after it were not tried\\.`
        )
      )(error);
    });
    assert.deepEqual(
      inWorld("JournalEntry").map((entry: any) => entry.name),
      ["One"]
    );
  });

  it("posts a chat message, which has no name", async () => {
    const result = await create({
      type: "ChatMessage",
      documents: [{ content: "<p>The door creaks.</p>", speaker: { alias: "Narrator" } }]
    });
    const [message] = inWorld("ChatMessage");
    assert.deepEqual(result.documents, [
      { uuid: `ChatMessage.${message.id}`, id: message.id, type: "base", unapplied: [] }
    ]);
    assert.deepEqual([message._source.content, message._source.flags], ["<p>The door creaks.</p>", MANAGED]);
  });

  it("creates a user only with a password that is not blank, hands it to Foundry and does not report it as lost", async () => {
    for (const password of [undefined, "", "   ", 5]) {
      await assert.rejects(
        create({ type: "User", documents: [{ name: "Ada", ...(password !== undefined && { password }) }] }),
        refused(
          "invalid_params",
          /documents\[0\]: A new user needs a password that is not blank\. The join page of a Foundry server can be reached by anyone/
        )
      );
    }
    await assert.rejects(
      create({ type: "User", documents: [{ name: "Ada", password: " padded " }] }),
      refused("invalid_params", /may not begin or end with a space/)
    );
    await assert.rejects(
      create({ type: "User", documents: [{ name: "Ada", password: "s3cret", passwordSalt: "pepper" }] }),
      refused("invalid_params", /passwordSalt cannot be given/)
    );
    assert.deepEqual(writes(world), []);
    const result = await create({ type: "User", documents: [{ name: "Ada", role: 1, password: "s3cret" }] });
    const [user] = inWorld("User");
    assert.deepEqual(result.documents, [{ uuid: `User.${user.id}`, id: user.id, name: "Ada", unapplied: [] }]);
    assert.equal(world.log.documentWrites[0]!.data[0].password, "s3cret");
    assert.deepEqual([user._source.password, user._source.flags], ["", MANAGED]);
    assert.equal(JSON.stringify(result).includes("s3cret"), false);
  });

  it("writes no Setting and no ActorDelta, and says what does instead", async () => {
    await assert.rejects(
      create({ type: "Setting", documents: [{ key: "core.time", value: "1" }] }),
      refused(
        "invalid_params",
        /These tools write no Setting\. A world setting is a registered value with a type and a change handler.*Nothing was written\.$/
      )
    );
    const scene = world.addScene({ name: "Cellar" });
    const token = world.addToken(scene, { name: "Goblin" });
    await assert.rejects(
      create({ type: "ActorDelta", parent: `${scene.uuid}.Token.${token.id}`, documents: [{ name: "Own" }] }),
      refused("invalid_params", /These tools write no ActorDelta.*ensure_actor/)
    );
    assert.deepEqual(writes(world), []);
  });
});
