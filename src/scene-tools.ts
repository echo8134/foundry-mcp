// The tools that read, render and build a scene: its walls, lights and regions, and the scene itself.

import { z } from "zod";
import { DOOR_KINDS, DOOR_STATE_NAMES, WALL_KIND_NAMES } from "../module/scripts/wall-kinds.mjs";
import { defineTool, folderPath, nonBlank, trimmed } from "./tool-spec.ts";

export const sceneId = z
  .string()
  .min(1)
  .optional()
  .describe("Scene id. Defaults to the scene the Gamemaster is viewing, else the active scene.");

export const frameSchema = z.object({ width: z.number().positive(), height: z.number().positive() });

export const pointSchema = z.tuple([z.number(), z.number()]);

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

export const frameDescription =
  "The coordinate frame: a rectangle of width x height units that spans the scene rectangle (the area the " +
  "map image covers), origin at the top left, x to the right, y down. Defaults to the scene size in pixels.";

const levelsDescription = "Level ids the walls belong to. Default: all levels.";

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
    const checked: unknown[] = [];
    lights.forEach((entry, index) => {
      // A light made by hand may be one this schema refuses. It keeps its place in the list, and the module leaves it out.
      if (typeof entry === "object" && entry !== null && (entry as { managed?: unknown }).managed === false) {
        checked.push({ managed: false });
        return;
      }
      const parsed = syncLightSchema.safeParse(entry);
      if (parsed.success) {
        const { id: _id, managed: _managed, ...light } = parsed.data;
        checked.push(light);
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
    ctx.value = { ...ctx.value, lights: checked };
  });

/** The shapes of a region, as get_scene returns them and sync_regions takes them. */
const REGION_SHAPES =
  "each `{type, hole, ...}`: rectangle {x, y, width, height, rotation, anchorX, anchorY} with x and y its top left " +
  "corner while the anchors are 0, their default, circle {x, y, radius} and ellipse {x, y, radiusX, radiusY, " +
  "rotation} around x and y, polygon {points: [[x, y], ...], origin} with at least 3 points, and Foundry's other " +
  "types (cone, ring, line, emanation, token, grid) with the fields Foundry stores for them. hole: true cuts the " +
  "shape out of the region.";

// The module checks the other keys of a behavior, a shape and a region against the live schemas of Foundry.
const regionBehaviorSchema = z.looseObject({
  type: nonBlank.describe("Behavior type, for example changeLevel or teleportToken."),
  name: trimmed.optional().describe("Name of the behavior, by which a later sync finds it. Default: its type."),
  id: z.string().min(1).optional().describe("Read-only, as get_scene returns it. Never sent to Foundry."),
  managed: z
    .boolean()
    .optional()
    .describe("As get_scene returns it. false means added by hand: the entry is left out, and the behavior stays.")
});

const regionEntrySchema = z.looseObject({
  name: nonBlank.describe("Region name, trimmed. A later sync of the same level set finds the region by it."),
  shapes: z
    .array(z.looseObject({ type: nonBlank.describe("rectangle, circle, ellipse, polygon, or another Foundry type.") }))
    .describe("The shapes of the region, in `frame` coordinates. [] is a region without an area."),
  behaviors: z
    .array(regionBehaviorSchema)
    .optional()
    .describe("The bridge-made behaviors of the region. Omit to leave its behaviors as they are, [] removes them."),
  id: z.string().min(1).optional().describe("Read-only, as get_scene returns it. Never sent to Foundry."),
  managed: z
    .boolean()
    .optional()
    .describe("As get_scene returns it. false means made by hand: the entry is left out, and the region stays."),
  levels: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "As get_scene returns it. An entry whose levels are another level set than the call's levels is left out. Never written: the region gets the call's levels."
    )
});

export const SENSES_SET_VISION =
  "while dnd5e's senseVisionSync setting is on (its default), a token whose actor has a sense that grants sight " +
  "takes its sight range, vision mode and detection modes from the actor's senses: set vision range on the actor, " +
  "and light, sight.angle and sight.enabled on the token";

const imageResultSchema = z.object({
  mimeType: z.string(),
  data: z.string(),
  frame: z.object({ width: z.number(), height: z.number() }),
  background: z.boolean()
});

export const CHECK_WITH_GET_SCENE =
  " The call may still have been applied in Foundry. Check with get_scene before retrying.";

export const SAFER_SCENE_ID =
  " Pass the sceneId from get_scene: the default follows whatever scene the Gamemaster is viewing at that moment.";

