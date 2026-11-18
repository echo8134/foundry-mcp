import assert from "node:assert/strict";
import { Collection, type EmbeddedWrite, fakeActors } from "./fake-actors.ts";
import { DOCUMENT_PLACES, type DocumentWrite, fakeDocuments } from "./fake-documents.ts";
import { fakeDocument } from "./fake-dom.ts";
import { applyChanges, cleanValue, cloneChanges, ForcedDeletion, merge, validationErrors } from "./fake-model.ts";
import { sceneSchema, systemConfig } from "./fake-system.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Foundry's Number#toNearest (common/primitives/number.mjs:73) as NumberField#clean applies it for a field with a step (common/data/fields.mjs:1529). */
function toNearest(value: number, interval: number) {
  return Number((Math.round(value / interval) * interval).toFixed(String(interval).length - 2));
}

/**
 * What Foundry keeps of an update: StringFields trim (common/data/fields.mjs:1764), the scene's padding is a
 * NumberField with step 0.05 (common/documents/scene.mjs:78), and Scene#_preUpdate drops a darkness change while the
 * darkness lock is on unless the same update sets the lock (client/documents/scene.mjs:1097).
 */
function stored(changes: Record<string, any>, current?: Record<string, any>) {
  const out = structuredClone(changes);
  for (const key of ["name", "navName", "weather"]) if (typeof out[key] === "string") out[key] = out[key].trim();
  if (typeof out.grid?.units === "string") out.grid.units = out.grid.units.trim();
  if (typeof out.padding === "number") out.padding = toNearest(out.padding, 0.05);
  if (
    current &&
    out.environment?.darknessLevel !== undefined &&
    current.environment.darknessLock &&
    out.environment.darknessLock === undefined
  ) {
    delete out.environment.darknessLevel;
  }
  return out;
}

/**
 * The scene origin and size of SquareGrid#calculateDimensions (common/grid/square.mjs:1349), where padding is rounded up
 * to whole cells, and a shift moves the map against the grid: sceneX = dimensions.x - shiftX (client/documents/scene.mjs:498).
 */
function dimensionsOf(source: Record<string, any>) {
  const { size } = source.grid;
  const x = Math.ceil(source.padding * source.width * (1 / size)) * size;
  const y = Math.ceil(source.padding * source.height * (1 / size)) * size;
  return {
    sceneX: x - (source.shiftX ?? 0),
    sceneY: y - (source.shiftY ?? 0),
    sceneWidth: source.width,
    sceneHeight: source.height,
    width: source.width + 2 * x,
    height: source.height + 2 * y
  };
}

/** An integer NumberField cleans by rounding (common/data/fields.mjs:1528) and then must be an integer (:1555), which only a non-finite number fails. */
const cleanInteger = (value: number) => {
  const rounded = Math.round(value);
  if (!Number.isInteger(rounded)) throw new Error("must be an integer");
  return rounded;
};

const USER_ID = "user1";

const DOCUMENT_TYPES = Object.freeze({
  Actor: ["base", "character", "npc", "vehicle", "group"],
  Item: ["base", "weapon", "feat", "spell", "class"],
  ActiveEffect: ["base", "enchantment"]
});

type WorldOptions = {
  weather?: string[];
  unloadable?: string[];
  thumbnailFails?: boolean;
  latency?: number;
  extraLevels?: string[];
};

