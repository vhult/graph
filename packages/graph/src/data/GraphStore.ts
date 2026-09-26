/**
 * Worker-side SoA mirrors of every graph buffer, with dirty tracking.
 *
 * Mirrors are the arrays transferred from the main thread (zero copy) — they
 * double as the source for device-lost recovery (M9). The GPU never sees
 * strings or objects; node identity is the index.
 */
import { GraphError } from "../api/errors";
import { NO_INDEX } from "../api/Slots";
import { DirtyRanges } from "./DirtyRanges";
import { IndexUploads } from "./IndexUploads";
import { CONSTANTS, DEFAULT_NODE_STYLE, GRAPH_BINDINGS, GRAPH_BUFFER_WORDS, type GraphBufferName } from "./Layouts";
import { edgeStateBits, ICON_PALETTE_MAX, packIconColors, packNodeSizes, packNodeStyle, paletteIndices, toHalfBits, type PaletteIndices } from "./Pack";

export interface Channel {
  /** CPU mirror, `elementCount * words` 32-bit words. */
  data: Uint32Array | Float32Array;
  /** 32-bit words per element. */
  readonly words: number;
  /** Dirty element ranges awaiting upload. */
  readonly dirty: DirtyRanges;
  readonly scattered: IndexUploads;
  /** Element count changed: the GPU buffer must be recreated. */
  realloc: boolean;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface NodeArrays {
  positions?: Float32Array;
  colors?: Uint32Array;
  sizes?: Float32Array;
  shapes?: Uint8Array;
  zIndex?: Uint8Array;
  icons?: Uint16Array;
  iconColors?: Uint32Array;
}

export interface EdgeArrays {
  indices?: Uint32Array;
  styles?: Uint32Array;
  colors?: Uint32Array;
}

export const DEFAULT_NODE_COLOR = 0xffffa04a; // rgba(74, 160, 255, 255)
export const DEFAULT_NODE_SIZE = 4;
const EDGE_REMOVED = 1 << 4;
const NODE_REMOVED = 1 << 7;
const NODE_GONE = NODE_REMOVED | CONSTANTS.STATE_HIDDEN;

function anyDirected(styles: Uint32Array | undefined): boolean {
  if (!styles) return false;
  const flag = CONSTANTS.EDGE_FLAG_DIRECTED;
  for (let i = 0; i < styles.length; i++) if ((styles[i]! & flag) !== 0) return true;
  return false;
}

export class GraphStore {
  nodeCount = 0;
  nodeSlots = 0;
  edgeCount = 0;
  /** Per-edge style words were supplied; otherwise every edge uses the global width. */
  hasEdgeStyles = false;
  /** Per-edge colours were supplied; otherwise every edge uses the global tint. */
  hasEdgeColors = false;
  hasDirected = false;
  hasNodeShapes = false;
  hasZLayers = false;
  hasIcons = false;
  iconPalette: Uint32Array = new Uint32Array([0xffffffff]);
  paletteVersion = 0;
  maxNodeSize = 0;
  hiddenCount = 0;
  dimmedCount = 0;
  edgeState: Uint32Array | null = null;
  readonly edgeStateUploads = new IndexUploads();
  edgeStateAll = false;
  removedEdges = 0;
  edgeRankWanted = false;
  /** Label text per node / edge, in the user's order; null when none were set. */
  nodeLabels: readonly string[] | null = null;
  edgeLabels: readonly string[] | null = null;
  readonly channels: Readonly<Record<GraphBufferName, Channel>>;
  /** World-space AABB of node positions; recomputed on bulk position writes. */
  readonly bounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private anyDirty = false;
  private nodeMark = new Uint8Array(0);
  private edgeHits = new Uint32Array(64);
  private edgeTinted: Uint32Array | null = null;

  constructor() {
    const channels = {} as Record<GraphBufferName, Channel>;
    for (const b of GRAPH_BINDINGS) {
      const words = GRAPH_BUFFER_WORDS[b.name];
      const data = b.name === "nodePos" ? new Float32Array(0) : new Uint32Array(0);
      channels[b.name] = { data, words, dirty: new DirtyRanges(), scattered: new IndexUploads(), realloc: true };
    }
    this.channels = channels;
    this.anyDirty = true;
  }

  get liveEdges(): number {
    return this.edgeCount - this.removedEdges;
  }

  get dirty(): boolean {
    return this.anyDirty;
  }

  /** Called by GraphBuffers once everything has been flushed. */
  markClean(): void {
    this.anyDirty = false;
  }

