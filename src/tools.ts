import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DOCUMENT_TYPES, SCHEMA_EXTRAS } from "../module/scripts/document-types.mjs";
import pkg from "../package.json" with { type: "json" };
import { DOCUMENT_SPECS } from "./document-tools.ts";
import { BridgeError } from "./hub.ts";
import { ERROR_CODES, type Method } from "./protocol.ts";
import {
  CHECK_WITH_GET_SCENE,
  frameDescription,
  frameSchema,
  pointSchema,
  SAFER_SCENE_ID,
  SCENE_SPECS,
  SENSES_SET_VISION,
  sceneId
} from "./scene-tools.ts";
import { defineTool, folderPath, nonBlank, type ToolSpec } from "./tool-spec.ts";

export interface Bridge {
  request(method: Method, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;
}

type ToolDef = ToolSpec & { name: Method };

const tokenIds = z.array(z.string().min(1));

const tokenAt = pointSchema.describe("The token's centre in `frame` coordinates.");

const tokenSnap = z
  .boolean()
  .optional()
  .describe("Snap the token to the grid as a drop onto the map does. Default true.");

// The module checks the other keys of an entry against the live token schema, which the server cannot know.
const placeTokenSchema = z.looseObject({
  actor: nonBlank.describe("World actor id, or Actor.<id>."),
  at: tokenAt,
  snap: tokenSnap
});

const updateTokenSchema = z
  .looseObject({ id: z.string().min(1).describe("Token id from get_scene."), at: tokenAt.optional(), snap: tokenSnap })
  .refine((entry) => entry.snap === undefined || entry.at !== undefined, { message: "snap needs at." });

const TOKEN_ENTRY =
  "`at` is the token's centre in `frame` (omit frame for scene pixels) and must lie inside the scene rectangle, " +
  "whose far edges are outside. Any other key is a stored token field (get_schema with document Token lists them), " +
  "for example hidden, elevation, level, rotation, name, disposition (-2 secret, -1 hostile, 0 neutral, 1 friendly), " +
  "actorLink, texture, light, sight, width, height, flags. x, y, delta, keys starting with _ and keys with a dot or " +
  "a leading -= or == are refused. width and height are stored, but dnd5e sets a creature token's size from its " +
  "actor's size when the actor's size changes, unless flags.dnd5e.lockSize is true. And " +
  SENSES_SET_VISION +
  ". A request that cannot be built is refused before anything is written: an unknown field, data Foundry's token " +
  "model refuses, and a value Foundry would store as something else (a text for a boolean or a number, null for a " +
  "field that takes none, a rotation below 0 or of 360 or more, a colour not given as #rrggbb), named with what it " +
  "would store. An object without keys (light: {}) asks for nothing and changes nothing; these tools remove no key.";

// The module checks what these hold against the live data models, which the server cannot know.
const storedData = (what: string) => z.record(z.string(), z.unknown()).optional().describe(what);

// The module checks the other keys of an effect against the live effect schema.
const effectEntrySchema = z.looseObject({
  _id: nonBlank
    .optional()
    .describe("The effect's id, or a label, which always becomes the same id. An effect that is not there is created."),
  name: nonBlank.optional().describe("Effect name, trimmed. Without _id, the bridge-made effect of exactly this name.")
});

const itemEntrySchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .optional()
      .describe("Id of an item of the actor, from get_actor. Omit to find the item by name and type."),
    name: nonBlank
      .optional()
      .describe("Item name, trimmed. With id, its new name. With from, defaults to the source's."),
    type: nonBlank
      .optional()
      .describe("Item type, for example feat, weapon, spell, class, race (a species) or background."),
    from: nonBlank
      .optional()
      .describe(
        "UUID of an item to copy when the item is created: Compendium.<pack>.Item.<id>, Item.<id>, or an item of an actor."
      ),
    img: nonBlank.nullable().optional().describe("Icon, a path or URL Foundry can load. null is none."),
    system: storedData("Stored dnd5e data of the item type."),
    flags: storedData("Flags by scope. flags.foundry-mcp is the bridge's own."),
    effects: z.array(effectEntrySchema).optional().describe("Effects of this item, given like the actor's effects."),
    remove: z
      .array(nonBlank)
      .optional()
      .describe('Dot paths of entries of this item to delete, for example ["system.activities.bite"].'),
    removeEffects: z.array(nonBlank).optional().describe("Ids or labels of effects of this item to delete.")
  })
  .refine(
    (entry) =>
      entry.id !== undefined || entry.from !== undefined || (entry.name !== undefined && entry.type !== undefined),
    { message: "Give id, or name and type, or from." }
  );

