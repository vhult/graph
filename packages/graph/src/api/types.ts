/** Public types. */
import { CONSTANTS } from "../data/Layouts";
import type { GraphError } from "./errors";

/** A colour as red, green, blue and alpha, each from 0 to 1. */
export type RGBA = readonly [r: number, g: number, b: number, a: number];

/** The look of the graph, set with `style.set` or `Graph.create`. */
export interface GraphStyle {
  /** Clear colour; alpha below 1 makes the canvas see-through. */
  background?: RGBA;
  /** Multiplies every node size. */
  nodeScale?: number;
  /** Colour and width in CSS px of edges without their own colour or width. */
  edge?: { color?: RGBA; width?: number };
  /** Label size in CSS px, font, colour and padding in CSS px. */
  label?: { size?: number; font?: string; color?: RGBA; padding?: number };
  /** Icon size inside the node (0.01 to 1) and the node size in CSS px below which icons are not drawn. */
  icon?: { scale?: number; minPx?: number };
  /** Look of the hovered node and edge, or false for no hover highlight. */
  hover?: HighlightLook | false;
  /** Look of nodes and edges with `Flag.selected`. */
  selected?: HighlightLook;
  /** Look of nodes and edges with `Flag.focused`. */
  focused?: HighlightLook;
  /** Opacity of nodes and edges with `Flag.dimmed`. */
  dimmed?: { alpha?: number };
  /** Fill and stroke of the box or lasso while it is drawn. */
  selection?: { fill?: RGBA; stroke?: RGBA };
}

/** An outline drawn around a node. */
export interface OutlineLook {
  /** Outline colour. */
  color?: RGBA;
  /** Outline width as a fraction of the node size. */
  scale?: number;
  /** Smallest outline width, CSS px. */
  minWidth?: number;
  /** Largest outline width, CSS px. */
  maxWidth?: number;
}

/** The look of a highlighted node and its edges. */
export interface HighlightLook {
  /** Outline around the node. */
  outline?: OutlineLook;
  /** Colour of the highlighted edge. */
  edgeColor?: RGBA;
  /** Width of the highlighted edge, CSS px. */
  edgeWidth?: number;
}

/** Options for `Graph.create`. */
export interface GraphOptions {
  /** Device pixel ratio of the backing store. Default: `devicePixelRatio`. */
  pixelRatio?: number;
  /** Tracks the canvas CSS size with a ResizeObserver. Default: true. */
  autoResize?: boolean;
  /** First look, the same shape as `style.set`. */
  style?: GraphStyle;
  /** First interaction settings, the same shape as `input.set`. */
  input?: GraphInput;
}

/** How an interaction runs: the engine does it ("auto"), only reports it ("manual"), or ignores it (false). */
export type Mode = "auto" | "manual" | false;

/** Interaction and picking settings, set with `input.set` or `Graph.create`. */
export interface GraphInput {
  /** Drag on empty space moves the camera. Default: "auto". */
  pan?: Mode;
  /** Wheel and pinch zoom around the pointer. Default: "auto". */
  zoom?: Mode;
  /** Two-finger twist turns the view. Default: false. */
  rotate?: Mode;
  /** Press and move on a node moves it, with every selected node. Default: "auto". */
  drag?: Mode;
  /** Click and key + drag select nodes. Default: "auto". */
  select?: Mode;
  /** Shape drawn to select: "box" or "lasso". Default: "box". */
  selectShape?: SelectShape;
  /** Key held to draw the select shape, or null to always draw it on empty space. Default: "shift". */
  selectKey?: SelectKey | null;
  /** What hover, click and the hover highlight see. Default: nodes and edges. */
  pick?: { nodes?: boolean; edges?: boolean; groups?: boolean };
  /** Extra reach around nodes, CSS px. Default: 0. */
  pickRadius?: number;
  /** Extra reach around edges, CSS px. Default: 4. */
  edgePickRadius?: number;
}

/** Shape drawn to select nodes. */
export type SelectShape = "box" | "lasso";

/** Modifier key that draws the select shape. */
export type SelectKey = "shift" | "alt" | "ctrl" | "meta";

