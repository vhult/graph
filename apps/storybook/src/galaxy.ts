import { rng, type GraphDataset } from "@vhult/graph-bench";

export const GALAXY = {
  radius: 1000,
  reach: 1.6,
  core: 110,
  bulgeScale: 120,
  diskScale: 330,
  bulgeShare: 0.1,
  youngShare: 0.12,
  knotShare: 0.03,
  knotSize: 12,
  dip: 0.24,
  dipAt: 0.55,
  twist: 5.5,
  edge: 0.18,
  glow: 0.3,
  speed: -35,
  patternSpeed: -0.05,
  armContrast: 1.3,
  armSpread: 0.03,
} as const;

export interface Galaxy {
  graph: GraphDataset;
  orbits: Float32Array;
}

const WORDS = 5;

export const GALAXY_WGSL = `
fn nodePosition(i : u32, t : f32) -> vec2<f32> {
  let a = data[i * ${WORDS}u];
  let b = data[i * ${WORDS}u + 1u];
  let tilt = data[i * ${WORDS}u + 2u] + param(0u) * t;
  let th = data[i * ${WORDS}u + 3u] + data[i * ${WORDS}u + 4u] * t;
  let e = vec2<f32>(a * cos(th), b * sin(th));
  let c = cos(tilt);
  let s = sin(tilt);
  return vec2<f32>(c * e.x - s * e.y, s * e.x + c * e.y);
}
`;

export const GALAXY_PARAMS = [GALAXY.patternSpeed];

const TAU = Math.PI * 2;
const PINK: [number, number, number] = [255, 105, 170];
const ROSE: [number, number, number] = [255, 150, 195];

export function kelvin(t: number): [number, number, number] {
  const k = t / 100;
  const r = k <= 66 ? 255 : 329.698727446 * Math.pow(k - 60, -0.1332047592);
  const g = k <= 66 ? 99.4708025861 * Math.log(k) - 161.1195681661 : 288.1221695283 * Math.pow(k - 60, -0.0755148492);
  const b = k >= 66 ? 255 : k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [c(r), c(g), c(b)];
}

export function word(rgb: [number, number, number], alpha: number): number {
  return (rgb[0] | (rgb[1] << 8) | (rgb[2] << 16) | (Math.round(Math.min(1, alpha) * 255) << 24)) >>> 0;
}

const ratio = (a: number): number => {
  const x = a / (GALAXY.dipAt * GALAXY.radius);
  return 1 - GALAXY.dip * x * x * Math.exp(1 - x * x);
};

const tiltAt = (a: number): number => (GALAXY.twist * a) / GALAXY.radius;

const spin = (a: number): number => (GALAXY.speed * (1 - Math.exp(-a / GALAXY.core))) / Math.max(a, 1e-3);

const fade = (a: number): number => {
  const inner = 0.3 + 0.7 * Math.min(1, a / (GALAXY.glow * GALAXY.radius)) ** 1.5;
  return a <= GALAXY.radius ? inner : Math.exp(-(a - GALAXY.radius) / (GALAXY.edge * GALAXY.radius));
};

const smooth = (lo: number, hi: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

const truncatedExp = (u: number, scale: number, max: number): number => -scale * Math.log(1 - u * (1 - Math.exp(-max / scale)));

class Stars {
  readonly positions: Float32Array;
  readonly colors: Uint32Array;
  readonly sizes: Float32Array;
  readonly orbits: Float32Array;
  n = 0;

  constructor(readonly count: number) {
    this.positions = new Float32Array(count * 2);
    this.colors = new Uint32Array(count);
    this.sizes = new Float32Array(count);
    this.orbits = new Float32Array(count * WORDS);
  }

  add(a: number, th: number, locked: boolean, color: number, size: number): void {
    const i = this.n++;
    const b = a * ratio(a);
    const tilt = tiltAt(a);
    const o = i * WORDS;
    this.orbits[o] = a;
    this.orbits[o + 1] = b;
    this.orbits[o + 2] = tilt;
    this.orbits[o + 3] = th;
    this.orbits[o + 4] = locked ? 0 : spin(a);
    const [x, y] = place(a, b, tilt, th);
    this.positions[i * 2] = x;
    this.positions[i * 2 + 1] = y;
    this.colors[i] = color;
    this.sizes[i] = size;
  }
}

function place(a: number, b: number, tilt: number, th: number): [number, number] {
  const ex = a * Math.cos(th);
  const ey = b * Math.sin(th);
  const c = Math.cos(tilt);
  const s = Math.sin(tilt);
  return [c * ex - s * ey, s * ex + c * ey];
}

class Density {
  private readonly cells: Float32Array;
  private readonly rings: Float32Array;
  private readonly side: number;
  private readonly half: number;

  constructor(stars: Stars, from: number, to: number) {
    const side = Math.round(Math.min(384, Math.max(96, Math.sqrt(stars.count) * 0.36)));
    this.side = side;
    this.half = GALAXY.reach * GALAXY.radius;
    const raw = new Float32Array(side * side);
    for (let i = from; i < to; i++) {
      const c = this.cell(stars.positions[i * 2]!, stars.positions[i * 2 + 1]!);
      if (c >= 0) raw[c]!++;
    }
    this.cells = new Float32Array(side * side);
    for (let y = 1; y < side - 1; y++) {
      for (let x = 1; x < side - 1; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += raw[(y + dy) * side + x + dx]!;
        this.cells[y * side + x] = sum / 9;
      }
    }
    const bins = side / 2;
    const total = new Float32Array(bins);
    const hits = new Float32Array(bins);
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const k = this.ring(x, y);
        if (k >= bins) continue;
        total[k]! += this.cells[y * side + x]!;
        hits[k]!++;
      }
    }
    this.rings = total.map((t, k) => (hits[k]! > 0 ? t / hits[k]! : 0));
  }

  contrast(px: number, py: number): number {
    const c = this.cell(px, py);
    if (c < 0) return 0;
    const mean = this.rings[this.ring(c % this.side, Math.floor(c / this.side))] ?? 0;
    return mean > 0 ? this.cells[c]! / mean : 0;
  }

  private cell(px: number, py: number): number {
    const x = Math.floor(((px + this.half) / (2 * this.half)) * this.side);
    const y = Math.floor(((py + this.half) / (2 * this.half)) * this.side);
    return x < 0 || y < 0 || x >= this.side || y >= this.side ? -1 : y * this.side + x;
  }

  private ring(x: number, y: number): number {
    return Math.floor(Math.hypot(x + 0.5 - this.side / 2, y + 0.5 - this.side / 2));
  }
}

