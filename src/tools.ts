import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DOCUMENT_TYPES, SCHEMA_EXTRAS } from "../module/scripts/document-types.mjs";
import { DOOR_KINDS, DOOR_STATE_NAMES, WALL_KIND_NAMES } from "../module/scripts/wall-kinds.mjs";
import pkg from "../package.json" with { type: "json" };
import { BridgeError } from "./hub.ts";
import { ERROR_CODES, type Method } from "./protocol.ts";

export interface Bridge {
  request(method: Method, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown>;
}

type ToolSpec = {
  description: string;
  input: z.ZodType;
  timeoutMs: number;
  ifOutcomeUnknown: string | null;
  toResult: (raw: unknown) => CallToolResult;
};
type ToolDef = ToolSpec & { name: Method };

const asJsonText = (raw: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(raw ?? null) }]
});

const sceneId = z
  .string()
  .min(1)
  .optional()
  .describe("Scene id. Defaults to the scene the Gamemaster is viewing, else the active scene.");

const frameSchema = z.object({ width: z.number().positive(), height: z.number().positive() });

const pointSchema = z.tuple([z.number(), z.number()]);

const wallPathSchema = z
  .object({
    points: z.array(pointSchema).min(2).describe("Vertices in order. Consecutive points are joined by walls."),
    closed: z.boolean().optional().describe("Also join the last point back to the first. Needs at least 3 points."),
    kind: z.enum(WALL_KIND_NAMES).optional().describe("Wall type for every segment of this path. Defaults to wall."),
    state: z
      .enum(DOOR_STATE_NAMES)
      .optional()
      .describe("Door state of every segment of this path: closed, open or locked. Only for kind door or secret-door.")
  })
  .refine((path) => !path.closed || path.points.length >= 3, {
    message: "A closed path needs at least 3 points."
  })
  .refine((path) => path.state === undefined || (path.kind !== undefined && DOOR_KINDS.includes(path.kind)), {
    message: "A door state needs kind door or secret-door."
  });

const frameDescription =
  "The coordinate frame: a rectangle of width x height units that spans the scene rectangle (the area the " +
  "map image covers), origin at the top left, x to the right, y down. Defaults to the scene size in pixels.";

const levelsDescription = "Level ids the walls belong to. Default: all levels.";

// Foundry's StringField trims by default (common/data/fields.mjs).
const trimmed = z.string().trim();
const nonBlank = trimmed.min(1);

const folderPath = z.array(nonBlank);

// NumberField#_validateType with a step (common/data/fields.mjs), via Number#toNearest (common/primitives/number.mjs).
const isMultipleOf = (value: number, step: number) => Number((Math.round(value / step) * step).toFixed(2)) === value;

// LightData bright and dim have step 0.01 (common/data/data.mjs), and NumberField#_cleanType rounds to it silently.
const radius = z
  .number()
  .min(0)
  .refine((value) => isMultipleOf(value, 0.01), { message: "Radii must be a multiple of 0.01." });

