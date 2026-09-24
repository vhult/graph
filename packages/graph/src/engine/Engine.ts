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
import type { BenchmarkOptions, BenchmarkResult, CameraView, GraphCaps, LabelSnapshot, RGBA } from "../api/types";
import { INPUT, type InputRing, type InputRecord } from "../bridge/InputRing";
import type { StreamSlots } from "../bridge/StreamSlots";
import type { DragEventName, InitOptions } from "../bridge/protocol";
import { STATE_SLOT } from "../bridge/SharedState";
import { Camera2D } from "../camera/Camera2D";
import { CameraPath } from "../camera/CameraPath";
import { Controls } from "../camera/Controls";
import { GraphStore, type EdgeArrays, type NodeArrays } from "../data/GraphStore";
import { createContractLayouts } from "../gpu/BindLayouts";
import { readCaps } from "../gpu/Caps";
import { createGpu, type Gpu } from "../gpu/Device";
import { FrameGraph, type EncodeTimes, type FrameContext } from "../gpu/FrameGraph";
import { FrameUniform, type FrameInputs } from "../gpu/FrameUniform";
import { GraphBuffers } from "../gpu/GraphBuffers";
import { PermuteKernels } from "../gpu/PermuteKernels";
import { Profiler, type ProfileSample } from "../gpu/Profiler";
import { Labels } from "../labels/Labels";
import { EDGE_DEBUG_MODES, EdgeCullPass } from "../passes/EdgeCullPass";
import { LabelDrawPass } from "../passes/LabelDrawPass";
import { LabelPass } from "../passes/LabelPass";
import { HoverPass } from "../passes/HoverPass";
import { PICKED_EDGES, PICKED_NODES, PickPass, type PickRequest } from "../passes/PickPass";
import { EdgeGeometryPass } from "../passes/EdgeGeometryPass";
import { EdgeSortPass } from "../passes/EdgeSortPass";
import { NodeGeometryPass } from "../passes/NodeGeometryPass";
import { SortPass } from "../passes/SortPass";
import { TransformCullPass } from "../passes/TransformCullPass";
import { UploadPass } from "../passes/UploadPass";
import { Benchmark } from "./Benchmark";
import { Dirty } from "./Dirty";
import { Press } from "./Press";
import { CPU, Probe, type ProbeSink } from "./Probe";
import { Telemetry } from "./Telemetry";

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
  onHover: (node: number | undefined, edge: number | undefined) => void;
  onClick: (node: number | undefined, edge: number | undefined) => void;
  onDrag: (event: DragEventName, index: number, x: number, y: number) => void;
  probeSink: ProbeSink;
}

interface Passes {
  cull: TransformCullPass;
  nodes: NodeGeometryPass;
  edges: EdgeGeometryPass;
  edgeCull: EdgeCullPass;
  labels: LabelPass;
}

const CPU_EMA = 0.1;
const DEFAULT_WARMUP_FRAMES = 10;
const FIT_PADDING_CSS_PX = 24;
const BENCH_TIMING = { off: 0, passes: 1, full: 2 } as const;
const CAMERA_SETTLE_MS = 50;
const CLICK_SLOP_CSS_PX = 3;
const NODE_DIRTY = [
  ["positions", Dirty.TOPOLOGY],
  ["sizes", Dirty.TOPOLOGY],
  ["shapes", Dirty.TOPOLOGY],
  ["colors", Dirty.STYLE],
] as const satisfies readonly (readonly [keyof NodeArrays, number])[];
const PICK_DIRTY = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.MOVED | Dirty.CAMERA | Dirty.STYLE | Dirty.STATE | Dirty.RESIZE | Dirty.EDGES | Dirty.LABELLED;

/** Straight-alpha RGBA in 0..1 to an rgba8unorm word (R in the low byte). */
function packRgbaTuple(c: RGBA): number {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (q(c[0]) | (q(c[1]) << 8) | (q(c[2]) << 16) | (q(c[3]) << 24)) >>> 0;
}

