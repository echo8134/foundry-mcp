import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeWorld } from "./fake-world.ts";
import { refused, restoreGlobals, viaTool } from "./token-world.ts";

afterEach(restoreGlobals);

const HP = "hitPoints0000001";
const GRANT = "itemGrant0000001";
const ADDED = { feature000000001: "Compendium.dnd5e.items.Item.feature000000002" };

for (const tool of ["ensure_actor", "update_documents"] as const) {
  describe(`${tool} writing advancements on an actor's item`, () => {
    let world: ReturnType<typeof fakeWorld>;
    beforeEach(() => {
      world = fakeWorld();
      world.install();
    });

    function onItem(type: string, advancement: Record<string, unknown>) {
      const actor = world.addActor({ type: "character", items: [{ name: "Source", type, system: { advancement } }] });
      const [item] = actor.items.values();
      return {
        entries: () => item.toObject().system.advancement,
        write: async (entries: Record<string, unknown>) => {
          const system = { advancement: entries };
          if (tool === "ensure_actor") {
            const result = await viaTool(tool, { actor: actor.id, items: [{ id: item.id, system }] });
            return result.items[0];
          }
          const result = await viaTool(tool, { documents: [{ uuid: item.uuid, data: { system } }] });
          return result.documents[0];
        }
      };
    }

    const hp = { _id: HP, type: "HitPoints", value: { 1: "max" }, configuration: {} };
    const grant = { _id: GRANT, type: "ItemGrant", value: {}, configuration: { optional: false } };

    it("records hit points by level and keeps levels omitted from a partial update", async () => {
      const { write, entries } = onItem("class", { [HP]: hp });
      assert.deepEqual(
        (await write({ [HP]: { type: "HitPoints", configuration: {}, value: { 2: 8, 3: 5 } } })).unapplied,
        []
      );
      assert.deepEqual((await write({ [HP]: { value: { 4: "avg", 5: "max" } } })).unapplied, []);
      assert.deepEqual(entries()[HP].value, { 1: "max", 2: 8, 3: 5, 4: "avg", 5: "max" });
      assert.deepEqual((await write({ [HP]: { value: { 2: 8, 3: 5 } } })).changed, []);
    });

    for (const type of ["class", "subclass", "race", "background"]) {
      it(`records an ItemGrant on a ${type} and checks its modeled configuration`, async () => {
        const { write, entries } = onItem(type, { [GRANT]: grant });
        const change = { [GRANT]: { value: { added: ADDED }, configuration: { optional: true } } };
        assert.deepEqual((await write(change)).unapplied, []);
        assert.deepEqual(entries()[GRANT].value, { added: ADDED });
        assert.equal(entries()[GRANT].configuration.optional, true);
        assert.deepEqual((await write(change)).changed, []);
      });
    }

    it("requires a type for a new advancement", async () => {
      const { write, entries } = onItem("class", {});
      await assert.rejects(write({ [HP]: { value: { 1: "max" } } }), refused("invalid_params", /type/));
      assert.deepEqual(entries(), {});
      assert.deepEqual(world.log.embedded, []);
    });

    it("rejects invalid hit-point levels and values before writing", async () => {
      const { write, entries } = onItem("class", { [HP]: hp });
      for (const value of [{ zero: 3 }, { 0: 3 }, { 2: "eight" }, { 2: 2.5 }, [8]]) {
        await assert.rejects(write({ [HP]: { value } }), refused("invalid_params", /\.value/));
      }
      assert.deepEqual(entries()[HP], hp);
      assert.deepEqual(world.log.embedded, []);
    });

    it("rejects unknown configuration fields and reserved keys nested in an ItemGrant record", async () => {
      const { write, entries } = onItem("subclass", { [GRANT]: grant });
      await assert.rejects(
        write({ [GRANT]: { configuration: { optionl: true } } }),
        refused("invalid_params", /optionl/)
      );
      await assert.rejects(
        write({ [GRANT]: { value: { added: { "-=old": null } } } }),
        refused("invalid_params", /-=old/)
      );
      assert.deepEqual(entries()[GRANT], grant);
      assert.deepEqual(world.log.embedded, []);
    });
  });
}