/** Payload of the `select` event. */
export interface SelectEvent {
  /** Selected nodes in "auto", or the nodes inside the shape or the clicked node in "manual". */
  nodes: Uint32Array;
  /** Gesture that made the selection. */
  shape: "click" | SelectShape;
  /** Shift key held. */
  shift: boolean;
  /** Control key held. */
  ctrl: boolean;
  /** Alt key held. */
  alt: boolean;
  /** Meta key held. */
  meta: boolean;
}

/** Phase of a gesture. */
export type GesturePhase = "start" | "move" | "end";

/** Payload of the `pan` event. */
export interface PanEvent {
  /** Gesture phase. */
  phase: GesturePhase;
  /** Horizontal move since the last event, CSS px. */
  dx: number;
  /** Vertical move since the last event, CSS px. */
  dy: number;
  /** Pointer x on the canvas, CSS px. */
  x: number;
  /** Pointer y on the canvas, CSS px. */
  y: number;
  /** Shift key held. */
  shift: boolean;
  /** Control key held. */
  ctrl: boolean;
  /** Alt key held. */
  alt: boolean;
  /** Meta key held. */
  meta: boolean;
}

/** Payload of the `zoom` event. */
export interface ZoomEvent {
  /** Gesture phase. */
  phase: GesturePhase;
  /** Zoom factor of this step. */
  factor: number;
  /** Zoom centre x on the canvas, CSS px. */
  x: number;
  /** Zoom centre y on the canvas, CSS px. */
  y: number;
  /** Shift key held. */
  shift: boolean;
  /** Control key held. */
  ctrl: boolean;
  /** Alt key held. */
  alt: boolean;
  /** Meta key held. */
  meta: boolean;
}

/** Payload of the `rotate` event. */
export interface RotateEvent {
  /** Gesture phase. */
  phase: GesturePhase;
  /** Turn of this step, radians. */
  angle: number;
  /** Turn centre x on the canvas, CSS px. */
  x: number;
  /** Turn centre y on the canvas, CSS px. */
  y: number;
  /** Shift key held. */
  shift: boolean;
  /** Control key held. */
  ctrl: boolean;
  /** Alt key held. */
  alt: boolean;
  /** Meta key held. */
  meta: boolean;
}

/** What is under the pointer or a queried point. */
export interface Hit {
  /** Node index, or null. */
  node: number | null;
  /** Edge index, or null. */
  edge: number | null;
  /** Group id, or null. */
  group: number | null;
  /** Point x, world units. */
  x: number;
  /** Point y, world units. */
  y: number;
  /** Point x on the canvas, CSS px. */
  screenX: number;
  /** Point y on the canvas, CSS px. */
  screenY: number;
  /** Mouse button of the press. */
  button: number;
  /** Shift key held. */
  shift: boolean;
  /** Control key held. */
  ctrl: boolean;
  /** Alt key held. */
  alt: boolean;
  /** Meta key held. */
  meta: boolean;
}

/** A rectangle on the canvas, CSS px. */
export interface Rect {
  /** Left edge, CSS px. */
  x: number;
  /** Top edge, CSS px. */
  y: number;
  /** Width, CSS px. */
  width: number;
  /** Height, CSS px. */
  height: number;
}

/** A polygon on the canvas. */
export interface Polygon {
  /** Corners as x, y pairs, CSS px. */
  points: readonly number[];
}

/** Engine tuning for Storybook and the bench; not stable API. */
export interface DebugTune {
  /** Node spacing in device px below which nodes merge into clusters; 0 turns LOD off. Default: 2.5. */
  lodTargetPx?: number;
  /** How far crowded edges are thinned, lower draws fewer; 0 draws every edge. Default: 1.5. */
  edgeMaxOverdraw?: number;
  /** On-screen length in CSS px at or below which an edge is not drawn. Default: 6. */
  edgeMinLengthPx?: number;
  /** Hover picks per second. Default: 60. */
  pickRate?: number;
  /** Diagnostic edge colouring. Default: "off". */
  edgeMode?: EdgeDebugMode;
}

/** Payload of the `dragStart` event. */
export interface DragStartEvent {
  /** Grabbed node. */
  index: number;
  /** Every dragged node. */
  nodes: Uint32Array;
  /** Grabbed node x, world units. */
  x: number;
  /** Grabbed node y, world units. */
  y: number;
}

/** Payload of the `drag` and `dragEnd` events. */
export interface DragMoveEvent {
  /** Grabbed node. */
  index: number;
  /** Horizontal offset since the start, world units. */
  dx: number;
  /** Vertical offset since the start, world units. */
  dy: number;
}

