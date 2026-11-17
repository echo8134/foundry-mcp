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

export function folderRecords(type) {
  return game.folders
    .filter((folder) => folder.type === type)
    .map((folder) => ({ id: folder.id, name: folder.name, parentId: folder.folder?.id ?? null }));
}