const SPECS: Record<Method, ToolSpec> = {
  ...SCENE_SPECS,
  list_actors: defineTool({
    description:
      "List the world's actors and actor folders. Each actor is {id, name, type, folder (path of folder names), " +
      "managed}, plus cr for an npc and level for a character. Narrow by folder (that folder and everything under " +
      "it), type (an actor type of the system, such as character or npc) or name (part of the name, any case). " +
      "Sorted by folder, then name. At most 200 actors come back: total says how many matched, truncated whether " +
      "the list was cut. get_actor reads one in full.",
    input: z.object({
      folder: folderPath.optional().describe('Folder path from the root, for example ["Monsters", "Drow"].'),
      type: nonBlank.optional().describe("Actor type, for example npc."),
      name: nonBlank.optional().describe("Part of the name, any case.")
    })
  }),
  get_actor: defineTool({
    description:
      "Read one actor. system, prototypeToken, ownership and itemData are stored data, with the field names and " +
      "codes dnd5e stores (get_schema lists them), so a value can be changed and passed back to ensure_actor. system, " +
      "prototypeToken and ownership leave out a stored key that ensure_actor would refuse, such as a vehicle's " +
      "legacy ac.calc; a token's actor has no prototypeToken. derived holds the numbers " +
      "the sheet shows, most of them computed by dnd5e and not stored: ac, hp, prof, xp, level, init, spell {dc, attack}, abilities {mod, save} and skills " +
      "{total, passive}, whatever the actor type has. items and effects are short lists; pass item ids as items and " +
      "effect ids as effects to get their full stored data in itemData and effectData. An itemData entry's name, img, " +
      "system, flags and effects can be passed back in an items entry of ensure_actor with its _id as id, and an " +
      "effectData entry as it is: unchanged they write nothing. tokens are the placed tokens of the actor. actor is a world actor id or a " +
      "UUID: Actor.<id>, Compendium.<pack>.Actor.<id>, or Scene.<id>.Token.<id>.Actor.<id>, the actor of an unlinked " +
      "token, whose data is the base actor merged with that token's own changes.",
    input: z.object({
      actor: nonBlank.describe("World actor id, or an actor UUID."),
      items: z.array(z.string().min(1)).optional().describe("Ids of the actor's items to return in full."),
      effects: z.array(z.string().min(1)).optional().describe("Ids of the actor's effects to return in full.")
    })
  }),
  get_schema: defineTool({
    description:
      "The stored field names of any document type, read from the data models of the running Foundry and the " +
      "installed dnd5e. document is a Foundry document type (Actor, Item, JournalEntry, JournalEntryPage, RollTable, " +
      "Macro and every other type list_documents takes), or Activity, Advancement or Config. Without type it lists the " +
      "types of the document; with type it returns the field tree, system included. A document without types, such as " +
      "Token, JournalEntry or User, returns its field tree at once and takes no type. A leaf is a string: the " +
      'kind, then constraints and the default, for example "integer, min 0, default 10". {$array: x}, {$set: x} and ' +
      "{$map: x, $keys} hold elements x, and a collection of documents is named, not expanded: read its entries as " +
      "the document it names (an item's activities as Activity, its advancement as Advancement). Config lists the dnd5e " +
      "key tables; with type it returns the legal keys of that table with their labels (toolIds gives each tool's item " +
      "UUID instead). path picks a subtree of a field tree, for example system.attributes.",
    input: z.object({
      document: z.enum([...DOCUMENT_TYPES, ...SCHEMA_EXTRAS]),
      type: nonBlank.optional().describe("A type of the document, or a Config table name."),
      path: nonBlank.optional().describe("Dot path into the field tree, for example system.abilities.")
    })
  }),
  place_tokens: defineTool({
    ifOutcomeUnknown: CHECK_WITH_GET_SCENE,
    description:
      "Place tokens of world actors, as a drop from the Actors tab does: each starts from its actor's prototype " +
      "token, with numbered copies, a wildcard image, and linked or not as the prototype says unless actorLink is " +
      "given. level defaults to the scene's initial level and elevation to that level's base. dnd5e may roll an " +
      "unlinked npc's hit points, as its world setting says. actorId is refused: give actor. " +
      TOKEN_ENTRY +
      " Returns created and requested, the tokens made as {id, name, actorId, at, unapplied: given fields that a " +
      "hook or the system stored otherwise}, and the scene. Foundry skips a token that a hook refuses and creates " +
      "the rest, so created below requested is a partial success. If Foundry fails on an entry, the error names it " +
      "and the tokens created before it, and the entries after it are not tried. Not safe to repeat: each call " +
      "places the tokens again. Tokens made here are flagged as bridge-made (managed: true in get_scene)." +
      SAFER_SCENE_ID,
    input: z.object({
      sceneId,
      frame: frameSchema.optional().describe(frameDescription),
      tokens: z.array(placeTokenSchema).min(1)
    })
  }),
  update_tokens: defineTool({
    ifOutcomeUnknown:
      " The call may still have been applied in Foundry. Running the same call again is safe: it writes only what still differs.",
    description:
      "Change tokens by id, hand-placed ones too. Only the given fields whose value differs from the stored one " +
      "are written. A change of at, elevation, size, shape or level moves the token as Foundry's own token " +
      "configuration does, as a teleport: no wall stops it and no level-change dialog opens. at is measured with " +
      "the token's size after the change; without at the top-left corner stays. A level change keeps the " +
      "elevation, so give elevation with level. dnd5e may mark a token that ends above the ground as falling, and " +
      "records the move on the token's actor. An entry of get_scene's tokenData can be passed back as it is: " +
      "actorId and flags.foundry-mcp are taken while they equal the stored ones, and an at equal to the token's " +
      "centre moves nothing, whatever snap says. " +
      TOKEN_ENTRY +
      " If an id is not on the scene, nothing is written. Returns per token {id, at (the centre after the write), " +
      "changed (the field paths whose stored value changed), unapplied (the field paths whose stored value is not " +
      "the one asked for, at for the position; a hook or the system can put a path in both)}, and the scene." +
      SAFER_SCENE_ID,
    input: z.object({
      sceneId,
      frame: frameSchema.optional().describe(frameDescription),
      tokens: z.array(updateTokenSchema).min(1)
    })
  }),
  delete_tokens: defineTool({
    ifOutcomeUnknown: CHECK_WITH_GET_SCENE,
    description:
      "Delete tokens by id; ids not on the scene are ignored. Foundry also removes each token from the combats it " +
      "is in, and an unlinked token's own actor data (its hit points and other changes) is lost with it. Returns " +
      "the count and the scene." +
      SAFER_SCENE_ID,
    input: z.object({ sceneId, ids: tokenIds.min(1).describe("Token ids to delete.") })
  }),
  ensure_actor: defineTool({
    ifOutcomeUnknown:
      " The call may still have been applied in Foundry. Find the actor with list_actors before retrying, " +
      "or run the same call again once writes are accepted: it changes only what still differs.",
    timeoutMs: 90_000,
    description:
      "Create an actor, or bring an existing one to the given data, changing only what differs: running it again " +
      "with the same input changes nothing. Without actor, the target is the bridge-made world actor of exactly that " +
      "name in exactly that folder (the root if omitted): one is updated, none is created (then give type or from), " +
      "several are refused, and so is a name that only an actor made by hand has, with its id to pass as actor on " +
      "purpose. With actor that actor is changed, hand-made or not: name is its new name and folder the folder to " +
      "move it into. Missing folders are created. The actor of a token (its UUID) takes no folder and no " +
      "prototypeToken, and a compendium actor is not written. from copies an actor with its items and effects when " +
      "the actor is created, and is not applied again on a later run. system, prototypeToken, ownership and flags " +
      "are stored data in the shape get_actor returns and get_schema lists: objects merge into what is stored, lists " +
      "are replaced whole, and data read with get_actor and passed back unchanged writes nothing. remove deletes entries " +
      "by dot path: an entry of a keyed map (system.tools.thief) or a key below flags; a path with no entry is " +
      "ignored, an entry of a map with fixed keys goes back to its defaults (system.abilities.str to 10), and on a " +
      "token's actor only what that token changed can be removed. " +
      "items adds or changes items and never deletes one. An entry with id is that item of the actor. Without id it " +
      "is the bridge-made item of exactly that name and type: one is changed, none is created, several are refused, " +
      "and so is a name that only an item made by hand has, with its id. from starts a new item as a copy and is not " +
      "applied again; img, system and flags are stored item data (get_schema with document Item, and Activity for an " +
      "entry of system.activities). A key of system.activities that is no 16-character id is a label, which always " +
      "becomes the same id: the same call again changes that activity. A new activity needs type. For example " +
      '{name: "Bite", type: "feat", system: {activities: {bite: {type: "attack", attack: {flat: true, bonus: "5", ' +
      'type: {value: "melee", classification: "weapon"}}, damage: {includeBase: false, parts: [{number: 2, ' +
      'denomination: 6, bonus: "3", types: ["piercing"]}]}, range: {value: "5", units: "ft"}}}}}. remove in an entry ' +
      "deletes entries of that item (system.activities.bite). effects are the actor's own active effects, and inside " +
      "an item entry that item's: stored ActiveEffect data, found by _id (an id or a label; an effect that is not " +
      "there is created under it, and an activity of the same call names it in its effects as {_id}), or without " +
      'it by name among the bridge-made ones. Their changes are system.changes [{key, type: "add", value: "2"}]. ' +
      "removeItems and removeEffects delete by id and ignore ids that are not there. New items are created after the " +
      "actor, as a drop on the sheet creates them, so dnd5e sets its item defaults, but no advancement runs: a class " +
      "(system.levels), a species (type race) and a background are stored as given, so give the features they grant " +
      "as items too, and a character's hit points. A copied spell keeps its system.prepared: give 1 (prepared) or 2 " +
      "(always) for a spell the creature has ready. For a cast activity dnd5e adds a copy of its spell as an item of " +
      "its own shortly after the call returns. On a token's actor, items and effects are written for that token only. " +
      'In dnd5e a fixed armor class is system.attributes.ac.calcs ["natural"] with ac.flat, speeds are ' +
      "formula texts under system.attributes.movement.speeds, a skill's value is its proficiency multiplier (0, 0.5, " +
      "1, 2), system.details.cr is a number (0.125, 0.25 and 0.5 for the fractions), a new npc given hp.max without " +
      "hp.value starts with value equal to max, and a token's sight range follows the actor's senses " +
      "(system.attributes.senses.ranges) while the senseVisionSync setting is on. A request that cannot be built is " +
      "refused before anything is written: an unknown or derived field, a key outside a map's fixed keys, " +
      "flags.foundry-mcp, data the actor model refuses, a value Foundry would store as something else (named with " +
      "what it would store), an img that does not load. Returns {id, uuid, name, type, folder, created, changed (the " +
      "field paths whose stored value changed or was removed), unapplied (the field paths whose stored value is not " +
      "the one asked for; a hook or the system can put a path in both), derived (the numbers get_actor returns under " +
      "that name, read after the write)}, and for each of items, effects, removeItems and removeEffects that was " +
      "given: items [{id, name, type, created, changed, unapplied, effects, removedEffects}] and effects [{id, name, " +
      "created, changed, unapplied}] with paths inside the item or effect, and the counts removedItems and " +
      "removedEffects. An entry Foundry created nothing for has error in place of its id.",
    input: z
      .strictObject({
        actor: nonBlank
          .optional()
          .describe(
            "The actor to change: a world actor id or UUID, or the UUID of a token's own actor, " +
              "Scene.<id>.Token.<id>.Actor.<id>. Omit to find the actor by name."
          ),
        name: nonBlank.optional().describe("Actor name, trimmed. Required without actor."),
        type: nonBlank
          .optional()
          .describe("Actor type of the system, for example npc. Needed to create, unless from is given."),
        folder: folderPath
          .optional()
          .describe("Folder path from the root. With actor, the folder to move the actor into. [] is the root."),
        from: nonBlank
          .optional()
          .describe(
            "UUID of a compendium actor, or id or UUID of a world actor, to copy when the actor is created. The " +
              "copy keeps the source's prototype token, name included: give prototypeToken.name to name its tokens " +
              "like the copy."
          ),
        img: nonBlank.nullable().optional().describe("Portrait image, a path or URL Foundry can load. null is none."),
        system: storedData("Stored dnd5e data of the actor type."),
        prototypeToken: storedData("Stored prototype token data, which place_tokens starts each token from."),
        ownership: storedData(
          "Level by user id, and default: -1 inherit, 0 none, 1 limited, 2 observer, 3 owner. To drop a user's " +
            "entry give -1: remove does not work here."
        ),
        flags: storedData("Flags by scope. flags.foundry-mcp is the bridge's own."),
        remove: z
          .array(nonBlank)
          .optional()
          .describe('Dot paths of entries to delete, for example ["system.tools.thief", "flags.world.note"].'),
        items: z.array(itemEntrySchema).optional().describe("Items to create or change."),
        removeItems: z.array(z.string().min(1)).optional().describe("Ids of items of the actor to delete."),
        effects: z.array(effectEntrySchema).optional().describe("The actor's own active effects to create or change."),
        removeEffects: z
          .array(nonBlank)
          .optional()
          .describe("Ids or labels of the actor's own active effects to delete.")
      })
      .refine((args) => args.actor !== undefined || args.name !== undefined, {
        message: "Give a name, or an actor to change."
      })
  }),
  delete_actors: defineTool({
    ifOutcomeUnknown: " The call may still have been applied in Foundry. Check with list_actors before retrying.",
    description:
      "Delete world actors by id; ids that are no world actor are ignored. Foundry cannot bring a deleted actor " +
      "back, so an actor this bridge did not make (managed: false in list_actors) is deleted only with handMade: " +
      "true: without it the whole call is refused, names those actors and deletes nothing. An actor that still has " +
      "tokens on a scene is not deleted either: the whole call is refused and names the scenes, so delete the tokens " +
      "first with delete_tokens. Returns deleted, and the ids and names of the actors that were deleted.",
    input: z.strictObject({
      ids: z.array(z.string().min(1)).min(1).describe("World actor ids to delete."),
      handMade: z.literal(true).optional().describe("Also delete actors this bridge did not make.")
    })
  }),
  ...DOCUMENT_SPECS
};

export const TOOLS = Object.fromEntries(
  Object.entries(SPECS).map(([name, spec]) => [name, { name, ...spec }])
) as Record<Method, ToolDef>;

function describeFailure(error: unknown, tool: ToolDef): string {
  if (error instanceof BridgeError) {
    const fromFoundry = (ERROR_CODES as readonly string[]).includes(error.code);
    const message = fromFoundry ? `Foundry reported ${error.code}: ${error.message}` : error.message;
    const outcomeUnknown = error.code === "timeout" || error.code === "bridge_closed";
    return outcomeUnknown && tool.ifOutcomeUnknown ? message + tool.ifOutcomeUnknown : message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function createMcpServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: "foundry-mcp", version: pkg.version });
  for (const tool of Object.values(TOOLS)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (args: unknown) => {
        try {
          const raw = await bridge.request(tool.name, args as Record<string, unknown>, { timeoutMs: tool.timeoutMs });
          return tool.toResult(raw);
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: describeFailure(error, tool) }] };
        }
      }
    );
  }
  return server;
}
