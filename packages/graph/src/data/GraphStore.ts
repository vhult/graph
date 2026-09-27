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
import { CONSTANTS, DEFAULT_NODE_STYLE, GRAPH_BINDINGS, GRAPH_BUFFER_WORDS, MAX_NODES, type GraphBufferName } from "./Layouts";
import { LookList } from "./LookList";
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
const NODE_GONE = CONSTANTS.STATE_REMOVED | CONSTANTS.STATE_HIDDEN;
const NO_STATE = new Uint32Array(0);

function directedBit(style: number): number {
  return (style & CONSTANTS.EDGE_FLAG_DIRECTED) !== 0 ? 1 : 0;
}

const LINE_BITS = (CONSTANTS.EDGE_PATTERN_MASK << CONSTANTS.EDGE_PATTERN_SHIFT) | CONSTANTS.EDGE_FLAG_TAPERED;

function lineBit(style: number): number {
  return (style & LINE_BITS) !== 0 ? 1 : 0;
}

function counted(state: number, bit: number): number {
  return (state & (bit | CONSTANTS.STATE_REMOVED)) === bit ? 1 : 0;
}

function lookPair(bits: readonly [number, number], gone: number): readonly [LookList, LookList] {
  return [new LookList(bits[0], gone), new LookList(bits[1], gone)];
}

export class GraphStore {
  nodeCount = 0;
  nodeSlots = 0;
  edgeCount = 0;
  /** Per-edge style words were supplied; otherwise every edge uses the global width. */
  hasEdgeStyles = false;
  /** Per-edge colours were supplied; otherwise every edge uses the global tint. */
  hasEdgeColors = false;
  directedEdges = 0;
  lineEdges = 0;
  hasNodeShapes = false;
  hasZLayers = false;
  hasIcons = false;
  iconPalette: Uint32Array = new Uint32Array([0xffffffff]);
  paletteVersion = 0;
  maxNodeSize = 0;
  hiddenCount = 0;
  dimmedCount = 0;
  readonly looks = {
    nodes: lookPair([CONSTANTS.STATE_SELECTED, CONSTANTS.STATE_FOCUSED], CONSTANTS.STATE_REMOVED),
    edges: lookPair([CONSTANTS.EDGE_STATE_SELECTED, CONSTANTS.EDGE_STATE_FOCUSED], CONSTANTS.EDGE_STATE_REMOVED),
  };
  /** Per-edge state bits, uploaded into the high bits of `edgeIdx`. */
  readonly edgeStateChannel: Channel = { data: NO_STATE, words: 1, dirty: new DirtyRanges(), scattered: new IndexUploads(), realloc: false };
  removedEdges = 0;
  edgeRankWanted = false;
  readonly channels: Readonly<Record<GraphBufferName, Channel>>;
  /** World-space AABB of node positions; recomputed on bulk position writes. */
  readonly bounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private anyDirty = false;
  private nodeMark = new Uint8Array(0);
  private edgeHits = new Uint32Array(64);

  constructor(readonly nodeReserve = 0) {
    const channels = {} as Record<GraphBufferName, Channel>;
    for (const b of GRAPH_BINDINGS) {
      const words = GRAPH_BUFFER_WORDS[b.name];
      const data = b.name === "nodePos" ? new Float32Array(0) : new Uint32Array(0);
      channels[b.name] = { data, words, dirty: new DirtyRanges(), scattered: new IndexUploads(), realloc: true };
    }
    this.channels = channels;
    this.anyDirty = true;
  }

  get edgeState(): Uint32Array | null {
    const st = this.edgeStateChannel.data as Uint32Array;
    return st.length > 0 ? st : null;
  }

  get liveEdges(): number {
    return this.edgeCount - this.removedEdges;
  }

  get hasDirected(): boolean {
    return this.directedEdges > 0;
  }

