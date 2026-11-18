// sync_regions against the fake world: what it creates, changes in place and deletes, what it never touches, and
// what it refuses before it writes anything.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { box, setUp, storedBox } from "./region-world.ts";
import { MANAGED, refused, restoreGlobals, viaTool, type World } from "./token-world.ts";

afterEach(restoreGlobals);

describe("sync_regions", () => {
  let world: World;
  let scene: any;
  let sync: ReturnType<typeof setUp>["sync"];
  let writes: ReturnType<typeof setUp>["writes"];
  let named: ReturnType<typeof setUp>["named"];
  let bridgeMade: ReturnType<typeof setUp>["bridgeMade"];
  beforeEach(() => {
    ({ world, scene, sync, writes, named, bridgeMade } = setUp());
  });

  const nave = {
    name: "Nave",
    color: "#aa3366",
    shapes: [
      box(1, 2, 3, 1),
      {
        type: "polygon",
        hole: true,
        points: [
          [2, 2],
          [3, 2],
          [3, 3]
        ]
      }
    ]
  };
  const cells = { width: 10, height: 8 };

  it("creates a region flagged as bridge-made, on the call's levels, with its shapes in scene pixels", async () => {
    const result = await sync({ frame: cells, levels: ["upper"], regions: [nave] });
    const [region] = named("Nave");
    assert.deepEqual(
      { ...result, regions: result.regions.map(({ changed, ...rest }: any) => ({ ...rest, changed: changed.sort() })) },
      {
        created: 1,
        updated: 0,
        deleted: 0,
        regions: [
          { id: region.id, name: "Nave", created: true, changed: ["color", "levels", "name", "shapes"], unapplied: [] }
        ],
        sceneId: scene.id,
        sceneName: "Cathedral"
      }
    );
    assert.deepEqual(
      [region._source.shapes, region._source.levels, region._source.color, region._source.flags],
      [
        [
          storedBox(100, 200, 300, 100),
          { type: "polygon", hole: true, points: [200, 200, 300, 200, 300, 300], origin: null }
        ],
        ["upper"],
        "#aa3366",
        MANAGED
      ]
    );
  });

  it("writes nothing when it is run again with the same input", async () => {
    const first = await sync({ frame: cells, levels: ["upper"], regions: [nave] });
    const before = writes();
    const again = await sync({ frame: cells, levels: ["upper"], regions: [nave] });
    assert.deepEqual(writes(), before);
    assert.deepEqual(again, {
      created: 0,
      updated: 0,
      deleted: 0,
      regions: [{ id: first.regions[0].id, name: "Nave", created: false, changed: [], unapplied: [] }],
      sceneId: scene.id,
      sceneName: "Cathedral"
    });
  });

  it("changes a region of the same name in place, so that it keeps its id, and writes only what differs", async () => {
    const first = await sync({ frame: cells, levels: ["upper"], regions: [nave] });
    const moved = { ...nave, color: "#113355", shapes: [box(4, 4, 2, 2)] };
    const result = await sync({ frame: cells, levels: ["upper"], regions: [moved] });
    assert.deepEqual(
      [result.created, result.updated, result.deleted, result.regions],
      [
        0,
        1,
        0,
        [{ id: first.regions[0].id, name: "Nave", created: false, changed: ["color", "shapes"], unapplied: [] }]
      ]
    );
    assert.deepEqual(writes(), ["create Region", "update Region"]);
    assert.deepEqual(world.log.documentWrites[1]!.data, [
      { _id: first.regions[0].id, color: "#113355", shapes: [storedBox(400, 400, 200, 200)] }
    ]);
    assert.deepEqual(named("Nave")[0]._source.shapes, [storedBox(400, 400, 200, 200)]);
  });

  it("deletes the region and creates another when an entry comes under another name", async () => {
    const first = await sync({ levels: ["upper"], regions: [{ name: "Nave", shapes: [box(0, 0)] }] });
    const result = await sync({ levels: ["upper"], regions: [{ name: "Choir", shapes: [box(0, 0)] }] });
    assert.deepEqual([result.created, result.updated, result.deleted], [1, 0, 1]);
    assert.notEqual(result.regions[0].id, first.regions[0].id);
    assert.deepEqual(
      scene.regions.map((region: any) => region.name),
      ["Choir"]
    );
    assert.deepEqual(writes(), ["create Region", "create Region", "delete Region"]);
  });

  it("never touches a region made by hand, also one of the same name, and says that it lies beside the new one", async () => {
    const byHand = world.addDocument(
      "Region",
      { name: "Nave", levels: ["upper"], shapes: [storedBox(5, 5)] },
      { parent: scene }
    );
    const before = structuredClone(byHand._source);
    const result = await sync({ levels: ["upper"], regions: [{ name: "Nave", shapes: [box(0, 0)] }] });
    assert.deepEqual([result.created, result.handPlaced], [1, [{ id: byHand.id, name: "Nave" }]]);
    assert.equal(named("Nave").length, 2);
    const emptied = await sync({ levels: ["upper"], regions: [] });
    assert.deepEqual([emptied.deleted, emptied.handPlaced], [1, undefined]);
    assert.deepEqual(
      scene.regions.map((region: any) => [region.id, region._source]),
      [[byHand.id, before]]
    );
  });

  it("lists a hand-made region of an entry's name only when it is on the call's level set", async () => {
    const beside = world.addDocument("Region", { name: "Stairs", levels: ["upper"] }, { parent: scene });
    world.addDocument("Region", { name: "Stairs", levels: ["lvl1"] }, { parent: scene });
    world.addDocument("Region", { name: "Stairs" }, { parent: scene });
    const result = await sync({ levels: ["upper"], regions: [{ name: "Stairs", shapes: [box(0, 0)] }] });
    assert.deepEqual(result.handPlaced, [{ id: beside.id, name: "Stairs" }]);
  });

  it("owns the bridge-made regions of exactly its level set, and takes every level of the scene as no levels", async () => {
    const onUpper = bridgeMade({ name: "Loft", levels: ["upper"] });
    const onLower = bridgeMade({ name: "Cellar", levels: ["lvl1"] });
    const onAll = bridgeMade({ name: "Everywhere" });
    const names = () => scene.regions.map((region: any) => region.name).sort();
    assert.equal((await sync({ levels: ["upper"], regions: [] })).deleted, 1);
    assert.deepEqual(names(), ["Cellar", "Everywhere"]);
    // Both levels of the scene are the level set "all levels": the region on all levels is found, not made again.
    const stair = { name: "Everywhere", shapes: [box(0, 0)] };
    const found = await sync({ levels: ["lvl1", "upper"], regions: [stair] });
    assert.deepEqual(
      [found.created, found.regions[0].id, found.regions[0].changed],
      [0, onAll.id, ["shapes", "levels"]]
    );
    assert.deepEqual(names(), ["Cellar", "Everywhere"]);
    assert.equal((await sync({ regions: [] })).deleted, 1);
    assert.deepEqual(
      [names(), scene.regions.has(onLower.id), scene.regions.has(onUpper.id)],
      [["Cellar"], true, false]
    );
  });

  it("stores levels given in another order as they are, and writes nothing for them", async () => {
    const region = bridgeMade({ name: "Stair", levels: ["upper", "lvl1"], shapes: [storedBox(0, 0)] });
    world.addLevel(scene, "crypt");
    const result = await sync({ levels: ["lvl1", "upper"], regions: [{ name: "Stair", shapes: [box(0, 0)] }] });
    assert.deepEqual([result.updated, result.regions[0].changed, writes()], [0, [], []]);
    assert.deepEqual(region._source.levels, ["upper", "lvl1"]);
  });

  it("gives the other stored fields of a region to Foundry, and leaves a field that is not given as it is", async () => {
    await sync({
      regions: [
        {
          name: "Vault",
          shapes: [box(0, 0)],
          elevation: { bottom: -20, top: 0 },
          visibility: 2,
          hidden: true,
          restriction: { enabled: true, type: "sight" }
        }
      ]
    });
    const [vault] = named("Vault");
    assert.deepEqual(
      [vault._source.elevation, vault._source.visibility, vault._source.hidden, vault._source.restriction],
      [{ bottom: -20, top: 0, topInclusive: false }, 2, true, { enabled: true, type: "sight", priority: 0 }]
    );
    const result = await sync({ regions: [{ name: "Vault", shapes: [box(0, 0)], hidden: false }] });
    assert.deepEqual(result.regions[0].changed, ["hidden"]);
    assert.deepEqual([vault._source.hidden, vault._source.visibility, vault._source.elevation.bottom], [false, 2, -20]);
  });
});

