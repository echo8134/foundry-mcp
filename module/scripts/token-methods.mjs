import { resolveActor } from "./actor-methods.mjs";
import {
  changedPaths,
  diffData,
  explainRecasts,
  isPlainObject,
  pickData,
  recastLeaves,
  sameData
} from "./data-diff.mjs";
import { MethodError } from "./errors.mjs";
import { explainFieldProblems, fieldProblems } from "./field-check.mjs";
import { frameToCanvas } from "./geometry.mjs";
import { FLAG_SCOPE } from "./scope.mjs";
import { tokenCentre } from "./token-data.mjs";
import { cleanedChanges, resolveScene, sceneFrame, sceneRect } from "./world.mjs";

/** Token fields a caller may not give, with what to do instead. */
const NOT_GIVEN = Object.freeze({
  x: "give at, the token's centre",
  y: "give at, the token's centre",
  actorId: "place_tokens takes actor, and a placed token keeps its actor",
  delta: "the token's own actor data is not written by the token tools"
});

const refuse = (index, message) =>
  new MethodError("invalid_params", `tokens[${index}]: ${message} Nothing was written.`);

function checkTokenFields(fields, index) {
  const refused = Object.keys(fields).flatMap((key) => {
    if (Object.hasOwn(NOT_GIVEN, key)) return [`${key} (${NOT_GIVEN[key]})`];
    return key.startsWith("_") ? [`${key} (Foundry keeps it itself)`] : [];
  });
  if (fields.flags !== undefined && !isPlainObject(fields.flags)) refused.push("flags (must be an object)");
  else if (Object.hasOwn(fields.flags ?? {}, FLAG_SCOPE)) refused.push(`flags.${FLAG_SCOPE} (the bridge sets it)`);
  if (refused.length > 0) throw refuse(index, `These keys cannot be given: ${refused.join(", ")}.`);
  const problems = fieldProblems(CONFIG.Token.documentClass.schema, fields);
  if (problems.length > 0) {
    throw refuse(index, `${explainFieldProblems(problems)} get_schema with document Token lists the token fields.`);
  }
}

function checkLevel(scene, level, index) {
  if (!scene.levels.has(level)) {
    throw refuse(index, `The scene has no level ${level}. Its levels: ${[...scene.levels.keys()].join(", ")}.`);
  }
}

function checkKeptAsGiven(given, wanted, index) {
  const recasts = recastLeaves(given, wanted);
  if (recasts.length > 0) throw refuse(index, `${explainRecasts(recasts)} Give each value as Foundry stores it.`);
}

const modelRefusal = (index, error) => refuse(index, `Foundry's token model refuses the data: ${error.message}`);

/** Read when it is used and never carried from prepare to run: a queued ensure_scene may change all of it. */
function sceneGeometry(scene, frame) {
  const rect = sceneRect(scene);
  const { width, height } = scene.dimensions;
  return { rect, frame: frame ?? sceneFrame(rect), canvas: { width, height } };
}

function canvasPoint(at, { frame, rect }, index) {
  // The far edges are outside, as in Foundry's own test of a drop (client/canvas/layers/tokens.mjs:980).
  if (at[0] < 0 || at[0] >= frame.width || at[1] < 0 || at[1] >= frame.height) {
    throw refuse(
      index,
      `at [${at.join(", ")}] lies outside the scene rectangle, which is ${frame.width} x ${frame.height} in this frame and ends before its far edges.`
    );
  }
  const point = frameToCanvas(at, frame, rect);
  if (!point.every(Number.isSafeInteger)) {
    throw refuse(index, `at is too large once converted to scene pixels: [${point.join(", ")}].`);
  }
  return point;
}

