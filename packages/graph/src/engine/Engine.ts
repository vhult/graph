/**
 * Worker-side orchestrator: owns the device, the frame loop and all GPU state.
 *
 * Frame loop contract:
 *   - A frame renders only when a dirty flag is set. Otherwise the loop goes to
 *     sleep: no rAF, no canvas texture, no GPU submission, no allocation.
 *   - Input wakes it via the InputRing's SLEEPING flag (one message per wake)
 *     or via any API message.
 */
import { GraphError, toGraphError } from "../api/errors";
import { mergeInput, type ResolvedInput } from "../api/input";
import { mergeStyle, type ResolvedStyle } from "../api/style";
import type { BenchmarkOptions, CameraEasing, CameraView, DebugTune, GesturePhase, GraphCaps, GraphInput, GraphStyle, Hit, IconSource, SelectEvent, WorldBounds } from "../api/types";
import { INPUT, modKeys, type InputRing, type InputRecord } from "../bridge/InputRing";
import type { StreamSlots } from "../bridge/StreamSlots";
import type { GestureMessage, HitEventName, InitOptions, WorkerEventName } from "../bridge/protocol";
import { STATE_SLOT } from "../bridge/SharedState";
import { Camera2D, nearestAngle, wrapAngle } from "../camera/Camera2D";
import { CameraAnimation } from "../camera/CameraAnimation";
import { CameraPath } from "../camera/CameraPath";
import { Controls, type Gesture } from "../camera/Controls";
import { GraphStore, type EdgeArrays, type NodeArrays } from "../data/GraphStore";
import { packRgba } from "../data/Pack";
import { CONSTANTS, PICK_CONSTANTS } from "../data/Layouts";
import { createContractLayouts } from "../gpu/BindLayouts";
import { readCaps } from "../gpu/Caps";
import { createGpu, type Gpu } from "../gpu/Device";
import { FrameGraph, type EncodeTimes, type FrameContext } from "../gpu/FrameGraph";
import { FrameUniform, type FrameInputs } from "../gpu/FrameUniform";
import { GraphBuffers } from "../gpu/GraphBuffers";
import { Lazy } from "../gpu/Lazy";
import { PermuteKernels } from "../gpu/PermuteKernels";
import { Profiler, type ProfileSample } from "../gpu/Profiler";
import { IconAtlas } from "../icons/IconAtlas";
import { Labels } from "../labels/Labels";
import { EdgeCullPass, RESTYLE_STATES, RESTYLE_STYLES } from "../passes/EdgeCullPass";
import { LabelDrawPass } from "../passes/LabelDrawPass";
import { LabelPass } from "../passes/LabelPass";
import { HoverPass } from "../passes/HoverPass";
import { PickPass, type PickRequest } from "../passes/PickPass";
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
import { Interaction } from "./Interaction";
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
  onReply: (id: number, value: unknown, error: GraphError | null, transfer?: ArrayBuffer[]) => void;
  onHit: (event: HitEventName, hit: Hit) => void;
  onGesture: (msg: GestureMessage) => void;
  onDragStart: (index: number, nodes: Uint32Array, x: number, y: number) => void;
  onDrag: (event: "drag" | "dragEnd", index: number, dx: number, dy: number) => void;
  onView: (x: number, y: number, zoom: number, rotation: number) => void;
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
const TEXT_DIRTY = Dirty.LABEL_QUERY | Dirty.LABELS | Dirty.LABELLED;
const LOOK_FLAGS = CONSTANTS.STATE_SELECTED | CONSTANTS.STATE_FOCUSED;

function dirtyFor(table: readonly (readonly [keyof NodeArrays, number])[], arrays: NodeArrays): number {
  let dirty = 0;
  for (const [k, flag] of table) if (arrays[k]) dirty |= flag;
  return dirty;
}

