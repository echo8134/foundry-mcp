import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { idFromLabel, isDocumentId } from "../module/scripts/labels.mjs";
import { ForcedDeletion } from "./fake-model.ts";
import { fakeWorld } from "./fake-world.ts";
import { MANAGED, refused, restoreGlobals, viaTool } from "./token-world.ts";

afterEach(restoreGlobals);

type World = ReturnType<typeof fakeWorld>;

const GONE = new ForcedDeletion();
const BITE = idFromLabel("bite");
const ensure = (args: Record<string, unknown>) => viaTool("ensure_actor", args);
const named = (actor: any, name: string) => actor.items.find((item: any) => item.name === name);

const part = (number: number, type: string) => ({ number, denomination: 6, bonus: "", types: [type] });
const attack = (bonus: string) => ({
  type: "attack",
  attack: { flat: true, bonus },
  damage: { includeBase: false, parts: [part(2, "piercing"), part(1, "poison")] }
});
const withBite = (activity: Record<string, unknown>) => ({
  name: "Bite",
  type: "feat",
  system: { activities: { bite: activity } }
});

describe("ensure_actor writing the activities of an item", () => {
  let world: World;
  let wolf: any;
  beforeEach(async () => {
    world = fakeWorld();
    world.install();
    await ensure({ name: "Wolf", type: "npc", items: [withBite(attack("5"))] });
    wolf = [...world.actors.values()][0];
    world.log.embedded.length = 0;
  });
  const give = (...items: Record<string, unknown>[]) => ensure({ actor: wolf.id, items });
  const activities = () => named(wolf, "Bite")._source.system.activities;
  const sent = () => world.log.embedded.map((write) => [write.action, write.data]);

  it("stores an activity under the id its label always becomes, with that id as its _id", async () => {
    assert.equal(isDocumentId(BITE), true);
    assert.deepEqual(
      Object.entries(activities()).map(([key, activity]: [string, any]) => [key, activity._id, activity.type]),
      [[BITE, BITE, "attack"]]
    );
  });

  it("changes the activity of a label when the call runs again with another value, and adds no second one", async () => {
    const result = await give(withBite(attack("7")));
    const bite = named(wolf, "Bite");
    assert.deepEqual(sent(), [
      ["update", [{ _id: bite.id, system: { activities: { [BITE]: { attack: { bonus: "7" } } } } }]]
    ]);
    assert.deepEqual(
      [result.items[0].changed, result.items[0].unapplied, Object.keys(activities()), activities()[BITE].attack.bonus],
      [[`system.activities.${BITE}.attack.bonus`], [], [BITE], "7"]
    );
  });

  it("changes an activity without its type being given again", async () => {
    const result = await give(withBite({ attack: { bonus: "9" } }));
    assert.deepEqual(
      [result.items[0].changed, activities()[BITE].type],
      [[`system.activities.${BITE}.attack.bonus`], "attack"]
    );
  });

  it("keeps a key that is a document id as it is, and takes its id as the key in the same call again", async () => {
    const claw = "abcdefghij123456";
    await give({ name: "Claw", type: "feat", system: { activities: { [claw]: attack("3") } } });
    const stored = named(wolf, "Claw")._source.system.activities;
    assert.deepEqual([Object.keys(stored), stored[claw]._id], [[claw], claw]);
    const again = await give({ name: "Bite", type: "feat", system: { activities: { [BITE]: attack("5") } } });
    assert.deepEqual([again.items[0].changed, Object.keys(activities())], [[], [BITE]]);
  });

  it("replaces a list inside an activity whole", async () => {
    const shorter = { ...attack("5"), damage: { parts: [part(3, "piercing")] } };
    const result = await give(withBite(shorter));
    assert.deepEqual(result.items[0].changed, [`system.activities.${BITE}.damage.parts`]);
    assert.deepEqual(activities()[BITE].damage, { includeBase: false, parts: [part(3, "piercing")] });
    assert.deepEqual((await give(withBite(shorter))).items[0].changed, []);
  });

  it("adds a second activity to the item and leaves the first as it is", async () => {
    const result = await give({
      name: "Bite",
      type: "feat",
      system: { activities: { lockjaw: { type: "save", save: { ability: ["str"], dc: { formula: "13" } } } } }
    });
    const lockjaw = idFromLabel("lockjaw");
    assert.deepEqual(Object.keys(activities()), [BITE, lockjaw]);
    assert.deepEqual(
      [activities()[lockjaw].damage.onSave, activities()[BITE].attack.bonus, result.items[0].unapplied],
      ["half", "5", []]
    );
  });

  it("removes an activity by its label, and ignores it once it is gone", async () => {
    const entry = { name: "Bite", type: "feat", remove: ["system.activities.bite"] };
    const result = await give(entry);
    assert.deepEqual(sent(), [["update", [{ _id: named(wolf, "Bite").id, system: { activities: { [BITE]: GONE } } }]]]);
    assert.deepEqual(
      [result.items[0].changed, result.items[0].unapplied, activities()],
      [[`system.activities.${BITE}`], [], {}]
    );
    assert.deepEqual([(await give(entry)).items[0].changed, sent().length], [[], 1]);
  });

  it("gives the behaviors of an activity ids that stay, so the same call again writes nothing", async () => {
    const behaviors = [{ type: "difficultTerrain", config: { multiplier: 3 } }];
    const first = await give(withBite({ behaviors }));
    const [stored] = activities()[BITE].behaviors;
    assert.deepEqual(
      [first.items[0].unapplied, isDocumentId(stored._id), stored.config],
      [[], true, { multiplier: 3 }]
    );
    const again = await give(withBite({ behaviors }));
    assert.deepEqual([again.items[0].changed, sent().length, activities()[BITE].behaviors[0]._id], [[], 1, stored._id]);
    const changed = await give(withBite({ behaviors: [{ type: "difficultTerrain", config: { multiplier: 4 } }] }));
    assert.deepEqual(
      [changed.items[0].changed, activities()[BITE].behaviors[0]._id],
      [[`system.activities.${BITE}.behaviors`], stored._id]
    );
  });

  it("takes two spellings of one HTML content in an activity's description as the same", async () => {
    await give(withBite({ description: { value: "<p>Sharp<br />teeth</p>" } }));
    assert.equal(activities()[BITE].description.value, "<p>Sharp<br>teeth</p>");
    const again = await give(withBite({ description: { value: "<p>Sharp<br />teeth</p>" } }));
    assert.deepEqual([again.items[0].changed, again.items[0].unapplied, sent().length], [[], [], 1]);
  });

  const refusals: [string, Record<string, unknown>, RegExp][] = [
    [
      "a new activity without a type",
      { claw: { attack: { bonus: "3" } } },
      /^items\[0\]: system\.activities\.claw: a new activity needs a type, one of attack, save, cast, heal\. get_schema with document Activity lists the fields of each\./
    ],
    [
      "a new activity of a type dnd5e does not have",
      { claw: { type: "strike" } },
      /system\.activities\.claw: a new activity needs a type, one of attack, save, cast, heal\./
    ],
    [
      "another type for an activity that exists",
      { bite: { type: "save" } },
      /^items\[0\]: system\.activities\.bite: this activity is of the type attack, and keeps it\. Leave type out, or remove the entry \(remove: \["system\.activities\.bite"\]\)/
    ],
    [
      "a field the activity type does not have",
      { bite: { attack: { bonuss: "9" } } },
      new RegExp(`^items\\[0\\]: No such field: system\\.activities\\.${BITE}\\.attack\\.bonuss\\.`)
    ],
    [
      "an _id that is not the key",
      { bite: { _id: "abcdefghij123456", attack: { bonus: "9" } } },
      /system\.activities\.bite: its _id "abcdefghij123456" is not its key\. Leave _id out\./
    ],
    [
      "a label and the id it becomes in one entry",
      { bite: { attack: { bonus: "9" } }, [BITE]: { attack: { bonus: "8" } } },
      /names the activity \w{16}, which another key of this entry names too/
    ],
    [
      "a key Foundry would read as an instruction",
      { "-=bite": null },
      /^items\[0\]: Not a plain key: "-=bite" in system\.activities\./
    ],
    [
      "a field of a behavior's config that its type does not have",
      { bite: { behaviors: [{ type: "difficultTerrain", config: { speed: 3 } }] } },
      new RegExp(`No such field: system\\.activities\\.${BITE}\\.behaviors\\.0\\.config\\.speed\\.`)
    ]
  ];
  for (const [label, given, message] of refusals) {
    it(`refuses ${label} and writes nothing`, async () => {
      const before = wolf.toObject();
      await assert.rejects(
        give({ name: "Bite", type: "feat", system: { activities: given } }),
        refused("invalid_params", message)
      );
      assert.deepEqual([sent(), wolf.toObject()], [[], before]);
    });
  }

  it("refuses to remove an entry that the same entry gives a value, and a path below an activity", async () => {
    await assert.rejects(
      give({ ...withBite({ attack: { bonus: "9" } }), remove: ["system.activities.bite"] }),
      refused(
        "invalid_params",
        new RegExp(`^items\\[0\\]: system\\.activities\\.${BITE} is named in remove and given a value in the same call`)
      )
    );
    await assert.rejects(
      give({ name: "Bite", type: "feat", remove: ["system.activities.bite.attack"] }),
      refused(
        "invalid_params",
        /^items\[0\]: remove: Not an entry that can be removed: system\.activities\.\w{16}\.attack\./
      )
    );
    assert.deepEqual(sent(), []);
  });
});