export function fakeWorld(options: WorldOptions = {}) {
  const folders = new Collection<any>();
  const scenes = new Collection<any>();
  const log = {
    sceneCreates: 0,
    sceneUpdates: 0,
    updateOptions: [] as any[],
    levelUpdates: 0,
    folderCreates: 0,
    thumbnails: 0,
    notifications: [] as string[],
    wallCreates: 0,
    wallDeletes: 0,
    lightCreates: 0,
    lightDeletes: 0,
    tokenCreates: 0,
    tokenUpdates: [] as any[][],
    tokenMoves: [] as { instructions: Record<string, any>; options: any }[],
    tokenDeletes: 0,
    actorCreates: [] as Record<string, any>[],
    actorUpdates: [] as { id: string; changes: Record<string, any> }[],
    actorDeletes: [] as string[][],
    /** Every create, update and deletion of items and effects, on an actor or on an item. */
    embedded: [] as EmbeddedWrite[],
    /** Every create, update and deletion the generic document classes saw. */
    documentWrites: [] as DocumentWrite[],
    packIndexes: [] as { pack: string; fields: string[] }[],
    packLoads: [] as string[]
  };
  const control = {
    thumbnailFails: options.thumbnailFails ?? false,
    wallCreateFails: false,
    wallDeleteFails: false,
    lightCreateFails: false,
    lightDeleteFails: false,
    textureGate: null as Promise<void> | null,
    thumbnailGate: null as Promise<void> | null,
    vetoWall: null as null | ((data: Record<string, any>) => boolean),
    vetoLight: null as null | ((data: Record<string, any>) => boolean),
    vetoToken: null as null | ((data: Record<string, any>) => boolean),
    /** Stands in for a preUpdateToken hook that changes or drops part of an update without an error. */
    filterTokenChanges: null as null | ((changes: Record<string, any>) => void),
    /** Stands in for a preCreateToken hook that changes the data of a token before it is stored. */
    filterTokenData: null as null | ((data: Record<string, any>) => void),
    /** The message of an error the create throws for a token, the way a failing hook or a lost connection ends it. */
    tokenCreateError: null as null | ((data: Record<string, any>) => string | undefined),
    tokenMoveError: null as string | null,
    tokenUpdateError: null as string | null,
    /** Stands in for a preCreateActor hook that refuses the actor. */
    vetoActor: null as null | ((data: Record<string, any>) => boolean),
    /** Stands in for a hook or a system rule that changes the data of an actor before it is stored. */
    filterActorData: null as null | ((source: Record<string, any>) => void),
    /** Stands in for a preUpdateActor hook that changes or drops part of an update without an error. */
    filterActorChanges: null as null | ((changes: Record<string, any>) => void),
    actorCreateError: null as string | null,
    /** The message of an error the update throws once it has stored its changes, as a failing hook after the write does. */
    actorUpdateError: null as string | null,
    /** Stands in for a preDeleteToken hook that refuses the deletion of a token. */
    vetoTokenDelete: null as null | ((token: any) => boolean),
    /** Stands in for a preDeleteActor hook that refuses the deletion of an actor. */
    vetoActorDelete: null as null | ((actor: any) => boolean),
    /** Stands in for a preCreate hook that refuses an item or an effect. */
    vetoEmbedded: null as null | ((document: string, data: Record<string, any>) => boolean),
    /** Stands in for a hook or a system rule that changes the data of an item or effect before it is stored. */
    filterEmbeddedData: null as null | ((document: string, source: Record<string, any>) => void),
    /** Stands in for a preUpdate hook that changes or drops part of an update of an item or effect. */
    filterEmbeddedChanges: null as null | ((document: string, changes: Record<string, any>) => void),
    /** The message of an error a write of items or effects throws once it has stored what it was given. */
    embeddedError: null as null | ((action: string, document: string) => string | undefined),
    /** Stands in for a preCreate hook that refuses a document of the generic classes. */
    vetoDocument: null as null | ((document: string, data: Record<string, any>) => boolean),
    /** Stands in for a hook or a system rule that changes the data of a new document before it is stored. */
    filterDocumentData: null as null | ((document: string, source: Record<string, any>) => void),
    /** Stands in for a preUpdate hook that refuses the update of a document. */
    vetoDocumentUpdate: null as null | ((document: string, changes: Record<string, any>) => boolean),
    /** Stands in for a preUpdate hook that changes or drops part of an update. */
    filterDocumentChanges: null as null | ((document: string, changes: Record<string, any>) => void),
    /** Stands in for a preDelete hook that refuses the deletion of a document. */
    vetoDocumentDelete: null as null | ((document: any) => boolean),
    /**
     * The message of an error a write of the generic classes throws: a create before anything is stored, an update
     * and a deletion once they have stored what they were given.
     */
    documentError: null as null | ((action: string, document: string, data?: Record<string, any>) => string | undefined)
  };
  const delay = () => pause(options.latency ?? 0);
  const system = systemConfig();
  const tokenFields = system.Token.documentClass.schema;
  const sceneFields = sceneSchema();
  let counter = 0;

  /** The wall's c is an array of integer NumberFields (common/documents/wall.mjs:54), and levels defaults to [] (SceneLevelsSetField). */
  function makeWall(data: Record<string, any>) {
    return { id: `wall${++counter}`, levels: [], flags: {}, ...data, c: data.c.map(cleanInteger) };
  }

  /**
   * What Foundry keeps of an ambient light. Fields default to LightData and BaseAmbientLight (common/data/data.mjs:42,
   * common/documents/ambient-light.mjs:34). Creating cleans and validates: the name is trimmed, the radii are rounded to
   * their 0.01 step (NumberField#clean, fields.mjs:1529), the rotation is normalised to 0..360 (AngleField, fields.mjs:3812)
   * and the colour is stored as lowercase #rrggbb (ColorField#_cast, fields.mjs:3680). A bad value throws here, and the
   * create skips that one document (client/data/client-backend.mjs:81-112). `_source` holds x and y as stored; the
   * document's own x and y are clamped to the canvas, as AmbientLightDocument#prepareDerivedData does
   * (client/documents/ambient-light.mjs:42-46).
   */
  function makeLight(data: Record<string, any>, parent: any) {
    const light = merge(
      {
        name: "",
        x: 0,
        y: 0,
        elevation: 0,
        levels: [],
        rotation: 0,
        walls: true,
        vision: false,
        hidden: false,
        locked: false,
        flags: {},
        config: {
          negative: false,
          priority: 0,
          alpha: 0.5,
          angle: 360,
          bright: 0,
          color: null,
          coloration: 1,
          dim: 0,
          attenuation: 0.5,
          luminosity: 0.5,
          saturation: 0,
          contrast: 0,
          shadows: 0,
          animation: { type: null, speed: 5, intensity: 5, reverse: false },
          darkness: { min: 0, max: 1 }
        }
      },
      structuredClone(data)
    );
    if (typeof light.name === "string") light.name = light.name.trim();
    for (const key of ["bright", "dim"]) light.config[key] = toNearest(light.config[key], 0.01);
    light.rotation = ((light.rotation % 360) + 360) % 360;
    if (typeof light.config.color === "string") {
      if (!/^#[0-9A-Fa-f]{6}$/.test(light.config.color))
        throw new Error("AmbientLight validation failed: must be a valid color string");
      light.config.color = light.config.color.toLowerCase();
    }
    const { animation, darkness } = light.config;
    if (animation.type === "" || !Number.isInteger(animation.speed) || animation.speed < 0 || animation.speed > 10)
      throw new Error("AmbientLight validation failed: animation");
    if (!Number.isInteger(animation.intensity) || animation.intensity < 1 || animation.intensity > 10)
      throw new Error("AmbientLight validation failed: animation");
    if (darkness.min > darkness.max)
      throw new Error("AmbientLight validation failed: darkness.max may not be less than darkness.min");
    if (light.config.alpha < 0 || light.config.alpha > 1 || light.config.angle < 0 || light.config.angle > 360)
      throw new Error("AmbientLight validation failed");
    light.x = cleanInteger(light.x);
    light.y = cleanInteger(light.y);
    const { x, y, ...rest } = light;
    return {
      id: `light${++counter}`,
      ...rest,
      _source: { x, y },
      get x() {
        return Math.max(0, Math.min(x, parent.dimensions.width));
      },
      get y() {
        return Math.max(0, Math.min(y, parent.dimensions.height));
      }
    };
  }

  const globals = globalThis as Record<string, any>;
  const documents = fakeDocuments({
    folders,
    log,
    control,
    delay,
    nextNumber: () => ++counter,
    hosts: () => ({ Scene: FakeScene })
  });
  let makeTokenLater: (data: Record<string, any>, scene: any, id: string | null) => any;
  const {
    actors,
    items,
    dependentTokens,
    syntheticActor,
    resolve,
    within,
    FakeActor,
    FakeItem,
    FakeEffect,
    addActor,
    addPackActor,
    addItem,
    addPackItem
  } = fakeActors({
    system,
    folders,
    log,
    control,
    delay,
    nextNumber: () => ++counter,
    makeToken: (data, scene, id) => makeTokenLater(data, scene, id),
    viewedScene: () => globals.canvas.scene,
    userId: USER_ID,
    packDocuments: (pack, documentName) => documents.packOf(pack, documentName).documents
  });

  /** What Foundry stores of the data a token is built from, or the error its token model throws on it. */
  function tokenSource(data: Record<string, any>, scene: any) {
    // BaseToken#_initializeSource puts a token without a level on the scene's initial one (common/documents/token.mjs:231-235).
    const given = { level: scene.initialLevel.id, ...structuredClone(data) };
    const source = cleanValue(tokenFields, given, { partial: false }) as Record<string, any>;
    const errors = validationErrors(tokenFields, source);
    if (errors.length > 0) throw new Error(`Token validation errors: ${errors.join("; ")}`);
    return source;
  }

  /**
   * A token on a square or gridless scene, the only grids a test scene uses. Its stored data is `_source`, and the
   * document reads each stored field from it unless `prepared` holds another value for it, which stands in for what
   * data preparation or a running animation puts in place of the stored one. `_id` is null for a token that is not
   * stored yet.
   */
  function makeToken(data: Record<string, any>, scene: any, id: string | null) {
    const source = tokenSource({ ...data, _id: id }, scene);
    const prepared: Record<string, any> = {};
    let synthetic: any = null;
    const sizeOf = (data: Record<string, any>) => ({
      width: (data.width ?? token.width) * scene.grid.size,
      height: (data.height ?? token.height) * scene.grid.size
    });
    const token: any = {
      documentName: "Token",
      _source: source,
      parent: scene,
      prepared,
      get id() {
        return source._id;
      },
      get uuid() {
        return `${scene.uuid}.Token.${source._id}`;
      },
      get actor() {
        const base = actors.get(source.actorId);
        if (!base) return null;
        if (source.actorLink) return base;
        synthetic ??= syntheticActor(base, token);
        return synthetic;
      },
      get baseActor() {
        return actors.get(source.actorId) ?? null;
      },
      /** The token's ActorDelta, as far as its stored data. */
      get delta() {
        return { _source: source.delta };
      },
      /** TokenDocument#update: an update of this one token on its scene, which resolves to the token. */
      async update(changes: Record<string, any>) {
        const [updated] = await scene.updateEmbeddedDocuments("Token", [{ _id: source._id, ...changes }]);
        return updated;
      },
      toObject: () => structuredClone(source),
      getSize: (data: Record<string, any> = {}) => sizeOf(data),
      getCenterPoint: (data: Record<string, any> = {}) => {
        const { width, height } = sizeOf(data);
        return {
          x: (data.x ?? token.x) + width / 2,
          y: (data.y ?? token.y) + height / 2,
          elevation: data.elevation ?? token.elevation
        };
      },
      /**
       * BaseToken#getSnappedPosition (common/documents/token.mjs:286): on a gridless scene the position as given; on a
       * square grid the corner of a token whole cells wide and high goes to the nearest grid vertex, and the elevation
       * is rounded to the grid distance.
       */
      getSnappedPosition: (data: Record<string, any> = {}) => {
        const { grid } = scene;
        const x = data.x ?? token.x;
        const y = data.y ?? token.y;
        const elevation = data.elevation ?? token.elevation;
        if (grid.isGridless) return { x, y, elevation };
        const whole = [data.width ?? token.width, data.height ?? token.height].every(Number.isInteger);
        assert.ok(whole, "the fake snaps only tokens whole cells wide and high");
        const toGrid = (value: number, step: number) => Math.round(value / step) * step;
        return { x: toGrid(x, grid.size), y: toGrid(y, grid.size), elevation: toGrid(elevation, grid.distance) };
      },
      /**
       * DataModel#validate with changes is a dry run of the update (common/abstract/data.mjs:575): it cleans the
       * changes, the given object itself when clean.copy is false, and throws what the update would refuse.
       */
      validate: ({ changes, clean }: { changes: Record<string, any>; clean?: { copy?: boolean } }) => {
        const target = clean?.copy === false ? changes : structuredClone(changes);
        const cleaned = cleanValue(tokenFields, target, { partial: true, source }) as Record<string, any>;
        const errors = validationErrors(tokenFields, applyChanges(structuredClone(source), cleaned));
        if (errors.length > 0) throw new Error(`Token validation errors: ${errors.join("; ")}`);
        return true;
      }
    };
    for (const key of Object.keys(source)) {
      if (!(key in token)) {
        Object.defineProperty(token, key, { get: () => prepared[key] ?? source[key], enumerable: true });
      }
    }
    if (source.actorId) {
      if (!dependentTokens.has(source.actorId)) dependentTokens.set(source.actorId, new Set());
      dependentTokens.get(source.actorId)!.add(token);
    }
    return token;
  }

  makeTokenLater = makeToken;

  /**
   * One token of an update: the changes are cleaned, pass the stand-in hook, and are merged into the stored data. Foundry
   * skips a token whose data then fails validation and goes on with the rest (client/data/client-backend.mjs:246-259).
   */
  function changeToken(token: any, changes: Record<string, any>) {
    const source = token._source;
    const cleaned = cleanValue(tokenFields, cloneChanges(changes), { partial: true, source }) as Record<string, any>;
    control.filterTokenChanges?.(cleaned);
    const next = applyChanges(structuredClone(source), cleaned);
    const errors = validationErrors(tokenFields, next);
    if (errors.length > 0) {
      log.notifications.push(`Token update skipped: ${errors.join("; ")}`);
      return;
    }
    for (const key of Object.keys(source)) delete source[key];
    Object.assign(source, next);
  }

  /** Whether the point lies on the wall's segment. */
  function onWall({ x, y }: { x: number; y: number }, [x1, y1, x2, y2]: number[]) {
    const cross = (x - x1!) * (y2! - y1!) - (y - y1!) * (x2! - x1!);
    const within =
      Math.min(x1!, x2!) <= x && x <= Math.max(x1!, x2!) && Math.min(y1!, y2!) <= y && y <= Math.max(y1!, y2!);
    return cross === 0 && within;
  }

  function makeScene(data: Record<string, any>) {
    const source = merge(
      {
        name: "",
        folder: null,
        navigation: true,
        active: true,
        thumb: null,
        width: 4000,
        height: 3000,
        // Foundry's initial is 0.25 (common/documents/scene.mjs:78). A test scene has none unless it asks, so canvas pixels equal scene pixels.
        padding: 0,
        shiftX: 0,
        shiftY: 0,
        tokenVision: true,
        weather: "",
        grid: { type: 1, size: 100, distance: 5, units: "ft" },
        fog: { mode: 1 },
        flags: {},
        environment: { darknessLevel: 0, globalLight: { enabled: false } },
        regions: []
      },
      stored(data)
    );
    const level = {
      id: "lvl1",
      name: "Level",
      // LevelDocument#prepareBaseData (client/documents/level.mjs:62-66).
      elevation: { base: 0 },
      _source: { background: { src: null } },
      get background() {
        return { ...this._source.background, color: "#999999" };
      }
    };
    const walls = new Collection<any>();
    const lights = new Collection<any>();
    const tokens = new Collection<any>();
    const levels = new Collection<any>([["lvl1", level]]);
    for (const id of options.extraLevels ?? [])
      levels.set(id, { id, name: id, elevation: { base: 0 }, _source: { background: { src: null } } });
    /**
     * As walls and lights: a token that fails validation or that a preCreate hook vetoes is skipped
     * (client/data/client-backend.mjs:81-112). A token created without a sort goes one above the highest on the scene
     * (client/documents/abstract/canvas-document.mjs:122-128).
     */
    const createTokens = async (data: Record<string, any>[]) => {
      await delay();
      const made = [];
      for (const { _id, ...one } of data) {
        const failure = control.tokenCreateError?.(one);
        if (failure) throw new Error(failure);
        control.filterTokenData?.(one);
        let token: any;
        try {
          const sort = "sort" in one ? one.sort : Math.max(0, ...tokens.map((placed: any) => placed.sort + 1));
          token = makeToken({ ...one, sort }, scene, `token${++counter}`);
        } catch (error) {
          log.notifications.push(`Token skipped: ${(error as Error).message}`);
          continue;
        }
        if (control.vetoToken?.(one)) {
          log.notifications.push("Token creation prevented");
          continue;
        }
        made.push(token);
      }
      if (made.length > 0) log.tokenCreates++;
      for (const token of made) tokens.set(token.id, token);
      return made;
    };
    const id = `scene${++counter}`;
    const scene: any = {
      id,
      uuid: `Scene.${id}`,
      documentName: "Scene",
      parent: null,
      pack: null,
      _source: source,
      initialLevel: level,
      levels,
      walls,
      lights,
      tokens,
      /** The regions are documents of the generic classes, stored as records in the scene's own data. */
      get regions() {
        return documents.childrenOf(scene, "Region", source.regions);
      },
      getEmbeddedCollection(name: string) {
        if (name === "Region") return scene.regions;
        const held: Record<string, Collection<any>> = {
          AmbientLight: lights,
          Level: levels,
          Token: tokens,
          Wall: walls
        };
        if (!held[name]) throw new Error(`${name} is not a valid embedded Document within the Scene Document`);
        return held[name];
      },
      toObject: () => structuredClone(source),
      /**
       * validate with changes is a dry run of an update (common/abstract/data.mjs:575-597): it cleans the changes, the
       * given object itself when clean.copy is false, and throws what the update would refuse unless it is not strict.
       */
      validate({ changes, clean, strict = true }: { changes: any; clean?: { copy?: boolean }; strict?: boolean }) {
        const target = clean?.copy === false ? changes : cloneChanges(changes);
        const cleaned = cleanValue(sceneFields, target, { partial: true, source }) as Record<string, any>;
        const errors = validationErrors(sceneFields, applyChanges(structuredClone(source), cleaned));
        if (errors.length > 0 && strict) throw new Error(`Scene validation errors: ${errors.join("; ")}`);
        return errors.length === 0;
      },
      get dimensions() {
        return dimensionsOf(source);
      },
      clone: (changes: Record<string, any>) => new FakeScene(merge(structuredClone(source), stored(changes))),
      get name() {
        return source.name;
      },
      get navName() {
        return source.navName;
      },
      get active() {
        return source.active;
      },
      get width() {
        return source.width;
      },
      get height() {
        return source.height;
      },
      get shiftX() {
        return source.shiftX;
      },
      get shiftY() {
        return source.shiftY;
      },
      get thumb() {
        return source.thumb;
      },
      get flags() {
        return source.flags;
      },
      get folder() {
        return source.folder ? folders.get(source.folder) : null;
      },
      get grid() {
        return { ...source.grid, isGridless: source.grid.type === 0, isSquare: source.grid.type === 1 };
      },
      async update(changes: Record<string, any>, updateOptions?: Record<string, any>) {
        await delay();
        log.sceneUpdates++;
        log.updateOptions.push(updateOptions);
        const changed = stored(changes, source);
        if (updateOptions?.autoReposition) {
          const next = merge(structuredClone(source), changed);
          const before = dimensionsOf(source);
          const scaleX = next.width / source.width;
          const scaleY = next.height / source.height;
          let dropped = false;
          // Scene#_preUpdate and #repositionObjects, client/documents/scene.mjs:1109-1119 and 1137-1161: an update without
          // grid.size gets the stored one scaled by the average of the two scale factors, and one below 20 px is dropped.
          if (source.grid.type !== 0 && changed.grid?.size === undefined) {
            const gridSize = Math.round(source.grid.size * ((scaleX + scaleY) / 2));
            if (gridSize < 20) {
              for (const key of ["width", "height", "padding"]) delete changed[key];
              log.notifications.push("SCENE.GridSizeError");
              dropped = true;
            } else {
              changed.grid = { ...changed.grid, size: gridSize };
              next.grid.size = gridSize;
            }
          }
          if (!dropped) {
            // Walls and lights move by the new origin and scale, lights from their clamped derived position (scene.mjs:1170-1176, 1213-1218).
            const after = dimensionsOf(next);
            const offsetX = after.sceneX - scaleX * before.sceneX;
            const offsetY = after.sceneY - scaleY * before.sceneY;
            for (const wall of walls.values()) {
              const [x1, y1, x2, y2] = wall.c;
              wall.c = [x1 * scaleX + offsetX, y1 * scaleY + offsetY, x2 * scaleX + offsetX, y2 * scaleY + offsetY].map(
                cleanInteger
              );
            }
            for (const light of lights.values()) {
              light._source.x = cleanInteger(light.x * scaleX + offsetX);
              light._source.y = cleanInteger(light.y * scaleY + offsetY);
            }
          }
        }
        merge(source, changed);
        return scene;
      },
      async updateEmbeddedDocuments(name: string, updates: any[]) {
        assert.ok(name === "Level" || name === "Token", name);
        await delay();
        if (name === "Token") {
          log.tokenUpdates.push(cloneChanges(updates));
          if (control.tokenUpdateError) throw new Error(control.tokenUpdateError);
          for (const { _id, ...changes } of updates) changeToken(tokens.get(_id), changes);
          return updates.map(({ _id }) => tokens.get(_id));
        }
        log.levelUpdates++;
        for (const { _id, ...changes } of updates) merge(level._source, changes);
      },
      /**
       * Scene#moveTokens (client/documents/scene.mjs:676) with a destination: the movement fields and the other data in
       * one update. Measured on Foundry 14.370: a movement field of the wrong type throws before any token is written,
       * and on the viewed scene a token whose centre would end on a wall stops one pixel short of it, with the result
       * false, unless constrainOptions.ignoreWalls is set, and a token whose centre would be on the far edge of the
       * canvas does not move. Read from the source: a level the scene lacks throws like a wrong type
       * (client/documents/token.mjs:2272, :2307), and a token that does not move still gets its other data (:1819-1826).
       */
      async moveTokens(instructions: Record<string, any>, moveOptions: any) {
        await delay();
        log.tokenMoves.push({ instructions: structuredClone(instructions), options: moveOptions });
        if (control.tokenMoveError) throw new Error(control.tokenMoveError);
        const movementFields: readonly string[] = system.Token.documentClass.MOVEMENT_FIELDS;
        const moves = Object.entries(instructions).map(([id, { destination, constrainOptions }]) => {
          const token = tokens.get(id);
          const { action: _action, ...changes } = destination;
          for (const key of ["x", "y", "elevation", "width", "height", "depth"]) {
            if (changes[key] !== undefined && typeof changes[key] !== "number")
              throw new Error(`${key} must be a number`);
          }
          if (changes.shape !== undefined && !tokenFields.fields.shape.choices.includes(changes.shape))
            throw new Error("shape is invalid");
          if (!levels.has(changes.level ?? token._source.level)) throw new Error("level must exist");
          return { token, changes, ignoreWalls: constrainOptions?.ignoreWalls === true };
        });
        const viewed = globals.canvas.scene === scene;
        const results: Record<string, boolean> = {};
        for (const { token, changes, ignoreWalls } of moves) {
          results[token.id] = true;
          if (viewed) {
            const from = token._source;
            const centre = token.getCenterPoint({ ...from, ...changes });
            const { width, height } = scene.dimensions;
            if (centre.x < 0 || centre.x >= width || centre.y < 0 || centre.y >= height) {
              for (const key of movementFields) delete changes[key];
              results[token.id] = false;
            } else if (!ignoreWalls && walls.filter((wall: any) => onWall(centre, wall.c)).length > 0) {
              changes.x = (changes.x ?? from.x) - Math.sign((changes.x ?? from.x) - from.x);
              results[token.id] = false;
            }
          }
          changeToken(token, changes);
        }
        return results;
      },
      async createEmbeddedDocuments(name: string, data: any[]) {
        if (name === "Token") return createTokens(data);
        assert.ok(name === "Wall" || name === "AmbientLight", name);
        await delay();
        // client/data/client-backend.mjs:81-112: a document that fails validation or that a preCreate hook vetoes is
        // skipped and the rest are created; only a server error throws (a *CreateFails switch).
        const isLight = name === "AmbientLight";
        if (isLight ? control.lightCreateFails : control.wallCreateFails)
          throw new Error(isLight ? "AmbientLight validation failed" : "Wall validation failed");
        const veto = isLight ? control.vetoLight : control.vetoWall;
        const made: any[] = [];
        for (const one of data) {
          let document: any;
          try {
            document = isLight ? makeLight(one, scene) : makeWall(one);
          } catch (error) {
            log.notifications.push(`${name} skipped: ${(error as Error).message}`);
            continue;
          }
          if (veto?.(one)) {
            log.notifications.push(`${name} creation prevented`);
            continue;
          }
          made.push(document);
        }
        if (made.length === 0) return [];
        if (isLight) log.lightCreates++;
        else log.wallCreates++;
        for (const document of made) (isLight ? lights : walls).set(document.id, document);
        return made;
      },
      async deleteEmbeddedDocuments(name: string, ids: string[]) {
        await delay();
        if (name === "Token") {
          for (const id of ids) if (!tokens.has(id)) throw new Error(`Token ${id} does not exist`);
          log.tokenDeletes++;
          // Foundry skips a token whose deletion a hook refuses (client/data/client-backend.mjs:404-409).
          const deleted = ids.map((id) => tokens.get(id)).filter((token) => !control.vetoTokenDelete?.(token));
          // A deleted token is no longer one of its actor's (client/documents/token.mjs:3150).
          for (const token of deleted) dependentTokens.get(token.actorId)?.delete(token);
          return deleted.filter((token) => tokens.delete(token.id));
        }
        assert.ok(name === "Wall" || name === "AmbientLight", name);
        const isLight = name === "AmbientLight";
        const collection = isLight ? lights : walls;
        if (isLight ? control.lightDeleteFails : control.wallDeleteFails) throw new Error("connection lost");
        // client/data/client-backend.mjs:403 looks every id up with strict: true before anything is deleted, so an unknown id throws and deletes nothing.
        for (const id of ids) if (!collection.has(id)) throw new Error(`${name} ${id} does not exist`);
        if (isLight) log.lightDeletes++;
        else log.wallDeletes++;
        return ids.map((id) => collection.get(id)!).filter((document) => collection.delete(document.id));
      },
      async createThumbnail() {
        await control.thumbnailGate;
        if (control.thumbnailFails) throw new Error("no upload permission");
        log.thumbnails++;
        return { thumb: `thumb-of:${level._source.background.src}:${source.width}x${source.height}` };
      }
    };
    scenes.set(scene.id, scene);
    return scene;
  }

  /**
   * Foundry's Scene constructor does not throw on bad data: its data preparation catches the error and leaves `dimensions`
   * undefined (client/documents/abstract/client-document.mjs:276), and an unknown grid type throws in it
   * (client/documents/scene.mjs:443), so a type that is not a number does that here.
   */
  class FakeScene {
    static documentName = "Scene";
    static schema = sceneFields;
    /** The documents a scene embeds, as far as the fake has them (common/documents/scene.mjs:32-42). */
    static metadata = {
      embedded: { AmbientLight: "lights", Level: "levels", Region: "regions", Token: "tokens", Wall: "walls" }
    };
    /** Document.hierarchy: the fields that hold embedded documents (common/abstract/document.mjs:259-266). */
    static hierarchy = Object.fromEntries(
      Object.values(FakeScene.metadata.embedded).map((field) => [field, sceneFields.fields[field]])
    );
    readonly dimensions: ReturnType<typeof dimensionsOf> | undefined;
    readonly shiftX: number | null;
    readonly shiftY: number | null;
    // A Scene built by hand takes Foundry's defaults (common/documents/scene.mjs:78), unlike makeScene's test default of no padding.
    constructor(data: any) {
      const source = merge(
        { width: 4000, height: 3000, padding: 0.25, shiftX: 0, shiftY: 0, grid: { type: 1, size: 100 } },
        stored(data)
      );
      this.shiftX = source.shiftX;
      this.shiftY = source.shiftY;
      this.dimensions = Number.isInteger(source.grid.type) ? dimensionsOf(source) : undefined;
    }
    static async create(data: any) {
      await delay();
      log.sceneCreates++;
      return makeScene(data);
    }
  }

  /**
   * The UUID forms the tools take, resolved as foundry.utils.fromUuid does for them (client/utils/helpers.mjs:172): null
   * when nothing is there. A UUID of the form "Broken.<reason>" throws, as Foundry's parsing can on input it does not expect.
   */
  async function fromUuid(uuid: string) {
    const parts = uuid.split(".");
    if (parts[0] === "Broken") throw new TypeError(parts[1]);
    if (parts[0] === "Scene") {
      const scene = scenes.get(parts[1]!);
      if (parts[4] !== "Actor") return scene ? documents.within(scene, parts.slice(2)) : null;
      const token = scene?.tokens.get(parts[3]);
      return token?.actor?.id === parts[5] ? within(token.actor, parts.slice(6)) : null;
    }
    return resolve(parts) ?? (await documents.resolve(parts)) ?? null;
  }

  /** Built with a parent scene, as Foundry's own token class is: an unsaved token, or the error its model throws. */
  class FakeToken {
    static documentName = "Token";
    static schema = tokenFields;
    /** A token embeds its own actor data (common/documents/token.mjs:40-42). */
    static metadata = { embedded: { ActorDelta: "delta" } };
    /**
     * Document.hierarchy, whose one field names the class of the token's own actor data (common/documents/token.mjs:64).
     * The fake stores that data as it comes, so the field here only names the class.
     */
    static hierarchy = { delta: { model: documents.classes.ActorDelta } };
    static MOVEMENT_FIELDS = system.Token.documentClass.MOVEMENT_FIELDS;
    /** Document.deleteDocuments with a parent scene (common/abstract/document.mjs:696-701). */
    static deleteDocuments(ids: string[], { parent }: { parent: any }) {
      return parent.deleteEmbeddedDocuments("Token", ids);
    }
    constructor(data: Record<string, any>, context: { parent: any }) {
      // biome-ignore lint/correctness/noConstructorReturn: the fake token is a plain object that makeToken builds.
      return makeToken(data, context.parent, null);
    }
  }

  const install = () => {
    globals.game = {
      scenes,
      folders,
      actors,
      items,
      documentTypes: { ...documents.documentTypes, ...DOCUMENT_TYPES },
      user: { id: USER_ID },
      packs: documents.packs,
      // The world's collections by document name (client/game.mjs:905-929).
      collections: new Map<string, Collection<any>>([
        ...documents.worlds,
        ["Actor", actors],
        ["Item", items],
        ["Scene", scenes]
      ])
    };
    globals.canvas = { scene: null };
    globals.CONST = { FOLDER_MAX_DEPTH: 4, ...DOCUMENT_PLACES };
    globals._del = new ForcedDeletion();
    globals.document = fakeDocument;
    globals.CONFIG = {
      ...Object.fromEntries(
        Object.entries(documents.classes).map(([name, documentClass]) => [
          name,
          { documentClass, dataModels: documents.dataModels[name] }
        ])
      ),
      Scene: { documentClass: FakeScene },
      ...system,
      Actor: { ...system.Actor, documentClass: FakeActor },
      Item: { ...system.Item, documentClass: FakeItem },
      ActiveEffect: { ...system.ActiveEffect, documentClass: FakeEffect },
      Token: { documentClass: FakeToken },
      weatherEffects: Object.fromEntries((options.weather ?? ["rain", "fog"]).map((key) => [key, {}])),
      Canvas: {
        lightAnimations: Object.fromEntries(["flame", "torch", "pulse"].map((key) => [key, {}])),
        darknessAnimations: Object.fromEntries(["magicalGloom", "roiling"].map((key) => [key, {}]))
      }
    };
    globals.foundry = {
      utils: {
        fromUuid,
        mergeObject: merge,
        // Stands in for randomID (common/utils/helpers.mjs:1259): a valid document id, another one on each call.
        randomID: () => `random${String(++counter).padStart(10, "0")}`,
        // Stands in for deepClone (common/utils/helpers.mjs:253), which copies what structuredClone refuses.
        deepClone: (value: unknown) => JSON.parse(JSON.stringify(value))
      },
      canvas: {
        // An empty source loads nothing and resolves null, like a failed load (client/canvas/loader.mjs:758-776).
        loadTexture: async (src: string) => {
          await control.textureGate;
          await delay();
          return !src || (options.unloadable ?? []).includes(src) ? null : {};
        }
      },
      documents: {
        Folder: {
          async create(data: any) {
            await delay();
            log.folderCreates++;
            return documents.makeFolder({ name: data.name, type: data.type, folder: data.folder ?? null });
          }
        },
        Scene: FakeScene
      }
    };
  };

  const addFolder = (name: string, parent: any = null, type = "Scene") =>
    documents.makeFolder({ name, type, folder: parent?.id ?? null });
  const addScene = (data: Record<string, any>) => makeScene(data);
  const addWall = (scene: any, data: Record<string, any> = {}) => {
    const wall = makeWall({ c: [0, 0, 1, 1], ...data });
    scene.walls.set(wall.id, wall);
    return wall;
  };
  const addToken = (scene: any, data: Record<string, any> = {}) => {
    const token = makeToken(data, scene, `token${++counter}`);
    scene.tokens.set(token.id, token);
    return token;
  };
  const addLight = (scene: any, data: Record<string, any> = {}) => {
    const light = makeLight({ x: 100, y: 100, config: { dim: 10 }, ...data }, scene);
    scene.lights.set(light.id, light);
    return light;
  };
  return {
    install,
    addFolder,
    addScene,
    addWall,
    addLight,
    addActor,
    addPackActor,
    addItem,
    addPackItem,
    addToken,
    addDocument: documents.addDocument,
    addPack: documents.addPack,
    addPackFolder: documents.addPackFolder,
    scenes,
    folders,
    actors,
    packs: documents.packs,
    log,
    control
  };
}
