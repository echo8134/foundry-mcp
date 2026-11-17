import assert from "node:assert/strict";

export class Collection<T> extends Map<string, T> {
  filter(fn: (value: T) => boolean) {
    return [...this.values()].filter(fn);
  }
  map<R>(fn: (value: T) => R) {
    return [...this.values()].map(fn);
  }
}

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function merge(target: Record<string, any>, changes: Record<string, any>) {
  for (const [key, value] of Object.entries(changes)) {
    if (isObject(value) && isObject(target[key])) merge(target[key], value);
    else target[key] = isObject(value) ? merge({}, value) : value;
  }
  return target;
}

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
    lightDeletes: 0
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
    vetoLight: null as null | ((data: Record<string, any>) => boolean)
  };
  const delay = () => pause(options.latency ?? 0);
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
        environment: { darknessLevel: 0, globalLight: { enabled: false } }
      },
      stored(data)
    );
    const level = {
      id: "lvl1",
      name: "Level",
      _source: { background: { src: null } },
      get background() {
        return { ...this._source.background, color: "#999999" };
      }
    };
    const walls = new Collection<any>();
    const lights = new Collection<any>();
    const levels = new Collection<any>([["lvl1", level]]);
    for (const id of options.extraLevels ?? [])
      levels.set(id, { id, name: id, _source: { background: { src: null } } });
    const scene: any = {
      id: `scene${++counter}`,
      _source: source,
      initialLevel: level,
      levels,
      walls,
      lights,
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
      },
      async updateEmbeddedDocuments(name: string, updates: any[]) {
        assert.equal(name, "Level");
        await delay();
        log.levelUpdates++;
        for (const { _id, ...changes } of updates) merge(level._source, changes);
      },
      async createEmbeddedDocuments(name: string, data: any[]) {
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
        assert.ok(name === "Wall" || name === "AmbientLight", name);
        await delay();
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

  const globals = globalThis as Record<string, any>;
  const install = () => {
    globals.game = { scenes, folders };
    globals.canvas = { scene: null };
    globals.CONST = { FOLDER_MAX_DEPTH: 4 };
    globals.CONFIG = {
      Scene: { documentClass: FakeScene },
      weatherEffects: Object.fromEntries((options.weather ?? ["rain", "fog"]).map((key) => [key, {}])),
      Canvas: {
        lightAnimations: Object.fromEntries(["flame", "torch", "pulse"].map((key) => [key, {}])),
        darknessAnimations: Object.fromEntries(["magicalGloom", "roiling"].map((key) => [key, {}]))
      }
    };
    globals.foundry = {
      canvas: {
        loadTexture: async (src: string) => {
          await control.textureGate;
          await delay();
          return (options.unloadable ?? []).includes(src) ? null : {};
        }
      },
      documents: {
        Folder: {
          async create(data: any) {
            await delay();
            log.folderCreates++;
            const folder = {
              id: `folder${++counter}`,
              name: data.name.trim(),
              type: data.type,
              folder: data.folder ? folders.get(data.folder) : null
            };
            folders.set(folder.id, folder);
            return folder;
          }
        },
        Scene: FakeScene
      }
    };
  };

  const addFolder = (name: string, parent: any = null, type = "Scene") => {
    const folder = { id: `folder${++counter}`, name, type, folder: parent };
    folders.set(folder.id, folder);
    return folder;
  };
  const addScene = (data: Record<string, any>) => makeScene(data);
  const addWall = (scene: any, data: Record<string, any> = {}) => {
    const wall = makeWall({ c: [0, 0, 1, 1], ...data });
    scene.walls.set(wall.id, wall);
    return wall;
  };
  const addLight = (scene: any, data: Record<string, any> = {}) => {
    const light = makeLight({ x: 100, y: 100, config: { dim: 10 }, ...data }, scene);
    scene.lights.set(light.id, light);
    return light;
  };
  return { install, addFolder, addScene, addWall, addLight, scenes, folders, log, control };
}
