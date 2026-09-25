/**
 * Worker-side SoA mirrors of every graph buffer, with dirty tracking.
 *
 * Mirrors are the arrays transferred from the main thread (zero copy) — they
 * double as the source for device-lost recovery (M9). The GPU never sees
 * strings or objects; node identity is the index.
 */
import { GraphError } from "../api/errors";
import { DirtyRanges } from "./DirtyRanges";
import { CONSTANTS, DEFAULT_NODE_STYLE, GRAPH_BINDINGS, GRAPH_BUFFER_WORDS, type GraphBufferName } from "./Layouts";
import { ICON_PALETTE_MAX, packIconColors, packNodeSizes, packNodeStyle, paletteIndices, toHalfBits, type PaletteIndices } from "./Pack";

export interface Channel {
  /** CPU mirror, `elementCount * words` 32-bit words. */
  data: Uint32Array | Float32Array;
  /** 32-bit words per element. */
  readonly words: number;
  /** Dirty element ranges awaiting upload. */
  readonly dirty: DirtyRanges;
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

export class GraphStore {
  nodeCount = 0;
  edgeCount = 0;
  /** Per-edge style words were supplied; otherwise every edge uses the global width. */
  hasEdgeStyles = false;
  /** Per-edge colours were supplied; otherwise every edge uses the global tint. */
  hasEdgeColors = false;
  hasNodeShapes = false;
  hasZLayers = false;
  hasIcons = false;
  iconPalette: Uint32Array = new Uint32Array([0xffffffff]);
  paletteVersion = 0;
  maxNodeSize = 0;
  /** Label text per node / edge, in the user's order; null when none were set. */
  nodeLabels: readonly string[] | null = null;
  edgeLabels: readonly string[] | null = null;
  readonly channels: Readonly<Record<GraphBufferName, Channel>>;
  /** World-space AABB of node positions; recomputed on bulk position writes. */
  readonly bounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private anyDirty = false;

  constructor() {
    const channels = {} as Record<GraphBufferName, Channel>;
    for (const b of GRAPH_BINDINGS) {
      const words = GRAPH_BUFFER_WORDS[b.name];
      const data = b.name === "nodePos" ? new Float32Array(0) : new Uint32Array(0);
      channels[b.name] = { data, words, dirty: new DirtyRanges(), realloc: true };
    }
    this.channels = channels;
    this.anyDirty = true;
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
    const resized = count !== this.nodeCount;
    const grown = count > this.nodeCount;
    this.nodeCount = count;
    const ch = this.channels;

    if (arrays.positions) this.replace(ch.nodePos, arrays.positions);
    else if (resized) this.replace(ch.nodePos, resizeF32(ch.nodePos.data as Float32Array, count * 2, 0));

    if (arrays.colors) this.replace(ch.nodeColor, arrays.colors);
    else if (resized) this.replace(ch.nodeColor, resizeU32(ch.nodeColor.data as Uint32Array, count, DEFAULT_NODE_COLOR));

    let size = ch.nodeSize.data as Uint32Array;
    if (arrays.sizes) {
      size = packNodeSizes(arrays.sizes, size);
      this.maxNodeSize = arrays.sizes.reduce((m, s) => Math.max(m, s), 0);
    } else if (resized) {
      size = resizeU32(size, count, toHalfBits(DEFAULT_NODE_SIZE));
      if (grown) this.maxNodeSize = Math.max(this.maxNodeSize, DEFAULT_NODE_SIZE);
    }
    if (palette) {
      size = packIconColors(size, palette.indices);
      this.setPalette(palette.palette);
    }
    if (size !== ch.nodeSize.data) this.replace(ch.nodeSize, size);

    if (arrays.shapes || arrays.zIndex || arrays.icons) {
      this.replace(ch.nodeStyle, packNodeStyle(count, ch.nodeStyle.data as Uint32Array, arrays.shapes, arrays.zIndex, arrays.icons));
      if (arrays.shapes) this.hasNodeShapes = arrays.shapes.some((s) => s !== 0);
      if (arrays.zIndex) this.hasZLayers = arrays.zIndex.some((z) => z !== 0);
      if (arrays.icons) this.hasIcons = arrays.icons.some((v) => v !== CONSTANTS.NO_ICON);
    } else if (resized) this.replace(ch.nodeStyle, resizeU32(ch.nodeStyle.data as Uint32Array, count, DEFAULT_NODE_STYLE));

    if (resized) this.replace(ch.nodeState, resizeU32(ch.nodeState.data as Uint32Array, count, 0));

    if (arrays.positions || resized) this.computeBounds();
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
    this.replace(ch.edgeStyle, arrays.styles ?? new Uint32Array(0));
    this.replace(ch.edgeColor, arrays.colors ?? new Uint32Array(0));
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
    for (let i = 0; i < style.length; i++) {
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
    ch.realloc = true;
    this.anyDirty = true;
  }

  private markRange(ch: Channel, start: number, end: number): void {
    ch.dirty.add(start, end);
    this.anyDirty = true;
  }

  private computeBounds(): void {
    const p = this.channels.nodePos.data as Float32Array;
    const b = this.bounds;
    if (this.nodeCount === 0) {
      b.minX = b.minY = b.maxX = b.maxY = 0;
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0, n = this.nodeCount * 2; i < n; i += 2) {
      const x = p[i]!;
      const y = p[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    b.minX = minX;
    b.minY = minY;
    b.maxX = maxX;
    b.maxY = maxY;
  }
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
