/**
 * Worker-side orchestrator: owns the device, the frame loop and all GPU state.
 *
 * Frame loop contract:
 *   - A frame renders only when a dirty flag is set. Otherwise the loop goes to
 *     sleep: no rAF, no canvas texture, no GPU submission, no allocation.
 *   - Input wakes it via the InputRing's SLEEPING flag (one message per wake)
 *     or via any API message.
 */
import { GraphError } from "../api/errors";
import { mergeInput, type ResolvedInput } from "../api/input";
import { mergeStyle, type ResolvedStyle } from "../api/style";
import type { BenchmarkOptions, BenchmarkResult, CameraEasing, CameraView, DebugTune, GesturePhase, GraphCaps, GraphInput, GraphStyle, Hit, IconSource, LabelSnapshot, RGBA, SelectEvent, SelectKey, WorldBounds } from "../api/types";
import { INPUT, MOD, type InputRing, type InputRecord } from "../bridge/InputRing";
import type { StreamSlots } from "../bridge/StreamSlots";
import type { GestureMessage, HitEventName, InitOptions, WorkerEventName } from "../bridge/protocol";
import { STATE_SLOT } from "../bridge/SharedState";
import { Camera2D, nearestAngle, wrapAngle } from "../camera/Camera2D";
import { CameraAnimation } from "../camera/CameraAnimation";
import { CameraPath } from "../camera/CameraPath";
import { Controls, type Gesture } from "../camera/Controls";
import { GraphStore, type EdgeArrays, type NodeArrays } from "../data/GraphStore";
import { CONSTANTS, NODE_RESERVE } from "../data/Layouts";
import { MAX_SHAPE_POINTS } from "../data/QueryShape";
import { createContractLayouts } from "../gpu/BindLayouts";
import { readCaps } from "../gpu/Caps";
import { createGpu, type Gpu } from "../gpu/Device";
import { FrameGraph, type EncodeTimes, type FrameContext } from "../gpu/FrameGraph";
import { FrameUniform, type FrameInputs } from "../gpu/FrameUniform";
import { GraphBuffers } from "../gpu/GraphBuffers";
import { PermuteKernels } from "../gpu/PermuteKernels";
import { Profiler, type ProfileSample } from "../gpu/Profiler";
import { IconAtlas } from "../icons/IconAtlas";
import { Labels } from "../labels/Labels";
import { EdgeCullPass } from "../passes/EdgeCullPass";
import { LabelDrawPass } from "../passes/LabelDrawPass";
import { LabelPass } from "../passes/LabelPass";
import { HoverPass } from "../passes/HoverPass";
import { PICKED_EDGES, PICKED_NODES, PickPass, type PickRequest } from "../passes/PickPass";
import { QueryPass, type QueryDone, type QueryFail } from "../passes/QueryPass";
import { SelectionShapePass } from "../passes/SelectionShapePass";
import { EdgeGeometryPass } from "../passes/EdgeGeometryPass";
import { EdgeSortPass } from "../passes/EdgeSortPass";
import { NodeGeometryPass } from "../passes/NodeGeometryPass";
import { NodeOrderPass } from "../passes/NodeOrderPass";
import { SortPass } from "../passes/SortPass";
import { TransformCullPass } from "../passes/TransformCullPass";
import { UploadPass } from "../passes/UploadPass";
import { Benchmark } from "./Benchmark";
import { Dirty, edgeUpdateDirty } from "./Dirty";
import { HoverGate } from "./HoverGate";
import { Press } from "./Press";
import { Selection, shapeAdds } from "./Selection";
import { CPU, Probe, type ProbeSink } from "./Probe";
import { Telemetry } from "./Telemetry";
import { applyTune, DEFAULT_TUNE, sameTune, type Tunable, type Tune } from "./Tune";

export interface EngineInit {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
  pixelRatio: number;
  ring: InputRing | null;
  state: Float64Array;
  options: InitOptions;
  gpu: GPU | undefined;
  requestFrame: (cb: (t: number) => void) => void;
  onError: (e: GraphError, fatal: boolean) => void;
  onBenchmark: (id: number, result: BenchmarkResult, transfer: ArrayBuffer[]) => void;
  onLabelSnapshot: (id: number, snapshot: LabelSnapshot, transfer: ArrayBuffer[]) => void;
  onIcons: (id: number, error: GraphError | null) => void;
  onSnapshot: (id: number, blob: Blob | null, error: GraphError | null) => void;
  onHit: (event: HitEventName, hit: Hit) => void;
  onGesture: (msg: GestureMessage) => void;
  onDragStart: (index: number, nodes: Uint32Array, x: number, y: number) => void;
  onDrag: (event: "drag" | "dragEnd", index: number, dx: number, dy: number) => void;
  onView: (x: number, y: number, zoom: number, rotation: number) => void;
  onQueryAt: (id: number, hit: Hit) => void;
  onQueryInside: (id: number, nodes: Uint32Array | null, error: GraphError | null) => void;
  onSelect: (event: SelectEvent) => void;
  probeSink: ProbeSink;
}

interface Passes {
  cull: TransformCullPass;
  order: NodeOrderPass;
  nodes: NodeGeometryPass;
  edges: EdgeGeometryPass;
  edgeCull: EdgeCullPass;
  labels: LabelPass;
  labelDraw: LabelDrawPass;
}

const CPU_EMA = 0.1;
const DEFAULT_WARMUP_FRAMES = 10;
const FIT_PADDING_CSS_PX = 24;
const BENCH_TIMING = { off: 0, passes: 1, full: 2 } as const;
const CAMERA_SETTLE_MS = 50;
const CLICK_SLOP_CSS_PX = 3;
const SHAPE_STEP_CSS_PX = 4;
const SELECT_KEY_MOD: Record<SelectKey, number> = { shift: MOD.SHIFT, alt: MOD.ALT, ctrl: MOD.CTRL, meta: MOD.META };
const DEFAULT_PICK_RATE = 60;
const NODE_DIRTY = [
  ["positions", Dirty.TOPOLOGY],
  ["sizes", Dirty.TOPOLOGY],
  ["shapes", Dirty.TOPOLOGY],
  ["colors", Dirty.STYLE],
  ["zIndex", Dirty.STYLE],
  ["icons", Dirty.STYLE],
  ["iconColors", Dirty.STYLE],
] as const satisfies readonly (readonly [keyof NodeArrays, number])[];
const UPDATE_DIRTY = [
  ["positions", Dirty.POSITIONS],
  ["sizes", Dirty.POSITIONS],
  ["shapes", Dirty.STYLE],
  ["colors", Dirty.STYLE],
  ["zIndex", Dirty.STYLE],
  ["icons", Dirty.STYLE],
  ["iconColors", Dirty.STYLE],
] as const satisfies readonly (readonly [keyof NodeArrays, number])[];
const PICK_DIRTY = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.MOVED | Dirty.CAMERA | Dirty.STYLE | Dirty.STATE | Dirty.RESIZE | Dirty.EDGES | Dirty.LABELLED;

function dirtyFor(table: readonly (readonly [keyof NodeArrays, number])[], arrays: NodeArrays): number {
  let dirty = 0;
  for (const [k, flag] of table) if (arrays[k]) dirty |= flag;
  return dirty;
}

/** Straight-alpha RGBA in 0..1 to an rgba8unorm word (R in the low byte). */
function packRgbaTuple(c: RGBA): number {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (q(c[0]) | (q(c[1]) << 8) | (q(c[2]) << 16) | (q(c[3]) << 24)) >>> 0;
}

function readView(c: Camera2D, out: CameraView): void {
  out.x = c.x;
  out.y = c.y;
  out.zoom = c.zoom;
  out.rotation = c.rotation;
}

function blankLabels(n: number): string[] {
  return new Array<string>(n).fill("");
}

export class Engine {
  readonly caps: GraphCaps;
  readonly probe: Probe;
  private readonly camera = new Camera2D();
  private readonly controls = new Controls();
  private readonly anim = new CameraAnimation();
  private readonly animFrom: CameraView = { x: 0, y: 0, zoom: 1, rotation: 0 };
  private readonly animTo: CameraView = { x: 0, y: 0, zoom: 1, rotation: 0 };
  private readonly animView: CameraView = { x: 0, y: 0, zoom: 1, rotation: 0 };
  private readonly pivot = { wx: 0, wy: 0, sx: 0, sy: 0, on: false };
  private viewEvents = false;
  private hoverEvents = false;
  private clickEvents = false;
  private doubleClickEvents = false;
  private menuEvents = false;
  private panEvents = false;
  private zoomEvents = false;
  private rotateEvents = false;
  private gestureTimer: ReturnType<typeof setTimeout> | undefined;
  private minZoomCss = 0;
  private maxZoomCss = Infinity;
  private limitBounds: WorldBounds | null = null;
  private readonly frameGraph: FrameGraph;
  private readonly frameUniform: FrameUniform;
  private readonly telemetry: Telemetry;
  private readonly context: GPUCanvasContext;
  private readonly frameCtx: FrameContext;
  private readonly frameInputs: FrameInputs;
  private readonly submitList: GPUCommandBuffer[] = [];
  private readonly inputRec: InputRecord = { type: 0, t: 0, x: 0, y: 0, dx: 0, dy: 0, buttons: 0, mods: 0, button: -1 };
  private readonly applyInput = (rec: InputRecord): void => this.input(rec);
  private readonly startTime = performance.now();
  private readonly encodeTimes: EncodeTimes;

