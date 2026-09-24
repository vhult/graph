/**
 * Single source of truth for every GPU-visible layout: struct byte layouts, the
 * binding contract, bit-packing constants and override constants.
 *
 * `src/shaders/common/layouts.wgsl` is GENERATED from this file by
 * `npm run gen` (also part of `npm run build`). Never hand-edit the WGSL side.
 */

// ---------------------------------------------------------------------------
// Struct layout math (WGSL host-shareable rules)
// ---------------------------------------------------------------------------

export type WgslType = "f32" | "u32" | "i32" | "vec2<f32>" | "vec2<u32>" | "vec4<f32>" | "vec4<u32>";

const TYPE_INFO: Record<WgslType, { size: number; align: number }> = {
  f32: { size: 4, align: 4 },
  u32: { size: 4, align: 4 },
  i32: { size: 4, align: 4 },
  "vec2<f32>": { size: 8, align: 8 },
  "vec2<u32>": { size: 8, align: 8 },
  "vec4<f32>": { size: 16, align: 16 },
  "vec4<u32>": { size: 16, align: 16 },
};

export interface FieldDef<N extends string = string> {
  readonly name: N;
  readonly type: WgslType;
  readonly doc?: string;
}

export interface StructLayout<N extends string = string> {
  readonly name: string;
  readonly fields: readonly (FieldDef<N> & { readonly offset: number })[];
  /** Byte offset of each field. */
  readonly offset: Readonly<Record<N, number>>;
  readonly size: number;
  readonly align: number;
}

const roundUp = (v: number, a: number): number => Math.ceil(v / a) * a;

export function defineStruct<const F extends readonly FieldDef[]>(
  name: string,
  fields: F,
): StructLayout<F[number]["name"]> {
  let cursor = 0;
  let align = 1;
  const out: (FieldDef & { offset: number })[] = [];
  const offset: Record<string, number> = {};
  for (const f of fields) {
    const info = TYPE_INFO[f.type];
    cursor = roundUp(cursor, info.align);
    out.push({ ...f, offset: cursor });
    offset[f.name] = cursor;
    cursor += info.size;
    align = Math.max(align, info.align);
  }
  return { name, fields: out, offset, size: roundUp(cursor, align), align } as unknown as StructLayout<F[number]["name"]>;
}

// ---------------------------------------------------------------------------
// @group(0) Frame uniform
// ---------------------------------------------------------------------------

export const FRAME = defineStruct("Frame", [
  { name: "originHi", type: "vec2<f32>", doc: "camera centre, high part" },
  { name: "originLo", type: "vec2<f32>", doc: "camera centre, low part" },
  { name: "scale", type: "vec2<f32>", doc: "world units -> NDC, includes aspect" },
  { name: "rotation", type: "vec2<f32>", doc: "cos, sin" },
  { name: "viewportPx", type: "vec2<f32>" },
  { name: "invViewportPx", type: "vec2<f32>" },
  { name: "pixelRatio", type: "f32" },
  { name: "zoom", type: "f32", doc: "device px per world unit" },
  { name: "time", type: "f32", doc: "seconds since init, for animated hooks" },
  { name: "frameIndex", type: "u32" },
  { name: "pointerPx", type: "vec2<f32>", doc: "cursor, device px; (-1,-1) if outside" },
  { name: "rasterDim", type: "vec2<u32>", doc: "accumulation buffer dimensions" },
  { name: "nodeCount", type: "u32" },
  { name: "edgeCount", type: "u32" },
  { name: "globalNodeScale", type: "f32" },
  { name: "globalEdgeWidth", type: "f32" },
  { name: "flags", type: "u32", doc: "FRAME_* bits" },
  { name: "globalEdgeColor", type: "u32", doc: "rgba8unorm tint for edges with no per-edge colour" },
] as const);

// ---------------------------------------------------------------------------
// Binding contract — PUBLIC API, versioned
// ---------------------------------------------------------------------------

/** 2: the trailing `_pad` word became `globalEdgeColor` (same offset, same size). */
export const BINDING_CONTRACT_VERSION = 2;

