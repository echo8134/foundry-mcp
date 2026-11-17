import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { idFromLabel, isDocumentId } from "../module/scripts/labels.mjs";
import { fakeWorld } from "./fake-world.ts";
import { MANAGED, refused, restoreGlobals, viaTool } from "./token-world.ts";

afterEach(restoreGlobals);

type World = ReturnType<typeof fakeWorld>;

const RAGE = idFromLabel("rage");
const ensure = (args: Record<string, unknown>) => viaTool("ensure_actor", args);
const named = (parent: any, name: string) => parent.items.find((item: any) => item.name === name);
const acBonus = (value: string) => ({ key: "system.attributes.ac.bonus", type: "add", value });
const rage = (value = "2") => ({ _id: "rage", name: "Rage", system: { changes: [acBonus(value)] } });

describe("ensure_actor writing the effects of an actor", () => {
  let world: World;
  let ogre: any;
  beforeEach(() => {
    world = fakeWorld({ unloadable: ["art/missing.webp"] });
    ogre = world.addActor({
      name: "Ogre",
      effects: [
        { _id: "blessed000000001", name: "Blessed", description: "<p>Holy</p>" },
        { _id: "cursed0000000001", name: "Cursed", flags: MANAGED },
        { _id: "twin000000000001", name: "Twin", flags: MANAGED },
        { _id: "twin000000000002", name: "Twin", flags: MANAGED }
      ]
    });
    world.install();
  });
  const give = (effects: unknown[], more: Record<string, unknown> = {}) => ensure({ actor: ogre.id, effects, ...more });
  const sent = () => world.log.embedded.map((write) => [write.action, write.document, write.data]);
  const stored = (id: string) => ogre.effects.get(id)?._source;

  it("creates an effect under the id its label always becomes, flagged as bridge-made, and finds it there again", async () => {
    const result = await give([rage()]);
    assert.equal(isDocumentId(RAGE), true);
    assert.deepEqual(
      world.log.embedded.map((write) => [write.action, write.document, write.parent, write.keepId]),
      [["create", "ActiveEffect", `Actor.${ogre.id}`, true]]
    );
    const { name, flags, system } = stored(RAGE);
    assert.deepEqual(
      [name, flags, system.changes.map((change: any) => [change.key, change.type, change.value, change.phase])],
      ["Rage", MANAGED, [["system.attributes.ac.bonus", "add", "2", "initial"]]]
    );
    assert.deepEqual(result.effects, [
      { id: RAGE, name: "Rage", created: true, changed: ["name", "system.changes"], unapplied: [] }
    ]);
    const again = await give([rage()]);
    assert.deepEqual(
      [again.effects, sent().length, ogre.effects.size],
      [[{ id: RAGE, name: "Rage", created: false, changed: [], unapplied: [] }], 1, 5]
    );
  });

  it("keeps the id of each change of an effect, so a list given again without ids is the same list", async () => {
    await give([rage()]);
    const [{ _id: first }] = stored(RAGE).system.changes;
    const result = await give([{ _id: "rage", system: { changes: [acBonus("3"), acBonus("1")] } }]);
    const changes = stored(RAGE).system.changes;
    assert.deepEqual(
      [
        result.effects[0].changed,
        result.effects[0].unapplied,
        changes.map((change: any) => change.value),
        changes[0]._id
      ],
      [["system.changes"], [], ["3", "1"], first]
    );
    assert.notEqual(changes[1]._id, first);
    const again = await give([{ _id: "rage", system: { changes: [acBonus("3"), acBonus("1")] } }]);
    assert.deepEqual([again.effects[0].changed, sent().length], [[], 2]);
  });

  it("changes the effect of an id, also one made by hand, and sends only what differs", async () => {
    const result = await give([
      { _id: "blessed000000001", name: "Blessed", disabled: true, description: "<p>Holy</p>" }
    ]);
    assert.deepEqual(sent(), [["update", "ActiveEffect", [{ _id: "blessed000000001", disabled: true }]]]);
    assert.deepEqual(result.effects, [
      { id: "blessed000000001", name: "Blessed", created: false, changed: ["disabled"], unapplied: [] }
    ]);
  });

  it("finds an effect without _id by its name among the bridge-made ones, and creates it where there is none", async () => {
    const result = await give([
      { name: "Cursed", disabled: true },
      { name: "Shielded", tint: "#00ff00" }
    ]);
    assert.deepEqual(
      result.effects.map((effect: any) => [effect.name, effect.created, effect.changed]),
      [
        ["Cursed", false, ["disabled"]],
        ["Shielded", true, ["name", "tint"]]
      ]
    );
    assert.deepEqual([result.effects[0].id, isDocumentId(result.effects[1].id)], ["cursed0000000001", true]);
    assert.deepEqual(stored(result.effects[1].id).flags, MANAGED);
    assert.deepEqual((await give([{ name: "Shielded", tint: "#00ff00" }])).effects[0].created, false);
  });

  it("refuses a name several bridge-made effects have, and one that only an effect made by hand has, with the ids", async () => {
    await assert.rejects(
      give([{ name: "Twin", disabled: true }]),
      refused(
        "invalid_params",
        /^effects\[0\]: 2 bridge-made effects of Ogre named "Twin" \(twin000000000001, twin000000000002\)\. Pass the id of one as _id\./
      )
    );
    await assert.rejects(
      give([{ name: "Blessed", disabled: true }]),
      refused(
        "invalid_params",
        /^effects\[0\]: An effect of Ogre named "Blessed" that this bridge did not make \(blessed000000001\)\. Pass its id as _id/
      )
    );
    assert.deepEqual(sent(), []);
  });

  const refusals: [string, Record<string, unknown>, RegExp][] = [
    ["an effect without _id and name", { disabled: true }, /^effects\[0\]: An effect needs an _id or a name\./],
    ["a new effect without a name", { _id: "haste", disabled: true }, /^effects\[0\]: A new effect needs a name\./],
    [
      "a field effects do not have, such as the changes of older Foundry versions",
      { name: "Old", changes: [{ key: "x", mode: 2, value: "1" }] },
      /^effects\[0\]: No such field: changes\. get_schema with document ActiveEffect and type base lists the stored fields\./
    ],
    [
      "a field the effect type does not have",
      { name: "Old", system: { magical: true } },
      /^effects\[0\]: No such field: system\.magical\./
    ],
    [
      "a type the system does not have",
      { name: "Old", type: "aura" },
      /Unknown effect type "aura"\. Use one of: base, enchantment\./
    ],
    [
      "another type for an effect that exists",
      { name: "Cursed", type: "enchantment" },
      /Cursed is of the type base, and an effect keeps its type/
    ],
    [
      "a value Foundry would store as something else",
      { name: "Cursed", tint: "blue" },
      /tint: "blue" would be stored as "#00000b"/
    ],
    [
      "data the effect model refuses",
      { name: "Cursed", duration: { value: "long" } },
      /^effects\[0\]: Foundry's effect model refuses the data: .*duration\.value: must be a number/
    ],
    [
      "an image that does not load",
      { name: "Cursed", img: "art/missing.webp" },
      /^effects\[0\]: The image art\/missing\.webp could not be loaded\./
    ],
    [
      "the bridge's own flag with another value",
      { name: "Cursed", flags: { "foundry-mcp": {} } },
      /flags\.foundry-mcp cannot be given/
    ]
  ];
  for (const [label, effect, message] of refusals) {
    it(`refuses ${label} and writes nothing`, async () => {
      const before = structuredClone(ogre._source);
      await assert.rejects(give([effect], { name: "Ogre Chief" }), refused("invalid_params", message));
      assert.deepEqual([sent(), ogre._source, world.log.actorUpdates.length], [[], before, 0]);
    });
  }

  it("refuses two entries for one effect, and an effect the same call changes and removes", async () => {
    await assert.rejects(
      give([{ _id: "cursed0000000001", disabled: true }, { name: "Cursed" }]),
      refused("invalid_params", /^effects\[0\] and effects\[1\] lead to the same effect\./)
    );
    await assert.rejects(
      give([rage()], { removeEffects: ["rage"] }),
      refused(
        "invalid_params",
        new RegExp(`^effects\\[0\\] \\(${RAGE}\\): removeEffects deletes the same effect in this call`)
      )
    );
    assert.deepEqual(sent(), []);
  });

  it("removes effects by id or label, ignores what is not there, and counts what it removed", async () => {
    await give([rage()]);
    const args = { actor: ogre.id, removeEffects: ["rage", "blessed000000001", "nothingHere000001", "no such label"] };
    const result = await ensure(args);
    assert.deepEqual(sent().at(-1), ["delete", "ActiveEffect", [RAGE, "blessed000000001"]]);
    assert.deepEqual([result.removedEffects, ogre.effects.size, "effects" in result], [2, 3, false]);
    assert.deepEqual([(await ensure(args)).removedEffects, sent().length], [0, 2]);
  });

  it("creates the effects of a new actor after the actor, and does not let them transfer to an actor again", async () => {
    const result = await ensure({ name: "Troll", type: "npc", effects: [{ ...rage(), transfer: true }] });
    const troll = world.actors.get(result.id);
    assert.deepEqual(
      [troll.effects.get(RAGE)._source.transfer, result.effects[0].created, result.effects[0].unapplied],
      [false, true, ["transfer"]]
    );
  });

  it("reads the full stored data of the effects asked for, which is taken back unchanged", async () => {
    await give([rage()]);
    // A key the effect model does not store again, which ensure_actor would refuse as an unknown field.
    stored("blessed000000001").retired = true;
    const read = await viaTool("get_actor", { actor: ogre.id, effects: [RAGE, "blessed000000001"] });
    assert.deepEqual(
      read.effectData.map((effect: any) => [effect._id, effect.name, effect.flags ?? null, "retired" in effect]),
      [
        [RAGE, "Rage", MANAGED, false],
        ["blessed000000001", "Blessed", null, false]
      ]
    );
    const back = await give(read.effectData);
    assert.deepEqual(
      [back.effects.map((effect: any) => [effect.changed, effect.unapplied]), sent().length],
      [
        [
          [[], []],
          [[], []]
        ],
        1
      ]
    );
    await assert.rejects(
      viaTool("get_actor", { actor: ogre.id, effects: ["ghost"] }),
      refused("not_found", /Ogre has no effect with the id ghost\. The effect ids are in this tool's effects list\./)
    );
  });
});

describe("ensure_actor writing the effects of an item", () => {
  let world: World;
  let wolf: any;
  beforeEach(() => {
    world = fakeWorld();
    wolf = world.addActor({
      name: "Wolf",
      items: [{ name: "Howl", type: "feat", flags: MANAGED, effects: [{ _id: "fear000000000001", name: "Fear" }] }]
    });
    world.install();
  });
  const POISON = idFromLabel("poison");
  const bite = {
    name: "Bite",
    type: "feat",
    system: { activities: { bite: { type: "save", effects: [{ _id: "poison" }] } } },
    effects: [{ _id: "poison", name: "Poisoned", description: "<p>Sick<br />and weak</p>" }]
  };
  const sent = () => world.log.embedded.map((write) => [write.action, write.document, write.parent]);

  it("creates a new item with its effects in one request, and an activity names an effect by the label both use", async () => {
    const result = await ensure({ actor: wolf.id, items: [bite] });
    const item = named(wolf, "Bite");
    assert.deepEqual(sent(), [["create", "Item", `Actor.${wolf.id}`]]);
    const [effect] = item._source.effects;
    assert.deepEqual(
      [effect._id, effect.name, effect.flags, effect.transfer, effect.description],
      [POISON, "Poisoned", MANAGED, true, "<p>Sick<br>and weak</p>"]
    );
    assert.deepEqual(item._source.system.activities[idFromLabel("bite")].effects, [{ _id: POISON }]);
    assert.deepEqual(result.items[0].effects, [
      { id: POISON, name: "Poisoned", created: true, changed: ["name", "description"], unapplied: [] }
    ]);
    const again = await ensure({ actor: wolf.id, items: [bite] });
    assert.deepEqual(
      [again.items[0].changed, again.items[0].effects[0].changed, again.items[0].effects[0].created, sent().length],
      [[], [], false, 1]
    );
  });

  it("creates, changes and removes the effects of an item that exists, through the item", async () => {
    const howl = named(wolf, "Howl");
    const result = await ensure({
      actor: wolf.id,
      items: [
        {
          name: "Howl",
          type: "feat",
          effects: [
            { _id: "fear000000000001", disabled: true },
            { _id: "dread", name: "Dread" }
          ]
        }
      ]
    });
    assert.deepEqual(sent(), [
      ["create", "ActiveEffect", howl.uuid],
      ["update", "ActiveEffect", howl.uuid]
    ]);
    assert.deepEqual(result.items[0].effects, [
      { id: "fear000000000001", name: "Fear", created: false, changed: ["disabled"], unapplied: [] },
      { id: idFromLabel("dread"), name: "Dread", created: true, changed: ["name"], unapplied: [] }
    ]);
    assert.deepEqual(result.items[0].changed, []);
    const removed = await ensure({
      actor: wolf.id,
      items: [{ id: howl.id, removeEffects: ["dread", "nothingHere000001"] }]
    });
    assert.deepEqual(
      [removed.items[0].removedEffects, howl._source.effects.map((effect: any) => effect.name)],
      [1, ["Fear"]]
    );
  });

  it("refuses a fault in an effect of an item with the place of the entry, and writes nothing", async () => {
    await assert.rejects(
      ensure({
        actor: wolf.id,
        items: [
          { name: "Trip", type: "feat" },
          { ...bite, effects: [{ _id: "poison", name: "P", sytem: {} }] }
        ]
      }),
      refused("invalid_params", /^items\[1\]\.effects\[0\]: No such field: sytem\./)
    );
    await assert.rejects(
      ensure({
        actor: wolf.id,
        items: [
          { name: "Howl", type: "feat", effects: [{ _id: "fear000000000001" }], removeEffects: ["fear000000000001"] }
        ]
      }),
      refused(
        "invalid_params",
        /^items\[0\]\.effects\[0\] \(fear000000000001\): items\[0\]\.removeEffects deletes the same effect/
      )
    );
    assert.deepEqual([sent(), wolf.items.size], [[], 1]);
  });

  it("writes an item's effects for one token where the actor is a token's", async () => {
    const scene = world.addScene({ name: "Cellar" });
    const token = world.addToken(scene, { name: "Wolf", actorId: wolf.id });
    const uuid = `${scene.uuid}.Token.${token.id}.Actor.${wolf.id}`;
    const howl = named(wolf, "Howl");
    await ensure({
      actor: uuid,
      items: [{ id: howl.id, effects: [{ _id: "dread", name: "Dread" }] }],
      effects: [{ _id: "rage", name: "Rage" }]
    });
    const { items, effects } = token._source.delta;
    assert.deepEqual(
      [
        items.map((item: any) => [item.name, item.effects.map((effect: any) => effect.name)]),
        effects.map((effect: any) => effect.name)
      ],
      [[["Howl", ["Fear", "Dread"]]], ["Rage"]]
    );
    assert.deepEqual([howl._source.effects.length, wolf.effects.size], [1, 0]);
  });

  it("reads an item in full with its effects, and takes its data back unchanged under its id", async () => {
    await ensure({ actor: wolf.id, items: [bite] });
    const item = named(wolf, "Bite");
    // A key the item model does not store again, which ensure_actor would refuse as an unknown field.
    item._source.system.retired = true;
    const read = await viaTool("get_actor", { actor: wolf.id, items: [item.id] });
    const [{ _id, name, img, system, flags, effects }] = read.itemData;
    assert.deepEqual([_id, flags, "retired" in system], [item.id, MANAGED, false]);
    world.log.embedded.length = 0;
    const back = await ensure({ actor: wolf.id, items: [{ id: _id, name, img, system, flags, effects }] });
    assert.deepEqual(
      [back.items[0].changed, back.items[0].unapplied, back.items[0].effects[0].changed, sent()],
      [[], [], [], []]
    );
  });
});