const lightShape = {
  at: pointSchema.describe("Position in `frame` coordinates."),
  bright: radius.optional().describe("Bright radius in grid distance units, for example feet."),
  dim: radius
    .optional()
    .describe("Dim radius in grid distance units. The light reaches as far as the larger of bright and dim."),
  color: trimmed
    .regex(/^#[0-9a-fA-F]{6}$/, { message: "Use a colour like #ff8800." })
    .toLowerCase()
    .optional()
    .describe("Light colour as #rrggbb. Default: none, white light."),
  alpha: z.number().min(0).max(1).optional().describe("Colour intensity, 0 to 1. Default 0.5."),
  angle: z.number().min(0).max(360).optional().describe("Emission angle in degrees. Default 360, a full circle."),
  rotation: z
    .number()
    .min(0)
    .max(360)
    .optional()
    .describe("Direction of a cone in degrees, 0 pointing down. Stored modulo 360."),
  animation: z
    .object({
      type: nonBlank.describe(
        "A Foundry light animation key such as flame, torch, pulse or sunburst. A darkness source takes darkness animation keys."
      ),
      speed: z.number().int().min(0).max(10).optional().describe("0 to 10. Default 5."),
      intensity: z.number().int().min(1).max(10).optional().describe("1 to 10. Default 5."),
      reverse: z.boolean().optional()
    })
    .strict()
    .optional(),
  walls: z.boolean().optional().describe("Whether walls block the light. Default true."),
  vision: z.boolean().optional().describe("Whether the light gives vision. Default false."),
  hidden: z
    .boolean()
    .optional()
    .describe(
      "Switches the light off for everyone, the Gamemaster included: Foundry treats a hidden light as disabled. It does not hide a light from players only. Default false."
    ),
  darkness: z
    .object({ min: z.number().min(0).max(1), max: z.number().min(0).max(1) })
    .strict()
    .refine((range) => range.min <= range.max, { message: "darkness.min may not be above darkness.max." })
    .optional()
    .describe("The scene darkness range, 0 to 1, in which the light is on. Default 0 to 1, always."),
  negative: z.boolean().optional().describe("A darkness source instead of a light."),
  name: nonBlank.optional().describe("A label for the light, trimmed.")
};

const needsRadius = (light: { bright?: number; dim?: number }) => (light.bright ?? 0) > 0 || (light.dim ?? 0) > 0;
const needsRadiusMessage = { message: "A light needs a bright or a dim radius above 0." };

export const lightSchema = z.object(lightShape).strict().refine(needsRadius, needsRadiusMessage);

const syncLightSchema = z
  .object({
    ...lightShape,
    id: z.string().min(1).optional().describe("Read-only, as get_scene returns it. Never sent to Foundry."),
    managed: z
      .boolean()
      .optional()
      .describe(
        "As get_scene returns it. false means hand-placed: the entry is left out, not touched and not recreated."
      ),
    levels: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "As get_scene returns it. A light whose levels are another level set than the call's levels (in effect, so [] and every level of the scene are the same) is left out, not touched and not recreated. Never written to Foundry."
      )
  })
  .strict()
  .refine(needsRadius, needsRadiusMessage);

// The SDK publishes tool schemas as draft-7 (sdk/dist/esm/server/zod-json-schema-compat.js). zod's default,
// draft-2020-12, writes the `at` tuple as prefixItems, which draft-7 ignores.
const { $schema: _draft, ...syncLightJsonSchema } = z.toJSONSchema(syncLightSchema, { io: "input", target: "draft-7" });

const syncLightsInput = z
  .object({
    sceneId,
    frame: frameSchema.optional().describe(frameDescription),
    lights: z.array(z.unknown()).meta({ items: syncLightJsonSchema }),
    levels: z.array(z.string().min(1)).optional().describe("Level ids the lights belong to. Default: all levels.")
  })
  .check((ctx) => {
    const { lights } = ctx.value;
    const kept: unknown[] = [];
    lights.forEach((entry, index) => {
      if (typeof entry === "object" && entry !== null && (entry as { managed?: unknown }).managed === false) return;
      const parsed = syncLightSchema.safeParse(entry);
      if (parsed.success) {
        const { id: _id, managed: _managed, ...light } = parsed.data;
        kept.push(light);
      } else {
        for (const issue of parsed.error.issues)
          ctx.issues.push({
            code: "custom",
            message: issue.message,
            input: entry,
            path: ["lights", index, ...issue.path]
          });
      }
    });
    if (lights.length > 0 && kept.length === 0 && ctx.issues.length === 0) {
      ctx.issues.push({
        code: "custom",
        message:
          `All ${lights.length} given lights were left out as hand-placed (managed: true is bridge-made, managed: false is hand-placed), so nothing was changed. ` +
          "Hand-placed lights already exist and a sync never touches them. Pass lights: [] to remove the bridge-made lights.",
        input: lights,
        path: ["lights"]
      });
    }
    ctx.value = { ...ctx.value, lights: kept };
  });

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

const SENSES_SET_VISION =
  "while dnd5e's senseVisionSync setting is on (its default), a token whose actor has a sense that grants sight " +
  "takes its sight range, vision mode and detection modes from the actor's senses: set vision range on the actor, " +
  "and light, sight.angle and sight.enabled on the token";

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

const imageResultSchema = z.object({
  mimeType: z.string(),
  data: z.string(),
  frame: z.object({ width: z.number(), height: z.number() }),
  background: z.boolean()
});

function defineTool(
  def: Partial<Pick<ToolSpec, "timeoutMs" | "ifOutcomeUnknown" | "toResult">> & Pick<ToolSpec, "description" | "input">
): ToolSpec {
  return { timeoutMs: 30_000, ifOutcomeUnknown: null, toResult: asJsonText, ...def };
}