export class Engine {
  readonly caps: GraphCaps;
  readonly probe: Probe;
  private readonly camera = new Camera2D();
  private readonly controls = new Controls();
  private readonly frameGraph: FrameGraph;
  private readonly frameUniform: FrameUniform;
  private readonly telemetry: Telemetry;
  private readonly context: GPUCanvasContext;
  private readonly frameCtx: FrameContext;
  private readonly frameInputs: FrameInputs;
  private readonly submitList: GPUCommandBuffer[] = [];
  private readonly inputRec: InputRecord = { type: 0, t: 0, x: 0, y: 0, dx: 0, dy: 0, buttons: 0, mods: 0 };
  private readonly applyInput = (rec: InputRecord): void => this.input(rec);
  private readonly startTime = performance.now();
  private readonly encodeTimes: EncodeTimes;

  private dirty = Dirty.RESIZE;
  private framePending = false;
  private stream: StreamSlots | null = null;
  private streamedPositions: Float32Array | null = null;
  private streamedColors: Uint32Array | null = null;
  /** performance.now() of the previous tick, for the zoom glide. */
  private lastTickMs = 0;
  private frameIndex = 0;
  private renderedFrames = 0;
  private cpuMsAvg = 0;
  private destroyed = false;
  private pixelRatio: number;
  /** Node count the cull buffers are sized for; -1 forces a check. */
  private reservedFor = -1;
  /** Edge count the edge cull buffers are sized for; -1 forces a check. */
  private reservedEdgesFor = -1;
  private bench: Benchmark | null = null;
  private labelSolves = 0;
  private benchTimer: ReturnType<typeof setTimeout> | undefined;
  private pick: PickPass | null = null;
  private hover: HoverPass | null = null;
  private pickLoading = false;
  private pickEdges = false;
  private hoverKinds = 0;
  private clickKinds = 0;
  private dragEvents = false;
  private nodeDrag = false;
  private dragNode = -1;
  private pressEngine = -1;
  private grabX = 0;
  private grabY = 0;
  private dragX = 0;
  private dragY = 0;
  private readonly dragPos = new Float32Array(2);
  private readonly world = { x: 0, y: 0 };
  private readonly press = new Press({
    startDrag: (node, nodeScale) => this.startDrag(node, nodeScale),
    endDrag: () => this.endDrag(),
    stopHold: (pan) => this.stopHold(pan),
    click: (node, edge) => this.emitClick(node, edge),
  });
  private pickWanted = false;
  private pickDue = 0;
  private pickTimer: ReturnType<typeof setTimeout> | undefined;
  private pickSeq = 0;
  private readonly pickInterval: number;
  private dataGen = 0;
  private cameraMs = -Infinity;
  private frameGen = -1;
  private hoverNode = -1;
  private hoverEdge = -1;
  private readonly pickRequest: PickRequest = { x: 0, y: 0, radiusPx: 0, edgeRadiusPx: 0, nodes: false, edges: false, shapes: false, edgeColors: false, token: 0 };

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

    this.context = init.canvas.getContext("webgpu") as GPUCanvasContext;
    this.context.configure({ device, format, alphaMode: init.options.transparent ? "premultiplied" : "opaque" });

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

    this.controls.enabled = init.options.controls;
    this.pickInterval = 1000 / Math.max(1, init.options.pickRate);
    this.pixelRatio = init.pixelRatio;
    this.frameCtx = {
      frameBindGroup: this.frameUniform.bindGroup,
      graphBindGroup: graph.bindGroup,
      nodeCount: 0,
      edgeCount: 0,
      dirty: 0,
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
      nodeScale: init.options.nodeScale,
      edgeWidth: init.options.edgeWidth,
      edgeColor: packRgbaTuple(init.options.edgeColor),
      flags: 0,
    };

