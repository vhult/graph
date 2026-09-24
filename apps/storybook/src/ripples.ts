import { NodeShape, type Graph, type NodeStream } from "@vhult/graph";
import { gridGraph, SPACING, type GraphDataset } from "@vhult/graph-bench";

export const WATER = {
  pull: 0.45,
  damping: 0.998,
  rate: 120,
  maxSteps: 2,
  radius: 24,
  height: 1.2,
  gain: 2.5,
  slope: 14,
  calm: 1e-3,
  tile: SPACING * 0.92,
} as const;

const STOPS: readonly (readonly [number, number, number, number])[] = [
  [-1, 4, 14, 34],
  [0, 12, 58, 96],
  [0.6, 70, 180, 210],
  [0.85, 170, 235, 245],
  [1, 240, 252, 255],
];

const PALETTE = Float32Array.from({ length: 256 * 3 }, (_, j) => {
  const s = Math.floor(j / 3) / 127.5 - 1;
  const c = (j % 3) + 1;
  let k = 1;
  while (k < STOPS.length - 1 && STOPS[k]![0] < s) k++;
  const a = STOPS[k - 1]!;
  const b = STOPS[k]!;
  const t = Math.min(1, Math.max(0, (s - a[0]) / (b[0] - a[0])));
  return a[c]! + (b[c]! - a[c]!) * t;
});

const light = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};
const [LX, LY, LZ] = light(-0.55, -0.7, 0.9);
const [HX, HY, HZ] = light(LX, LY, LZ + 1);
const QX = HX / HZ;
const QY = HY / HZ;
const AMBIENT = 0.45;
const DIFFUSE = 0.75;
const GLINT = 190;
const GLINT_WIDTH = 6;
const glintAt = (nx: number, ny: number): number => {
  const dx = nx - QX;
  const dy = ny - QY;
  const g = 1 - (dx * dx + dy * dy) * GLINT_WIDTH;
  return g > 0 ? g * g * g * g * GLINT : 0;
};

const rest = (): number => {
  const s = AMBIENT + DIFFUSE * LZ;
  const glint = glintAt(0, 0);
  const c = (i: number) => Math.min(255, Math.floor(PALETTE[128 * 3 + i]! * s + glint));
  return (c(0) | (c(1) << 8) | (c(2) << 16) | (255 << 24)) >>> 0;
};

export function pool(count: number, seed: number): GraphDataset {
  const g = gridGraph(count, seed);
  g.nodes.sizes.fill(WATER.tile);
  g.nodes.colors.fill(rest());
  g.nodes.shapes = new Uint8Array(count).fill(NodeShape.square);
  return g;
}

export class Water {
  workMs = 0;
  private height: Float32Array;
  private previous: Float32Array;
  private readonly laplacian: Float32Array;
  private readonly slopeX: Float32Array;
  private readonly slopeY: Float32Array;
  private readonly edgeX: Float32Array;
  private readonly edgeY: Float32Array;
  private readonly stream: NodeStream;
  private readonly pending: number[] = [];
  private readonly box: HTMLElement;
  private readonly offHover: () => void;
  private still = false;
  private last = 0;
  private due = 0;
  private stepMs = 0;
  private paintMs = 0;
  private raf = 0;

  constructor(
    graph: Graph,
    private readonly g: GraphDataset,
    root: HTMLElement,
  ) {
    const n = g.nodes.count;
    this.height = new Float32Array(n);
    this.previous = new Float32Array(n);
    this.laplacian = new Float32Array(n);
    this.slopeX = new Float32Array(n);
    this.slopeY = new Float32Array(n);
    const m = g.edges.count;
    const idx = g.edges.indices;
    const pos = g.nodes.positions;
    this.edgeX = new Float32Array(m);
    this.edgeY = new Float32Array(m);
    for (let e = 0; e < m; e++) {
      const a = idx[e * 2]!;
      const b = idx[e * 2 + 1]!;
      const dx = pos[b * 2]! - pos[a * 2]!;
      const dy = pos[b * 2 + 1]! - pos[a * 2 + 1]!;
      const l2 = dx * dx + dy * dy || 1;
      this.edgeX[e] = dx / l2;
      this.edgeY[e] = dy / l2;
    }
    this.stream = graph.streamNodes({ colors: true });
    this.box = document.createElement("div");
    this.box.className = "stage-note";
    this.box.style.cssText = "top: 8px; right: 8px; left: auto; bottom: auto";
    root.append(this.box);
    this.offHover = graph.on("nodeHover", (i) => {
      if (i !== null) this.pending.push(i);
    });
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.offHover();
    this.box.remove();
  }

