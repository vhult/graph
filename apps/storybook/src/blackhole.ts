import { rng, type GraphDataset } from "@vhult/graph-bench";
import { kelvin, word } from "./galaxy";

export const HOLE = {
  inner: 6,
  outer: 22,
  starRadius: 200,
  starCone: 0.22,
  viewX: 36,
  viewY: 22,
  rows: 240,
  samples: 512,
  scale: 30,
  orbit: 23,
  starShare: 0.12,
  ringShare: 0.25,
  falloff: 30,
} as const;

const CRITICAL = 3 * Math.sqrt(3);
const TAU = Math.PI * 2;

export interface BlackHole {
  graph: GraphDataset;
  data: Float32Array;
  tableOffset: number;
}

function periastron(b: number): number {
  return ((2 * b) / Math.sqrt(3)) * Math.cos(Math.acos(-CRITICAL / b) / 3);
}

function sweep(b: number, top: number): number {
  if (b === 0) return 0;
  const n = 96;
  const ib2 = 1 / (b * b);
  let s = 0;
  for (let j = 0; j < n; j++) {
    const v = (j + 0.5) / n;
    const u = top * (1 - v * v);
    s += (2 * top * v) / Math.sqrt(Math.max(ib2 - u * u + 2 * u * u * u, 1e-300));
  }
  return s / n;
}

function row(r: number, out: Float32Array, at: number): void {
  const n = HOLE.samples;
  const half = n / 2;
  const u = 1 / r;
  const bmax = Math.sqrt((r * r * r) / (r - 2));
  let last = -Infinity;
  const put = (j: number, psi: number, b: number) => {
    last = Math.max(psi, last + 1e-6);
    out[at + j * 2] = last;
    out[at + j * 2 + 1] = b;
  };
  for (let j = 0; j < half; j++) {
    const b = bmax * Math.sin(((j / (half - 1)) * Math.PI) / 2);
    put(j, sweep(b, u), b);
  }
  for (let j = 0; j < half; j++) {
    const b = CRITICAL + (bmax - CRITICAL) * Math.exp(-HOLE.falloff * ((j + 1) / half));
    put(half + j, 2 * sweep(b, 1 / periastron(b)) - sweep(b, u), b);
  }
}

export function lensTable(): Float32Array {
  const h = HOLE;
  const t = new Float32Array((h.rows + 1) * h.samples * 2);
  for (let k = 0; k < h.rows; k++) row(h.inner * Math.pow(h.outer / h.inner, k / (h.rows - 1)), t, k * h.samples * 2);
  row(h.starRadius, t, h.rows * h.samples * 2);
  return t;
}

