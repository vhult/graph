import { SPACING, hslToWord, noise2, rng } from "./datasets";
import type { GraphDataset } from "./graphs";

export const BRAIN = {
  cortex: 0.22,
  step: 1.4,
  gap: 0.012,
  fold: 0.06,
  gyri: 0.025,
  folds: 34,
  dendrites: 6,
  length: 260,
  bow: 1.1,
};

export function brain(count: number, seed = 1): GraphDataset {
  const B = BRAIN;
  const n = Math.max(1, Math.floor(count));
  const r = rng(seed);
  const noise = noise2(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const unit = SPACING * Math.sqrt((n * 2) / 3.47);
  const step = (SPACING * B.step) / unit;

  const halfWidth = (y: number) => 0.47 * (1 + 0.1 * y);
  const fold = (h: number, a: number) =>
    1 + B.fold * noise(Math.cos(a) * 3 + h * 7, Math.sin(a) * 3) + B.gyri * Math.sin(a * B.folds + 3 * noise(Math.cos(a) * 2, Math.sin(a) * 2 + h * 5));
  const shape = (x: number, y: number) => {
    const h = x < 0 ? -1 : 1;
    const ax = halfWidth(y);
    const dx = (x - h * (ax + B.gap)) / ax;
    const dy = y / 1.15;
    return Math.hypot(dx, dy) / fold(h, Math.atan2(dy, dx));
  };
  const inside = (x: number, y: number) => shape(x, y) < 1 || (Math.abs(x) < 0.2 && y > -0.4 && y < 0.5 && shape(Math.sign(x || 1) * 0.2, y) < 1);

  const positions = new Float32Array(n * 2);
  const colors = new Uint32Array(n);
  const sizes = new Float32Array(n);
  const indices = new Uint32Array(n * 2);
  let v = 0;
  let e = 0;
  const cortexCount = Math.floor(n * B.cortex);
  const fibreEnd = n - cortexCount;

  const field = (x: number, y: number) => {
    const h = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const bow = (y0: number) => B.bow * Math.max(-1, Math.min(1, (y0 - 0.05) / 0.45));
    const k = B.bow / 0.45;
    const y0 = (y + k * 0.05 * x * x) / (1 + k * x * x);
    const cAngle = Math.atan2(2 * bow(y0) * x, 1);
    const cx = h * (halfWidth(y) + B.gap);
    const ex = (x - cx) / (halfWidth(y) * halfWidth(y));
    const ey = y / (1.15 * 1.15);
    const aAngle = Math.atan2(ex, -ey);
    const px = h * 0.42;
    const py = 0.05;
    const pAngle = Math.atan2(y - py, x - px);
    const band = Math.exp(-((ax / 0.3) ** 2)) * Math.exp(-(((y - 0.05) / 0.6) ** 4));
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    const fan = Math.exp(-d2 / 0.12) * (1 - Math.exp(-d2 / 0.006)) * 1.2;
    const ring = 0.35;
    const w = band + fan + ring;
    const cos = (band * Math.cos(2 * cAngle) + fan * Math.cos(2 * pAngle) + ring * Math.cos(2 * aAngle)) / w;
    const sin = (band * Math.sin(2 * cAngle) + fan * Math.sin(2 * pAngle) + ring * Math.sin(2 * aAngle)) / w;
    const angle = Math.atan2(sin, cos) / 2;
    return [Math.cos(angle), Math.sin(angle), fan / w] as const;
  };

  const tx = new Float64Array(B.length * 2 + 1);
  const ty = new Float64Array(B.length * 2 + 1);
  const tb = new Float64Array(B.length * 2 + 1);
  let misses = 0;
  while (v < fibreEnd && misses < 1_000_000) {
    const sx = (r() - 0.5) * 2;
    const sy = (r() - 0.5) * 2.4;
    if (!inside(sx, sy)) {
      misses++;
      continue;
    }
    const length = Math.floor(B.length * (0.3 + 0.7 * r()));
    let count = 0;
    const trace = (dir: number, from: number) => {
      let x = sx;
      let y = sy;
      let [dx, dy] = field(x, y);
      dx *= dir;
      dy *= dir;
      let k = from;
      for (let q = 0; q < length; q++) {
        const [fx, fy, fb] = field(x + (dx * step) / 2, y + (dy * step) / 2);
        const flip = fx * dx + fy * dy < 0 ? -1 : 1;
        dx = fx * flip;
        dy = fy * flip;
        x += dx * step;
        y += dy * step;
        if (!inside(x, y)) break;
        tx[k] = x;
        ty[k] = y;
        tb[k] = fb;
        k += dir;
        count++;
      }
      return k - dir;
    };
    const [, , b0] = field(sx, sy);
    tx[B.length] = sx;
    ty[B.length] = sy;
    tb[B.length] = b0;
    const lo = trace(-1, B.length - 1);
    const hi = trace(1, B.length + 1);
    const first = Math.min(lo, B.length);
    const last = Math.max(hi, B.length);
    const jitter = normal() * step * 0.3;
    let prev = -1;
    for (let k = first; k <= last && v < fibreEnd; k++) {
      const kx = k < last ? tx[k + 1]! - tx[k]! : tx[k]! - tx[k - 1]!;
      const ky = k < last ? ty[k + 1]! - ty[k]! : ty[k]! - ty[k - 1]!;
      const kl = Math.hypot(kx, ky) || 1;
      const blue = tb[k]!;
      const red = Math.abs(kx / kl) * (1 - 0.6 * blue);
      const green = Math.abs(ky / kl) * (1 - 0.6 * blue);
      const top = Math.max(red, green, blue, 1e-6);
      const shade = 0.8 + 0.2 * r();
      const c = (m: number) => Math.round(Math.min(1, (m / top) * shade + 0.12) * 255);
      positions[v * 2] = (tx[k]! - (ky / kl) * jitter) * unit;
      positions[v * 2 + 1] = (ty[k]! + (kx / kl) * jitter) * unit;
      colors[v] = (c(red) | (c(green) << 8) | (c(blue) << 16) | (255 << 24)) >>> 0;
      sizes[v] = 1.9 + 0.6 * r();
      if (prev >= 0) {
        indices[e++] = prev;
        indices[e++] = v;
      }
      prev = v;
      v++;
    }
    if (count === 0) misses++;
  }

  while (v < n) {
    const h = r() < 0.5 ? -1 : 1;
    const a = r() * Math.PI * 2;
    const s = (0.84 + 0.14 * r()) * fold(h, a);
    const y = 1.15 * Math.sin(a) * s;
    const x = h * (halfWidth(y) + B.gap) + halfWidth(y) * Math.cos(a) * s;
    if (Math.abs(x) < 0.15 && y > -0.42 && y < 0.52) continue;
    const soma = v;
    positions[v * 2] = x * unit;
    positions[v * 2 + 1] = y * unit;
    colors[v] = hslToWord(0.98, 0.3, 0.75, 0.95);
    sizes[v] = 2 + r();
    v++;
    for (let d = 0; d < B.dendrites && v < n; d++) {
      const b = r() * Math.PI * 2;
      const rho = SPACING * (0.6 + r());
      positions[v * 2] = x * unit + Math.cos(b) * rho;
      positions[v * 2 + 1] = y * unit + Math.sin(b) * rho;
      colors[v] = hslToWord(0.98, 0.25, 0.58, 0.8);
      sizes[v] = 1 + 0.5 * r();
      indices[e++] = soma;
      indices[e++] = v;
      v++;
    }
  }

  return { nodes: { count: n, positions, colors, sizes }, edges: { count: e / 2, indices: indices.slice(0, e) } };
}