  private readonly tick = (now: number): void => {
    const dt = this.last === 0 ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    for (const i of this.pending) this.drop(i);
    this.pending.length = 0;
    this.workMs = 0;
    this.due = this.still ? 0 : Math.min(WATER.maxSteps, this.due + dt * WATER.rate);
    const steps = Math.floor(this.due);
    if (steps > 0) {
      this.due -= steps;
      const t0 = performance.now();
      for (let s = 0; s < steps; s++) this.step(s === steps - 1);
      const t1 = performance.now();
      const peak = this.paint();
      const t2 = performance.now();
      this.still = peak < WATER.calm;
      if (this.still) {
        this.height.fill(0);
        this.previous.fill(0);
      }
      this.workMs = t2 - t0;
      this.show(t1 - t0, t2 - t1, steps);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  drop(i: number): void {
    const pos = this.g.nodes.positions;
    const u = this.height;
    const p = this.previous;
    const x = pos[i * 2]!;
    const y = pos[i * 2 + 1]!;
    const r2 = WATER.radius * WATER.radius;
    this.still = false;
    for (let j = 0; j < u.length; j++) {
      const dx = pos[j * 2]! - x;
      const dy = pos[j * 2 + 1]! - y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      const w = WATER.height * 0.5 * (1 + Math.cos((Math.PI * Math.sqrt(d2)) / WATER.radius));
      u[j]! += w;
      p[j]! += w;
    }
  }

  private step(slope: boolean): void {
    const u = this.height;
    const p = this.previous;
    const lap = this.laplacian;
    const gx = this.slopeX;
    const gy = this.slopeY;
    const ex = this.edgeX;
    const ey = this.edgeY;
    const idx = this.g.edges.indices;
    const m = this.g.edges.count;
    lap.fill(0);
    if (slope) {
      gx.fill(0);
      gy.fill(0);
    }
    for (let e = 0; e < m; e++) {
      const a = idx[e * 2]!;
      const b = idx[e * 2 + 1]!;
      const d = u[b]! - u[a]!;
      lap[a]! += d;
      lap[b]! -= d;
      if (slope) {
        const sx = d * ex[e]!;
        const sy = d * ey[e]!;
        gx[a]! += sx;
        gy[a]! += sy;
        gx[b]! += sx;
        gy[b]! += sy;
      }
    }
    for (let i = 0; i < u.length; i++) {
      const h = u[i]!;
      p[i] = h + (h - p[i]!) * WATER.damping + WATER.pull * lap[i]!;
    }
    this.height = p;
    this.previous = u;
  }

  private paint(): number {
    const u = this.height;
    const gx = this.slopeX;
    const gy = this.slopeY;
    const colors = this.stream.colors;
    let peak = 0;
    for (let i = 0; i < u.length; i++) {
      const h = u[i]!;
      const a = Math.abs(h);
      if (a > peak) peak = a;
      const nx = -gx[i]! * WATER.slope;
      const ny = -gy[i]! * WATER.slope;
      const lit = AMBIENT + DIFFUSE * (LZ + nx * LX + ny * LY);
      const shade = lit > 0.1 ? lit : 0.1;
      const glint = glintAt(nx, ny);
      const s = h * WATER.gain;
      const k = (s <= -1 ? 0 : s >= 1 ? 255 : ((s + 1) * 127.5) | 0) * 3;
      const r = PALETTE[k]! * shade + glint;
      const g = PALETTE[k + 1]! * shade + glint;
      const b = PALETTE[k + 2]! * shade + glint;
      colors[i] = (r > 255 ? 255 : r) | ((g > 255 ? 255 : g) << 8) | ((b > 255 ? 255 : b) << 16) | 0xff000000;
    }
    this.stream.commit();
    return peak;
  }

  private show(stepMs: number, paintMs: number, steps: number): void {
    this.stepMs += (stepMs - this.stepMs) * 0.1;
    this.paintMs += (paintMs - this.paintMs) * 0.1;
    const state = this.still ? "still" : "moving";
    this.box.textContent = [`water ${state}`, `simulate ${this.stepMs.toFixed(1)} ms (${steps} steps)`, `colours ${this.paintMs.toFixed(1)} ms`].join("\n");
  }
}
