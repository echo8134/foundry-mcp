// The tools that read and write a document of any type.

import { z } from "zod";
import { DOCUMENT_TYPES } from "../module/scripts/document-types.mjs";
import { defineTool, folderPath, nonBlank, type ToolSpec } from "./tool-spec.ts";

const documentType = z.enum(DOCUMENT_TYPES);

// The module checks what a document's data holds against the live schema of its class, which the server cannot know.
const documentData = z.record(z.string(), z.unknown());

const SPECIAL_TOOLS =
  "For an Actor, a Token, a Wall, an AmbientLight and a Scene the tools made for them do more and are the better " +
  "choice: ensure_actor and delete_actors, place_tokens, update_tokens and delete_tokens, sync_walls, create_walls " +
  "and delete_walls, sync_lights, ensure_scene.";

const HIGH_STAKES =
  "Some writes reach past the document. A User is an account: the join page of a Foundry server can be reached by " +
  "anyone who has its address, so every user needs a password. Role 3 (Assistant GM) and role 4 (Gamemaster) both " +
  "count as a Gamemaster, who can do anything in the world, and a user's permissions give or take single rights " +
  "by name whatever the role says, such as MACRO_SCRIPT (to write script macros) and FILES_UPLOAD. ownership decides " +
  "which players see and change a document (by user id, and default: 0 none, 1 limited, 2 observer, 3 owner): a " +
  "wrong level shows players what the Gamemaster prepared in secret. A ChatMessage is shown to every connected " +
  "player the moment it is created, unless it has whisper. The command of a Macro of the type script is code: it " +
  "runs in the browser of whoever runs the macro, a player's too, and a user's hotbar puts macros under that user's " +
  "number keys. Some modules run code they find in flags, an item macro for example, so a flag written for such a " +
  "module can be code as well. Code that Foundry runs by itself is not written at all: a RegionBehavior of the type " +
  "executeScript or executeMacro is not created, alone or inside a region or a scene, its source or its macro is not " +
  "changed, and neither is the command of a macro that such a behavior names. The Gamemaster does these in Foundry.";