/** The top-left corner that puts the token's centre on at, as a drop onto the map does (client/canvas/placeables/token.mjs:2753). */
function cornerAt(token, at, size, snap, geometry, index) {
  const [x, y] = canvasPoint(at, geometry, index);
  const pivot = token.getCenterPoint({ x: 0, y: 0, ...size });
  const dropped = { x: x - pivot.x, y: y - pivot.y };
  const placed = snap ? token.getSnappedPosition({ ...dropped, ...size }) : dropped;
  const corner = { x: Math.round(placed.x), y: Math.round(placed.y) };
  // On the viewed scene Foundry moves no token to a centre outside the canvas (client/canvas/placeables/token.mjs:3029-3033).
  const centre = [corner.x + pivot.x, corner.y + pivot.y];
  const { width, height } = geometry.canvas;
  if (centre[0] < 0 || centre[0] >= width || centre[1] < 0 || centre[1] >= height) {
    throw refuse(
      index,
      `at [${at.join(", ")}] puts the token's centre at canvas pixel [${centre.join(", ")}], on or beyond the edge of the canvas, where Foundry moves no token. Give a point further inside${snap ? ", or snap: false" : ""}.`
    );
  }
  return corner;
}

/** A caller names the position as at, so a difference in x or y is a difference in at. */
const bridgePaths = (paths) => [...new Set(paths.map((path) => (path === "x" || path === "y" ? "at" : path)))];

async function placeableActor(ref, index) {
  let actor;
  try {
    actor = await resolveActor(ref);
  } catch (error) {
    if (!(error instanceof MethodError)) throw error;
    throw new MethodError(error.code, `tokens[${index}]: ${error.message} Nothing was written.`);
  }
  if (actor.pack) {
    throw refuse(
      index,
      `${ref} is an actor in the compendium ${actor.pack}. Import it into the world and pass the world actor's id.`
    );
  }
  if (actor.isToken) {
    throw refuse(index, `${ref} is the actor of a token. Pass the id of its world actor, the token's actorId.`);
  }
  return actor;
}

/**
 * The token actor.getTokenDocument would build, without what that call numbers and draws by chance: the name of a copy
 * and a wildcard image, of which each call uses up one (client/documents/actor.mjs:342-368).
 */
function unnumberedToken(actor, scene, data) {
  const merged = foundry.utils.mergeObject(actor.prototypeToken.toObject(), {
    ...structuredClone(data),
    actorId: actor.id
  });
  return new CONFIG.Token.documentClass(merged, { parent: scene });
}

/** Every check of a placement, and the data and corner of each token. Reads only. */
async function planPlacement(scene, { frame, tokens }) {
  const geometry = sceneGeometry(scene, frame);
  const entries = [];
  for (const [index, { actor: ref, at, snap = true, ...fields }] of tokens.entries()) {
    checkTokenFields(fields, index);
    const actor = await placeableActor(ref, index);
    const level = fields.level === undefined ? scene.initialLevel.id : fields.level;
    checkLevel(scene, level, index);
    const data = {
      ...fields,
      level,
      // The base elevation of the level (client/documents/level.mjs:62-66), as a drop onto the viewed level gets it.
      elevation: fields.elevation === undefined ? scene.levels.get(level).elevation.base : fields.elevation,
      flags: { ...fields.flags, [FLAG_SCOPE]: { managed: true } }
    };
    let token;
    try {
      token = unnumberedToken(actor, scene, data);
    } catch (error) {
      throw modelRefusal(index, error);
    }
    checkKeptAsGiven(data, token._source, index);
    const { width, height, shape } = token._source;
    const corner = cornerAt(token, at, { width, height, shape }, snap, geometry, index);
    entries.push({ index, actor, data, asked: fields, corner });
  }
  return { geometry, entries };
}

export async function preparePlacement(request) {
  const scene = resolveScene(request.sceneId);
  await planPlacement(scene, request);
  return { scene, request };
}

