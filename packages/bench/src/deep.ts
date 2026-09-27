import { SPACING, hslToWord, rng } from "./datasets";
import { mortonOrder, nearestPairs, type GraphDataset } from "./graphs";

export const DEEP = {
  perGalaxy: 330,
  sky: 7,
  stars: 0.025,
  starCount: 14,
  alpha: 0.95,
  maxShare: 0.03,
  spread: 1.05,
  clusters: 20,
  clustered: 0.4,
  tails: 0.1,
  friends: 2,
  maxLink: 2.5,
};

export function deepField(count: number, seed = 1): GraphDataset {
  const D = DEEP;
  const n = Math.max(1, Math.floor(count));
  const r = rng(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const width = Math.sqrt((n * SPACING * SPACING * D.sky * 16) / 9);
  const height = (width * 9) / 16;

  const positions = new Float32Array(n * 2);
  const colors = new Uint32Array(n);
  const sizes = new Float32Array(n);
  const zIndex = new Uint8Array(n);
  const group = new Uint32Array(n);
  let v = 0;
  const put = (x: number, y: number, color: number, size: number, z: number, id: number) => {
    positions[v * 2] = x;
    positions[v * 2 + 1] = y;
    colors[v] = color;
    sizes[v] = size * 1.35;
    zIndex[v] = z;
    group[v] = id;
    v++;
  };

  const starShare = n >= 2000 ? Math.floor(n * D.stars) : 0;
  const stars = starShare > 0 ? Math.min(D.starCount, Math.max(1, Math.floor(starShare / 100))) : 0;
  const budget = n - starShare;
  const galaxies = Math.max(1, Math.round(n / D.perGalaxy));
  const weight = new Float64Array(galaxies);
  let weightSum = 0;
  for (let g = 0; g < galaxies; g++) {
    weight[g] = Math.pow(1 - r(), -1 / D.alpha);
    weightSum += weight[g]!;
  }
  const cap = D.maxShare * weightSum;
  weightSum = 0;
  for (let g = 0; g < galaxies; g++) {
    weight[g] = Math.min(weight[g]!, cap);
    weightSum += weight[g]!;
  }
  const members = new Uint32Array(galaxies);
  let given = 0;
  for (let g = 0; g < galaxies; g++) {
    members[g] = Math.floor((budget * weight[g]!) / weightSum);
    given += members[g]!;
  }
  for (let g = 0; given < budget; g = (g + 1) % galaxies) {
    members[g]!++;
    given++;
  }

  const cx = Array.from({ length: D.clusters }, () => (r() - 0.5) * width * 0.9);
  const cy = Array.from({ length: D.clusters }, () => (r() - 0.5) * height * 0.9);

  for (let g = 0; g < galaxies; g++) {
    const m = members[g]!;
    if (m === 0) continue;
    const R = SPACING * Math.sqrt(m) * D.spread;
    let gx: number;
    let gy: number;
    if (r() < D.clustered) {
      const c = Math.floor(r() * D.clusters);
      gx = cx[c]! + normal() * width * 0.06;
      gy = cy[c]! + normal() * width * 0.06;
    } else {
      gx = (r() - 0.5) * width;
      gy = (r() - 0.5) * height;
    }
    gx = Math.max(-width / 2, Math.min(width / 2, gx));
    gy = Math.max(-height / 2, Math.min(height / 2, gy));
    const turn = r() * Math.PI * 2;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    const z = Math.max(0, Math.min(13, Math.floor(Math.log2(m)) - 3));
    const place = (lx: number, ly: number, q: number, color: number, size: number, top = 0) => {
      const y = ly * q;
      put(gx + lx * cos - y * sin, gy + lx * sin + y * cos, color, size, Math.min(14, z + top), g);
    };

    const pick = r();
    const kind = m < 150 ? (pick < 0.7 ? 3 : pick < 0.85 ? 1 : 2) : pick < 0.45 ? 0 : pick < 0.75 ? 1 : 2;

    if (kind === 0) {
      const q = 0.15 + 0.85 * r();
      const arms = r() < 0.7 ? 2 : 3 + Math.floor(r() * 2);
      const pitch = 0.2 + 0.25 * r();
      const bulge = 0.15 + 0.2 * r();
      const tailed = m > 3000 && r() < D.tails;
      const tailCount = tailed ? Math.floor(m * 0.12) : 0;
      const bulgeCount = Math.floor((m - tailCount) * bulge);
      const inner = R * 0.3;
      for (let k = 0; k < bulgeCount; k++) {
        const lx = normal() * R * 0.1;
        const ly = normal() * R * 0.1;
        const t = Math.min(1, Math.hypot(lx, ly) / (R * 0.25));
        place(lx, ly, q, hslToWord(0.11, 0.55 + 0.2 * t, 0.85 - 0.3 * t, 1), 1.6 + 1.2 * (1 - t), 1);
      }
      for (let k = bulgeCount; k < m - tailCount; k++) {
        let rho = -inner * Math.log(1 - r());
        while (rho > R * 1.4) rho = -inner * Math.log(1 - r());
        const onArm = r() < 0.7;
        const arm = Math.floor(r() * arms);
        const base = Math.log(Math.max(rho, R * 0.05) / (R * 0.05)) / pitch + (arm * Math.PI * 2) / arms;
        const a = onArm ? base + normal() * 0.22 : r() * Math.PI * 2;
        const lx = Math.cos(a) * rho;
        const ly = Math.sin(a) * rho;
        const t = Math.min(1, rho / R);
        let hue = 0.12 + (0.6 - 0.12) * Math.min(1, t * 2.5);
        let sat = 0.5;
        let light = onArm ? 0.74 - 0.15 * t : 0.5 - 0.1 * t;
        const alpha = onArm ? 0.95 - 0.4 * t : 0.5 - 0.2 * t;
        if (onArm && t > 0.2 && r() < 0.04) {
          hue = 0.93;
          sat = 0.8;
          light = 0.72;
        }
        if (q < 0.35 && ly > 0 && ly < R * 0.06 && rho < R * 0.8) light *= 0.35;
        place(lx, ly, q, hslToWord(hue, sat, light, alpha), 1.2 + 0.6 * r());
      }
      for (let k = 0; k < tailCount; k++) {
        const t = r();
        const side = k % 2 === 0 ? 0 : Math.PI;
        const a = side + t * 1.8;
        const rho = R * (0.8 + 2.2 * t);
        const off = normal() * R * 0.06 * (1 + t);
        place(Math.cos(a) * rho - Math.sin(a) * off, Math.sin(a) * rho + Math.cos(a) * off, Math.max(q, 0.6), hslToWord(0.6, 0.45, 0.6 - 0.15 * t, 0.6 - 0.3 * t), 1.1);
      }
    } else if (kind === 1) {
      const q = 0.45 + 0.55 * r();
      const hue = 0.08 + 0.04 * r();
      for (let k = 0; k < m; k++) {
        let rho = R * 0.12 * Math.log(1 - r()) ** 2;
        while (rho > R * 1.6) rho = R * 0.12 * Math.log(1 - r()) ** 2;
        const a = r() * Math.PI * 2;
        const t = Math.min(1, rho / R);
        place(Math.cos(a) * rho, Math.sin(a) * rho, q, hslToWord(hue, 0.45 + 0.25 * t, 0.86 - 0.36 * t, 1 - 0.5 * t), 1.3 + 1.4 * (1 - t) * (1 - t), t < 0.2 ? 1 : 0);
      }
    } else if (kind === 2) {
      const clumps = 3 + Math.floor(r() * 6);
      const kx = Array.from({ length: clumps }, () => normal() * R * 0.35);
      const ky = Array.from({ length: clumps }, () => normal() * R * 0.35);
      const hue = 0.58 + 0.06 * r();
      for (let k = 0; k < m; k++) {
        const c = Math.floor(r() * clumps);
        const lx = kx[c]! + normal() * R * 0.18;
        const ly = ky[c]! + normal() * R * 0.18;
        const knot = r() < 0.06;
        place(lx, ly, 1, knot ? hslToWord(0.93, 0.8, 0.72, 0.95) : hslToWord(hue, 0.55, 0.62 + 0.13 * r(), 0.8), 1.2 + 0.5 * r());
      }
    } else {
      const q = 0.4 + 0.6 * r();
      const red = r() < 0.6;
      const hue = red ? 0.02 + 0.06 * r() : 0.58 + 0.05 * r();
      for (let k = 0; k < m; k++) {
        const lx = normal() * R * 0.35;
        const ly = normal() * R * 0.35;
        const t = Math.min(1, Math.hypot(lx, ly) / R);
        place(lx, ly, q, hslToWord(hue, red ? 0.7 : 0.5, 0.62 - 0.2 * t, 0.9 - 0.4 * t), 1.2 + 0.4 * r());
      }
    }
  }

  let left = n - v;
  for (let s = 0; s < stars; s++) {
    const m = s === stars - 1 ? left : Math.floor(left / (stars - s)) + Math.floor((r() - 0.5) * (left / (stars - s)) * 0.8);
    left -= m;
    const x = (r() - 0.5) * width * 0.95;
    const y = (r() - 0.5) * height * 0.95;
    const id = galaxies + s;
    const core = Math.floor(m * 0.3);
    const glow = SPACING * Math.sqrt(m) * 0.12;
    const tint = r() < 0.5 ? 0.12 : 0.6;
    for (let k = 0; k < core; k++) {
      const ox = normal() * glow;
      const oy = normal() * glow;
      const t = Math.min(1, Math.hypot(ox, oy) / (glow * 2.5));
      put(x + ox, y + oy, hslToWord(tint, 0.3, 0.97 - 0.3 * t, 1 - 0.5 * t), 2.2 + 1.5 * (1 - t), 15, id);
    }
    const reach = SPACING * Math.sqrt(m) * 2.2;
    for (let k = core; k < m; k++) {
      const spike = k % 4;
      const a = Math.PI / 4 + (spike * Math.PI) / 2;
      const t = Math.pow(r(), 1.8);
      const d = glow + t * reach;
      const off = normal() * SPACING * 0.3 * (1 - t);
      put(x + Math.cos(a) * d - Math.sin(a) * off, y + Math.sin(a) * d + Math.cos(a) * off, hslToWord(tint, 0.25, 0.9 - 0.3 * t, Math.pow(1 - t, 1.5)), 1.6 * (1 - t) + 0.9, 15, id);
    }
  }

  const nodes = { count: n, positions, colors, sizes, zIndex };
  const friends = nearestPairs(nodes, [mortonOrder(nodes), mortonOrder(nodes, 1 / 3)], D.friends);
  const limit = (SPACING * D.maxLink) ** 2;
  const indices = new Uint32Array(friends.count * 2);
  let e = 0;
  for (let k = 0; k < friends.count; k++) {
    const a = friends.indices[k * 2]!;
    const b = friends.indices[k * 2 + 1]!;
    if (group[a] !== group[b]) continue;
    const dx = positions[a * 2]! - positions[b * 2]!;
    const dy = positions[a * 2 + 1]! - positions[b * 2 + 1]!;
    if (dx * dx + dy * dy > limit) continue;
    indices[e++] = a;
    indices[e++] = b;
  }
  return { nodes, edges: { count: e / 2, indices: indices.slice(0, e) } };
}
