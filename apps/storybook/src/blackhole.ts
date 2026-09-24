import { rng, type GraphDataset } from "@vhult/graph-bench";

export const HOLE = {
  inner: 5,
  outer: 24,
  body: 11,
  wispShare: 0.1,
  frame: 28,
  tilt: 89,
  rows: 240,
  samples: 512,
  scale: 30,
  orbit: 12,
  ringShare: 0.1,
  clumpShare: 0.7,
  clumpWidth: 0.25,
  clumpLength: 0.06,
  shearTime: 30,
  falloff: 30,
} as const;

const CRITICAL = 3 * Math.sqrt(3);
const TAU = Math.PI * 2;

const HOT: [number, number, number] = [255, 255, 255];
const WARM: [number, number, number] = [255, 232, 226];
const COOL: [number, number, number] = [238, 176, 164];

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
  const t = new Float32Array(h.rows * h.samples * 2);
  for (let k = 0; k < h.rows; k++) row(h.inner * Math.pow(h.outer / h.inner, k / (h.rows - 1)), t, k * h.samples * 2);
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
  let a = data[i * 3u];
  let phi = data[i * 3u + 1u] + t * param(1u) * pow(a, -1.5);
  let k = u32(data[i * 3u + 2u]);
  let tilt = param(0u);
  let o = vec3<f32>(sin(tilt), 0.0, cos(tilt));
  let e2 = vec3<f32>(-cos(tilt), 0.0, sin(tilt));
  let p = vec3<f32>(cos(phi), sin(phi), 0.0);
  let rows = u32(param(4u));
  let rowF = log(a / param(5u)) / log(param(6u) / param(5u)) * f32(rows - 1u);
  let gamma = acos(clamp(dot(o, p), -1.0, 1.0));
  var d = vec2<f32>(p.y, dot(p, e2));
  let dl = length(d);
  d = select(vec2<f32>(1.0, 0.0), d / dl, dl > 1e-6);
  var psi = gamma;
  if (k == 1u) {
    psi = TAU - gamma;
    d = -d;
  } else if (k == 2u) {
    psi = TAU + gamma;
  }
  let r0 = u32(clamp(floor(rowF), 0.0, f32(rows - 1u)));
  let r1 = min(r0 + 1u, rows - 1u);
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

export function place(table: Float32Array, a: number, phi: number, k: number, tilt: number): [number, number] {
  const h = HOLE;
  const px = Math.cos(phi);
  const py = Math.sin(phi);
  const gamma = Math.acos(Math.max(-1, Math.min(1, Math.sin(tilt) * px)));
  let dx = py;
  let dy = -Math.cos(tilt) * px;
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
  const rowF = (Math.log(a / h.inner) / Math.log(h.outer / h.inner)) * (h.rows - 1);
  const r0 = Math.max(0, Math.min(h.rows - 1, Math.floor(rowF)));
  const r1 = Math.min(r0 + 1, h.rows - 1);
  const w = rowF - Math.floor(rowF);
  const b = rowB(table, r0, psi) * (1 - w) + rowB(table, r1, psi) * w;
  return [dx * b * h.scale, dy * b * h.scale];
}

export function holeParams(tiltDeg: number, tableOffset: number): number[] {
  const h = HOLE;
  return [(tiltDeg * Math.PI) / 180, h.orbit, tableOffset, h.samples, h.rows, h.inner, h.outer, h.scale];
}

function mix(a: [number, number, number], b: [number, number, number], f: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function word(rgb: [number, number, number], alpha: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (c(rgb[0]) | (c(rgb[1]) << 8) | (c(rgb[2]) << 16) | (c(alpha * 255) << 24)) >>> 0;
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(TAU * r());
}

export function blackHole(total: number, tiltDeg: number, seed = 1): BlackHole {
  const h = HOLE;
  const r = rng(seed);
  const disk = Math.floor(total / (2 + h.ringShare));
  const rings = Math.floor(disk * h.ringShare);
  const count = disk * 2 + rings;
  const table = lensTable();
  const tableOffset = count * 3;
  const data = new Float32Array(tableOffset + table.length);
  data.set(table, tableOffset);
  const positions = new Float32Array(count * 2);
  const colors = new Uint32Array(count);
  const sizes = new Float32Array(count);
  const tilt = (tiltDeg * Math.PI) / 180;
  const span = h.outer - h.inner;
  let n = 0;
  const add = (a: number, phi: number, k: number, color: number, size: number) => {
    data[n * 3] = a;
    data[n * 3 + 1] = phi;
    data[n * 3 + 2] = k;
    const [x, y] = place(table, a, phi, k, tilt);
    positions[n * 2] = x;
    positions[n * 2 + 1] = y;
    colors[n] = color;
    sizes[n] = size;
    n++;
  };
  const radius = () =>
    r() < h.wispShare ? h.body + (h.outer - h.body) * Math.pow(r(), 1.5) : h.inner + (h.body - h.inner) * Math.pow(r(), 1.6);
  let clumpR = 0;
  let clumpPhi = 0;
  let clumpLeft = 0;
  for (let i = 0; i < disk; i++) {
    let a: number;
    let phi: number;
    if (r() < h.clumpShare) {
      if (clumpLeft-- <= 0) {
        clumpR = radius();
        clumpPhi = r() * TAU;
        clumpLeft = 20 + Math.floor(r() * 200);
      }
      a = Math.min(h.outer, Math.max(h.inner, clumpR + gauss(r) * h.clumpWidth));
      phi = clumpPhi + gauss(r) * h.clumpLength + h.shearTime * h.orbit * Math.pow(a, -1.5);
    } else {
      a = radius();
      phi = r() * TAU;
    }
    const f = (a - h.inner) / span;
    const heat = Math.pow(Math.max(0, 1 - (a - h.inner) / (h.body - h.inner)), 1.6) * 0.9 + 0.1 * (1 - f);
    const rgb = f < 0.25 ? mix(HOT, WARM, f / 0.25) : mix(WARM, COOL, Math.min(1, (f - 0.25) / 0.75));
    const alpha = 0.015 + 0.2 * heat;
    const size = 3 + 2.5 * r();
    add(a, phi, 0, word(rgb, alpha), size);
    add(a, phi, 1, word(rgb, alpha * 0.9), size);
    if (i < rings) add(a, phi, 2, word(HOT, 0.2), 1.4);
  }
  return {
    graph: { nodes: { count: n, positions, colors, sizes }, edges: { count: 0, indices: new Uint32Array(0) } },
    data,
    tableOffset,
  };
}
