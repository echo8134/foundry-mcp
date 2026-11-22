// sync_regions and the stairs between levels: changeLevel, and the destinations of a teleportToken, also those that
// name a region before it exists.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { box, setUp } from "./region-world.ts";
import { MANAGED, refused, restoreGlobals, viaTool, type World } from "./token-world.ts";

afterEach(restoreGlobals);

describe("sync_regions and the stairs between levels", () => {
  let world: World;
  let scene: any;
  let sync: ReturnType<typeof setUp>["sync"];
  let writes: ReturnType<typeof setUp>["writes"];
  let named: ReturnType<typeof setUp>["named"];
  beforeEach(() => {
    ({ world, scene, sync, writes, named } = setUp());
  });

  const teleport = (...destinations: unknown[]) => [{ type: "teleportToken", system: { destinations } }];
  const door = (name: string, ...destinations: unknown[]) => ({
    name,
    shapes: [box(0, 0)],
    behaviors: teleport(...destinations)
  });
  const destinationsOf = async (name: string) => {
    const { regions } = await viaTool("get_scene", { sceneId: scene.id });
    return regions.find((region: any) => region.name === name).behaviors[0].system.destinations;
  };
  const storedDestinations = (name: string) => [...named(name)[0].behaviors.values()][0]._source.system.destinations;

  it("refuses a changeLevel on one level, where it would offer nothing, and takes it on the levels a stair joins", async () => {
    const steps = { name: "Steps", shapes: [box(0, 0)], behaviors: [{ type: "changeLevel" }] };
    await assert.rejects(
      sync({ levels: ["upper"], regions: [steps] }),
      refused("invalid_params", /^regions\[0\]\.behaviors\[0\]: A changeLevel behavior offers a token the other levels/)
    );
    assert.deepEqual(writes(), []);
    assert.equal((await sync({ levels: ["lvl1", "upper"], regions: [steps] })).created, 1);
    assert.equal((await sync({ regions: [{ ...steps, name: "Shaft" }] })).created, 1);
  });

  it("leads a destination named in the same call to the region the call creates", async () => {
    const result = await sync({
      levels: ["upper"],
      regions: [door("East", { region: "West" }), door("West", { region: "East" })]
    });
    const [east, west] = result.regions;
    assert.deepEqual([result.created, east.behaviors[0].pending, west.behaviors[0].pending], [2, undefined, undefined]);
    assert.deepEqual(
      [await destinationsOf("East"), await destinationsOf("West")],
      [[`${scene.uuid}.Region.${west.id}`], [`${scene.uuid}.Region.${east.id}`]]
    );
    assert.deepEqual(writes(), ["create Region", "create RegionBehavior", "create RegionBehavior"]);
  });

  it("writes nothing on the next run although Foundry keeps a destination in another spelling than the given one", async () => {
    await sync({ levels: ["upper"], regions: [door("East", { region: "West" }), door("West", { region: "East" })] });
    const before = writes();
    const again = await sync({
      levels: ["upper"],
      regions: [door("East", { region: "West" }), door("West", { region: "East" })]
    });
    assert.deepEqual([writes(), again.updated], [before, 0]);

    // A change of the list is written, and Foundry stores the UUID relative to the behavior.
    const far = world.addDocument("Region", { name: "Far", levels: ["lvl1"] }, { parent: scene });
    const west = named("West")[0];
    const both = [door("East", { region: "West" }, far.uuid), door("West", { region: "East" })];
    const changed = await sync({ levels: ["upper"], regions: both });
    assert.deepEqual(changed.regions[0].behaviors[0].changed, ["system.destinations"]);
    assert.deepEqual(storedDestinations("East"), [`..${west.id}`, `..${far.id}`]);
    assert.deepEqual(await destinationsOf("East"), [west.uuid, far.uuid]);
    const settled = writes();
    assert.equal((await sync({ levels: ["upper"], regions: both })).updated, 0);
    assert.deepEqual(writes(), settled);
  });

  const PENDING = "flags.foundry-mcp.pending";
  const waitingFor = (...regions: string[]) => ({
    "foundry-mcp": { managed: true, pending: regions.map((region) => ({ field: "destinations", region })) }
  });
  const behaviorOf = (name: string) => [...named(name)[0].behaviors.values()][0];

  it("builds two regions on different levels that name each other in two calls: the second leads the first one on", async () => {
    const down = { levels: ["lvl1"], regions: [door("Down", { region: "Up" })] };
    const up = { levels: ["upper"], regions: [door("Up", { region: "Down" })] };
    const first = await sync(down);
    assert.deepEqual([first.regions[0].behaviors[0].pending, first.resolved], [["Up"], undefined]);
    assert.deepEqual(
      [storedDestinations("Down"), await destinationsOf("Down"), behaviorOf("Down").flags],
      [[], [{ region: "Up" }], waitingFor("Up")]
    );

    const second = await sync(up);
    assert.equal(second.regions[0].behaviors[0].pending, undefined);
    assert.deepEqual(second.resolved, [
      {
        id: behaviorOf("Down").id,
        type: "teleportToken",
        region: { id: first.regions[0].id, name: "Down" },
        names: ["Up"],
        changed: ["system.destinations", PENDING],
        unapplied: []
      }
    ]);
    assert.deepEqual(
      [await destinationsOf("Up"), await destinationsOf("Down"), behaviorOf("Down").flags],
      [[named("Down")[0].uuid], [named("Up")[0].uuid], MANAGED]
    );

    const before = writes();
    const third = await sync(down);
    assert.deepEqual(
      [third.updated, third.resolved, third.regions[0].behaviors[0].pending, (await sync(up)).updated, writes()],
      [0, undefined, undefined, 0, before]
    );
  });

  it("keeps a name that still leads nowhere when get_scene's regions are passed back, and drops one the entry no longer gives", async () => {
    await sync({ levels: ["lvl1"], regions: [door("Down", { region: "Up" })] });
    const before = writes();
    const read = await viaTool("get_scene", { sceneId: scene.id });
    const back = await sync({ levels: ["lvl1"], regions: read.regions });
    assert.deepEqual([back.updated, back.regions[0].behaviors[0].pending, writes()], [0, ["Up"], before]);

    const dropped = await sync({ levels: ["lvl1"], regions: [door("Down")] });
    assert.deepEqual([dropped.regions[0].behaviors[0].changed, behaviorOf("Down").flags], [[PENDING], MANAGED]);
    assert.equal((await sync({ levels: ["upper"], regions: [door("Up")] })).resolved, undefined);
    assert.deepEqual(await destinationsOf("Down"), []);
  });

  it("keeps a waiting name when an entry leaves its destinations out, as one that switches the stair off", async () => {
    await sync({ levels: ["lvl1"], regions: [door("Down", { region: "Up" })] });
    const off = { name: "Down", shapes: [box(0, 0)], behaviors: [{ type: "teleportToken", disabled: true }] };
    const switched = await sync({ levels: ["lvl1"], regions: [off] });
    assert.deepEqual(
      [switched.regions[0].behaviors[0].changed, switched.regions[0].behaviors[0].pending, behaviorOf("Down").flags],
      [["disabled"], ["Up"], waitingFor("Up")]
    );
    assert.deepEqual(await destinationsOf("Down"), [{ region: "Up" }]);
    assert.deepEqual((await sync({ levels: ["upper"], regions: [door("Up")] })).resolved[0].names, ["Up"]);
    assert.deepEqual(await destinationsOf("Down"), [named("Up")[0].uuid]);
  });

  it("leads a waiting name on only to the one bridge-made region of that name, and only if it is on one level", async () => {
    await sync({ levels: ["lvl1"], regions: [door("Down", { region: "Up" }, { region: "Loft" })] });
    world.addDocument("Region", { name: "Up", levels: ["upper"] }, { parent: scene });
    const onBoth = await sync({ regions: [door("Up")] });
    assert.deepEqual(
      [onBoth.resolved, await destinationsOf("Down")],
      [undefined, [{ region: "Up" }, { region: "Loft" }]]
    );
    await sync({ regions: [] });

    const twin = world.addDocument("Region", { name: "Loft", levels: ["lvl1"], flags: MANAGED }, { parent: scene });
    const made = await sync({ levels: ["upper"], regions: [door("Loft"), door("Up")] });
    assert.deepEqual(
      made.resolved.map((one: any) => [one.region.name, one.names, one.changed]),
      [["Down", ["Up"], ["system.destinations", PENDING]]]
    );
    assert.deepEqual(
      [await destinationsOf("Down"), behaviorOf("Down").flags],
      [[`${scene.uuid}.Region.${made.regions[1].id}`, { region: "Loft" }], waitingFor("Loft")]
    );
    assert.ok(scene.regions.has(twin.id));
  });

  it("leads a waiting name on as the entry's own destination when its level set is synced after the region came another way", async () => {
    const down = { levels: ["lvl1"], regions: [door("Down", { region: "Up" })] };
    await sync(down);
    const up = world.addDocument("Region", { name: "Up", levels: ["upper"], flags: MANAGED }, { parent: scene });
    const again = await sync(down);
    const [behavior] = again.regions[0].behaviors;
    assert.deepEqual(
      [again.resolved, behavior.changed, behavior.pending, await destinationsOf("Down")],
      [undefined, ["system.destinations", PENDING], undefined, [up.uuid]]
    );
  });

  it("adds the region a waiting name leads to beside the destinations the behavior has", async () => {
    const far = world.addDocument("Region", { name: "Far", levels: ["lvl1"] }, { parent: scene });
    await sync({ levels: ["lvl1"], regions: [door("Down", far.uuid, { region: "Up" })] });
    const made = await sync({ levels: ["upper"], regions: [door("Up")] });
    assert.deepEqual(await destinationsOf("Down"), [far.uuid, `${scene.uuid}.Region.${made.regions[0].id}`]);
  });

  it("leads a name to the region of the call that has it before one of another level set", async () => {
    world.addDocument("Region", { name: "West", levels: ["lvl1"], flags: MANAGED }, { parent: scene });
    const result = await sync({ levels: ["upper"], regions: [door("East", { region: "West" }), door("West")] });
    assert.deepEqual(await destinationsOf("East"), [`${scene.uuid}.Region.${result.regions[1].id}`]);
  });

  it("never leads on a name kept on a behavior the bridge did not make", async () => {
    const kept = { "foundry-mcp": { pending: [{ field: "destinations", region: "Up" }] } };
    world.addDocument(
      "Region",
      { name: "Old door", levels: ["lvl1"], behaviors: [{ type: "teleportToken", flags: kept }] },
      { parent: scene }
    );
    const made = await sync({ levels: ["upper"], regions: [door("Up")] });
    assert.deepEqual([made.resolved, writes(), await destinationsOf("Old door")], [undefined, ["create Region"], []]);
  });

  it("leads a waiting name on in a region of the same call whose entry gives no behaviors", async () => {
    await sync({ levels: ["lvl1"], regions: [door("Down", { region: "Up" })] });
    const result = await sync({ levels: ["lvl1"], regions: [{ name: "Down", shapes: [box(0, 0)] }, door("Up")] });
    assert.deepEqual(
      result.resolved.map((one: any) => [one.region.name, one.names]),
      [["Down", ["Up"]]]
    );
    assert.deepEqual(await destinationsOf("Down"), [named("Up")[0].uuid]);
  });

  it("keeps a name waiting when a hook refuses the creation of its region, and leads on the others of the call", async () => {
    await sync({ levels: ["lvl1"], regions: [door("Down", { region: "Up" }, { region: "Loft" })] });
    world.control.vetoDocument = (document: string, data: Record<string, any>) =>
      document === "Region" && data.name === "Up";
    const made = await sync({ levels: ["upper"], regions: [door("Up"), door("Loft")] });
    assert.deepEqual(
      [made.regions.map((region: any) => region.created), made.resolved.map((one: any) => one.names)],
      [[false, true], [["Loft"]]]
    );
    assert.deepEqual(
      [await destinationsOf("Down"), behaviorOf("Down").flags],
      [[named("Loft")[0].uuid, { region: "Up" }], waitingFor("Up")]
    );

    const vetoed = await sync({ levels: ["upper"], regions: [door("Up"), door("Loft")] });
    assert.deepEqual(
      [vetoed.resolved, await destinationsOf("Down")],
      [undefined, [named("Loft")[0].uuid, { region: "Up" }]]
    );

    world.control.vetoDocument = null;
    const later = await sync({ levels: ["upper"], regions: [door("Up"), door("Loft")] });
    assert.deepEqual(
      later.resolved.map((one: any) => one.names),
      [["Up"]]
    );
    assert.deepEqual(await destinationsOf("Down"), [named("Loft")[0].uuid, named("Up")[0].uuid]);
  });

  for (const source of ["a new region", "an existing region", "an existing behavior"]) {
    it(`keeps a vetoed same-call destination pending on ${source} through readback and retry`, async () => {
      const levels = ["upper"];
      const byHand = world.addDocument("Region", { name: "Porch", levels }, { parent: scene });
      if (source === "an existing region") await sync({ levels, regions: [{ name: "Door", shapes: [box(0, 0)] }] });
      if (source === "an existing behavior") await sync({ levels, regions: [door("Door", byHand.uuid)] });
      const request = {
        levels,
        regions: [door("Door", { region: "Landing" }, byHand.uuid, { region: "Loft" }), door("Landing"), door("Loft")]
      };
      world.control.vetoDocument = (document, data) => document === "Region" && data.name === "Landing";
      const first = await sync(request);
      const behavior = first.regions[0].behaviors[0];
      assert.match(first.regions[1].error, /Foundry created nothing/);
      assert.deepEqual([behavior.pending, behavior.unapplied], [["Landing"], []]);
      const loft = named("Loft")[0];
      assert.deepEqual(await destinationsOf("Door"), [byHand.uuid, loft.uuid, { region: "Landing" }]);
      assert.deepEqual(behaviorOf("Door").flags, waitingFor("Landing"));

      const before = writes();
      const { regions } = await viaTool("get_scene", { sceneId: scene.id });
      assert.equal((await sync({ levels, regions })).updated, 0);
      assert.deepEqual(writes(), before);
      assert.equal((await sync(request)).updated, 0);
      assert.deepEqual(writes().slice(before.length), ["create Region"]);

      world.control.vetoDocument = null;
      const retry = await sync(request);
      assert.deepEqual([retry.regions[0].behaviors[0].pending, behaviorOf("Door").flags], [undefined, MANAGED]);
      assert.deepEqual(await destinationsOf("Door"), [named("Landing")[0].uuid, byHand.uuid, loft.uuid]);
      const settled = writes();
      assert.equal((await sync(request)).updated, 0);
      assert.deepEqual(writes(), settled);
    });
  }

  it("reports the stored pending names when a hook vetoes the behavior update too", async () => {
    const levels = ["upper"];
    await sync({ levels, regions: [door("Door", { region: "Cellar" })] });
    world.control.vetoDocument = (document, data) => document === "Region" && data.name === "Landing";
    world.control.vetoDocumentUpdate = (document) => document === "RegionBehavior";
    const result = await sync({ levels, regions: [door("Door", { region: "Landing" }), door("Landing")] });
    const [behavior] = result.regions[0].behaviors;
    assert.deepEqual([behavior.pending, behavior.unapplied], [["Cellar"], [PENDING]]);
    assert.deepEqual(await destinationsOf("Door"), [{ region: "Cellar" }]);
  });

  it("reports the regions created before a dependent behavior write fails and restores its siblings in order", async () => {
    const request = {
      levels: ["upper"],
      regions: [
        {
          name: "Door",
          shapes: [box(0, 0)],
          behaviors: [
            { type: "pauseGame", name: "First" },
            ...teleport({ region: "Landing" }),
            { type: "pauseGame", name: "Last" }
          ]
        },
        door("Landing")
      ]
    };
    world.control.documentError = (action, document) =>
      action === "create" && document === "RegionBehavior" ? "connection lost" : undefined;
    await assert.rejects(
      sync(request),
      (error: unknown) =>
        refused("foundry_error", /creating the behaviors of the region Door \(connection lost\)/)(error) &&
        refused("foundry_error", /region Door \(\w+\) created; region Landing \(\w+\) created/)(error)
    );
    assert.equal(named("Door")[0].behaviors.size, 0);

    world.control.documentError = null;
    const retry = await sync(request);
    assert.deepEqual([retry.created, retry.updated], [0, 1]);
    const read = await viaTool("get_scene", { sceneId: scene.id });
    const { behaviors } = read.regions.find((region: any) => region.name === "Door");
    assert.deepEqual(
      behaviors.map((behavior: any) => behavior.name),
      ["First", "", "Last"]
    );
    assert.deepEqual(behaviors[1].system.destinations, [named("Landing")[0].uuid]);
  });

  it("names a destination it led on when a later step of the call fails", async () => {
    await sync({ levels: ["lvl1"], regions: [door("Down", { region: "Up" })] });
    world.addDocument("Region", { name: "Old", levels: ["upper"], flags: MANAGED }, { parent: scene });
    world.control.documentError = (action: string) => (action === "delete" ? "connection lost" : undefined);
    await assert.rejects(
      sync({ levels: ["upper"], regions: [door("Up")] }),
      refused(
        "foundry_error",
        /shows: region Up \(\w+\) created; behavior of the region Up teleportToken \(\w+\) created; behavior of the region Down teleportToken \(\w+\) changed \(system\.destinations, flags\.foundry-mcp\.pending\)\. Running/
      )
    );
  });

  it("reports nothing unapplied when Foundry stores the destination of a new behavior relative to it", async () => {
    // On Foundry 14.370 a creation was seen to keep the UUID it is given, and an update to store it relative to the
    // behavior. Either spelling names the same region, whichever a creation stores.
    await sync({ levels: ["upper"], regions: [{ name: "West", shapes: [box(0, 0)] }] });
    world.control.filterDocumentData = (document: string, source: Record<string, any>) => {
      if (document !== "Region") return;
      for (const behavior of source.behaviors) {
        behavior.system.destinations = behavior.system.destinations.map(
          (uuid: string) => `..${uuid.split(".").at(-1)}`
        );
      }
    };
    const pair = { levels: ["upper"], regions: [door("East", { region: "West" }), door("West", { region: "East" })] };
    const result = await sync(pair);
    assert.deepEqual(storedDestinations("East"), [`..${named("West")[0].id}`]);
    assert.deepEqual(
      result.regions.map((region: any) => region.behaviors[0].unapplied),
      [[], []]
    );
    const before = writes();
    assert.deepEqual([(await sync(pair)).updated, writes()], [0, before]);
  });

  it("takes a destination by the UUID of a region, of this scene or another, a region made by hand too", async () => {
    const crypt = world.addScene({ name: "Crypt" });
    const tomb = world.addDocument("Region", { name: "Tomb", levels: ["lvl1"] }, { parent: crypt });
    const byHand = world.addDocument("Region", { name: "Landing", levels: ["lvl1"] }, { parent: scene });
    await sync({ levels: ["upper"], regions: [door("Trapdoor", tomb.uuid, byHand.uuid, tomb.uuid)] });
    assert.deepEqual(await destinationsOf("Trapdoor"), [tomb.uuid, byHand.uuid]);
  });

  it("refuses a destination that Foundry could not teleport into, or that leads nowhere, before anything is written", async () => {
    const onBoth = world.addDocument("Region", { name: "Wide", flags: MANAGED }, { parent: scene });
    world.addDocument("Region", { name: "Twin", levels: ["lvl1"], flags: MANAGED }, { parent: scene });
    world.addDocument("Region", { name: "Twin", flags: MANAGED }, { parent: scene });
    const cases: [Record<string, unknown>, string, RegExp][] = [
      [
        { regions: [door("A", { region: "B" }), door("B")] },
        "invalid_params",
        /^regions\[0\]\.behaviors\[0\]: system\.destinations\[0\]: The destination "B" is on 2 levels\. Foundry teleports a token only into a region that is on exactly one level/
      ],
      [
        { levels: ["upper"], regions: [door("A", onBoth.uuid)] },
        "invalid_params",
        new RegExp(`The destination ${onBoth.uuid} is on 2 levels`)
      ],
      [
        { levels: ["upper"], regions: [door("A", { region: "Twin" })] },
        "invalid_params",
        /2 bridge-made regions of this scene are named "Twin" \(.*\)\. Give the UUID of one in place of its name\./
      ],
      [
        { levels: ["upper"], regions: [door("A", `${scene.uuid}.Region.gone000000000000`)] },
        "not_found",
        /system\.destinations\[0\]: Nothing exists at the UUID .*gone000000000000\. Nothing was written\.$/
      ],
      [{ levels: ["upper"], regions: [door("A", scene.uuid)] }, "invalid_params", /is a Scene, not a Region\./],
      [
        { levels: ["upper"], regions: [door("A", "..abcdefgh12345678")] },
        "invalid_params",
        /Give the absolute UUID of a Region, such as Scene\.<id>\.Region\.<id>, or \{region: "<name>"\}/
      ],
      [
        { levels: ["upper"], regions: [door("A", { region: 5 })] },
        "invalid_params",
        /Give the absolute UUID of a Region/
      ],
      [
        {
          levels: ["upper"],
          regions: [{ ...door("A"), behaviors: [{ type: "teleportToken", system: { destinations: "x" } }] }]
        },
        "invalid_params",
        /system\.destinations must be a list\./
      ]
    ];
    for (const [args, code, message] of cases) {
      await assert.rejects(sync(args), refused(code, message), JSON.stringify(args));
    }
    assert.deepEqual([writes(), scene.regions.size], [[], 3]);
  });

  it("refuses a destination that the same call deletes", async () => {
    const old = world.addDocument("Region", { name: "Old", levels: ["upper"], flags: MANAGED }, { parent: scene });
    await assert.rejects(
      sync({ levels: ["upper"], regions: [door("New", old.uuid)] }),
      refused("invalid_params", /is a bridge-made region that this call does not name, so the call deletes it\./)
    );
    assert.deepEqual(writes(), []);
  });
});
