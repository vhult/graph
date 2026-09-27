import { rng, type GraphDataset } from "@vhult/graph-bench";

export const HOLE3D = {
  rIn: 4.5,
  rOut: 40,
  radii: 96,
  angles: 512,
  step: 0.002,
  timeScale: 24,
  scale: 30,
  extent: 17,
  inclination: 84,
  exposure: 9,
  alpha: 0.85,
  beaming: 0,
  clumpShare: 0.35,
  clumps: 90,
  wispShare: 0.12,
} as const;

const WORDS = 4;
const PSI_TOP = 3 * Math.PI;
const CAPTURE = 3 * Math.sqrt(3);

export interface Hole3d {
  graph: GraphDataset;
  data: Float32Array;
  params: number[];
}

export const HOLE3D_WGSL = `
const TAU : f32 = 6.283185307;

fn tableB(r : f32, psi : f32) -> f32 {
  let nr = param(2u);
  let na = param(3u);
  let fr = clamp(log(r / param(4u)) / log(param(5u) / param(4u)), 0.0, 1.0) * (nr - 1.0);
  let fa = clamp(psi / param(6u), 0.0, 1.0) * (na - 1.0);
  let r0 = min(u32(fr), u32(nr) - 2u);
  let a0 = min(u32(fa), u32(na) - 2u);
  let tr = fr - f32(r0);
  let ta = fa - f32(a0);
  let base = u32(param(1u));
  let w = u32(na);
  let lo = mix(data[base + r0 * w + a0], data[base + r0 * w + a0 + 1u], ta);
  let hi = mix(data[base + (r0 + 1u) * w + a0], data[base + (r0 + 1u) * w + a0 + 1u], ta);
  return mix(lo, hi, tr);
}

struct Image {
  sky : vec2<f32>,
  depth : f32,
  g : f32,
  r : f32,
  heat : f32,
  order : u32,
}

fn image(i : u32, t : f32) -> Image {
  let n = u32(param(0u));
  let order = i / n;
  let k = i - order * n;
  let r = data[k * ${WORDS}u];
  let phi = data[k * ${WORDS}u + 1u] + sqrt(1.0 / (r * r * r)) * t * param(8u);
  let pos = vec3<f32>(r * cos(phi), r * sin(phi), data[k * ${WORDS}u + 2u]);
  let inc = param(7u);
  let o = vec3<f32>(0.0, -sin(inc), cos(inc));
  let up = vec3<f32>(0.0, cos(inc), sin(inc));
  let right = vec3<f32>(1.0, 0.0, 0.0);
  let rr = length(pos);
  let nrm = pos / rr;
  let psi = acos(clamp(dot(nrm, o), -1.0, 1.0));
  var d = vec2<f32>(dot(nrm, right), dot(nrm, up));
  let dl = length(d);
  d = select(vec2<f32>(1.0, 0.0), d / dl, dl > 1e-6);
  var angle = psi;
  if (order == 1u) {
    angle = TAU - psi;
    d = -d;
  }
  if (order == 2u) {
    angle = TAU + psi;
  }
  let sky = d * tableB(rr, angle);
  let lz = cross(right * sky.x + up * sky.y, o).z;
  let g = sqrt(max(1.0 - 3.0 / r, 1e-4)) / max(1.0 - sqrt(1.0 / (r * r * r)) * lz, 1e-3);
  var depth = select(0.0, 0.5, order == 2u);
  if (order == 0u) {
    depth = (1.0 + 14.99 * (0.5 + 0.5 * tanh(dot(pos, o) / 8.0))) / 16.0;
  }
  return Image(sky, depth, g, r, data[k * ${WORDS}u + 3u], order);
}

fn nodePosition(i : u32, t : f32) -> vec3<f32> {
  let im = image(i, t);
  return vec3<f32>(im.sky.x * param(9u), -im.sky.y * param(9u), im.depth);
}

fn blackbody(t : f32) -> vec3<f32> {
  let a = vec3<f32>(0.4, 0.13, 0.09);
  let b = vec3<f32>(0.92, 0.5, 0.4);
  let c = vec3<f32>(1.0, 0.8, 0.75);
  let d = vec3<f32>(1.0, 0.94, 0.93);
  let e = vec3<f32>(0.9, 0.92, 1.0);
  if (t < 0.5) {
    return mix(a, b, clamp(t / 0.5, 0.0, 1.0));
  }
  if (t < 0.85) {
    return mix(b, c, (t - 0.5) / 0.35);
  }
  if (t < 1.3) {
    return mix(c, d, (t - 0.85) / 0.45);
  }
  return mix(d, e, clamp((t - 1.3) / 0.7, 0.0, 1.0));
}

fn nodeColor(i : u32, t : f32, p : vec3<f32>) -> vec4<f32> {
  let im = image(i, t);
  let rin = param(4u);
  let temp = pow(im.r / rin, -0.75) * pow(max(1.0 - sqrt(rin / im.r), 0.0), 0.25) / 0.4886;
  let g = mix(1.0, im.g, param(12u));
  let seen = g * temp;
  let orderFade = 1.0;
  let light = pow(g, 3.0) * (0.03 + pow(temp, 3.0)) * im.heat * orderFade * param(10u);
  let edge = 1.0 - smoothstep(0.55 * param(5u), param(5u), im.r);
  let rgb = vec3<f32>(1.0) - exp(-blackbody(seen) * light * edge);
  let glow = clamp(max(rgb.r, max(rgb.g, rgb.b)) * 1.3, 0.0, 1.0);
  return vec4<f32>(rgb, param(11u) * edge * glow);
}
`;

