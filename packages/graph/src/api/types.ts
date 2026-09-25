/** Public types. */
import { CONSTANTS } from "../data/Layouts";

export type RGBA = readonly [r: number, g: number, b: number, a: number];

export interface GraphOptions {
  /** Device pixel ratio used for the backing store. Default: `devicePixelRatio`. */
  pixelRatio?: number;
  /** Clear colour, straight alpha, 0..1. */
  background?: RGBA;
  transparent?: boolean;
  /** Track the canvas CSS size with a ResizeObserver. Default: true. */
  autoResize?: boolean;
  /** Built-in pan/zoom controls. Default: true. */
  controls?: boolean;
  /** Multiplier applied to every node size. Default: 1. */
  nodeScale?: number;
  /** Width of an edge with no per-edge width, device px. Default: 1. */
  edgeWidth?: number;
  /**
   * Tint applied to edges that carry no per-edge colour. Straight alpha.
   * Default: a dim blue-grey.
   */
  edgeColor?: RGBA;
  /**
   * Compile the arrowhead into the edge shader; edges whose style word has the
   * directed flag then get one at their target. Directed edges need a wider
   * quad, so this costs fill on every edge; leave it off for undirected graphs.
   * Default: false.
   */
  directedEdges?: boolean;
  /**
   * How much crowded areas of edges are thinned: lower draws fewer edges. It
   * is not a count of edges per pixel; the edges that stay still cover a
   * crowded pixel many times over. The edges kept carry the opacity of the
   * ones dropped, so the area looks the same; zooming in only brings edges
   * back, never removes them. `0` draws every edge. Default: 1.5.
   */
  edgeMaxOverdraw?: number;
  /**
   * On-screen length, CSS px, at or below which an edge is not drawn: too small
   * to read as a line. Edges fade in quickly above it (fully visible at 1.5x),
   * so a drawn edge is clearly visible but nothing pops while zooming. `0`
   * draws every edge that has any length. Default: 6.
   */
  edgeMinLengthPx?: number;
  /**
   * Diagnostic edge colouring. "length": red = below the minimum length (drawn
   * only in this mode), orange = fading in, green = fully drawn. "thinning":
   * blue = every edge of its chunk drawn, red = heavily thinned. "chunk": one
   * colour per chunk of 1024 edges. Default: "off".
   */
  edgeDebug?: EdgeDebugMode;
  /** Label text size, CSS px. Default: 12. */
  labelSize?: number;
  /** Minimum gap between two labels, CSS px. Default: 2. */
  labelPadding?: number;
  /** CSS font family of labels, available to the render worker. Default: system-ui. */
  labelFont?: string;
  /**
   * Level of detail: once a chunk's nodes would sit closer together than this
   * many device px, they are drawn as merged clusters instead. Larger merges
   * sooner (faster, coarser); `0` disables LOD and draws every node. Default: 2.5.
   */
  lodTargetPx?: number;
  pickRate?: number;
  pickRadius?: number;
  edgePickRadius?: number;
  hoverStyle?: HoverStyle | false;
  nodeDrag?: boolean;
  iconScale?: number;
  iconMinPx?: number;
}

export interface NodeDragEvent {
  index: number;
  x: number;
  y: number;
}

export interface HoverStyle {
  nodeColor?: RGBA;
  nodeScale?: number;
  edgeColor?: RGBA;
  edgeWidth?: number;
}

export type EdgeDebugMode = "off" | "length" | "thinning" | "chunk";

export interface CopyOption {
  /**
   * Copy the array before transferring it to the render worker. By default
   * arrays are TRANSFERRED (zero copy) and become detached in the caller.
   */
  copy?: boolean;
}

export interface NodeData {
  count: number;
  /** xy interleaved, world units. Length `2 * count`. */
  positions?: Float32Array;
  /** rgba8unorm packed (R in the low byte), one word per node. */
  colors?: Uint32Array | Uint8Array;
  /** World-unit diameters, one per node. */
  sizes?: Float32Array;
  /** Shape per node, one of `NodeShape`. */
  shapes?: Uint8Array;
  zIndex?: Uint8Array;
  icons?: Uint16Array;
  iconColors?: Uint32Array | Uint8Array;
}

export type NodeUpdate = Omit<NodeData, "count">;

export interface IconPath {
  path: string | readonly string[];
  viewBox?: readonly [x: number, y: number, width: number, height: number];
  fillRule?: "nonzero" | "evenodd";
}

export interface IconSvg {
  svg: string;
}

export type IconSource = IconPath | IconSvg;

export const NO_ICON: number = CONSTANTS.NO_ICON;

export interface NodeStreamChannels {
  positions?: boolean;
  colors?: boolean;
  zIndex?: boolean;
}

export interface NodeStream {
  readonly positions: Float32Array;
  readonly colors: Uint32Array;
  readonly zIndex: Uint8Array;
  commit(): void;
}

export const NodeShape = { circle: 0, square: 1, hexagon: 2 } as const;
export type NodeShape = (typeof NodeShape)[keyof typeof NodeShape];

export interface EdgeData {
  count: number;
  /**
   * Source and target NODE INDICES interleaved, length `2 * count`. Indices are
   * positions in the arrays passed to `setNodes`; the engine maps them to its
   * internal order itself.
   */
  indices: Uint32Array;
  /**
   * Packed style word per edge (width, curve, caps, flags). Length `count`.
   * `0` means "use the global edge width, straight, undirected".
   */
  styles?: Uint32Array;
  /**
   * rgba8unorm at the source and target end, interleaved, length `2 * count`
   * (the pair is interpolated along the edge). Per-edge colour is measurably
   * slower than a single global tint; omit it when every edge looks the same.
   */
  colors?: Uint32Array;
}

