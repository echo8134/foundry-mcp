import { lightMarkers } from "./light-data.mjs";
import { tokenMarkers } from "./token-data.mjs";

const WALL_COLOR = "#ff2d2d";
const DOOR_COLOR = "#2d7bff";
const LIGHT_COLOR = "#ffd400";
const DARKNESS_COLOR = "#c04dff";
// Keyed by CONST.TOKEN_DISPOSITIONS (common/constants.mjs).
const TOKEN_COLORS = Object.freeze({ "-2": "#19e6e6", "-1": "#ff8c1a", 0: "#f0f0f0", 1: "#33dd55" });
const TOKEN_FILL_ALPHA = 0.35;

export function drawWalls(context, scene, rect, width, height) {
  const sx = width / rect.width;
  const sy = height / rect.height;
  const lineWidth = Math.max(2, Math.round(Math.max(width, height) / 400));
  context.lineCap = "round";
  for (const wall of scene.walls) {
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

export function drawLights(context, scene, rect, width, height) {
  const lineWidth = Math.max(2, Math.round(Math.max(width, height) / 400));
  const circle = (x, y, radius) => {
    context.beginPath();
    context.arc(x, y, radius, 0, 2 * Math.PI);
  };
  for (const { x, y, radius, negative } of lightMarkers([...scene.lights.values()], rect, scene.grid, {
    width,
    height
  })) {
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

export function drawTokens(context, scene, rect, width, height) {
  const lineWidth = Math.max(2, Math.round(Math.max(width, height) / 400));
  const placed = scene.tokens.map((token) => {
    const { x, y } = token.getCenterPoint();
    return { x, y, ...token.getSize(), disposition: token.disposition, hidden: token.hidden };
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
