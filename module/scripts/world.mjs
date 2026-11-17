import { MethodError } from "./errors.mjs";

export function resolveScene(sceneId) {
  const scene = sceneId ? game.scenes.get(sceneId) : (canvas.scene ?? game.scenes.active);
  if (scene) return scene;
  throw new MethodError(
    "not_found",
    sceneId ? `No scene with id ${sceneId}.` : "No scene is being viewed or active. Pass a sceneId."
  );
}

export function sceneRect(scene) {
  const { sceneX: x, sceneY: y, sceneWidth: width, sceneHeight: height } = scene.dimensions;
  return { x, y, width, height };
}

export function sceneFrame(rect) {
  return { width: rect.width, height: rect.height };
}

/**
 * The given changes as Foundry would store them on the document. validate with changes is a dry run of the update
 * (common/abstract/data.mjs:575-597). It cleans a copy unless clean.copy is false, and it leaves out the migrate and
 * model steps of the update's own cleaning unless asked for them (client/data/client-backend.mjs:231-235).
 * @param {{validate: (options: object) => boolean}} document
 * @param {Record<string, unknown>} given
 * @returns {Record<string, unknown>}
 * @throws the error of Foundry's data model, for changes it refuses
 */
export function cleanedChanges(document, given) {
  const wanted = structuredClone(given);
  document.validate({ changes: wanted, clean: { copy: false, migrate: true, model: true } });
  return wanted;
}

export function folderRecords(type) {
  return game.folders
    .filter((folder) => folder.type === type)
    .map((folder) => ({ id: folder.id, name: folder.name, parentId: folder.folder?.id ?? null }));
}
