import { GraphError } from "../api/errors";
import type { IconPath as IconPathSource, IconSource } from "../api/types";
import { ICON_CONSTANTS } from "../data/Layouts";

type Point = [number, number];
type Quad = [Point, Point, Point];
type Matrix = [number, number, number, number, number, number];
type Segment = ["L", number, number] | ["Q", number, number, number, number] | ["C", number, number, number, number, number, number];

interface Contour {
  x: number;
  y: number;
  segs: Segment[];
}

interface IconPath {
  d: string;
  evenOdd: boolean;
  matrix: Matrix;
}

interface ParsedIcon {
  viewBox: [number, number, number, number] | null;
  paths: IconPath[];
}

interface Band {
  curves: number[];
  min: number[];
  max: number[];
}

interface BuiltIcon {
  curves: Quad[];
  nb: number;
  evenOdd: boolean;
  h: Band[];
  v: Band[];
}

export interface IconSet {
  data: Uint32Array;
  count: number;
  curves: number;
  maxCurves: number;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const DEFAULT_VIEWBOX: [number, number, number, number] = [0, 0, 24, 24];
const CURVE_TOLERANCE = 2e-4;
const BANDS_MAX = 32;
const BAND_SLACK = 1.05;
const SKIPPED = new Set(["defs", "clipPath", "mask", "symbol", "title", "desc", "metadata", "style", "pattern", "linearGradient", "radialGradient", "filter", "marker"]);

export function buildIcons(sources: readonly IconSource[]): IconSet {
  const built = sources.map((s, i) => {
    try {
      return buildIcon("svg" in s ? parseSvg(s.svg) : fromPath(s));
    } catch (e) {
      throw new GraphError("invalid-argument", `defineIcons: icon ${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return pack(built);
}

function fromPath(icon: IconPathSource): ParsedIcon {
  const d = typeof icon.path === "string" ? icon.path : icon.path.join(" ");
  const vb = icon.viewBox ?? DEFAULT_VIEWBOX;
  return { viewBox: [vb[0], vb[1], vb[2], vb[3]], paths: [{ d, evenOdd: icon.fillRule === "evenodd", matrix: IDENTITY }] };
}

function attributes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!] = m[2] ?? m[3] ?? "";
  const style = out.style;
  if (style) {
    for (const part of style.split(";")) {
      const k = part.indexOf(":");
      if (k > 0) out[part.slice(0, k).trim()] = part.slice(k + 1).trim();
    }
  }
  return out;
}

const numbers = (s: string): number[] => (s.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function parseTransform(text: string | undefined): Matrix {
  let m = IDENTITY;
  if (!text) return m;
  for (const t of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const v = numbers(t[2]!);
    let next: Matrix;
    switch (t[1]) {
      case "matrix":
        next = [v[0] ?? 1, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1, v[4] ?? 0, v[5] ?? 0];
        break;
      case "translate":
        next = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case "scale":
        next = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const a = ((v[0] ?? 0) * Math.PI) / 180;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const cx = v[1] ?? 0;
        const cy = v[2] ?? 0;
        next = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
        break;
      }
      case "skewX":
        next = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        next = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    m = multiply(m, next);
  }
  return m;
}

function shapePath(tag: string, a: Record<string, string>): string | null {
  const n = (k: string, d = 0) => (a[k] !== undefined && a[k] !== "" ? Number.parseFloat(a[k]!) : d);
  switch (tag) {
    case "path":
      return a.d ?? null;
    case "circle":
    case "ellipse": {
      const cx = n("cx");
      const cy = n("cy");
      const rx = tag === "circle" ? n("r") : n("rx");
      const ry = tag === "circle" ? n("r") : n("ry", rx);
      if (!(rx > 0) || !(ry > 0)) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case "rect": {
      const x = n("x");
      const y = n("y");
      const w = n("width");
      const h = n("height");
      if (!(w > 0) || !(h > 0)) return null;
      let rx = a.rx !== undefined ? n("rx") : n("ry");
      let ry = a.ry !== undefined ? n("ry") : rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      if (rx === 0 || ry === 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return (
        `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
        `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
      );
    }
    case "polygon":
    case "polyline": {
      const p = numbers(a.points ?? "");
      if (p.length < 6) return null;
      let d = `M${p[0]} ${p[1]}`;
      for (let i = 2; i + 1 < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
      return d + "Z";
    }
    default:
      return null;
  }
}

interface Scope {
  tag: string;
  matrix: Matrix;
  evenOdd: boolean;
  hidden: boolean;
  noFill: boolean;
}

function parseSvg(markup: string): ParsedIcon {
  const stack: Scope[] = [{ tag: "", matrix: IDENTITY, evenOdd: false, hidden: false, noFill: false }];
  let viewBox: [number, number, number, number] | null = null;
  let size: [number, number] | null = null;
  let skip = 0;
  const paths: IconPath[] = [];
  const body = markup.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  for (const m of body.matchAll(/<\s*(\/)?\s*([a-zA-Z][\w:-]*)([^>]*?)(\/)?\s*>/g)) {
    const closing = m[1] === "/";
    const tag = m[2]!;
    const selfClosing = m[4] === "/";
    if (closing) {
      if (SKIPPED.has(tag)) skip = Math.max(0, skip - 1);
      else if (skip === 0 && stack.length > 1 && stack[stack.length - 1]!.tag === tag) stack.pop();
      continue;
    }
    if (SKIPPED.has(tag)) {
      if (!selfClosing) skip++;
      continue;
    }
    if (skip > 0) continue;
    const a = attributes(m[3]!);
    const parent = stack[stack.length - 1]!;
    const matrix = multiply(parent.matrix, parseTransform(a.transform));
    const evenOdd = a["fill-rule"] !== undefined ? a["fill-rule"] === "evenodd" : parent.evenOdd;
    const hidden = parent.hidden || a.display === "none" || a.visibility === "hidden";
    const noFill = a.fill !== undefined ? a.fill === "none" || a.fill === "transparent" : parent.noFill;
    if (tag === "svg" && stack.length === 1) {
      const vb = numbers(a.viewBox ?? "");
      if (vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) viewBox = [vb[0]!, vb[1]!, vb[2]!, vb[3]!];
      const w = Number.parseFloat(a.width ?? "");
      const h = Number.parseFloat(a.height ?? "");
      if (w > 0 && h > 0) size = [w, h];
    }
    if (tag === "svg" || tag === "g" || tag === "a") {
      if (!selfClosing) stack.push({ tag, matrix, evenOdd, hidden, noFill });
      continue;
    }
    const d = shapePath(tag, a);
    if (d && !hidden && !noFill) paths.push({ d, evenOdd, matrix });
  }
  if (paths.length === 0) throw new Error("no filled path, circle, ellipse, rect or polygon found");
  return { viewBox: viewBox ?? (size ? [0, 0, size[0], size[1]] : null), paths };
}

function parsePath(d: string): Contour[] {
  const num = /[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/y;
  let i = 0;
  const skip = () => {
    while (i < d.length && (d[i] === " " || d[i] === "," || d[i] === "\n" || d[i] === "\t" || d[i] === "\r")) i++;
  };
  const readNum = () => {
    skip();
    num.lastIndex = i;
    const m = num.exec(d);
    if (!m) throw new Error(`bad number at ${i} in path data`);
    i = num.lastIndex;
    return Number(m[0]);
  };
  const readFlag = () => {
    skip();
    const c = d[i++];
    if (c !== "0" && c !== "1") throw new Error(`bad arc flag at ${i} in path data`);
    return c === "1";
  };
  const contours: Contour[] = [];
  let cur: Contour | null = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastC: Point | null = null;
  let lastQ: Point | null = null;
  let cmd = "";
  const close = () => {
    if (!cur) return;
    if (x !== sx || y !== sy) cur.segs.push(["L", sx, sy]);
    if (cur.segs.length > 0) contours.push(cur);
    cur = null;
    x = sx;
    y = sy;
  };
  for (;;) {
    skip();
    if (i >= d.length) break;
    const ch = d[i]!;
    const fresh = (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
    if (fresh) {
      cmd = ch;
      i++;
    } else if (!cmd) throw new Error("path data must start with a command");
    const rel = cmd >= "a";
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (C === "Z") {
      if (!fresh) throw new Error(`unexpected "${ch}" after "${cmd}" at ${i} in path data`);
      close();
      lastC = lastQ = null;
      continue;
    }
    if (C === "M") {
      const nx = readNum() + ox;
      const ny = readNum() + oy;
      close();
      x = sx = nx;
      y = sy = ny;
      cur = { x, y, segs: [] };
      cmd = rel ? "l" : "L";
      lastC = lastQ = null;
      continue;
    }
    if (!cur) {
      sx = x;
      sy = y;
      cur = { x, y, segs: [] };
    }
    const c = cur as Contour;
    switch (C) {
      case "L":
        x = readNum() + ox;
        y = readNum() + oy;
        c.segs.push(["L", x, y]);
        lastC = lastQ = null;
        break;
      case "H":
        x = readNum() + ox;
        c.segs.push(["L", x, y]);
        lastC = lastQ = null;
        break;
      case "V":
        y = readNum() + oy;
        c.segs.push(["L", x, y]);
        lastC = lastQ = null;
        break;
      case "C":
      case "S": {
        let x1: number;
        let y1: number;
        if (C === "C") {
          x1 = readNum() + ox;
          y1 = readNum() + oy;
        } else {
          x1 = lastC ? 2 * x - lastC[0] : x;
          y1 = lastC ? 2 * y - lastC[1] : y;
        }
        const x2 = readNum() + ox;
        const y2 = readNum() + oy;
        x = readNum() + ox;
        y = readNum() + oy;
        c.segs.push(["C", x1, y1, x2, y2, x, y]);
        lastC = [x2, y2];
        lastQ = null;
        break;
      }
      case "Q":
      case "T": {
        let x1: number;
        let y1: number;
        if (C === "Q") {
          x1 = readNum() + ox;
          y1 = readNum() + oy;
        } else {
          x1 = lastQ ? 2 * x - lastQ[0] : x;
          y1 = lastQ ? 2 * y - lastQ[1] : y;
        }
        x = readNum() + ox;
        y = readNum() + oy;
        c.segs.push(["Q", x1, y1, x, y]);
        lastQ = [x1, y1];
        lastC = null;
        break;
      }
      case "A": {
        const rx = readNum();
        const ry = readNum();
        const phi = (readNum() * Math.PI) / 180;
        const fa = readFlag();
        const fs = readFlag();
        const x2 = readNum() + ox;
        const y2 = readNum() + oy;
        for (const s of arcToCubics(x, y, rx, ry, phi, fa, fs, x2, y2)) c.segs.push(s);
        x = x2;
        y = y2;
        lastC = lastQ = null;
        break;
      }
      default:
        throw new Error(`unknown path command "${cmd}"`);
    }
  }
  close();
  return contours;
}

function arcToCubics(x1: number, y1: number, rx: number, ry: number, phi: number, fa: boolean, fs: boolean, x2: number, y2: number): Segment[] {
  if (x1 === x2 && y1 === y2) return [];
  if (rx === 0 || ry === 0) return [["L", x2, y2]];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = c * dx + s * dy;
  const y1p = -s * dx + c * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const k = Math.sqrt(lam);
    rx *= k;
    ry *= k;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (fa === fs) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = c * cxp - s * cyp + (x1 + x2) / 2;
  const cy = s * cxp + c * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  if (fs && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const map = (u: number, v: number): Point => [cx + rx * u * c - ry * v * s, cy + rx * u * s + ry * v * c];
  const out: Segment[] = [];
  let th = t1;
  for (let j = 0; j < n; j++) {
    const c1 = Math.cos(th);
    const s1 = Math.sin(th);
    const c2 = Math.cos(th + step);
    const s2 = Math.sin(th + step);
    const a = map(c1 - k * s1, s1 + k * c1);
    const b = map(c2 + k * s2, s2 - k * c2);
    const e: Point = j === n - 1 ? [x2, y2] : map(c2, s2);
    out.push(["C", a[0], a[1], b[0], b[1], e[0], e[1]]);
    th += step;
  }
  return out;
}

function cubicToQuads(p0: Point, p1: Point, p2: Point, p3: Point, out: Quad[]): void {
  const ex = p3[0] - 3 * p2[0] + 3 * p1[0] - p0[0];
  const ey = p3[1] - 3 * p2[1] + 3 * p1[1] - p0[1];
  const err = (Math.sqrt(3) / 36) * Math.hypot(ex, ey);
  const n = Math.max(1, Math.ceil(Math.cbrt(err / CURVE_TOLERANCE)));
  const at = (t: number): Point => {
    const u = 1 - t;
    return [
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ];
  };
  const der = (t: number): Point => {
    const u = 1 - t;
    return [
      3 * u * u * (p1[0] - p0[0]) + 6 * u * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]),
      3 * u * u * (p1[1] - p0[1]) + 6 * u * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]),
    ];
  };
  for (let j = 0; j < n; j++) {
    const a = j / n;
    const b = (j + 1) / n;
    const h = (b - a) / 3;
    const q0 = j === 0 ? p0 : at(a);
    const q3 = j === n - 1 ? p3 : at(b);
    const da = der(a);
    const db = der(b);
    const c1x = q0[0] + h * da[0];
    const c1y = q0[1] + h * da[1];
    const c2x = q3[0] - h * db[0];
    const c2y = q3[1] - h * db[1];
    out.push([q0, [(3 * (c1x + c2x) - (q0[0] + q3[0])) / 4, (3 * (c1y + c2y) - (q0[1] + q3[1])) / 4], q3]);
  }
}

function contourQuads(contour: Contour, xf: (x: number, y: number) => Point): Quad[] {
  const quads: Quad[] = [];
  let p = xf(contour.x, contour.y);
  for (const s of contour.segs) {
    if (s[0] === "L") {
      const e = xf(s[1], s[2]);
      if (e[0] !== p[0] || e[1] !== p[1]) quads.push([p, [(p[0] + e[0]) / 2, (p[1] + e[1]) / 2], e]);
      p = e;
    } else if (s[0] === "Q") {
      const e = xf(s[3], s[4]);
      quads.push([p, xf(s[1], s[2]), e]);
      p = e;
    } else {
      const e = xf(s[5], s[6]);
      cubicToQuads(p, xf(s[1], s[2]), xf(s[3], s[4]), e, quads);
      p = e;
    }
  }
  return quads;
}

function flatten(quads: Quad[]): Point[] {
  const pts: Point[] = [];
  for (const [a, b, c] of quads) {
    for (let k = 0; k < 4; k++) {
      const t = k / 4;
      const u = 1 - t;
      pts.push([u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]]);
    }
  }
  return pts;
}

function area(pts: Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function inside(pt: Point, poly: Point[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > pt[1] !== b[1] > pt[1] && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

const reverse = (quads: Quad[]): Quad[] => quads.reverse().map(([a, b, c]): Quad => [c, b, a]);

function orient(contours: Quad[][], evenOdd: boolean): Quad[][] {
  const polys = contours.map(flatten);
  const areas = polys.map(area);
  const depth = contours.map((_, i) => {
    const probe = polys[i]![1] ?? polys[i]![0]!;
    let n = 0;
    for (let j = 0; j < polys.length; j++) if (j !== i && inside(probe, polys[j]!)) n++;
    return n;
  });
  if (evenOdd) return contours.map((q, i) => ((depth[i]! % 2 === 0) === areas[i]! > 0 ? q : reverse(q)));
  let outer = 0;
  for (let i = 0; i < contours.length; i++) if (depth[i] === 0) outer += areas[i]!;
  return outer >= 0 ? contours : contours.map(reverse);
}

function bands(curves: Quad[], nb: number): { h: Band[]; v: Band[]; mean: number } {
  const h: Band[] = [];
  const v: Band[] = [];
  let total = 0;
  for (let k = 0; k < nb; k++) {
    const lo = k / nb - 1e-6;
    const hi = (k + 1) / nb + 1e-6;
    const hb: Band = { curves: [], min: [], max: [] };
    const vb: Band = { curves: [], min: [], max: [] };
    for (let i = 0; i < curves.length; i++) {
      const [a, b, c] = curves[i]!;
      const minX = Math.min(a[0], b[0], c[0]);
      const maxX = Math.max(a[0], b[0], c[0]);
      const minY = Math.min(a[1], b[1], c[1]);
      const maxY = Math.max(a[1], b[1], c[1]);
      if (maxY > minY && minY <= hi && maxY >= lo) {
        hb.curves.push(i);
        hb.min.push(minX);
        hb.max.push(maxX);
      }
      if (maxX > minX && minX <= hi && maxX >= lo) {
        vb.curves.push(i);
        vb.min.push(minY);
        vb.max.push(maxY);
      }
    }
    total += hb.curves.length + vb.curves.length;
    h.push(hb);
    v.push(vb);
  }
  return { h, v, mean: total / (2 * nb) };
}

function buildIcon(icon: ParsedIcon): BuiltIcon {
  const raw = icon.paths.map((p) => ({ contours: parsePath(p.d), evenOdd: p.evenOdd, m: p.matrix }));
  let vb = icon.viewBox;
  if (!vb) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of raw) {
      for (const c of r.contours) {
        const pts: Point[] = [[c.x, c.y]];
        for (const s of c.segs) for (let k = 1; k < s.length; k += 2) pts.push([s[k] as number, s[k + 1] as number]);
        for (const [x, y] of pts) {
          const tx = r.m[0] * x + r.m[2] * y + r.m[4];
          const ty = r.m[1] * x + r.m[3] * y + r.m[5];
          minX = Math.min(minX, tx);
          minY = Math.min(minY, ty);
          maxX = Math.max(maxX, tx);
          maxY = Math.max(maxY, ty);
        }
      }
    }
    vb = maxX > minX || maxY > minY ? [minX, minY, Math.max(maxX - minX, 1e-9), Math.max(maxY - minY, 1e-9)] : DEFAULT_VIEWBOX;
  }
  const [vx, vy, vw, vh] = vb;
  if (![vx, vy, vw, vh].every(Number.isFinite) || !(vw > 0) || !(vh > 0)) throw new Error("viewBox must be finite with a positive width and height");
  const s = 1 / Math.max(vw, vh);
  const ox = (1 - vw * s) / 2;
  const oy = (1 - vh * s) / 2;
  const evenOdd = raw.every((r) => r.evenOdd);
  const curves: Quad[] = [];
  for (const r of raw) {
    const m = r.m;
    const xf = (x: number, y: number): Point => [(m[0] * x + m[2] * y + m[4] - vx) * s + ox, (m[1] * x + m[3] * y + m[5] - vy) * s + oy];
    const quads = r.contours.map((c) => contourQuads(c, xf)).filter((q) => q.length > 0);
    for (const q of evenOdd ? quads : orient(quads, r.evenOdd)) curves.push(...q);
  }
  for (const q of curves) for (const p of q) if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error("path data is not finite");
  let best = bands(curves, 1);
  let bestNb = 1;
  const tries = [best];
  for (let nb = 2; nb <= BANDS_MAX && curves.length > 0; nb++) tries.push(bands(curves, nb));
  const lowest = Math.min(...tries.map((t) => t.mean));
  for (let k = 0; k < tries.length; k++) {
    if (tries[k]!.mean <= lowest * BAND_SLACK) {
      best = tries[k]!;
      bestNb = k + 1;
      break;
    }
  }
  return { curves, nb: bestNb, evenOdd, h: best.h, v: best.v };
}

function pack(icons: BuiltIcon[]): IconSet {
  const { ICON_HEADER_WORDS, ICON_RECORD_WORDS, ICON_CURVE_WORDS, ICON_FLAG_EVEN_ODD } = ICON_CONSTANTS;
  let words = ICON_HEADER_WORDS + icons.length * ICON_RECORD_WORDS;
  const bandBase: number[] = [];
  const listBase: number[] = [];
  const curveBase: number[] = [];
  for (const icon of icons) {
    bandBase.push(words);
    words += 4 * icon.nb;
  }
  for (const icon of icons) {
    listBase.push(words);
    for (const b of icon.h) words += 2 * b.curves.length;
    for (const b of icon.v) words += 2 * b.curves.length;
  }
  for (const icon of icons) {
    curveBase.push(words);
    words += ICON_CURVE_WORDS * icon.curves.length;
  }
  const data = new Uint32Array(Math.max(words, 4));
  const f32 = new Float32Array(data.buffer);
  const curves = icons.reduce((n, icon) => n + icon.curves.length, 0);
  data[0] = icons.length;
  data[1] = curveBase[0] ?? words;
  data[2] = curves;
  icons.forEach((icon, n) => {
    const rec = ICON_HEADER_WORDS + n * ICON_RECORD_WORDS;
    data[rec] = bandBase[n]!;
    data[rec + 1] = icon.nb | (icon.evenOdd ? ICON_FLAG_EVEN_ODD : 0);
    data[rec + 2] = curveBase[n]!;
    data[rec + 3] = icon.curves.length;
    let c = curveBase[n]!;
    for (const [a, b, e] of icon.curves) {
      f32[c] = a[0];
      f32[c + 1] = a[1];
      f32[c + 2] = b[0];
      f32[c + 3] = b[1];
      f32[c + 4] = e[0];
      f32[c + 5] = e[1];
      c += ICON_CURVE_WORDS;
    }
    let list = listBase[n]!;
    let band = bandBase[n]!;
    for (const b of [...icon.h, ...icon.v]) {
      const count = b.curves.length;
      data[band] = list;
      data[band + 1] = count;
      band += 2;
      const order = b.curves.map((_, k) => k);
      const plus = [...order].sort((p, q) => b.max[q]! - b.max[p]!);
      const minus = [...order].sort((p, q) => b.min[p]! - b.min[q]!);
      for (const k of plus) data[list++] = curveBase[n]! + b.curves[k]! * ICON_CURVE_WORDS;
      for (const k of minus) data[list++] = curveBase[n]! + b.curves[k]! * ICON_CURVE_WORDS;
    }
  });
  return { data, count: icons.length, curves, maxCurves: icons.reduce((n, icon) => Math.max(n, icon.curves.length), 0) };
}
