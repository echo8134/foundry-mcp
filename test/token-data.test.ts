import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tokenMarkers } from "../module/scripts/token-data.mjs";

describe("tokenMarkers", () => {
  const rect = { x: 300, y: 200, width: 1000, height: 800 };

  it("turns a token's centre and pixel size in the canvas into its centre and size in image pixels", () => {
    const [marker] = tokenMarkers([{ x: 600, y: 450, width: 200, height: 100, disposition: 0, hidden: false }], rect, {
      width: 500,
      height: 400
    });
    assert.deepEqual(marker, { x: 150, y: 125, width: 100, height: 50, disposition: 0, hidden: false });
  });

  it("scales each axis on its own when the image does not keep the scene's aspect ratio", () => {
    const [marker] = tokenMarkers([{ x: 350, y: 250, width: 100, height: 100, disposition: 1, hidden: true }], rect, {
      width: 100,
      height: 400
    });
    assert.deepEqual(marker, { x: 5, y: 25, width: 10, height: 50, disposition: 1, hidden: true });
  });
});