  get hasLinePatterns(): boolean {
    return this.lineEdges > 0;
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
  setNodes(count: number, arrays: NodeArrays): void {
    const palette = arrays.iconColors ? this.palette(arrays.iconColors, new Uint32Array(0)) : null;
    const total = this.withReserve(count);
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
      this.noteStyleFlags(arrays, false);
    } else if (resized) this.replace(ch.nodeStyle, resizeU32(ch.nodeStyle.data as Uint32Array, total, DEFAULT_NODE_STYLE));

    const st = new Uint32Array(total);
    st.fill(NODE_GONE, count);
    this.replace(ch.nodeState, st);
    this.hiddenCount = 0;
    this.dimmedCount = 0;
    this.looks.nodes[0].reset();
    this.looks.nodes[1].reset();

    this.computeBounds();
  }

  /** Node count for `slots` plus the reserve, at most `MAX_NODES`. */
  withReserve(slots: number): number {
    return Math.min(slots + this.nodeReserve, MAX_NODES);
  }

  /** True when an add that ends at `slots` takes new slots up to the last one. */
  needsGrowth(slots: number): boolean {
    return slots > this.nodeSlots && slots >= this.nodeCount && this.nodeCount < MAX_NODES;
  }

  growNodes(slots: number): void {
    const count = this.withReserve(slots);
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
    for (let j = 0; j < n; j++) this.setNodeState(st, indices[j]!, 0);
    compactLooks(this.looks.nodes, st);
    ch.scattered.add(indices);
    const pos = arrays.positions;
    if (pos) for (let j = 0; j < n; j++) this.growBounds(pos[j * 2]!, pos[j * 2 + 1]!);
    else if (n > 0) this.growBounds(0, 0);
  }