/** Diagnostic edge colouring mode. */
export type EdgeDebugMode = "off" | "length" | "thinning" | "chunk";

/** Options for calls that send arrays. */
export interface CopyOption {
  /** Copies the arrays instead of transferring them, so they stay usable. Default: false. */
  copy?: boolean;
}

/** Nodes for `nodes.set` and `nodes.add`. */
export interface NodeData {
  /** Number of nodes. */
  count: number;
  /** x, y per node, world units. */
  positions?: Float32Array;
  /** Packed RGBA per node, see `packRgba`. */
  colors?: Uint32Array | Uint8Array;
  /** Diameter per node, world units. */
  sizes?: Float32Array;
  /** Shape per node, one of `NodeShape`. */
  shapes?: Uint8Array;
  /** Layer per node, 0 to 15, higher on top. */
  zIndex?: Uint8Array;
  /** Icon id per node, or `NO_ICON`. */
  icons?: Uint16Array;
  /** Packed RGBA icon tint per node. */
  iconColors?: Uint32Array | Uint8Array;
  /** Label text per node. */
  labels?: readonly (string | null | undefined)[];
}

/** Node channels for `nodes.update` and `nodes.updateAll`; labels null clears every label in `updateAll`. */
export type NodeUpdate = Omit<NodeData, "count" | "labels"> & {
  labels?: readonly (string | null | undefined)[] | null;
};

/** An icon from SVG path data. */
export interface IconPath {
  /** SVG path data, one path or several. */
  path: string | readonly string[];
  /** SVG view box of the path. */
  viewBox?: readonly [x: number, y: number, width: number, height: number];
  /** SVG fill rule. */
  fillRule?: "nonzero" | "evenodd";
}

/** An icon from SVG markup. */
export interface IconSvg {
  /** SVG markup. */
  svg: string;
}

/** An icon shape, from path data or SVG markup. */
export type IconSource = IconPath | IconSvg;

/** Icon id for a node with no icon. */
export const NO_ICON: number = CONSTANTS.NO_ICON;

/** Channels of a node stream. */
export interface NodeStreamChannels {
  /** Streams positions. */
  positions?: boolean;
  /** Streams colours. */
  colors?: boolean;
  /** Streams layers. */
  zIndex?: boolean;
}

/** A buffer the host writes node channels into, then commits. */
export interface NodeStream {
  /** x, y per node slot, world units. */
  readonly positions: Float32Array;
  /** Packed RGBA per node slot. */
  readonly colors: Uint32Array;
  /** Layer per node slot. */
  readonly zIndex: Uint8Array;
  /** Sends what was written to the engine. */
  commit(): void;
}

/** Node shapes. */
export const NodeShape = { circle: 0, square: 1, hexagon: 2 } as const;
/** A node shape value. */
export type NodeShape = (typeof NodeShape)[keyof typeof NodeShape];

/** Node and edge flags for `nodes.flag` and `edges.flag`. */
export const Flag = { selected: 2, dimmed: 4, hidden: 8, focused: 64 } as const;

/** Edges for `edges.set` and `edges.add`. */
export interface EdgeData {
  /** Number of edges. */
  count: number;
  /** Source and target node index per edge. */
  indices: Uint32Array;
  /** Style word per edge, see `packEdgeStyle`. */
  styles?: Uint32Array;
  /** Packed RGBA at the source, then at the target, per edge. */
  colors?: Uint32Array;
  /** Label text per edge. */
  labels?: readonly (string | null | undefined)[];
}

/** Edge channels for `edges.update` and `edges.updateAll`; labels null clears every label in `updateAll`. */
export type EdgeUpdate = Partial<Omit<EdgeData, "count" | "labels">> & {
  labels?: readonly (string | null | undefined)[] | null;
};

/** A camera view. */
export interface CameraView {
  /** Centre x, world units. */
  x: number;
  /** Centre y, world units. */
  y: number;
  /** CSS px per world unit. */
  zoom: number;
  /** Rotation, radians. */
  rotation: number;
}

/** Easing of a camera animation. */
export type CameraEasing = "linear" | "ease";

/** A rectangle in world units. */
export interface WorldBounds {
  /** Left edge. */
  minX: number;
  /** Top edge. */
  minY: number;
  /** Right edge. */
  maxX: number;
  /** Bottom edge. */
  maxY: number;
}