describe("ensure_actor writing items on the actor of a token", () => {
  let world: World;
  let scene: any;
  let goblin: any;
  let token: any;
  let uuid: string;
  beforeEach(() => {
    world = fakeWorld();
    scene = world.addScene({ name: "Cellar" });
    goblin = world.addActor({
      name: "Goblin",
      system: { attributes: { hp: { value: 7, max: 7, temp: null } } },
      items: [
        {
          name: "Scimitar",
          type: "feat",
          flags: MANAGED,
          system: {
            type: { value: "monster" },
            activities: {
              slash00000000001: { _id: "slash00000000001", type: "attack", attack: { bonus: "4", flat: true } }
            }
          }
        }
      ]
    });
    token = world.addToken(scene, { name: "Goblin", actorId: goblin.id });
    uuid = `${scene.uuid}.Token.${token.id}.Actor.${goblin.id}`;
    world.install();
  });
  const own = () => (token._source.delta.items ?? []).map((item: any) => (item._tombstone ? "tombstone" : item.name));

  it("creates an item in the token's own data, beside what the token changed before, and not on the world actor", async () => {
    await ensure({ actor: uuid, system: { attributes: { hp: { value: 2 } } } });
    const result = await ensure({ actor: uuid, items: [withBite(attack("5"))] });
    assert.deepEqual([own(), goblin.items.size, token.actor.items.size], [["Bite"], 1, 2]);
    assert.deepEqual(
      [token._source.delta.system, token._source.delta.items[0].flags, result.items[0].created],
      [{ attributes: { hp: { value: 2 } } }, MANAGED, true]
    );
    assert.deepEqual(
      world.log.embedded.map((write) => [write.action, write.parent]),
      [["create", uuid]]
    );
    const again = await ensure({ actor: uuid, items: [withBite(attack("5"))] });
    assert.deepEqual([again.items[0].changed, again.items[0].created, world.log.embedded.length], [[], false, 1]);
  });

  it("changes an item of the world actor for the one token, found by name or by id", async () => {
    const [scimitar] = goblin.items.values();
    const before = scimitar.toObject();
    const result = await ensure({
      actor: uuid,
      items: [
        { name: "Scimitar", type: "feat", system: { activities: { slash00000000001: { attack: { bonus: "6" } } } } }
      ]
    });
    assert.deepEqual(
      [result.items[0].id, result.items[0].changed, result.items[0].unapplied],
      [scimitar.id, ["system.activities.slash00000000001.attack.bonus"], []]
    );
    assert.deepEqual(
      [token._source.delta.items[0].system.activities.slash00000000001.attack, scimitar.toObject()],
      [{ bonus: "6", flat: true }, before]
    );
    const renamed = await ensure({ actor: uuid, items: [{ id: scimitar.id, name: "Notched Scimitar" }] });
    assert.deepEqual(
      [renamed.items[0].changed, own(), goblin.items.map((item: any) => item.name)],
      [["name"], ["Notched Scimitar"], ["Scimitar"]]
    );
  });

  it("removes an activity of a world actor's item for the one token, and the item itself", async () => {
    const [scimitar] = goblin.items.values();
    const cut = await ensure({
      actor: uuid,
      items: [{ id: scimitar.id, remove: ["system.activities.slash00000000001"] }]
    });
    assert.deepEqual(
      [
        cut.items[0].changed,
        token._source.delta.items[0].system.activities,
        Object.keys(scimitar._source.system.activities)
      ],
      [["system.activities.slash00000000001"], {}, ["slash00000000001"]]
    );
    const removed = await ensure({ actor: uuid, removeItems: [scimitar.id] });
    assert.deepEqual(
      [removed.removedItems, own(), token.actor.items.size, goblin.items.size],
      [1, ["tombstone"], 0, 1]
    );
    assert.equal((await ensure({ actor: uuid, removeItems: [scimitar.id] })).removedItems, 0);
  });

  it("removes an item the token added without a trace", async () => {
    const added = await ensure({ actor: uuid, items: [{ name: "Net", type: "feat" }] });
    const result = await ensure({ actor: uuid, removeItems: [added.items[0].id] });
    assert.deepEqual([result.removedItems, own()], [1, []]);
  });
});