export const HOLE_WGSL = `
const TAU : f32 = 6.28318531;

fn rowB(r : u32, psi : f32) -> f32 {
  let n = u32(param(3u));
  let base = u32(param(2u)) + r * n * 2u;
  if (psi <= data[base]) {
    return data[base + 1u];
  }
  var lo = 0u;
  var hi = n - 1u;
  if (psi >= data[base + hi * 2u]) {
    return data[base + hi * 2u + 1u];
  }
  loop {
    if (hi - lo <= 1u) {
      break;
    }
    let mid = (lo + hi) / 2u;
    if (data[base + mid * 2u] <= psi) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  let p0 = data[base + lo * 2u];
  let p1 = data[base + hi * 2u];
  let f = clamp((psi - p0) / max(p1 - p0, 1e-9), 0.0, 1.0);
  return mix(data[base + lo * 2u + 1u], data[base + hi * 2u + 1u], f);
}

fn nodePosition(i : u32, t : f32) -> vec2<f32> {
  let a = data[i * 4u];
  let angle = data[i * 4u + 1u];
  let k = u32(data[i * 4u + 2u]);
  let star = data[i * 4u + 3u] > 0.5;
  let tilt = param(0u);
  let o = vec3<f32>(sin(tilt), 0.0, cos(tilt));
  let e1 = vec3<f32>(0.0, 1.0, 0.0);
  let e2 = vec3<f32>(-cos(tilt), 0.0, sin(tilt));
  let rows = u32(param(4u));
  var p : vec3<f32>;
  var rowF : f32;
  if (star) {
    p = -o * cos(a) + sin(a) * (cos(angle) * e1 + sin(angle) * e2);
    rowF = f32(rows);
  } else {
    let phi = angle + t * param(1u) * pow(a, -1.5);
    p = vec3<f32>(cos(phi), sin(phi), 0.0);
    rowF = log(a / param(5u)) / log(param(6u) / param(5u)) * f32(rows - 1u);
  }
  let gamma = acos(clamp(dot(o, p), -1.0, 1.0));
  var d = vec2<f32>(dot(p, e1), dot(p, e2));
  let dl = length(d);
  d = select(vec2<f32>(1.0, 0.0), d / dl, dl > 1e-6);
  var psi = gamma;
  if (k == 1u) {
    psi = TAU - gamma;
    d = -d;
  } else if (k == 2u) {
    psi = TAU + gamma;
  }
  let r0 = u32(clamp(floor(rowF), 0.0, f32(rows)));
  let r1 = min(r0 + 1u, select(rows - 1u, rows, star));
  let b = mix(rowB(r0, psi), rowB(r1, psi), fract(rowF));
  return d * b * param(7u);
}
`;

function rowB(table: Float32Array, r: number, psi: number): number {
  const n = HOLE.samples;
  const base = r * n * 2;
  if (psi <= table[base]!) return table[base + 1]!;
  let lo = 0;
  let hi = n - 1;
  if (psi >= table[base + hi * 2]!) return table[base + hi * 2 + 1]!;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[base + mid * 2]! <= psi) lo = mid;
    else hi = mid;
  }
  const p0 = table[base + lo * 2]!;
  const p1 = table[base + hi * 2]!;
  const f = Math.min(1, Math.max(0, (psi - p0) / Math.max(p1 - p0, 1e-9)));
  return table[base + lo * 2 + 1]! + (table[base + hi * 2 + 1]! - table[base + lo * 2 + 1]!) * f;
}

export function place(table: Float32Array, a: number, angle: number, k: number, star: boolean, tilt: number): [number, number] {
  const h = HOLE;
  const o = [Math.sin(tilt), 0, Math.cos(tilt)];
  const e2 = [-Math.cos(tilt), 0, Math.sin(tilt)];
  let p: number[];
  let rowF: number;
  if (star) {
    const s = Math.sin(a);
    p = [-o[0]! * Math.cos(a) + s * Math.sin(angle) * e2[0]!, s * Math.cos(angle), -o[2]! * Math.cos(a) + s * Math.sin(angle) * e2[2]!];
    rowF = h.rows;
  } else {
    p = [Math.cos(angle), Math.sin(angle), 0];
    rowF = (Math.log(a / h.inner) / Math.log(h.outer / h.inner)) * (h.rows - 1);
  }
  const gamma = Math.acos(Math.max(-1, Math.min(1, o[0]! * p[0]! + o[2]! * p[2]!)));
  let dx = p[1]!;
  let dy = p[0]! * e2[0]! + p[2]! * e2[2]!;
  const dl = Math.hypot(dx, dy);
  if (dl > 1e-6) {
    dx /= dl;
    dy /= dl;
  } else {
    dx = 1;
    dy = 0;
  }
  let psi = gamma;
  if (k === 1) {
    psi = TAU - gamma;
    dx = -dx;
    dy = -dy;
  } else if (k === 2) psi = TAU + gamma;
  const r0 = Math.max(0, Math.min(h.rows, Math.floor(rowF)));
  const r1 = Math.min(r0 + 1, star ? h.rows : h.rows - 1);
  const w = rowF - Math.floor(rowF);
  const b = rowB(table, r0, psi) * (1 - w) + rowB(table, r1, psi) * w;
  return [dx * b * h.scale, dy * b * h.scale];
}