/** Animation of `camera.set`. */
export interface CameraAnimOptions {
  /** Duration, ms. */
  duration: number;
  /** Easing. Default: "ease". */
  easing?: CameraEasing;
}

/** Options for `camera.fit`. */
export interface CameraFitOptions {
  /** Nodes to frame. Default: every node. */
  nodes?: Uint32Array;
  /** World rectangle to frame. */
  bounds?: WorldBounds;
  /** Space around the framed area, CSS px. Default: 24. */
  padding?: number;
  /** Animation duration, ms. Default: 0. */
  duration?: number;
}

/** Options for `camera.rotate`. */
export interface CameraRotateOptions {
  /** Turn centre x on the canvas, CSS px. Default: the canvas centre. */
  x?: number;
  /** Turn centre y on the canvas, CSS px. Default: the canvas centre. */
  y?: number;
  /** Animation duration, ms. Default: 0. */
  duration?: number;
}

/** Limits of what the camera can reach. */
export interface CameraLimits {
  /** Smallest zoom, CSS px per world unit. Default: 0. */
  minZoom?: number;
  /** Largest zoom, CSS px per world unit. Default: no limit. */
  maxZoom?: number;
  /** World rectangle the view centre stays in. Default: no limit. */
  bounds?: WorldBounds;
}