export function photonTable(): Float32Array {
  const { rIn, rOut, radii, angles, step } = HOLE3D;
  const u = Array.from({ length: radii }, (_, i) => 1 / (rIn * Math.pow(rOut / rIn, i / (radii - 1))));
  const bs: number[] = [];
  for (let k = 1; k <= 600; k++) bs.push((CAPTURE * k) / 601);
  for (let k = 0; k < 2400; k++) bs.push(CAPTURE + Math.pow(10, -7 + (k / 2399) * (Math.log10(60) + 7)));
  const inbound = new Float32Array(bs.length * radii).fill(NaN);
  const outbound = new Float32Array(bs.length * radii).fill(NaN);
  const force = (a: number) => 3 * a * a - a;
  const h = step;
  const stop = PSI_TOP + 0.3;
  bs.forEach((b, k) => {
    let uu = 0;
    let w = 1 / b;
    let phi = 0;
    let next = radii - 1;
    let back = radii;
    let out = false;
    while (phi < stop) {
      const k1u = w;
      const k1w = force(uu);
      const k2u = w + (h / 2) * k1w;
      const k2w = force(uu + (h / 2) * k1u);
      const k3u = w + (h / 2) * k2w;
      const k3w = force(uu + (h / 2) * k2u);
      const k4u = w + h * k3w;
      const k4w = force(uu + h * k3u);
      const nu = uu + (h / 6) * (k1u + 2 * k2u + 2 * k3u + k4u);
      const nw = w + (h / 6) * (k1w + 2 * k2w + 2 * k3w + k4w);
      if (!out) {
        while (next >= 0 && nu >= u[next]!) {
          inbound[k * radii + next] = phi + (h * (u[next]! - uu)) / (nu - uu);
          next--;
        }
        if (nw < 0) {
          out = true;
          back = next + 1;
        }
      } else {
        while (back < radii && nu <= u[back]!) {
          outbound[k * radii + back] = phi + (h * (u[back]! - uu)) / (nu - uu);
          back++;
        }
      }
      uu = nu;
      w = nw;
      phi += h;
      if (uu > 0.5 || uu < 0 || (out && back >= radii)) break;
    }
  });
  const table = new Float32Array(radii * angles);
  const ps: number[] = [];
  const pb: number[] = [];
  for (let i = 0; i < radii; i++) {
    ps.length = 0;
    pb.length = 0;
    const push = (psi: number, b: number) => {
      if (psi === psi && (ps.length === 0 || psi > ps[ps.length - 1]!)) {
        ps.push(psi);
        pb.push(b);
      }
    };
    for (let k = 0; k < bs.length; k++) push(inbound[k * radii + i]!, bs[k]!);
    for (let k = bs.length - 1; k >= 0; k--) push(outbound[k * radii + i]!, bs[k]!);
    let s = 0;
    for (let j = 0; j < angles; j++) {
      const psi = (j / (angles - 1)) * PSI_TOP;
      while (s < ps.length - 2 && ps[s + 1]! < psi) s++;
      const p0 = ps[s]!;
      const p1 = ps[s + 1] ?? p0;
      const t = p1 > p0 ? Math.min(1, Math.max(0, (psi - p0) / (p1 - p0))) : 0;
      table[i * angles + j] = pb[s]! + ((pb[s + 1] ?? pb[s]!) - pb[s]!) * t;
    }
  }
  return table;
}

export function blackHole3d(count: number, seed = 1): Hole3d {
  const H = HOLE3D;
  const r = rng(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const particles = Math.floor(count / 3);
  const nodes = particles * 3;
  const table = photonTable();
  const data = new Float32Array(particles * WORDS + table.length);
  data.set(table, particles * WORDS);
  const clumps = Array.from({ length: H.clumps }, () => [H.rIn + 1 + (H.rOut - H.rIn - 2) * Math.pow(r(), 1.5), r() * Math.PI * 2]);
  for (let k = 0; k < particles; k++) {
    const o = k * WORDS;
    let radius: number;
    let phi: number;
    let heat: number;
    const pick = r();
    if (pick < H.wispShare) {
      const [cr, cp] = clumps[Math.floor(r() * clumps.length)]!;
      radius = 16 + (cr! - H.rIn) * 0.9 + normal() * 1.2;
      phi = cp! + normal() * 0.9;
      heat = 0.35 + 0.4 * r();
    } else if (pick < H.wispShare + H.clumpShare) {
      const [cr, cp] = clumps[Math.floor(r() * clumps.length)]!;
      radius = cr! + normal() * 0.3;
      phi = cp! + normal() * 0.25;
      heat = 1.05 + 0.2 * r();
    } else {
      radius = H.rIn + (H.rOut - H.rIn) * Math.pow(r(), 2.4);
      phi = r() * Math.PI * 2;
      heat = 0.9 + 0.15 * r();
    }
    radius = Math.min(H.rOut, Math.max(H.rIn + 0.05, radius));
    data[o] = radius;
    data[o + 1] = phi;
    data[o + 2] = normal() * 0.006 * radius;
    data[o + 3] = heat;
  }
  const sizes = new Float32Array(nodes);
  for (let i = 0; i < nodes; i++) {
    const order = Math.floor(i / particles);
    sizes[i] = order === 0 ? 1.6 + 1.0 * r() : order === 1 ? 1.5 : 1.2;
  }
  return {
    graph: {
      nodes: { count: nodes, positions: new Float32Array(nodes * 2), colors: new Uint32Array(nodes), sizes },
      edges: { count: 0, indices: new Uint32Array(0) },
    },
    data,
    params: [particles, particles * WORDS, H.radii, H.angles, H.rIn, H.rOut, PSI_TOP, (H.inclination * Math.PI) / 180, H.timeScale, H.scale, H.exposure, H.alpha, H.beaming],
  };
}
