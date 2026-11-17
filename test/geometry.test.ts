import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canvasToFrame, frameToCanvas, pathsToSegments } from "../module/scripts/geometry.mjs";

// 2000x1500 scene, padding 0.25, grid 100: padding is rounded up to whole cells, so the scene rect starts at 500,400.
const rect = { x: 500, y: 400, width: 2000, height: 1500 };
const pixels = { width: 2000, height: 1500 };

describe("geometry", () => {
  it("places the scene origin at the padded scene rect, not at the canvas origin", () => {
    assert.deepEqual(frameToCanvas([0, 0], pixels, rect), [500, 400]);
    assert.deepEqual(frameToCanvas([2000, 1500], pixels, rect), [2500, 1900]);
  });

  it("scales by the frame: half-size frame doubles coordinates", () => {
    const half = { width: 1000, height: 750 };
    assert.deepEqual(frameToCanvas([100, 100], half, rect), [700, 600]);
    assert.deepEqual(frameToCanvas([1000, 750], half, rect), [2500, 1900]);
  });

  it("gives grid-cell coordinates with a columns x rows frame", () => {
    assert.deepEqual(frameToCanvas([3, 2], { width: 20, height: 15 }, rect), [800, 600]);
  });

  it("turns a closed path of N points into N segments with identical shared endpoints", () => {
    const { segments, skipped } = pathsToSegments(
      [
        {
          points: [
            [0.1, 0.1],
            [10.3, 0.1],
            [10.3, 8.7],
            [0.1, 8.7]
          ],
          closed: true
        }
      ],
      { width: 10, height: 8 },
      rect
    );
    assert.equal(skipped, 0);
    assert.equal(segments.length, 4);
    const count = segments.length;
    for (let i = 0; i < count; i++) {
      const current: { c: number[] } = segments[i]!;
      const following: { c: number[] } = segments[(i + 1) % count]!;
      assert.deepEqual(current.c.slice(2), following.c.slice(0, 2));
    }
  });

  it("turns an open path of N points into N-1 segments and keeps the kind", () => {
    const { segments } = pathsToSegments(
      [
        {
          points: [
            [0, 0],
            [1, 0],
            [1, 1]
          ],
          kind: "door"
        }
      ],
      pixels,
      rect
    );
    assert.equal(segments.length, 2);
    assert.ok(segments.every((s) => s.kind === "door"));
  });

  it("defaults the kind to wall", () => {
    const { segments } = pathsToSegments(
      [
        {
          points: [
            [0, 0],
            [5, 0]
          ]
        }
      ],
      pixels,
      rect
    );
    assert.equal(segments[0]!.kind, "wall");
  });

  it("drops and counts segments that collapse to a point after rounding", () => {
    const { segments, skipped } = pathsToSegments(
      [
        {
          points: [
            [10, 10],
            [10.2, 10.2],
            [50, 10]
          ]
        },
        {
          points: [
            [5, 5],
            [5, 5]
          ]
        }
      ],
      pixels,
      rect
    );
    assert.equal(skipped, 2);
    assert.deepEqual(
      segments.map((s) => s.c),
      [[510, 410, 550, 410]]
    );
  });

  it("reports the first converted point that is not a safe integer before it skips anything, so two overflowing points are not one point", () => {
    const overflow = pathsToSegments(
      [
        {
          points: [
            [1e308, 0],
            [1.5e308, 0]
          ]
        }
      ],
      pixels,
      rect
    );
    assert.deepEqual([overflow.segments, overflow.skipped, overflow.unstorable?.[0]], [[], 0, Infinity]);
    const late = pathsToSegments(
      [
        {
          points: [
            [5, 5],
            [5, 5]
          ]
        },
        {
          points: [
            [0, 0],
            [2 ** 60, 0]
          ]
        }
      ],
      pixels,
      rect
    );
    assert.deepEqual([late.segments, late.skipped, late.unstorable], [[], 0, [2 ** 60 + 500, 400]]);
    assert.equal(
      pathsToSegments(
        [
          {
            points: [
              [0, 0],
              [5, 0]
            ]
          }
        ],
        pixels,
        rect
      ).unstorable,
      null
    );
  });

  it("round-trips frame to canvas to frame", () => {
    const frame = { width: 100, height: 80 };
    const [cx, cy] = frameToCanvas([37, 21], frame, rect);
    const [x, y] = canvasToFrame([cx, cy], frame, rect);
    assert.ok(Math.abs(x - 37) < frame.width / rect.width);
    assert.ok(Math.abs(y - 21) < frame.height / rect.height);
  });

  it("round-trips exactly in scene pixels", () => {
    assert.deepEqual(canvasToFrame([1234, 987], pixels, rect), [734, 587]);
  });

  it("carries a path's door state onto each of its segments and leaves other paths without one", () => {
    const { segments } = pathsToSegments(
      [
        {
          points: [
            [0, 0],
            [1, 0],
            [1, 1]
          ],
          kind: "door",
          state: "open"
        },
        {
          points: [
            [5, 5],
            [6, 5]
          ],
          kind: "door"
        }
      ],
      pixels,
      rect
    );
    assert.deepEqual(
      segments.map((s) => s.state),
      ["open", "open", undefined]
    );
  });
});