export const GROUP_FRAME = 0;
export const GROUP_GRAPH = 1;
export const GROUP_PASS = 2;
export const GROUP_USER = 3;

export type BindingKind = "uniform" | "sampler" | "storage-read";

export interface BindingDef {
  readonly binding: number;
  readonly name: string;
  readonly kind: BindingKind;
  /** WGSL declaration type (struct name, `sampler`, or array type). */
  readonly wgslType: string;
  readonly doc?: string;
}

export const FRAME_BINDINGS = [
  { binding: 0, name: "frame", kind: "uniform", wgslType: "Frame" },
  { binding: 1, name: "samp_linear", kind: "sampler", wgslType: "sampler" },
  { binding: 2, name: "samp_nearest", kind: "sampler", wgslType: "sampler" },
] as const satisfies readonly BindingDef[];

/** Graph data buffers, in binding order. Names double as GPU buffer ids. */
export const GRAPH_BINDINGS = [
  { binding: 0, name: "nodePos", kind: "storage-read", wgslType: "array<vec2<f32>>" },
  { binding: 1, name: "nodeStyle", kind: "storage-read", wgslType: "array<u32>" },
  { binding: 2, name: "nodeSize", kind: "storage-read", wgslType: "array<u32>", doc: "2 x f16 packed (size, ringWidth)" },
  { binding: 3, name: "nodeColor", kind: "storage-read", wgslType: "array<u32>", doc: "rgba8unorm" },
  { binding: 4, name: "nodeState", kind: "storage-read", wgslType: "array<u32>", doc: "STATE_* bits" },
  { binding: 5, name: "edgeIdx", kind: "storage-read", wgslType: "array<vec2<u32>>" },
  { binding: 6, name: "edgeStyle", kind: "storage-read", wgslType: "array<u32>" },
  { binding: 7, name: "edgeColor", kind: "storage-read", wgslType: "array<u32>" },
] as const satisfies readonly BindingDef[];

export type GraphBufferName = (typeof GRAPH_BINDINGS)[number]["name"];

/** 32-bit words per element for each graph buffer. */
export const GRAPH_BUFFER_WORDS: Readonly<Record<GraphBufferName, number>> = {
  nodePos: 2,
  nodeStyle: 1,
  nodeSize: 1,
  nodeColor: 1,
  nodeState: 1,
  edgeIdx: 2,
  edgeStyle: 1,
  edgeColor: 2,
};

// ---------------------------------------------------------------------------
// Bit-packing constants
// ---------------------------------------------------------------------------

export const CONSTANTS = {
  // nodeState bits
  STATE_HOVERED: 1 << 0,
  STATE_SELECTED: 1 << 1,
  STATE_DIMMED: 1 << 2,
  STATE_HIDDEN: 1 << 3,
  STATE_NEIGHBOR: 1 << 4,
  STATE_DRAGGING: 1 << 5,
  STATE_FOREGROUND_MASK: (1 << 0) | (1 << 1) | (1 << 5),
  STATE_GROUP_SHIFT: 8,
  // nodeStyle fields
  STYLE_SHAPE_MASK: 0xff,
  STYLE_ICON_SHIFT: 8,
  STYLE_ICON_MASK: 0xffff,
  STYLE_ZLAYER_SHIFT: 24,
  STYLE_ZLAYER_MASK: 0xf,
  Z_LAYERS: 16,
  STYLE_FLAGS_SHIFT: 28,
  STYLE_FLAG_RING: 1 << 28,
  STYLE_FLAG_LABEL: 1 << 29,
  STYLE_FLAG_PINNED: 1 << 30,
  NO_ICON: 0xffff,
  SHAPE_CIRCLE: 0,
  SHAPE_SQUARE: 1,
  SHAPE_HEXAGON: 2,
  INSTANCE_SHAPE_BITS: 0xf,
  INSTANCE_LAYER_SHIFT: 4,
  INSTANCE_LAYER_BITS: 0xf0,
  // edgeStyle fields
  EDGE_WIDTH_MASK: 0xff,
  EDGE_CURVE_SHIFT: 8,
  EDGE_CURVE_MASK: 0xf,
  EDGE_CURVATURE_SHIFT: 12,
  EDGE_CURVATURE_MASK: 0xff,
  EDGE_ZLAYER_SHIFT: 20,
  EDGE_CAP_SHIFT: 24,
  EDGE_FLAG_DIRECTED: 1 << 28,
  EDGE_FLAG_DASHED: 1 << 29,
  /** Width unit of the edgeStyle low byte: 1/8 device px. */
  EDGE_WIDTH_SCALE: 8,
} as const;