describe("sync_regions and the behaviors of a region", () => {
  let world: World;
  let scene: any;
  let sync: ReturnType<typeof setUp>["sync"];
  let writes: ReturnType<typeof setUp>["writes"];
  let named: ReturnType<typeof setUp>["named"];
  beforeEach(() => {
    ({ world, scene, sync, writes, named } = setUp());
  });

  const stair = (behaviors?: unknown[]) => ({
    regions: [{ name: "Stair", shapes: [box(0, 0)], ...(behaviors && { behaviors }) }]
  });
  const behaviorsOf = (name: string) =>
    named(name)[0].behaviors.map((behavior: any) => [behavior._source.name, behavior.type, behavior.flags]);

  it("creates a region with its behaviors in one write, flagged as bridge-made, an unnamed one without a name", async () => {
    const result = await sync(
      stair([{ type: "changeLevel" }, { type: "pauseGame", name: "Halt", system: { once: true } }])
    );
    assert.deepEqual(writes(), ["create Region"]);
    assert.deepEqual(behaviorsOf("Stair"), [
      ["", "changeLevel", MANAGED],
      ["Halt", "pauseGame", MANAGED]
    ]);
    // Foundry shows a behavior without a name under the label of its type.
    assert.equal([...named("Stair")[0].behaviors.values()][0].name, "Label of changeLevel");
    const [region] = result.regions;
    assert.deepEqual(
      region.behaviors.map(({ id, changed, ...rest }: any) => [named("Stair")[0].behaviors.has(id), rest]),
      [
        [true, { name: "", type: "changeLevel", created: true, unapplied: [] }],
        [true, { name: "Halt", type: "pauseGame", created: true, unapplied: [] }]
      ]
    );
    assert.equal(region.removedBehaviors, 0);
  });

  it("creates the regions of a call in one write, and the behaviors of a region that exists in one write each way", async () => {
    await sync({
      regions: [
        { name: "Stair", shapes: [box(0, 0)], behaviors: [{ type: "pauseGame", name: "Old" }] },
        { name: "Hall", shapes: [box(2, 2)] }
      ]
    });
    assert.deepEqual(writes(), ["create Region"]);
    assert.equal(world.log.documentWrites[0]!.data.length, 2);
    const before = writes().length;
    const result = await sync({
      regions: [
        {
          name: "Stair",
          shapes: [box(1, 1)],
          behaviors: [
            { type: "pauseGame", name: "One" },
            { type: "pauseGame", name: "Two" }
          ]
        },
        { name: "Hall", shapes: [box(3, 3)] }
      ]
    });
    assert.deepEqual(writes().slice(before), ["update Region", "create RegionBehavior", "delete RegionBehavior"]);
    assert.deepEqual(
      world.log.documentWrites.slice(before).map((write) => write.data.length),
      [2, 2, 1]
    );
    assert.deepEqual(
      [result.updated, result.regions[0].behaviors.map((one: any) => one.created), result.regions[0].removedBehaviors],
      [2, [true, true], 1]
    );
  });

  it("finds a behavior by its type and its name, so two of one name and different types lie side by side", async () => {
    const both = stair([
      { type: "pauseGame", name: "Step" },
      { type: "changeLevel", name: "Step" }
    ]);
    const first = await sync(both);
    assert.deepEqual(behaviorsOf("Stair"), [
      ["Step", "pauseGame", MANAGED],
      ["Step", "changeLevel", MANAGED]
    ]);
    const before = writes();
    const again = await sync(both);
    assert.deepEqual(
      [writes(), again.regions[0].behaviors.map((one: any) => one.id)],
      [before, first.regions[0].behaviors.map((one: any) => one.id)]
    );
  });

  it("brings the bridge-made behaviors to the list by name: one changed in place, one created, one deleted", async () => {
    await sync(stair([{ type: "changeLevel" }, { type: "pauseGame", name: "Halt", system: { once: true } }]));
    const [region] = named("Stair");
    const halt = region.behaviors.find((behavior: any) => behavior.name === "Halt");
    const before = writes();
    assert.equal(
      (await sync(stair([{ type: "changeLevel" }, { type: "pauseGame", name: "Halt", system: { once: true } }])))
        .updated,
      0
    );
    assert.deepEqual(writes(), before);

    const result = await sync(
      stair([
        { type: "pauseGame", name: "Halt", disabled: true, system: { once: false } },
        { type: "pauseGame", name: "Second" }
      ])
    );
    assert.deepEqual([result.created, result.updated, result.deleted], [0, 1, 0]);
    assert.deepEqual(
      result.regions[0].behaviors.map(({ id, name, created, changed }: any) => [
        id === halt.id,
        name,
        created,
        changed.sort()
      ]),
      [
        [true, "Halt", false, ["disabled", "system.once"]],
        [false, "Second", true, ["name", "type"]]
      ]
    );
    assert.equal(result.regions[0].removedBehaviors, 1);
    assert.deepEqual(writes().slice(before.length), [
      "create RegionBehavior",
      "update RegionBehavior",
      "delete RegionBehavior"
    ]);
    assert.deepEqual(
      region.behaviors.map((behavior: any) => [behavior.name, behavior.disabled, behavior._source.system]),
      [
        ["Halt", true, { once: false }],
        ["Second", false, { once: false }]
      ]
    );
  });

  it("replaces a behavior whose entry comes with another type under the same name", async () => {
    await sync(stair([{ type: "pauseGame", name: "Step" }]));
    const result = await sync(stair([{ type: "changeLevel", name: "Step" }]));
    assert.deepEqual([result.regions[0].behaviors[0].created, result.regions[0].removedBehaviors], [true, 1]);
    assert.deepEqual(behaviorsOf("Stair"), [["Step", "changeLevel", MANAGED]]);
  });

  it("never touches a behavior someone added in Foundry, and leaves all behaviors alone when none are given", async () => {
    await sync(stair([{ type: "pauseGame" }]));
    const [region] = named("Stair");
    const byHand = world.addDocument("RegionBehavior", { type: "pauseGame", name: "pauseGame" }, { parent: region });
    const before = writes();
    await sync(stair());
    assert.deepEqual(writes(), before);
    assert.equal(region.behaviors.size, 2);
    const emptied = await sync(stair([]));
    assert.deepEqual([emptied.updated, emptied.regions[0].removedBehaviors], [1, 1]);
    assert.deepEqual(
      region.behaviors.map((behavior: any) => behavior.id),
      [byHand.id]
    );
  });

  it("finds a bridge-made behavior without a name by its type, also one that is stored under its type as its name", async () => {
    const region = world.addDocument(
      "Region",
      {
        name: "Stair",
        flags: MANAGED,
        shapes: [storedBox(0, 0)],
        behaviors: [
          { type: "pauseGame", flags: MANAGED },
          { type: "changeLevel", name: "changeLevel", flags: MANAGED }
        ]
      },
      { parent: scene }
    );
    const [pause, change] = region.behaviors.values();
    const result = await sync(stair([{ type: "pauseGame" }, { type: "changeLevel" }]));
    assert.deepEqual(
      result.regions[0].behaviors.map(({ id, created, changed }: any) => [id, created, changed]),
      [
        [pause.id, false, []],
        [change.id, false, ["name"]]
      ]
    );
    assert.deepEqual([pause._source.name, change._source.name, writes()], ["", "", ["update RegionBehavior"]]);
  });

  it("refuses to delete a bridge-made region that holds a behavior added by hand", async () => {
    await sync(stair([{ type: "pauseGame" }]));
    const [region] = named("Stair");
    world.addDocument("RegionBehavior", { type: "executeScript", name: "Alarm" }, { parent: region });
    const before = writes();
    await assert.rejects(
      sync({ regions: [] }),
      refused(
        "invalid_params",
        new RegExp(
          `^This call does not name the region Stair \\(${region.id}\\), which holds Alarm\\. .*delete_documents\\. Nothing was written\\.$`
        )
      )
    );
    assert.deepEqual(writes(), before);
    assert.equal((await sync(stair())).deleted, 0);
  });

  it("applies the rule for code Foundry runs by itself: no such behavior is created, and none is changed", async () => {
    const script = { type: "executeScript", system: { events: ["tokenEnter"], source: "game.paused = true" } };
    for (const [behavior, reason] of [
      [script, /These tools create no region behavior of the type executeScript/],
      [
        { type: "executeMacro", system: { uuid: "Macro.trap000000000000" } },
        /create no region behavior of the type executeMacro/
      ]
    ] as const) {
      await assert.rejects(
        sync(stair([{ type: "pauseGame" }, behavior])),
        (error: unknown) =>
          refused("invalid_params", reason)(error) &&
          refused("invalid_params", /^regions\[0\]\.behaviors\[1\]: /)(error)
      );
    }
    assert.deepEqual([writes(), scene.regions.size], [[], 0]);

    // One that carries the bridge's flag, as a copy made in Foundry can: the same data back is no change.
    const region = world.addDocument(
      "Region",
      {
        name: "Stair",
        flags: MANAGED,
        shapes: [storedBox(0, 0)],
        behaviors: [{ ...script, name: "Alarm", flags: MANAGED }]
      },
      { parent: scene }
    );
    assert.equal((await sync(stair([{ ...script, name: "Alarm" }]))).updated, 0);
    await assert.rejects(
      sync(stair([{ ...script, name: "Alarm", system: { ...script.system, source: "game.togglePause()" } }])),
      refused("invalid_params", /^regions\[0\]\.behaviors\[0\]: .*These tools do not change its source\./)
    );
    assert.deepEqual([writes(), [...region.behaviors.values()][0]._source.system.source], [[], "game.paused = true"]);
  });
});

