import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyWall, WALL_KIND_NAMES, wallFields } from "../module/scripts/wall-kinds.mjs";

describe("wall kinds", () => {
  it("lists all seven kinds", () => {
    assert.equal(WALL_KIND_NAMES.length, 7);
  });

  for (const kind of WALL_KIND_NAMES) {
    it(`classifies a built ${kind} as ${kind}`, () => {
      assert.equal(classifyWall(wallFields(kind, 5)), kind);
    });
  }

  it("builds a plain wall as fully blocking with no door", () => {
    assert.deepEqual(wallFields("wall", 5), { light: 20, sight: 20, sound: 20, move: 20, door: 0 });
  });

  it("gives windows a two grid unit threshold", () => {
    const fields = wallFields("window", 5);
    assert.deepEqual(fields.threshold, { light: 10, sight: 10, attenuation: true });
  });

  it("classifies an unlisted combination as custom", () => {
    assert.equal(classifyWall({ light: 20, sight: 0, sound: 20, move: 20, door: 0 }), "custom");
    assert.equal(classifyWall({ light: 20, sight: 20, sound: 20, move: 20, door: 7 }), "custom");
  });

  it("maps door states to Foundry's door state codes and adds them only when given", () => {
    assert.equal(wallFields("door", 5, "closed").ds, 0);
    assert.equal(wallFields("door", 5, "open").ds, 1);
    assert.equal(wallFields("secret-door", 5, "locked").ds, 2);
    assert.equal("ds" in wallFields("door", 5), false);
  });

  it("does not change how a door with a state classifies", () => {
    assert.equal(classifyWall(wallFields("door", 5, "locked")), "door");
  });
});