/** Default nodeStyle word: shape 0 (circle), no icon, layer 0, no flags. */
export const DEFAULT_NODE_STYLE = CONSTANTS.NO_ICON << CONSTANTS.STYLE_ICON_SHIFT;

// ---------------------------------------------------------------------------
// Engine-internal layouts (@group(2), NOT public contract)
// ---------------------------------------------------------------------------

/**
 * One visible node, written by TRANSFORM_CULL in draw order and read by the
 * node vertex shader with a single 16-byte load (no index indirection).
 */
export const NODE_INSTANCE = defineStruct("NodeInstance", [
  { name: "screenPos", type: "vec2<f32>", doc: "device px" },
  { name: "radiusPx", type: "f32", doc: "projected radius, device px; low INSTANCE_SHAPE_BITS mantissa bits hold the shape, INSTANCE_LAYER_BITS the z layer" },
  { name: "color", type: "u32", doc: "rgba8unorm" },
] as const);

/**
 * Spatial bounds of one chunk of CHUNK_SIZE consecutive engine-order nodes.
 * Engine order is Morton order, so a chunk is spatially compact and one test
 * rejects all of its nodes without reading them (docs/decisions.md).
 */
export const CHUNK_BOUNDS = defineStruct("ChunkBounds", [
  { name: "lo", type: "vec2<f32>", doc: "min node centre, world" },
  { name: "hi", type: "vec2<f32>", doc: "max node centre, world" },
  { name: "maxSize", type: "f32", doc: "largest diameter, world, before globalNodeScale" },
  { name: "flags", type: "u32", doc: "CHUNK_FLAG_* bits" },
] as const);

/**
 * One chunk of EDGE_CHUNK_SIZE consecutive edges, as the edge cull sees it.
 * Edges are sorted by (length level, midpoint Z-order) and shuffled within the
 * chunk, so a chunk holds edges of similar length in one area, its box is
 * tight, its longest edge says how long all of them are on screen, and any
 * prefix of it is a random sample of it.
 */
export const EDGE_CHUNK = defineStruct("EdgeChunk", [
  { name: "lo", type: "vec2<f32>", doc: "min endpoint, world" },
  { name: "hi", type: "vec2<f32>", doc: "max endpoint, world" },
  { name: "maxLen", type: "f32", doc: "longest edge, world units" },
  { name: "maxWidthPx", type: "f32", doc: "widest per-edge style width, device px; 0 = none" },
  { name: "density", type: "f32", doc: "edge length per area where this length level lies, 1/world" },
  { name: "_pad", type: "f32" },
  { name: "midLo", type: "vec2<f32>" },
  { name: "midHi", type: "vec2<f32>" },
] as const);

/**
 * Edge state buffer, in u32 words (C = edge chunks):
 *   [EDGE_SCRATCH_DRAW_ARGS]      drawIndirect args: one quad per drawn edge
 *   [EDGE_SCRATCH_DISPATCH]       dispatchIndirect args: one workgroup per listed chunk
 *   [EDGE_SCRATCH_LIST_COUNT]     chunks listed this frame
 *   [EDGE_SCRATCH_LIST]           C listed chunk ids,
 *                             C + 1 offsets of each listed chunk's edges in the draw list,
 *                             C × EdgeChunk,
 *                             MOVE_LIST + C: edge chunks holding a dragged node's edges
 */
export const EDGE_CONSTANTS = {
  /** Edges per chunk: one bounds record, one cull decision. */
  EDGE_CHUNK_SIZE: 1024,
  EDGE_CHUNK_SHIFT: 10,
  EDGE_CHUNK_WORDS: 12,
  /** Sort-key bits for the length level: 16 octaves of length / graph extent. */
  EDGE_LEVEL_BITS: 4,
  EDGE_SCRATCH_DRAW_ARGS: 0,
  EDGE_SCRATCH_DISPATCH: 4,
  EDGE_SCRATCH_LIST_COUNT: 7,
  EDGE_SCRATCH_LIST: 8,
} as const;