export function galaxy(count: number, seed = 1): Galaxy {
  const g = GALAXY;
  const R = g.radius;
  const r = rng(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(TAU * r());
  const stars = new Stars(count);
  const lift = Math.sqrt(1_000_000 / Math.max(1, count));
  const tone = (rgb: [number, number, number], alpha: number) => word(rgb, alpha * lift);

  const knots = Math.floor((count * g.knotShare) / g.knotSize);
  const young = Math.floor(count * g.youngShare);
  const bulge = Math.floor(count * g.bulgeShare);
  const disk = count - bulge - young - knots * g.knotSize;

  for (let k = 0; k < disk; k++) {
    const a = truncatedExp(r(), g.diskScale, g.reach * R);
    const f = Math.min(1, a / R);
    const temp = 4300 + 2600 * Math.pow(f, 0.7) * r() + 900 * r();
    const alpha = (0.14 + 0.14 * r()) * fade(a);
    stars.add(a, r() * TAU, false, tone(kelvin(temp), alpha), 0.8 + 0.8 * r());
  }
  const density = new Density(stars, 0, disk);

  for (let k = 0; k < bulge; k++) {
    const a = truncatedExp(r(), g.bulgeScale, 0.8 * R);
    const alpha = (0.2 + 0.3 * Math.exp(-a / g.core) * r()) * fade(a);
    stars.add(a, r() * TAU, false, tone(kelvin(4300 + 1900 * r()), alpha), 1 + 0.8 * r());
  }

  const seeds: number[] = [];
  for (let k = 0, tries = 0; k < young && tries < young * 400; tries++) {
    const a = truncatedExp(r(), g.diskScale, 1.2 * R);
    if (r() > smooth(0.08 * R, 0.35 * R, a)) continue;
    const th = r() * TAU;
    const [x, y] = place(a, a * ratio(a), tiltAt(a), th);
    const c = density.contrast(x, y) / g.armContrast;
    if (r() > c * c) continue;
    const at = a * (1 + normal() * g.armSpread);
    if (seeds.length < knots * 2 && r() < (knots * 4) / young) seeds.push(at, th);
    const alpha = (0.35 + 0.4 * r()) * fade(at);
    stars.add(at, th, true, tone(kelvin(9000 + 21000 * r()), alpha), 1.2 + 1.8 * Math.pow(r(), 2));
    k++;
  }

  for (let k = 0; k * 2 < seeds.length && stars.n + g.knotSize <= count; k++) {
    const a0 = seeds[k * 2]!;
    const th0 = seeds[k * 2 + 1]!;
    for (let j = 0; j < g.knotSize; j++) {
      const a = a0 + normal() * 0.006 * R;
      const th = th0 + (normal() * 0.006 * R) / Math.max(a0, 1);
      const alpha = (0.35 + 0.3 * r()) * fade(a);
      stars.add(a, th, true, tone(r() < 0.7 ? PINK : ROSE, alpha), 1.4 + 1.8 * r());
    }
  }

  while (stars.n < count) {
    const a = truncatedExp(r(), g.diskScale, g.reach * R);
    stars.add(a, r() * TAU, false, tone(kelvin(5200 + 1500 * r()), 0.12 * fade(a)), 0.8 + 0.8 * r());
  }

  return {
    graph: {
      nodes: { count, positions: stars.positions, colors: stars.colors, sizes: stars.sizes },
      edges: { count: 0, indices: new Uint32Array(0) },
    },
    orbits: stars.orbits,
  };
}
