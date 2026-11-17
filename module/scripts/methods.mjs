import { getActor, getSchema, listActors } from "./actor-methods.mjs";
import { MethodError } from "./errors.mjs";
import { folderPath, folderScope, resolveFolderPath } from "./folders.mjs";
import { canvasToFrame, frameToCanvas, pathsToSegments } from "./geometry.mjs";
import { lightData, lightFields } from "./light-data.mjs";
import {
  canvasOverflow,
  planSceneChanges,
  scenesNamed,
  touchesGeometry,
  touchesThumbnail,
  unknownSceneFields
} from "./scene-data.mjs";
import { drawLights, drawTokens, drawWalls } from "./scene-drawing.mjs";
import { FLAG_SCOPE, isManaged, replacedBySync, sameLevelSet } from "./scope.mjs";
import { tokenFields } from "./token-data.mjs";
import { classifyWall, wallFields } from "./wall-kinds.mjs";
import { folderRecords, resolveScene, sceneFrame, sceneRect } from "./world.mjs";
import { createWriteQueue } from "./write-queue.mjs";

const THUMBNAIL_PENDING = "thumbnailPending";
const DEFAULT_MAX_SIZE = 1568;
export const QUEUE_BUDGET_MS = {
  create_walls: 25_000,
  delete_walls: 25_000,
  sync_walls: 25_000,
  sync_lights: 25_000,
  ensure_scene: 85_000
};

export const timing = { textureLoadMs: 30_000 };

function withTimeout(promise, ms, makeError) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), Math.max(0, ms));
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** foundry.canvas.loadTexture logs a failed load and resolves null (client/canvas/loader.mjs). */
function loadBackground(src) {
  return withTimeout(
    foundry.canvas.loadTexture(src),
    timing.textureLoadMs,
    () =>
      new MethodError(
        "foundry_error",
        `The image ${src} did not load within ${Math.round(timing.textureLoadMs / 1000)} seconds.`
      )
  );
}

function scenePath(scene, folders) {
  return folderPath(folders, scene.folder?.id ?? null) ?? [];
}

function gridType(grid) {
  if (grid.isGridless) return "gridless";
  return grid.isSquare ? "square" : "hex";
}

async function getScene({ sceneId }) {
  const scene = resolveScene(sceneId);
  const rect = sceneRect(scene);
  const frame = sceneFrame(rect);
  const { grid } = scene;
  return {
    id: scene.id,
    name: scene.name,
    navName: scene.navName ?? "",
    folder: scenePath(scene, folderRecords("Scene")),
    active: scene.active,
    viewed: canvas.scene?.id === scene.id,
    frame,
    shiftX: scene.shiftX ?? 0,
    shiftY: scene.shiftY ?? 0,
    grid: { type: gridType(grid), size: grid.size, distance: grid.distance, units: grid.units },
    background: { src: scene.initialLevel?.background?.src ?? null },
    levels: scene.levels.map((level) => ({ id: level.id, name: level.name })),
    walls: scene.walls.map((wall) => {
      const [x1, y1] = canvasToFrame([wall.c[0], wall.c[1]], frame, rect);
      const [x2, y2] = canvasToFrame([wall.c[2], wall.c[3]], frame, rect);
      return {
        id: wall.id,
        c: [x1, y1, x2, y2],
        kind: classifyWall(wall),
        door: wall.door,
        ds: wall.ds,
        levels: [...wall.levels],
        managed: isManaged(wall)
      };
    }),
    // AmbientLightDocument#prepareDerivedData clamps x and y to the canvas (client/documents/ambient-light.mjs).
    lights: scene.lights.map((light) => ({
      id: light.id,
      at: canvasToFrame([light._source.x, light._source.y], frame, rect),
      levels: [...light.levels],
      ...lightFields(light),
      managed: isManaged(light)
    })),
    tokens: scene.tokens.map((token) => tokenFields(token, frame, rect))
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The rendered scene image could not be decoded."));
    image.src = src;
  });
}

