import { SPACING, hslToWord, noise2, rng } from "./datasets";
import type { GraphDataset } from "./graphs";

const NONE = 0xffffffff;

export const RIVERS = {
  land: 0.55,
  spacing: 1.15,
  jitter: 0.35,
  detail: 0.12,
  rough: 0.03,
  major: 9,
};

export function rivers(count: number, seed = 1): GraphDataset {
  const R = RIVERS;
  const n = Math.max(1, Math.floor(count));
  const r = rng(seed);
  const shape = noise2(seed);
  const fine = noise2(seed ^ 0x9e3779b9);

  const cols = Math.max(2, Math.ceil(Math.sqrt(((n / R.land) * 16) / 9)));
  const rows = Math.max(2, Math.ceil(n / R.land / cols));
  const cells = cols * rows;
  const half = cols / 2;
  const score = new Float32Array(cells);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i - half) / half;
      const y = (j - rows / 2) / half;
      const fall = x * x + (y * 16 / 9) ** 2;
      score[j * cols + i] = shape(x * 1.8 + 3.1, y * 1.8 - 1.7) * 0.7 + 0.45 - fall * 0.9;
    }
  }
  const sorted = score.slice().sort();
  const cut = sorted[Math.max(0, cells - n)]!;
  const node = new Int32Array(cells).fill(-1);
  const cellOf = new Uint32Array(n);
  let made = 0;
  for (let c = 0; c < cells && made < n; c++) {
    if (score[c]! >= cut) {
      node[c] = made;
      cellOf[made++] = c;
    }
  }
  for (let c = 0; c < cells && made < n; c++) {
    if (node[c]! < 0) {
      node[c] = made;
      cellOf[made++] = c;
    }
  }

  const height = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    const c = cellOf[v]!;
    const x = ((c % cols) - half) / half;
    const y = (Math.floor(c / cols) - rows / 2) / half;
    height[v] = score[c]! + R.detail * fine(x * 14, y * 14) + R.rough * r();
  }

  const keys = new Float64Array(n);
  const ids = new Uint32Array(n);
  let size = 0;
  const push = (k: number, id: number) => {
    let i = size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= k) break;
      keys[i] = keys[p]!;
      ids[i] = ids[p]!;
      i = p;
    }
    keys[i] = k;
    ids[i] = id;
  };
  const pop = () => {
    const top = ids[0]!;
    const k = keys[--size]!;
    const id = ids[size]!;
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= size) break;
      if (c + 1 < size && keys[c + 1]! < keys[c]!) c++;
      if (keys[c]! >= k) break;
      keys[i] = keys[c]!;
      ids[i] = ids[c]!;
      i = c;
    }
    keys[i] = k;
    ids[i] = id;
    return top;
  };

  const seen = new Uint8Array(n);
  const down = new Uint32Array(n).fill(NONE);
  const land = (i: number, j: number) => (i < 0 || j < 0 || i >= cols || j >= rows ? -1 : node[j * cols + i]!);
  for (let v = 0; v < n; v++) {
    const c = cellOf[v]!;
    const i = c % cols;
    const j = Math.floor(c / cols);
    if (land(i + 1, j) < 0 || land(i - 1, j) < 0 || land(i, j + 1) < 0 || land(i, j - 1) < 0) {
      seen[v] = 1;
      push(height[v]!, v);
    }
  }
  const order = new Uint32Array(n);
  let done = 0;
  while (size > 0) {
    const v = pop();
    order[done++] = v;
    const c = cellOf[v]!;
    const i = c % cols;
    const j = Math.floor(c / cols);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const w = land(i + di, j + dj);
        if (w < 0 || seen[w]) continue;
        seen[w] = 1;
        down[w] = v;
        push(height[w]!, w);
      }
    }
  }

  const flow = new Uint32Array(n).fill(1);
  for (let k = done - 1; k >= 0; k--) {
    const v = order[k]!;
    if (down[v] !== NONE) flow[down[v]!]! += flow[v]!;
  }
  const basin = new Uint32Array(n);
  for (let k = 0; k < done; k++) {
    const v = order[k]!;
    basin[v] = down[v] === NONE ? v : basin[down[v]!]!;
  }

  const positions = new Float32Array(n * 2);
  const colors = new Uint32Array(n);
  const sizes = new Float32Array(n);
  const zIndex = new Uint8Array(n);
  const sp = SPACING * R.spacing;
  const indices = new Uint32Array(n * 2);
  let e = 0;
  for (let v = 0; v < n; v++) {
    const c = cellOf[v]!;
    positions[v * 2] = ((c % cols) - half + (r() - 0.5) * 2 * R.jitter) * sp;
    positions[v * 2 + 1] = (Math.floor(c / cols) - rows / 2 + (r() - 0.5) * 2 * R.jitter) * sp;
    const k = Math.min(1, Math.log(flow[v]!) / R.major);
    const hue = (basin[v]! * 0.618034) % 1;
    colors[v] = hslToWord(hue, 0.8, 0.3 + 0.42 * k, 0.03 + 0.97 * Math.pow(k, 1.4));
    sizes[v] = 0.9 + Math.min(6, Math.log2(flow[v]!) * 0.4);
    zIndex[v] = Math.min(15, Math.floor(Math.log2(flow[v]!)));
    if (down[v] !== NONE) {
      indices[e++] = v;
      indices[e++] = down[v]!;
    }
  }
  return { nodes: { count: n, positions, colors, sizes, zIndex }, edges: { count: e / 2, indices: indices.slice(0, e) } };
}
