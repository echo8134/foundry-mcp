import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const json = async (path: string) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));

const REPO = "https://github.com/echo8134/foundry-mcp";

describe("the release a Foundry server installs from the manifest link", () => {
  it("names one version in the module, the server package and its lock file", async () => {
    const [module, pkg, lock] = await Promise.all([
      json("module/module.json"),
      json("package.json"),
      json("package-lock.json")
    ]);
    assert.deepEqual(
      [pkg.version, lock.version, lock.packages[""].version],
      [module.version, module.version, module.version]
    );
  });

  it("points the manifest at the latest release and the download at the release of its own version", async () => {
    const module = await json("module/module.json");
    assert.deepEqual(
      [module.manifest, module.download],
      [`${REPO}/releases/latest/download/module.json`, `${REPO}/releases/download/v${module.version}/module.zip`]
    );
  });
});
