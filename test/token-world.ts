// What the tests of the token write tools share: a call through the tool's own input schema, and a small scene.

import assert from "node:assert/strict";
import { MethodError } from "../module/scripts/errors.mjs";
import { METHODS } from "../module/scripts/methods.mjs";
import { TOOLS } from "../src/tools.ts";
import { fakeWorld } from "./fake-world.ts";

type Name = "place_tokens" | "update_tokens" | "delete_tokens" | "get_scene" | "ensure_scene";
export const viaTool = (name: Name, args: unknown) =>
  (METHODS as unknown as Record<Name, (params: any) => Promise<any>>)[name](TOOLS[name].input.parse(args));

const globals = globalThis as Record<string, unknown>;
const saved = {
  game: globals.game,
  canvas: globals.canvas,
  foundry: globals.foundry,
  CONST: globals.CONST,
  CONFIG: globals.CONFIG
};
export const restoreGlobals = () => {
  Object.assign(globals, saved);
};

/** Makes the scene the one the Gamemaster's tab shows, where Foundry checks a move against walls and the canvas. */
export const view = (scene: unknown) => {
  (globals.canvas as { scene: unknown }).scene = scene;
};

export const refused = (code: string, message?: RegExp) => (error: unknown) =>
  error instanceof MethodError && error.code === code && (message?.test(error.message) ?? true);

export const only = (scene: any) => {
  assert.equal(scene.tokens.size, 1);
  return [...scene.tokens.values()][0];
};

export const MANAGED = { "foundry-mcp": { managed: true } };

/** Strings Foundry would store as other strings, measured live on the token model. */
export const COLOUR_AND_BLANK_RECASTS: [string, Record<string, unknown>, RegExp][] = [
  ["a colour name", { light: { color: "blue" } }, /light\.color: "blue" would be stored as "#00000b"/],
  ["a short colour", { light: { color: "#F80" } }, /light\.color: "#F80" would be stored as "#000f80"/],
  [
    "an empty text for a field that takes none",
    { texture: { src: "" } },
    /texture\.src: "" would be stored as "icons\/svg\/mystery-man\.svg"/
  ]
];

/** A 1000 x 800 map with 0.25 padding on a 100 px grid: the scene rectangle starts at canvas (300, 200). */
export function setUp(options: Parameters<typeof fakeWorld>[0] = {}) {
  const world = fakeWorld({ extraLevels: ["upper"], ...options });
  const scene = world.addScene({ name: "Cellar", width: 1000, height: 800, padding: 0.25 });
  const goblin = world.addActor({
    name: "Goblin",
    prototypeToken: { name: "Goblin", actorLink: false, disposition: -1, width: 1, height: 1 }
  });
  world.install();
  return { world, scene, goblin };
}

export type World = ReturnType<typeof fakeWorld>;