async function getSceneImage({
  sceneId,
  maxSize = DEFAULT_MAX_SIZE,
  showWalls = false,
  showLights = false,
  showTokens = false
}) {
  const scene = resolveScene(sceneId);
  const rect = sceneRect(scene);
  const scale = Math.min(1, maxSize / Math.max(rect.width, rect.height));
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));

  const src = scene.initialLevel?.background?.src ?? null;
  // Scene#createThumbnail draws no mesh for a texture that did not load (client/documents/scene.mjs).
  if (src && !(await loadBackground(src))) {
    throw new MethodError("foundry_error", `The scene's background image ${src} could not be loaded.`);
  }

  let thumb;
  try {
    ({ thumb } = await scene.createThumbnail({ width, height, format: "image/webp", quality: 0.9 }));
  } catch (error) {
    throw new MethodError("foundry_error", `Foundry could not render the scene: ${error.message}`);
  }

  const surface = document.createElement("canvas");
  surface.width = width;
  surface.height = height;
  const context = surface.getContext("2d");
  context.fillStyle = scene.initialLevel?.background?.color ?? "#999999";
  context.fillRect(0, 0, width, height);
  context.drawImage(await loadImage(thumb), 0, 0, width, height);
  if (showWalls) drawWalls(context, scene, rect, width, height);
  if (showLights) drawLights(context, scene, rect, width, height);
  if (showTokens) drawTokens(context, scene, rect, width, height);

  const dataUrl = surface.toDataURL("image/webp", 0.9);
  const [, mimeType, data] = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl) ?? [];
  if (!data) throw new MethodError("foundry_error", "The browser could not encode the scene image.");
  return { mimeType, data, frame: { width, height }, background: src !== null };
}

const sceneLevelIds = (scene) => [...scene.levels.keys()];

function checkLevels(scene, levels) {
  const unknownLevels = levels.filter((id) => !scene.levels.has(id));
  if (unknownLevels.length > 0) {
    throw new MethodError("invalid_params", `Unknown level ids for scene ${scene.id}: ${unknownLevels.join(", ")}.`);
  }
}

function checkAnimations(lights) {
  for (const { animation, negative } of lights) {
    if (animation === undefined) continue;
    const table = negative ? CONFIG.Canvas.darknessAnimations : CONFIG.Canvas.lightAnimations;
    if (!Object.hasOwn(table, animation.type)) {
      const kind = negative ? "darkness source" : "light";
      throw new MethodError(
        "invalid_params",
        `Unknown animation "${animation.type}" for a ${kind}. Use one of: ${Object.keys(table).join(", ")}.`
      );
    }
  }
}

function buildWalls(scene, { frame, paths, levels = [] }) {
  const { segments, skipped, unstorable } = pathsToSegments(
    paths,
    frame ?? sceneFrame(sceneRect(scene)),
    sceneRect(scene)
  );
  if (unstorable) {
    throw new MethodError(
      "invalid_params",
      `A wall coordinate is too large once converted to scene pixels (the bridge stores only safe integers): [${unstorable.join(", ")}].`
    );
  }
  const data = segments.map(({ c, kind, state }) => ({
    c,
    levels,
    flags: { [FLAG_SCOPE]: { managed: true } },
    ...wallFields(kind, scene.grid.distance, state)
  }));
  return { data, skipped };
}

function buildLights(scene, { frame, lights, levels = [] }) {
  const rect = sceneRect(scene);
  return lights.map((light) => {
    const point = frameToCanvas(light.at, frame ?? sceneFrame(rect), rect);
    if (!point.every(Number.isSafeInteger)) {
      throw new MethodError(
        "invalid_params",
        `A light position is too large once converted to scene pixels (the bridge stores only safe integers): [${point.join(", ")}].`
      );
    }
    return lightData(light, point, levels, { [FLAG_SCOPE]: { managed: true } });
  });
}

/**
 * Foundry skips a document that fails validation or that a hook refuses, on create and on delete, and resolves with
 * the rest (client/data/client-backend.mjs, #preCreateDocumentArray and #preDeleteDocumentArray).
 */
async function undoPartialCreate(scene, documentName, created, requested, noun) {
  const ids = created.map((document) => document.id);
  let removedIds = [];
  let failure = null;
  try {
    if (ids.length > 0)
      removedIds = (await scene.deleteEmbeddedDocuments(documentName, ids)).map((document) => document.id);
  } catch (error) {
    failure = error;
  }
  const removed = removedIds.length;
  const remaining = ids.filter((id) => !removedIds.includes(id));
  const left = remaining.length;
  let outcome = `The ${ids.length} it did create were deleted again`;
  if (failure) {
    outcome = `The ${ids.length} it did create could not be deleted again (${failure.message})`;
  } else if (left > 0) {
    outcome = `Only ${removed} of the ${ids.length} it did create were deleted again (Foundry skips a deletion that a hook refuses)`;
  }
  if (left > 0) {
    outcome += `; ${left} remain in the scene. They are flagged as bridge-made, so the next sync of the same level set removes them (ids ${remaining.join(", ")})`;
  }
  throw new MethodError(
    "foundry_error",
    `Foundry created ${ids.length} of ${requested} ${noun}: it skips one that fails its validation or that a hook refuses. ${outcome}, and the existing ${noun} were left in place.`
  );
}