export async function placeTokens({ scene, request }) {
  // Planned again inside the write queue: a write queued before this one may have moved the scene rectangle or removed an
  // actor or a level since prepare looked.
  const { geometry, entries } = await planPlacement(scene, request);
  const tokens = [];
  for (const { index, actor, data, asked, corner } of entries) {
    let token;
    let created;
    try {
      // Built and created one at a time, so each copy is numbered after the ones created before it. Without parent
      // Foundry takes the viewed scene, and with it the level, the shape and the numbering (client/documents/actor.mjs:340, :362-367).
      token = await actor.getTokenDocument(structuredClone(data), { parent: scene });
      // A token created with a sort keeps it, and one without goes above the others (client/documents/abstract/canvas-document.mjs:122-128).
      const { sort, ...source } = token.toObject();
      const stacked = asked.sort === undefined ? source : { ...source, sort };
      [created] = await scene.createEmbeddedDocuments("Token", [{ ...stacked, ...corner }]);
    } catch (error) {
      const made = tokens.map((placed) => placed.id);
      const before =
        made.length > 0
          ? `Created before it, and left on the scene: ${made.join(", ")}.`
          : "No token was created before it.";
      throw new MethodError(
        "foundry_error",
        `tokens[${index}]: Foundry failed while creating the token (${error.message}). ${before} The entries after it were not tried. get_scene lists the tokens the scene has now.`
      );
    }
    if (!created) continue;
    const wanted = { ...pickData(token._source, asked), ...corner };
    const unapplied = bridgePaths(diffData(wanted, created._source).paths);
    tokens.push({
      id: created.id,
      name: created.name,
      actorId: created.actorId,
      at: tokenCentre(created, geometry.frame, geometry.rect),
      ...(unapplied.length > 0 && { unapplied })
    });
  }
  return { created: tokens.length, requested: entries.length, tokens, sceneId: scene.id, sceneName: scene.name };
}

function tokensOnScene(scene, ids) {
  const missing = ids.filter((id) => !scene.tokens.has(id));
  if (missing.length > 0) {
    throw new MethodError(
      "not_found",
      `The scene ${scene.name} has no token with the id ${missing.join(", ")}. Nothing was written. get_scene lists its tokens.`
    );
  }
  return ids.map((id) => scene.tokens.get(id));
}

/**
 * The corner for a given at. A token whose centre is on at already and whose size stays does not move, whatever snap
 * says: an entry read with get_scene and passed back must not snap a token someone put off the grid.
 */
function cornerChange(token, at, snap, wanted, geometry, index) {
  const source = token._source;
  const size = {
    width: wanted.width ?? source.width,
    height: wanted.height ?? source.height,
    shape: wanted.shape ?? source.shape
  };
  const resized = Object.keys(size).some((key) => size[key] !== source[key]);
  const centre = tokenCentre(token, geometry.frame, geometry.rect);
  if (!resized && at[0] === centre[0] && at[1] === centre[1]) return {};
  return cornerAt(token, at, size, snap, geometry, index);
}

/**
 * get_scene returns the stored actorId and the bridge's own flag in tokenData, and an entry read there can be passed
 * back as it is. So both are taken while they equal what is stored, and are no part of the change.
 */
function withoutStoredIdentity({ actorId, ...fields }, source, index) {
  if (actorId !== undefined && actorId !== source.actorId) {
    throw refuse(index, "actorId cannot be changed: a placed token keeps its actor. Leave it out.");
  }
  const { flags } = fields;
  if (!isPlainObject(flags) || !Object.hasOwn(flags, FLAG_SCOPE)) return fields;
  if (!sameData(flags[FLAG_SCOPE], source.flags?.[FLAG_SCOPE])) return fields;
  const { [FLAG_SCOPE]: _stored, ...others } = flags;
  return { ...fields, flags: others };
}

/** Every check of an update, and for each token what Foundry would store and which part of it differs. Reads only. */
function planUpdate(scene, { frame, tokens }) {
  const geometry = sceneGeometry(scene, frame);
  const ids = tokens.map((entry) => entry.id);
  const repeated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (repeated.length > 0) {
    throw new MethodError(
      "invalid_params",
      `The token id ${repeated.join(", ")} is given more than once. Give each token once, with all its changes. Nothing was written.`
    );
  }
  const found = tokensOnScene(scene, ids);
  const plans = tokens.map(({ id: _id, at, snap = true, ...given }, index) => {
    const token = found[index];
    const fields = withoutStoredIdentity(given, token._source, index);
    checkTokenFields(fields, index);
    if (fields.level !== undefined) checkLevel(scene, fields.level, index);
    let wanted;
    try {
      wanted = cleanedChanges(token, fields);
    } catch (error) {
      throw modelRefusal(index, error);
    }
    checkKeptAsGiven(fields, wanted, index);
    if (at !== undefined) Object.assign(wanted, cornerChange(token, at, snap, wanted, geometry, index));
    return { token, wanted, ...diffData(wanted, token._source) };
  });
  return { geometry, plans };
}

