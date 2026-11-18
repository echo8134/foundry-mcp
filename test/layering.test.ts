import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SCRIPTS = new URL("../module/scripts/", import.meta.url);

/** The modules that are about one kind of document, by the prefix of their file name. */
const OF_ONE_KIND = /^(actor|item|light|scene|token|wall)-/;

const importsOf = (file: string) =>
  [...readFileSync(new URL(file, SCRIPTS), "utf8").matchAll(/from "\.\/([a-z-]+\.mjs)"/g)].map((match) => match[1]!);

describe("the module scripts", () => {
  it("keep the modules that serve every document free of the modules of one kind of document", () => {
    const shared = readdirSync(SCRIPTS).filter(
      (file) => file.endsWith(".mjs") && !OF_ONE_KIND.test(file) && !["main.mjs", "methods.mjs"].includes(file)
    );
    assert.ok(shared.includes("write-checks.mjs") && shared.includes("document-writes.mjs"));
    const reaching = shared.flatMap((file) =>
      importsOf(file)
        .filter((imported) => OF_ONE_KIND.test(imported))
        .map((imported) => `${file} imports ${imported}`)
    );
    assert.deepEqual(reaching, []);
  });
});