export interface CameraView {
  x: number;
  y: number;
  /** Device pixels per world unit. */
  zoom: number;
  /** Radians. */
  rotation: number;
}

export interface GraphStats {
  /** Frames the worker actually rendered (idle frames are skipped entirely). */
  renderedFrames: number;
  frameIndex: number;
  /** Worker CPU time of the last rendered frame, ms. */
  cpuMs: number;
  /** Worker CPU time, exponential moving average, ms. */
  cpuMsAvg: number;
  nodeCount: number;
  edgeCount: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Bytes uploaded to the GPU by the last rendered frame. */
  uploadBytes: number;
  /**
   * Bytes in the GPU buffers the engine holds. WebGPU does not expose free or
   * total GPU memory, so this is what the engine itself uses.
   */
  gpuBytes: number;
  peakGpuBytes: number;
  /** Device pixels per CSS pixel of the canvas. */
  pixelRatio: number;
  /** GPU time per frame, rolling mean over 30 frames, ms. NaN without `timestamp-query`. */
  gpuMs: number;
  /** GPU time per pass (rolling means, ms), keyed by `GraphCaps.profilerSlots`. */
  passMs: Record<string, number>;
  /** Nodes drawn in the last profiled frame (after culling). */
  visibleNodes: number;
  /**
   * Edges submitted in the last profiled frame: on screen, not in an entirely
   * sub-pixel chunk, and kept by thinning. Shorter-than-a-pixel edges among
   * them are still dropped by the vertex shader, so this is an upper bound.
   */
  visibleEdges: number;
  /** Labels on screen, not counting labels fading out. */
  labelsShown: number;
  /** Label placements completed since start. */
  labelSolves: number;
  /** Labels that started fading in since start. */
  labelsAdded: number;
  /** Labels that started fading out since start. */
  labelsRemoved: number;
  droppedSamples: number;
}

/** The candidates of one label placement and what the placement decided for each. */
export interface LabelSnapshot {
  /** Candidates found, including any beyond `capacity`. */
  found: number;
  /** Candidates the placement can hold. */
  capacity: number;
  /** Label box centres, device px, x y interleaved. */
  center: Float32Array;
  /** Label box half widths, device px, padding included. */
  halfWidth: Float32Array;
  /** Label box half heights, device px, padding included. */
  halfHeight: Float32Array;
  /** Priority: higher wins. */
  rank: Float32Array;
  /** Node size, world units, or edge length on screen, device px. */
  size: Float32Array;
  /** Engine node index, or sorted edge index with the top bit set. */
  index: Uint32Array;
  /** 0 undecided, 1 shown, 2 hidden. */
  decision: Uint8Array;
}

export interface GraphCaps {
  timestampQuery: boolean;
  indirectFirstInstance: boolean;
  subgroups: boolean;
  float32Filterable: boolean;
  shaderF16: boolean;
  maxBufferSize: number;
  maxStorageBufferBindingSize: number;
  maxTextureDimension2D: number;
  maxStorageBuffersPerShaderStage: number;
  maxIcons: number;
  /** True when the input ring / stats use SharedArrayBuffer (cross-origin isolated). */
  sharedMemory: boolean;
  /** Human-readable adapter description, e.g. "nvidia ampere". */
  adapter: string;
  /** Names of the GPU profiler slots, in slot order. */
  profilerSlots: string[];
}

/**
 * A camera path keyframe, relative to the data: `x`, `y` are fractions of the
 * node bounds (0.5 = centre), `zoom` multiplies the fit-to-screen zoom.
 */
export interface CameraPathKey {
  x: number;
  y: number;
  zoom: number;
}

export interface BenchmarkOptions {
  path: readonly CameraPathKey[];
  /** Frames recorded along the path. */
  frames: number;
  /** Frames rendered at the first key before recording starts. Default 10. */
  warmup?: number;
  timing?: "off" | "passes" | "full";
}

/** Per-frame series; NaN where no sample exists. */
export interface BenchmarkResult {
  frames: number;
  warmup: number;
  nodeCount: number;
  viewport: [width: number, height: number];
  adapter: string;
  timestampQuery: boolean;
  wallMs: number;
  /** Worker CPU time per frame, ms. */
  cpuMs: Float64Array;
  /** Time between consecutive rendered frames, ms (vsync- or GPU-bound). */
  intervalMs: Float64Array;
  /** GPU time per frame, ms. */
  gpuMs: Float64Array;
  /** GPU time per pass per frame, ms. */
  passMs: Record<string, Float64Array>;
  /** Nodes drawn per frame. */
  visibleNodes: Float64Array;
  /** Edges submitted per frame, after the edge cull (see `GraphStats.visibleEdges`). */
  visibleEdges: Float64Array;
}

export interface DebugSummary {
  n: number;
  ran: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface DebugTotals {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface DebugRecording {
  schema: 1;
  date: string;
  userAgent: string;
  adapter: string;
  caps: GraphCaps;
  nodeCount: number;
  edgeCount: number;
  viewport: [width: number, height: number];
  pixelRatio: number;
  durationMs: number;
  frames: number;
  gpuGroups: Record<string, string>;
  summary: Record<string, DebugSummary>;
  series: Record<string, number[]>;
  workerMessages: Record<string, DebugTotals>;
  mainThread: Record<string, DebugTotals>;
}

export interface GraphEvents {
  error: Error;
  nodeHover: number | null;
  edgeHover: number | null;
  nodeClick: number | null;
  edgeClick: number | null;
  nodeDragStart: NodeDragEvent;
  nodeDrag: NodeDragEvent;
  nodeDragEnd: NodeDragEvent;
}