  private dirty = Dirty.RESIZE;
  private style: ResolvedStyle;
  private transparent: boolean;
  private framePending = false;
  private stream: StreamSlots | null = null;
  private streamedPositions: Float32Array | null = null;
  private streamedColors: Uint32Array | null = null;
  private streamedZIndex: Uint8Array | null = null;
  /** performance.now() of the previous tick, for the zoom glide. */
  private lastTickMs = 0;
  private frameIndex = 0;
  private renderedFrames = 0;
  private cpuMsAvg = 0;
  private destroyed = false;
  private pixelRatio: number;
  /** Node count the cull buffers are sized for; -1 forces a check. */
  private reservedFor = -1;
  private reservedIcons = false;
  private iconsTooLarge = false;
  private iconAtlas: IconAtlas | null = null;
  private iconLoad: Promise<IconAtlas> | null = null;
  private iconChain: Promise<unknown> = Promise.resolve();
  /** Edge count the edge cull buffers are sized for; -1 forces a check. */
  private reservedEdgesFor = -1;
  private bench: Benchmark | null = null;
  private labelSolves = 0;
  private benchTimer: ReturnType<typeof setTimeout> | undefined;
  private pick: PickPass | null = null;
  private query: QueryPass | null = null;
  private readonly atJobs: { id: number; x: number; y: number }[] = [];
  private readonly snapJobs: { id: number; type: string }[] = [];
  private atSeq = 0;
  private hover: HoverPass | null = null;
  private shapePass: SelectionShapePass | null = null;
  private shapeLoading = false;
  private shapeOn = false;
  private shapeLasso = false;
  private shapeMods = 0;
  private shapeCount = 0;
  private shapePts = new Float32Array(0);
  private readonly shapeBox = new Float32Array(8);
  private readonly selection = new Selection();
  private selectEvents = false;
  private pickLoading = false;
  private hoverLoading = false;
  private lookList = new Uint32Array(16);
  private selectedCount = 0;
  private focusedCount = 0;
  private edgeLookList = new Uint32Array(16);
  private selectedEdges = 0;
  private focusedEdges = 0;
  private pickEdges = false;
  private inputState: ResolvedInput;
  private pickKinds = 0;
  private dragEvents = false;
  private dragNode = -1;
  private dragAuto = false;
  private moveEnding = false;
  private dragList: Uint32Array = new Uint32Array(0);
  private dragFrom = new Float32Array(0);
  private dragXY = new Float32Array(0);
  private dragWords = new Uint32Array(0);
  private grabX = 0;
  private grabY = 0;
  private dragDx = 0;
  private dragDy = 0;
  private readonly world = { x: 0, y: 0 };
  private readonly press = new Press({
    startDrag: (node, nodeScale, auto) => this.startDrag(node, nodeScale, auto),
    dragTo: () => this.dragTo(),
    moveDragged: () => this.moveDragged(),
    endDrag: () => this.endDrag(),
    stopHold: (pan) => this.stopHold(pan),
    startShape: () => this.startShape(),
    shapeTo: (x, y) => this.shapeTo(x, y),
    endShape: () => this.endShape(),
    cancelShape: () => this.cancelShape(),
    click: (node, edge, x, y, button, mods) => this.emitClick(node, edge, x, y, button, mods),
  });
  private mods = 0;
  private hoverX = 0;
  private hoverY = 0;
  private hoverMods = 0;
  private shotEvent: HitEventName | null = null;
  private shotSeq = 0;
  private shotX = 0;
  private shotY = 0;
  private shotButton = 0;
  private shotMods = 0;
  private pickWanted = false;
  private readonly hoverGate = new HoverGate();
  private pickDue = 0;
  private pickTimer: ReturnType<typeof setTimeout> | undefined;
  private pickSeq = 0;
  private pickInterval = 1000 / DEFAULT_PICK_RATE;
  private readonly wanted: Tune = { ...DEFAULT_TUNE };
  private active: Tune = { ...DEFAULT_TUNE };
  private pipesLoading = false;
  private dataGen = 0;
  private cameraMs = -Infinity;
  private frameGen = -1;
  private hoverNode = -1;
  private hoverEdge = -1;
  private readonly pickRequest: PickRequest = { x: 0, y: 0, radiusPx: 0, edgeRadiusPx: 0, nodes: false, edges: false, shapes: false, layers: false, edgeColors: false, token: 0 };

  private constructor(
    private readonly gpu: Gpu,
    private readonly store: GraphStore,
    private readonly graph: GraphBuffers,
    private readonly profiler: Profiler,
    frameGraph: FrameGraph,
    private readonly passes: Passes,
    private readonly layouts: ReturnType<typeof createContractLayouts>,
    private readonly init: EngineInit,
    private readonly labels: Labels,
  ) {
    const { device, format } = gpu;
    this.frameGraph = frameGraph;
    this.caps = readCaps(gpu.adapter, device, init.ring !== null, profiler.slotNames);

    this.style = init.options.style;
    this.inputState = init.options.input;
    this.transparent = this.style.background[3] < 1;
    this.context = init.canvas.getContext("webgpu") as GPUCanvasContext;
    this.context.configure({ device, format, alphaMode: this.transparent ? "premultiplied" : "opaque" });

    this.frameUniform = new FrameUniform(device, layouts.frame);
    graph.flush(); // create the (empty) graph buffers + bind group
    this.telemetry = new Telemetry(init.state);
    profiler.onSample = this.onProfileSample;
    profiler.timeAlways(frameGraph.slotsOf(passes.labels));
    profiler.setTimed(false);
    this.probe = new Probe(
      profiler.slotNames,
      frameGraph.slotGroups(profiler.slotNames.length),
      frameGraph.computeNames,
      init.ring !== null,
      init.options.timeOrigin,
      init.probeSink,
    );
    this.encodeTimes = { row: this.probe.row, base: this.probe.encodeBase };

    this.pixelRatio = init.pixelRatio;
    this.frameCtx = {
      frameBindGroup: this.frameUniform.bindGroup,
      graphBindGroup: graph.bindGroup,
      nodeCount: 0,
      edgeCount: 0,
      dirty: 0,
      icons: null,
    };
    this.frameInputs = {
      camera: this.camera,
      pixelRatio: init.pixelRatio,
      time: 0,
      frameIndex: 0,
      pointerX: -1,
      pointerY: -1,
      nodeCount: 0,
      edgeCount: 0,
      nodeScale: this.style.nodeScale,
      edgeWidth: this.style.edge.width,
      edgeColor: packRgbaTuple(this.style.edge.color),
      flags: 0,
      iconScale: this.style.icon.scale,
      iconMinPx: this.style.icon.minPx,
      dimmedAlpha: 0,
      selectedEdgeColor: 0,
      selectedEdgeWidth: 0,
      focusedEdgeColor: 0,
      focusedEdgeWidth: 0,
    };
    this.writeLooks();

    passes.labels.onShown = (shown, count) => {
      const t0 = this.probe.full ? performance.now() : 0;
      this.labels.applyShown(shown, count, this.clock());
      this.markDirty(Dirty.LABELS | Dirty.LABELLED);
      if (this.probe.full) this.probe.async(CPU.ASYNC_LABELS, performance.now() - t0);
    };
    passes.labels.requestSolve = () => this.markDirty(Dirty.LABEL_QUERY);
    passes.labels.onSnapshot = (id, snapshot) =>
      init.onLabelSnapshot(id, snapshot, [snapshot.center.buffer, snapshot.halfWidth.buffer, snapshot.halfHeight.buffer, snapshot.rank.buffer, snapshot.size.buffer, snapshot.index.buffer, snapshot.decision.buffer] as ArrayBuffer[]);

    const bg = this.style.background;
    this.frameGraph.setClearColor(bg[0], bg[1], bg[2], bg[3]);
    this.labels.setColor(packRgbaTuple(this.style.label.color));
    this.resize(init.width, init.height, init.pixelRatio);
    this.syncModes();
    this.syncPick();

    device.lost.then((info) => {
      if (this.destroyed) return;
      init.onError(new GraphError("device-lost", `GPU device lost (${info.reason}): ${info.message}`), true);
    });
    device.addEventListener("uncapturederror", (ev) => {
      init.onError(new GraphError("internal", (ev as GPUUncapturedErrorEvent).error.message), false);
    });
  }

  static async create(init: EngineInit): Promise<Engine> {
    const gpu = await createGpu(init.gpu);
    const { device, format } = gpu;
    const layouts = createContractLayouts(device);
    const profiler = new Profiler(device, device.features.has("timestamp-query"));
    const frameGraph = new FrameGraph(profiler);
    const store = new GraphStore();
    const kernels = await PermuteKernels.create(device);
    const graph = new GraphBuffers(device, layouts.graph, store, kernels);
    const [sort, cull, nodes, edgeSort, edgeCull, edges] = await Promise.all([
      SortPass.create(device, layouts, graph, store.bounds),
      TransformCullPass.create(device, layouts, DEFAULT_TUNE),
      NodeGeometryPass.create(device, format, layouts),
      EdgeSortPass.create(device, graph, store.bounds),
      EdgeCullPass.create(device, layouts, DEFAULT_TUNE),
      EdgeGeometryPass.create(device, format, layouts, DEFAULT_TUNE),
    ]);
    const order = await NodeOrderPass.create(device, layouts.frame, cull, (b) => graph.retireAfterSubmit(b));
    nodes.order = order;
    // Compute runs in stage order: upload, node sort, edge sort, node cull, edge cull.
    frameGraph.addCompute(new UploadPass(graph));
    frameGraph.addCompute(sort);
    frameGraph.addCompute(edgeSort);
    frameGraph.addCompute(cull);
    frameGraph.addCompute(order);
    frameGraph.addCompute(edgeCull);
    const label = init.options.style.label;
    const labelState = new Labels(device, { sizeCssPx: label.size, paddingCssPx: label.padding, font: label.font });
    const [labels, labelDraw] = await Promise.all([
      LabelPass.create(device, layouts, graph, cull, edgeCull, labelState),
      LabelDrawPass.create(device, format, layouts, graph, labelState),
    ]);
    frameGraph.addCompute(labels);
    frameGraph.addRender(edges);
    frameGraph.addRender(nodes);
    frameGraph.addRender(labelDraw);
    return new Engine(gpu, store, graph, profiler, frameGraph, { cull, order, nodes, edges, edgeCull, labels, labelDraw }, layouts, init, labelState);
  }

  // ---- API (called from worker message dispatch) ----------------------------

  resize(width: number, height: number, pixelRatio: number): void {
    const max = this.caps.maxTextureDimension2D;
    const w = Math.max(1, Math.min(max, Math.round(width)));
    const h = Math.max(1, Math.min(max, Math.round(height)));
    this.init.canvas.width = w;
    this.init.canvas.height = h;
    this.camera.setViewport(w, h);
    if (pixelRatio !== this.pixelRatio) {
      this.stopAnim();
      this.camera.zoom *= pixelRatio / this.pixelRatio;
    }
    this.pixelRatio = pixelRatio;
    this.applyLimits();
    this.labels.setPixelRatio(pixelRatio);
    this.passes.labels.setViewport(w, h);
    this.markDirty(Dirty.RESIZE);
  }

  setNodes(count: number, arrays: NodeArrays, labels: string[]): void {
    const store = this.store;
    let dirty = Dirty.STATE | (count + NODE_RESERVE !== store.nodeCount ? Dirty.TOPOLOGY : 0);
    for (const [k, flag] of NODE_DIRTY) if (arrays[k]) dirty |= flag;
    const topology = (dirty & Dirty.TOPOLOGY) !== 0;
    if (topology || store.edgeCount > 0) this.press.cancel();
    this.syncStreamed(arrays);
    if (count !== store.nodeSlots) this.stream = null;
    store.setNodes(count, arrays, NODE_RESERVE);
    if (store.edgeCount > 0) {
      store.setEdges(0, {});
      store.edgeLabels = null;
      if (this.labels.hasEdgeText) dirty |= Dirty.LABEL_QUERY | Dirty.LABELS;
      this.labels.clearEdges();
      dirty |= Dirty.EDGES;
      if (this.selectedEdges + this.focusedEdges > 0) this.listEdgeLooks();
    }
    if (topology) this.labels.setNodeCount(store.nodeCount);
    store.nodeLabels = labels.length > 0 ? labels : null;
    if (this.labels.setNodeText(labels)) dirty |= Dirty.LABEL_QUERY | Dirty.LABELS | Dirty.LABELLED;
    if (topology || (dirty & Dirty.EDGES) !== 0) this.newData();
    if (this.selectedCount + this.focusedCount > 0) this.listLooks();
    this.syncPipes();
    this.markDirty(dirty);
  }