export const DOCUMENT_SPECS = {
  list_documents: defineTool({
    description:
      "List the documents of one Foundry document type. It works for every type: JournalEntry, Item, RollTable, " +
      "Macro, Playlist, Cards, ChatMessage, Combat, Folder, User, Setting and the rest, with whatever the system or a " +
      "module stores in them. Without parent and pack it lists the documents of the world. parent, the UUID of a " +
      "document, lists that document's embedded documents of the type: the JournalEntryPage of a JournalEntry, the " +
      "PlaylistSound of a Playlist, the TableResult of a RollTable, the Combatant of a Combat, the Item or " +
      "ActiveEffect of an Actor, the Wall or Token of a Scene. pack, a compendium pack id such as dnd5e.monsters, " +
      "lists that pack from its index and loads none of its documents. A type that exists only inside another " +
      "document needs parent, an Adventure needs pack, and a combination that leads nowhere is refused with what to " +
      "pass instead. Each document is {uuid, id, name (where the type has names), type (its subtype where the type " +
      "has subtypes, such as text for a journal page or npc for an actor), folder (path of folder names, in a " +
      "listing of the world or of a pack, for a type that folders hold), managed (true when this bridge made it)}. " +
      "Narrow by folder (that folder and everything under it), name (part of the name, any case) and subtype. Sorted " +
      "by folder path, then name. Chat messages are sorted by time, oldest first. At most 200 documents come back: " +
      "total says how many matched and truncated whether the list was cut, and of chat messages the newest 200 are " +
      "kept. For a type that folders hold the result also has folders [{id, path}], where id is what a document's " +
      "stored folder field takes. For a type that compendium packs hold it has packs [{id, title, locked}]: the packs " +
      "of that type in this world, whose id is what pack takes. get_document reads one document in full by its uuid. " +
      "list_actors and list_scenes say more about actors and scenes.",
    input: z.strictObject({
      type: documentType.describe("The document type, for example JournalEntry."),
      parent: nonBlank
        .optional()
        .describe("UUID of the document whose embedded documents to list, for example JournalEntry.<id>."),
      pack: nonBlank
        .optional()
        .describe("Compendium pack id, for example dnd5e.monsters, as packs of an earlier listing names it."),
      folder: folderPath.optional().describe('Folder path from the root, for example ["Lore", "Gods"].'),
      name: nonBlank.optional().describe("Part of the name, any case."),
      subtype: nonBlank
        .optional()
        .describe("A subtype of the document type, for example text for a JournalEntryPage. get_schema lists them.")
    })
  }),
  get_document: defineTool({
    description:
      "Read one document of any type by its UUID, as list_documents returns it. A compendium document is loaded for " +
      "this. Returns {uuid, documentName, id, name and type (where the document has them), parent (the UUID of the " +
      "document it is embedded in, or null), pack (the id of its compendium pack, or null) and for a pack document " +
      "locked, folder (path of folder names, for a type that folders hold), managed (true when this bridge made it), " +
      "data, embedded}. data is the document's stored data, with the field names and codes Foundry and the system " +
      "store (get_schema lists them), in the shape update_documents takes: change a value and pass data back, and " +
      "what was not changed writes nothing. data leaves out the embedded documents, and a stored key that " +
      "update_documents would refuse. embedded lists the embedded documents by their document type, each {uuid, id, " +
      "name, type}, to read with this tool by its uuid: the pages of a journal entry under JournalEntryPage, the " +
      "sounds of a playlist under PlaylistSound, the results of a table under TableResult, the items and effects of " +
      "an actor under Item and ActiveEffect. At most 200 of each are listed. embeddedTotals names the types that have " +
      "more, with how many: list_documents with this uuid as parent narrows them by name. A user's password and " +
      "passwordSalt are never returned. A world Setting can be read here, and its value is whatever the system or a " +
      "module stored, which can include an access key of a service. get_actor and get_scene say more about an actor " +
      "and a scene: derived numbers, placed tokens, and walls and lights in map coordinates.",
    input: z.strictObject({
      uuid: nonBlank.describe(
        "The document's UUID, for example JournalEntry.<id>, JournalEntry.<id>.JournalEntryPage.<id> or Compendium.<pack>.Item.<id>."
      )
    })
  }),
  create_documents: defineTool({
    ifOutcomeUnknown:
      " The call may still have been applied in Foundry. Check with list_documents before retrying: running it again " +
      "creates the documents again.",
    timeoutMs: 90_000,
    description:
      "Create documents of one Foundry document type, any type, from stored data. Without parent and pack they are " +
      "created in the world. parent, the UUID of a document, creates them embedded in it: a JournalEntryPage in a " +
      "JournalEntry, a PlaylistSound in a Playlist, a TableResult in a RollTable, a Combatant in a Combat, an Item or " +
      "an ActiveEffect in an Actor. pack, a compendium pack id, creates them in that pack. A type that exists only " +
      "inside another document needs parent, a parent must be of a type that holds such documents, a pack must hold " +
      "the type, and a locked pack is refused: the Gamemaster unlocks it in Foundry. Each entry of documents is the " +
      "stored data of one new document, with the fields get_schema lists, in the shape get_document returns as data. " +
      "A field left out takes Foundry's default. A type with subtypes takes type, such as text for a JournalEntryPage. " +
      "folder is a folder id from list_documents. Embedded documents can be given inside the data and are created " +
      'with it, for example a journal entry with a page: {name: "Lore", pages: [{name: "The Old Gods", type: "text", ' +
      'text: {content: "<p>...</p>"}}]}, or a playlist with sounds: {name: "Tavern", sounds: [{name: "Fire", path: ' +
      '"sounds/fire.ogg"}]}. Everything is checked before anything is written, and the whole call is refused when one ' +
      "entry cannot be built: an unknown or derived field, a key outside a map's fixed keys, an unknown subtype, data " +
      "Foundry's model refuses, a value Foundry would store as something else (named with what it would store), an " +
      "img that does not load, flags.foundry-mcp. Every document made here, and every embedded document made with it, " +
      "is flagged as bridge-made (managed: true). Returns {requested, created, documents: [{uuid, id, name, type, " +
      "unapplied}]} in the order given. unapplied names the given fields whose stored value is not the one asked for, " +
      "normally none: a hook, the system or the server changed them, as the server does with an _id or _stats given " +
      "for a new document. An entry Foundry created nothing for, because a hook or the system refused it, has error " +
      "in place of its uuid, and the entries after it are still created. If Foundry fails on an entry, the error " +
      "names it and the documents created before it, and the entries after it are not tried. Not safe to repeat: " +
      "each call creates the documents again. " +
      HIGH_STAKES +
      " A new User needs a password that is not blank and that neither begins nor ends with a space, and " +
      "passwordSalt cannot be given. A Setting and an ActorDelta are not written by this tool. " +
      SPECIAL_TOOLS,
    input: z.strictObject({
      type: documentType.describe("The document type to create, for example JournalEntry."),
      parent: nonBlank
        .optional()
        .describe("UUID of the document to create them in, for an embedded type: for example JournalEntry.<id>."),
      pack: nonBlank.optional().describe("Compendium pack id to create them in, for example world.handouts."),
      documents: z.array(documentData).min(1).describe("The stored data of each new document.")
    })
  }),
  update_documents: defineTool({
    ifOutcomeUnknown:
      " The call may still have been applied in Foundry. Running the same call again is safe: it writes only what " +
      "still differs. A password is the exception, it is written again.",
    timeoutMs: 90_000,
    description:
      "Change documents of any type by UUID, those made by hand too. Each entry is {uuid, data, remove}. data is " +
      "stored data in the shape get_document returns and get_schema lists: objects merge into what is stored, lists " +
      "are replaced whole, and only the fields whose value differs from the stored one are written. So data read " +
      "with get_document and passed back unchanged writes nothing, and the same call again writes nothing. remove " +
      "deletes entries by dot path: an entry of a keyed map, or a key below flags. A path with no entry is ignored. " +
      "Everything is checked before anything is written, and the whole call is refused when one entry cannot be " +
      "applied: a UUID nothing exists at, the same document twice, a document in a locked compendium pack (the " +
      "Gamemaster unlocks it in Foundry), a type or an _id other than the document's, which Foundry cannot change, an " +
      "unknown or derived field, a key outside a map's fixed keys, data Foundry's model refuses, a value Foundry " +
      "would store as something else (named with what it would store), an img that does not load, flags.foundry-mcp " +
      "with another value than the stored one. The embedded documents of a document are not taken inside its data: " +
      "change one by its own UUID, create one with create_documents and the document as parent, delete one with " +
      "delete_documents. Returns {documents: [{uuid, changed, unapplied}]}: changed is the field paths whose stored " +
      "value changed or was removed, unapplied the field paths whose stored value is not the one asked for, normally " +
      "none (a hook, the system or the server can put a path in both). If Foundry fails on an entry, the error names " +
      "it and what the stored data shows as changed, and the entries after it are not tried. " +
      HIGH_STAKES +
      " A user's password can be set and never read: one that is given is written on every call, and Foundry logs " +
      "that user out. It cannot be made blank or removed, passwordSalt cannot be given, and the role and password of " +
      "the user this bridge works as are not changed here, because Foundry would log the bridge out. A Setting is " +
      "not written by this tool, and a token's own actor data is written with ensure_actor. " +
      SPECIAL_TOOLS,
    input: z.strictObject({
      documents: z
        .array(
          z.strictObject({
            uuid: nonBlank.describe("UUID of the document to change, from list_documents or get_document."),
            data: documentData
              .optional()
              .describe("Stored data to bring the document to, in the shape get_document returns."),
            remove: z
              .array(nonBlank)
              .optional()
              .describe('Dot paths of entries to delete, for example ["flags.world.note"].')
          })
        )
        .min(1)
    })
  }),
  delete_documents: defineTool({
    ifOutcomeUnknown:
      " The call may still have been applied in Foundry. Running the same call again is safe: it ignores what is " +
      "already gone.",
    description:
      "Delete documents of any type by UUID. Foundry cannot bring a deleted document back, and there is no undo. A " +
      "UUID nothing exists at is ignored, so the same call can be run again. Foundry deletes a document together " +
      "with everything embedded in it: a journal entry with its pages, a playlist with its sounds, a table with its " +
      "results, an actor with its items and effects, a scene with its walls, lights, tokens and everything else " +
      "placed on it, a combat with its combatants. A UUID inside another document of the same call is left out for " +
      "that reason. Deleting a Folder deletes the folder alone: the documents in it move to its parent folder, and " +
      "so does every folder below it, at any depth, each keeping its own documents. A document this bridge did not " +
      "make (managed: false in list_documents) is deleted only with handMade: true: without it the whole call is " +
      "refused, names those documents and deletes nothing. The embedded documents of a document that is deleted go " +
      "with it whoever made them. Also refused, before anything is deleted: a document in a locked compendium pack " +
      "(the Gamemaster unlocks it in Foundry), a world actor that still has tokens on a scene (delete the tokens " +
      "first with delete_tokens, or give their UUIDs or their scene's in the same call, which deletes them before " +
      "the actor), the actor of a token (delete the token), the user this bridge works as, and a Setting or an " +
      "ActorDelta, which this tool does not write. Deleting a User removes that account and the settings stored for " +
      "it. Returns {deleted, documents: [{uuid, name}]}: the documents Foundry deleted. A deletion that a hook " +
      "refused is left out of both, and so is an actor one of whose tokens a hook kept. " +
      SPECIAL_TOOLS,
    input: z.strictObject({
      uuids: z.array(nonBlank).min(1).describe("UUIDs of the documents to delete."),
      handMade: z.literal(true).optional().describe("Also delete documents this bridge did not make.")
    })
  })
} satisfies Record<string, ToolSpec>;
