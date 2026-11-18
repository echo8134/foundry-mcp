import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeWorld } from "./fake-world.ts";
import { MANAGED, refused, restoreGlobals, viaTool, type World } from "./token-world.ts";

afterEach(restoreGlobals);

const update = (...documents: Record<string, unknown>[]) => viaTool("update_documents", { documents });
const remove = (uuids: string[], handMade?: true) =>
  viaTool("delete_documents", { uuids, ...(handMade && { handMade }) });
const get = (uuid: string) => viaTool("get_document", { uuid });
const inWorld = (type: string): any[] => [...(globalThis as any).game.collections.get(type).values()];
const writes = (world: World) => world.log.documentWrites.map((write) => `${write.action} ${write.document}`);
const NOT_WRITTEN = /Nothing was written\.$/;

describe("update_documents", () => {
  let world: World;
  let entry: any;
  let page: any;
  beforeEach(() => {
    world = fakeWorld({ unloadable: ["icons/missing.webp"] });
    world.install();
    entry = world.addDocument("JournalEntry", {
      name: "Pelor",
      sort: 3,
      flags: { world: { note: "x", keep: 1 } },
      pages: [{ name: "Dogma", text: { content: "<p>Light</p>" } }]
    });
    [page] = [...entry.pages.values()];
  });

  it("writes only the fields whose value differs, on a document made by hand too, and says what changed", async () => {
    const result = await update({
      uuid: entry.uuid,
      data: { name: "Pelor the Shining", sort: 3, flags: { world: { note: "y" } } }
    });
    assert.deepEqual(result, {
      documents: [{ uuid: entry.uuid, changed: ["name", "flags.world.note"], unapplied: [] }]
    });
    assert.deepEqual(world.log.documentWrites[0]!.data, [
      { name: "Pelor the Shining", flags: { world: { note: "y" } } }
    ]);
    assert.deepEqual(
      [entry.name, entry._source.sort, entry._source.flags],
      ["Pelor the Shining", 3, { world: { note: "y", keep: 1 } }]
    );
  });

  it("writes nothing when the same call runs again", async () => {
    const change = { uuid: entry.uuid, data: { name: "Pelor the Shining" } };
    await update(change);
    const again = await update(change);
    assert.deepEqual(again.documents, [{ uuid: entry.uuid, changed: [], unapplied: [] }]);
    assert.deepEqual(writes(world), ["update JournalEntry"]);
  });

  it("writes nothing for data read with get_document and passed back unchanged, bridge-made or not", async () => {
    const made = world.addDocument("JournalEntry", {
      name: "Made",
      flags: MANAGED,
      pages: [{ name: "Typed", type: "image" }]
    });
    const [typed] = [...made.pages.values()];
    for (const uuid of [entry.uuid, page.uuid, made.uuid, typed.uuid]) {
      const { data } = await get(uuid);
      const result = await update({ uuid, data });
      assert.deepEqual(result.documents, [{ uuid, changed: [], unapplied: [] }], uuid);
    }
    assert.deepEqual(writes(world), []);
  });

  it("changes an embedded document by its own UUID, and compares its HTML by what it says", async () => {
    const change = { uuid: page.uuid, data: { text: { content: "<p class='creed'>Warm<br /></p>" } } };
    const result = await update(change);
    assert.deepEqual(result.documents, [{ uuid: page.uuid, changed: ["text.content"], unapplied: [] }]);
    assert.notEqual(page._source.text.content, change.data.text.content);
    assert.deepEqual((await update(change)).documents[0].changed, []);
    assert.deepEqual(writes(world), ["update JournalEntryPage"]);
  });

  it("removes entries by dot path, ignores a path that has no entry, and refuses a path that is given a value too", async () => {
    const result = await update({ uuid: entry.uuid, remove: ["flags.world.note", "flags.world.gone"] });
    assert.deepEqual(result.documents, [{ uuid: entry.uuid, changed: ["flags.world.note"], unapplied: [] }]);
    assert.deepEqual(entry._source.flags, { world: { keep: 1 } });
    assert.deepEqual((await update({ uuid: entry.uuid, remove: ["flags.world.note"] })).documents[0].changed, []);
    await assert.rejects(
      update({ uuid: entry.uuid, data: { flags: { world: { keep: 2 } } }, remove: ["flags.world.keep"] }),
      refused("invalid_params", /flags\.world\.keep is named in remove and given a value/)
    );
    await assert.rejects(
      update({ uuid: entry.uuid, remove: ["name"] }),
      refused("invalid_params", /Not an entry that can be removed: name/)
    );
  });

  it("changes several documents in one call, each once", async () => {
    const other = world.addDocument("JournalEntry", { name: "Heironeous" });
    const result = await update({ uuid: other.uuid, data: { sort: 9 } }, { uuid: page.uuid, data: { name: "Creed" } });
    assert.deepEqual(result.documents, [
      { uuid: other.uuid, changed: ["sort"], unapplied: [] },
      { uuid: page.uuid, changed: ["name"], unapplied: [] }
    ]);
    await assert.rejects(
      update({ uuid: other.uuid, data: { sort: 1 } }, { uuid: other.uuid, data: { name: "Twice" } }),
      refused(
        "invalid_params",
        /documents\[0\] and documents\[1\] are the same document.*Give it once, with all its changes/
      )
    );
    assert.equal(other._source.sort, 9);
  });

  const refusals: [string, Record<string, unknown>, RegExp][] = [
    [
      "an unknown field",
      { data: { colour: "red" } },
      /No such field: colour\. get_schema with document JournalEntry lists/
    ],
    [
      "the embedded documents inside the data",
      { data: { name: "A", pages: [{ name: "New" }] } },
      /pages cannot be given: it holds the embedded documents of the JournalEntry.*Change one with this tool by its UUID, create one with create_documents and JournalEntry\.\w+ as parent, and delete one with delete_documents/
    ],
    ["another id", { data: { _id: "other00000000000" } }, /_id: Foundry cannot change the id of a document/],
    ["a value Foundry would store as another", { data: { sort: "5" } }, /sort: "5" would be stored as 5/],
    ["data Foundry's model refuses", { data: { name: null } }, /Foundry's JournalEntry model refuses the data/],
    [
      "the bridge's own flag",
      { data: { flags: { "foundry-mcp": { managed: true } } } },
      /flags\.foundry-mcp cannot be given: it is the bridge's own flag/
    ],
    [
      "the removal of the bridge's own flag",
      { remove: ["flags.foundry-mcp"] },
      /flags\.foundry-mcp is the bridge's own flag, which stays/
    ]
  ];
  for (const [label, change, message] of refusals) {
    it(`refuses ${label}, names the entry, and writes none of the changes of the call`, async () => {
      await assert.rejects(
        update({ uuid: page.uuid, data: { name: "Fine" } }, { uuid: entry.uuid, ...change }),
        (error: unknown) =>
          refused("invalid_params", message)(error) &&
          /^documents\[1\]: /.test((error as Error).message) &&
          NOT_WRITTEN.test((error as Error).message)
      );
      assert.deepEqual([writes(world), page.name], [[], "Dogma"]);
    });
  }

  it("refuses a UUID nothing exists at, another subtype and an image that does not load", async () => {
    await assert.rejects(
      update({ uuid: page.uuid, data: { name: "Fine" } }, { uuid: "JournalEntry.nobody", data: { name: "X" } }),
      refused("not_found", /^documents\[1\]: Nothing exists at the UUID JournalEntry\.nobody\. Nothing was written\./)
    );
    await assert.rejects(
      update({ uuid: page.uuid, data: { type: "image" } }),
      refused(
        "invalid_params",
        /is of the type text, and Foundry cannot change the type of a document\. Leave type out, or create another JournalEntryPage/
      )
    );
    const macro = world.addDocument("Macro", { name: "Roll" });
    await assert.rejects(
      update({ uuid: macro.uuid, data: { img: "icons/missing.webp" } }),
      refused("invalid_params", /The image icons\/missing\.webp could not be loaded/)
    );
    assert.deepEqual(
      (await update({ uuid: macro.uuid, data: { img: "icons/svg/dice-target.svg" } })).documents[0].changed,
      []
    );
    assert.deepEqual(writes(world), []);
  });

  it("refuses a document in a locked pack, and changes one in a pack that is unlocked", async () => {
    const rules = world.addDocument(
      "JournalEntry",
      { name: "Combat", pages: [{ name: "Actions" }] },
      { pack: "dnd5e.rules" }
    );
    const [actions] = [...rules.pages.values()];
    for (const uuid of [rules.uuid, actions.uuid]) {
      await assert.rejects(
        update({ uuid, data: { name: "Mine" } }),
        refused(
          "invalid_params",
          /lies in the compendium pack dnd5e\.rules \(dnd5e\.rules\), which is locked\. The Gamemaster unlocks/
        )
      );
    }
    assert.deepEqual(writes(world), []);
    const letter = world.addDocument("JournalEntry", { name: "Letter" }, { pack: "world.handouts" });
    assert.deepEqual((await update({ uuid: letter.uuid, data: { name: "Sealed letter" } })).documents[0].changed, [
      "name"
    ]);
    assert.equal(letter.name, "Sealed letter");
  });

  it("names a change that a hook refused or changed as unapplied", async () => {
    world.control.vetoDocumentUpdate = () => true;
    const refusedByHook = await update({ uuid: entry.uuid, data: { name: "Blocked", sort: 8 } });
    assert.deepEqual(refusedByHook.documents, [{ uuid: entry.uuid, changed: [], unapplied: ["name", "sort"] }]);
    world.control.vetoDocumentUpdate = null;
    world.control.filterDocumentChanges = (_name, changes) => {
      changes.sort = 100;
    };
    const changedByHook = await update({ uuid: entry.uuid, data: { name: "Through", sort: 8 } });
    assert.deepEqual(changedByHook.documents, [{ uuid: entry.uuid, changed: ["name", "sort"], unapplied: ["sort"] }]);
  });

  it("says what the stored data shows when Foundry fails on an entry, and does not try the entries after it", async () => {
    const other = world.addDocument("JournalEntry", { name: "Heironeous" });
    world.control.documentError = (action, name) =>
      action === "update" && name === "JournalEntryPage" ? "socket closed" : undefined;
    await assert.rejects(
      update(
        { uuid: entry.uuid, data: { sort: 8 } },
        { uuid: page.uuid, data: { name: "Creed" } },
        { uuid: other.uuid, data: { sort: 1 } }
      ),
      (error: unknown) =>
        refused(
          "foundry_error",
          /^documents\[1\]: Foundry failed while updating \S+ \(socket closed\)\. Changed in the stored data: JournalEntry\.\w+ \(sort\); \S+ \(name\)\. Running the call again writes what still differs\.$/
        )(error)
    );
    assert.equal(other._source.sort, 0);
  });

  describe("on a user", () => {
    let ada: any;
    beforeEach(() => {
      world.addDocument("User", { _id: "user1", name: "Gamemaster", role: 4 });
      ada = world.addDocument("User", { name: "Ada", role: 1 });
    });

    it("sets a password on every call that gives one, reports it as changed and never as lost", async () => {
      const change = { uuid: ada.uuid, data: { password: "s3cret", role: 2 } };
      const first = await update(change);
      assert.deepEqual(first.documents, [{ uuid: ada.uuid, changed: ["role", "password"], unapplied: [] }]);
      assert.deepEqual((await update(change)).documents, [{ uuid: ada.uuid, changed: ["password"], unapplied: [] }]);
      assert.deepEqual(
        world.log.documentWrites.map((write) => write.data[0]),
        [{ password: "s3cret", role: 2 }, { password: "s3cret" }]
      );
      assert.equal(JSON.stringify(first).includes("s3cret"), false);
    });

    it("reports a password a hook refused as unapplied", async () => {
      world.control.vetoDocumentUpdate = () => true;
      const result = await update({ uuid: ada.uuid, data: { password: "s3cret" } });
      assert.deepEqual(result.documents, [{ uuid: ada.uuid, changed: [], unapplied: ["password"] }]);
    });

    it("refuses a blank or padded password, its removal, and a salt", async () => {
      const refusedChanges: [Record<string, unknown>, RegExp][] = [
        [
          { data: { password: "" } },
          /The password of Ada cannot be removed or made blank\. The join page.*Give another password, or leave password out/
        ],
        [{ data: { password: "  " } }, /cannot be removed or made blank/],
        [{ data: { password: null } }, /cannot be removed or made blank/],
        [{ remove: ["password"] }, /cannot be removed or made blank/],
        [{ data: { password: "s3cret " } }, /may not begin or end with a space/],
        [{ data: { passwordSalt: "pepper" } }, /passwordSalt cannot be given/]
      ];
      for (const [change, message] of refusedChanges) {
        await assert.rejects(update({ uuid: ada.uuid, ...change }), refused("invalid_params", message));
      }
      assert.deepEqual(writes(world), []);
    });

    it("does not change the role or the password of the user the bridge works as, and changes its other data", async () => {
      for (const data of [{ role: 3 }, { password: "s3cret" }]) {
        await assert.rejects(
          update({ uuid: "User.user1", data }),
          refused(
            "invalid_params",
            /Gamemaster is the user this bridge works as, and Foundry logs a user out when its (role|password) changes/
          )
        );
      }
      const result = await update({ uuid: "User.user1", data: { color: "#112233" } });
      assert.deepEqual(result.documents[0].changed, ["color"]);
    });
  });

  it("writes no Setting, and sends a token's own actor to ensure_actor", async () => {
    const setting = world.addDocument("Setting", { key: "core.time", value: "1" });
    await assert.rejects(
      update({ uuid: setting.uuid, data: { value: "2" } }),
      refused("invalid_params", /^documents\[0\]: These tools write no Setting/)
    );
    const scene = world.addScene({ name: "Cellar" });
    const goblin = world.addActor({ name: "Goblin" });
    const token = world.addToken(scene, { name: "Goblin", actorId: goblin.id });
    const uuid = `${scene.uuid}.Token.${token.id}.Actor.${goblin.id}`;
    await assert.rejects(
      update({ uuid, data: { name: "Wounded" } }),
      refused("invalid_params", /is the actor of a token.*change it with ensure_actor, by the same UUID as actor/)
    );
    assert.deepEqual(
      [setting._source.value, world.log.actorUpdates.length, world.log.tokenUpdates.length],
      ["1", 0, 0]
    );
  });

  it("takes back an actor whose prototype token carries the bridge's flag, as Foundry's Assign Token leaves it", async () => {
    const goblin = world.addActor({
      name: "Goblin",
      flags: MANAGED,
      prototypeToken: { name: "Goblin", actorLink: false, flags: MANAGED }
    });
    const { data } = await get(`Actor.${goblin.id}`);
    assert.deepEqual(data.prototypeToken.flags, MANAGED);
    assert.deepEqual((await update({ uuid: `Actor.${goblin.id}`, data })).documents[0], {
      uuid: `Actor.${goblin.id}`,
      changed: [],
      unapplied: []
    });
    await assert.rejects(
      update({
        uuid: `Actor.${goblin.id}`,
        data: { prototypeToken: { flags: { "foundry-mcp": { managed: false } } } }
      }),
      refused("invalid_params", /prototypeToken\.flags\.foundry-mcp cannot be given/)
    );
    assert.equal(world.log.actorUpdates.length, 0);
  });

  it("changes a scene's own data, and sends its walls to their own UUIDs", async () => {
    const scene = world.addScene({ name: "Cellar" });
    world.addWall(scene);
    const result = await update({ uuid: scene.uuid, data: { name: "Wine cellar", navName: "Cellar" } });
    assert.deepEqual(result.documents, [{ uuid: scene.uuid, changed: ["name", "navName"], unapplied: [] }]);
    assert.deepEqual([scene.name, scene.navName, world.log.sceneUpdates], ["Wine cellar", "Cellar", 1]);
    await assert.rejects(
      update({ uuid: scene.uuid, data: { name: "Vault", walls: [{ c: [0, 0, 100, 0] }] } }),
      refused(
        "invalid_params",
        /walls cannot be given: it holds the embedded documents of the Scene, which each have a UUID of their own.*Nothing was written\.$/
      )
    );
    assert.deepEqual([scene.name, scene.walls.size, world.log.sceneUpdates], ["Wine cellar", 1, 1]);
  });

  it("changes a world actor like any other document", async () => {
    const goblin = world.addActor({ name: "Goblin", type: "npc", system: { details: { cr: 1 } } });
    const result = await update({ uuid: `Actor.${goblin.id}`, data: { system: { details: { cr: 2 } } } });
    assert.deepEqual(result.documents, [{ uuid: `Actor.${goblin.id}`, changed: ["system.details.cr"], unapplied: [] }]);
    assert.equal(goblin._source.system.details.cr, 2);
  });
});

describe("delete_documents", () => {
  let world: World;
  beforeEach(() => {
    world = fakeWorld();
    world.install();
  });

  it("deletes bridge-made documents, names them, and ignores a UUID nothing exists at, so that a retry is safe", async () => {
    const pelor = world.addDocument("JournalEntry", { name: "Pelor", flags: MANAGED });
    const roll = world.addDocument("Macro", { name: "Roll", flags: MANAGED });
    const uuids = [pelor.uuid, "JournalEntry.nobody", roll.uuid, "Broken.parse", pelor.uuid];
    assert.deepEqual(await remove(uuids), {
      deleted: 2,
      documents: [
        { uuid: pelor.uuid, name: "Pelor" },
        { uuid: roll.uuid, name: "Roll" }
      ]
    });
    assert.deepEqual([inWorld("JournalEntry").length, inWorld("Macro").length], [0, 0]);
    assert.deepEqual(await remove(uuids), { deleted: 0, documents: [] });
    assert.deepEqual(writes(world), ["delete JournalEntry", "delete Macro"]);
  });

  it("deletes a document nobody flagged only with handMade, and without it refuses the whole call and names it", async () => {
    const made = world.addDocument("JournalEntry", { name: "Made", flags: MANAGED });
    const byHand = world.addDocument("JournalEntry", { name: "By hand" });
    await assert.rejects(
      remove([made.uuid, byHand.uuid]),
      refused(
        "invalid_params",
        new RegExp(
          `^These documents were not made by this bridge: By hand \\(${byHand.uuid.replace(".", "\\.")}\\)\\. Foundry cannot bring a deleted document back\\. Pass handMade: true to delete them as well\\. Nothing was written\\.$`
        )
      )
    );
    assert.deepEqual([inWorld("JournalEntry").length, writes(world)], [2, []]);
    assert.equal((await remove([made.uuid, byHand.uuid], true)).deleted, 2);
    assert.equal(inWorld("JournalEntry").length, 0);
  });

  it("leaves out a document whose parent is deleted in the same call, which takes it along", async () => {
    const entry = world.addDocument("JournalEntry", { name: "Pelor", flags: MANAGED, pages: [{ name: "By hand" }] });
    const [page] = [...entry.pages.values()];
    const result = await remove([page.uuid, entry.uuid]);
    assert.deepEqual(result, { deleted: 1, documents: [{ uuid: entry.uuid, name: "Pelor" }] });
    assert.deepEqual(writes(world), ["delete JournalEntry"]);
  });

  it("deletes embedded documents by their own UUIDs, those of one parent in one request", async () => {
    const flagged = { flags: MANAGED };
    const one = world.addDocument("JournalEntry", {
      name: "One",
      pages: [{ name: "A", ...flagged }, { name: "B", ...flagged }, { name: "C" }]
    });
    const two = world.addDocument("JournalEntry", { name: "Two", pages: [{ name: "D", ...flagged }] });
    const [a, b] = [...one.pages.values()];
    const [d] = [...two.pages.values()];
    const result = await remove([a.uuid, d.uuid, b.uuid]);
    assert.deepEqual(
      result.documents.map((gone: any) => gone.name),
      ["A", "B", "D"]
    );
    assert.deepEqual(
      world.log.documentWrites.map((write) => [write.parent, write.data.length]),
      [
        [one.uuid, 2],
        [two.uuid, 1]
      ]
    );
    assert.deepEqual(
      [...one.pages.values()].map((left: any) => left.name),
      ["C"]
    );
  });

  it("refuses a document in a locked pack, and deletes one in a pack that is unlocked", async () => {
    const rules = world.addDocument("JournalEntry", { name: "Combat", flags: MANAGED }, { pack: "dnd5e.rules" });
    const letter = world.addDocument("JournalEntry", { name: "Letter", flags: MANAGED }, { pack: "world.handouts" });
    await assert.rejects(
      remove([letter.uuid, rules.uuid]),
      refused("invalid_params", /lies in the compendium pack dnd5e\.rules.*which is locked.*Nothing was written\.$/)
    );
    assert.equal(world.packs.get("world.handouts").documents.size, 1);
    assert.deepEqual(await remove([letter.uuid]), { deleted: 1, documents: [{ uuid: letter.uuid, name: "Letter" }] });
    assert.equal(world.packs.get("world.handouts").documents.size, 0);
  });

  it("refuses a world actor that still has tokens on a scene, and the actor of a token, and deletes an actor that has none", async () => {
    const scene = world.addScene({ name: "Cellar" });
    const goblin = world.addActor({ name: "Goblin", flags: MANAGED });
    const ogre = world.addActor({ name: "Ogre", flags: MANAGED });
    const token = world.addToken(scene, { name: "Goblin", actorId: goblin.id });
    await assert.rejects(
      remove([`Actor.${ogre.id}`, `Actor.${goblin.id}`]),
      refused(
        "invalid_params",
        /Goblin \(Actor\.\w+\) still has tokens on Cellar.*Delete the tokens first with delete_tokens/
      )
    );
    await assert.rejects(
      remove([`${scene.uuid}.Token.${token.id}.Actor.${goblin.id}`]),
      refused("invalid_params", /is the actor of a token, and goes with its token: delete the token with delete_tokens/)
    );
    assert.equal(world.actors.size, 2);
    assert.deepEqual(await remove([`Actor.${ogre.id}`]), {
      deleted: 1,
      documents: [{ uuid: `Actor.${ogre.id}`, name: "Ogre" }]
    });
    assert.deepEqual([...world.actors.keys()], [goblin.id]);
  });

  it("does not delete the user the bridge works as, nor a Setting", async () => {
    world.addDocument("User", { _id: "user1", name: "Gamemaster", role: 4 });
    const ada = world.addDocument("User", { name: "Ada" });
    const setting = world.addDocument("Setting", { key: "core.time", value: "1" });
    await assert.rejects(
      remove([ada.uuid, "User.user1"], true),
      refused("invalid_params", /Gamemaster is the user this bridge works as, and cannot be deleted through it/)
    );
    await assert.rejects(remove([setting.uuid], true), refused("invalid_params", /These tools write no Setting/));
    assert.deepEqual([inWorld("User").length, inWorld("Setting").length], [2, 1]);
    assert.equal((await remove([ada.uuid], true)).deleted, 1);
  });

  it("leaves a deletion that a hook refused out of the result", async () => {
    const kept = world.addDocument("JournalEntry", { name: "Kept", flags: MANAGED });
    const gone = world.addDocument("JournalEntry", { name: "Gone", flags: MANAGED });
    world.control.vetoDocumentDelete = (document) => document.name === "Kept";
    assert.deepEqual(await remove([kept.uuid, gone.uuid]), {
      deleted: 1,
      documents: [{ uuid: gone.uuid, name: "Gone" }]
    });
    assert.deepEqual(
      inWorld("JournalEntry").map((entry: any) => entry.name),
      ["Kept"]
    );
  });

  it("names what was deleted before a request Foundry fails on", async () => {
    const entry = world.addDocument("JournalEntry", { name: "Pelor", flags: MANAGED });
    const macro = world.addDocument("Macro", { name: "Roll", flags: MANAGED });
    world.control.documentError = (action, name) =>
      action === "delete" && name === "Macro" ? "socket closed" : undefined;
    await assert.rejects(
      remove([entry.uuid, macro.uuid]),
      refused(
        "foundry_error",
        /^Foundry failed while deleting Macro\.\w+ \(socket closed\)\. Deleted before that: JournalEntry\.\w+\. list_documents shows what exists now\.$/
      )
    );
  });
});