  addNodes(indices: Uint32Array, slots: number, arrays: NodeArrays, labels?: string[]): void {
    const store = this.store;
    this.syncStreamed({});
    if (slots !== store.nodeSlots) this.stream = null;
    const grow = slots >= store.nodeCount;
    if (grow) {
      this.press.cancel();
      store.growNodes(slots + NODE_RESERVE);
      this.labels.setNodeCount(store.nodeCount);
      this.newData();
    }
    store.addNodes(indices, slots, arrays);
    let dirty = grow ? Dirty.TOPOLOGY : Dirty.POSITIONS | Dirty.STYLE | Dirty.STATE;
    const text = labels ?? (store.nodeLabels ? blankLabels(indices.length) : undefined);
    if (text) {
      this.setNodeLabelsAt(indices, text);
      dirty |= Dirty.LABEL_QUERY | Dirty.LABELS | Dirty.LABELLED;
    }
    this.markDirty(dirty);
  }

  removeNodes(indices: Uint32Array): Uint32Array {
    if (this.dragNode >= 0 && this.store.anyFlagged(indices, CONSTANTS.STATE_DRAGGING)) this.press.cancel();
    const edges = this.store.removeNodes(indices);
    if (edges.length > 0) this.store.hideEdges(edges);
    if (edges.length > 0 && this.selectedEdges + this.focusedEdges > 0) this.listEdgeLooks();
    this.newData();
    this.markDirty(Dirty.STATE);
    return edges;
  }

  compactNodes(remap: Uint32Array): void {
    const store = this.store;
    this.press.cancel();
    this.syncStreamed({});
    const slots = store.nodeSlots;
    store.compactNodes(remap, NODE_RESERVE);
    if (store.nodeSlots !== slots) this.stream = null;
    this.labels.setNodeCount(store.nodeCount);
    if (store.nodeLabels) this.labels.setNodeText(store.nodeLabels);
    this.newData();
    if (this.selectedCount + this.focusedCount > 0) this.listLooks();
    this.markDirty(Dirty.TOPOLOGY | Dirty.EDGES);
  }

  updateNodes(start: number, arrays: NodeArrays, labels?: string[] | null): void {
    this.store.updateNodes(start, arrays);
    let dirty = dirtyFor(UPDATE_DIRTY, arrays);
    if (labels !== undefined) {
      this.store.nodeLabels = labels && labels.length > 0 ? labels : null;
      if (this.labels.setNodeText(labels ?? [])) dirty |= Dirty.LABEL_QUERY | Dirty.LABELS | Dirty.LABELLED;
    }
    this.markDirty(dirty);
  }

  updateNodesAt(indices: Uint32Array, arrays: NodeArrays, labels?: string[]): void {
    this.store.updateNodesAt(indices, arrays);
    let dirty = dirtyFor(UPDATE_DIRTY, arrays);
    if (labels) {
      this.setNodeLabelsAt(indices, labels);
      dirty |= Dirty.LABEL_QUERY | Dirty.LABELS | Dirty.LABELLED;
    }
    this.markDirty(dirty);
  }

  flagNodes(indices: Uint32Array | null, flags: number, on: boolean): void {
    this.store.flagNodes(indices, flags, on);
    if ((flags & (CONSTANTS.STATE_SELECTED | CONSTANTS.STATE_FOCUSED)) !== 0) this.listLooks();
    this.markDirty(Dirty.STATE);
  }

  defineIcons(id: number, icons: readonly IconSource[], ids: Uint16Array | null = null): void {
    this.iconChain = this.iconChain
      .then(() => this.loadIcons())
      .then((atlas) => {
        if (this.destroyed) return;
        if (ids) atlas.defineAt(ids, icons);
        else atlas.define(icons);
        this.markDirty(Dirty.STYLE);
        this.init.onIcons(id, null);
      })
      .catch((e: unknown) => this.init.onIcons(id, e instanceof GraphError ? e : new GraphError("internal", String(e))));
  }

  removeIcons(ids: Uint16Array): void {
    if (this.store.clearIcons(ids)) this.markDirty(Dirty.STYLE);
    this.iconChain = this.iconChain
      .then(() => {
        if (this.destroyed || !this.iconAtlas) return;
        this.iconAtlas.clear(ids);
        this.markDirty(Dirty.STYLE);
      })
      .catch((e: unknown) => this.init.onError(e instanceof GraphError ? e : new GraphError("internal", String(e)), false));
  }

  private loadIcons(): Promise<IconAtlas> {
    this.iconLoad ??= Promise.allSettled([
      IconAtlas.create(this.gpu),
      this.passes.cull.loadIcons(),
      this.passes.order.iconScatter.load(),
      this.passes.nodes.iconVariant.load(),
      this.hover?.iconPipe.load(),
    ]).then(([atlas, ...rest]) => {
      const failed = [atlas, ...rest].find((r) => r.status === "rejected");
      if (failed || this.destroyed) {
        if (atlas.status === "fulfilled") atlas.value.destroy();
        this.iconLoad = null;
        throw failed ? failed.reason : new GraphError("destroyed", "Graph destroyed");
      }
      this.iconAtlas = (atlas as PromiseFulfilledResult<IconAtlas>).value;
      this.markDirty(Dirty.STYLE);
      return this.iconAtlas;
    });
    return this.iconLoad;
  }

  setEdges(count: number, arrays: EdgeArrays, labels: string[]): void {
    this.press.cancel();
    this.store.setEdges(count, arrays);
    this.labels.setEdgeCount(count);
    this.store.edgeLabels = labels.length > 0 ? labels : null;
    this.syncEdgeOrder();
    const text = this.labels.setEdgeText(labels);
    if (this.selectedEdges + this.focusedEdges > 0) this.listEdgeLooks();
    this.newData();
    this.syncPipes();
    this.markDirty(Dirty.EDGES | (text ? Dirty.LABEL_QUERY | Dirty.LABELS : 0));
  }

  addEdges(indices: Uint32Array, slots: number, arrays: EdgeArrays, labels?: string[]): void {
    this.press.cancel();
    this.store.addEdges(indices, slots, arrays, this.frameInputs.edgeColor);
    this.labels.setEdgeCount(slots);
    this.newData();
    this.syncPipes();
    let dirty = Dirty.EDGES;
    const text = labels ?? (this.store.edgeLabels ? blankLabels(indices.length) : undefined);
    if (text) {
      this.setEdgeLabelsAt(indices, text);
      dirty |= Dirty.LABEL_QUERY | Dirty.LABELS;
    }
    this.markDirty(dirty);
  }

  hideEdges(indices: Uint32Array): void {
    this.store.hideEdges(indices);
    if (this.selectedEdges + this.focusedEdges > 0) this.listEdgeLooks();
    this.markDirty(Dirty.STATE);
  }

  flagEdges(indices: Uint32Array | null, flags: number, on: boolean): void {
    this.store.flagEdges(indices, flags, on);
    if ((flags & (CONSTANTS.STATE_SELECTED | CONSTANTS.STATE_FOCUSED)) !== 0) this.listEdgeLooks();
    this.markDirty(Dirty.STATE);
  }

  updateEdgesAt(indices: Uint32Array, arrays: EdgeArrays, labels?: string[]): void {
    if (arrays.indices) this.newData();
    this.store.updateEdgesAt(indices, arrays, this.frameInputs.edgeColor);
    this.syncPipes();
    let dirty = edgeUpdateDirty(arrays, false);
    if (labels) {
      this.setEdgeLabelsAt(indices, labels);
      dirty |= Dirty.LABEL_QUERY | Dirty.LABELS;
    }
    this.markDirty(dirty);
  }

  updateEdges(arrays: EdgeArrays, labels?: string[] | null): void {
    if (arrays.indices) this.newData();
    this.store.updateEdges(arrays);
    this.syncPipes();
    let dirty = edgeUpdateDirty(arrays, true);
    if (labels !== undefined) {
      this.store.edgeLabels = labels && labels.length > 0 ? labels : null;
      this.syncEdgeOrder();
      if (this.labels.setEdgeText(labels ?? [])) dirty |= Dirty.LABEL_QUERY | Dirty.LABELS;
    }
    this.markDirty(dirty);
  }

  compactEdges(remap: Uint32Array): void {
    this.press.cancel();
    this.store.compactEdges(remap);
    this.labels.setEdgeCount(this.store.edgeCount);
    if (this.store.edgeLabels) this.labels.setEdgeText(this.store.edgeLabels);
    if (this.selectedEdges + this.focusedEdges > 0) this.listEdgeLooks();
    this.newData();
    this.markDirty(Dirty.EDGES);
  }

  private setNodeLabelsAt(indices: Uint32Array, texts: string[]): void {
    const n = this.store.nodeSlots;
    const cur = this.store.nodeLabels;
    let arr: string[];
    if (cur && cur.length === n) arr = cur as string[];
    else {
      arr = new Array<string>(n).fill("");
      if (cur) for (let i = 0; i < Math.min(cur.length, n); i++) arr[i] = cur[i]!;
      this.store.nodeLabels = arr;
    }
    for (let j = 0; j < indices.length; j++) arr[indices[j]!] = texts[j]!;
    this.labels.setNodeTextAt(indices, texts);
  }

  private setEdgeLabelsAt(indices: Uint32Array, texts: string[]): void {
    const n = this.store.edgeCount;
    const cur = this.store.edgeLabels;
    let arr: string[];
    if (cur && cur.length === n) arr = cur as string[];
    else {
      arr = new Array<string>(n).fill("");
      if (cur) for (let i = 0; i < Math.min(cur.length, n); i++) arr[i] = cur[i]!;
      this.store.edgeLabels = arr;
    }
    for (let j = 0; j < indices.length; j++) arr[indices[j]!] = texts[j]!;
    this.syncEdgeOrder();
    this.labels.setEdgeTextAt(indices, texts);
  }

  private syncEdgeOrder(): void {
    const store = this.store;
    const keep = store.edgeLabels !== null || this.pickEdges;
    this.graph.keepEdgeOrder = keep;
    if (!keep) this.graph.setEdgeOrder(null);
    else if (!this.graph.edgeOrder && store.edgeCount > 0) {
      store.reloadEdges();
      this.newData();
      this.markDirty(Dirty.EDGES);
    }
  }

  setInput(partial: GraphInput): void {
    const drag = this.inputState.drag;
    const select = this.inputState.select;
    this.inputState = mergeInput(this.inputState, partial);
    if (drag !== false && this.inputState.drag === false) this.press.cancel();
    if (select !== false && this.inputState.select === false) this.press.cancel();
    this.syncModes();
    this.syncPick();
  }

  private syncModes(): void {
    const c = this.controls;
    const s = this.inputState;
    c.panMode = s.pan;
    c.zoomMode = s.zoom;
    c.rotateMode = s.rotate;
    if (s.zoom !== "auto") c.cancelZoom();
  }

