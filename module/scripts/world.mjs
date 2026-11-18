import { dropAt, pickData } from "./data-diff.mjs";
import { MethodError } from "./errors.mjs";
import { fieldProblems } from "./field-check.mjs";
import { resolveFolderPath } from "./folders.mjs";
import { canonicalNodes, canonicalStyle } from "./html.mjs";
import { TYPED_ENTRY_SCHEMAS } from "./item-data.mjs";

export const timing = { textureLoadMs: 30_000 };

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

function withTimeout(promise, ms, makeError) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), Math.max(0, ms));
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** foundry.canvas.loadTexture logs a failed load and resolves null (client/canvas/loader.mjs). */
export function loadTexture(src) {
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

/** The cleaning an update gets: with the migrations and the model's own step (client/data/client-backend.mjs:231-235). */
const AS_AN_UPDATE = Object.freeze({ migrate: true, model: true });

/**
 * The given changes as Foundry would store them on the document. validate with changes is a dry run of the update
 * (common/abstract/data.mjs:575-597). It cleans a copy unless clean.copy is false, and it leaves out the migrate and
 * model steps of the update's own cleaning unless asked for them.
 * @param {{validate: (options: object) => boolean}} document
 * @param {Record<string, unknown>} given
 * @returns {Record<string, unknown>}
 * @throws the error of Foundry's data model, for changes it refuses
 */
export function cleanedChanges(document, given) {
  const wanted = structuredClone(given);
  document.validate({ changes: wanted, clean: { ...AS_AN_UPDATE, copy: false } });
  return wanted;
}

/**
 * The same dry run for an update that holds deletion operators. Foundry copies the update itself here, which keeps
 * them; structuredClone would turn each into an empty object.
 * @param {{validate: (options: object) => boolean}} document
 * @param {Record<string, unknown>} update
 * @throws the error of Foundry's data model, for an update it refuses
 */
export function checkUpdate(document, update) {
  document.validate({ changes: update, clean: AS_AN_UPDATE });
}

/**
 * The part of stored data that the document's model would store again, in the stored values. dnd5e deletes a legacy
 * key on every cleaning, and its vehicle model puts one back as a default (`system.attributes.ac.calc`, dnd5e
 * module/data/actor/templates/attributes.mjs:185-212, module/data/actor/vehicle.mjs:42-45): such a key is stored, and
 * refused when it is given back. Without strict the dry run cleans the copy and does not throw for stored data the
 * model would refuse. The copy is Foundry's own: measured, structuredClone refuses the stored data of some items (a
 * spell copied from a compendium) with a DataCloneError.
 * @param {{validate: (options: object) => boolean}} document
 * @param {Record<string, unknown>} stored the document's `_source`, or a part of it
 * @returns {Record<string, unknown>}
 */
export function storedAgain(document, stored) {
  const cleaned = foundry.utils.deepClone(stored);
  document.validate({ changes: cleaned, clean: { ...AS_AN_UPDATE, copy: false }, strict: false });
  return /** @type {Record<string, unknown>} */ (pickData(stored, cleaned));
}

/**
 * Stored data of a document that a write tool takes back as it is: without a key the model would not store again, and
 * without a key outside a map's fixed keys, which dnd5e stores and then ignores (one pack actor has
 * system.skills.value).
 * @param {{documentName: string, type?: string, validate: (options: object) => boolean}} document
 * @param {Record<string, unknown>} stored the document's `_source`, or a part of it
 * @returns {Record<string, unknown>}
 */
export function takenBack(document, stored) {
  const data = storedAgain(document, stored);
  const schema = CONFIG[document.documentName].documentClass.schema;
  const walk = { type: document.type, schemaFor: TYPED_ENTRY_SCHEMAS };
  for (const { path, problem } of fieldProblems(schema, data, walk)) {
    if (problem === "key") dropAt(data, path);
  }
  return data;
}

/**
 * The content of an HTML text in a form that does not depend on how it is spelled. A template's content is parsed in
 * a document of its own, which runs no script and loads no image.
 * @param {string} html
 * @returns {string}
 */
export function canonicalHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const probe = document.createElement("span");
  const parse = (declaration) => {
    probe.style.cssText = declaration;
    return probe.style.cssText;
  };
  return JSON.stringify(canonicalNodes(template.content.childNodes, (style) => canonicalStyle(style, parse)));
}

/**
 * @param {Iterable<{id: string, name: string, folder?: {id: string} | null}>} folders folder documents
 * @returns {import("./folders.mjs").FolderRecord[]}
 */
export const foldersAsRecords = (folders) =>
  Array.from(folders, (folder) => ({ id: folder.id, name: folder.name, parentId: folder.folder?.id ?? null }));

/** The world's folders of one document type. A compendium pack has folders of its own. */
export function folderRecords(type) {
  return foldersAsRecords(game.folders.filter((folder) => folder.type === type));
}

/**
 * @param {string} type the document type of the folders, such as "Scene"
 * @param {readonly string[]} path folder names from the root
 * @returns {{id: string | null, missing: string[]}} the deepest folder on the path that exists, null for the root, and
 *   the names below it that do not exist yet
 */
export function findFolder(type, path) {
  const maxDepth = CONST.FOLDER_MAX_DEPTH;
  if (path.length > maxDepth) {
    throw new MethodError(
      "invalid_params",
      `Foundry allows folders at most ${maxDepth} levels deep, the path has ${path.length}.`
    );
  }
  const { chain, missing, ambiguous } = resolveFolderPath(folderRecords(type), path);
  if (ambiguous) {
    throw new MethodError(
      "invalid_params",
      `Two ${type.toLowerCase()} folders share the path ${JSON.stringify(ambiguous)}. Rename one.`
    );
  }
  return { id: chain.at(-1)?.id ?? null, missing };
}

/**
 * @param {string} type
 * @param {{id: string | null, missing: string[]}} place as findFolder returns it
 * @returns {Promise<string | null>} the id of the folder the path ends in
 */
export async function createMissingFolders(type, { id, missing }) {
  let parent = id;
  for (const name of missing) {
    const created = await foundry.documents.Folder.create({ name, type, folder: parent });
    parent = created.id;
  }
  return parent;
}
