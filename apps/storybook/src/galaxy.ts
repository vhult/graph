import { rng, type GraphDataset } from "@vhult/graph-bench";

export const GALAXY = {
  radius: 1000,
  core: 110,
  bulgeScale: 70,
  diskScale: 280,
  bulgeShare: 0.22,
  coreRatio: 0.7,
  outerRatio: 0.88,
  twist: 5.2,
  speed: 105,
  patternSpeed: 0.16,
} as const;

export interface Galaxy {
  graph: GraphDataset;
  orbits: Float32Array;
}

export const GALAXY_WGSL = `
fn nodePosition(i : u32, t : f32) -> vec2<f32> {
  let a = data[i * 4u];
  let b = data[i * 4u + 1u];
  let tilt = data[i * 4u + 2u] + param(0u) * t;
  let w = param(1u) * (1.0 - exp(-a / param(2u))) / max(a, 1e-3);
  let th = data[i * 4u + 3u] + w * t;
  let e = vec2<f32>(a * cos(th), b * sin(th));
  let c = cos(tilt);
  let s = sin(tilt);
  return vec2<f32>(c * e.x - s * e.y, s * e.x + c * e.y);
}
`;

export const GALAXY_PARAMS = [GALAXY.patternSpeed, GALAXY.speed, GALAXY.core];

function ratio(a: number): number {
  const g = GALAXY;
  if (a < g.core) return 1 + (a / g.core) * (g.coreRatio - 1);
  return g.coreRatio + ((Math.min(a, g.radius) - g.core) / (g.radius - g.core)) * (g.outerRatio - g.coreRatio);
}

function truncatedExp(u: number, scale: number, max: number): number {
  return -scale * Math.log(1 - u * (1 - Math.exp(-max / scale)));
}

export function kelvin(t: number): [number, number, number] {
  const k = t / 100;
  const r = k <= 66 ? 255 : 329.698727446 * Math.pow(k - 60, -0.1332047592);
  const g = k <= 66 ? 99.4708025861 * Math.log(k) - 161.1195681661 : 288.1221695283 * Math.pow(k - 60, -0.0755148492);
  const b = k >= 66 ? 255 : k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [c(r), c(g), c(b)];
}

export function word(rgb: [number, number, number], alpha: number): number {
  return (rgb[0] | (rgb[1] << 8) | (rgb[2] << 16) | (Math.round(alpha * 255) << 24)) >>> 0;
}

export function galaxy(count: number, seed = 1): Galaxy {
  const g = GALAXY;
  const r = rng(seed);
  const positions = new Float32Array(count * 2);
  const colors = new Uint32Array(count);
  const sizes = new Float32Array(count);
  const orbits = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    const bulge = r() < g.bulgeShare;
    const a = bulge ? truncatedExp(r(), g.bulgeScale, g.radius * 0.35) : truncatedExp(r(), g.diskScale, g.radius);
    const b = a * ratio(a);
    const tilt = (g.twist * a) / g.radius;
    const th = r() * Math.PI * 2;
    orbits[i * 4] = a;
    orbits[i * 4 + 1] = b;
    orbits[i * 4 + 2] = tilt;
    orbits[i * 4 + 3] = th;
    const ex = a * Math.cos(th);
    const ey = b * Math.sin(th);
    const c = Math.cos(tilt);
    const s = Math.sin(tilt);
    positions[i * 2] = c * ex - s * ey;
    positions[i * 2 + 1] = s * ex + c * ey;

    const f = a / g.radius;
    const pick = r();
    let temp: number;
    let size = 1 + 1.6 * Math.pow(r(), 3);
    let alpha = 0.16 + 0.2 * r();
    if (bulge) {
      temp = 3200 + 2600 * r();
      alpha = 0.3;
    } else if (pick < 0.01 && f > 0.15) {
      temp = 0;
      size = 2.5 + 3 * r();
      alpha = 0.45;
    } else if (pick < 0.02) {
      temp = 15000 + 15000 * r();
      size = 3 + 4 * r();
      alpha = 0.7;
    } else {
      temp = 4200 + 7000 * Math.pow(f, 0.6) * r() + 1500 * r();
    }
    colors[i] = temp === 0 ? word([255, 105, 170], alpha) : word(kelvin(temp), alpha * (1 - 0.35 * f));
    sizes[i] = size;
  }

  return {
    graph: {
      nodes: { count, positions, colors, sizes },
      edges: { count: 0, indices: new Uint32Array(0) },
    },
    orbits,
  };
}
