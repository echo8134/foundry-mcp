// What the tests of sync_regions share: a scene of two levels, and a rectangle as a caller gives it and as Foundry
// stores it.

import { fakeWorld } from "./fake-world.ts";
import { MANAGED, viaTool } from "./token-world.ts";

export const box = (x: number, y: number, width = 100, height = 100) => ({ type: "rectangle", x, y, width, height });
export const storedBox = (x: number, y: number, width = 100, height = 100) => ({
  type: "rectangle",
  hole: false,
  x,
  y,
  width,
  height,
  anchorX: 0,
  anchorY: 0,
  rotation: 0,
  gridBased: false
});

/** A scene of two levels, lvl1 and upper, whose scene rectangle starts at the canvas origin. */
export function setUp() {
  const world = fakeWorld({ extraLevels: ["upper"] });
  const scene = world.addScene({ name: "Cathedral", width: 1000, height: 800 });
  world.install();
  const sync = (args: Record<string, unknown>) => viaTool("sync_regions", { sceneId: scene.id, ...args });
  const writes = () => world.log.documentWrites.map((write) => `${write.action} ${write.document}`);
  const named = (name: string) => scene.regions.filter((region: any) => region.name === name);
  const bridgeMade = (data: Record<string, unknown>) =>
    world.addDocument("Region", { flags: MANAGED, ...data }, { parent: scene });
  return { world, scene, sync, writes, named, bridgeMade };
}