  tune(t: DebugTune): void {
    applyTune(this.wanted, t);
    if (t.pickRate !== undefined) this.pickInterval = 1000 / Math.max(1, t.pickRate);
    this.syncPipes();
  }

  private tunables(): Tunable[] {
    const list: Tunable[] = [this.passes.cull, this.passes.edgeCull, this.passes.edges];
    if (this.pick) list.push(this.pick);
    if (this.hover) list.push(this.hover);
    return list;
  }

  private syncPipes(): void {
    this.wanted.arrows = this.store.hasDirected;
    if (this.pipesLoading || sameTune(this.wanted, this.active)) return;
    const t = { ...this.wanted };
    this.pipesLoading = true;
    Promise.all(this.tunables().map((p) => p.loadTune(t))).then(
      () => {
        this.pipesLoading = false;
        if (this.destroyed) return;
        const passes = this.tunables();
        if (passes.every((p) => p.hasTune(t))) {
          for (const p of passes) p.useTune(t);
          this.active = t;
          this.markDirty(Dirty.STYLE);
        }
        this.syncPipes();
      },
      (e: unknown) => {
        this.pipesLoading = false;
        this.init.onError(e instanceof GraphError ? e : new GraphError("internal", String(e)), false);
      },
    );
  }

  private adopt<T extends Tunable>(pass: T): Promise<T> {
    const t = this.active;
    return pass.loadTune(t).then(() => {
      if (t !== this.active) return this.adopt(pass);
      pass.useTune(t);
      return pass;
    });
  }

  private syncPick(): void {
    const pick = this.inputState.pick;
    const nodes = pick.nodes;
    const edges = pick.edges;
    this.pickKinds = (nodes ? PICKED_NODES : 0) | (edges ? PICKED_EDGES : 0);
    if (!nodes) this.hoverNode = -1;
    if (!edges) this.hoverEdge = -1;
    if (!nodes && this.hover?.setNode(-1, 0, false, this.pixelRatio)) this.markDirty(Dirty.HOVER);
    if (!edges && this.hover?.setEdge(-1, 0, 0, 0)) this.markDirty(Dirty.HOVER);
    const any = this.pickKinds !== 0 || this.inputState.drag !== false || this.inputState.select !== false;
    const edgesChanged = edges !== this.pickEdges;
    this.pickEdges = edges;
    this.pickSeq++;
    if (edgesChanged) {
      this.passes.edgeCull.setLines(edges, (b) => this.graph.retireAfterSubmit(b));
      this.syncEdgeOrder();
      this.markDirty(Dirty.STYLE);
    }
    if (any && !this.pick && !this.pickLoading) {
      this.pickLoading = true;
      PickPass.create(this.gpu.device, this.layouts, this.active)
        .then((pick) => this.adopt(pick))
        .then(
          (pick) => {
            if (this.destroyed) {
              pick.destroy();
              return;
            }
            pick.onResult = this.onPick;
            this.pick = pick;
            this.pickWanted = this.hoverPicks;
            this.wake();
          },
          (e) => this.init.onError(e instanceof GraphError ? e : new GraphError("internal", String(e)), false),
        );
    }
    if (any) this.loadHover();
    this.syncHoverGate();
    this.pickWanted = this.hoverPicks;
    this.wake();
  }

  private get hoverPicks(): boolean {
    return this.hoverGate.open;
  }

  private syncHoverGate(): void {
    const change = this.hoverGate.update(this.pickKinds, this.style.hover !== false, this.hoverEvents);
    if (change > 0) {
      this.pickWanted = true;
      this.wake();
    } else if (change < 0) {
      this.clearHover();
      this.pickWanted = false;
    }
  }

  private loadHover(): void {
    if (this.hover || this.hoverLoading) return;
    this.hoverLoading = true;
    const retire = (b: GPUBuffer) => this.graph.retireAfterSubmit(b);
    HoverPass.create(this.gpu.device, this.gpu.format, this.layouts, this.graph, this.active, retire)
      .then((hover) => this.adopt(hover))
      .then(
        (hover) => {
          if (this.destroyed) {
            hover.destroy();
            return;
          }
          this.hover = hover;
          hover.setHoverLook(this.style.hover);
          hover.setLooks(this.style.selected, this.style.focused);
          hover.setLookList(this.lookList, this.selectedCount, this.focusedCount);
          hover.setEdgeLookList(this.edgeLookList, this.selectedEdges, this.focusedEdges);
          this.passes.nodes.hover = hover;
          this.passes.edges.hover = hover;
          if (this.iconLoad) {
            hover.iconPipe.load().then(
              () => this.markDirty(Dirty.HOVER),
              (e: unknown) => this.init.onError(e instanceof GraphError ? e : new GraphError("internal", String(e)), false),
            );
          }
          this.markDirty(Dirty.HOVER);
        },
        (e) => this.init.onError(e instanceof GraphError ? e : new GraphError("internal", String(e)), false),
      );
  }

  private listLooks(): void {
    const store = this.store;
    const selected = CONSTANTS.STATE_SELECTED;
    const focused = CONSTANTS.STATE_FOCUSED;
    let s = store.listNodes(selected, this.lookList, 0);
    let f = store.listNodes(focused, this.lookList, Math.min(s, this.lookList.length));
    if (s + f > this.lookList.length) {
      this.lookList = new Uint32Array(Math.max(16, 2 ** Math.ceil(Math.log2(s + f))));
      s = store.listNodes(selected, this.lookList, 0);
      f = store.listNodes(focused, this.lookList, s);
    }
    if (s === this.selectedCount && f === this.focusedCount && s + f === 0) return;
    this.selectedCount = s;
    this.focusedCount = f;
    if (this.hover) this.hover.setLookList(this.lookList, s, f);
    else if (s + f > 0) this.loadHover();
  }

  private listEdgeLooks(): void {
    const store = this.store;
    const selected = CONSTANTS.EDGE_STATE_SELECTED;
    const focused = CONSTANTS.EDGE_STATE_FOCUSED;
    let s = store.listEdges(selected, this.edgeLookList, 0);
    let f = store.listEdges(focused, this.edgeLookList, Math.min(s, this.edgeLookList.length));
    if (s + f > this.edgeLookList.length) {
      this.edgeLookList = new Uint32Array(Math.max(16, 2 ** Math.ceil(Math.log2(s + f))));
      s = store.listEdges(selected, this.edgeLookList, 0);
      f = store.listEdges(focused, this.edgeLookList, s);
    }
    if (s === this.selectedEdges && f === this.focusedEdges && s + f === 0) return;
    this.selectedEdges = s;
    this.focusedEdges = f;
    if (this.hover) this.hover.setEdgeLookList(this.edgeLookList, s, f);
    else if (s + f > 0) this.loadHover();
  }

  private newData(): void {
    this.dataGen++;
    this.clearHover();
  }

  private clearHover(): void {
    this.pickSeq++;
    if (this.hoverNode !== -1 || this.hoverEdge !== -1) this.emitHover(-1, -1, PICKED_NODES | PICKED_EDGES, 1);
  }

  private maybePick(now: number): void {
    if (!this.pickWanted || !this.hoverPicks || this.bench || this.press.waiting || this.dragNode >= 0 || this.shapeOn) return;
    const x = this.controls.pointerX;
    const y = this.controls.pointerY;
    if (x < 0 || y < 0) {
      this.pickWanted = false;
      this.pickSeq++;
      this.emitHover(-1, -1, PICKED_NODES | PICKED_EDGES, 1);
      return;
    }
    const pick = this.pick;
    if (!pick || this.frameGen !== this.dataGen || !pick.free) return;
    const due = Math.max(this.pickDue, this.cameraMs + CAMERA_SETTLE_MS);
    if (now < due) {
      if (this.pickTimer === undefined) this.pickTimer = setTimeout(this.pickWake, due - now);
      return;
    }
    if (this.submitPick(pick, x, y, (this.pickKinds & PICKED_NODES) !== 0, (this.pickKinds & PICKED_EDGES) !== 0, this.pickSeq) === 0) return;
    this.hoverX = x;
    this.hoverY = y;
    this.hoverMods = this.mods;
    this.pickWanted = false;
    this.pickDue = now + this.pickInterval;
  }

  private pressPick(): void {
    const p = this.press;
    const drag = this.inputState.drag;
    const nodes = drag !== false || this.inputState.select !== false || (this.pickKinds & PICKED_NODES) !== 0;
    const edges = (this.pickKinds & PICKED_EDGES) !== 0;
    if (!nodes && !edges) {
      p.resolve(-1, -1, 1, false);
      return;
    }
    const pick = this.pick;
    if (!pick || this.frameGen !== this.dataGen || !pick.free) return;
    const seq = this.pickSeq + 1;
    if (this.submitPick(pick, p.x, p.y, nodes, edges, seq) === 0) {
      p.resolve(-1, -1, 1, drag);
      return;
    }
    this.pickSeq = seq;
    p.seq = seq;
  }

  private shoot(event: HitEventName, rec: InputRecord): void {
    this.shotEvent = event;
    this.shotSeq = 0;
    this.shotX = rec.x;
    this.shotY = rec.y;
    this.shotButton = rec.button;
    this.shotMods = rec.mods;
  }

  private shotPick(): void {
    const nodes = (this.pickKinds & PICKED_NODES) !== 0;
    const edges = (this.pickKinds & PICKED_EDGES) !== 0;
    if (nodes || edges) {
      const pick = this.pick;
      if (!pick || this.frameGen !== this.dataGen || !pick.free) return;
      const seq = this.pickSeq + 1;
      if (this.submitPick(pick, this.shotX, this.shotY, nodes, edges, seq) !== 0) {
        this.pickSeq = seq;
        this.shotSeq = seq;
        return;
      }
    }
    this.emitShot(-1, -1);
  }

  private emitShot(node: number, edge: number): void {
    const event = this.shotEvent;
    if (event === null) return;
    this.shotEvent = null;
    this.shotSeq = 0;
    this.init.onHit(event, this.hit(node, edge, this.shotX, this.shotY, this.shotButton, this.shotMods));
  }

  private hit(node: number, edge: number, x: number, y: number, button: number, mods: number): Hit {
    this.camera.screenToWorld(x, y, this.world);
    const r = this.pixelRatio;
    return {
      node: node >= 0 ? node : null,
      edge: edge >= 0 ? edge : null,
      group: null,
      x: this.world.x,
      y: this.world.y,
      screenX: x / r,
      screenY: y / r,
      button,
      shift: (mods & MOD.SHIFT) !== 0,
      ctrl: (mods & MOD.CTRL) !== 0,
      alt: (mods & MOD.ALT) !== 0,
      meta: (mods & MOD.META) !== 0,
    };
  }

