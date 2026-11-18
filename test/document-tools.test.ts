import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BridgeError } from "../src/hub.ts";
import { TOOLS } from "../src/tools.ts";
import { connect, text } from "./tool-client.ts";

describe("MCP tools for reading any document", () => {
  it("sends list_documents and get_document to the bridge as given, with the name and the folder names trimmed", async () => {
    const { client, calls } = await connect(() => ({}));
    const listing = {
      type: "JournalEntryPage",
      parent: "JournalEntry.abc",
      name: " gods ",
      subtype: "text"
    };
    const inPack = { type: "Item", pack: "dnd5e.items", folder: [" Weapons ", "Swords"] };
    for (const args of [listing, inPack]) {
      assert.notEqual((await client.callTool({ name: "list_documents", arguments: args })).isError, true);
    }
    await client.callTool({ name: "get_document", arguments: { uuid: " Compendium.dnd5e.items.Item.abc " } });
    assert.deepEqual(
      calls.map((call) => [call.method, call.params, call.timeoutMs]),
      [
        ["list_documents", { ...listing, name: "gods" }, 30_000],
        ["list_documents", { ...inPack, folder: ["Weapons", "Swords"] }, 30_000],
        ["get_document", { uuid: "Compendium.dnd5e.items.Item.abc" }, 30_000]
      ]
    );
  });

  it("takes every document type of Foundry for list_documents, and for get_schema also Activity, Advancement and Config", () => {
    for (const type of [
      "ActiveEffect",
      "Adventure",
      "Cards",
      "ChatMessage",
      "Combat",
      "Folder",
      "RollTable",
      "Setting",
      "User",
      "Wall"
    ]) {
      assert.equal(TOOLS.list_documents.input.safeParse({ type }).success, true, type);
      assert.equal(TOOLS.get_schema.input.safeParse({ document: type }).success, true, type);
    }
    for (const document of ["Activity", "Advancement", "Config"]) {
      assert.equal(TOOLS.get_schema.input.safeParse({ document }).success, true, document);
      assert.equal(TOOLS.list_documents.input.safeParse({ type: document }).success, false, document);
    }
  });

  for (const [label, name, args, message] of [
    ["list_documents without a type", "list_documents", {}, /at type$/],
    [
      "list_documents with a type Foundry does not have",
      "list_documents",
      { type: "Spell" },
      /Invalid option.* at type$/
    ],
    ["list_documents with a blank parent", "list_documents", { type: "Item", parent: " " }, /at parent$/],
    [
      "list_documents with an input it does not have",
      "list_documents",
      { type: "Item", actor: "a1" },
      /Unrecognized key: "actor"/
    ],
    ["get_document without a uuid", "get_document", {}, /at uuid$/],
    ["get_document with a blank uuid", "get_document", { uuid: "  " }, /at uuid$/],
    ["get_schema for a document Foundry does not have", "get_schema", { document: "Spell" }, /at document$/]
  ] as const) {
    it(`refuses ${label} before any request is sent`, async () => {
      const { client, calls } = await connect(() => ({}));
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.match(text(result), message);
      assert.equal(calls.length, 0);
    });
  }

  it("tells a caller where list_documents reads, what each entry holds and where the list ends", async () => {
    const listing = TOOLS.list_documents.description;
    for (const said of [
      /Without parent and pack it lists the documents of the world/,
      /parent, the UUID of a document, lists that document's embedded documents of the type/,
      /lists that pack from its index and loads none of its documents/,
      /a combination that leads nowhere is refused with what to pass instead/,
      /managed \(true when this bridge made it\)/,
      /At most 200 documents come back: total says how many matched and truncated whether the list was cut/,
      /of chat messages the newest 200 are kept/,
      /packs \[\{id, title, locked\}\]/
    ]) {
      assert.match(listing, said);
    }
  });

  it("tells a caller what get_document returns, that data goes back to update_documents, and what it never returns", async () => {
    const reading = TOOLS.get_document.description;
    for (const said of [
      /in the shape update_documents takes: change a value and pass data back, and what was not changed writes nothing/,
      /data leaves out the embedded documents/,
      /embedded lists the embedded documents by their document type, each \{uuid, id, name, type\}/,
      /embeddedTotals names the types that have more/,
      /A user's password and passwordSalt are never returned/,
      /its value is whatever the system or a module stored, which can include an access key of a service/
    ]) {
      assert.match(reading, said);
    }
    assert.match(TOOLS.get_schema.description, /The stored field names of any document type/);
    assert.match(TOOLS.get_schema.description, /A document without types, such as Token, JournalEntry or User/);
  });
});

