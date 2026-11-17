import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { folderPath, folderScope, isUnder, listFolderPaths, resolveFolderPath } from "../module/scripts/folders.mjs";

describe("folders", () => {
  const folders = [
    { id: "a", name: "Chapter 5", parentId: null },
    { id: "b", name: "Holoth", parentId: "a" },
    { id: "c", name: "Tower", parentId: "b" },
    { id: "d", name: "Holoth", parentId: null }
  ];

  it("derives a folder's path from the root", () => {
    assert.deepEqual(folderPath(folders, "c"), ["Chapter 5", "Holoth", "Tower"]);
    assert.deepEqual(folderPath(folders, null), []);
    assert.equal(folderPath(folders, "ghost"), null);
  });

  it("does not loop on records that name each other as parents", () => {
    assert.equal(
      folderPath(
        [
          { id: "x", name: "X", parentId: "y" },
          { id: "y", name: "Y", parentId: "x" }
        ],
        "x"
      ),
      null
    );
  });

  it("lists every folder with its path, ordered by path", () => {
    assert.deepEqual(
      listFolderPaths(folders).map((f) => f.path),
      [["Chapter 5"], ["Chapter 5", "Holoth"], ["Chapter 5", "Holoth", "Tower"], ["Holoth"]]
    );
  });

  it("tells which paths lie under a prefix, the prefix itself included", () => {
    assert.equal(isUnder(["Chapter 5", "Holoth"], ["Chapter 5"]), true);
    assert.equal(isUnder(["Chapter 5"], ["Chapter 5"]), true);
    assert.equal(isUnder(["Holoth"], ["Chapter 5"]), false);
    assert.equal(isUnder(["Chapter 5"], ["Chapter 5", "Holoth"]), false);
  });

  it("resolves a path, and says which names are missing", () => {
    assert.deepEqual(resolveFolderPath(folders, ["Chapter 5", "Holoth"]), {
      chain: [folders[0], folders[1]],
      missing: [],
      ambiguous: null
    });
    assert.deepEqual(resolveFolderPath(folders, ["Chapter 5", "Gates", "Inner"]), {
      chain: [folders[0]],
      missing: ["Gates", "Inner"],
      ambiguous: null
    });
    assert.deepEqual(resolveFolderPath(folders, []), { chain: [], missing: [], ambiguous: null });
    assert.deepEqual(resolveFolderPath(folders, ["Nope"]), { chain: [], missing: ["Nope"], ambiguous: null });
  });

  it("reports two same-named folders under one parent as ambiguous", () => {
    const twins = [...folders, { id: "e", name: "Holoth", parentId: null }];
    assert.deepEqual(resolveFolderPath(twins, ["Holoth", "Tower"]).ambiguous, ["Holoth"]);
  });

  it("scopes to a folder and everything under it, to everything for no path or [], and to nothing for an unknown path", () => {
    const scope = folderScope(folders, ["Chapter 5", "Holoth"]);
    assert.deepEqual(
      scope?.folders.map((f) => f.id),
      ["b", "c"]
    );
    assert.equal(scope?.inScope(["Chapter 5", "Holoth", "Tower"]), true);
    assert.equal(scope?.inScope(["Chapter 5"]), false);
    for (const everything of [undefined, []]) {
      const all = folderScope(folders, everything);
      assert.equal(all?.folders.length, 4);
      assert.equal(all?.inScope([]), true);
    }
    assert.equal(folderScope(folders, ["Chapter 5", "Gates"]), null);
    assert.equal(folderScope(folders, ["Holoth", "Tower"]), null, "a path must name a folder that exists");
  });
});