  private submitPick(pick: PickPass, x: number, y: number, nodes: boolean, edges: boolean, token: number): number {
    const req = this.pickRequest;
    req.x = x;
    req.y = y;
    req.radiusPx = this.inputState.pickRadius * this.pixelRatio;
    req.edgeRadiusPx = this.inputState.edgePickRadius * this.pixelRatio;
    req.nodes = nodes;
    req.edges = edges;
    req.shapes = this.store.hasNodeShapes;
    req.layers = this.store.hasZLayers;
    req.edgeColors = this.store.hasEdgeColors;
    req.token = token;
    const device = this.gpu.device;
    const encoder = device.createCommandEncoder();
    const picked = pick.encode(encoder, this.frameCtx, this.graph, this.passes.cull, this.passes.edgeCull, req);
    if (picked === 0) return 0;
    device.queue.submit([encoder.finish()]);
    pick.afterSubmit();
    return picked;
  }

  private readonly pickWake = (): void => {
    this.pickTimer = undefined;
    this.wake();
  };

  private readonly onPick = (node: number, edge: number, nodeScale: number, token: number): void => {
    if (this.destroyed) return;
    const seq = Math.floor(token / 4);
    const picked = token % 4;
    const p = this.press;
    const n = (picked & PICKED_NODES) !== 0 ? node : -1;
    const e = (picked & PICKED_EDGES) !== 0 ? edge : -1;
    if (p.waiting && p.seq !== 0 && seq === p.seq) {
      p.resolve(n, e, nodeScale, this.inputState.drag);
    } else if (this.shotEvent !== null && seq === this.shotSeq) this.emitShot(n, e);
    else if (this.atSeq !== 0 && seq === this.atSeq) this.emitAt(n, e);
    else if (seq === this.pickSeq && this.hoverPicks) this.emitHover(node, edge, picked, nodeScale);
    if (this.pickWanted || p.waiting || this.shotEvent !== null || this.atJobs.length > 0) this.wake();
  };

  private startDrag(node: number, nodeScale: number, auto: boolean): void {
    const store = this.store;
    const list = store.nodeFlagged(node, CONSTANTS.STATE_SELECTED) ? this.selectedNodes() : Uint32Array.of(node);
    const n = list.length;
    const mirror = store.channels.nodePos.data as Float32Array;
    const streamed = this.streamedPositions;
    const from = new Float32Array(n * 2);
    for (let j = 0; j < n; j++) {
      const i = list[j]!;
      const pos = streamed && i * 2 + 1 < streamed.length ? streamed : mirror;
      from[j * 2] = pos[i * 2]!;
      from[j * 2 + 1] = pos[i * 2 + 1]!;
    }
    const at = list.indexOf(node);
    this.dragList = list;
    this.dragFrom = from;
    this.dragXY = new Float32Array(n * 2);
    this.dragWords = new Uint32Array(this.dragXY.buffer);
    this.dragNode = node;
    this.dragAuto = auto;
    this.moveEnding = false;
    this.dragDx = 0;
    this.dragDy = 0;
    this.camera.screenToWorld(this.press.x, this.press.y, this.world);
    this.grabX = this.world.x;
    this.grabY = this.world.y;
    store.flagNodes(list, CONSTANTS.STATE_DRAGGING, true);
    this.dirty |= Dirty.STATE;
    if (auto) {
      this.passes.cull.moveNodes();
      this.passes.edgeCull.moveNodes(store.edgeCount);
    }
    if (this.dragEvents) this.init.onDragStart(node, list.slice(), from[at * 2]!, from[at * 2 + 1]!);
    this.hoverX = this.press.x;
    this.hoverY = this.press.y;
    this.hoverMods = this.mods;
    this.emitHover(node, -1, PICKED_NODES | PICKED_EDGES, nodeScale);
    this.wake();
  }

  private selectedNodes(): Uint32Array {
    const looks = this.lookList;
    const store = this.store;
    const selected = CONSTANTS.STATE_SELECTED;
    let n = 0;
    for (let j = 0; j < this.selectedCount; j++) if (store.nodeFlagged(looks[j]!, selected)) n++;
    const out = new Uint32Array(n);
    n = 0;
    for (let j = 0; j < this.selectedCount; j++) if (store.nodeFlagged(looks[j]!, selected)) out[n++] = looks[j]!;
    return out;
  }

  private dragTo(): boolean {
    const px = this.controls.pointerX;
    const py = this.controls.pointerY;
    if (this.dragNode < 0 || px < 0 || py < 0) return false;
    this.camera.screenToWorld(px, py, this.world);
    const dx = this.world.x - this.grabX;
    const dy = this.world.y - this.grabY;
    if (dx === this.dragDx && dy === this.dragDy) return false;
    this.dragDx = dx;
    this.dragDy = dy;
    if (this.dragEvents) this.init.onDrag("drag", this.dragNode, dx, dy);
    return true;
  }

  private moveDragged(): void {
    const store = this.store;
    const from = this.dragFrom;
    const xy = this.dragXY;
    const dx = this.dragDx;
    const dy = this.dragDy;
    for (let k = 0; k < xy.length; k += 2) {
      xy[k] = from[k]! + dx;
      xy[k + 1] = from[k + 1]! + dy;
      store.growBounds(xy[k]!, xy[k + 1]!);
    }
    store.writePositionsAt(this.dragList, this.dragWords);
    this.dirty |= Dirty.MOVED;
  }

  private endDrag(): void {
    const i = this.dragNode;
    if (i < 0) return;
    this.store.flagNodes(this.dragList, CONSTANTS.STATE_DRAGGING, false);
    this.dragNode = -1;
    if (this.dragAuto) this.moveEnding = true;
    this.controls.hold = false;
    if (this.dragEvents) this.init.onDrag("dragEnd", i, this.dragDx, this.dragDy);
    if (this.hoverPicks) this.pickWanted = true;
    this.markDirty(Dirty.STATE);
  }

  private stopHold(pan: boolean): void {
    if (!pan) {
      this.controls.hold = false;
      return;
    }
    if (this.controls.release(this.press.x, this.press.y, this.camera)) {
      this.stopAnim();
      this.dirty |= Dirty.CAMERA;
    }
    this.wake();
  }

  private emitClick(node: number, edge: number, x: number, y: number, button: number, mods: number): void {
    this.selectClick(node, mods);
    if (!this.clickEvents) return;
    const n = (this.pickKinds & PICKED_NODES) !== 0 ? node : -1;
    const e = (this.pickKinds & PICKED_EDGES) !== 0 ? edge : -1;
    this.init.onHit("click", this.hit(n, e, x, y, button, mods));
  }

  private selectKeyHeld(mods: number): boolean {
    if (this.inputState.select === false || (mods & MOD.TOUCH) !== 0) return false;
    const key = this.inputState.selectKey;
    return key === null || (mods & SELECT_KEY_MOD[key]) !== 0;
  }

  private startShape(): void {
    const p = this.press;
    if (this.shapePts.length === 0) this.shapePts = new Float32Array(MAX_SHAPE_POINTS * 2);
    this.shapeOn = true;
    this.shapeLasso = this.inputState.selectShape === "lasso";
    this.shapeMods = p.mods;
    this.shapePts[0] = p.x;
    this.shapePts[1] = p.y;
    this.shapeCount = 1;
    this.loadShapePass();
    this.shapeTo(this.controls.pointerX, this.controls.pointerY);
  }

  private shapeTo(x: number, y: number): void {
    if (!this.shapeOn) return;
    const pts = this.shapePts;
    if (!this.shapeLasso) {
      pts[2] = x;
      pts[3] = y;
      this.shapeCount = 2;
    } else {
      const n = this.shapeCount;
      const dx = x - pts[n * 2 - 2]!;
      const dy = y - pts[n * 2 - 1]!;
      const step = SHAPE_STEP_CSS_PX * this.pixelRatio;
      if (dx * dx + dy * dy < step * step) return;
      const k = n < MAX_SHAPE_POINTS ? n : n - 1;
      pts[k * 2] = x;
      pts[k * 2 + 1] = y;
      this.shapeCount = k + 1;
    }
    this.drawShape();
  }

  private boxPoints(): Float32Array {
    const p = this.shapePts;
    const b = this.shapeBox;
    b[0] = p[0]!;
    b[1] = p[1]!;
    b[2] = p[2]!;
    b[3] = p[1]!;
    b[4] = p[2]!;
    b[5] = p[3]!;
    b[6] = p[0]!;
    b[7] = p[3]!;
    return b;
  }

  private drawShape(): void {
    const pass = this.shapePass;
    if (!pass) return;
    const stroke = Math.max(1, this.pixelRatio);
    if (this.shapeLasso) pass.setShape(this.shapePts, this.shapeCount, stroke);
    else if (this.shapeCount === 2) pass.setShape(this.boxPoints(), 4, stroke);
    this.markDirty(Dirty.HOVER);
  }

  private loadShapePass(): void {
    if (this.shapePass || this.shapeLoading) return;
    this.shapeLoading = true;
    SelectionShapePass.create(this.gpu.device, this.gpu.format, this.layouts).then(
      (pass) => {
        if (this.destroyed) {
          pass.destroy();
          return;
        }
        this.shapePass = pass;
        pass.setColors(this.style.selection.fill, this.style.selection.stroke);
        this.passes.labelDraw.overlay = pass;
        if (this.shapeOn) this.drawShape();
      },
      (e: unknown) => this.init.onError(e instanceof GraphError ? e : new GraphError("internal", String(e)), false),
    );
  }

  private stopShape(): void {
    this.shapeOn = false;
    this.controls.hold = false;
    this.shapePass?.hide();
    if (this.hoverPicks) this.pickWanted = true;
    this.markDirty(Dirty.HOVER);
  }

  private endShape(): void {
    if (!this.shapeOn) return;
    this.stopShape();
    const lasso = this.shapeLasso;
    const kind = lasso ? "lasso" : "box";
    const mods = this.shapeMods;
    const n = this.shapeCount;
    if (lasso ? n < 3 : n < 2) {
      this.applyShape(new Uint32Array(0), kind, mods);
      return;
    }
    const poly = lasso ? this.shapePts.slice(0, n * 2) : this.boxPoints().slice();
    this.findInside(
      poly,
      (nodes) => this.applyShape(nodes, kind, mods),
      (e) => this.init.onError(e, false),
    );
  }

  private cancelShape(): void {
    if (this.shapeOn) this.stopShape();
  }

  private liveNodes(nodes: Uint32Array): Uint32Array {
    const store = this.store;
    const hidden = CONSTANTS.STATE_HIDDEN;
    const slots = store.nodeSlots;
    let n = 0;
    for (let j = 0; j < nodes.length; j++) {
      const i = nodes[j]!;
      if (i < slots && !store.nodeFlagged(i, hidden)) nodes[n++] = i;
    }
    return n === nodes.length ? nodes : nodes.subarray(0, n);
  }

  private applyShape(nodes: Uint32Array, shape: "box" | "lasso", mods: number): void {
    const mode = this.inputState.select;
    if (this.destroyed || mode === false) return;
    const live = this.liveNodes(nodes);
    if (mode === "manual") {
      this.emitSelect(live, shape, mods);
      return;
    }
    const s = this.selection;
    s.load(this.selectedNodes());
    s.shape(live, shapeAdds(mods, this.inputState.selectKey));
    this.applySelection();
    this.emitSelect(s.nodes, shape, mods);
  }

