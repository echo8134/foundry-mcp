// Stored text that Foundry runs as code without anyone clicking: the generic document tools write none of it.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeWorld } from "./fake-world.ts";
import { MANAGED, refused, restoreGlobals, viaTool, type World } from "./token-world.ts";

afterEach(restoreGlobals);

const create = (args: Record<string, unknown>) => viaTool("create_documents", args);
const update = (...documents: Record<string, unknown>[]) => viaTool("update_documents", { documents });
const get = (uuid: string) => viaTool("get_document", { uuid });
const writes = (world: World) => world.log.documentWrites.map((write) => `${write.action} ${write.document}`);

const SCRIPT = { type: "executeScript", system: { events: ["tokenEnter"], source: "game.paused = true" } };
const MACRO = { type: "executeMacro", system: { events: ["tokenEnter"], uuid: "Macro.trap000000000000" } };
const PAUSE = { type: "pauseGame", system: { once: true } };

describe("code that Foundry runs by itself", () => {
  let world: World;
  let scene: any;
  let region: any;
  beforeEach(() => {
    world = fakeWorld();
    world.install();
    scene = world.addScene({ name: "Cellar" });
    region = world.addDocument("Region", { name: "Pit" }, { parent: scene });
  });

  for (const [type, behavior, reason] of [
    [
      "executeScript",
      SCRIPT,
      /its source is code that Foundry runs by itself, without anyone clicking, in every connected browser, the players' included/
    ],
    [
      "executeMacro",
      MACRO,
      /it makes Foundry run a macro by itself, without anyone clicking, in one connected browser or in all of them/
    ]
  ] as const) {
    it(`creates no region behavior of the type ${type}, and says who does`, async () => {
      await assert.rejects(
        create({ type: "RegionBehavior", parent: region.uuid, documents: [PAUSE, behavior] }),
        (error: unknown) =>
          refused("invalid_params", reason)(error) &&
          refused(
            "invalid_params",
            new RegExp(
              `^documents\\[1\\]: These tools create no region behavior of the type ${type}: .*The Gamemaster adds such a behavior in Foundry's own region configuration\\. Nothing was written\\.$`
            )
          )(error)
      );
      assert.deepEqual([region.behaviors.size, writes(world)], [0, []]);
    });

    it(`creates no region and no scene that brings a behavior of the type ${type} with it`, async () => {
      await assert.rejects(
        create({ type: "Region", parent: scene.uuid, documents: [{ name: "Trap", behaviors: [PAUSE, behavior] }] }),
        refused(
          "invalid_params",
          new RegExp(`^documents\\[0\\]: behaviors\\.1: These tools create no region behavior of the type ${type}`)
        )
      );
      await assert.rejects(
        create({
          type: "Scene",
          documents: [{ name: "Vault", regions: [{ name: "Trap", behaviors: [{ ...behavior, type: `${type} ` }] }] }]
        }),
        refused(
          "invalid_params",
          new RegExp(
            `^documents\\[0\\]: regions\\.0\\.behaviors\\.0: These tools create no region behavior of the type ${type}: .*Nothing was written\\.$`
          )
        )
      );
      assert.deepEqual([scene.regions.size, world.scenes.size, world.log.sceneCreates, writes(world)], [1, 1, 0, []]);
    });
  }

  it("writes no behavior that runs code into the scenes an adventure holds, on a create or a change", async () => {
    const trapped = (behavior: Record<string, unknown>) => [
      { name: "Cave", regions: [{ name: "Pit", behaviors: [behavior] }] }
    ];
    world.addPack("world.adventures", "Adventure");
    for (const behavior of [SCRIPT, MACRO]) {
      await assert.rejects(
        create({
          type: "Adventure",
          pack: "world.adventures",
          documents: [{ name: "Lost Mine", scenes: trapped(behavior) }]
        }),
        refused(
          "invalid_params",
          new RegExp(
            `^documents\\[0\\]: scenes\\.0\\.regions\\.0\\.behaviors\\.0: These tools create no region behavior of the type ${behavior.type}`
          )
        )
      );
    }
    const made = await create({
      type: "Adventure",
      pack: "world.adventures",
      documents: [{ name: "Lost Mine", scenes: trapped(PAUSE) }]
    });
    assert.equal(made.created, 1);
    const { uuid } = made.documents[0];
    await assert.rejects(
      update({ uuid, data: { name: "Found Mine", scenes: trapped(SCRIPT) } }),
      refused(
        "invalid_params",
        /^documents\[0\]: scenes\.0\.regions\.0\.behaviors\.0: These tools create no region behavior of the type executeScript: .*Nothing was written\.$/
      )
    );
    assert.deepEqual(writes(world), ["create Adventure"]);
    const calmer = await update({ uuid, data: { scenes: trapped({ type: "pauseGame", system: { once: false } }) } });
    assert.deepEqual(calmer.documents[0].changed, ["scenes"]);
  });

  it("takes back an adventure that holds a script behavior written in Foundry, and changes its other fields", async () => {
    const adventure = world.addDocument(
      "Adventure",
      { name: "Lost Mine", scenes: [{ name: "Cave", regions: [{ name: "Pit", behaviors: [SCRIPT] }] }] },
      { pack: "world.adventures" }
    );
    const { data } = await get(adventure.uuid);
    assert.equal(data.scenes[0].regions[0].behaviors[0].system.source, "game.paused = true");
    const renamed = await update({ uuid: adventure.uuid, data: { ...data, name: "Found Mine" } });
    assert.deepEqual(renamed.documents[0].changed, ["name"]);
    assert.deepEqual(world.log.documentWrites[0]!.data, [{ name: "Found Mine" }]);
  });

  it("takes no behavior that hides in an object where Foundry would read a list of them", async () => {
    await assert.rejects(
      create({ type: "Region", parent: scene.uuid, documents: [{ name: "Trap", behaviors: { 0: SCRIPT } }] }),
      refused("invalid_params", /^documents\[0\]: Not a list of documents: behaviors\..*Nothing was written\.$/)
    );
    await assert.rejects(
      create({
        type: "Scene",
        documents: [{ name: "Vault", regions: { 0: { name: "Trap", behaviors: [SCRIPT] } } }]
      }),
      refused("invalid_params", /^documents\[0\]: Not a list of documents: regions\./)
    );
    await assert.rejects(
      create({ type: "Region", parent: scene.uuid, documents: [{ name: "Trap", behaviors: [[SCRIPT]] }] }),
      refused("invalid_params", /^documents\[0\]: Not a list of documents: behaviors\.0\./)
    );
    world.addPack("world.adventures", "Adventure");
    await assert.rejects(
      create({
        type: "Adventure",
        pack: "world.adventures",
        documents: [{ name: "Mine", scenes: { 0: { name: "Cave", regions: [{ name: "Pit", behaviors: [SCRIPT] }] } } }]
      }),
      refused("invalid_params", /^documents\[0\]: Not a list of documents: scenes\./)
    );
    assert.deepEqual([scene.regions.size, writes(world)], [1, []]);
  });

  it("knows a type that runs code however it is spelled, as Foundry reads it", async () => {
    for (const type of [["executeScript"], " executeMacro "]) {
      await assert.rejects(
        create({ type: "Region", parent: scene.uuid, documents: [{ name: "Trap", behaviors: [{ type }] }] }),
        refused(
          "invalid_params",
          /^documents\[0\]: behaviors\.0: These tools create no region behavior of the type execute/
        )
      );
    }
    assert.deepEqual([scene.regions.size, writes(world)], [1, []]);
  });

  it("creates a region behavior that runs no code, by itself and with its region", async () => {
    const alone = await create({ type: "RegionBehavior", parent: region.uuid, documents: [PAUSE] });
    assert.equal(alone.created, 1);
    const withRegion = await create({
      type: "Region",
      parent: scene.uuid,
      documents: [{ name: "Trap", behaviors: [PAUSE] }]
    });
    assert.equal(withRegion.created, 1);
    const trap = scene.regions.find((one: any) => one.name === "Trap");
    assert.deepEqual(
      [...region.behaviors.values(), ...trap.behaviors.values()].map((behavior: any) => [
        behavior.type,
        behavior._source.system,
        behavior._source.flags
      ]),
      [
        ["pauseGame", { once: true }, MANAGED],
        ["pauseGame", { once: true }, MANAGED]
      ]
    );
  });

  it("does not change the code of a script behavior, nor the macro of a macro behavior, and changes what else they hold", async () => {
    const script = world.addDocument("RegionBehavior", SCRIPT, { parent: region });
    const macro = world.addDocument("RegionBehavior", MACRO, { parent: region });
    await assert.rejects(
      update({ uuid: script.uuid, data: { name: "Fine", system: { source: "game.users.contents" } } }),
      refused(
        "invalid_params",
        /^documents\[0\]: Scene\.\w+\.Region\.\w+\.RegionBehavior\.\w+ is a region behavior of the type executeScript: its source is code that Foundry runs by itself.*These tools do not change its source\. The Gamemaster changes it in Foundry's own region configuration\. Nothing was written\.$/
      )
    );
    await assert.rejects(
      update({ uuid: macro.uuid, data: { system: { uuid: "Macro.other00000000000" } } }),
      refused("invalid_params", /is a region behavior of the type executeMacro: .*These tools do not change its uuid\./)
    );
    assert.deepEqual(
      [script._source.system.source, script.name, macro._source.system.uuid, writes(world)],
      ["game.paused = true", "", "Macro.trap000000000000", []]
    );

    const { data } = await get(script.uuid);
    assert.equal(data.system.source, "game.paused = true");
    assert.deepEqual((await update({ uuid: script.uuid, data })).documents[0].changed, []);
    const renamed = await update({ uuid: script.uuid, data: { ...data, name: "Alarm", disabled: true } });
    assert.deepEqual(renamed.documents[0].changed, ["name", "disabled"]);
    assert.deepEqual([script.name, script._source.system.source], ["Alarm", "game.paused = true"]);
  });

  it("does not turn a behavior into one that runs code", async () => {
    const pause = world.addDocument("RegionBehavior", PAUSE, { parent: region });
    for (const type of ["executeScript", "executeMacro"]) {
      await assert.rejects(
        update({ uuid: pause.uuid, data: { type, system: SCRIPT.system } }),
        refused("invalid_params", /is of the type pauseGame, and Foundry cannot change the type of a document/)
      );
    }
    await assert.rejects(
      update({ uuid: pause.uuid, data: { system: { source: "game.paused = true" } } }),
      refused("invalid_params", /No such field: system\.source/)
    );
    assert.deepEqual([pause.type, pause._source.system, writes(world)], ["pauseGame", { once: true }, []]);
  });

  it("deletes a behavior that runs code", async () => {
    const script = world.addDocument("RegionBehavior", SCRIPT, { parent: region });
    const result = await viaTool("delete_documents", { uuids: [script.uuid], handMade: true });
    assert.deepEqual([result.deleted, region.behaviors.size], [1, 0]);
  });

  it("does not change the command of a macro that a region behavior runs, and changes any other macro", async () => {
    const trap = world.addDocument("Macro", {
      name: "Trap",
      type: "script",
      command: "ui.notifications.info('click')"
    });
    const loot = world.addDocument("Macro", { name: "Loot", type: "script", command: "1" });
    const behavior = world.addDocument(
      "RegionBehavior",
      { ...MACRO, system: { ...MACRO.system, uuid: trap.uuid } },
      { parent: region }
    );
    await assert.rejects(
      update({ uuid: trap.uuid, data: { command: "game.users.contents" } }),
      (error: unknown) =>
        refused(
          "invalid_params",
          /^documents\[0\]: Foundry runs the macro Trap \(Macro\.\w+\) by itself, without anyone clicking, in one connected browser or in all of them, the players' included: the region behavior (\S+) names it\. These tools do not change the command of such a macro\. The Gamemaster changes it in Foundry's own macro configuration\. Nothing was written\.$/
        )(error) && (error as Error).message.includes(behavior.uuid)
    );
    assert.deepEqual([trap._source.command, writes(world)], ["ui.notifications.info('click')", []]);

    const { data } = await get(trap.uuid);
    assert.deepEqual((await update({ uuid: trap.uuid, data: { ...data, name: "Pit trap" } })).documents[0].changed, [
      "name"
    ]);
    assert.deepEqual((await update({ uuid: loot.uuid, data: { command: "2" } })).documents[0].changed, ["command"]);
    assert.deepEqual(
      [trap.name, trap._source.command, loot._source.command],
      ["Pit trap", "ui.notifications.info('click')", "2"]
    );
  });

  it("knows a compendium macro by a UUID without its type, as Foundry finds it", async () => {
    world.addPack("world.macros", "Macro", { locked: false });
    const trap = world.addDocument("Macro", { name: "Trap", type: "script", command: "1" }, { pack: "world.macros" });
    world.addDocument(
      "RegionBehavior",
      { ...MACRO, system: { ...MACRO.system, uuid: `Compendium.world.macros.${trap.id}` } },
      { parent: region }
    );
    await assert.rejects(
      update({ uuid: trap.uuid, data: { command: "2" } }),
      refused("invalid_params", /These tools do not change the command of such a macro\./)
    );
    assert.deepEqual([trap._source.command, writes(world)], ["1", []]);
  });
});
