import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { changeNotes } from "../scripts/release-notes.mjs";

const template = await readFile(new URL("../.github/pull_request_template.md", import.meta.url), "utf8");

describe("release notes", () => {
  it("publishes the author's bullet from the PR template, including inline Markdown", () => {
    const text = "Added hex grid support to `ensure_scene`.";
    assert.deepEqual(changeNotes("refactor: grid types", `${template.trimEnd()} ${text}\r\n`), [
      { section: "Features", text }
    ]);
  });

  it("leaves an explicitly internal PR out even if its title describes a fix", () => {
    assert.deepEqual(changeNotes("fix: reduce CI retries", `${template.trimEnd()} N/A`), []);
  });

  it("uses the PR title if the template still contains only its instructions", () => {
    assert.deepEqual(changeNotes("Scenes: Show a preview", template), [
      { section: "Other changes", text: "Scenes: Show a preview" }
    ]);
  });

  it("groups direct commits in a release that has no PRs", () => {
    assert.deepEqual(changeNotes("feat: support hex grids"), [{ section: "Features", text: "support hex grids" }]);
    assert.deepEqual(changeNotes("fix(scene): preserve walls"), [{ section: "Fixes", text: "preserve walls" }]);
    assert.deepEqual(changeNotes("perf: speed up rendering"), [
      { section: "Improvements", text: "speed up rendering" }
    ]);
    assert.deepEqual(changeNotes("feat!: rename a tool"), [{ section: "Breaking changes", text: "rename a tool" }]);
    assert.deepEqual(changeNotes("chore: release 0.6.0"), []);
  });
});