const checkWallRequest = (scene, { levels = [] }) => checkLevels(scene, levels);

function checkLightRequest(scene, request) {
  const { levels = [], lights } = request;
  checkLevels(scene, levels);
  const sceneLevels = sceneLevelIds(scene);
  const owned = lights.filter((light) => light.levels === undefined || sameLevelSet(light.levels, levels, sceneLevels));
  if (lights.length > 0 && owned.length === 0) {
    throw new MethodError(
      "invalid_params",
      `All ${lights.length} given lights were left out, so nothing was changed. Each one's own levels are another level set than this call's (${levels.length > 0 ? levels.join(", ") : "none, which means all levels"}), and the entries with managed: false were left out before that. Pass the levels of these lights as the call's levels, or pass lights: [] to remove the bridge-made lights.`
    );
  }
  checkAnimations(owned);
  return { ...request, lights: owned };
}

async function createWalls({ scene, request }) {
  const { data, skipped } = buildWalls(scene, request);
  const target = { sceneId: scene.id, sceneName: scene.name };
  if (data.length === 0) return { created: 0, requested: 0, ids: [], skipped, ...target };
  const created = await scene.createEmbeddedDocuments("Wall", data);
  return { created: created.length, requested: data.length, ids: created.map((wall) => wall.id), skipped, ...target };
}

async function syncWalls({ scene, request }) {
  const { data, skipped } = buildWalls(scene, request);
  if (request.paths.length > 0 && data.length === 0) {
    throw new MethodError(
      "invalid_params",
      "Every segment of the given paths collapses to a point at this frame, so there is nothing to draw. Nothing was changed. Check the frame, or pass empty paths to remove the bridge-made walls."
    );
  }
  const target = { sceneId: scene.id, sceneName: scene.name };
  // Create first, delete after: a failed create leaves the scene as it was, and the next sync clears what a crash left.
  const replaced = scene.walls
    .filter((wall) => replacedBySync(wall, request.levels ?? [], sceneLevelIds(scene)))
    .map((wall) => wall.id);
  const created = data.length > 0 ? await scene.createEmbeddedDocuments("Wall", data) : [];
  if (created.length < data.length) await undoPartialCreate(scene, "Wall", created, data.length, "walls");
  const deleted = replaced.length > 0 ? (await scene.deleteEmbeddedDocuments("Wall", replaced)).length : 0;
  return { deleted, created: created.length, ids: created.map((wall) => wall.id), skipped, ...target };
}

async function syncLights({ scene, request }) {
  const data = buildLights(scene, request);
  const target = { sceneId: scene.id, sceneName: scene.name };
  const replaced = scene.lights
    .filter((light) => replacedBySync(light, request.levels ?? [], sceneLevelIds(scene)))
    .map((light) => light.id);
  const created = data.length > 0 ? await scene.createEmbeddedDocuments("AmbientLight", data) : [];
  if (created.length < data.length) await undoPartialCreate(scene, "AmbientLight", created, data.length, "lights");
  const deleted = replaced.length > 0 ? (await scene.deleteEmbeddedDocuments("AmbientLight", replaced)).length : 0;
  return { deleted, created: created.length, ids: created.map((light) => light.id), ...target };
}

async function deleteWalls({ scene, request: { ids, all } }) {
  const existing = all ? scene.walls.map((wall) => wall.id) : ids.filter((id) => scene.walls.has(id));
  const target = { sceneId: scene.id, sceneName: scene.name };
  if (existing.length === 0) return { deleted: 0, ...target };
  const deleted = await scene.deleteEmbeddedDocuments("Wall", existing);
  return { deleted: deleted.length, ...target };
}

async function listScenes({ folder }) {
  const folders = folderRecords("Scene");
  const scope = folderScope(folders, folder);
  if (!scope) throw new MethodError("not_found", `No scene folder at path ${JSON.stringify(folder)}.`);
  const scenes = game.scenes
    .map((scene) => ({ scene, path: scenePath(scene, folders) }))
    .filter(({ path }) => scope.inScope(path))
    .map(({ scene, path }) => {
      const { grid } = scene;
      return {
        id: scene.id,
        name: scene.name,
        navName: scene.navName ?? "",
        folder: path,
        active: scene.active,
        viewed: canvas.scene?.id === scene.id,
        width: scene.width,
        height: scene.height,
        shiftX: scene.shiftX ?? 0,
        shiftY: scene.shiftY ?? 0,
        grid: { type: gridType(grid), size: grid.size, distance: grid.distance, units: grid.units },
        background: { src: scene.initialLevel?.background?.src ?? null },
        walls: { total: scene.walls.size, managed: scene.walls.filter(isManaged).length },
        lights: { total: scene.lights.size, managed: scene.lights.filter(isManaged).length },
        tokens: { total: scene.tokens.size, managed: scene.tokens.filter(isManaged).length }
      };
    });
  return { folders: scope.folders, scenes };
}