export function prepareUpdate(request) {
  const scene = resolveScene(request.sceneId);
  planUpdate(scene, request);
  return { scene, request };
}

/** What the stored data shows after a write that threw: Foundry may have applied a part of it. */
function describeWritten(plans, before) {
  const changed = plans.map(({ token, wanted }, index) => ({
    id: token.id,
    paths: bridgePaths(changedPaths(wanted, before[index], token._source))
  }));
  const written = changed.filter(({ paths }) => paths.length > 0).map(({ id, paths }) => `${id} (${paths.join(", ")})`);
  if (written.length === 0) return "None of the given tokens was changed.";
  const unwritten = changed
    .filter(({ paths }, index) => paths.length === 0 && plans[index].paths.length > 0)
    .map(({ id }) => id);
  const rest = unwritten.length > 0 ? ` Not changed: ${unwritten.join(", ")}.` : "";
  return `Changed in the stored data: ${written.join("; ")}.${rest}`;
}

/**
 * A change to a movement field goes through moveTokens as a displacement that ignores walls and movement cost, as
 * Foundry's own token configuration moves a token (client/applications/sheets/token/token-config.mjs:152-157). It opens
 * no level-change dialog (client/data/region-behaviors/change-level.mjs:64). Without the two options Foundry stops a
 * token of the viewed scene short of a wall its centre would end on.
 */
export async function updateTokens({ scene, request }) {
  // Planned again inside the write queue: see placeTokens.
  const { geometry, plans } = planUpdate(scene, request);
  const movementFields = CONFIG.Token.documentClass.MOVEMENT_FIELDS;
  const before = plans.map(({ token, wanted }) => pickData(token._source, wanted));
  const moves = {};
  const updates = [];
  for (const { token, paths, changes } of plans) {
    if (paths.length === 0) continue;
    if (Object.keys(changes).some((key) => movementFields.includes(key))) {
      moves[token.id] = {
        destination: { ...changes, action: "displace" },
        constrainOptions: { ignoreWalls: true, ignoreCost: true }
      };
    } else {
      updates.push({ _id: token.id, ...changes });
    }
  }
  const write = async (what, ids, run) => {
    if (ids.length === 0) return;
    try {
      await run();
    } catch (error) {
      throw new MethodError(
        "foundry_error",
        `Foundry failed while ${what} ${ids.join(", ")} (${error.message}). ${describeWritten(plans, before)} Running the call again writes what still differs.`
      );
    }
  };
  await write("moving the tokens", Object.keys(moves), () => scene.moveTokens(moves, { animate: false }));
  await write(
    "updating the tokens",
    updates.map((update) => update._id),
    () => scene.updateEmbeddedDocuments("Token", updates)
  );
  return {
    tokens: plans.map(({ token, wanted }, index) => {
      const unapplied = bridgePaths(diffData(wanted, token._source).paths);
      return {
        id: token.id,
        at: tokenCentre(token, geometry.frame, geometry.rect),
        changed: bridgePaths(changedPaths(wanted, before[index], token._source)),
        ...(unapplied.length > 0 && { unapplied })
      };
    }),
    sceneId: scene.id,
    sceneName: scene.name
  };
}

export async function deleteTokens({ scene, request: { ids } }) {
  const existing = [...new Set(ids)].filter((id) => scene.tokens.has(id));
  const target = { sceneId: scene.id, sceneName: scene.name };
  if (existing.length === 0) return { deleted: 0, ...target };
  const deleted = await scene.deleteEmbeddedDocuments("Token", existing);
  return { deleted: deleted.length, ...target };
}