  removeNodes(indices: Uint32Array): Uint32Array {
    checkIndices(indices, this.nodeCount, "removeNodes", "node count");
    const ch = this.channels.nodeState;
    const st = ch.data as Uint32Array;
    if (this.nodeMark.length < this.nodeCount) this.nodeMark = new Uint8Array(this.nodeCount);
    const mark = this.nodeMark;
    for (let j = 0; j < indices.length; j++) {
      this.setNodeState(st, indices[j]!, NODE_GONE);
      mark[indices[j]!] = 1;
    }
    compactLooks(this.looks.nodes, st);
    ch.scattered.add(indices);
    this.anyDirty = true;

    const ends = this.channels.edgeIdx.data as Uint32Array;
    const es = this.edgeState;
    let hits = this.edgeHits;
    let k = 0;
    for (let e = 0; e < this.edgeCount; e++) {
      if (mark[ends[e * 2]!] !== 1 && mark[ends[e * 2 + 1]!] !== 1) continue;
      if (es && (es[e]! & CONSTANTS.EDGE_STATE_REMOVED) !== 0) continue;
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

  compactNodes(remap: Uint32Array): void {
    const n0 = Math.min(remap.length, this.nodeSlots);
    let n = 0;
    for (let i = 0; i < n0; i++) if (remap[i] !== NO_INDEX) n++;
    const total = this.withReserve(n);
    const ch = this.channels;
    const pack = (src: Uint32Array, words: number, fill: number): Uint32Array => packRemap(src, words, remap, n0, n, total, fill);
    this.replace(ch.nodePos, new Float32Array(pack(u32(ch.nodePos.data), 2, 0).buffer));
    this.replace(ch.nodeColor, pack(ch.nodeColor.data as Uint32Array, 1, DEFAULT_NODE_COLOR));
    this.replace(ch.nodeSize, pack(ch.nodeSize.data as Uint32Array, 1, toHalfBits(DEFAULT_NODE_SIZE)));
    this.replace(ch.nodeStyle, pack(ch.nodeStyle.data as Uint32Array, 1, DEFAULT_NODE_STYLE));
    this.replace(ch.nodeState, pack(ch.nodeState.data as Uint32Array, 1, NODE_GONE));
    this.nodeCount = total;
    this.recountNodes();
    const ends = ch.edgeIdx.data as Uint32Array;
    for (let e = 0; e < this.edgeCount; e++) {
      const a = remap[ends[e * 2]!] ?? NO_INDEX;
      const b = remap[ends[e * 2 + 1]!] ?? NO_INDEX;
      const kept = a !== NO_INDEX ? a : b !== NO_INDEX ? b : 0;
      ends[e * 2] = a !== NO_INDEX ? a : kept;
      ends[e * 2 + 1] = b !== NO_INDEX ? b : kept;
    }
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
    if (arrays.sizes || palette) this.writeRange(ch.nodeSize, start, this.sizeWords(arrays, (ch.nodeSize.data as Uint32Array).subarray(start, start + n), palette));
    if (arrays.shapes || arrays.zIndex || arrays.icons) {
      this.writeRange(ch.nodeStyle, start, packNodeStyle(n, ch.nodeStyle.data as Uint32Array, arrays.shapes, arrays.zIndex, arrays.icons, start));
      this.noteStyleFlags(arrays, true);
    }
  }

  updateNodesAt(indices: Uint32Array, arrays: NodeArrays): void {
    checkIndices(indices, this.nodeCount, "updateNodesAt", "node count");
    const palette = arrays.iconColors ? this.palette(arrays.iconColors, this.iconPalette) : null;
    const ch = this.channels;
    if (arrays.positions) this.writeAt(ch.nodePos, indices, arrays.positions);
    if (arrays.colors) this.writeAt(ch.nodeColor, indices, arrays.colors);
    if (arrays.sizes || palette) this.writeAt(ch.nodeSize, indices, this.sizeWords(arrays, gather(ch.nodeSize.data as Uint32Array, indices), palette));
    if (arrays.shapes || arrays.zIndex || arrays.icons) {
      this.writeAt(ch.nodeStyle, indices, packNodeStyle(indices.length, gather(ch.nodeStyle.data as Uint32Array, indices), arrays.shapes, arrays.zIndex, arrays.icons));
      this.noteStyleFlags(arrays, true);
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
    if (indices === null) {
      for (let i = 0; i < this.nodeCount; i++) if ((st[i]! & CONSTANTS.STATE_REMOVED) === 0) st[i] = ((st[i]! & keep) | set) >>> 0;
      this.recountNodes();
      if (this.nodeCount > 0) this.markRange(ch, 0, this.nodeCount);
      return;
    }
    checkIndices(indices, this.nodeCount, "flagNodes", "node count");
    for (let j = 0; j < indices.length; j++) this.setNodeState(st, indices[j]!, ((st[indices[j]!]! & keep) | set) >>> 0);
    compactLooks(this.looks.nodes, st);
    ch.scattered.add(indices);
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

  writePositionsAt(indices: Uint32Array, positions: Float32Array): void {
    this.writeAt(this.channels.nodePos, indices, positions);
  }

  private setNodeState(st: Uint32Array, i: number, next: number): void {
    const old = st[i]!;
    st[i] = next;
    this.hiddenCount += counted(next, CONSTANTS.STATE_HIDDEN) - counted(old, CONSTANTS.STATE_HIDDEN);
    this.dimmedCount += counted(next, CONSTANTS.STATE_DIMMED) - counted(old, CONSTANTS.STATE_DIMMED);
    this.looks.nodes[0].update(i, old, next);
    this.looks.nodes[1].update(i, old, next);
  }

  private recountNodes(): void {
    const st = this.channels.nodeState.data as Uint32Array;
    const [a, b] = this.looks.nodes;
    a.reset();
    b.reset();
    let hidden = 0;
    let dim = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      const s = st[i]!;
      hidden += counted(s, CONSTANTS.STATE_HIDDEN);
      dim += counted(s, CONSTANTS.STATE_DIMMED);
      a.update(i, 0, s);
      b.update(i, 0, s);
    }
    this.hiddenCount = hidden;
    this.dimmedCount = dim;
  }

  private writeAt(ch: Channel, indices: Uint32Array, values: Uint32Array | Float32Array): void {
    scatterWords(ch.data, indices, values, ch.words);
    ch.scattered.add(indices);
    this.anyDirty = true;
  }

  private noteStyleFlags(a: NodeArrays, merge: boolean): void {
    if (a.shapes) this.hasNodeShapes = (merge && this.hasNodeShapes) || a.shapes.some((s) => s !== 0);
    if (a.zIndex) this.hasZLayers = (merge && this.hasZLayers) || a.zIndex.some((z) => z !== 0);
    if (a.icons) this.hasIcons = (merge && this.hasIcons) || a.icons.some((v) => v !== CONSTANTS.NO_ICON);
  }

  private sizeWords(arrays: NodeArrays, current: Uint32Array, palette: PaletteIndices | null): Uint32Array {
    let size = current;
    if (arrays.sizes) {
      size = packNodeSizes(arrays.sizes, current);
      this.maxNodeSize = arrays.sizes.reduce((m, s) => Math.max(m, s), this.maxNodeSize);
    }
    if (palette) {
      size = packIconColors(size, palette.indices);
      this.setPalette(palette.palette);
    }
    return size;
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
    this.edgeCount = count;
    const ch = this.channels;

    this.replace(ch.edgeIdx, arrays.indices ?? sized(ch.edgeIdx.data as Uint32Array, count * 2, 0));

    // Uniform edges upload NOTHING for style or colour: the shader variant that
    // reads them is not compiled, and the buffers stay at their minimum size.
    // At 30M edges that is 360 MB not allocated, which matters on an iGPU.
    this.hasEdgeStyles = arrays.styles !== undefined;
    this.hasEdgeColors = arrays.colors !== undefined;
    this.replace(ch.edgeStyle, arrays.styles ?? new Uint32Array(0));
    this.replace(ch.edgeColor, arrays.colors ?? new Uint32Array(0));
    const es = this.edgeStateChannel;
    es.data = NO_STATE;
    es.dirty.clear();
    es.scattered.reset(count);
    this.looks.edges[0].reset();
    this.looks.edges[1].reset();
    this.removedEdges = 0;
    this.edgeRankWanted = false;
    this.countStyles();
  }

  addEdges(indices: Uint32Array, slots: number, arrays: EdgeArrays): void {
    const ch = this.channels;
    const { indices: ends, styles, colors } = arrays;
    const idx = sized(ch.edgeIdx.data as Uint32Array, slots * 2, 0);
    const st = styles || this.hasEdgeStyles ? sized(ch.edgeStyle.data as Uint32Array, slots, 0) : null;
    const co = colors || this.hasEdgeColors ? sized(ch.edgeColor.data as Uint32Array, slots * 2, 0) : null;
    const es = this.edgeState ? sized(this.edgeState, slots, 0) : null;
    let removed = this.removedEdges;
    let directed = this.directedEdges;
    let line = this.lineEdges;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j]!;
      idx[i * 2] = ends ? ends[j * 2]! : 0;
      idx[i * 2 + 1] = ends ? ends[j * 2 + 1]! : 0;
      const gone = es !== null && (es[i]! & CONSTANTS.EDGE_STATE_REMOVED) !== 0;
      if (es) this.setEdgeState(es, i, 0);
      if (gone) removed--;
      if (st) {
        const w = styles ? styles[j]! : 0;
        directed += directedBit(w) - (gone ? 0 : directedBit(st[i]!));
        line += lineBit(w) - (gone ? 0 : lineBit(st[i]!));
        st[i] = w;
      }
      if (co) {
        co[i * 2] = colors ? colors[j * 2]! : 0;
        co[i * 2 + 1] = colors ? colors[j * 2 + 1]! : 0;
      }
    }
    ch.edgeIdx.data = idx;
    if (st) ch.edgeStyle.data = st;
    if (co) ch.edgeColor.data = co;
    this.hasEdgeStyles = st !== null;
    this.hasEdgeColors = co !== null;
    if (es) {
      this.edgeStateChannel.data = es;
      compactLooks(this.looks.edges, es);
    }
    this.removedEdges = removed;
    this.directedEdges = directed;
    this.lineEdges = line;
    this.edgeCount = slots;
    this.reloadEdges();
  }

  hideEdges(indices: Uint32Array): void {
    checkIndices(indices, this.edgeCount, "hideEdges", "edge count");
    const st = this.ensureEdgeState();
    const sw = this.hasEdgeStyles ? (this.channels.edgeStyle.data as Uint32Array) : null;
    const hide = CONSTANTS.EDGE_STATE_REMOVED | CONSTANTS.EDGE_STATE_HIDDEN;
    let removed = this.removedEdges;
    let directed = this.directedEdges;
    let line = this.lineEdges;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j]!;
      if ((st[i]! & CONSTANTS.EDGE_STATE_REMOVED) === 0) {
        removed++;
        if (sw) {
          directed -= directedBit(sw[i]!);
          line -= lineBit(sw[i]!);
        }
      }
      this.setEdgeState(st, i, (st[i]! | hide) >>> 0);
    }
    this.removedEdges = removed;
    this.directedEdges = directed;
    this.lineEdges = line;
    this.stageEdgeState(st, indices);
  }

  flagEdges(indices: Uint32Array | null, flags: number, on: boolean): void {
    if (indices) checkIndices(indices, this.edgeCount, "flagEdges", "edge count");
    const st = this.ensureEdgeState();
    const bits = edgeStateBits(flags);
    const keep = on ? 0xffffffff : ~bits >>> 0;
    const set = on ? bits : 0;
    const next = (s: number): number => {
      const n = (s & keep) | set;
      return ((n & CONSTANTS.EDGE_STATE_REMOVED) !== 0 ? n | CONSTANTS.EDGE_STATE_HIDDEN : n) >>> 0;
    };
    if (indices === null) {
      for (let i = 0; i < this.edgeCount; i++) st[i] = next(st[i]!);
      this.relistEdges(st, this.edgeCount);
      this.markRange(this.edgeStateChannel, 0, this.edgeCount);
      this.edgeRankWanted = true;
      return;
    }
    for (let j = 0; j < indices.length; j++) this.setEdgeState(st, indices[j]!, next(st[indices[j]!]!));
    this.stageEdgeState(st, indices);
  }

  updateEdgesAt(indices: Uint32Array, arrays: EdgeArrays): void {
    checkIndices(indices, this.edgeCount, "updateEdgesAt", "edge count");
    const ch = this.channels;
    const reload = arrays.indices !== undefined || (arrays.styles !== undefined && !this.hasEdgeStyles) || (arrays.colors !== undefined && !this.hasEdgeColors);
    if (arrays.styles) this.restyleEdges(indices, arrays.styles);
    if (!reload) {
      if (arrays.styles) this.writeAt(ch.edgeStyle, indices, arrays.styles);
      if (arrays.colors) this.writeAt(ch.edgeColor, indices, arrays.colors);
      this.edgeRankWanted = true;
      return;
    }
    if (arrays.indices) scatterWords(ch.edgeIdx.data as Uint32Array, indices, arrays.indices, 2);
    if (arrays.colors) {
      if (!this.hasEdgeColors) ch.edgeColor.data = new Uint32Array(this.edgeCount * 2);
      scatterWords(ch.edgeColor.data as Uint32Array, indices, arrays.colors, 2);
      this.hasEdgeColors = true;
    }
    this.edgeRankWanted ||= arrays.styles !== undefined || arrays.colors !== undefined;
    this.reloadEdges();
  }

  updateEdges(arrays: EdgeArrays): void {
    const ch = this.channels;
    const reload = arrays.indices !== undefined || (arrays.styles !== undefined && !this.hasEdgeStyles) || (arrays.colors !== undefined && !this.hasEdgeColors);
    if (!reload) {
      if (arrays.styles) this.writeRange(ch.edgeStyle, 0, arrays.styles);
      if (arrays.colors) {
        (ch.edgeColor.data as Uint32Array).set(arrays.colors);
        this.markRange(ch.edgeColor, 0, this.edgeCount);
      }
      this.edgeRankWanted = true;
    } else {
      if (arrays.indices) ch.edgeIdx.data = arrays.indices;
      if (arrays.styles) ch.edgeStyle.data = arrays.styles;
      if (arrays.colors) ch.edgeColor.data = arrays.colors;
      this.hasEdgeStyles ||= arrays.styles !== undefined;
      this.hasEdgeColors ||= arrays.colors !== undefined;
      this.reloadEdges();
    }
    if (arrays.styles) this.countStyles();
  }

  compactEdges(remap: Uint32Array): void {
    const n0 = Math.min(remap.length, this.edgeCount);
    let n = 0;
    for (let i = 0; i < n0; i++) if (remap[i] !== NO_INDEX) n++;
    const ch = this.channels;
    const pack = (src: Uint32Array, words: number): Uint32Array => packRemap(src, words, remap, n0, n, n, 0);
    ch.edgeIdx.data = pack(ch.edgeIdx.data as Uint32Array, 2);
    if (this.hasEdgeStyles) ch.edgeStyle.data = pack(ch.edgeStyle.data as Uint32Array, 1);
    if (this.hasEdgeColors) ch.edgeColor.data = pack(ch.edgeColor.data as Uint32Array, 2);
    let removed = 0;
    if (this.edgeState) {
      const st = pack(this.edgeState, 1);
      for (let i = 0; i < n; i++) if ((st[i]! & CONSTANTS.EDGE_STATE_REMOVED) !== 0) removed++;
      this.edgeStateChannel.data = st;
      this.relistEdges(st, n);
    }
    this.removedEdges = removed;
    this.edgeCount = n;
    this.countStyles();
    for (const c of [ch.edgeIdx, ch.edgeStyle, ch.edgeColor, this.edgeStateChannel]) c.scattered.reset(n);
    this.reloadEdges();
  }

  private setEdgeState(st: Uint32Array, i: number, next: number): void {
    const old = st[i]!;
    st[i] = next;
    this.looks.edges[0].update(i, old, next);
    this.looks.edges[1].update(i, old, next);
  }

  private relistEdges(st: Uint32Array, n: number): void {
    const [a, b] = this.looks.edges;
    a.reset();
    b.reset();
    for (let i = 0; i < n; i++) {
      a.update(i, 0, st[i]!);
      b.update(i, 0, st[i]!);
    }
  }

  private restyleEdges(indices: Uint32Array, styles: Uint32Array): void {
    const ch = this.channels.edgeStyle;
    if (!this.hasEdgeStyles) ch.data = new Uint32Array(this.edgeCount);
    this.hasEdgeStyles = true;
    const st = ch.data as Uint32Array;
    const es = this.edgeState;
    let directed = this.directedEdges;
    let line = this.lineEdges;
    for (let j = 0; j < indices.length; j++) {
      const i = indices[j]!;
      const w = styles[j]!;
      if (es === null || (es[i]! & CONSTANTS.EDGE_STATE_REMOVED) === 0) {
        directed += directedBit(w) - directedBit(st[i]!);
        line += lineBit(w) - lineBit(st[i]!);
      }
      st[i] = w;
    }
    this.directedEdges = directed;
    this.lineEdges = line;
  }

  private countStyles(): void {
    const st = this.channels.edgeStyle.data as Uint32Array;
    const es = this.edgeState;
    const n = this.hasEdgeStyles ? Math.min(this.edgeCount, st.length) : 0;
    let directed = 0;
    let line = 0;
    for (let i = 0; i < n; i++) {
      if (es !== null && (es[i]! & CONSTANTS.EDGE_STATE_REMOVED) !== 0) continue;
      directed += directedBit(st[i]!);
      line += lineBit(st[i]!);
    }
    this.directedEdges = directed;
    this.lineEdges = line;
  }

  private ensureEdgeState(): Uint32Array {
    const st = sized(this.edgeStateChannel.data as Uint32Array, this.edgeCount, 0);
    this.edgeStateChannel.data = st;
    return st;
  }

  private stageEdgeState(st: Uint32Array, indices: Uint32Array): void {
    compactLooks(this.looks.edges, st);
    this.edgeStateChannel.scattered.add(indices);
    this.edgeRankWanted = true;
    this.anyDirty = true;
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

function compactLooks(looks: readonly [LookList, LookList], st: Uint32Array): void {
  looks[0].compact(st);
  looks[1].compact(st);
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

function checkIndices(indices: Uint32Array, limit: number, name: string, what: string): void {
  for (let j = 0; j < indices.length; j++) {
    if (indices[j]! >= limit) throw new RangeError(`${name}: index ${indices[j]} exceeds ${what} ${limit}`);
  }
}

function packRemap(src: Uint32Array, words: number, remap: Uint32Array, n0: number, n: number, total: number, fill: number): Uint32Array {
  const out = new Uint32Array(total * words);
  if (fill !== 0) out.fill(fill, n * words);
  for (let i = 0; i < n0; i++) {
    const r = remap[i]!;
    if (r !== NO_INDEX) for (let k = 0; k < words; k++) out[r * words + k] = src[i * words + k]!;
  }
  return out;
}

function scatterWords(dst: Uint32Array | Float32Array, indices: Uint32Array, words: Uint32Array | Float32Array, w: number): void {
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
