import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BridgeError } from "../src/hub.ts";
import { TOOLS } from "../src/tools.ts";
import { connect, text } from "./tool-client.ts";

describe("MCP tools for actors", () => {
  it("sends ensure_actor and delete_actors to the bridge unchanged, the first with the long timeout", async () => {
    const { client, calls } = await connect(() => ({}));
    const ensure = {
      name: "Bandit",
      type: "npc",
      folder: ["Monsters"],
      from: "Compendium.dnd5e.actors24.Actor.abc",
      img: "art/bandit.webp",
      system: { attributes: { hp: { max: 11 } }, anything: { the: ["module", "checks"] } },
      prototypeToken: { name: "Bandit" },
      ownership: { default: 0 },
      flags: { world: { note: "x" } },
      remove: ["system.tools.thief"]
    };
    const remove = { ids: ["a1", "a2"], handMade: true };
    assert.notEqual((await client.callTool({ name: "ensure_actor", arguments: ensure })).isError, true);
    assert.notEqual(
      (await client.callTool({ name: "ensure_actor", arguments: { actor: "a1", img: null } })).isError,
      true
    );
    assert.notEqual((await client.callTool({ name: "delete_actors", arguments: remove })).isError, true);
    assert.deepEqual(
      calls.map((call) => [call.method, call.params, call.timeoutMs]),
      [
        ["ensure_actor", ensure, 90_000],
        ["ensure_actor", { actor: "a1", img: null }, 90_000],
        ["delete_actors", remove, 30_000]
      ]
    );
  });

  it("sends the items and effects of ensure_actor to the bridge as given, with their names trimmed", async () => {
    const { client, calls } = await connect(() => ({}));
    const args = {
      actor: "a1",
      items: [
        {
          name: " Bite ",
          type: "feat",
          system: { activities: { bite: { type: "attack", anything: ["the", "module", "checks"] } } },
          flags: { world: { note: "x" } },
          effects: [{ _id: "poison", name: " Poisoned ", system: { changes: [] }, anything: 1 }],
          remove: ["system.activities.old"],
          removeEffects: ["old"]
        },
        { id: "i1", img: null },
        { from: "Compendium.dnd5e.spells24.Item.abc" }
      ],
      removeItems: ["i2"],
      effects: [{ name: "Rage", disabled: true }],
      removeEffects: ["rage"]
    };
    assert.notEqual((await client.callTool({ name: "ensure_actor", arguments: args })).isError, true);
    const sent = structuredClone(args);
    sent.items[0]!.name = "Bite";
    sent.items[0]!.effects![0]!.name = "Poisoned";
    assert.deepEqual(calls[0]!.params, sent);
    await client.callTool({ name: "get_actor", arguments: { actor: "a1", items: ["i1"], effects: ["e1"] } });
    assert.deepEqual(calls[1]!.params, { actor: "a1", items: ["i1"], effects: ["e1"] });
  });

  it("tells a caller of ensure_actor how items, activities and effects are found and what dnd5e does with them", async () => {
    const { client } = await connect(() => ({}));
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((t) => t.name === name)!.description ?? "";
    const ensure = description("ensure_actor");
    for (const said of [
      /items adds or changes items and never deletes one/,
      /bridge-made item of exactly that name and type: one is changed, none is created, several are refused/,
      /a name that only an item made by hand has, with its id/,
      /from starts a new item as a copy and is not applied again/,
      /that is no 16-character id is a label, which always becomes the same id/,
      /A new activity needs type/,
      /range: \{value: "5", units: "ft"\}/,
      /remove in an entry deletes entries of that item \(system\.activities\.bite\)/,
      /an activity of the same call names it in its effects as \{_id\}/,
      /system\.changes \[\{key, type: "add", value: "2"\}\]/,
      /removeItems and removeEffects delete by id and ignore ids that are not there/,
      /no advancement runs/,
      /system\.prepared: give 1 \(prepared\) or 2 \(always\)/,
      /dnd5e adds a copy of its spell as an item of its own shortly after the call returns/,
      /On a token's actor, items and effects are written for that token only/,
      /An entry Foundry created nothing for has error in place of its id/
    ]) {
      assert.match(ensure, said);
    }
    assert.match(
      description("get_actor"),
      /effect ids as effects to get their full stored data in itemData and effectData/
    );
    assert.match(description("get_actor"), /passed back in an items entry of ensure_actor with its _id as id/);
  });

  it("trims an actor's name and the names of its folder path before they reach the bridge", async () => {
    const { client, calls } = await connect(() => ({}));
    await client.callTool({
      name: "ensure_actor",
      arguments: { name: "  Bandit ", type: "npc", folder: [" Monsters "] }
    });
    assert.deepEqual(calls[0]!.params, { name: "Bandit", type: "npc", folder: ["Monsters"] });
  });

  for (const [label, name, args, message] of [
    [
      "ensure_actor without a name and without an actor",
      "ensure_actor",
      { type: "npc" },
      /Give a name, or an actor to change/
    ],
    [
      "ensure_actor with an input it does not have",
      "ensure_actor",
      { name: "Bandit", type: "npc", spells: [{ name: "Fire Bolt" }] },
      /Unrecognized key: "spells"/
    ],
    [
      "ensure_actor with an item entry that names no item",
      "ensure_actor",
      { name: "Bandit", items: [{ name: "Sword" }] },
      /Give id, or name and type, or from/
    ],
    [
      "ensure_actor with an item entry that has a key it does not take",
      "ensure_actor",
      { name: "Bandit", items: [{ name: "Sword", type: "weapon", sort: 5 }] },
      /Unrecognized key: "sort"/
    ],
    [
      "ensure_actor with an effect whose name is blank",
      "ensure_actor",
      { name: "Bandit", effects: [{ name: " " }] },
      /at effects\[0\]\.name$/
    ],
    [
      "ensure_actor with items that are no list",
      "ensure_actor",
      { name: "Bandit", items: { name: "Sword", type: "weapon" } },
      /at items$/
    ],
    [
      "ensure_actor with system data that is no object",
      "ensure_actor",
      { name: "Bandit", system: "strong" },
      /expected record.* at system$/
    ],
    ["ensure_actor with a blank name", "ensure_actor", { name: "  " }, /at name$/],
    ["delete_actors without ids", "delete_actors", { ids: [] }, />=1 items at ids$/],
    [
      "delete_actors with handMade false",
      "delete_actors",
      { ids: ["a1"], handMade: false },
      /expected true at handMade$/
    ],
    [
      "delete_actors with an input it does not have",
      "delete_actors",
      { ids: ["a1"], all: true },
      /Unrecognized key: "all"/
    ]
  ] as const) {
    it(`refuses ${label} before any request is sent`, async () => {
      const { client, calls } = await connect(() => ({}));
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.match(text(result), message);
      assert.equal(calls.length, 0);
    });
  }

  it("tells a caller of ensure_actor how the actor is found, what the data is, and what dnd5e stores", async () => {
    const { client } = await connect(() => ({}));
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((t) => t.name === name)!.description ?? "";
    const ensure = description("ensure_actor");
    assert.match(ensure, /bridge-made world actor of exactly that name in exactly that folder/);
    assert.match(ensure, /a name that only an actor made by hand has, with its id to pass as actor on purpose/);
    assert.match(ensure, /stored data in the shape get_actor returns and get_schema lists/);
    assert.match(ensure, /objects merge into what is stored, lists are replaced whole/);
    assert.match(ensure, /data read with get_actor and passed back unchanged writes nothing/);
    assert.match(description("get_actor"), /leave out a stored key that ensure_actor would refuse/);
    assert.match(description("get_actor"), /a token's actor has no prototypeToken/);
    assert.match(ensure, /remove deletes entries by dot path/);
    assert.match(
      ensure,
      /an entry of a map with fixed keys goes back to its defaults \(system\.abilities\.str to 10\)/
    );
    assert.match(ensure, /on a token's actor only what that token changed can be removed/);
    assert.match(ensure, /from copies an actor with its items and effects when the actor is created/);
    assert.match(ensure, /a new npc given hp\.max without hp\.value starts with value equal to max/);
    assert.match(ensure, /system\.attributes\.ac\.calcs \["natural"\] with ac\.flat/);
    assert.match(
      ensure,
      /sight range follows the actor's senses \(system\.attributes\.senses\.ranges\) while the senseVisionSync/
    );
    assert.match(ensure, /changed .*unapplied .*derived/);
    assert.doesNotMatch(ensure, /null deletes/);
    assert.match(description("delete_actors"), /handMade: true/);
    assert.match(description("delete_actors"), /still has tokens on a scene/);
    const shape = (TOOLS.ensure_actor.input as any).shape;
    assert.match(shape.ownership.description, /-1 inherit, 0 none, 1 limited, 2 observer, 3 owner/);
  });

  for (const tool of ["ensure_actor", "delete_actors"] as const) {
    it(`a timeout on ${tool} warns that it may have been applied, and says how to go on`, async () => {
      const { client } = await connect(() => {
        throw new BridgeError("timeout", "Foundry did not answer.");
      });
      const args = { ensure_actor: { name: "Bandit", type: "npc" }, delete_actors: { ids: ["a1"] } }[tool];
      const result = await client.callTool({ name: tool, arguments: args });
      assert.match(text(result), /may still have been applied in Foundry/);
      assert.match(
        text(result),
        tool === "ensure_actor"
          ? /list_actors before retrying, or run the same call again/
          : /list_actors before retrying/
      );
    });
  }
});
