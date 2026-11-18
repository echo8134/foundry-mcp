import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { regionMarkers, shapeInFrame, shapeOnCanvas } from "../module/scripts/region-data.mjs";

// 2000x1500 scene, padding 0.25, grid 100: the scene rectangle starts at 500,400 on the canvas.
const rect = { x: 500, y: 400, width: 2000, height: 1500 };
const pixels = { width: 2000, height: 1500 };
// Half the scene size: a frame coordinate is half the scene pixel.
const half = { width: 1000, height: 750 };
// 20 columns of 100 px and 30 rows of 50 px: x shrinks by 100 and y by 50.
const uneven = { width: 20, height: 30 };

/** One stored shape of each of Foundry's types, in canvas pixels, and what it is in the half-size frame. */
const STORED: Record<string, { stored: Record<string, any>; inHalf: Record<string, any> }> = {
  rectangle: {
    stored: {
      type: "rectangle",
      hole: false,
      x: 700,
      y: 600,
      width: 400,
      height: 200,
      anchorX: 0,
      anchorY: 0,
      rotation: 0,
      gridBased: false
    },
    inHalf: {
      type: "rectangle",
      hole: false,
      x: 100,
      y: 100,
      width: 200,
      height: 100,
      anchorX: 0,
      anchorY: 0,
      rotation: 0,
      gridBased: false
    }
  },
  circle: {
    stored: { type: "circle", hole: true, x: 1500, y: 900, radius: 300, gridBased: false },
    inHalf: { type: "circle", hole: true, x: 500, y: 250, radius: 150, gridBased: false }
  },
  ellipse: {
    stored: { type: "ellipse", hole: false, x: 900, y: 800, radiusX: 200, radiusY: 100, rotation: 0, gridBased: false },
    inHalf: { type: "ellipse", hole: false, x: 200, y: 200, radiusX: 100, radiusY: 50, rotation: 0, gridBased: false }
  },
  cone: {
    stored: {
      type: "cone",
      hole: false,
      x: 600,
      y: 500,
      radius: 400,
      angle: 60,
      rotation: 45,
      curvature: "round",
      gridBased: false
    },
    inHalf: {
      type: "cone",
      hole: false,
      x: 50,
      y: 50,
      radius: 200,
      angle: 60,
      rotation: 45,
      curvature: "round",
      gridBased: false
    }
  },
  ring: {
    stored: {
      type: "ring",
      hole: false,
      x: 1000,
      y: 1000,
      radius: 200,
      innerWidth: 20,
      outerWidth: 40,
      gridBased: false
    },
    inHalf: { type: "ring", hole: false, x: 250, y: 300, radius: 100, innerWidth: 10, outerWidth: 20, gridBased: false }
  },
  line: {
    stored: { type: "line", hole: false, x: 500, y: 400, length: 600, width: 100, rotation: 0, gridBased: false },
    inHalf: { type: "line", hole: false, x: 0, y: 0, length: 300, width: 50, rotation: 0, gridBased: false }
  },
  polygon: {
    stored: { type: "polygon", hole: false, points: [500, 400, 900, 400, 900, 1000], origin: { x: 700, y: 600 } },
    inHalf: {
      type: "polygon",
      hole: false,
      points: [
        [0, 0],
        [200, 0],
        [200, 300]
      ],
      origin: { x: 100, y: 100 }
    }
  },
  token: {
    stored: { type: "token", hole: false, x: 700, y: 600, width: 2, height: 1, shape: 4 },
    inHalf: { type: "token", hole: false, x: 100, y: 100, width: 2, height: 1, shape: 4 }
  },
  grid: {
    stored: { type: "grid", hole: false, offsets: [{ i: 4, j: 5 }], origin: { x: 1100, y: 800 } },
    inHalf: { type: "grid", hole: false, offsets: [{ i: 4, j: 5 }], origin: { x: 300, y: 200 } }
  },
  emanation: {
    stored: {
      type: "emanation",
      hole: false,
      base: { type: "circle", hole: false, x: 1500, y: 900, radius: 100, gridBased: false },
      radius: 60,
      gridBased: false
    },
    inHalf: {
      type: "emanation",
      hole: false,
      base: { type: "circle", hole: false, x: 500, y: 250, radius: 50, gridBased: false },
      radius: 30,
      gridBased: false
    }
  }
};