  private selectClick(node: number, mods: number): void {
    const mode = this.inputState.select;
    if (mode === false) return;
    const store = this.store;
    const n = node >= 0 && node < store.nodeSlots && !store.nodeFlagged(node, CONSTANTS.STATE_HIDDEN) ? node : -1;
    if (mode === "manual") {
      this.emitSelect(n >= 0 ? Uint32Array.of(n) : new Uint32Array(0), "click", mods);
      return;
    }
    const s = this.selection;
    s.load(this.selectedNodes());
    s.click(n >= 0 ? n : null, (mods & MOD.SHIFT) !== 0);
    this.applySelection();
    this.emitSelect(s.nodes, "click", mods);
  }

  private applySelection(): void {
    const s = this.selection;
    if (s.removed.length === 0 && s.added.length === 0) return;
    const selected = CONSTANTS.STATE_SELECTED;
    if (s.removed.length > 0) this.store.flagNodes(s.removed, selected, false);
    if (s.added.length > 0) this.store.flagNodes(s.added, selected, true);
    this.listLooks();
    this.markDirty(Dirty.STATE);
  }

  private emitSelect(nodes: Uint32Array, shape: SelectEvent["shape"], mods: number): void {
    if (!this.selectEvents) return;
    this.init.onSelect({
      nodes: nodes.slice(),
      shape,
      shift: (mods & MOD.SHIFT) !== 0,
      ctrl: (mods & MOD.CTRL) !== 0,
      alt: (mods & MOD.ALT) !== 0,
      meta: (mods & MOD.META) !== 0,
    });
  }

  private emitHover(node: number, edge: number, picked: number, nodeScale: number): void {
    const hoverNodes = (picked & PICKED_NODES) !== 0 && (this.pickKinds & PICKED_NODES) !== 0;
    const hoverEdges = (picked & PICKED_EDGES) !== 0 && (this.pickKinds & PICKED_EDGES) !== 0;
    let moved = false;
    if (hoverNodes && node !== this.hoverNode) {
      this.hoverNode = node;
      moved = true;
    }
    if (hoverEdges && edge !== this.hoverEdge) {
      this.hoverEdge = edge;
      moved = true;
    }
    if (moved && this.hoverEvents) this.init.onHit("hover", this.hit(this.hoverNode, this.hoverEdge, this.hoverX, this.hoverY, -1, this.hoverMods));
    const hover = this.hover;
    if (!hover) return;
    let changed = false;
    if (hoverNodes) changed = hover.setNode(node, nodeScale, this.store.hasNodeShapes, this.pixelRatio) || changed;
    if (hoverEdges) {
      const ch = this.store.channels;
      const ends = ch.edgeIdx.data as Uint32Array;
      const style = edge >= 0 && this.store.hasEdgeStyles ? ch.edgeStyle.data[edge]! : 0;
      changed = hover.setEdge(edge, edge >= 0 ? ends[edge * 2]! : 0, edge >= 0 ? ends[edge * 2 + 1]! : 0, style) || changed;
    }
    if (changed && this.style.hover) this.markDirty(Dirty.HOVER);
  }

  setStream(stream: StreamSlots): void {
    this.stream = stream;
    this.wake();
  }

  private takeStream(): number {
    const s = this.stream;
    const n = this.store.nodeCount;
    if (!s || !s.pending || s.count !== this.store.nodeSlots) return 0;
    if ((s.positions && !this.graph.canStream("nodePos", n)) || (s.colors && !this.graph.canStream("nodeColor", n))) return 0;
    if (s.zIndex && !this.graph.canStream("nodeStyle", n)) return 0;
    const slot = s.take()!;
    let bytes = 0;
    if (s.positions) {
      this.streamedPositions = slot.positions;
      this.dirty |= Dirty.POSITIONS;
      bytes += this.graph.streamChannel("nodePos", slot.positions);
    }
    if (s.colors) {
      this.streamedColors = slot.colors;
      this.dirty |= Dirty.STYLE;
      bytes += this.graph.streamChannel("nodeColor", slot.colors);
    }
    if (s.zIndex) {
      this.streamedZIndex = slot.zIndex;
      this.store.hasZLayers = true;
      this.dirty |= Dirty.STYLE;
      bytes += this.graph.streamLayers(slot.zWords);
    }
    return bytes;
  }

  private syncStreamed(arrays: NodeArrays): void {
    const n = this.store.nodeSlots;
    const p = this.streamedPositions;
    if (p && !arrays.positions && p.length === n * 2) this.store.updatePositions(0, p);
    const c = this.streamedColors;
    if (c && !arrays.colors && c.length === n) this.store.updateColors(0, c);
    const z = this.streamedZIndex;
    if (z && !arrays.zIndex && z.length === n) this.store.syncZIndex(z);
    this.streamedPositions = null;
    this.streamedColors = null;
    this.streamedZIndex = null;
  }

  setView(view: Partial<CameraView>, duration: number, easing: CameraEasing): void {
    this.beginMove();
    const r = view.rotation;
    const rotation = r === undefined ? undefined : nearestAngle(this.animFrom.rotation, r);
    const zoom = view.zoom === undefined ? undefined : view.zoom * this.pixelRatio;
    this.camera.setView({ x: view.x, y: view.y, zoom, rotation });
    this.endMove(duration, easing);
  }

  fit(padding: number, nodes: Uint32Array | null, bounds: WorldBounds | null, duration: number): void {
    const nodeScale = this.frameInputs.nodeScale;
    const b = nodes ? this.store.nodeBounds(nodes, nodeScale, this.streamedPositions) : (bounds ?? this.store.drawnBounds(nodeScale));
    if (!b) return;
    this.beginMove();
    this.camera.fitRotated(b, padding * this.pixelRatio);
    this.endMove(duration, "ease");
  }

  rotate(angle: number, x: number | undefined, y: number | undefined, duration: number): void {
    const c = this.camera;
    const sx = x === undefined ? c.viewportW * 0.5 : x * this.pixelRatio;
    const sy = y === undefined ? c.viewportH * 0.5 : y * this.pixelRatio;
    this.beginMove();
    c.screenToWorld(sx, sy, this.world);
    c.rotateAround(angle, sx, sy);
    this.endMove(duration, "ease");
    const p = this.pivot;
    if (!this.anim.active) return;
    p.wx = this.world.x;
    p.wy = this.world.y;
    p.sx = sx;
    p.sy = sy;
    p.on = true;
  }

  limits(minZoom: number, maxZoom: number, bounds: WorldBounds | null): void {
    this.minZoomCss = minZoom;
    this.maxZoomCss = maxZoom;
    this.limitBounds = bounds;
    this.applyLimits();
    this.markDirty(Dirty.CAMERA);
  }

  listen(events: readonly WorkerEventName[]): void {
    this.viewEvents = events.includes("view");
    this.hoverEvents = events.includes("hover");
    this.clickEvents = events.includes("click");
    this.doubleClickEvents = events.includes("doubleClick");
    this.menuEvents = events.includes("contextMenu");
    this.dragEvents = events.includes("dragStart") || events.includes("drag") || events.includes("dragEnd");
    this.panEvents = events.includes("pan");
    this.zoomEvents = events.includes("zoom");
    this.rotateEvents = events.includes("rotate");
    this.selectEvents = events.includes("select");
    this.syncHoverGate();
  }

  private flushGestures(nowMs: number): void {
    const c = this.controls;
    const due = c.settleWheel(nowMs);
    if (due > 0 && this.zoomEvents && this.gestureTimer === undefined) this.gestureTimer = setTimeout(this.gestureWake, due);
    this.flushGesture(c.panGesture, "pan", this.panEvents);
    this.flushGesture(c.zoomGesture, "zoom", this.zoomEvents);
    this.flushGesture(c.rotateGesture, "rotate", this.rotateEvents);
  }

  private flushGesture(g: Gesture, t: GestureMessage["t"], listen: boolean): void {
    if (g.dirty) {
      if (listen) this.postGesture(g, t, g.sent ? "move" : "start");
      g.sent = true;
      g.clear();
    }
    if (g.ended) {
      if (listen && g.sent) this.postGesture(g, t, "end");
      g.ended = false;
      g.sent = false;
    }
  }

  private postGesture(g: Gesture, t: GestureMessage["t"], phase: GesturePhase): void {
    const r = this.pixelRatio;
    const m = g.mods;
    const x = g.x / r;
    const y = g.y / r;
    const shift = (m & MOD.SHIFT) !== 0;
    const ctrl = (m & MOD.CTRL) !== 0;
    const alt = (m & MOD.ALT) !== 0;
    const meta = (m & MOD.META) !== 0;
    if (t === "pan") this.init.onGesture({ t, event: { phase, dx: g.dx / r, dy: g.dy / r, x, y, shift, ctrl, alt, meta } });
    else if (t === "zoom") this.init.onGesture({ t, event: { phase, factor: g.factor, x, y, shift, ctrl, alt, meta } });
    else this.init.onGesture({ t, event: { phase, angle: g.angle, x, y, shift, ctrl, alt, meta } });
  }

  private readonly gestureWake = (): void => {
    this.gestureTimer = undefined;
    this.wake();
  };

  private applyLimits(): void {
    this.camera.setLimits(this.minZoomCss * this.pixelRatio, this.maxZoomCss * this.pixelRatio, this.limitBounds);
  }

  private stopAnim(): void {
    this.anim.cancel();
    this.pivot.on = false;
  }

  private beginMove(): void {
    this.controls.cancelZoom();
    this.stopAnim();
    readView(this.camera, this.animFrom);
  }

  private endMove(duration: number, easing: CameraEasing): void {
    if (duration > 0) {
      const c = this.camera;
      readView(c, this.animTo);
      const f = this.animFrom;
      c.x = f.x;
      c.y = f.y;
      c.zoom = f.zoom;
      c.rotation = f.rotation;
      this.anim.start(f, this.animTo, duration, easing, performance.now());
    } else this.camera.rotation = wrapAngle(this.camera.rotation);
    this.markDirty(Dirty.CAMERA);
  }

  private stepCamera(nowMs: number): void {
    const v = this.animView;
    const more = this.anim.step(nowMs, v);
    const c = this.camera;
    c.setView(v);
    if (!more) c.rotation = wrapAngle(c.rotation);
    const p = this.pivot;
    if (p.on) c.pin(p.wx, p.wy, p.sx, p.sy);
    if (!more) p.on = false;
    this.dirty |= Dirty.CAMERA;
  }