export const LABEL_PARAMS = defineStruct("LabelParams", [
  { name: "textH", type: "f32" },
  { name: "labelH", type: "f32" },
  { name: "gap", type: "f32" },
  { name: "padding", type: "f32" },
  { name: "maxHalfW", type: "f32" },
  { name: "maxHalfH", type: "f32" },
  { name: "minEdgeW", type: "f32" },
  { name: "labelArea", type: "f32" },
  { name: "cellW", type: "f32" },
  { name: "bonus", type: "f32" },
  { name: "fadeS", type: "f32" },
  { name: "glyphTable", type: "u32" },
  { name: "gridW", type: "u32" },
  { name: "gridH", type: "u32" },
  { name: "capacity", type: "u32" },
  { name: "chunks", type: "u32" },
  { name: "levels", type: "u32" },
  { name: "nodeCount", type: "u32" },
  { name: "edgeChunks", type: "u32" },
  { name: "edgeLevels", type: "u32" },
  { name: "edgeCount", type: "u32" },
  { name: "bitsOffset", type: "u32" },
  { name: "liveCount", type: "u32" },
] as const);

export const LABEL_CANDIDATE = defineStruct("LabelCandidate", [
  { name: "center", type: "vec2<f32>" },
  { name: "halfW", type: "f32" },
  { name: "halfH", type: "f32" },
  { name: "rank", type: "f32" },
  { name: "index", type: "u32" },
  { name: "size", type: "f32" },
] as const);

export const LIVE_LABEL = defineStruct("LiveLabel", [
  { name: "index", type: "u32" },
  { name: "slot", type: "u32" },
  { name: "run", type: "u32" },
  { name: "start", type: "f32" },
  { name: "fadeOut", type: "u32" },
] as const);

export const LABEL_CONSTANTS = {
  LABEL_NONE: 0xffffffff,
  LABEL_EDGE_BIT: 0x80000000,
  LABEL_GLYPHS: 32,
  LABEL_TREE_TOP: 16,
  LABEL_ROUNDS: 8,
  LABEL_NEIGHBOURS: 48,
  LABEL_LANES: 8,
  LABEL_SHOWN_MAX: 4096,
  LABEL_SLOTS: 8192,
  LABEL_GLYPH_MAX: 8192,
  WORK_CANDIDATES: 0,
  WORK_JOBS: 1,
  WORK_SHOWN: 2,
  WORK_ROUND: 3,
  WORK_EDGE_JOBS: 12,
  WORK_MAX_HALF_W: 13,
  WORK_MAX_HALF_H: 14,
  WORK_JOB_LIST: 16,
  LABEL_EDGE_PARTS: 2,
  LABEL_LIST_PARTS: 4,
  ARGS_JOBS: 0,
  ARGS_EDGE_JOBS: 1,
  ARGS_LISTS: 3,
  ARGS_ROUND: 7,
} as const;

export const PICK_PARAMS = defineStruct("PickParams", [
  { name: "pointer", type: "vec2<f32>" },
  { name: "radiusPx", type: "f32" },
  { name: "flags", type: "u32" },
  { name: "edgeRadiusPx", type: "f32" },
] as const);

export const PICK_CONSTANTS = {
  PICK_NODE_COUNT: 0,
  PICK_EDGE_BEST: 1,
  PICK_NODE_RESULT: 2,
  PICK_EDGE_RESULT: 3,
  PICK_EDGE_COUNT: 4,
  PICK_NODE_SCALE: 5,
  PICK_NODE_ENGINE: 6,
  PICK_LIST: 8,
  PICK_FLAG_NODES: 1,
  PICK_FLAG_EDGES: 2,
  PICK_FLAG_SHAPES: 4,
  PICK_FLAG_EDGE_COLORS: 8,
  PICK_FLAG_LAYERS: 16,
  PICK_LAYER_SHIFT: 27,
  HOVER_FLAG_SHAPES: 1,
} as const;

