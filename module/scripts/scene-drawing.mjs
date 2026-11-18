// What get_scene_image draws over the rendered scene. Each function gets the documents to draw, and the view: the
// scene rectangle, the scene's grid and the size of the image.

import { lightMarkers } from "./light-data.mjs";
import { regionMarkers } from "./region-data.mjs";
import { storedCentre, tokenMarkers } from "./token-data.mjs";

const WALL_COLOR = "#ff2d2d";
const DOOR_COLOR = "#2d7bff";
const LIGHT_COLOR = "#ffd400";
const DARKNESS_COLOR = "#c04dff";
// Keyed by CONST.TOKEN_DISPOSITIONS (common/constants.mjs).
const TOKEN_COLORS = Object.freeze({ "-2": "#19e6e6", "-1": "#ff8c1a", 0: "#f0f0f0", 1: "#33dd55" });
const TOKEN_FILL_ALPHA = 0.35;
const REGION_FILL_ALPHA = 0.25;

const lineWidthFor = ({ width, height }) => Math.max(2, Math.round(Math.max(width, height) / 400));

export function drawWalls(context, walls, view) {
  const { rect, width, height } = view;
  const sx = width / rect.width;
  const sy = height / rect.height;
  const lineWidth = lineWidthFor(view);
  context.lineCap = "round";
  for (const wall of walls) {
    const [x1, y1, x2, y2] = wall.c;
    context.beginPath();
    context.moveTo((x1 - rect.x) * sx, (y1 - rect.y) * sy);
    context.lineTo((x2 - rect.x) * sx, (y2 - rect.y) * sy);
    context.strokeStyle = "#000000";
    context.lineWidth = lineWidth + 2;
    context.stroke();
    context.strokeStyle = wall.door > 0 ? DOOR_COLOR : WALL_COLOR;
    context.lineWidth = lineWidth;
    context.stroke();
  }
}

export function drawLights(context, lights, view) {
  const { rect, grid, width, height } = view;
  const lineWidth = lineWidthFor(view);
  const circle = (x, y, radius) => {
    context.beginPath();
    context.arc(x, y, radius, 0, 2 * Math.PI);
  };
  for (const { x, y, radius, negative } of lightMarkers(lights, rect, grid, { width, height })) {
    const color = negative ? DARKNESS_COLOR : LIGHT_COLOR;
    if (radius > 0) {
      for (const [stroke, strokeWidth] of [
        ["#000000", lineWidth + 2],
        [color, lineWidth]
      ]) {
        context.strokeStyle = stroke;
        context.lineWidth = strokeWidth;
        circle(x, y, radius);
        context.stroke();
      }
    }
    circle(x, y, lineWidth * 2 + 2);
    context.fillStyle = color;
    context.strokeStyle = "#000000";
    context.lineWidth = 2;
    context.fill();
    context.stroke();
  }
}

export function drawTokens(context, tokens, view) {
  const { rect, width, height } = view;
  const lineWidth = lineWidthFor(view);
  const placed = tokens.map((token) => {
    const { x, y } = storedCentre(token);
    return { x, y, ...token.getSize(token._source), disposition: token.disposition, hidden: token.hidden };
  });
  for (const marker of tokenMarkers(placed, rect, { width, height })) {
    const color = TOKEN_COLORS[marker.disposition] ?? TOKEN_COLORS[0];
    context.beginPath();
    context.ellipse(marker.x, marker.y, marker.width / 2, marker.height / 2, 0, 0, 2 * Math.PI);
    if (!marker.hidden) {
      context.globalAlpha = TOKEN_FILL_ALPHA;
      context.fillStyle = color;
      context.fill();
      context.globalAlpha = 1;
    }
    for (const [stroke, strokeWidth] of [
      ["#000000", lineWidth + 2],
      [color, lineWidth]
    ]) {
      context.strokeStyle = stroke;
      context.lineWidth = strokeWidth;
      context.stroke();
    }
  }
}

/**
 * Each region in its stored colour: its area filled lightly, its outlines dashed and its name in the middle. The
 * outlines are the ones Foundry works out of the region's shapes (RegionDocument#polygons,
 * client/documents/region.mjs:50-61), where a hole is an outline inside another, so filling by the even-odd rule
 * leaves it open.
 */
export function drawRegions(context, regions, view) {
  const { rect, width, height } = view;
  const lineWidth = lineWidthFor(view);
  const outlined = regions.map((region) => ({
    name: region.name,
    color: region._source.color,
    contours: region.polygons.map((polygon) => polygon.points)
  }));
  context.font = `${Math.max(12, Math.round(Math.max(width, height) / 60))}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const { name, color, contours, label } of regionMarkers(outlined, rect, { width, height })) {
    context.beginPath();
    for (const contour of contours) {
      for (const [index, [x, y]] of contour.entries()) {
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
    }
    context.globalAlpha = REGION_FILL_ALPHA;
    context.fillStyle = color;
    context.fill("evenodd");
    context.globalAlpha = 1;
    context.setLineDash([lineWidth * 3, lineWidth * 2]);
    for (const [stroke, strokeWidth] of [
      ["#000000", lineWidth + 2],
      [color, lineWidth]
    ]) {
      context.strokeStyle = stroke;
      context.lineWidth = strokeWidth;
      context.stroke();
    }
    context.setLineDash([]);
    if (!label) continue;
    context.strokeStyle = "#000000";
    context.lineWidth = 3;
    context.strokeText(name, label[0], label[1]);
    context.fillStyle = "#ffffff";
    context.fillText(name, label[0], label[1]);
  }
}