describe("a region's shape in the frame of a call", () => {
  for (const [type, { stored, inHalf }] of Object.entries(STORED)) {
    it(`gives a shape of the type ${type} in the frame, and stores it again as it was`, () => {
      assert.deepEqual(shapeInFrame(stored, half, rect), inHalf);
      assert.deepEqual(shapeOnCanvas(inHalf, half, rect), { shape: stored, problems: [] });
      assert.deepEqual(shapeOnCanvas(shapeInFrame(stored, pixels, rect), pixels, rect), {
        shape: stored,
        problems: []
      });
    });
  }

  it("gives a polygon without an origin its points and no origin", () => {
    const stored = { type: "polygon", hole: false, points: [500, 400, 900, 400, 900, 1000], origin: null };
    assert.equal(shapeInFrame(stored, half, rect).origin, null);
    assert.equal(shapeOnCanvas(shapeInFrame(stored, half, rect), half, rect).shape.origin, null);
  });

  it("scales the sides of a shape by the axis each lies along where the frame is not the scene's shape", () => {
    const sides = (rotation: number) => {
      const { width, height } = shapeInFrame(
        { type: "rectangle", x: 500, y: 400, width: 400, height: 200, rotation },
        uneven,
        rect
      );
      return [width, height];
    };
    assert.deepEqual(sides(0), [4, 4]);
    assert.deepEqual(sides(180), [4, 4]);
    assert.deepEqual(sides(90), [8, 2]);
    assert.deepEqual(sides(270), [8, 2]);
    // Turned off the axes, both by the mean of 1/100 and 1/50.
    assert.deepEqual(sides(45), [6, 3]);
    assert.equal(shapeInFrame({ type: "circle", x: 500, y: 400, radius: 200 }, uneven, rect).radius, 3);
    // A rectangle of 4 columns by 4 rows covers exactly those cells on the canvas.
    assert.deepEqual(shapeOnCanvas({ type: "rectangle", x: 1, y: 2, width: 4, height: 4 }, uneven, rect).shape, {
      type: "rectangle",
      x: 600,
      y: 500,
      width: 400,
      height: 200
    });
  });

  it("stores points and lengths in whole scene pixels", () => {
    const image = { width: 1568, height: 1176 };
    const { shape, problems } = shapeOnCanvas({ type: "rectangle", x: 100, y: 50, width: 75, height: 33 }, image, rect);
    assert.deepEqual(problems, []);
    // 100 * 2000 / 1568 = 127.55, 50 * 1500 / 1176 = 63.78, 75 * 1.2755 = 95.66, 33 * 1.2755 = 42.09.
    assert.deepEqual(shape, { type: "rectangle", x: 628, y: 464, width: 96, height: 42 });
  });

  it("drops a corner of a polygon that falls on the one before it, and the one that closes it", () => {
    const { shape, problems } = shapeOnCanvas(
      {
        type: "polygon",
        points: [
          [0, 0],
          [0.2, 0.2],
          [100, 0],
          [100, 100],
          [0, 0]
        ]
      },
      pixels,
      rect
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(shape.points, [500, 400, 600, 400, 600, 500]);
  });

  it("says what it cannot work with, and what Foundry could not store or draw", () => {
    const problemsOf = (shape: Record<string, any>, frame = pixels) => shapeOnCanvas(shape, frame, rect).problems;
    assert.match(problemsOf({ type: "square", x: 0, y: 0 })[0]!, /^its type must be one of rectangle, circle, /);
    assert.deepEqual(problemsOf({ type: "rectangle", x: "1", y: 0, width: 5, height: 5 }), [
      "x and y must be numbers."
    ]);
    assert.deepEqual(problemsOf({ type: "circle", x: 1, y: 1, radius: "wide" }), ["radius must be a number."]);
    assert.deepEqual(
      problemsOf({
        type: "polygon",
        points: [
          [0, 0],
          [10, 10]
        ]
      }),
      ["points must be at least 3 points, each as [x, y]."]
    );
    assert.deepEqual(problemsOf({ type: "polygon", points: [0, 0, 10, 0, 10, 10] }), [
      "points must be at least 3 points, each as [x, y]."
    ]);
    assert.deepEqual(
      problemsOf({
        type: "polygon",
        points: [
          [0, 0],
          [0.1, 0.1],
          [0.2, 0]
        ]
      }),
      ["fewer than 3 of its points are apart once converted to scene pixels, so it encloses nothing."]
    );
    assert.deepEqual(problemsOf({ type: "rectangle", x: 0, y: 0, width: 0.4, height: 10 }), [
      "width must be above 0 once rounded to whole scene pixels at this frame."
    ]);
    assert.deepEqual(problemsOf({ type: "ellipse", x: 0, y: 0, radiusX: 0, radiusY: -3 }), [
      "radiusX and radiusY must be above 0 once rounded to whole scene pixels at this frame."
    ]);
    assert.deepEqual(problemsOf({ type: "rectangle", x: 1e300, y: 0, width: 5, height: 5 }), [
      "a coordinate is too large once converted to scene pixels (the bridge stores only safe integers)."
    ]);
    assert.deepEqual(problemsOf({ type: "emanation", radius: 5, base: { type: "circle", x: 0, y: 0, radius: 0 } }), [
      "base: radius must be above 0 once rounded to whole scene pixels at this frame."
    ]);
    assert.deepEqual(
      problemsOf({
        type: "polygon",
        points: [
          [0, 0],
          [10, 0],
          [10, 10]
        ],
        origin: { x: 1 }
      }),
      ["origin must be {x, y} or null."]
    );
  });

  it("takes a ring and an emanation with a reach of 0, as Foundry does", () => {
    const ring = { type: "ring", x: 0, y: 0, radius: 0, innerWidth: 0, outerWidth: 50 };
    const emanation = { type: "emanation", radius: 0, base: { type: "circle", x: 0, y: 0, radius: 50 } };
    assert.deepEqual(shapeOnCanvas(ring, pixels, rect).problems, []);
    assert.deepEqual(shapeOnCanvas(emanation, pixels, rect).problems, []);
  });
});

describe("regionMarkers", () => {
  it("puts each outline on the image and the name in the middle of the box around them", () => {
    const [marker] = regionMarkers(
      [
        {
          name: "Stair",
          color: "#ff00ff",
          contours: [
            [700, 600, 1100, 600, 1100, 1000, 700, 1000],
            [800, 700, 900, 700, 900, 800]
          ]
        }
      ],
      rect,
      { width: 500, height: 375 }
    );
    assert.deepEqual(marker, {
      name: "Stair",
      color: "#ff00ff",
      contours: [
        [
          [50, 50],
          [150, 50],
          [150, 150],
          [50, 150]
        ],
        [
          [75, 75],
          [100, 75],
          [100, 100]
        ]
      ],
      label: [100, 100]
    });
  });

  it("gives a region without an area no place for its name", () => {
    assert.deepEqual(
      regionMarkers([{ name: "Empty", color: "#000000", contours: [] }], rect, { width: 500, height: 375 }),
      [{ name: "Empty", color: "#000000", contours: [], label: null }]
    );
  });
});