export const HOVER_PARAMS = defineStruct("HoverParams", [
  { name: "node", type: "u32" },
  { name: "lodScale", type: "f32" },
  { name: "nodeGrow", type: "f32" },
  { name: "nodeColor", type: "u32" },
  { name: "edgeA", type: "u32" },
  { name: "edgeB", type: "u32" },
  { name: "edgeStyle", type: "u32" },
  { name: "edgeColor", type: "u32" },
  { name: "edgeWidth", type: "f32" },
  { name: "flags", type: "u32" },
] as const);

export function pickOutWords(nodeCount: number, edgeCount: number): number {
  return PICK_CONSTANTS.PICK_LIST + 2 * Math.max(1, chunkCount(nodeCount), edgeChunkCount(edgeCount));
}

export function edgeChunkCount(edgeCount: number): number {
  return Math.ceil(edgeCount / EDGE_CONSTANTS.EDGE_CHUNK_SIZE);
}

/** Words in the edge state buffer for `edgeCount` edges. */
export function edgeScratchWords(edgeCount: number): number {
  const c = edgeChunkCount(edgeCount);
  return edgeMoveWordOffset(edgeCount) + ENGINE_CONSTANTS.MOVE_LIST + c;
}

export function edgeMoveWordOffset(edgeCount: number): number {
  const c = edgeChunkCount(edgeCount);
  return EDGE_CONSTANTS.EDGE_SCRATCH_LIST + c + (c + 1) + EDGE_CONSTANTS.EDGE_CHUNK_WORDS * c;
}

/**
 * Buckets. Each visible node lands in exactly one.
 *
 * Draw order interleaves chunks: instances are ordered by (segment within the
 * chunk, scrambled chunk position, engine index), so consecutive draws come from
 * far-apart chunks every DRAW_SEGMENT nodes (overlapping blended quads are not
 * issued back to back) while each node's place depends only on its own index
 * (stable frame to frame: overlapping nodes never swap).
 *
 * The cull state buffer packs, in u32 words (C = chunks, S = segments/chunk):
 *   [SCRATCH_DRAW_ARGS]   NUM_BUCKETS × drawIndirect args (4 words each)
 *   [SCRATCH_BUCKET_BASE] NUM_BUCKETS × first instance slot of each bucket
 *   [SCRATCH_LIST_COUNT]  number of chunks with ≥ 1 visible node
 *   [SCRATCH_CHUNKS]      (S + NUM_BUCKETS − 1)·C cell counts, in draw order (see cull_state.wgsl),
 *                         the same number of cell offsets (= draw slots),
 *                         ceil(cells / CHUNK_SIZE) scan block sums,
 *                         C visible-node totals per chunk,
 *                         C list of non-empty chunk ids,
 *                         C × ChunkBounds (CHUNK_BOUNDS_WORDS words each),
 *                         ceil(N / 32) labelled node bits
 */
export const ENGINE_CONSTANTS = {
  BUCKET_NORMAL: 0,
  BUCKET_FOREGROUND: 1,
  BUCKET_TINY: 2,
  BUCKET_CLUSTER: 3,
  BUCKET_CULLED: 0xf,
  NUM_BUCKETS: 4,
  /** Nodes per thread in chunked passes (measured: −20 % on the full scan vs 1). */
  ITEMS_PER_THREAD: 4,
  /** WORKGROUP_SIZE × ITEMS_PER_THREAD: one workgroup per chunk. */
  CHUNK_SIZE: 1024,
  /** Nodes per draw-order segment; divides WORKGROUP_SIZE. Chosen by measurement. */
  DRAW_SEGMENT: 16,
  CHUNK_FLAG_FOREGROUND: 1,
  CHUNK_BOUNDS_WORDS: 6,
  SCRATCH_DRAW_ARGS: 0,
  SCRATCH_BUCKET_BASE: 16,
  SCRATCH_LIST_COUNT: 20,
  SCRATCH_CHUNKS: 32,
  /** Radix sort digit width and bin count. */
  RADIX_BITS: 4,
  RADIX_BINS: 16,
  MOVE_COUNT: 0,
  MOVE_NODE: 1,
  MOVE_LIST: 2,
  MOVE_GROUPS: 256,
} as const;