const CHECK_WITH_GET_SCENE = " The call may still have been applied in Foundry. Check with get_scene before retrying.";

const SAFER_SCENE_ID =
  " Pass the sceneId from get_scene: the default follows whatever scene the Gamemaster is viewing at that moment.";

const SPECS: Record<Method, ToolSpec> = {
  get_scene: defineTool({
    description:
      'Read a Foundry scene: id, name, navName ("" when none), folder (path of folder names from the root), active, viewed, shiftX and shiftY (the map shift, see ensure_scene), grid, ' +
      "background image path, levels, every wall, every ambient light and every token. The returned `frame` " +
      "is the scene size in pixels. Wall coordinates `c` ([x1, y1, x2, y2]) are in that frame (scene pixels). To " +
      "compare them with an image from get_scene_image, multiply by imageFrame / sceneFrame, because the image " +
      "is usually smaller than the scene. Wall `kind` is one of wall, door, secret-door, window, terrain, " +
      "invisible, ethereal, or custom. Walls are `{id, c, kind, door, ds, levels, managed}`. Each light is " +
      "`{id, at, levels, managed, ...}` with `at` in the same frame, as stored (not clamped to the canvas), and the " +
      "other fields as sync_lights takes them (bright and dim in grid distance units); fields Foundry holds as " +
      "none, such as the colour of a white light, are left out. `levels` is the level ids the wall or light belongs " +
      "to ([] is all levels). `managed` is true for walls and lights made by this bridge (create_walls, sync_walls, " +
      "sync_lights) and false for those placed by hand. Tokens are `{id, name, actorId, actorLink, at, width, height, " +
      "elevation, level, hidden, disposition, rotation, managed, hp}`: `at` is the centre in the same frame, width and " +
      "height in grid cells (dnd5e resets them when the actor's size changes, unless the token has " +
      "flags.dnd5e.lockSize), elevation in grid distance units, level the one level id the token is on, disposition " +
      "-2 secret, -1 hostile, 0 neutral, 1 friendly, and hp {value, max} of the token's own actor when it has hit " +
      "points. Pass token ids as tokens to get their full stored data in tokenData, in the shape update_tokens " +
      "takes: id and at in place of _id, x and y. An entry passed back unchanged writes nothing. The stored sight " +
      "is not always what a token sees: " +
      SENSES_SET_VISION +
      ".",
    input: z.object({
      sceneId,
      tokens: tokenIds.optional().describe("Ids of tokens to return in full in tokenData.")
    })
  }),
  get_scene_image: defineTool({
    description:
      "Render the scene rectangle (the area the map image covers) as an image whose aspect ratio matches the " +
      "scene. The result also states the image's pixel size as `frame`, and `background`: whether a map image " +
      "is in the picture (false means only the scene's background colour). Pass that frame to create_walls to " +
      "give coordinates exactly as measured in this image, with the origin at the top left. Set showWalls to " +
      "draw the existing walls over the image (walls in red, doors in blue) to check your work. Set showLights to " +
      "draw every ambient light, hand-placed and bridge-made: a dot at its position and a ring at its reach " +
      "(yellow, or purple for a darkness source). Set showTokens to draw every token as an ellipse over its footprint, " +
      "outlined by disposition (green friendly, white neutral, orange hostile, cyan secret) and left unfilled when hidden.",
    input: z.object({
      sceneId,
      maxSize: z.number().int().min(64).max(4096).optional().describe("Longest image side in pixels. Default 1568."),
      showWalls: z.boolean().optional().describe("Draw the scene's walls over the image. Default false."),
      showLights: z.boolean().optional().describe("Draw the scene's ambient lights over the image. Default false."),
      showTokens: z.boolean().optional().describe("Draw the scene's tokens over the image. Default false.")
    }),
    timeoutMs: 90_000,
    toResult: (raw) => {
      const image = imageResultSchema.parse(raw);
      return {
        content: [
          { type: "image", data: image.data, mimeType: image.mimeType },
          { type: "text", text: JSON.stringify({ frame: image.frame, background: image.background }) }
        ]
      };
    }
  }),
  create_walls: defineTool({
    ifOutcomeUnknown: CHECK_WITH_GET_SCENE,
    description:
      "Create walls from paths. Each path is a list of points joined in order (set closed to join the last point " +
      "to the first), so consecutive walls always share an endpoint and leave no gaps. Use one path per room " +
      "outline or wall run, and a separate two-point path with kind door for a door. Coordinates are in `frame` " +
      "(width x height units spanning the scene rectangle, origin top left). Omit frame to use scene pixels. Use " +
      "the frame returned by get_scene_image to give coordinates as measured in that image, or " +
      "{width: columns, height: rows} for grid cells. Returns the created wall ids, how many walls were " +
      "asked for (`requested`) and how many Foundry created (`created`), and the scene they went to. Foundry " +
      "skips a wall that fails its validation or that a hook refuses and creates the rest, so `created` below " +
      "`requested` is a partial success: the walls that were made stay. Segments that collapse to a point are skipped and counted. A point that is not a safe integer once " +
      "converted to scene pixels is refused before anything is written (the bridge is stricter than Foundry here, on purpose). A path of kind door or secret-door may set " +
      "state (closed, open, locked). Every wall made here is flagged as bridge-made (get_scene reports managed: " +
      "true); to redraw a map without piling up duplicates use sync_walls instead." +
      SAFER_SCENE_ID,
    input: z.object({
      sceneId,
      frame: frameSchema.optional().describe(frameDescription),
      paths: z.array(wallPathSchema).min(1),
      levels: z.array(z.string().min(1)).optional().describe(levelsDescription)
    })
  }),
  delete_walls: defineTool({
    ifOutcomeUnknown: CHECK_WITH_GET_SCENE,
    description:
      "Delete walls from a scene, either the given ids or every wall (all: true). Give exactly one of the two. " +
      "Returns the count and the scene it was applied to." +
      SAFER_SCENE_ID,
    input: z
      .object({
        sceneId,
        ids: z.array(z.string().min(1)).min(1).optional().describe("Wall ids to delete."),
        all: z.literal(true).optional().describe("Delete every wall in the scene.")
      })
      .refine((args) => (args.ids !== undefined) !== (args.all === true), {
        message: "Give exactly one of ids (non-empty) or all: true."
      })
  }),
  sync_walls: defineTool({
    ifOutcomeUnknown: CHECK_WITH_GET_SCENE,
    description:
      "Make a scene's bridge-made walls exactly the given paths: creates the paths, flagged as bridge-made, then " +
      "deletes the bridge-made walls (managed: true in get_scene) that were there before. Walls drawn by hand " +
      "carry no flag and are never touched. Takes the same paths, frame, levels and door state as create_walls, " +
      "but paths may be empty, which only removes the bridge-made walls; paths that were given but yield no wall " +
      "(every segment collapses to a point at that frame) are refused. With levels, only the bridge-made walls " +
      "that belong to exactly that level set are replaced (no levels means the walls on all levels, and a set that " +
      "names every level of the scene counts as no levels); bridge-made walls of other level sets stay. A request that cannot be built is refused before anything is written, and if " +
      "Foundry creates fewer walls than asked the ones it made are deleted again and the old walls stay (an " +
      "error says how many it created, and how many of those could be removed again). Safe to run again with the " +
      "same input: it ends with exactly the given walls, also after an interrupted run. It is not atomic in Foundry, so a run that stops between the two " +
      "steps leaves old and new bridge-made walls side by side until you run it again. Returns the deleted and " +
      "created counts, the created ids, skipped segments and the scene." +
      SAFER_SCENE_ID,
    input: z.object({
      sceneId,
      frame: frameSchema.optional().describe(frameDescription),
      paths: z.array(wallPathSchema),
      levels: z.array(z.string().min(1)).optional().describe(levelsDescription)
    })
  }),
  sync_lights: defineTool({
    ifOutcomeUnknown: CHECK_WITH_GET_SCENE,
    description:
      "Make a scene's bridge-made ambient lights exactly the given list: creates the lights, flagged as " +
      "bridge-made, then deletes the bridge-made lights (managed: true in get_scene) that were there before. " +
      "Lights placed by hand carry no flag and are never touched. `lights` may be empty, which only removes the " +
      "bridge-made lights. A light is `at` ([x, y] in `frame`, the same frame model as sync_walls: omit frame " +
      "for scene pixels) plus at least one of bright and dim, radii in the scene's grid distance units (for " +
      "example feet), not pixels. Foundry lights a circle as far as the larger of the two: bright is the part " +
      "at full strength and dim fades out to its radius, so give dim as the outer radius and a bright radius " +
      "not above it. Optional: color (#rrggbb), alpha (colour intensity 0 to 1), angle (emission angle, " +
      "default a full circle) and rotation (its direction), animation {type, speed 0 to 10, intensity 1 to 10, " +
      "reverse} where type is a Foundry light animation key such as flame, torch, pulse or sunburst (a darkness " +
      "source takes darkness animation keys such as magicalGloom, and an unknown key is refused before anything " +
      "is written), walls (blocked by walls, default true), vision, hidden (switches the light off for everyone, " +
      "the Gamemaster too, it does not hide it from players only), darkness {min, max} (the scene darkness " +
      "range, 0 to 1, in which the light is on), negative (a darkness source instead of a light) and name. A " +
      "field left out takes Foundry's default. Foundry clamps a position outside the canvas when it draws the " +
      "light; get_scene still reports the position as stored. Takes levels as sync_walls does: only the " +
      "bridge-made lights that belong to exactly that level set are replaced, those of other level sets stay. " +
      "The lights of get_scene can be passed back as they are, with one limit: the read-only keys id and managed " +
      "are accepted and not sent to Foundry, a light with managed: false (hand-placed) is left out before " +
      "validation, without being checked, and a light whose levels are another level set than this call's levels is " +
      "left out too. Level sets are compared as Foundry reads them: [] and the list of every level of the scene are " +
      "the same set, all levels. A light's own levels are never written, the light gets the call's levels. So " +
      "sync_lights with get_scene's lights and the same levels changes nothing in effect, hand-placed lights " +
      "included, unless every given light is left out: that call is refused before anything is written, with the " +
      "reason, for example for a scene that has only hand-placed lights, because it would otherwise " +
      "remove the bridge-made lights: only a literally empty `lights` does that. A request that cannot be built is refused before anything is " +
      "written, and if Foundry creates fewer lights than asked the ones it made are deleted again and the old " +
      "lights stay (an error says how many it created, and how many of those could be removed again). Safe to run again with the same input: it ends with " +
      "exactly the given lights, also after an interrupted run. It is not atomic in Foundry, so a run that stops " +
      "between the two steps leaves old and new bridge-made lights side by side until you run it again. Returns " +
      "the deleted and created counts, the created ids and the scene. Check the result with get_scene_image and " +
      "showLights." +
      SAFER_SCENE_ID,
    input: syncLightsInput
  }),
  list_scenes: defineTool({
    description:
      "List the scenes of the world and the scene folders, without loading any of them. Each scene has id, name, " +
      "navName, folder (path of folder names from the root, [] at the root), active, viewed, width and height " +
      "(of the map, without padding), shiftX and shiftY, grid, background image path and wall, light and token counts (each with total, " +
      "and managed: the bridge-made ones). Pass folder (a path of folder names) to list only that folder and everything under it; " +
      "[] or no folder lists everything. " +
      "Use it to find a scene id for ensure_scene or the wall tools.",
    input: z.object({
      folder: folderPath.optional().describe('Folder path from the root, for example ["Chapter 5", "Holoth"].')
    })
  }),
  ensure_scene: defineTool({
    ifOutcomeUnknown:
      " The call may still have been applied in Foundry. Find the scene with list_scenes before retrying, " +
      "or run the same call again once writes are accepted: it changes only what is still missing.",
    timeoutMs: 90_000,
    description:
      "Create a scene, or bring an existing one to the given settings, changing only what differs. Running it " +
      "again with the same input changes nothing, so it is safe to repeat once the earlier call has ended. Without sceneId the " +
      "scene is found by exact name inside exactly the given folder (the root if omitted): one match is updated, " +
      "none is created (then width and height are required), several are refused. With sceneId that scene is " +
      "updated, and name and folder are its new name and place. Missing folders on the path are created. Only " +
      "the given fields are written. background.src sets the image of the scene's initial level and the scene " +
      "directory's thumbnail is rendered from it, and is rendered again on a later call if an earlier render failed. " +
      "Changing width, height, padding, shiftX, shiftY, grid.type or grid.size of an existing scene moves everything already placed on it " +
      "(walls, tokens, tiles, lights, sounds, notes, drawings, regions) with the map, as the scene config does. The " +
      "grid size changes only when you pass a different grid.size: the bridge keeps the stored one otherwise, " +
      "although Foundry itself would scale it by the average of the two scale factors. Returns the scene id, name, folder, whether it was created, changed: the names of the " +
      "fields that were written (for example background.src, grid.size), and unapplied: given fields Foundry " +
      "did not store, normally empty (darkness while the scene's darkness lock is on is the known case). " +
      "Pass the returned id to the wall tools. A scene created here does not become the active scene. To update a scene " +
      "that may already exist under another name or folder, pass its sceneId from list_scenes: the name lookup " +
      "only sees the exact name in the exact folder.",
    input: z
      .object({
        sceneId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Id of the scene to update, from list_scenes or an earlier ensure_scene. Omit to find the scene by name."
          ),
        name: nonBlank.optional().describe("Scene name, trimmed. Required without sceneId."),
        folder: folderPath
          .optional()
          .describe("Folder path from the root. With sceneId, the folder to move the scene into. [] is the root."),
        background: z
          .object({
            src: nonBlank.refine((src) => !/^data:/i.test(src), {
              message:
                "A data: URL is refused: Foundry stores it as a file under another path, so it never reads back equal."
            })
          })
          .optional()
          .describe("Map image of the scene's initial level, a path or URL Foundry can load. Not a data: URL."),
        width: z.number().int().positive().optional().describe("Map width in pixels. Required to create."),
        height: z.number().int().positive().optional().describe("Map height in pixels. Required to create."),
        padding: z
          .number()
          .min(0)
          .max(0.5)
          .refine((value) => isMultipleOf(value, 0.05), { message: "Padding must be a multiple of 0.05." })
          .optional()
          .describe("Scene padding as a fraction, 0 to 0.5 in steps of 0.05, because Foundry rounds to that step."),
        shiftX: z
          .number()
          .int()
          .optional()
          .describe(
            "Scene pixels the map image is moved left against the grid, so a positive value moves the map left and a negative one right. " +
              "A map point at scene pixel x lies on a grid line when shiftX is x modulo grid.size; a scene pixel is the image pixel times scene width over image width. " +
              "Must stay within the padding in pixels (padding rounded up to whole grid cells), or the call is refused with invalid_params: " +
              "map outside the canvas is not drawn and holds no tokens. Default 0."
          ),
        shiftY: z
          .number()
          .int()
          .optional()
          .describe(
            "Scene pixels the map image is moved up against the grid: positive moves the map up. A point at scene pixel y (image pixel times scene height over image height) lies on a grid line when shiftY is y modulo grid.size. " +
              "Must stay within the padding in pixels, like shiftX."
          ),
        grid: z
          .object({
            type: z.enum(["square", "gridless"]).optional(),
            // Foundry's CONST.GRID_MIN_SIZE
            size: z.number().int().min(20).optional().describe("Pixels per grid cell."),
            distance: z.number().positive().optional().describe("Distance one cell stands for."),
            units: trimmed.optional().describe("Unit of the distance, for example ft.")
          })
          .optional(),
        navName: trimmed.optional().describe("Name shown in the navigation bar."),
        navigation: z.boolean().optional().describe("Show the scene in the navigation bar."),
        tokenVision: z.boolean().optional(),
        fogExploration: z.boolean().optional().describe("Fog of war exploration on or off."),
        globalLight: z.boolean().optional().describe("Global illumination on or off."),
        darkness: z.number().min(0).max(1).optional().describe("Darkness level, 0 (day) to 1 (night)."),
        weather: trimmed.optional().describe('Foundry weather effect key, for example rain or fog. "" for none.')
      })
      .refine((args) => args.sceneId !== undefined || args.name !== undefined, {
        message: "Give a name, or a sceneId to update."
      })
  }),
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
      "first with delete_tokens), the actor of a token (delete the token), the user this bridge works as, and a " +
      "Setting or an ActorDelta, which this tool does not write. Deleting a User removes that account and the " +
      "settings stored for it. Returns {deleted, documents: [{uuid, name}]}: the documents Foundry deleted. A " +
      "deletion that a hook refused is left out of both. " +
      SPECIAL_TOOLS,
    input: z.strictObject({
      uuids: z.array(nonBlank).min(1).describe("UUIDs of the documents to delete."),
      handMade: z.literal(true).optional().describe("Also delete documents this bridge did not make.")
    })
  })
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