  /**
   * Bulk replace node data. `count` is authoritative; missing arrays are filled
   * with defaults (or preserved prefix-wise when the count is unchanged).
   */
  setNodes(count: number, arrays: NodeArrays, reserve = 0): void {
    const palette = arrays.iconColors ? this.palette(arrays.iconColors, new Uint32Array(0)) : null;
    const total = count + reserve;
    const resized = total !== this.nodeCount;
    const grown = count > this.nodeSlots;
    this.nodeCount = total;
    this.nodeSlots = count;
    const ch = this.channels;
    const half = toHalfBits(DEFAULT_NODE_SIZE);

    if (arrays.positions) this.replace(ch.nodePos, padF32(arrays.positions, total * 2));
    else if (resized) this.replace(ch.nodePos, resizeF32(ch.nodePos.data as Float32Array, total * 2, 0));

    if (arrays.colors) this.replace(ch.nodeColor, padU32(arrays.colors, total, DEFAULT_NODE_COLOR));
    else if (resized) this.replace(ch.nodeColor, resizeU32(ch.nodeColor.data as Uint32Array, total, DEFAULT_NODE_COLOR));

    let size = ch.nodeSize.data as Uint32Array;
    if (arrays.sizes) {
      size = packNodeSizes(arrays.sizes, size);
      this.maxNodeSize = arrays.sizes.reduce((m, s) => Math.max(m, s), 0);
    } else if (resized) {
      size = resizeU32(size, total, half);
      if (grown) this.maxNodeSize = Math.max(this.maxNodeSize, DEFAULT_NODE_SIZE);
    }
    if (palette) {
      size = packIconColors(size, palette.indices);
      this.setPalette(palette.palette);
    }
    if (size !== ch.nodeSize.data) this.replace(ch.nodeSize, padU32(size, total, half));

    if (arrays.shapes || arrays.zIndex || arrays.icons) {
      this.replace(ch.nodeStyle, padU32(packNodeStyle(count, ch.nodeStyle.data as Uint32Array, arrays.shapes, arrays.zIndex, arrays.icons), total, DEFAULT_NODE_STYLE));
      if (arrays.shapes) this.hasNodeShapes = arrays.shapes.some((s) => s !== 0);
      if (arrays.zIndex) this.hasZLayers = arrays.zIndex.some((z) => z !== 0);
      if (arrays.icons) this.hasIcons = arrays.icons.some((v) => v !== CONSTANTS.NO_ICON);
    } else if (resized) this.replace(ch.nodeStyle, resizeU32(ch.nodeStyle.data as Uint32Array, total, DEFAULT_NODE_STYLE));

    const st = new Uint32Array(total);
    st.fill(NODE_GONE, count);
    this.replace(ch.nodeState, st);
    this.hiddenCount = 0;
    this.dimmedCount = 0;

    this.computeBounds();
  }

  growNodes(count: number): void {
    const ch = this.channels;
    this.replace(ch.nodePos, resizeF32(ch.nodePos.data as Float32Array, count * 2, 0));
    this.replace(ch.nodeColor, resizeU32(ch.nodeColor.data as Uint32Array, count, DEFAULT_NODE_COLOR));
    this.replace(ch.nodeSize, resizeU32(ch.nodeSize.data as Uint32Array, count, toHalfBits(DEFAULT_NODE_SIZE)));
    this.replace(ch.nodeStyle, resizeU32(ch.nodeStyle.data as Uint32Array, count, DEFAULT_NODE_STYLE));
    this.replace(ch.nodeState, resizeU32(ch.nodeState.data as Uint32Array, count, NODE_GONE));
    this.nodeCount = count;
  }

  addNodes(indices: Uint32Array, slots: number, arrays: NodeArrays): void {
    if (slots > this.nodeCount) throw new RangeError(`addNodes: ${slots} slots exceed node count ${this.nodeCount}`);
    const n = indices.length;
    this.nodeSlots = slots;
    this.updateNodesAt(indices, {
      positions: arrays.positions ?? new Float32Array(n * 2),
      colors: arrays.colors ?? new Uint32Array(n).fill(DEFAULT_NODE_COLOR),
      sizes: arrays.sizes ?? new Float32Array(n).fill(DEFAULT_NODE_SIZE),
      shapes: arrays.shapes ?? new Uint8Array(n),
      zIndex: arrays.zIndex ?? new Uint8Array(n),
      icons: arrays.icons ?? new Uint16Array(n).fill(CONSTANTS.NO_ICON),
      iconColors: arrays.iconColors,
    });
    const ch = this.channels.nodeState;
    const st = ch.data as Uint32Array;
    for (let j = 0; j < n; j++) st[indices[j]!] = 0;
    ch.scattered.add(indices, new Uint32Array(n), 1, this.nodeCount);
    const pos = arrays.positions;
    if (pos) for (let j = 0; j < n; j++) this.growBounds(pos[j * 2]!, pos[j * 2 + 1]!);
    else if (n > 0) this.growBounds(0, 0);
  }

  removeNodes(indices: Uint32Array): Uint32Array {
    for (let j = 0; j < indices.length; j++) {
      if (indices[j]! >= this.nodeCount) throw new RangeError(`removeNodes: index ${indices[j]} exceeds node count ${this.nodeCount}`);
    }
    const ch = this.channels.nodeState;
    const st = ch.data as Uint32Array;
    if (this.nodeMark.length < this.nodeCount) this.nodeMark = new Uint8Array(this.nodeCount);
    const mark = this.nodeMark;
    const hidden = CONSTANTS.STATE_HIDDEN;
    const dimmed = CONSTANTS.STATE_DIMMED;
    let count = this.hiddenCount;
    let dim = this.dimmedCount;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j]!;
      const old = st[i]!;
      if ((old & NODE_REMOVED) === 0 && (old & hidden) !== 0) count--;
      if ((old & NODE_REMOVED) === 0 && (old & dimmed) !== 0) dim--;
      st[i] = NODE_GONE;
      mark[i] = 1;
    }
    this.hiddenCount = count;
    this.dimmedCount = dim;
    ch.scattered.add(indices, new Uint32Array(indices.length).fill(NODE_GONE), 1, this.nodeCount);
    this.anyDirty = true;