/** Latest frame numbers, from `stats`. */
export interface GraphStats {
  /** Frames the worker rendered. */
  renderedFrames: number;
  /** Index of the last frame. */
  frameIndex: number;
  /** Worker CPU time of the last rendered frame, ms. */
  cpuMs: number;
  /** Worker CPU time, moving average, ms. */
  cpuMsAvg: number;
  /** Nodes in the engine. */
  nodeCount: number;
  /** Edges in the engine. */
  edgeCount: number;
  /** Canvas width, device px. */
  viewportWidth: number;
  /** Canvas height, device px. */
  viewportHeight: number;
  /** Bytes uploaded to the GPU by the last rendered frame. */
  uploadBytes: number;
  /** Bytes in the GPU buffers the engine holds. */
  gpuBytes: number;
  /** Largest `gpuBytes` since start. */
  peakGpuBytes: number;
  /** Device px per CSS px of the canvas. */
  pixelRatio: number;
  /** GPU time per frame, rolling mean, ms; NaN without timestamp queries. */
  gpuMs: number;
  /** GPU time per pass, rolling mean, ms, keyed by `GraphCaps.profilerSlots`. */
  passMs: Record<string, number>;
  /** Nodes drawn in the last profiled frame. */
  visibleNodes: number;
  /** Edges submitted in the last profiled frame. */
  visibleEdges: number;
  /** Labels on screen, not counting labels fading out. */
  labelsShown: number;
  /** Label placements completed since start. */
  labelSolves: number;
  /** Labels that started fading in since start. */
  labelsAdded: number;
  /** Labels that started fading out since start. */
  labelsRemoved: number;
  /** Profiler samples dropped since start. */
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

/** What this GPU and page support. */
export interface GraphCaps {
  /** GPU timestamp queries are available. */
  timestampQuery: boolean;
  /** Indirect draws can set the first instance. */
  indirectFirstInstance: boolean;
  /** Shader subgroups are available. */
  subgroups: boolean;
  /** 32-bit float textures can be filtered. */
  float32Filterable: boolean;
  /** 16-bit floats are available in shaders. */
  shaderF16: boolean;
  /** Largest GPU buffer, bytes. */
  maxBufferSize: number;
  /** Largest storage buffer binding, bytes. */
  maxStorageBufferBindingSize: number;
  /** Largest 2D texture side, px. */
  maxTextureDimension2D: number;
  /** Storage buffers per shader stage. */
  maxStorageBuffersPerShaderStage: number;
  /** Most icons the icon set can hold. */
  maxIcons: number;
  /** Input ring and stats use SharedArrayBuffer. */
  sharedMemory: boolean;
  /** Adapter description, such as "nvidia ampere". */
  adapter: string;
  /** Names of the GPU profiler slots, in slot order. */
  profilerSlots: string[];
}

/** A camera path key relative to the node bounds. */
export interface CameraPathKey {
  /** Centre x as a fraction of the node bounds, 0.5 is the middle. */
  x: number;
  /** Centre y as a fraction of the node bounds, 0.5 is the middle. */
  y: number;
  /** Multiplies the fit-to-screen zoom. */
  zoom: number;
}

/** Options for `debug.benchmark`. */
export interface BenchmarkOptions {
  /** Camera path keys to play. */
  path: readonly CameraPathKey[];
  /** Frames recorded along the path. */
  frames: number;
  /** Frames rendered at the first key before recording starts. Default: 10. */
  warmup?: number;
  /** GPU timing detail. Default: "passes". */
  timing?: "off" | "passes" | "full";
}

/** Per-frame series of a benchmark run; NaN where no sample exists. */
export interface BenchmarkResult {
  /** Frames recorded. */
  frames: number;
  /** Warm-up frames rendered before recording. */
  warmup: number;
  /** Nodes in the engine. */
  nodeCount: number;
  /** Canvas size, device px. */
  viewport: [width: number, height: number];
  /** Adapter description. */
  adapter: string;
  /** GPU timestamp queries were available. */
  timestampQuery: boolean;
  /** Wall time of the run, ms. */
  wallMs: number;
  /** Worker CPU time per frame, ms. */
  cpuMs: Float64Array;
  /** Time between consecutive rendered frames, ms. */
  intervalMs: Float64Array;
  /** GPU time per frame, ms. */
  gpuMs: Float64Array;
  /** GPU time per pass per frame, ms. */
  passMs: Record<string, Float64Array>;
  /** Nodes drawn per frame. */
  visibleNodes: Float64Array;
  /** Edges submitted per frame. */
  visibleEdges: Float64Array;
}

/** Statistics of one recorded series. */
export interface DebugSummary {
  /** Samples. */
  n: number;
  /** Share of frames with a sample. */
  ran: number;
  /** Mean. */
  mean: number;
  /** Median. */
  p50: number;
  /** 95th percentile. */
  p95: number;
  /** 99th percentile. */
  p99: number;
  /** Largest sample. */
  max: number;
}

/** Totals of one message or call type in a recording. */
export interface DebugTotals {
  /** Number of calls. */
  count: number;
  /** Total time, ms. */
  totalMs: number;
  /** Longest call, ms. */
  maxMs: number;
}

/** A debug overlay recording. */
export interface DebugRecording {
  /** Recording format version. */
  schema: 1;
  /** Date of the recording, ISO 8601. */
  date: string;
  /** Browser user agent. */
  userAgent: string;
  /** Adapter description. */
  adapter: string;
  /** GPU and page capabilities. */
  caps: GraphCaps;
  /** Nodes in the engine. */
  nodeCount: number;
  /** Edges in the engine. */
  edgeCount: number;
  /** Canvas size, device px. */
  viewport: [width: number, height: number];
  /** Device px per CSS px. */
  pixelRatio: number;
  /** Length of the recording, ms. */
  durationMs: number;
  /** Frames recorded. */
  frames: number;
  /** GPU group per profiler column. */
  gpuGroups: Record<string, string>;
  /** Statistics per series. */
  summary: Record<string, DebugSummary>;
  /** Per-frame values per series. */
  series: Record<string, number[]>;
  /** Totals per worker message type. */
  workerMessages: Record<string, DebugTotals>;
  /** Totals per main-thread API call. */
  mainThread: Record<string, DebugTotals>;
}

/** Events and their payloads, for `on`. */
export interface GraphEvents {
  /** Something failed after creation. */
  error: GraphError;
  /** What is under the pointer changed. */
  hover: Hit;
  /** Left click on a node, an edge or empty space. */
  click: Hit;
  /** Left double click. */
  doubleClick: Hit;
  /** Right click or long press. */
  contextMenu: Hit;
  /** A drag started. */
  dragStart: DragStartEvent;
  /** The dragged nodes moved. */
  drag: DragMoveEvent;
  /** A drag ended. */
  dragEnd: DragMoveEvent;
  /** A click or a shape selected nodes. */
  select: SelectEvent;
  /** A pan gesture step. */
  pan: PanEvent;
  /** A wheel or pinch step. */
  zoom: ZoomEvent;
  /** A twist step. */
  rotate: RotateEvent;
  /** Edges went away with a removed node. */
  edgesRemoved: Uint32Array;
  /** The camera moved, at most once per frame. */
  view: CameraView;
}