export const SCENE_SPECS = {
  get_scene: defineTool({
    description:
      'Read a Foundry scene: id, name, navName ("" when none), folder (path of folder names from the root), active, viewed, shiftX and shiftY (the map shift, see ensure_scene), grid, ' +
      "background image path, levels, every wall, every ambient light, every token and every region. The returned `frame` " +
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
      ". Levels are `{id, name, sort, initial, elevation {bottom, top}, background {src, color}, foreground {src}, " +
      "textures, visibility {levels}}`, as Foundry stores them: initial is true for the level the scene opens on, an " +
      "elevation bound of null is no bound, textures says how the level's images lie over the scene rectangle " +
      "(anchorX, anchorY, offsetX and offsetY in scene pixels, fit, scaleX, scaleY, rotation), and visibility.levels " +
      "are the levels shown together with this one. Levels are created and changed with create_documents and " +
      "update_documents (type Level, parent the scene), and the scene's initialLevel with update_documents. Regions " +
      "are `{id, name, levels, elevation {bottom, top, topInclusive}, shapes, color, visibility, hidden, behaviors, " +
      "managed}`, with restriction while one is enabled and attachment {token} for a region that follows a token. " +
      "visibility is 4 on the region layer while it is unlocked, 0 on the region layer, 1 always for the Gamemaster, " +
      "3 always for observers, 2 always for everyone. shapes are in the same frame as the walls, " +
      REGION_SHAPES +
      " Behaviors are `{id, type, name, disabled, system, managed}`. system is the stored data of the " +
      "behavior type, the source of an executeScript included, but for a UUID that Foundry stores relative to the " +
      "behavior, such as a destination of a teleportToken: that is given as the absolute UUID it names. A region's " +
      "own UUID is Scene.<scene id>.Region.<region id>. The regions can be passed back to sync_regions as they are.",
    input: z.object({
      sceneId,
      tokens: z.array(z.string().min(1)).optional().describe("Ids of tokens to return in full in tokenData.")
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
      "outlined by disposition (green friendly, white neutral, orange hostile, cyan secret) and left unfilled when hidden. " +
      "Set showRegions to draw every region in its own colour: its area filled lightly, with a hole left open, a dashed " +
      "outline, and its name in the middle. Without level the image shows the scene's initial level and the walls, " +
      "lights, tokens and regions of every level. With level, a level id from get_scene, it shows that level as " +
      "Foundry shows it: the level's background and foreground images, placed and scaled by the level's textures, " +
      "over the level's background colour, and the images of the levels it shows with it (visibility.levels). Then " +
      "showWalls, showLights and showRegions draw only what is on that level, which includes what names no levels " +
      "and so is on all of them, and showTokens only the tokens whose level it is. `background` then says whether " +
      "that level has a background image. A level id the scene lacks is refused.",
    input: z.object({
      sceneId,
      maxSize: z.number().int().min(64).max(4096).optional().describe("Longest image side in pixels. Default 1568."),
      level: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Id of the level to render, from get_scene. Default: the scene's initial level, with every level's walls, lights, tokens and regions."
        ),
      showWalls: z.boolean().optional().describe("Draw the scene's walls over the image. Default false."),
      showLights: z.boolean().optional().describe("Draw the scene's ambient lights over the image. Default false."),
      showTokens: z.boolean().optional().describe("Draw the scene's tokens over the image. Default false."),
      showRegions: z.boolean().optional().describe("Draw the scene's regions over the image. Default false.")
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
  sync_regions: defineTool({
    ifOutcomeUnknown:
      " The call may still have been applied in Foundry. Running the same call again is safe: it writes only what still differs.",
    description:
      "Make the bridge-made regions of one level set of a scene exactly the given list, each found by its name. A " +
      "region the list names is updated in place where it exists, so it keeps its id and its UUID, and only what " +
      "differs is written. One that is missing is created, flagged as bridge-made. A bridge-made region of the " +
      "level set that the list does not name is deleted. So an entry under another name deletes the region and " +
      "creates a new one, with another UUID. Regions made by hand carry no flag and are never touched, also when " +
      "one has the name of an entry: the result then lists it under handPlaced, and the bridge-made region of that " +
      "name lies beside it. `regions` may be empty, which only removes the bridge-made regions of the level set. " +
      "levels works as in sync_walls: the call's levels become the levels of every region in it, and the sync owns " +
      "only the bridge-made regions of exactly that level set (no levels means all levels, and a set that names " +
      "every level of the scene counts as no levels). Regions of other level sets stay. A scene of several levels " +
      "takes one call for each level set: one for each single level, and one for each set of levels that a stair " +
      "joins. An entry is name, shapes and any other stored Region field (get_schema with document Region lists " +
      "them): elevation {bottom, top, topInclusive} in grid distance units, where null, the default, is no bound, " +
      "color (#rrggbb, and Foundry picks one for a new region that gives none), visibility and hidden as get_scene " +
      "returns them, restriction {enabled, type, priority}. A field left out of an existing region stays as it " +
      "is. Keys starting with _ and flags.foundry-mcp are refused. shapes are in `frame`, the same frame model as " +
      "sync_walls (omit frame for scene pixels), " +
      REGION_SHAPES +
      " Points and lengths are stored in whole scene pixels. A shape may reach beyond the scene rectangle, " +
      "as Foundry allows. behaviors, when given, are the bridge-made behaviors of the region, brought to the list " +
      "in the same way by name: `{type, name, disabled, system}`. A behavior without a name goes by its type, so a " +
      "region has one unnamed behavior of a type. One that exists under the name and type is updated in place, a " +
      "missing one is created, and a bridge-made one the list does not name is deleted. Behaviors someone added in " +
      "Foundry are never touched. Without behaviors the region keeps the behaviors it has, and behaviors: [] removes " +
      "the bridge-made ones. system is the stored data of the behavior type (get_schema with document " +
      "RegionBehavior and the type lists it). Two types make stairs. changeLevel (system {movementActions}, none " +
      "needed) offers a token that enters the region the other levels the region is on. Sync it in a call whose " +
      "levels are the levels the stair joins, or that has no levels for every level, with the shape where the stair " +
      "is on both maps. On a region of one level it is refused, because it would offer nothing. teleportToken " +
      "(system {destinations, placement: random, center or relative, snap, choice}) moves a token that enters into " +
      "one of its destination regions, on this or another level or scene. For stairs that do not line up, make a " +
      "region at each end with the other as its destination. A destination is the UUID of a region " +
      '(Scene.<scene id>.Region.<region id>), or {region: "<name>"}: the region of that name in this call, or else ' +
      "the one bridge-made region of that name on another level set of this scene. A destination must be on exactly " +
      "one level, or the call is refused: Foundry teleports into no region that is on several. So the two ends of a " +
      "stair between levels are on two level sets and take two calls. A UUID that leads to no region is refused. A " +
      "name that no region has yet is left out and reported as pending in the result of that behavior. So two " +
      "regions on different levels that name each other take three calls the first time: the first level set " +
      "(pending), the second, and the first again. From then on each call finds both and changes nothing. No behavior that " +
      "runs code is created or changed: executeScript and executeMacro are refused as in create_documents. The " +
      "regions of get_scene can be passed back as they are: id is read and never written, an entry with managed: " +
      "false (made by hand) is left out, so is an entry whose own levels are another level set than the call's, and " +
      "so is a behavior with managed: false. If every given region is left out the call is refused, because it " +
      "would otherwise delete the bridge-made regions: only a literally empty `regions` does that. A request that " +
      "cannot be built is refused before anything is written: an unknown field, a shape that encloses nothing at " +
      "that frame (a polygon with fewer than 3 points apart, a width, height or radius of 0), data Foundry's region " +
      "or behavior model refuses, a value Foundry would store as something else, two entries of one name, two " +
      "bridge-made regions of one name in the level set (named with their ids), and a region the call would delete " +
      "that holds behaviors added by hand. Safe to run again with the same input: a second run writes nothing. It " +
      "is not atomic in Foundry: if a write fails midway the error names what was written, and the same call again " +
      "writes what still differs. Returns created, updated and deleted (counts of regions), regions [{id, name, " +
      "created, changed (the field paths whose stored value changed), unapplied (those whose stored value is not the " +
      "one asked for), behaviors [{id, name, type, created, changed, unapplied, pending}], removedBehaviors}] for each " +
      "entry that was not left out, and the scene. An entry Foundry created nothing for has error in place of its " +
      "id. Check the result with get_scene_image and showRegions." +
      SAFER_SCENE_ID,
    input: z.object({
      sceneId,
      frame: frameSchema.optional().describe(frameDescription),
      regions: z.array(regionEntrySchema),
      levels: z
        .array(z.string().min(1))
        .optional()
        .describe("Level ids the regions belong to, and the level set this sync owns. Default: all levels.")
    })
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
  })
};