function findSceneToEnsure({ sceneId, name, folder = [] }, lookupFolderId) {
  if (sceneId) {
    const scene = game.scenes.get(sceneId);
    if (!scene) throw new MethodError("not_found", `No scene with id ${sceneId}.`);
    return scene;
  }
  if (lookupFolderId === undefined) return null;
  const records = game.scenes.map((scene) => ({ scene, name: scene.name, folderId: scene.folder?.id ?? null }));
  const matches = scenesNamed(records, name, lookupFolderId);
  if (matches.length > 1) {
    const where = folder.length > 0 ? `folder ${JSON.stringify(folder)}` : "the root";
    const ids = matches.map((match) => match.scene.id).join(", ");
    throw new MethodError(
      "invalid_params",
      `${matches.length} scenes named "${name}" in ${where} (${ids}). Pass a sceneId.`
    );
  }
  return matches[0]?.scene ?? null;
}

async function checkEnsureSceneInput(input) {
  const { folder, background, weather } = input;
  const unknown = unknownSceneFields(input);
  if (unknown.length > 0) {
    throw new MethodError(
      "invalid_params",
      `This Foundry module does not know the ensure_scene field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. The Foundry tab probably still runs an older module than the server: reload Foundry (F5) and call again.`
    );
  }
  const maxDepth = CONST.FOLDER_MAX_DEPTH;
  if (folder && folder.length > maxDepth) {
    throw new MethodError(
      "invalid_params",
      `Foundry allows folders at most ${maxDepth} levels deep, the path has ${folder.length}.`
    );
  }
  if (weather && !Object.hasOwn(CONFIG.weatherEffects, weather)) {
    throw new MethodError(
      "invalid_params",
      `Unknown weather "${weather}". Use one of: ${Object.keys(CONFIG.weatherEffects).join(", ")}, or "" for none.`
    );
  }
  if (background && !(await loadBackground(background.src))) {
    throw new MethodError("invalid_params", `The background image ${background.src} could not be loaded.`);
  }
  return input;
}

/**
 * Foundry rescales grid.size by the map's average scale when a repositioning update carries none
 * (client/documents/scene.mjs, #repositionObjects).
 */
const withGridSize = (changes, stored) => ({
  ...changes,
  grid: { ...changes.grid, size: changes.grid?.size ?? stored.grid.size }
});

/** Measured on a clone with the changes, as #repositionObjects measures them (client/documents/scene.mjs). */
function checkInsideCanvas(existing, changes) {
  const probe = existing
    ? existing.clone(withGridSize(changes, existing._source))
    : new CONFIG.Scene.documentClass({ name: "dimensions", ...changes });
  const { dimensions } = probe;
  if (!dimensions) {
    throw new MethodError(
      "foundry_error",
      "Foundry could not work out the scene dimensions for this change (its data preparation failed, see the browser console), so the map could not be checked against the canvas. Nothing was changed."
    );
  }
  const messages = canvasOverflow(dimensions, { x: probe.shiftX ?? 0, y: probe.shiftY ?? 0 }).map(
    ({ axis, shift, over, min, max }) => {
      const name = `shift${axis.toUpperCase()}`;
      return `${name} ${shift} would leave ${Number(over.toFixed(1))} px of the map outside the canvas, where Foundry does not draw it and tokens cannot go. With the width, height, padding and grid this call leaves, ${name} can be from ${min} to ${max}: lower the shift or raise padding.`;
    }
  );
  if (messages.length > 0) throw new MethodError("invalid_params", `Nothing was changed. ${messages.join(" ")}`);
}

async function createMissingFolders(parentId, names) {
  let id = parentId;
  for (const name of names) {
    const created = await foundry.documents.Folder.create({ name, type: "Scene", folder: id });
    id = created.id;
  }
  return id;
}

