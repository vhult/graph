import { GraphError } from "../api/errors";
import type { Polygon, Rect } from "../api/types";

export const MAX_SHAPE_POINTS = 1024;

function finite(v: number, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new GraphError("invalid-argument", `query.inside: ${name} must be a finite number, got ${String(v)}`);
  return v;
}

export function packShape(shape: Rect | Polygon, pixelRatio: number): Float32Array {
  if (shape === null || typeof shape !== "object") throw new GraphError("invalid-argument", "query.inside: shape must be a rect or { points }");
  if ("points" in shape) {
    const p = shape.points;
    if (p === null || typeof p !== "object" || typeof p.length !== "number") throw new GraphError("invalid-argument", "query.inside: points must be an array of numbers");
    if (p.length % 2 !== 0) throw new GraphError("invalid-argument", `query.inside: points holds x, y pairs, got ${p.length} numbers`);
    const n = p.length / 2;
    if (n < 3) throw new GraphError("invalid-argument", `query.inside: a polygon needs at least 3 points, got ${n}`);
    if (n > MAX_SHAPE_POINTS) throw new GraphError("invalid-argument", `query.inside: a polygon takes at most ${MAX_SHAPE_POINTS} points, got ${n}`);
    const out = new Float32Array(p.length);
    for (let k = 0; k < p.length; k++) out[k] = finite(p[k]!, `points[${k}]`) * pixelRatio;
    return out;
  }
  const x = finite(shape.x, "x") * pixelRatio;
  const y = finite(shape.y, "y") * pixelRatio;
  const w = finite(shape.width, "width");
  const h = finite(shape.height, "height");
  if (w < 0 || h < 0) throw new GraphError("invalid-argument", `query.inside: width and height must be >= 0, got ${w} and ${h}`);
  const x1 = x + w * pixelRatio;
  const y1 = y + h * pixelRatio;
  return new Float32Array([x, y, x1, y, x1, y1, x, y1]);
}
