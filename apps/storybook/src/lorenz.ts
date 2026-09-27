import { rng, type GraphDataset } from "@vhult/graph-bench";

export const LORENZ = {
  sigma: 10,
  rho: 28,
  beta: 8 / 3,
  dt: 0.004,
  warmup: 2000,
  points: 150_000,
  flow: 60,
  spin: 0.12,
  tilt: 0.35,
  scale: 20,
  depth: 64,
  spread: 0.12,
  alpha: 0.22,
  extent: 34,
} as const;

const WORDS = 4;

export interface Lorenz {
  graph: GraphDataset;
  data: Float32Array;
  params: number[];
}

export const LORENZ_WGSL = `
fn tablePoint(base : u32, k : u32) -> vec3<f32> {
  let o = base + k * 4u;
  return vec3<f32>(data[o], data[o + 1u], data[o + 2u]);
}

fn pathPlace(i : u32, t : f32) -> f32 {
  let len = param(0u);
  let s = data[i * ${WORDS}u] + param(2u) * t;
  return s - floor(s / len) * len;
}

fn nodePosition(i : u32, t : f32) -> vec3<f32> {
  let o = i * ${WORDS}u;
  let len = param(0u);
  let base = u32(param(1u));
  let f = pathPlace(i, t);
  let k = min(u32(f), u32(len) - 1u);
  let k1 = select(k + 1u, 0u, k + 1u >= u32(len));
  let p = mix(tablePoint(base, k), tablePoint(base, k1), f - f32(k)) + vec3<f32>(data[o + 1u], data[o + 2u], data[o + 3u]);
  let yaw = param(3u) * t;
  let x = cos(yaw) * p.x - sin(yaw) * p.y;
  let y = sin(yaw) * p.x + cos(yaw) * p.y;
  let depth = cos(param(4u)) * y - sin(param(4u)) * p.z;
  let up = sin(param(4u)) * y + cos(param(4u)) * p.z;
  return vec3<f32>(x * param(5u), -up * param(5u), 0.5 - depth / param(6u));
}

fn heat(v : f32) -> vec3<f32> {
  let a = vec3<f32>(0.32, 0.12, 0.95);
  let b = vec3<f32>(0.95, 0.22, 0.62);
  let c = vec3<f32>(1.0, 0.62, 0.2);
  let d = vec3<f32>(1.0, 0.95, 0.7);
  if (v < 0.4) {
    return mix(a, b, v / 0.4);
  }
  if (v < 0.75) {
    return mix(b, c, (v - 0.4) / 0.35);
  }
  return mix(c, d, (v - 0.75) / 0.25);
}

fn nodeColor(i : u32, t : f32, p : vec3<f32>) -> vec4<f32> {
  let base = u32(param(1u));
  let k = min(u32(pathPlace(i, t)), u32(param(0u)) - 1u);
  let speed = data[base + k * 4u + 3u];
  let light = mix(0.3, 1.0, clamp(p.z, 0.0, 1.0));
  return vec4<f32>(heat(clamp(speed, 0.0, 1.0)) * light, param(7u));
}
`;

function trace(): Float32Array {
  const { sigma, rho, beta, dt, warmup, points } = LORENZ;
  let x = 1;
  let y = 1;
  let z = 1;
  const d = (px: number, py: number, pz: number): [number, number, number] => [sigma * (py - px), px * (rho - pz) - py, px * py - beta * pz];
  const step = () => {
    const [ax, ay, az] = d(x, y, z);
    const [bx, by, bz] = d(x + (ax * dt) / 2, y + (ay * dt) / 2, z + (az * dt) / 2);
    const [cx, cy, cz] = d(x + (bx * dt) / 2, y + (by * dt) / 2, z + (bz * dt) / 2);
    const [ex, ey, ez] = d(x + cx * dt, y + cy * dt, z + cz * dt);
    x += ((ax + 2 * bx + 2 * cx + ex) * dt) / 6;
    y += ((ay + 2 * by + 2 * cy + ey) * dt) / 6;
    z += ((az + 2 * bz + 2 * cz + ez) * dt) / 6;
  };
  for (let k = 0; k < warmup; k++) step();
  const table = new Float32Array(points * 4);
  let top = 0;
  for (let k = 0; k < points; k++) {
    step();
    table[k * 4] = x;
    table[k * 4 + 1] = y;
    table[k * 4 + 2] = z - rho + 1;
    const [vx, vy, vz] = d(x, y, z);
    const v = Math.hypot(vx, vy, vz);
    table[k * 4 + 3] = v;
    if (v > top) top = v;
  }
  for (let k = 0; k < points; k++) table[k * 4 + 3] = Math.pow(table[k * 4 + 3]! / top, 0.8);
  return table;
}

export function lorenz(count: number, seed = 1): Lorenz {
  const L = LORENZ;
  const r = rng(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const table = trace();
  const data = new Float32Array(count * WORDS + table.length);
  data.set(table, count * WORDS);
  const positions = new Float32Array(count * 2);
  const colors = new Uint32Array(count);
  const sizes = new Float32Array(count);
  const alpha = Math.min(0.85, L.alpha * Math.sqrt(1_000_000 / Math.max(1, count)));
  for (let i = 0; i < count; i++) {
    const s = r() * L.points;
    const o = i * WORDS;
    data[o] = s;
    data[o + 1] = normal() * L.spread;
    data[o + 2] = normal() * L.spread;
    data[o + 3] = normal() * L.spread;
    const k = Math.floor(s) * 4;
    const y = table[k + 1]! + data[o + 2]!;
    const z = table[k + 2]! + data[o + 3]!;
    positions[i * 2] = (table[k]! + data[o + 1]!) * L.scale;
    positions[i * 2 + 1] = -(Math.sin(L.tilt) * y + Math.cos(L.tilt) * z) * L.scale;
    colors[i] = 0;
    sizes[i] = 0.9 + 0.8 * r();
  }
  return {
    graph: { nodes: { count, positions, colors, sizes }, edges: { count: 0, indices: new Uint32Array(0) } },
    data,
    params: [L.points, count * WORDS, L.flow, L.spin, L.tilt, L.scale, L.depth, alpha],
  };
}