/** Foundry renders a thumbnail itself only in Scene#_preCreate with a background, never on update (client/documents/scene.mjs). */
async function refreshThumbnail(scene) {
  const src = scene.initialLevel?.background?.src;
  if (!src) return;
  if (!(await loadBackground(src))) {
    throw new MethodError(
      "foundry_error",
      `The scene was saved but its background image ${src} could not be loaded, so no thumbnail was rendered. Run the call again once the image loads.`
    );
  }
  let thumb;
  try {
    ({ thumb } = await scene.createThumbnail());
  } catch (error) {
    throw new MethodError(
      "foundry_error",
      `The scene was saved but Foundry could not render its thumbnail: ${error.message}`
    );
  }
  await scene.update({ thumb, flags: { [FLAG_SCOPE]: { [THUMBNAIL_PENDING]: false } } }, { diff: false });
}

async function ensureScene(input) {
  const folders = folderRecords("Scene");
  const wanted = input.folder ?? [];
  const resolved = resolveFolderPath(folders, wanted);
  if (resolved.ambiguous) {
    throw new MethodError(
      "invalid_params",
      `Two scene folders share the path ${JSON.stringify(resolved.ambiguous)}. Rename one.`
    );
  }
  const lookupFolderId = resolved.missing.length === 0 ? (resolved.chain.at(-1)?.id ?? null) : undefined;
  const existing = findSceneToEnsure(input, lookupFolderId);
  if (!existing && (input.width === undefined || input.height === undefined)) {
    throw new MethodError("invalid_params", "Creating a scene needs width and height.");
  }

  const current = existing
    ? { scene: existing._source, level: existing.initialLevel._source }
    : { scene: {}, level: {} };
  const geometry = planSceneChanges({ ...input, folder: undefined }, current);
  if (touchesGeometry(geometry.changed)) checkInsideCanvas(existing, geometry.scene);

  const folderId =
    input.folder === undefined
      ? undefined
      : await createMissingFolders(resolved.chain.at(-1)?.id ?? null, resolved.missing);
  const wantedFields = { ...input, folder: folderId };
  const plan = planSceneChanges(wantedFields, current);
  // Set in the same write as the change, so a crash or a failed render leaves the marker for the next run.
  const hasBackground = Boolean(input.background?.src ?? current.level.background?.src);
  if (hasBackground && touchesThumbnail(plan.changed))
    plan.scene.flags = { [FLAG_SCOPE]: { [THUMBNAIL_PENDING]: true } };

  let scene = existing;
  if (!scene) {
    scene = await foundry.documents.Scene.create({ ...plan.scene, active: false });
  } else if (Object.keys(plan.scene).length > 0) {
    const reposition = touchesGeometry(plan.changed);
    if (reposition) plan.scene.grid = withGridSize(plan.scene, scene._source).grid;
    await scene.update(plan.scene, reposition ? { autoReposition: true } : {});
  }
  if (Object.keys(plan.level).length > 0) {
    await scene.updateEmbeddedDocuments("Level", [{ _id: scene.initialLevel.id, ...plan.level }]);
  }
  const pending = scene.flags?.[FLAG_SCOPE]?.[THUMBNAIL_PENDING] === true;
  if (pending || !scene.thumb) await refreshThumbnail(scene);

  // Foundry may drop or round a given value, for example darknessLevel under darknessLock (Scene#_preUpdate,
  // client/documents/scene.mjs).
  const unapplied = planSceneChanges(wantedFields, { scene: scene._source, level: scene.initialLevel._source }).changed;
  return {
    id: scene.id,
    name: scene.name,
    folder: scenePath(scene, folderRecords("Scene")),
    created: !existing,
    changed: plan.changed.filter((key) => !unapplied.includes(key)),
    unapplied
  };
}

const writeQueue = createWriteQueue({ fail: (message) => new MethodError("foundry_error", message) });
// prepare may run beside a running call, so it must only read.
const serialised = (name, prepare, run) => (params) =>
  writeQueue.submit(name, QUEUE_BUDGET_MS[name], () => prepare(params), run);

const onScene =
  (check) =>
  ({ sceneId, ...request }) => {
    const scene = resolveScene(sceneId);
    return { scene, request: check?.(scene, request) ?? request };
  };

export const METHODS = Object.freeze({
  get_scene: getScene,
  get_scene_image: getSceneImage,
  create_walls: serialised("create_walls", onScene(checkWallRequest), createWalls),
  delete_walls: serialised("delete_walls", onScene(), deleteWalls),
  sync_walls: serialised("sync_walls", onScene(checkWallRequest), syncWalls),
  sync_lights: serialised("sync_lights", onScene(checkLightRequest), syncLights),
  list_scenes: listScenes,
  ensure_scene: serialised("ensure_scene", checkEnsureSceneInput, ensureScene),
  list_actors: listActors,
  get_actor: getActor,
  get_schema: getSchema
});