export function holeParams(tiltDeg: number, tableOffset: number): number[] {
  const h = HOLE;
  return [(tiltDeg * Math.PI) / 180, h.orbit, tableOffset, h.samples, h.rows, h.inner, h.outer, h.scale];
}

function diskRadius(r: () => number): number {
  const h = HOLE;
  for (;;) {
    const x = h.inner + (h.outer - h.inner) * Math.pow(r(), 1.4);
    const streak = 0.55 + 0.45 * Math.sin(x * 7.3) * Math.sin(x * 2.1 + 1.3);
    if (r() < streak) return x;
  }
}

export function blackHole(total: number, tiltDeg: number, seed = 1): BlackHole {
  const h = HOLE;
  const r = rng(seed);
  const starImages = Math.round(total * h.starShare);
  const disk = Math.floor((total - starImages) / (2 + h.ringShare));
  const rings = Math.floor(disk * h.ringShare);
  const count = starImages + disk * 2 + rings;
  const table = lensTable();
  const tableOffset = count * 4;
  const data = new Float32Array(tableOffset + table.length);
  data.set(table, tableOffset);
  const positions = new Float32Array(count * 2);
  const colors = new Uint32Array(count);
  const sizes = new Float32Array(count);
  const tilt = (tiltDeg * Math.PI) / 180;
  const peak = Math.pow(h.inner * 1.36, -0.75) * Math.pow(1 - Math.sqrt(6 / (h.inner * 1.36)), 0.25);
  let n = 0;
  const inView = (x: number, y: number) => Math.abs(x) <= h.viewX * h.scale && Math.abs(y) <= h.viewY * h.scale;
  const add = (a: number, angle: number, k: number, star: boolean, color: number, size: number) => {
    const [x, y] = place(table, a, angle, k, star, tilt);
    if (star && !inView(x, y)) return;
    data[n * 4] = a;
    data[n * 4 + 1] = angle;
    data[n * 4 + 2] = k;
    data[n * 4 + 3] = star ? 1 : 0;
    positions[n * 2] = x;
    positions[n * 2 + 1] = y;
    colors[n] = color;
    sizes[n] = size;
    n++;
  };
  for (let i = 0; i < disk; i++) {
    const a = diskRadius(r);
    const phi = r() * TAU;
    const heat = Math.min(1, (Math.pow(a, -0.75) * Math.pow(1 - Math.sqrt(6 / a), 0.25)) / peak);
    const rgb = kelvin(1700 + 4300 * heat * (0.8 + 0.2 * r()));
    const alpha = 0.1 + 0.28 * heat;
    const size = 1 + 1.2 * r();
    add(a, phi, 0, false, word(rgb, alpha), size);
    add(a, phi, 1, false, word(rgb, alpha * 0.8), size * 0.9);
    if (i < rings) add(a, phi, 2, false, word(rgb, alpha * 0.7), 0.8);
  }
  const star = (eps: number, k: number) => {
    const beta = r() * TAU;
    const rgb = kelvin(4000 + 9000 * r());
    const alpha = (0.35 + 0.55 * Math.pow(r(), 2)) * (k === 1 ? 0.75 : 1);
    add(eps, beta, k, true, word(rgb, alpha), 1 + 2.2 * Math.pow(r(), 4));
  };
  const first = n;
  while (n - first < starImages - 1) {
    const eps = Math.acos(1 - 2 * r());
    if (r() * (1 + (eps / h.starCone) ** 2) > 1) continue;
    star(eps, 0);
    star(eps, 1);
  }
  return {
    graph: {
      nodes: { count: n, positions: positions.slice(0, n * 2), colors: colors.slice(0, n), sizes: sizes.slice(0, n) },
      edges: { count: 0, indices: new Uint32Array(0) },
    },
    data,
    tableOffset,
  };
}