function readView(c: Camera2D, out: CameraView): void {
  out.x = c.x;
  out.y = c.y;
  out.zoom = c.zoom;
  out.rotation = c.rotation;
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
  private readonly softFail = (e: unknown): void => this.init.onError(toGraphError(e), false);
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
  private readonly pick = new Lazy(() => PickPass.create(this.gpu.device, this.layouts, this.active).then((p) => this.adopt(p, p.pipelines)));
  private readonly hover = new Lazy(() =>
    HoverPass.create(this.gpu.device, this.gpu.format, this.layouts, this.graph, this.active, (b) => this.graph.retireAfterSubmit(b)).then((h) => this.adopt(h, h.edgePipes)),
  );
  private readonly shapePass = new Lazy(() => SelectionShapePass.create(this.gpu.device, this.gpu.format, this.layouts));
  private readonly interaction: Interaction;
  private query: QueryPass | null = null;
  private readonly snapJobs: { id: number; type: string }[] = [];
  private inputState: ResolvedInput;
  private pickEdges = false;
  private moveEnding = false;
  private readonly world = { x: 0, y: 0 };
  private readonly wanted: Tune = { ...DEFAULT_TUNE };
  private active: Tune = { ...DEFAULT_TUNE };
  private pipesLoading = false;
  private dataGen = 0;
  private frameGen = -1;
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
    this.interaction = new Interaction(
      {
        store,
        camera: this.camera,
        controls: this.controls,
        events: init,
        streamed: () => this.streamedPositions,
        pickFree: () => this.pickFree(),
        submitPick: (x, y, nodes, edges, token) => this.submitPick(x, y, nodes, edges, token),
        findInside: (points, done, fail) => this.findInside(points, done, fail),
        loadShape: () =>
          this.lazyPass(this.shapePass, (p) => {
            p.setColors(this.style.selection.fill, this.style.selection.stroke);
            this.passes.labelDraw.overlay = p;
            this.interaction.redrawShape();
          }),
        drawShape: (points, count) => this.drawShape(points, count),
        hideShape: () => {
          this.shapePass.value?.hide();
          this.markDirty(Dirty.HOVER);
        },
        showHover: (node, edge, which, nodeScale) => this.showHover(node, edge, which, nodeScale),
        flagNodes: (indices, flags, on) => this.flagNodes(indices, flags, on),
        markDirty: (flags) => this.markDirty(flags),
        startMove: (auto) => {
          this.moveEnding = false;
          if (!auto) return;
          this.passes.cull.moveNodes();
          this.passes.edgeCull.moveNodes(store.edgeCount);
        },
        endMove: () => (this.moveEnding = true),
        stopHold: (pan, x, y) => this.stopHold(pan, x, y),
        wake: () => this.wake(),
      },
      this.inputState,
    );
    this.interaction.setHoverLook(this.style.hover !== false);
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
      edgeColor: packRgba(...this.style.edge.color),
      flags: 0,
      iconScale: this.style.icon.scale,
      iconMinPx: this.style.icon.minPx,
      dimmedAlpha: this.style.dimmed.alpha,
    };

    passes.labels.onShown = (shown, count) => {
      const t0 = this.probe.full ? performance.now() : 0;
      this.labels.applyShown(shown, count, this.clock());
      this.markDirty(Dirty.LABELS | Dirty.LABELLED);
      if (this.probe.full) this.probe.async(CPU.ASYNC_LABELS, performance.now() - t0);
    };
    passes.labels.requestSolve = () => this.markDirty(Dirty.LABEL_QUERY);
    passes.labels.onSnapshot = (id, snapshot) =>
      init.onReply(id, snapshot, null, [snapshot.center.buffer, snapshot.halfWidth.buffer, snapshot.halfHeight.buffer, snapshot.rank.buffer, snapshot.size.buffer, snapshot.index.buffer, snapshot.decision.buffer] as ArrayBuffer[]);

    const bg = this.style.background;
    this.frameGraph.setClearColor(bg[0], bg[1], bg[2], bg[3]);
    this.labels.setColor(packRgba(...this.style.label.color));
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
    const store = new GraphStore(init.options.nodeReserve);
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
    this.interaction.pixelRatio = pixelRatio;
    this.applyLimits();
    this.labels.setPixelRatio(pixelRatio);
    this.passes.labels.setViewport(w, h);
    this.markDirty(Dirty.RESIZE);
  }

  setNodes(count: number, arrays: NodeArrays, labels: string[]): void {
    const store = this.store;
    let dirty = Dirty.STATE | (store.withReserve(count) !== store.nodeCount ? Dirty.TOPOLOGY : 0) | dirtyFor(NODE_DIRTY, arrays);
    const topology = (dirty & Dirty.TOPOLOGY) !== 0;
    this.interaction.cancel();
    this.syncStreamed(arrays);
    if (count !== store.nodeSlots) this.stream = null;
    store.setNodes(count, arrays);
    if (store.edgeCount > 0) {
      store.setEdges(0, {});
      if (this.labels.hasEdgeText) dirty |= Dirty.LABEL_QUERY | Dirty.LABELS;
      this.labels.clearEdges();
      dirty |= Dirty.EDGES;
    }
    if (topology) this.labels.setNodeCount(store.nodeCount);
    if (this.labels.setNodeText(labels)) dirty |= TEXT_DIRTY;
    if (topology || (dirty & Dirty.EDGES) !== 0) this.newData();
    this.syncPipes();
    this.markDirty(dirty);
  }

  addNodes(indices: Uint32Array, slots: number, arrays: NodeArrays, labels?: string[]): void {
    const store = this.store;
    this.syncStreamed({});
    if (slots !== store.nodeSlots) this.stream = null;
    const grow = store.needsGrowth(slots);
    if (grow) {
      this.interaction.cancel();
      store.growNodes(slots);
      this.labels.setNodeCount(store.nodeCount);
      this.newData();
    }
    store.addNodes(indices, slots, arrays);
    const dirty = grow ? Dirty.TOPOLOGY : Dirty.STYLE | Dirty.STATE;
    this.markDirty(dirty | (this.labels.textAt("nodes", indices, labels ?? null) ? TEXT_DIRTY : 0));
  }

  removeNodes(indices: Uint32Array): Uint32Array {
    if (this.interaction.dragging && this.store.anyFlagged(indices, CONSTANTS.STATE_DRAGGING)) this.interaction.cancel();
    const edges = this.store.removeNodes(indices);
    if (edges.length > 0) this.store.hideEdges(edges);
    this.newData();
    this.syncPipes();
    this.markDirty(Dirty.STATE);
    return edges;
  }

  compactNodes(remap: Uint32Array): void {
    const store = this.store;
    this.interaction.cancel();
    this.syncStreamed({});
    const slots = store.nodeSlots;
    store.compactNodes(remap);
    if (store.nodeSlots !== slots) this.stream = null;
    this.labels.setNodeCount(store.nodeCount);
    this.labels.compactText("nodes", remap);
    this.newData();
    this.markDirty(Dirty.TOPOLOGY | Dirty.EDGES);
  }

  updateNodes(start: number, arrays: NodeArrays, labels?: string[] | null): void {
    this.store.updateNodes(start, arrays);
    let dirty = dirtyFor(UPDATE_DIRTY, arrays);
    if (labels !== undefined && this.labels.setNodeText(labels ?? [])) dirty |= TEXT_DIRTY;
    this.markDirty(dirty);
  }

  updateNodesAt(indices: Uint32Array, arrays: NodeArrays, labels?: string[]): void {
    this.store.updateNodesAt(indices, arrays);
    const text = labels !== undefined && this.labels.textAt("nodes", indices, labels);
    this.markDirty(dirtyFor(UPDATE_DIRTY, arrays) | (text ? TEXT_DIRTY : 0));
  }

  flagNodes(indices: Uint32Array | null, flags: number, on: boolean): void {
    this.store.flagNodes(indices, flags, on);
    if (on && (flags & LOOK_FLAGS) !== 0) this.loadHover();
    this.markDirty(Dirty.STATE);
  }

  defineIcons(id: number, icons: readonly IconSource[], ids: Uint16Array | null = null): void {
    this.iconChain = this.iconChain
      .then(() => this.loadIcons())
      .then((atlas) => {
        if (this.destroyed) return;
        for (const f of ids ? atlas.defineAt(ids, icons) : atlas.define(icons)) this.init.onError(new GraphError("invalid-argument", f), false);
        this.markDirty(Dirty.STYLE);
        this.init.onReply(id, undefined, null);
      })
      .catch((e: unknown) => this.init.onReply(id, undefined, toGraphError(e)));
  }

  removeIcons(ids: Uint16Array): void {
    if (this.store.clearIcons(ids)) this.markDirty(Dirty.STYLE);
    this.iconChain = this.iconChain
      .then(() => {
        if (this.destroyed || !this.iconAtlas) return;
        this.iconAtlas.clear(ids);
        this.markDirty(Dirty.STYLE);
      })
      .catch(this.softFail);
  }

  private loadIcons(): Promise<IconAtlas> {
    this.iconLoad ??= Promise.allSettled([
      IconAtlas.create(this.gpu),
      this.passes.cull.loadIcons(),
      this.passes.order.iconScatter.load(),
      this.passes.nodes.iconVariant.load(),
      this.hover.value?.iconPipe.load(),
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
    this.interaction.cancel();
    this.store.setEdges(count, arrays);
    this.labels.setEdgeCount(count);
    const text = this.labels.setEdgeText(labels);
    this.syncEdgeOrder();
    this.newData();
    this.syncPipes();
    this.markDirty(Dirty.EDGES | (text ? Dirty.LABEL_QUERY | Dirty.LABELS : 0));
  }

  addEdges(indices: Uint32Array, slots: number, arrays: EdgeArrays, labels?: string[]): void {
    this.interaction.cancel();
    this.store.addEdges(indices, slots, arrays);
    this.labels.setEdgeCount(slots);
    this.newData();
    this.syncPipes();
    const text = this.labels.textAt("edges", indices, labels ?? null);
    if (text && !this.graph.keepEdgeOrder) this.syncEdgeOrder();
    this.markDirty(Dirty.EDGES | (text ? Dirty.LABEL_QUERY | Dirty.LABELS : 0));
  }

  hideEdges(indices: Uint32Array): void {
    this.store.hideEdges(indices);
    this.syncPipes();
    this.markDirty(Dirty.STATE);
  }

  flagEdges(indices: Uint32Array | null, flags: number, on: boolean): void {
    this.store.flagEdges(indices, flags, on);
    if (on && (flags & LOOK_FLAGS) !== 0) this.loadHover();
    this.markDirty(Dirty.STATE);
  }

  updateEdgesAt(indices: Uint32Array, arrays: EdgeArrays, labels?: string[]): void {
    if (arrays.indices) this.newData();
    this.store.updateEdgesAt(indices, arrays);
    this.syncPipes();
    const text = labels !== undefined && this.labels.textAt("edges", indices, labels);
    if (text && !this.graph.keepEdgeOrder) this.syncEdgeOrder();
    this.markDirty(edgeUpdateDirty(arrays, false) | (text ? Dirty.LABEL_QUERY | Dirty.LABELS : 0));
  }

  updateEdges(arrays: EdgeArrays, labels?: string[] | null): void {
    if (arrays.indices) this.newData();
    this.store.updateEdges(arrays);
    this.syncPipes();
    let dirty = edgeUpdateDirty(arrays, true);
    if (labels !== undefined) {
      if (this.labels.setEdgeText(labels ?? [])) dirty |= Dirty.LABEL_QUERY | Dirty.LABELS;
      this.syncEdgeOrder();
    }
    this.markDirty(dirty);
  }

  compactEdges(remap: Uint32Array): void {
    this.interaction.cancel();
    this.store.compactEdges(remap);
    this.labels.setEdgeCount(this.store.edgeCount);
    this.labels.compactText("edges", remap);
    this.newData();
    this.syncPipes();
    this.markDirty(Dirty.EDGES);
  }

  private syncEdgeOrder(): void {
    const store = this.store;
    const keep = this.labels.hasEdgeText || this.pickEdges;
    this.graph.keepEdgeOrder = keep;
    if (!keep) this.graph.setEdgeOrder(null);
    else if (!this.graph.edgeOrder && store.edgeCount > 0) {
      store.reloadEdges();
      this.newData();
      this.markDirty(Dirty.EDGES);
    }
  }

  setInput(partial: GraphInput): void {
    this.inputState = mergeInput(this.inputState, partial);
    this.interaction.setInput(this.inputState);
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
    if (t.pickRate !== undefined) this.interaction.pickInterval = 1000 / t.pickRate;
    this.syncPipes();
  }

  private tunables(): Tunable[] {
    const list: Tunable[] = [this.passes.cull, this.passes.edgeCull.cull, this.passes.edges.pipelines];
    if (this.pick.value) list.push(this.pick.value.pipelines);
    if (this.hover.value) list.push(this.hover.value.edgePipes);
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
        this.init.onError(toGraphError(e), false);
      },
    );
  }

  private adopt<P>(pass: P, tuned: Tunable): Promise<P> {
    const t = this.active;
    return tuned.loadTune(t).then(() => {
      if (t !== this.active) return this.adopt(pass, tuned);
      tuned.useTune(t);
      return pass;
    });
  }

  private lazyPass<T extends { destroy(): void }>(lazy: Lazy<T>, ready: (value: T) => void): void {
    if (lazy.value || lazy.loading) return;
    lazy.load().then(
      (value) => {
        if (this.destroyed) value.destroy();
        else ready(value);
      },
      this.softFail,
    );
  }

  private syncPick(): void {
    const s = this.inputState;
    const edges = s.pick.edges;
    if (edges !== this.pickEdges) {
      this.pickEdges = edges;
      this.passes.edgeCull.setLines(edges, (b) => this.graph.retireAfterSubmit(b));
      this.syncEdgeOrder();
      this.markDirty(Dirty.STYLE);
    }
    if (!s.pick.nodes && !edges && s.drag === false && s.select === false) return;
    this.lazyPass(this.pick, (pick) => {
      pick.onResult = this.interaction.onPick;
      this.interaction.wantHover();
      this.wake();
    });
    this.loadHover();
  }

  private loadHover(): void {
    this.lazyPass(this.hover, (hover) => {
      hover.setHoverLook(this.style.hover);
      hover.setLooks(this.style.selected, this.style.focused);
      this.passes.nodes.hover = hover;
      this.passes.edges.hover = hover;
      if (this.iconLoad) {
        hover.iconPipe.load().then(
          () => this.markDirty(Dirty.HOVER),
          this.softFail,
        );
      }
      this.markDirty(Dirty.HOVER);
    });
  }

  private newData(): void {
    this.dataGen++;
    this.interaction.clearHover();
  }

  private pickFree(): boolean {
    const pick = this.pick.value;
    return pick !== null && this.frameGen === this.dataGen && pick.free;
  }

  private submitPick(x: number, y: number, nodes: boolean, edges: boolean, token: number): boolean {
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
    const pick = this.pick.value!;
    const device = this.gpu.device;
    const encoder = device.createCommandEncoder();
    if (pick.encode(encoder, this.frameCtx, this.graph, this.passes.cull, this.passes.edgeCull, req) === 0) return false;
    device.queue.submit([encoder.finish()]);
    pick.afterSubmit();
    return true;
  }

  private stopHold(pan: boolean, x: number, y: number): void {
    if (!pan) {
      this.controls.hold = false;
      return;
    }
    if (this.controls.release(x, y, this.camera)) {
      this.stopAnim();
      this.dirty |= Dirty.CAMERA;
    }
    this.wake();
  }

  private drawShape(points: Float32Array, count: number): void {
    const pass = this.shapePass.value;
    if (!pass) return;
    pass.setShape(points, count, Math.max(1, this.pixelRatio));
    this.markDirty(Dirty.HOVER);
  }

  private showHover(node: number, edge: number, which: number, nodeScale: number): void {
    const hover = this.hover.value;
    if (!hover) return;
    const store = this.store;
    let changed = false;
    if ((which & PICK_CONSTANTS.PICK_FLAG_NODES) !== 0) changed = hover.setNode(node, nodeScale, store.hasNodeShapes, this.pixelRatio) || changed;
    if ((which & PICK_CONSTANTS.PICK_FLAG_EDGES) !== 0) {
      const ends = store.channels.edgeIdx.data as Uint32Array;
      const style = edge >= 0 && store.hasEdgeStyles ? store.channels.edgeStyle.data[edge]! : 0;
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
    this.panEvents = events.includes("pan");
    this.zoomEvents = events.includes("zoom");
    this.rotateEvents = events.includes("rotate");
    this.interaction.listen(events);
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
    if (t === "pan") this.init.onGesture({ t, event: modKeys(m, { phase, dx: g.dx / r, dy: g.dy / r, x, y }) });
    else if (t === "zoom") this.init.onGesture({ t, event: modKeys(m, { phase, factor: g.factor, x, y }) });
    else this.init.onGesture({ t, event: modKeys(m, { phase, angle: g.angle, x, y }) });
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
      fi.nodeScale = s.nodeScale;
      fi.edgeWidth = s.edge.width;
      fi.edgeColor = packRgba(...s.edge.color);
      fi.iconScale = s.icon.scale;
      fi.iconMinPx = s.icon.minPx;
      dirty |= Dirty.STYLE;
    }
    if (partial.hover !== undefined || partial.selected || partial.focused || partial.dimmed) {
      fi.dimmedAlpha = s.dimmed.alpha;
      this.hover.value?.setHoverLook(s.hover);
      this.hover.value?.setLooks(s.selected, s.focused);
      dirty |= Dirty.STYLE | Dirty.HOVER;
      if (partial.hover !== undefined) this.interaction.setHoverLook(s.hover !== false);
    }
    const shape = this.shapePass.value;
    if (partial.selection && shape) {
      shape.setColors(s.selection.fill, s.selection.stroke);
      if (this.interaction.shaping) dirty |= Dirty.HOVER;
    }
    if (partial.label) {
      const l = s.label;
      if (this.labels.setStyle({ sizeCssPx: l.size, paddingCssPx: l.padding, font: l.font })) {
        this.passes.labels.setViewport(this.camera.viewportW, this.camera.viewportH);
        dirty |= TEXT_DIRTY;
      }
      this.labels.setColor(packRgba(...l.color));
      dirty |= Dirty.LABELS;
    }
    this.markDirty(dirty);
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
          if (!this.destroyed) this.init.onReply(job.id, blob, null);
        },
        (e: unknown) => {
          if (!this.destroyed) this.init.onReply(job.id, undefined, toGraphError(e));
        },
      );
    }
  }

  queryAt(id: number, x: number, y: number): void {
    this.interaction.queryAt(id, x, y);
  }

  queryInside(id: number, points: Float32Array): void {
    this.findInside(
      points,
      (nodes) => this.init.onReply(id, nodes, null, [nodes.buffer as ArrayBuffer]),
      (e) => this.init.onReply(id, undefined, e),
    );
  }

  private findInside(points: Float32Array, done: QueryDone, fail: QueryFail): void {
    this.query ??= new QueryPass(this.gpu.device, this.layouts, () => this.wake(), (e) => this.init.onError(e, false));
    this.query.request(points, done, fail);
  }

  private runQuery(): void {
    this.query!.run(this.frameUniform.bindGroup, this.graph, this.store.nodeCount);
  }

  /** Play `opts.path` one step per rendered frame and record per-frame timings. */
  benchmark(id: number, opts: BenchmarkOptions): void {
    if (this.bench) return this.init.onReply(id, undefined, new GraphError("invalid-argument", "A benchmark is already running"));
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
    const handoff = this.controls.pinching;
    if (this.controls.apply(rec, this.camera)) {
      this.stopAnim();
      this.dirty |= Dirty.CAMERA;
    }
    this.interaction.input(rec, handoff);
    if (rec.type === INPUT.POINTER_MOVE || rec.type === INPUT.POINTER_LEAVE || rec.type === INPUT.POINTER_DOWN) {
      this.frameInputs.pointerX = this.controls.pointerX;
      this.frameInputs.pointerY = this.controls.pointerY;
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
    clearTimeout(this.gestureTimer);
    this.interaction.destroy();
    this.pick.value?.destroy();
    this.query?.destroy();
    this.shapePass.value?.destroy();
    this.hover.value?.destroy();
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
    this.interaction.step(streamedBytes > 0 && this.stream?.positions === true);
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

    if ((this.dirty & (Dirty.CAMERA | Dirty.RESIZE)) !== 0) this.interaction.cameraMoved(t0);
    this.interaction.pumpPick(t0, bench !== null);

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
    const graph = this.graph;
    if (graph.edgeRank) {
      this.passes.edgeCull.restyle(RESTYLE_STYLES, graph.edgeRank, graph.restyleSlot, graph.restyledEdges, edgeCount);
      this.passes.edgeCull.restyle(RESTYLE_STATES, graph.edgeRank, graph.stateSlot, graph.restyledStates, edgeCount);
    }
    if (full) probe.mark(CPU.RESERVE);

    const fi = this.frameInputs;
    fi.time = (t0 - this.startTime) / 1000;
    fi.frameIndex = this.frameIndex;
    fi.pixelRatio = this.pixelRatio;
    fi.nodeCount = nodeCount;
    fi.edgeCount = edgeCount;
    fi.flags = (this.store.hiddenCount > 0 ? CONSTANTS.FRAME_FLAG_HIDDEN : 0) | (this.store.dimmedCount > 0 ? CONSTANTS.FRAME_FLAG_DIMMED : 0);
    const hover = this.hover.value;
    if (hover) {
      hover.syncLists(this.store.looks);
      hover.syncLooks(this.store.hasNodeShapes, this.store.hasEdgeStyles, this.pixelRatio);
      fi.flags |= CONSTANTS.FRAME_FLAG_EDGE_LOOKS;
    }
    this.frameUniform.write(fi);

    const ctx = this.frameCtx;
    ctx.graphBindGroup = this.graph.bindGroup;
    ctx.nodeCount = nodeCount;
    ctx.edgeCount = edgeCount;
    ctx.dirty = this.dirty;
    ctx.icons = icons && this.passes.cull.tailed ? atlas : null;
    this.passes.edges.perEdgeStyle = this.store.hasEdgeStyles;
    this.passes.edges.linePatterns = this.store.hasLinePatterns;
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
    this.passes.labels.recordReadback(encoder, ctx);
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
    if ((frameDirty & PICK_DIRTY) !== 0) this.interaction.wantHover();

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
        this.init.onError(toGraphError(e), false);
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
        this.init.onError(toGraphError(err), false);
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
    this.init.onReply(b.id, result, null, b.transferables());
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
