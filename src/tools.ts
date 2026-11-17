import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
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
      "height in grid cells (dnd5e resets them from the actor's size unless the token has flags.dnd5e.lockSize), " +
      "elevation in grid distance units, level the one level id the token is on, disposition -2 secret, -1 hostile, " +
      "0 neutral, 1 friendly, and hp {value, max} of the token's own actor when it has hit points.",
    input: z.object({ sceneId })
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
      "codes dnd5e stores (get_schema lists them), so a value can be changed and passed back. derived holds the numbers " +
      "the sheet shows, most of them computed by dnd5e and not stored: ac, hp, prof, xp, level, init, spell {dc, attack}, abilities {mod, save} and skills " +
      "{total, passive}, whatever the actor type has. items and effects are short lists; pass item ids as items to get " +
      "their full stored data in itemData. tokens are the placed tokens of the actor. actor is a world actor id or a " +
      "UUID: Actor.<id>, Compendium.<pack>.Actor.<id>, or Scene.<id>.Token.<id>.Actor.<id>, the actor of an unlinked " +
      "token, whose data is the base actor merged with that token's own changes.",
    input: z.object({
      actor: nonBlank.describe("World actor id, or an actor UUID."),
      items: z.array(z.string().min(1)).optional().describe("Ids of the actor's items to return in full.")
    })
  }),
  get_schema: defineTool({
    description:
      "The stored field names of the installed dnd5e, read from its data models. Without type it lists the types of " +
      "the document (Token has none); with type it returns the field tree, system included. A leaf is a string: the " +
      'kind, then constraints and the default, for example "integer, min 0, default 10". {$array: x}, {$set: x} and ' +
      "{$map: x, $keys} hold elements x, and a collection of documents is named, not expanded: read its entries as " +
      "the document it names (an item's activities as Activity, its advancement as Advancement). Config lists the dnd5e " +
      "key tables; with type it returns the legal keys of that table with their labels (toolIds gives each tool's item " +
      "UUID instead). path picks a subtree of a field tree, for example system.attributes.",
    input: z.object({
      document: z.enum(["Actor", "Item", "ActiveEffect", "Token", "Activity", "Advancement", "Config"]),
      type: nonBlank.optional().describe("A type of the document, or a Config table name."),
      path: nonBlank.optional().describe("Dot path into the field tree, for example system.abilities.")
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