describe("sync_regions and what it refuses", () => {
  let world: World;
  let scene: any;
  let sync: ReturnType<typeof setUp>["sync"];
  let writes: ReturnType<typeof setUp>["writes"];
  let bridgeMade: ReturnType<typeof setUp>["bridgeMade"];
  beforeEach(() => {
    ({ world, scene, sync, writes, bridgeMade } = setUp());
  });

  const good = { name: "Good", shapes: [box(0, 0)] };
  const cases: [string, Record<string, unknown>, RegExp][] = [
    [
      "a field Foundry does not store",
      { regions: [good, { ...good, name: "B", colour: "#fff" }] },
      /^regions\[1\]: No such field: colour\./
    ],
    [
      "a polygon of two points",
      {
        regions: [
          {
            name: "B",
            shapes: [
              box(0, 0),
              {
                type: "polygon",
                points: [
                  [0, 0],
                  [5, 5]
                ]
              }
            ]
          }
        ]
      },
      /^regions\[0\]: shapes\[1\]: points must be at least 3 points, each as \[x, y\]\. Nothing was written\.$/
    ],
    [
      "a rectangle without a width at this frame",
      { frame: { width: 10000, height: 8000 }, regions: [{ name: "B", shapes: [box(0, 0, 4, 100)] }] },
      /shapes\[0\]: width must be above 0 once rounded to whole scene pixels at this frame\./
    ],
    [
      "a shape type Foundry does not have",
      { regions: [{ name: "B", shapes: [{ type: "square" }] }] },
      /shapes\[0\]: its type must be one of rectangle, /
    ],
    [
      "a field of a shape that Foundry does not store",
      { regions: [{ name: "B", shapes: [{ ...box(0, 0), depth: 3 }] }] },
      /^regions\[0\]: No such field: shapes\.0\.depth\./
    ],
    ["a level the scene does not have", { levels: ["attic"], regions: [good] }, /Unknown level ids .*attic/],
    [
      "two entries of one name",
      { regions: [good, good] },
      /^regions\[0\] and regions\[1\] are both named "Good"\. The sync finds a region by its name/
    ],
    [
      "a key Foundry keeps itself",
      { regions: [{ ...good, _id: "abcdefgh12345678" }] },
      /^regions\[0\]: _id cannot be given: Foundry keeps it itself\./
    ],
    [
      "the bridge's own flag",
      { regions: [{ ...good, flags: { "foundry-mcp": { managed: false } } }] },
      /flags\.foundry-mcp cannot be given: it is the bridge's own flag/
    ],
    [
      "a value Foundry's model refuses",
      { regions: [{ ...good, visibility: 9 }] },
      /^regions\[0\]: Foundry's Region model refuses the data: /
    ],
    [
      "a value Foundry would store as another",
      { regions: [{ ...good, hidden: "yes" }] },
      /hidden: "yes" would be stored as false/
    ],
    [
      "a behavior type Foundry does not have",
      { regions: [{ ...good, behaviors: [{ type: "openPortal" }] }] },
      /^regions\[0\]\.behaviors\[0\]: Unknown region behavior type "openPortal"\. Use one of: changeLevel, /
    ],
    [
      "a field of a behavior that its type does not store",
      { regions: [{ ...good, behaviors: [{ type: "pauseGame", system: { twice: true } }] }] },
      /^regions\[0\]\.behaviors\[0\]: No such field: system\.twice\./
    ],
    [
      "two behaviors of one type and name",
      { regions: [{ ...good, behaviors: [{ type: "pauseGame" }, { type: "pauseGame" }] }] },
      /^regions\[0\]\.behaviors\[0\] and regions\[0\]\.behaviors\[1\] are both the behavior pauseGame "pauseGame"\. The sync finds a behavior of a region by its type and its name/
    ]
  ];
  for (const [what, args, message] of cases) {
    it(`refuses ${what} before anything is written`, async () => {
      await assert.rejects(sync(args), refused("invalid_params", message));
      assert.deepEqual([writes(), scene.regions.size], [[], 0]);
    });
  }

  it("refuses the same faults in a region that exists, and leaves it as it is", async () => {
    const region = bridgeMade({ name: "Good", shapes: [storedBox(0, 0)] });
    const before = structuredClone(region._source);
    for (const [fields, message] of [
      [{ colour: "#fff" }, /No such field: colour/],
      [{ visibility: 9 }, /Foundry's Region model refuses the data/],
      [{ hidden: "yes" }, /would be stored as false/],
      [{ shapes: [box(0, 0, 0, 5)] }, /width must be above 0/]
    ] as const) {
      await assert.rejects(sync({ regions: [{ ...good, ...fields }] }), refused("invalid_params", message));
    }
    assert.deepEqual([writes(), region._source], [[], before]);
  });

  it("refuses two bridge-made regions of one name in the level set, naming them", async () => {
    const one = bridgeMade({ name: "Good", levels: ["upper"] });
    const two = bridgeMade({ name: "Good", levels: ["upper"] });
    bridgeMade({ name: "Good", levels: ["lvl1"] });
    await assert.rejects(
      sync({ levels: ["upper"], regions: [good] }),
      refused(
        "invalid_params",
        new RegExp(
          `^regions\\[0\\]: 2 bridge-made regions of this level set are named "Good" \\(${one.id}, ${two.id}\\)\\.`
        )
      )
    );
    assert.deepEqual(writes(), []);
  });

  it("names what was written when Foundry fails midway, and a rerun writes what still differs", async () => {
    bridgeMade({ name: "Old" });
    world.control.documentError = (action: string) => (action === "delete" ? "connection lost" : undefined);
    await assert.rejects(
      sync({ regions: [good] }),
      refused(
        "foundry_error",
        /^Foundry failed while deleting the regions the call does not name \(connection lost\)\. Written before that, as the stored data shows: region Good \(\w+\) created\. Running the call again writes what still differs\.$/
      )
    );
    world.control.documentError = null;
    const again = await sync({ regions: [good] });
    assert.deepEqual([again.created, again.updated, again.deleted], [0, 0, 1]);
    assert.deepEqual(
      scene.regions.map((region: any) => region.name),
      ["Good"]
    );
  });

  it("gives an entry Foundry created nothing for an error in place of its id, and reports a change a hook refused", async () => {
    world.control.vetoDocument = (_document: string, data: Record<string, any>) => data.name === "Blocked";
    const result = await sync({ regions: [{ ...good, name: "Blocked" }, good] });
    assert.equal(result.created, 1);
    assert.deepEqual(
      [result.regions[0].name, result.regions[0].id, result.regions[0].created],
      ["Blocked", undefined, false]
    );
    assert.match(result.regions[0].error, /Foundry created nothing for this entry/);
    world.control.vetoDocument = null;
    world.control.vetoDocumentUpdate = () => true;
    const kept = await sync({ regions: [{ ...good, color: "#010203" }] });
    assert.deepEqual([kept.updated, kept.regions[0].changed, kept.regions[0].unapplied], [0, [], ["color"]]);
  });
});

describe("sync_regions with the regions get_scene returns", () => {
  let world: World;
  let scene: any;
  let sync: ReturnType<typeof setUp>["sync"];
  let writes: ReturnType<typeof setUp>["writes"];
  beforeEach(() => {
    ({ world, scene, sync, writes } = setUp());
  });

  it("writes nothing when they are passed back as they are, with frame, behaviors and destinations", async () => {
    const byHand = world.addDocument("Region", { name: "Altar", levels: ["upper"] }, { parent: scene });
    world.addDocument("Region", { name: "Cellar", levels: ["lvl1"], flags: MANAGED }, { parent: scene });
    await sync({
      frame: { width: 500, height: 400 },
      levels: ["upper"],
      regions: [
        {
          name: "Door",
          elevation: { bottom: 20, top: null },
          shapes: [box(10, 10, 30, 30), { type: "ellipse", x: 100, y: 100, radiusX: 20, radiusY: 10, hole: true }],
          behaviors: [
            { type: "teleportToken", system: { destinations: [{ region: "Cellar" }], choice: true } },
            { type: "pauseGame", name: "Halt" }
          ]
        }
      ]
    });
    const door = scene.regions.find((region: any) => region.name === "Door");
    world.addDocument("RegionBehavior", { type: "executeScript", name: "Alarm" }, { parent: door });
    const read = await viaTool("get_scene", { sceneId: scene.id });
    assert.deepEqual(
      read.regions.map((region: any) => [region.name, region.managed]),
      [
        ["Altar", false],
        ["Cellar", true],
        ["Door", true]
      ]
    );
    const before = writes();
    const result = await sync({ levels: ["upper"], regions: read.regions });
    assert.deepEqual(writes(), before);
    assert.deepEqual(
      [result.created, result.updated, result.deleted, result.regions.map((region: any) => region.name)],
      [0, 0, 0, ["Door"]]
    );
    assert.deepEqual(
      result.regions[0].behaviors.map((behavior: any) => [behavior.name, behavior.changed]),
      [
        ["", []],
        ["Halt", []]
      ]
    );
    assert.ok(scene.regions.has(byHand.id));
  });

  it("refuses a call whose regions were all left out, which would otherwise delete the bridge-made ones", async () => {
    world.addDocument("Region", { name: "Altar", levels: ["upper"] }, { parent: scene });
    world.addDocument("Region", { name: "Cellar", levels: ["lvl1"], flags: MANAGED }, { parent: scene });
    world.addDocument("Region", { name: "Loft", levels: ["upper"], flags: MANAGED }, { parent: scene });
    const read = await viaTool("get_scene", { sceneId: scene.id });
    const others = read.regions.filter((region: any) => region.name !== "Loft");
    await assert.rejects(
      sync({ levels: ["upper"], regions: others }),
      refused(
        "invalid_params",
        /^All 2 given regions were left out: .*regions: \[\] to remove the bridge-made regions of this level set\. Nothing was written\.$/
      )
    );
    assert.deepEqual([writes(), scene.regions.size], [[], 3]);
  });
});