/** Workgroup size used by every engine compute pass (matches the WORKGROUP_SIZE override default). */
export const WORKGROUP_SIZE = 256;

export function chunkCount(nodeCount: number): number {
  return Math.ceil(nodeCount / ENGINE_CONSTANTS.CHUNK_SIZE);
}

/** Words in the cull scratch buffer for `nodeCount` nodes. */
export function cullScratchWords(nodeCount: number): number {
  const k = ENGINE_CONSTANTS;
  const c = chunkCount(nodeCount);
  const cells = cullCellCount(nodeCount);
  return labelledWordOffset(nodeCount) + Math.ceil(nodeCount / 32);
}

export function drawTableWordOffset(nodeCount: number): number {
  const k = ENGINE_CONSTANTS;
  const c = chunkCount(nodeCount);
  const cells = cullCellCount(nodeCount);
  return k.SCRATCH_CHUNKS + 2 * cells + Math.ceil(cells / k.CHUNK_SIZE) + 2 * c + k.CHUNK_BOUNDS_WORDS * c;
}

export function labelledWordOffset(nodeCount: number): number {
  return drawTableWordOffset(nodeCount) + chunkCount(nodeCount);
}

/** Scan cells: DRAW segments per chunk for BUCKET_NORMAL + one per other bucket. */
export function cullCellCount(nodeCount: number): number {
  const k = ENGINE_CONSTANTS;
  return (k.CHUNK_SIZE / k.DRAW_SEGMENT + k.NUM_BUCKETS - 1) * chunkCount(nodeCount);
}

/**
 * Chunk scramble multiplier for C chunks: draw position of chunk c is
 * (c · stride) mod C, chosen so that consecutive draw positions map to chunks
 * ≈ 0.618·C apart (golden-ratio step) in Morton order, i.e. far apart in space.
 */
export function drawStride(chunks: number): number {
  if (chunks <= 2) return 1;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  let step = Math.round(chunks * 0.6180339887);
  while (gcd(step, chunks) !== 1) step++;
  // stride = step⁻¹ mod C (extended Euclid): then position j holds chunk j · step mod C.
  let [r0, r1, s0, s1] = [chunks, step % chunks, 0, 1];
  while (r1 !== 0) {
    const q = Math.floor(r0 / r1);
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % chunks) + chunks) % chunks;
}

export function drawPositions(chunks: number): Uint32Array {
  const stride = drawStride(chunks);
  const out = new Uint32Array(chunks);
  for (let c = 0; c < chunks; c++) out[c] = (c * stride) % chunks;
  return out;
}

/**
 * Morton key bits per axis for `n` nodes: ~4 nodes per cell on average is
 * plenty for chunk coherence (1024 nodes per chunk) and minimises sort passes.
 */
export function mortonBitsPerAxis(n: number): number {
  return Math.min(16, Math.max(1, Math.ceil(Math.log2(Math.sqrt(Math.max(n, 1) / 4)))));
}

// ---------------------------------------------------------------------------
// Reserved override constants
// ---------------------------------------------------------------------------

export const OVERRIDES = [
  { name: "WORKGROUP_SIZE", type: "u32", value: "256u" },
  { name: "RASTER_TILE_X", type: "u32", value: "1u" },
  { name: "RASTER_TILE_Y", type: "u32", value: "1u" },
  { name: "ENABLE_ICONS", type: "bool", value: "true" },
  { name: "ENABLE_RINGS", type: "bool", value: "true" },
  { name: "ENABLE_GRADIENT_EDGES", type: "bool", value: "true" },
  { name: "SMALL_NODE_PX", type: "f32", value: "3.0" },
  // Target on-screen spacing between drawn items: the cull picks the coarsest
  // LOD level whose clusters are still this far apart. Quality/speed knob.
  { name: "LOD_TARGET_PX", type: "f32", value: "2.5" },
  { name: "SMALL_EDGE_PX", type: "f32", value: "1.5" },
  { name: "USER_WORDS", type: "u32", value: "0u" },
] as const;