  setStyle(partial: GraphStyle): void {
    const s = mergeStyle(this.style, partial);
    this.style = s;
    const fi = this.frameInputs;
    let dirty = 0;
    if (partial.background) {
      const bg = s.background;
      const transparent = bg[3] < 1;
      if (transparent !== this.transparent) {
        this.transparent = transparent;
        this.context.configure({ device: this.gpu.device, format: this.gpu.format, alphaMode: transparent ? "premultiplied" : "opaque" });
        dirty |= Dirty.FORCED;
      }
      this.frameGraph.setClearColor(bg[0], bg[1], bg[2], bg[3]);
      dirty |= Dirty.CLEAR_COLOR;
    }
    if (partial.nodeScale !== undefined || partial.edge || partial.icon) {
      const tint = packRgbaTuple(s.edge.color);
      if (tint !== fi.edgeColor) this.store.retintEdges(tint);
      fi.nodeScale = s.nodeScale;
      fi.edgeWidth = s.edge.width;
      fi.edgeColor = tint;
      fi.iconScale = s.icon.scale;
      fi.iconMinPx = s.icon.minPx;
      dirty |= Dirty.STYLE;
    }
    if (partial.hover !== undefined || partial.selected || partial.focused || partial.dimmed) {
      this.writeLooks();
      this.hover?.setHoverLook(s.hover);
      this.hover?.setLooks(s.selected, s.focused);
      dirty |= Dirty.STYLE | Dirty.HOVER;
      if (partial.hover !== undefined) this.syncHoverGate();
    }
    if (partial.selection && this.shapePass) {
      this.shapePass.setColors(s.selection.fill, s.selection.stroke);
      if (this.shapeOn) dirty |= Dirty.HOVER;
    }
    if (partial.label) {
      const l = s.label;
      if (this.labels.setStyle({ sizeCssPx: l.size, paddingCssPx: l.padding, font: l.font })) {
        this.passes.labels.setViewport(this.camera.viewportW, this.camera.viewportH);
        dirty |= Dirty.LABEL_QUERY | Dirty.LABELS | Dirty.LABELLED;
      }
      this.labels.setColor(packRgbaTuple(l.color));
      dirty |= Dirty.LABELS;
    }
    this.markDirty(dirty);
  }

  private writeLooks(): void {
    const s = this.style;
    const fi = this.frameInputs;
    fi.dimmedAlpha = s.dimmed.alpha;
    fi.selectedEdgeColor = packRgbaTuple(s.selected.edgeColor);
    fi.selectedEdgeWidth = s.selected.edgeWidth;
    fi.focusedEdgeColor = packRgbaTuple(s.focused.edgeColor);
    fi.focusedEdgeWidth = s.focused.edgeWidth;
  }

  labelSnapshot(id: number): void {
    this.passes.labels.requestSnapshot(id);
    this.markDirty(Dirty.LABEL_QUERY);
  }

  requestRender(): void {
    this.markDirty(Dirty.FORCED);
  }

  snapshot(id: number, type: string): void {
    this.snapJobs.push({ id, type });
    this.markDirty(Dirty.FORCED);
  }

  private takeSnapshots(): void {
    const canvas = this.init.canvas;
    for (const job of this.snapJobs.splice(0)) {
      canvas.convertToBlob({ type: job.type }).then(
        (blob) => {
          if (!this.destroyed) this.init.onSnapshot(job.id, blob, null);
        },
        (e: unknown) => {
          if (!this.destroyed) this.init.onSnapshot(job.id, null, e instanceof GraphError ? e : new GraphError("internal", String(e)));
        },
      );
    }
  }

  queryAt(id: number, x: number, y: number): void {
    this.atJobs.push({ id, x: x * this.pixelRatio, y: y * this.pixelRatio });
    this.wake();
  }

  queryInside(id: number, points: Float32Array): void {
    this.findInside(
      points,
      (nodes) => this.init.onQueryInside(id, nodes, null),
      (e) => this.init.onQueryInside(id, null, e),
    );
  }

  private findInside(points: Float32Array, done: QueryDone, fail: QueryFail): void {
    this.query ??= new QueryPass(this.gpu.device, this.layouts, () => this.wake(), (e) => this.init.onError(e, false));
    this.query.request(points, done, fail);
  }

  private runQuery(): void {
    this.query!.run(this.frameUniform.bindGroup, this.graph, this.store.nodeCount);
  }

  private atPick(): void {
    const job = this.atJobs[0]!;
    const nodes = (this.pickKinds & PICKED_NODES) !== 0;
    const edges = (this.pickKinds & PICKED_EDGES) !== 0;
    if (nodes || edges) {
      const pick = this.pick;
      if (!pick || this.frameGen !== this.dataGen || !pick.free) return;
      const seq = this.pickSeq + 1;
      if (this.submitPick(pick, job.x, job.y, nodes, edges, seq) !== 0) {
        this.pickSeq = seq;
        this.atSeq = seq;
        return;
      }
    }
    this.emitAt(-1, -1);
  }

  private emitAt(node: number, edge: number): void {
    const job = this.atJobs.shift();
    this.atSeq = 0;
    if (job) this.init.onQueryAt(job.id, this.hit(node, edge, job.x, job.y, -1, 0));
  }

  /** Play `opts.path` one step per rendered frame and record per-frame timings. */
  benchmark(id: number, opts: BenchmarkOptions): void {
    if (this.bench) throw new GraphError("invalid-argument", "A benchmark is already running");
    const c = this.camera;
    const fitZoom = Camera2D.fitZoomIn(this.store.bounds, FIT_PADDING_CSS_PX * this.pixelRatio, c.viewportW, c.viewportH);
    const path = new CameraPath(opts.path, opts.frames, this.store.bounds, fitZoom);
    this.bench = new Benchmark(id, path, opts.warmup ?? DEFAULT_WARMUP_FRAMES, this.profiler.slotNames);
    this.probe.setOverride(BENCH_TIMING[opts.timing ?? "passes"]);
    this.markDirty(Dirty.CAMERA);
  }

  /** Apply one input record (from the ring or the postMessage fallback). */
  input(rec: InputRecord): void {
    if (this.probe.full) this.probe.input(rec.t);
    this.mods = rec.mods;
    const handoff = this.controls.pinching;
    if (this.controls.apply(rec, this.camera)) {
      this.stopAnim();
      this.dirty |= Dirty.CAMERA;
    }
    const p = this.press;
    if (rec.type === INPUT.POINTER_DOWN) {
      const drag = this.inputState.drag !== false;
      const select = this.inputState.select !== false;
      const shape = select && this.selectKeyHeld(rec.mods);
      if (!handoff && (rec.buttons & 1) !== 0 && (drag || select || this.clickEvents)) {
        p.down(rec.x, rec.y, drag || shape, rec.button, rec.mods, shape);
        this.controls.hold = drag || shape;
      } else p.cancel();
    } else if (rec.type === INPUT.DBLCLICK) {
      if (this.doubleClickEvents) this.shoot("doubleClick", rec);
    } else if (rec.type === INPUT.MENU) {
      p.cancel();
      if (this.menuEvents) this.shoot("contextMenu", rec);
    } else if (rec.type === INPUT.POINTER_MOVE) p.move(rec.x, rec.y, CLICK_SLOP_CSS_PX * this.pixelRatio);
    else if (rec.type === INPUT.POINTER_UP) p.up();
    else if (rec.type === INPUT.PINCH) p.cancel();
    if (rec.type === INPUT.POINTER_MOVE || rec.type === INPUT.POINTER_LEAVE || rec.type === INPUT.POINTER_DOWN) {
      this.frameInputs.pointerX = this.controls.pointerX;
      this.frameInputs.pointerY = this.controls.pointerY;
      if (this.hoverPicks) this.pickWanted = true;
    }
  }