    const ends = this.channels.edgeIdx.data as Uint32Array;
    const es = this.edgeState;
    let hits = this.edgeHits;
    let k = 0;
    for (let e = 0; e < this.edgeCount; e++) {
      if (mark[ends[e * 2]!] !== 1 && mark[ends[e * 2 + 1]!] !== 1) continue;
      if (es && (es[e]! & EDGE_REMOVED) !== 0) continue;
      if (k === hits.length) {
        const next = new Uint32Array(hits.length * 2);
        next.set(hits);
        hits = next;
      }
      hits[k++] = e;
    }
    this.edgeHits = hits;
    for (let j = 0; j < indices.length; j++) mark[indices[j]!] = 0;
    return hits.slice(0, k);
  }

  compactNodes(remap: Uint32Array, reserve = 0): void {
    const n0 = Math.min(remap.length, this.nodeSlots);
    let n = 0;
    for (let i = 0; i < n0; i++) if (remap[i] !== NO_INDEX) n++;
    const total = n + reserve;
    const ch = this.channels;
    const pack = (src: Uint32Array, words: number, fill: number): Uint32Array => {
      const out = new Uint32Array(total * words);
      if (fill !== 0) out.fill(fill, n * words);
      for (let i = 0; i < n0; i++) {
        const r = remap[i]!;
        if (r === NO_INDEX) continue;
        for (let k = 0; k < words; k++) out[r * words + k] = src[i * words + k]!;
      }
      return out;
    };
    this.replace(ch.nodePos, new Float32Array(pack(u32(ch.nodePos.data), 2, 0).buffer));
    this.replace(ch.nodeColor, pack(ch.nodeColor.data as Uint32Array, 1, DEFAULT_NODE_COLOR));
    this.replace(ch.nodeSize, pack(ch.nodeSize.data as Uint32Array, 1, toHalfBits(DEFAULT_NODE_SIZE)));
    this.replace(ch.nodeStyle, pack(ch.nodeStyle.data as Uint32Array, 1, DEFAULT_NODE_STYLE));
    const st = pack(ch.nodeState.data as Uint32Array, 1, NODE_GONE);
    this.replace(ch.nodeState, st);
    let hidden = 0;
    let dim = 0;
    for (let i = 0; i < n; i++) {
      if ((st[i]! & CONSTANTS.STATE_HIDDEN) !== 0) hidden++;
      if ((st[i]! & CONSTANTS.STATE_DIMMED) !== 0) dim++;
    }
    this.hiddenCount = hidden;
    this.dimmedCount = dim;
    const labels = this.nodeLabels;
    if (labels) {
      const out: string[] = new Array<string>(n).fill("");
      for (let i = 0; i < n0; i++) if (remap[i] !== NO_INDEX) out[remap[i]!] = labels[i] ?? "";
      this.nodeLabels = out;
    }
    const ends = ch.edgeIdx.data as Uint32Array;
    for (let e = 0; e < this.edgeCount; e++) {
      const a = remap[ends[e * 2]!] ?? NO_INDEX;
      const b = remap[ends[e * 2 + 1]!] ?? NO_INDEX;
      const kept = a !== NO_INDEX ? a : b !== NO_INDEX ? b : 0;
      ends[e * 2] = a !== NO_INDEX ? a : kept;
      ends[e * 2 + 1] = b !== NO_INDEX ? b : kept;
    }
    this.nodeCount = total;
    this.nodeSlots = n;
    this.computeBounds();
    if (this.edgeCount > 0) this.reloadEdges();
  }

  updateNodes(start: number, arrays: NodeArrays): void {
    const n = arrays.positions ? arrays.positions.length / 2 : (arrays.colors ?? arrays.sizes ?? arrays.shapes ?? arrays.zIndex ?? arrays.icons ?? arrays.iconColors)?.length ?? 0;
    if (start + n > this.nodeCount) throw new RangeError("updateNodes: range exceeds node count");
    const palette = arrays.iconColors ? this.palette(arrays.iconColors, this.iconPalette) : null;
    const ch = this.channels;
    if (arrays.positions) this.updatePositions(start, arrays.positions);
    if (arrays.colors) this.updateColors(start, arrays.colors);
    const sizeWords = ch.nodeSize.data as Uint32Array;
    let size: Uint32Array | null = null;
    if (arrays.sizes) {
      size = packNodeSizes(arrays.sizes, sizeWords, start);
      this.maxNodeSize = arrays.sizes.reduce((m, s) => Math.max(m, s), this.maxNodeSize);
    }
    if (palette) {
      size = packIconColors(size ?? sizeWords.subarray(start, start + n), palette.indices);
      this.setPalette(palette.palette);
    }
    if (size) this.writeRange(ch.nodeSize, start, size);
    if (arrays.shapes || arrays.zIndex || arrays.icons) {
      this.writeRange(ch.nodeStyle, start, packNodeStyle(n, ch.nodeStyle.data as Uint32Array, arrays.shapes, arrays.zIndex, arrays.icons, start));
      if (arrays.shapes) this.hasNodeShapes ||= arrays.shapes.some((s) => s !== 0);
      if (arrays.zIndex) this.hasZLayers ||= arrays.zIndex.some((z) => z !== 0);
      if (arrays.icons) this.hasIcons ||= arrays.icons.some((v) => v !== CONSTANTS.NO_ICON);
    }
  }

  updateNodesAt(indices: Uint32Array, arrays: NodeArrays): void {
    for (let j = 0; j < indices.length; j++) {
      if (indices[j]! >= this.nodeCount) throw new RangeError(`updateNodesAt: index ${indices[j]} exceeds node count ${this.nodeCount}`);
    }
    const palette = arrays.iconColors ? this.palette(arrays.iconColors, this.iconPalette) : null;
    const ch = this.channels;
    if (arrays.positions) this.writeAt(ch.nodePos, indices, u32(arrays.positions));
    if (arrays.colors) this.writeAt(ch.nodeColor, indices, arrays.colors);
    let size: Uint32Array | null = null;
    if (arrays.sizes) {
      size = packNodeSizes(arrays.sizes, gather(ch.nodeSize.data as Uint32Array, indices));
      this.maxNodeSize = arrays.sizes.reduce((m, s) => Math.max(m, s), this.maxNodeSize);
    }
    if (palette) {
      size = packIconColors(size ?? gather(ch.nodeSize.data as Uint32Array, indices), palette.indices);
      this.setPalette(palette.palette);
    }
    if (size) this.writeAt(ch.nodeSize, indices, size);
    if (arrays.shapes || arrays.zIndex || arrays.icons) {
      this.writeAt(ch.nodeStyle, indices, packNodeStyle(indices.length, gather(ch.nodeStyle.data as Uint32Array, indices), arrays.shapes, arrays.zIndex, arrays.icons));
      if (arrays.shapes) this.hasNodeShapes ||= arrays.shapes.some((s) => s !== 0);
      if (arrays.zIndex) this.hasZLayers ||= arrays.zIndex.some((z) => z !== 0);
      if (arrays.icons) this.hasIcons ||= arrays.icons.some((v) => v !== CONSTANTS.NO_ICON);
    }
  }

  clearIcons(ids: Uint16Array): boolean {
    const { STYLE_ICON_SHIFT, STYLE_ICON_MASK, NO_ICON } = CONSTANTS;
    const gone = new Uint8Array(STYLE_ICON_MASK + 1);
    for (let j = 0; j < ids.length; j++) gone[ids[j]!] = 1;
    const ch = this.channels.nodeStyle;
    const st = ch.data as Uint32Array;
    const clear = ~(STYLE_ICON_MASK << STYLE_ICON_SHIFT);
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < this.nodeCount; i++) {
      const w = st[i]!;
      if (gone[(w >>> STYLE_ICON_SHIFT) & STYLE_ICON_MASK] === 0) continue;
      st[i] = ((w & clear) | (NO_ICON << STYLE_ICON_SHIFT)) >>> 0;
      if (lo < 0) lo = i;
      hi = i;
    }
    if (lo < 0) return false;
    this.markRange(ch, lo, hi + 1);
    return true;
  }

  flagNodes(indices: Uint32Array | null, flags: number, on: boolean): void {
    const ch = this.channels.nodeState;
    const st = ch.data as Uint32Array;
    const keep = on ? 0xffffffff : ~flags >>> 0;
    const set = on ? flags : 0;
    const hidden = CONSTANTS.STATE_HIDDEN;
    const dimmed = CONSTANTS.STATE_DIMMED;
    if (indices === null) {
      let count = 0;
      let dim = 0;
      for (let i = 0; i < this.nodeCount; i++) {
        const old = st[i]!;
        if ((old & NODE_REMOVED) !== 0) continue;
        const next = ((old & keep) | set) >>> 0;
        st[i] = next;
        if ((next & hidden) !== 0) count++;
        if ((next & dimmed) !== 0) dim++;
      }
      this.hiddenCount = count;
      this.dimmedCount = dim;
      if (this.nodeCount > 0) this.markRange(ch, 0, this.nodeCount);
      return;
    }
    for (let j = 0; j < indices.length; j++) {
      if (indices[j]! >= this.nodeCount) throw new RangeError(`flagNodes: index ${indices[j]} exceeds node count ${this.nodeCount}`);
    }
    let count = this.hiddenCount;
    let dim = this.dimmedCount;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j]!;
      const old = st[i]!;
      const next = ((old & keep) | set) >>> 0;
      count += ((next & hidden) !== 0 ? 1 : 0) - ((old & hidden) !== 0 ? 1 : 0);
      dim += ((next & dimmed) !== 0 ? 1 : 0) - ((old & dimmed) !== 0 ? 1 : 0);
      st[i] = next;
    }
    this.hiddenCount = count;
    this.dimmedCount = dim;
    ch.scattered.add(indices, gather(st, indices), 1, this.nodeCount);
    this.anyDirty = true;
  }

  nodeFlagged(i: number, bit: number): boolean {
    return ((this.channels.nodeState.data as Uint32Array)[i]! & bit) !== 0;
  }

  anyFlagged(indices: Uint32Array, bit: number): boolean {
    const st = this.channels.nodeState.data as Uint32Array;
    for (let j = 0; j < indices.length; j++) if ((st[indices[j]!]! & bit) !== 0) return true;
    return false;
  }

  writePositionsAt(indices: Uint32Array, words: Uint32Array): void {
    this.writeAt(this.channels.nodePos, indices, words);
  }

  listNodes(bit: number, out: Uint32Array, at: number): number {
    const st = this.channels.nodeState.data as Uint32Array;
    const n = this.nodeSlots;
    let k = 0;
    for (let i = 0; i < n; i++) {
      if ((st[i]! & bit) === 0) continue;
      if (at + k < out.length) out[at + k] = i;
      k++;
    }
    return k;
  }

  private writeAt(ch: Channel, indices: Uint32Array, words: Uint32Array): void {
    const w = ch.words;
    const dst = u32(ch.data);
    for (let j = 0; j < indices.length; j++) {
      const at = indices[j]! * w;
      for (let k = 0; k < w; k++) dst[at + k] = words[j * w + k]!;
    }
    ch.scattered.add(indices, words, w, dst.length / w);
    this.anyDirty = true;
  }

  private palette(colors: Uint32Array, from: Uint32Array): PaletteIndices {
    const p = paletteIndices(colors, from);
    if (!p) throw new GraphError("invalid-argument", `iconColors: at most ${ICON_PALETTE_MAX} different colours`);
    return p;
  }

  private setPalette(palette: Uint32Array): void {
    if (palette === this.iconPalette) return;
    this.iconPalette = palette;
    this.paletteVersion++;
  }

  private writeRange(ch: Channel, start: number, words: Uint32Array): void {
    (ch.data as Uint32Array).set(words, start);
    this.markRange(ch, start, start + words.length);
  }

  drawnBounds(nodeScale: number): Bounds {
    const r = this.maxNodeSize * nodeScale * 0.5;
    const b = this.bounds;
    return { minX: b.minX - r, minY: b.minY - r, maxX: b.maxX + r, maxY: b.maxY + r };
  }

  nodeBounds(nodes: Uint32Array, nodeScale: number, streamed: Float32Array | null): Bounds | null {
    const mirror = this.channels.nodePos.data as Float32Array;
    const n = this.nodeSlots;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let j = 0; j < nodes.length; j++) {
      const i = nodes[j]!;
      if (i >= n) continue;
      const pos = streamed && i * 2 + 1 < streamed.length ? streamed : mirror;
      const x = pos[i * 2]!;
      const y = pos[i * 2 + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minX > maxX) return null;
    const r = this.maxNodeSize * nodeScale * 0.5;
    return { minX: minX - r, minY: minY - r, maxX: maxX + r, maxY: maxY + r };
  }

  /**
   * Bulk replace edge data. Endpoints arrive as USER node indices and stay that
   * way here: the GPU maps them to engine order and sorts the list itself
   * (EdgeSortPass), so this never has to know about either order.
   */
  setEdges(count: number, arrays: EdgeArrays): void {
    const resized = count !== this.edgeCount;
    this.edgeCount = count;
    const ch = this.channels;

    if (arrays.indices) this.replace(ch.edgeIdx, arrays.indices);
    else if (resized) this.replace(ch.edgeIdx, resizeU32(ch.edgeIdx.data as Uint32Array, count * 2, 0));

    // Uniform edges upload NOTHING for style or colour: the shader variant that
    // reads them is not compiled, and the buffers stay at their minimum size.
    // At 30M edges that is 360 MB not allocated, which matters on an iGPU.
    this.hasEdgeStyles = arrays.styles !== undefined;
    this.hasEdgeColors = arrays.colors !== undefined;
    this.hasDirected = anyDirected(arrays.styles);
    this.replace(ch.edgeStyle, arrays.styles ?? new Uint32Array(0));
    this.replace(ch.edgeColor, arrays.colors ?? new Uint32Array(0));
    this.edgeState = null;
    this.edgeStateUploads.reset(count);
    this.edgeStateAll = false;
    this.removedEdges = 0;
    this.edgeRankWanted = false;
    this.edgeTinted = null;
  }

  addEdges(indices: Uint32Array, slots: number, arrays: EdgeArrays, tint: number): void {
    const ch = this.channels;
    const ends = sized(ch.edgeIdx.data as Uint32Array, slots * 2, 0);
    const src = arrays.indices;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j]!;
      ends[i * 2] = src ? src[j * 2]! : 0;
      ends[i * 2 + 1] = src ? src[j * 2 + 1]! : 0;
    }
    ch.edgeIdx.data = ends;
    if (arrays.styles || this.hasEdgeStyles) {
      const st = sized(ch.edgeStyle.data as Uint32Array, slots, 0);
      for (let j = 0; j < indices.length; j++) st[indices[j]!] = arrays.styles ? arrays.styles[j]! : 0;
      ch.edgeStyle.data = st;
      this.hasEdgeStyles = true;
      this.hasDirected ||= anyDirected(arrays.styles);
    }
    if (arrays.colors || this.hasEdgeColors) {
      const filled = this.hasEdgeColors ? ch.edgeColor.data.length / 2 : 0;
      const co = sized(ch.edgeColor.data as Uint32Array, slots * 2, tint);
      this.tintFrom(slots, filled);
      for (let j = 0; j < indices.length; j++) {
        const i = indices[j]!;
        co[i * 2] = arrays.colors ? arrays.colors[j * 2]! : tint;
        co[i * 2 + 1] = arrays.colors ? arrays.colors[j * 2 + 1]! : tint;
      }
      if (arrays.colors) this.untint(indices);
      else this.tint(indices);
      ch.edgeColor.data = co;
      this.hasEdgeColors = true;
    }
    if (this.edgeState) {
      const st = sized(this.edgeState, slots, 0);
      let removed = this.removedEdges;
      for (let j = 0; j < indices.length; j++) {
        const i = indices[j]!;
        if ((st[i]! & EDGE_REMOVED) !== 0) removed--;
        st[i] = 0;
      }
      this.edgeState = st;
      this.removedEdges = removed;
    }
    this.edgeCount = slots;
    this.reloadEdges();
  }

  hideEdges(indices: Uint32Array): void {
    this.checkEdges(indices, "hideEdges");
    const st = this.ensureEdgeState();
    const hide = EDGE_REMOVED | CONSTANTS.EDGE_STATE_HIDDEN;
    let removed = this.removedEdges;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j]!;
      if ((st[i]! & EDGE_REMOVED) === 0) removed++;
      st[i] = (st[i]! | hide) >>> 0;
    }
    this.removedEdges = removed;
    this.stageEdgeState(indices, st);
  }

  flagEdges(indices: Uint32Array | null, flags: number, on: boolean): void {
    if (indices) this.checkEdges(indices, "flagEdges");
    const st = this.ensureEdgeState();
    const bits = edgeStateBits(flags);
    const keep = on ? 0xffffffff : ~bits >>> 0;
    const set = on ? bits : 0;
    const hidden = CONSTANTS.EDGE_STATE_HIDDEN;
    const apply = (i: number): void => {
      const next = (st[i]! & keep) | set;
      st[i] = ((next & EDGE_REMOVED) !== 0 ? next | hidden : next) >>> 0;
    };
    if (indices === null) {
      for (let i = 0; i < this.edgeCount; i++) apply(i);
      this.edgeStateAll = true;
      this.edgeStateUploads.clear();
      this.edgeRankWanted = true;
      this.anyDirty = true;
      return;
    }
    for (let j = 0; j < indices.length; j++) apply(indices[j]!);
    this.stageEdgeState(indices, st);
  }

  updateEdgesAt(indices: Uint32Array, arrays: EdgeArrays, tint: number): void {
    this.checkEdges(indices, "updateEdgesAt");
    const ch = this.channels;
    this.hasDirected ||= anyDirected(arrays.styles);
    const reload = arrays.indices !== undefined || (arrays.styles !== undefined && !this.hasEdgeStyles) || (arrays.colors !== undefined && !this.hasEdgeColors);
    if (!reload) {
      if (arrays.styles) this.writeAt(ch.edgeStyle, indices, arrays.styles);
      if (arrays.colors) {
        this.writeAt(ch.edgeColor, indices, arrays.colors);
        this.untint(indices);
      }
      this.edgeRankWanted = true;
      return;
    }
    if (arrays.indices) scatterWords(ch.edgeIdx.data as Uint32Array, indices, arrays.indices, 2);
    if (arrays.styles) {
      if (!this.hasEdgeStyles) ch.edgeStyle.data = new Uint32Array(this.edgeCount);
      scatterWords(ch.edgeStyle.data as Uint32Array, indices, arrays.styles, 1);
      this.hasEdgeStyles = true;
    }
    if (arrays.colors) {
      if (!this.hasEdgeColors) {
        ch.edgeColor.data = new Uint32Array(this.edgeCount * 2).fill(tint);
        this.tintFrom(this.edgeCount, 0);
      }
      scatterWords(ch.edgeColor.data as Uint32Array, indices, arrays.colors, 2);
      this.untint(indices);
      this.hasEdgeColors = true;
    }
    this.edgeRankWanted ||= arrays.styles !== undefined || arrays.colors !== undefined;
    this.reloadEdges();
  }

  updateEdges(arrays: EdgeArrays): void {
    const ch = this.channels;
    if (arrays.styles) this.hasDirected = anyDirected(arrays.styles);
    if (arrays.colors) this.edgeTinted = null;
    const reload = arrays.indices !== undefined || (arrays.styles !== undefined && !this.hasEdgeStyles) || (arrays.colors !== undefined && !this.hasEdgeColors);
    if (!reload) {
      if (arrays.styles) this.writeRange(ch.edgeStyle, 0, arrays.styles);
      if (arrays.colors) {
        (ch.edgeColor.data as Uint32Array).set(arrays.colors);
        this.markRange(ch.edgeColor, 0, this.edgeCount);
      }
      this.edgeRankWanted = true;
      return;
    }
    if (arrays.indices) ch.edgeIdx.data = arrays.indices;
    if (arrays.styles) ch.edgeStyle.data = arrays.styles;
    if (arrays.colors) ch.edgeColor.data = arrays.colors;
    this.hasEdgeStyles ||= arrays.styles !== undefined;
    this.hasEdgeColors ||= arrays.colors !== undefined;
    this.reloadEdges();
  }

  compactEdges(remap: Uint32Array): void {
    const n0 = Math.min(remap.length, this.edgeCount);
    let n = 0;
    for (let i = 0; i < n0; i++) if (remap[i] !== NO_INDEX) n++;
    const ch = this.channels;
    const pack = (src: Uint32Array, words: number): Uint32Array => {
      const out = new Uint32Array(n * words);
      for (let i = 0; i < n0; i++) {
        const r = remap[i]!;
        if (r === NO_INDEX) continue;
        for (let k = 0; k < words; k++) out[r * words + k] = src[i * words + k]!;
      }
      return out;
    };
    ch.edgeIdx.data = pack(ch.edgeIdx.data as Uint32Array, 2);
    if (this.hasEdgeStyles) ch.edgeStyle.data = pack(ch.edgeStyle.data as Uint32Array, 1);
    if (this.hasEdgeColors) ch.edgeColor.data = pack(ch.edgeColor.data as Uint32Array, 2);
    const tinted = this.edgeTinted;
    if (tinted) {
      const out = new Uint32Array(Math.ceil(n / 32));
      for (let i = 0; i < n0; i++) {
        const r = remap[i]!;
        if (r !== NO_INDEX && (tinted[i >>> 5]! & (1 << (i & 31))) !== 0) out[r >>> 5] = out[r >>> 5]! | (1 << (r & 31));
      }
      this.edgeTinted = out;
    }
    let removed = 0;
    if (this.edgeState) {
      const st = pack(this.edgeState, 1);
      for (let i = 0; i < n; i++) if ((st[i]! & EDGE_REMOVED) !== 0) removed++;
      this.edgeState = st;
    }
    const labels = this.edgeLabels;
    if (labels) {
      const out: string[] = new Array<string>(n).fill("");
      for (let i = 0; i < n0; i++) if (remap[i] !== NO_INDEX) out[remap[i]!] = labels[i] ?? "";
      this.edgeLabels = out;
    }
    this.removedEdges = removed;
    this.edgeCount = n;
    for (const c of [ch.edgeIdx, ch.edgeStyle, ch.edgeColor]) c.scattered.reset(n);
    this.edgeStateUploads.reset(n);
    this.reloadEdges();
  }

  listEdges(bit: number, out: Uint32Array, at: number): number {
    const st = this.edgeState;
    if (!st) return 0;
    const n = Math.min(this.edgeCount, st.length);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const s = st[i]!;
      if ((s & bit) === 0 || (s & EDGE_REMOVED) !== 0) continue;
      if (at + k < out.length) out[at + k] = i;
      k++;
    }
    return k;
  }

  retintEdges(tint: number): number {
    const mask = this.edgeTinted;
    if (!mask || !this.hasEdgeColors) return 0;
    const ch = this.channels.edgeColor;
    const co = ch.data as Uint32Array;
    const n = this.edgeCount;
    let count = 0;
    let run = -1;
    for (let i = 0; i < n; i++) {
      if ((mask[i >>> 5]! & (1 << (i & 31))) === 0) {
        if (run >= 0) this.markRange(ch, run, i);
        run = -1;
        continue;
      }
      co[i * 2] = tint;
      co[i * 2 + 1] = tint;
      count++;
      if (run < 0) run = i;
    }
    if (run >= 0) this.markRange(ch, run, n);
    if (count > 0) this.edgeRankWanted = true;
    return count;
  }

  private tintFrom(slots: number, from: number): void {
    const words = Math.ceil(slots / 32);
    let mask = this.edgeTinted;
    if (!mask || mask.length < words) {
      const next = new Uint32Array(words);
      if (mask) next.set(mask);
      mask = next;
      this.edgeTinted = mask;
    }
    for (let i = from; i < slots; i++) mask[i >>> 5] = mask[i >>> 5]! | (1 << (i & 31));
  }

  private tint(indices: Uint32Array): void {
    const mask = this.edgeTinted!;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j]!;
      mask[i >>> 5] = mask[i >>> 5]! | (1 << (i & 31));
    }
  }

  private untint(indices: Uint32Array): void {
    const mask = this.edgeTinted;
    if (!mask) return;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j]!;
      mask[i >>> 5] = mask[i >>> 5]! & ~(1 << (i & 31));
    }
  }

  private ensureEdgeState(): Uint32Array {
    const st = this.edgeState;
    if (st && st.length === this.edgeCount) return st;
    this.edgeState = st ? sized(st, this.edgeCount, 0) : new Uint32Array(this.edgeCount);
    return this.edgeState;
  }

  private stageEdgeState(indices: Uint32Array, st: Uint32Array): void {
    if (!this.edgeStateAll) this.edgeStateUploads.add(indices, gather(st, indices), 1, this.edgeCount);
    this.edgeRankWanted = true;
    this.anyDirty = true;
  }

  private checkEdges(indices: Uint32Array, name: string): void {
    for (let j = 0; j < indices.length; j++) {
      if (indices[j]! >= this.edgeCount) throw new RangeError(`${name}: index ${indices[j]} exceeds edge count ${this.edgeCount}`);
    }
  }

  /**
   * Re-upload every edge channel from these mirrors, which are still in the
   * user's order. Needed whenever the nodes are renumbered: the GPU copies hold
   * sorted, engine-indexed edges that are only valid for the old numbering.
   */
  reloadEdges(): void {
    for (const ch of [this.channels.edgeIdx, this.channels.edgeStyle, this.channels.edgeColor]) {
      ch.dirty.clear();
      ch.realloc = true;
    }
    this.anyDirty = true;
  }

  /** Partial position update: `data` holds xy pairs for nodes `start..`. */
  updatePositions(start: number, data: Float32Array): void {
    const pos = this.channels.nodePos;
    const count = data.length >> 1;
    if (start + count > this.nodeCount) throw new RangeError("updatePositions: range exceeds node count");
    (pos.data as Float32Array).set(data, start * 2);
    this.markRange(pos, start, start + count);
  }

  syncZIndex(zIndex: Uint8Array): void {
    const { STYLE_ZLAYER_SHIFT, STYLE_ZLAYER_MASK } = CONSTANTS;
    const style = this.channels.nodeStyle.data as Uint32Array;
    const keep = ~(STYLE_ZLAYER_MASK << STYLE_ZLAYER_SHIFT);
    let any = 0;
    for (let i = 0, n = Math.min(style.length, zIndex.length); i < n; i++) {
      const z = zIndex[i]!;
      const layer = z > STYLE_ZLAYER_MASK ? STYLE_ZLAYER_MASK : z;
      any |= layer;
      style[i] = (style[i]! & keep) | (layer << STYLE_ZLAYER_SHIFT);
    }
    this.hasZLayers = any !== 0;
  }

  updateColors(start: number, data: Uint32Array): void {
    const ch = this.channels.nodeColor;
    if (start + data.length > this.nodeCount) throw new RangeError("updateColors: range exceeds node count");
    (ch.data as Uint32Array).set(data, start);
    this.markRange(ch, start, start + data.length);
  }

  growBounds(x: number, y: number): void {
    const b = this.bounds;
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  }

  /**
   * Whole-array replacement always recreates the GPU buffer: `mappedAtCreation`
   * is the fastest bulk path, faster than a full-size writeBuffer.
   */
  private replace(ch: Channel, data: Uint32Array | Float32Array): void {
    ch.data = data;
    ch.dirty.clear();
    ch.scattered.reset(data.length / ch.words);
    ch.realloc = true;
    this.anyDirty = true;
  }

  private markRange(ch: Channel, start: number, end: number): void {
    ch.dirty.add(start, end);
    this.anyDirty = true;
  }

  private computeBounds(): void {
    const p = this.channels.nodePos.data as Float32Array;
    const st = this.channels.nodeState.data as Uint32Array;
    const hidden = CONSTANTS.STATE_HIDDEN;
    const b = this.bounds;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < this.nodeCount; i++) {
      if ((st[i]! & hidden) !== 0) continue;
      const x = p[i * 2]!;
      const y = p[i * 2 + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minX > maxX) {
      b.minX = b.minY = b.maxX = b.maxY = 0;
      return;
    }
    b.minX = minX;
    b.minY = minY;
    b.maxX = maxX;
    b.maxY = maxY;
  }
}

