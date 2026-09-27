import { SPACING, hslToWord, noise2, rng } from "./datasets";
import { mortonOrder, nearestPairs, type GraphDataset } from "./graphs";

export const COSMIC = {
  perKnot: 2500,
  sparse: 3,
  cluster: 0.2,
  filament: 0.6,
  wall: 0.14,
  links: 4,
  reach: 3.8,
  keep: 0.5,
  tendrils: 2,
  width: 0.02,
  bend: 0.25,
  core: 0.035,
  friends: 2,
  maxLink: 5,
};

export function cosmicWeb(count: number, seed = 1): GraphDataset {
  const C = COSMIC;
  const n = Math.max(1, Math.floor(count));
  const r = rng(seed);
  const noise = noise2(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

  const width = Math.sqrt((n * SPACING * SPACING * C.sparse * 16) / 9);
  const height = (width * 9) / 16;
  const cols = Math.max(2, Math.round(Math.sqrt(((n / C.perKnot) * 16) / 9) * 2));
  const rows = Math.max(2, Math.round((cols * 9) / 16));
  const cell = width / cols;
  const slot = new Int32Array(cols * rows).fill(-1);
  const xs: number[] = [];
  const ys: number[] = [];
  const ms: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5 + (r() - 0.5) * 0.9) * cell - width / 2;
      const y = (j + 0.5 + (r() - 0.5) * 0.9) * cell - height / 2;
      const ex = (2 * x) / width;
      const ey = (2 * y) / height;
      const edge = 1 - Math.max(0, Math.hypot(ex, ey * 0.9) - 0.75 + 0.15 * noise(ex * 3 + 9, ey * 3)) / 0.25;
      const dense = Math.pow(0.5 + 0.5 * noise(x / (cell * 6) + 3.7, y / (cell * 6) - 1.3), 2) * 2.2 * Math.max(0, edge);
      if (r() > Math.min(1, dense) * C.keep) continue;
      slot[j * cols + i] = xs.length;
      xs.push(x);
      ys.push(y);
      ms.push(Math.min(60, Math.pow(1 - r(), -1 / 1.1)));
    }
  }
  if (xs.length === 0) {
    slot[Math.floor(rows / 2) * cols + Math.floor(cols / 2)] = 0;
    xs.push(0);
    ys.push(0);
    ms.push(1);
  }
  const knots = xs.length;
  const kx = xs;
  const ky = ys;
  const mass = ms;

  const fa: number[] = [];
  const fb: number[] = [];
  const seen = new Set<number>();
  const near: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = slot[j * cols + i]!;
      if (k < 0) continue;
      near.length = 0;
      for (let dj = -4; dj <= 4; dj++) {
        for (let di = -4; di <= 4; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
          const o = slot[jj * cols + ii]!;
          if (o >= 0 && o !== k) near.push(o);
        }
      }
      const d = (o: number) => Math.hypot(kx[o]! - kx[k]!, ky[o]! - ky[k]!);
      near.sort((a, b) => d(a) - d(b));
      for (let s = 0; s < Math.min(C.links, near.length); s++) {
        const o = near[s]!;
        if (d(o) > C.reach * cell) break;
        const key = Math.min(k, o) * knots + Math.max(k, o);
        if (seen.has(key)) continue;
        seen.add(key);
        fa.push(k);
        fb.push(o);
      }
    }
  }
  for (let k = 0; k < knots; k++) {
    const tendrils = Math.floor(r() * C.tendrils);
    for (let q = 0; q < tendrils; q++) {
      const a = r() * Math.PI * 2;
      const len = cell * (0.9 + 1.2 * r());
      fa.push(k);
      fb.push(kx.length);
      kx.push(kx[k]! + Math.cos(a) * len);
      ky.push(ky[k]! + Math.sin(a) * len);
      mass.push(0.2);
    }
  }
  const filaments = fa.length;
  const cx = new Float64Array(filaments);
  const cy = new Float64Array(filaments);
  const thick = new Float64Array(filaments);
  const weight = new Float64Array(filaments);
  const strength = new Float64Array(filaments);
  let weightSum = 0;
  for (let f = 0; f < filaments; f++) {
    const a = fa[f]!;
    const b = fb[f]!;
    const dx = kx[b]! - kx[a]!;
    const dy = ky[b]! - ky[a]!;
    const len = Math.hypot(dx, dy);
    const bend = (r() - 0.5) * C.bend * len;
    cx[f] = (kx[a]! + kx[b]!) / 2 - (dy / len) * bend;
    cy[f] = (ky[a]! + ky[b]!) / 2 + (dx / len) * bend;
    const pair = mass[a]! * mass[b]!;
    thick[f] = cell * C.width * Math.pow(pair, 0.3);
    weight[f] = len * Math.pow(pair, 0.5);
    strength[f] = Math.min(1, Math.max(0, Math.log(pair) / Math.log(400)));
    weightSum += weight[f]!;
  }

  const positions = new Float32Array(n * 2);
  const colors = new Uint32Array(n);
  const sizes = new Float32Array(n);
  let v = 0;
  const linked = new Uint8Array(n);
  const put = (x: number, y: number, color: number, size: number, link = 1) => {
    linked[v] = link;
    positions[v * 2] = x;
    positions[v * 2 + 1] = y;
    colors[v] = color;
    sizes[v] = r() < 0.01 ? size * 2 : size;
    v++;
  };

  const clusterCount = Math.floor(n * C.cluster);
  const filamentCount = filaments > 0 ? Math.floor(n * C.filament) : 0;
  const wallCount = filaments > 0 ? Math.floor(n * C.wall) : 0;
  let massSum = 0;
  for (let k = 0; k < knots; k++) massSum += mass[k]!;
  for (let k = 0; k < knots && v < clusterCount; k++) {
    const members = k === knots - 1 ? clusterCount - v : Math.min(clusterCount - v, Math.round((clusterCount * mass[k]!) / massSum));
    const sigma = cell * C.core * Math.cbrt(mass[k]!);
    for (let q = 0; q < members; q++) {
      const ox = normal() * sigma;
      const oy = normal() * sigma;
      const t = Math.min(1, Math.hypot(ox, oy) / (2.5 * sigma));
      put(kx[k]! + ox, ky[k]! + oy, hslToWord(0.11 - 0.07 * t, 0.9, 0.88 - 0.3 * t, 1), 1.4 + 1.6 * Math.pow(r(), 3) * (1 - t));
    }
  }

  const bezier = (f: number, t: number, spread: number) => {
    const a = fa[f]!;
    const b = fb[f]!;
    const u = 1 - t;
    const x = u * u * kx[a]! + 2 * u * t * cx[f]! + t * t * kx[b]!;
    const y = u * u * ky[a]! + 2 * u * t * cy[f]! + t * t * ky[b]!;
    const tx = 2 * u * (cx[f]! - kx[a]!) + 2 * t * (kx[b]! - cx[f]!);
    const ty = 2 * u * (cy[f]! - ky[a]!) + 2 * t * (ky[b]! - cy[f]!);
    const tl = Math.hypot(tx, ty) || 1;
    const off = normal() * spread;
    return [x - (ty / tl) * off, y + (tx / tl) * off] as const;
  };

  const filamentEnd = v + filamentCount;
  for (let f = 0; f < filaments && v < filamentEnd; f++) {
    const members = f === filaments - 1 ? filamentEnd - v : Math.min(filamentEnd - v, Math.round((filamentCount * weight[f]!) / weightSum));
    for (let q = 0; q < members; q++) {
      let t = r();
      for (let tries = 0; tries < 8; tries++) {
        const ends = 1 - 4 * t * (1 - t);
        const keep = (0.3 + 0.7 * (0.5 + 0.5 * noise(f * 7.31, t * 5))) * (0.4 + 0.6 * ends);
        if (r() < keep) break;
        t = r();
      }
      const ends = 1 - 4 * t * (1 - t);
      const [x, y] = bezier(f, t, thick[f]! * (0.6 + 1.2 * ends));
      const g = strength[f]!;
      put(x, y, hslToWord(0.68 + 0.25 * Math.max(ends, g * 0.6), 0.85, 0.5 + 0.2 * g + 0.12 * ends, 0.7 + 0.3 * Math.max(g, ends)), 1.3 + 1.4 * Math.pow(r(), 4) + 0.5 * g);
    }
  }

  const wallEnd = v + wallCount;
  while (v < wallEnd) {
    const f = Math.floor(r() * filaments);
    const [x, y] = bezier(f, r(), thick[f]! * 7);
    put(x, y, hslToWord(0.66, 0.7, 0.5, 0.6), 1.1, 0);
  }
  while (v < n) {
    const k = Math.floor(r() * knots);
    const a = r() * Math.PI * 2;
    const d = cell * 3 * Math.sqrt(r());
    put(kx[k]! + Math.cos(a) * d, ky[k]! + Math.sin(a) * d, hslToWord(0.66, 0.5, 0.4, 0.4), 1, 0);
  }

  const nodes = { count: n, positions, colors, sizes };
  const friends = nearestPairs(nodes, [mortonOrder(nodes), mortonOrder(nodes, 1 / 3)], C.friends);
  const limit = (SPACING * C.maxLink) ** 2;
  const indices = new Uint32Array(friends.count * 2);
  let e = 0;
  for (let k = 0; k < friends.count; k++) {
    const a = friends.indices[k * 2]!;
    const b = friends.indices[k * 2 + 1]!;
    const dx = positions[a * 2]! - positions[b * 2]!;
    const dy = positions[a * 2 + 1]! - positions[b * 2 + 1]!;
    if (dx * dx + dy * dy > limit || !linked[a] || !linked[b]) continue;
    indices[e++] = a;
    indices[e++] = b;
  }
  return { nodes, edges: { count: e / 2, indices: indices.slice(0, e) } };
}