  wake(): void {
    if (this.framePending || this.destroyed) return;
    this.framePending = true;
    this.init.requestFrame(this.tick);
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.benchTimer);
    clearTimeout(this.pickTimer);
    clearTimeout(this.gestureTimer);
    this.pick?.destroy();
    this.query?.destroy();
    this.shapePass?.destroy();
    this.hover?.destroy();
    this.probe.destroy();
    this.passes.cull.destroy();
    this.passes.order.destroy();
    this.passes.edgeCull.destroy();
    this.passes.labels.destroy();
    this.labels.destroy();
    this.iconAtlas?.destroy();
    this.profiler.destroy();
    this.graph.destroy();
    this.frameUniform.destroy();
    this.context.unconfigure();
    this.gpu.device.destroy();
  }

  // ---- frame loop -------------------------------------------------------------

  private clock(): number {
    return (performance.now() - this.startTime) / 1000;
  }

  private markDirty(flags: number): void {
    this.dirty |= flags;
    this.wake();
  }

  private readonly tick = (): void => {
    this.framePending = false;
    if (this.destroyed) return;
    const t0 = performance.now();
    const probe = this.probe;
    const full = probe.full;
    if (full) probe.begin(t0);

    const ring = this.init.ring;
    if (ring) ring.drain(this.inputRec, this.applyInput);
    const streamedBytes = this.takeStream();

    // Advance the zoom glide before deciding whether the frame is idle: while a
    // glide is in flight it keeps the loop awake, and when it settles the frame
    // is skipped exactly as before.
    const dt = this.lastTickMs === 0 ? 0 : (t0 - this.lastTickMs) / 1000;
    this.lastTickMs = t0;
    if (dt > 0 && this.controls.advance(dt, this.camera)) this.dirty |= Dirty.CAMERA;
    this.flushGestures(t0);
    if (this.anim.active) this.stepCamera(t0);
    if (this.dragNode >= 0) {
      this.press.step();
      if (this.dragAuto && streamedBytes > 0 && this.stream?.positions) this.moveDragged();
    }
    if (this.press.waiting && this.press.seq === 0) this.pressPick();
    if (this.shotEvent !== null && this.shotSeq === 0) this.shotPick();
    if (this.atJobs.length > 0 && this.atSeq === 0) this.atPick();
    if (full) probe.mark(CPU.INPUT);
    const now = this.clock();
    if (this.labels.stepWidths()) this.dirty |= Dirty.LABEL_QUERY;
    if (this.labels.settle(now)) this.dirty |= Dirty.LABELS | Dirty.LABELLED;
    if (this.labels.animating(now)) this.dirty |= Dirty.LABELS;
    if (full) probe.mark(CPU.LABELS);

    const bench = this.bench;
    const benchFrame = bench !== null && bench.driving;
    if (benchFrame) {
      bench.beforeFrame(this.camera);
      this.dirty |= Dirty.CAMERA;
    }

    if ((this.dirty & (Dirty.CAMERA | Dirty.RESIZE)) !== 0) {
      this.cameraMs = t0;
      if (this.dragNode < 0 && (this.hoverNode !== -1 || this.hoverEdge !== -1)) {
        this.clearHover();
        if (this.hoverPicks) this.pickWanted = true;
      }
    }
    if (this.pickWanted) this.maybePick(t0);

    if (this.dirty === 0) {
      if (this.query?.ready) this.runQuery();
      // Idle: skip the frame entirely. Sleep unless input raced in.
      if (!ring) return;
      if (!ring.trySleep()) {
        this.wake();
        return;
      }
      if (this.stream?.pending && ring.claimWake()) this.wake();
      return;
    }

    if (!full && probe.on) probe.begin(t0);
    const frameDirty = this.dirty;
    this.profiler.setTimed(probe.on);
    this.frameGraph.split = full;
    const uploaded = this.graph.flush();
    if (this.graph.edgesUnsorted) this.dirty |= Dirty.EDGES;
    if (full) probe.mark(CPU.UPLOAD);
    const atlas = this.iconAtlas;
    if (atlas && atlas.paletteVersion !== this.store.paletteVersion) atlas.setPalette(this.store.iconPalette, this.store.paletteVersion);
    const icons = this.store.hasIcons && atlas !== null && atlas.count > 0;
    const nodeCount = this.reserveNodes(icons);
    const edgeCount = this.reserveEdges();
    const restyled = this.graph.restyledEdges;
    if (restyled > 0 && this.graph.edgeRank) {
      const slot = this.graph.restyleSlot;
      this.passes.edgeCull.restyle(this.graph.edgeRank, slot.ranges, slot.params, restyled, edgeCount);
    }
    if (full) probe.mark(CPU.RESERVE);

    const fi = this.frameInputs;
    fi.time = (t0 - this.startTime) / 1000;
    fi.frameIndex = this.frameIndex;
    fi.pixelRatio = this.pixelRatio;
    fi.nodeCount = nodeCount;
    fi.edgeCount = edgeCount;
    fi.flags = (this.store.hiddenCount > 0 ? CONSTANTS.FRAME_FLAG_HIDDEN : 0) | (this.store.dimmedCount > 0 ? CONSTANTS.FRAME_FLAG_DIMMED : 0);
    const hover = this.hover;
    if (hover) {
      hover.syncLooks(this.store.hasNodeShapes, this.store.hasEdgeStyles, this.pixelRatio);
      if (hover.edgeLookCount > 0 && edgeCount > 0 && (this.graph.edgeRank !== null || (this.graph.edgesUnsorted && this.store.edgeRankWanted))) fi.flags |= CONSTANTS.FRAME_FLAG_EDGE_LOOKS;
    }
    this.frameUniform.write(fi);

    const ctx = this.frameCtx;
    ctx.graphBindGroup = this.graph.bindGroup;
    ctx.nodeCount = nodeCount;
    ctx.edgeCount = edgeCount;
    ctx.dirty = this.dirty;
    ctx.icons = icons && this.passes.cull.tailed ? atlas : null;
    this.passes.edges.perEdgeStyle = this.store.hasEdgeStyles;
    this.passes.edges.perEdgeColor = this.store.hasEdgeColors;
    this.passes.cull.shapes = this.store.hasNodeShapes;
    this.passes.cull.layers = this.store.hasZLayers;
    this.passes.order.layers = this.store.hasZLayers;
    this.passes.nodes.layers = this.store.hasZLayers;
    this.passes.nodes.shapes = this.store.hasNodeShapes;
    this.passes.edges.shapes = this.store.hasNodeShapes;

    const device = this.gpu.device;
    const encoder = device.createCommandEncoder();
    this.profiler.beginFrame();
    if (full) probe.mark(CPU.UNIFORM);
    const target = this.context.getCurrentTexture().createView();
    if (full) probe.mark(CPU.TEXTURE);
    this.frameGraph.execute(encoder, target, ctx, full ? this.encodeTimes : null);
    if (this.moveEnding) {
      this.moveEnding = false;
      this.passes.cull.endMove();
      this.passes.edgeCull.endMove();
    }
    if (full) probe.sync();
    this.passes.labels.recordFrame(this.frameIndex);
    this.passes.labels.recordReadback(encoder);
    this.profiler.endFrame(
      encoder,
      this.frameIndex,
      nodeCount > 0 ? this.passes.cull.outputs!.scratch : null,
      edgeCount > 0 ? this.passes.edgeCull.outputs!.scratch : null,
    );
    if (full) probe.mark(CPU.READBACK);
    this.submitList[0] = encoder.finish();
    if (full) probe.mark(CPU.FINISH);
    device.queue.submit(this.submitList);
    if (this.snapJobs.length > 0) this.takeSnapshots();
    if (full) probe.mark(CPU.SUBMIT);
    this.profiler.afterSubmit();
    this.passes.labels.afterSubmit();
    this.graph.afterSubmit();
    if (this.query?.ready) this.runQuery();
    if (full) probe.mark(CPU.AFTER);

    const cpuMs = performance.now() - t0;
    if (benchFrame) bench.afterFrame(this.frameIndex, t0, cpuMs);
    if (bench && !bench.driving && benchFrame) this.waitBenchGpu(bench);
    if (probe.on) {
      const solves = this.labels.solves;
      const solveMs = solves !== this.labelSolves ? this.passes.labels.lastSolveMs : NaN;
      this.labelSolves = solves;
      probe.end(this.frameIndex, t0, cpuMs, frameDirty, (uploaded ? this.graph.lastUploadBytes : 0) + streamedBytes, this.labels.live.shownCount, solveMs);
    }
    this.dirty = (this.passes.labels.busy ? Dirty.LABELS : 0) | (this.passes.labels.marked ? Dirty.LABELLED : 0);
    this.passes.labels.marked = false;
    this.frameIndex++;
    this.renderedFrames++;
    this.cpuMsAvg = this.renderedFrames === 1 ? cpuMs : this.cpuMsAvg + (cpuMs - this.cpuMsAvg) * CPU_EMA;
    this.publishState(cpuMs, (uploaded ? this.graph.lastUploadBytes : 0) + streamedBytes);
    if (this.viewEvents && (frameDirty & (Dirty.CAMERA | Dirty.RESIZE)) !== 0) {
      const c = this.camera;
      this.init.onView(c.x, c.y, c.zoom, c.rotation);
    }
    if (bench && !bench.driving) this.scheduleBenchCheck();
    this.frameGen = this.dataGen;
    if ((frameDirty & PICK_DIRTY) !== 0 && this.hoverPicks) this.pickWanted = true;

    // One more tick to pick up input that arrived during this frame; it sleeps if there is none.
    this.wake();
  };

  /** Size the cull buffers for the current node count; returns the drawable count. */
  private reserveNodes(icons: boolean): number {
    const n = this.store.nodeCount;
    if (n !== this.reservedFor || icons !== this.reservedIcons) {
      this.reservedIcons = icons;
      const tail = icons && this.passes.cull.fits(n, true);
      if (icons && !tail && !this.iconsTooLarge) {
        const msg = `${n.toLocaleString("en-US")} nodes with icons need a larger buffer than this GPU binds: nodes are drawn without icons.`;
        this.init.onError(new GraphError("limits-exceeded", msg), false);
      }
      this.iconsTooLarge = icons && !tail;
      try {
        const retire = (b: GPUBuffer) => this.graph.retireAfterSubmit(b);
        this.passes.cull.reserve(n, retire, tail);
        this.passes.nodes.bind(this.passes.cull.outputs!);
        this.reservedFor = n;
      } catch (e) {
        this.reservedFor = n;
        this.init.onError(e instanceof GraphError ? e : new GraphError("internal", String(e)), false);
        this.passes.cull.outputs = null;
      }
    }
    return this.passes.cull.outputs ? n : 0;
  }

  /** Size the edge buffers for the current edge count; returns the drawable count. */
  private reserveEdges(): number {
    const e = this.store.edgeCount;
    if (e !== this.reservedEdgesFor) {
      this.reservedEdgesFor = e;
      try {
        this.passes.edgeCull.reserve(e, (b) => this.graph.retireAfterSubmit(b));
        this.passes.edges.bind(this.passes.edgeCull.outputs!);
      } catch (err) {
        this.init.onError(err instanceof GraphError ? err : new GraphError("internal", String(err)), false);
        this.passes.edgeCull.outputs = null;
      }
    }
    return this.passes.edgeCull.outputs ? e : 0;
  }

  private readonly onProfileSample = (s: ProfileSample): void => {
    const t0 = this.probe.full ? performance.now() : 0;
    this.passes.labels.onProfile(s.frameIndex, s.slotMs, this.profiler.slotNames);
    this.telemetry.onSample(s, this.profiler.droppedFrames, this.profiler.zeroSamples);
    if (this.probe.on || this.probe.recording) this.probe.onSample(s);
    if (this.bench) {
      this.bench.onSample(s);
      this.finishBenchIfComplete();
    }
    if (this.probe.full) this.probe.async(CPU.ASYNC_PROFILE, performance.now() - t0);
  };

  private waitBenchGpu(bench: Benchmark): void {
    const t0 = bench.firstT0;
    this.gpu.device.queue.onSubmittedWorkDone().then(() => {
      bench.gpuDone(performance.now() - t0);
      this.finishBenchIfComplete();
    }, () => bench.gpuDone(NaN));
  }

  private scheduleBenchCheck(): void {
    clearTimeout(this.benchTimer);
    this.benchTimer = setTimeout(() => this.finishBenchIfComplete(), 2100);
  }

  private finishBenchIfComplete(): void {
    const b = this.bench;
    if (!b || !b.complete) return;
    clearTimeout(this.benchTimer);
    this.bench = null;
    this.probe.setOverride(null);
    const result = b.result({
      nodeCount: this.store.nodeSlots,
      viewport: [this.camera.viewportW, this.camera.viewportH],
      adapter: this.caps.adapter,
      timestampQuery: this.caps.timestampQuery,
    });
    this.init.onBenchmark(b.id, result, b.transferables());
  }

  private publishState(cpuMs: number, uploadBytes: number): void {
    const s = this.init.state;
    const c = this.camera;
    s[STATE_SLOT.FRAME_INDEX] = this.frameIndex;
    s[STATE_SLOT.RENDERED_FRAMES] = this.renderedFrames;
    s[STATE_SLOT.CPU_MS_LAST] = cpuMs;
    s[STATE_SLOT.CPU_MS_AVG] = this.cpuMsAvg;
    s[STATE_SLOT.NODE_COUNT] = this.store.nodeSlots;
    s[STATE_SLOT.EDGE_COUNT] = this.store.liveEdges;
    s[STATE_SLOT.VIEWPORT_W] = c.viewportW;
    s[STATE_SLOT.VIEWPORT_H] = c.viewportH;
    s[STATE_SLOT.CAMERA_X] = c.x;
    s[STATE_SLOT.CAMERA_Y] = c.y;
    s[STATE_SLOT.CAMERA_ZOOM] = c.zoom;
    s[STATE_SLOT.CAMERA_ROTATION] = c.rotation;
    s[STATE_SLOT.UPLOAD_BYTES] = uploadBytes;
    s[STATE_SLOT.GPU_BYTES] = this.gpu.memory.bytes;
    s[STATE_SLOT.PEAK_GPU_BYTES] = this.gpu.memory.peak;
    s[STATE_SLOT.LABELS_SHOWN] = this.labels.live.shownCount;
    s[STATE_SLOT.LABEL_SOLVES] = this.labels.solves;
    s[STATE_SLOT.LABELS_ADDED] = this.labels.live.added;
    s[STATE_SLOT.LABELS_REMOVED] = this.labels.live.faded;
  }
}