function u32(a: Uint32Array | Float32Array): Uint32Array {
  return a instanceof Uint32Array ? a : new Uint32Array(a.buffer, a.byteOffset, a.length);
}

function gather(words: Uint32Array, indices: Uint32Array): Uint32Array {
  const out = new Uint32Array(indices.length);
  for (let j = 0; j < indices.length; j++) out[j] = words[indices[j]!]!;
  return out;
}

function sized(prev: Uint32Array, length: number, fill: number): Uint32Array {
  return prev.length === length ? prev : resizeU32(prev, length, fill);
}

function scatterWords(dst: Uint32Array, indices: Uint32Array, words: Uint32Array, w: number): void {
  for (let j = 0; j < indices.length; j++) {
    for (let k = 0; k < w; k++) dst[indices[j]! * w + k] = words[j * w + k]!;
  }
}

function padU32(a: Uint32Array, length: number, fill: number): Uint32Array {
  if (a.length === length) return a;
  const out = new Uint32Array(length);
  out.set(a);
  if (fill !== 0) out.fill(fill, a.length);
  return out;
}

function padF32(a: Float32Array, length: number): Float32Array {
  if (a.length === length) return a;
  const out = new Float32Array(length);
  out.set(a);
  return out;
}

function resizeU32(prev: Uint32Array, length: number, fill: number): Uint32Array {
  const next = new Uint32Array(length);
  next.set(prev.length <= length ? prev : prev.subarray(0, length));
  if (prev.length < length) next.fill(fill, prev.length);
  return next;
}

function resizeF32(prev: Float32Array, length: number, fill: number): Float32Array {
  const next = new Float32Array(length);
  next.set(prev.length <= length ? prev : prev.subarray(0, length));
  if (prev.length < length && fill !== 0) next.fill(fill, prev.length);
  return next;
}