describe("MCP tools for writing any document", () => {
  const journal = {
    type: "JournalEntry",
    documents: [{ name: " Lore ", pages: [{ name: "Gods", anything: ["the", "module", "checks"] }] }]
  };
  const changes = {
    documents: [{ uuid: " JournalEntry.abc ", data: { name: " Lore " }, remove: [" flags.world.note "] }]
  };
  const deletion = { uuids: [" JournalEntry.abc ", "Macro.def"], handMade: true };

  it("sends the three write tools to the bridge with the document data untouched, and UUIDs and paths trimmed", async () => {
    const { client, calls } = await connect(() => ({}));
    for (const [name, args] of [
      ["create_documents", journal],
      ["create_documents", { type: "JournalEntryPage", parent: " JournalEntry.abc ", documents: [{ name: "Gods" }] }],
      ["create_documents", { type: "Item", pack: "world.loot", documents: [{ name: "Rope", type: "loot" }] }],
      ["update_documents", changes],
      ["delete_documents", deletion]
    ] as const) {
      assert.notEqual((await client.callTool({ name, arguments: args })).isError, true, name);
    }
    assert.deepEqual(
      calls.map((call) => [call.method, call.params, call.timeoutMs]),
      [
        ["create_documents", journal, 90_000],
        [
          "create_documents",
          { type: "JournalEntryPage", parent: "JournalEntry.abc", documents: [{ name: "Gods" }] },
          90_000
        ],
        ["create_documents", { type: "Item", pack: "world.loot", documents: [{ name: "Rope", type: "loot" }] }, 90_000],
        [
          "update_documents",
          { documents: [{ uuid: "JournalEntry.abc", data: { name: " Lore " }, remove: ["flags.world.note"] }] },
          90_000
        ],
        ["delete_documents", { uuids: ["JournalEntry.abc", "Macro.def"], handMade: true }, 30_000]
      ]
    );
  });

  for (const [label, name, args, message] of [
    [
      "create_documents without documents",
      "create_documents",
      { type: "Macro", documents: [] },
      />=1 items at documents$/
    ],
    ["create_documents without a type", "create_documents", { documents: [{ name: "A" }] }, /at type$/],
    [
      "create_documents with a type Foundry does not have",
      "create_documents",
      { type: "Spell", documents: [{}] },
      /at type$/
    ],
    [
      "create_documents with a document that is no object",
      "create_documents",
      { type: "Macro", documents: ["Roll"] },
      /expected record.* at documents\[0\]$/
    ],
    [
      "create_documents with an input it does not have",
      "create_documents",
      { type: "Macro", documents: [{ name: "A" }], folder: ["Macros"] },
      /Unrecognized key: "folder"/
    ],
    ["update_documents without documents", "update_documents", { documents: [] }, />=1 items at documents$/],
    [
      "update_documents with an entry without a uuid",
      "update_documents",
      { documents: [{ data: {} }] },
      /at documents\[0\]\.uuid$/
    ],
    [
      "update_documents with an entry that has a key it does not take",
      "update_documents",
      { documents: [{ uuid: "Macro.a", name: "Roll" }] },
      /Unrecognized key: "name"/
    ],
    [
      "update_documents with data that is no object",
      "update_documents",
      { documents: [{ uuid: "Macro.a", data: "Roll" }] },
      /expected record.* at documents\[0\]\.data$/
    ],
    ["delete_documents without uuids", "delete_documents", { uuids: [] }, />=1 items at uuids$/],
    ["delete_documents with a blank uuid", "delete_documents", { uuids: ["Macro.a", " "] }, /at uuids\[1\]$/],
    [
      "delete_documents with handMade false",
      "delete_documents",
      { uuids: ["Macro.a"], handMade: false },
      /expected true at handMade$/
    ],
    [
      "delete_documents with an input it does not have",
      "delete_documents",
      { uuids: ["Macro.a"], all: true },
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

  for (const [tool, args, advice] of [
    [
      "create_documents",
      journal,
      /Check with list_documents before retrying: running it again creates the documents again/
    ],
    [
      "update_documents",
      changes,
      /Running the same call again is safe: it writes only what still differs\. A password is the exception/
    ],
    ["delete_documents", deletion, /Running the same call again is safe: it ignores what is already gone/]
  ] as const) {
    it(`a timeout on ${tool} warns that it may have been applied, and says how to go on`, async () => {
      const { client } = await connect(() => {
        throw new BridgeError("timeout", "Foundry did not answer.");
      });
      const result = await client.callTool({ name: tool, arguments: args });
      assert.match(text(result), /may still have been applied in Foundry/);
      assert.match(text(result), advice);
    });
  }

  it("names the writes that reach past a document in the tools that make them", () => {
    for (const tool of ["create_documents", "update_documents"] as const) {
      const { description } = TOOLS[tool];
      assert.match(
        description,
        /A User is an account: the join page of a Foundry server can be reached by anyone who has its address/,
        tool
      );
      assert.match(description, /Role 3 \(Assistant GM\) and role 4 \(Gamemaster\) both count as a Gamemaster/, tool);
      assert.match(description, /a user's permissions give or take single rights by name whatever the role says/, tool);
      assert.match(description, /ownership decides which players see and change a document/, tool);
      assert.match(description, /A ChatMessage is shown to every connected player the moment it is created/, tool);
      assert.match(
        description,
        /The command of a Macro of the type script is code: it runs in the browser of whoever runs the macro/,
        tool
      );
      assert.match(description, /Some modules run code they find in flags/, tool);
      assert.match(
        description,
        /Code that Foundry runs by itself is not written at all: a RegionBehavior of the type executeScript or executeMacro is not created/,
        tool
      );
      assert.match(description, /A Setting .*not written by this tool/, tool);
    }
    assert.match(TOOLS.create_documents.description, /A new User needs a password that is not blank/);
    assert.match(
      TOOLS.update_documents.description,
      /one that is given is written on every call, and Foundry logs that user out/
    );
    assert.match(
      TOOLS.update_documents.description,
      /It cannot be made blank or removed, passwordSalt cannot be given/
    );
  });

  it("tells a caller what the write tools promise: checks before writing, managed flags, repeats and what a deletion takes along", () => {
    const { create_documents: create, update_documents: update, delete_documents: remove } = TOOLS;
    assert.match(
      create.description,
      /Everything is checked before anything is written, and the whole call is refused when one entry cannot be built/
    );
    assert.match(
      create.description,
      /Every document made here, and every embedded document made with it, is flagged as bridge-made/
    );
    assert.match(create.description, /has error in place of its uuid, and the entries after it are still created/);
    assert.match(create.description, /Not safe to repeat/);
    assert.match(
      update.description,
      /data read with get_document and passed back unchanged writes nothing, and the same call again writes nothing/
    );
    assert.match(update.description, /The embedded documents of a document are not taken inside its data/);
    assert.match(remove.description, /Foundry cannot bring a deleted document back, and there is no undo/);
    assert.match(remove.description, /Foundry deletes a document together with everything embedded in it/);
    assert.match(
      remove.description,
      /Deleting a Folder deletes the folder alone: the documents in it move to its parent folder, and so does every folder below it, at any depth/
    );
    assert.match(
      remove.description,
      /is deleted only with handMade: true: without it the whole call is refused, names those documents and deletes nothing/
    );
    for (const tool of [create, update, remove]) {
      assert.match(
        tool.description,
        /the tools made for them do more and are the better choice: ensure_actor and delete_actors, place_tokens/
      );
    }
  });
});