    passes.labels.onShown = (shown, count) => {
      const t0 = this.probe.full ? performance.now() : 0;
      this.labels.applyShown(shown, count, this.clock());
      this.markDirty(Dirty.LABELS | Dirty.LABELLED);
      if (this.probe.full) this.probe.async(CPU.ASYNC_LABELS, performance.now() - t0);
    };
    passes.labels.requestSolve = () => this.markDirty(Dirty.LABEL_QUERY);
    passes.labels.onSnapshot = (id, snapshot) =>
      init.onLabelSnapshot(id, snapshot, [snapshot.center.buffer, snapshot.halfWidth.buffer, snapshot.halfHeight.buffer, snapshot.rank.buffer, snapshot.size.buffer, snapshot.index.buffer, snapshot.decision.buffer] as ArrayBuffer[]);

    this.setBackground(init.options.background);
    this.resize(init.width, init.height, init.pixelRatio);
    if (init.options.nodeDrag) this.setNodeDrag(true);

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
    const edgeOpts = {
      directed: init.options.directedEdges,
      maxOverdraw: init.options.edgeMaxOverdraw,
      minLengthPx: init.options.edgeMinLengthPx,
      debug: Math.max(0, EDGE_DEBUG_MODES.indexOf(init.options.edgeDebug)),
    };
    const [sort, cull, nodes, edgeSort, edgeCull, edges] = await Promise.all([
      SortPass.create(device, layouts, graph, store.bounds),
      TransformCullPass.create(device, layouts, init.options.lodTargetPx),
      NodeGeometryPass.create(device, format, layouts),
      EdgeSortPass.create(device, graph, store.bounds),
      EdgeCullPass.create(device, layouts, edgeOpts),
      EdgeGeometryPass.create(device, format, layouts, edgeOpts),
    ]);
    // Compute runs in stage order: upload, node sort, edge sort, node cull, edge cull.
    frameGraph.addCompute(new UploadPass(graph));
    frameGraph.addCompute(sort);
    frameGraph.addCompute(edgeSort);
    frameGraph.addCompute(cull);
    frameGraph.addCompute(edgeCull);
    const labelState = new Labels(device, { sizeCssPx: init.options.labelSize, paddingCssPx: init.options.labelPadding, font: init.options.labelFont });
    const [labels, labelDraw] = await Promise.all([
      LabelPass.create(device, layouts, graph, cull, edgeCull, labelState),
      LabelDrawPass.create(device, format, layouts, graph, labelState),
    ]);
    frameGraph.addCompute(labels);
    frameGraph.addRender(edges);
    frameGraph.addRender(nodes);
    frameGraph.addRender(labelDraw);
    return new Engine(gpu, store, graph, profiler, frameGraph, { cull, nodes, edges, edgeCull, labels }, layouts, init, labelState);
  }

  // ---- API (called from worker message dispatch) ----------------------------

  resize(width: number, height: number, pixelRatio: number): void {
    const max = this.caps.maxTextureDimension2D;
    const w = Math.max(1, Math.min(max, Math.round(width)));
    const h = Math.max(1, Math.min(max, Math.round(height)));
    this.init.canvas.width = w;
    this.init.canvas.height = h;
    this.camera.setViewport(w, h);
    this.pixelRatio = pixelRatio;
    this.labels.setPixelRatio(pixelRatio);
    this.passes.labels.setViewport(w, h);
    this.markDirty(Dirty.RESIZE);
  }

  setNodes(count: number, arrays: NodeArrays): void {
    let dirty = count !== this.store.nodeCount ? Dirty.TOPOLOGY : 0;
    for (const [k, flag] of NODE_DIRTY) if (arrays[k]) dirty |= flag;
    const topology = (dirty & Dirty.TOPOLOGY) !== 0;
    if (topology) this.press.cancel();
    this.syncStreamed(arrays);
    this.store.setNodes(count, arrays);
    if (topology) {
      this.labels.setNodeCount(count);
      this.newData();
    }
    this.markDirty(dirty);
  }

  setEdges(count: number, arrays: EdgeArrays): void {
    this.press.cancel();
    this.store.setEdges(count, arrays);
    this.labels.setEdgeCount(count);
    this.newData();
    this.markDirty(Dirty.EDGES);
  }

  /** Label text per node, in the user's order; empty clears. */
  setNodeLabels(labels: string[]): void {
    this.store.nodeLabels = labels.length > 0 ? labels : null;
    this.labels.setNodeText(labels);
    this.markDirty(Dirty.LABEL_QUERY | Dirty.LABELS | Dirty.LABELLED);
  }

  /** Label text per edge, in the user's order; empty clears. */
  setEdgeLabels(labels: string[]): void {
    this.store.edgeLabels = labels.length > 0 ? labels : null;
    this.syncEdgeOrder();
    this.labels.setEdgeText(labels);
    this.markDirty(Dirty.EDGES | Dirty.LABEL_QUERY | Dirty.LABELS);
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

  setPicking(hover: number, click: number, drag: boolean): void {
    this.hoverKinds = hover;
    this.clickKinds = click;
    this.dragEvents = drag;
    this.syncPick();
  }

  setNodeDrag(on: boolean): void {
    if (!on) this.press.cancel();
    this.nodeDrag = on;
    this.syncPick();
  }

  private syncPick(): void {
    const hoverNodes = (this.hoverKinds & PICKED_NODES) !== 0;
    const hoverEdges = (this.hoverKinds & PICKED_EDGES) !== 0;
    if (!hoverNodes) this.hoverNode = -1;
    if (!hoverEdges) this.hoverEdge = -1;
    if (!hoverNodes && this.hover?.setNode(-1, 0, false)) this.markDirty(Dirty.HOVER);
    if (!hoverEdges && this.hover?.setEdge(-1, 0, 0, 0)) this.markDirty(Dirty.HOVER);
    const edges = hoverEdges || (this.clickKinds & PICKED_EDGES) !== 0;
    const any = this.hoverKinds !== 0 || this.clickKinds !== 0 || this.nodeDrag;
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
      const o = this.init.options;
      const edgeOpts = {
        directed: o.directedEdges,
        maxOverdraw: o.edgeMaxOverdraw,
        minLengthPx: o.edgeMinLengthPx,
        debug: Math.max(0, EDGE_DEBUG_MODES.indexOf(o.edgeDebug)),
      };
      const style = o.hoverStyle;
      const hover = style
        ? HoverPass.create(this.gpu.device, this.gpu.format, this.layouts, this.graph, o.directedEdges, {
            nodeColor: packRgbaTuple(style.nodeColor),
            nodeScale: style.nodeScale,
            edgeColor: packRgbaTuple(style.edgeColor),
            edgeWidth: style.edgeWidth,
          })
        : Promise.resolve(null);
      Promise.all([PickPass.create(this.gpu.device, this.layouts, o.lodTargetPx, edgeOpts), hover]).then(
        ([pick, hover]) => {
          if (this.destroyed) {
            pick.destroy();
            hover?.destroy();
            return;
          }
          pick.onResult = this.onPick;
          this.pick = pick;
          this.hover = hover;
          this.passes.nodes.hover = hover;
          this.passes.edges.hover = hover;
          this.pickWanted = this.hoverKinds !== 0;
          this.wake();
        },
        (e) => this.init.onError(e instanceof GraphError ? e : new GraphError("internal", String(e)), false),
      );
    }
    this.pickWanted = this.hoverKinds !== 0;
    this.wake();
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
    if (!this.pickWanted || this.bench || this.press.waiting || this.dragNode >= 0) return;
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
    if (this.submitPick(pick, x, y, (this.hoverKinds & PICKED_NODES) !== 0, (this.hoverKinds & PICKED_EDGES) !== 0, this.pickSeq) === 0) return;
    this.pickWanted = false;
    this.pickDue = now + this.pickInterval;
  }

  private pressPick(): void {
    const pick = this.pick;
    if (!pick || this.frameGen !== this.dataGen || !pick.free) return;
    const p = this.press;
    const seq = this.pickSeq + 1;
    if (this.submitPick(pick, p.x, p.y, true, (this.clickKinds & PICKED_EDGES) !== 0, seq) === 0) {
      p.resolve(-1, -1, 1, this.nodeDrag);
      return;
    }
    this.pickSeq = seq;
    p.seq = seq;
  }

  private submitPick(pick: PickPass, x: number, y: number, nodes: boolean, edges: boolean, token: number): number {
    const req = this.pickRequest;
    req.x = x;
    req.y = y;
    req.radiusPx = this.init.options.pickRadius * this.pixelRatio;
    req.edgeRadiusPx = this.init.options.edgePickRadius * this.pixelRatio;
    req.nodes = nodes;
    req.edges = edges;
    req.shapes = this.store.hasNodeShapes;
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

  private readonly onPick = (node: number, edge: number, nodeScale: number, engine: number, token: number): void => {
    if (this.destroyed) return;
    const seq = Math.floor(token / 4);
    const picked = token % 4;
    const p = this.press;
    if (p.waiting && p.seq !== 0 && seq === p.seq) {
      this.pressEngine = engine;
      p.resolve((picked & PICKED_NODES) !== 0 ? node : -1, (picked & PICKED_EDGES) !== 0 ? edge : -1, nodeScale, this.nodeDrag);
    } else if (seq === this.pickSeq) this.emitHover(node, edge, picked, nodeScale);
    if (this.pickWanted || p.waiting) this.wake();
  };

  private startDrag(node: number, nodeScale: number): void {
    const pos = this.streamedPositions ?? (this.store.channels.nodePos.data as Float32Array);
    const x = pos[node * 2]!;
    const y = pos[node * 2 + 1]!;
    this.camera.screenToWorld(this.press.x, this.press.y, this.world);
    this.grabX = x - this.world.x;
    this.grabY = y - this.world.y;
    this.dragNode = node;
    this.dragX = x;
    this.dragY = y;
    this.passes.cull.moveNode(this.pressEngine);
    this.passes.edgeCull.moveNode(this.pressEngine, this.store.edgeCount);
    if (this.dragEvents) this.init.onDrag("nodeDragStart", node, x, y);
    this.emitHover(node, -1, PICKED_NODES | PICKED_EDGES, nodeScale);
    this.moveDragged();
    this.wake();
  }

  private moveDragged(): void {
    const i = this.dragNode;
    const px = this.controls.pointerX;
    const py = this.controls.pointerY;
    if (i < 0 || i >= this.store.nodeCount || px < 0 || py < 0) return;
    this.camera.screenToWorld(px, py, this.world);
    const d = this.dragPos;
    d[0] = this.world.x + this.grabX;
    d[1] = this.world.y + this.grabY;
    const x = d[0]!;
    const y = d[1]!;
    if (x === this.dragX && y === this.dragY) return;
    this.dragX = x;
    this.dragY = y;
    this.store.updatePositions(i, d);
    this.store.growBounds(x, y);
    this.dirty |= Dirty.MOVED;
    if (this.dragEvents) this.init.onDrag("nodeDrag", i, x, y);
  }

  private endDrag(): void {
    const i = this.dragNode;
    if (i < 0) return;
    this.moveDragged();
    this.dragNode = -1;
    this.controls.hold = false;
    if (this.dragEvents) this.init.onDrag("nodeDragEnd", i, this.dragX, this.dragY);
    if (this.hoverKinds !== 0) this.pickWanted = true;
    this.wake();
  }

  private stopHold(pan: boolean): void {
    if (!pan) this.controls.hold = false;
    else if (this.controls.release(this.press.x, this.press.y, this.camera)) this.markDirty(Dirty.CAMERA);
  }

  private emitClick(node: number, edge: number): void {
    const n = (this.clickKinds & PICKED_NODES) !== 0 ? node : undefined;
    const e = (this.clickKinds & PICKED_EDGES) !== 0 ? edge : undefined;
    if (n !== undefined || e !== undefined) this.init.onClick(n, e);
  }

  private emitHover(node: number, edge: number, picked: number, nodeScale: number): void {
    let n: number | undefined;
    let e: number | undefined;
    const hoverNodes = (picked & PICKED_NODES) !== 0 && (this.hoverKinds & PICKED_NODES) !== 0;
    const hoverEdges = (picked & PICKED_EDGES) !== 0 && (this.hoverKinds & PICKED_EDGES) !== 0;
    if (hoverNodes && node !== this.hoverNode) n = this.hoverNode = node;
    if (hoverEdges && edge !== this.hoverEdge) e = this.hoverEdge = edge;
    if (n !== undefined || e !== undefined) this.init.onHover(n, e);
    const hover = this.hover;
    if (!hover) return;
    let changed = false;
    if (hoverNodes) changed = hover.setNode(node, nodeScale, this.store.hasNodeShapes) || changed;
    if (hoverEdges) {
      const ch = this.store.channels;
      const ends = ch.edgeIdx.data as Uint32Array;
      const style = edge >= 0 && this.store.hasEdgeStyles ? ch.edgeStyle.data[edge]! : 0;
      changed = hover.setEdge(edge, edge >= 0 ? ends[edge * 2]! : 0, edge >= 0 ? ends[edge * 2 + 1]! : 0, style) || changed;
    }
    if (changed) this.markDirty(Dirty.HOVER);
  }

  updatePositions(start: number, data: Float32Array): void {
    this.store.updatePositions(start, data);
    this.markDirty(Dirty.POSITIONS);
  }

  setStream(stream: StreamSlots): void {
    this.stream = stream;
    this.wake();
  }

  private takeStream(): number {
    const s = this.stream;
    const n = this.store.nodeCount;
    if (!s || !s.pending || s.count !== n) return 0;
    if ((s.positions && !this.graph.canStream("nodePos", n)) || (s.colors && !this.graph.canStream("nodeColor", n))) return 0;
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
    return bytes;
  }

  private syncStreamed(arrays: NodeArrays): void {
    const n = this.store.nodeCount;
    const p = this.streamedPositions;
    if (p && !arrays.positions && p.length === n * 2) this.store.updatePositions(0, p);
    const c = this.streamedColors;
    if (c && !arrays.colors && c.length === n) this.store.updateColors(0, c);
    this.streamedPositions = null;
    this.streamedColors = null;
  }

  updateColor(index: number, rgba: number): void {
    this.store.updateColor(index, rgba);
    this.markDirty(Dirty.STYLE);
  }

  setView(view: Partial<CameraView>): void {
    this.controls.cancelZoom();
    this.camera.setView(view);
    this.markDirty(Dirty.CAMERA);
  }

  fit(padding: number): void {
    this.controls.cancelZoom();
    this.camera.fit(this.store.drawnBounds(this.frameInputs.nodeScale), padding * this.pixelRatio);
    this.markDirty(Dirty.CAMERA);
  }

  setBackground(c: RGBA): void {
    this.frameGraph.setClearColor(c[0], c[1], c[2], c[3]);
    this.markDirty(Dirty.CLEAR_COLOR);
  }

  setNodeScale(v: number): void {
    this.frameInputs.nodeScale = v;
    this.markDirty(Dirty.STYLE);
  }

  labelSnapshot(id: number): void {
    this.passes.labels.requestSnapshot(id);
    this.markDirty(Dirty.LABEL_QUERY);
  }

  requestRender(): void {
    this.markDirty(Dirty.FORCED);
  }

  /** Play `opts.path` one step per rendered frame and record per-frame timings. */
  benchmark(id: number, opts: BenchmarkOptions): void {
    if (this.bench) throw new GraphError("invalid-argument", "A benchmark is already running");
    const fitZoom = this.camera.fitZoom(this.store.bounds, FIT_PADDING_CSS_PX * this.pixelRatio);
    const path = new CameraPath(opts.path, opts.frames, this.store.bounds, fitZoom);
    this.bench = new Benchmark(id, path, opts.warmup ?? DEFAULT_WARMUP_FRAMES, this.profiler.slotNames);
    this.probe.setOverride(BENCH_TIMING[opts.timing ?? "passes"]);
    this.markDirty(Dirty.CAMERA);
  }

  /** Apply one input record (from the ring or the postMessage fallback). */
  input(rec: InputRecord): void {
    if (this.probe.full) this.probe.input(rec.t);
    const handoff = this.controls.pinching;
    if (this.controls.apply(rec, this.camera)) this.dirty |= Dirty.CAMERA;
    const p = this.press;
    if (rec.type === INPUT.POINTER_DOWN) {
      if (!handoff && (rec.buttons & 1) !== 0 && (this.nodeDrag || this.clickKinds !== 0)) {
        p.down(rec.x, rec.y, this.nodeDrag);
        this.controls.hold = this.nodeDrag;
      } else p.cancel();
    } else if (rec.type === INPUT.POINTER_MOVE) p.move(rec.x, rec.y, CLICK_SLOP_CSS_PX * this.pixelRatio);
    else if (rec.type === INPUT.POINTER_UP) p.up();
    else if (rec.type === INPUT.PINCH) p.cancel();
    if (rec.type === INPUT.POINTER_MOVE || rec.type === INPUT.POINTER_LEAVE || rec.type === INPUT.POINTER_DOWN) {
      this.frameInputs.pointerX = this.controls.pointerX;
      this.frameInputs.pointerY = this.controls.pointerY;
      if (this.hoverKinds !== 0) this.pickWanted = true;
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
    this.pick?.destroy();
    this.hover?.destroy();
    this.probe.destroy();
    this.passes.cull.destroy();
    this.passes.edgeCull.destroy();
    this.passes.labels.destroy();
    this.labels.destroy();
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
    if (this.dragNode >= 0) this.moveDragged();
    if (this.press.active && this.press.seq === 0) this.pressPick();
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
        this.pickWanted = true;
      }
    }
    if (this.pickWanted) this.maybePick(t0);

    if (this.dirty === 0) {
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
    if (full) probe.mark(CPU.UPLOAD);
    const nodeCount = this.reserveNodes();
    const edgeCount = this.reserveEdges();
    if (full) probe.mark(CPU.RESERVE);

    const fi = this.frameInputs;
    fi.time = (t0 - this.startTime) / 1000;
    fi.frameIndex = this.frameIndex;
    fi.pixelRatio = this.pixelRatio;
    fi.nodeCount = nodeCount;
    fi.edgeCount = edgeCount;
    this.frameUniform.write(fi);

    const ctx = this.frameCtx;
    ctx.graphBindGroup = this.graph.bindGroup;
    ctx.nodeCount = nodeCount;
    ctx.edgeCount = edgeCount;
    ctx.dirty = this.dirty;
    this.passes.edges.perEdgeStyle = this.store.hasEdgeStyles;
    this.passes.edges.perEdgeColor = this.store.hasEdgeColors;
    this.passes.cull.shapes = this.store.hasNodeShapes;
    this.passes.nodes.shapes = this.store.hasNodeShapes;
    this.passes.edges.shapes = this.store.hasNodeShapes;

    const device = this.gpu.device;
    const encoder = device.createCommandEncoder();
    this.profiler.beginFrame();
    if (full) probe.mark(CPU.UNIFORM);
    const target = this.context.getCurrentTexture().createView();
    if (full) probe.mark(CPU.TEXTURE);
    this.frameGraph.execute(encoder, target, ctx, full ? this.encodeTimes : null);
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
    if (full) probe.mark(CPU.SUBMIT);
    this.profiler.afterSubmit();
    this.passes.labels.afterSubmit();
    this.graph.afterSubmit();
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
    if (bench && !bench.driving) this.scheduleBenchCheck();
    this.frameGen = this.dataGen;
    if ((frameDirty & PICK_DIRTY) !== 0 && this.hoverKinds !== 0) this.pickWanted = true;

    // One more tick to pick up input that arrived during this frame; it sleeps if there is none.
    this.wake();
  };

  /** Size the cull buffers for the current node count; returns the drawable count. */
  private reserveNodes(): number {
    const n = this.store.nodeCount;
    if (n !== this.reservedFor) {
      try {
        const retire = (b: GPUBuffer) => this.graph.retireAfterSubmit(b);
        this.passes.cull.reserve(n, retire);
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
      nodeCount: this.store.nodeCount,
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
    s[STATE_SLOT.NODE_COUNT] = this.store.nodeCount;
    s[STATE_SLOT.EDGE_COUNT] = this.store.edgeCount;
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
