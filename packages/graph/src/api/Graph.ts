/**
 * Main-thread facade. Every setter is synchronous and cheap: it posts to
 * the render worker and returns. The main thread never touches the GPU.
 */
import { InputRing } from "../bridge/InputRing";
import { StreamSlots } from "../bridge/StreamSlots";
import { WORKER_EVENTS, type FromWorker, type ToWorker } from "../bridge/protocol";
import type { EdgeArrays, NodeArrays } from "../data/GraphStore";
import { createStateBuffer, STATE_SLOT } from "../bridge/SharedState";
import { Camera2D } from "../camera/Camera2D";
import { DebugOverlay } from "./DebugOverlay";
import { errorFromCode, GraphError, UnsupportedError } from "./errors";
import { copyInput, DEFAULT_INPUT, mergeInput, type ResolvedInput } from "./input";
import { PointerInput, type InputSink } from "./PointerInput";
import { NO_INDEX, Slots } from "./Slots";
import { CONSTANTS, MAX_NODES } from "../data/Layouts";
import { resolveStyle } from "./style";
import { Flag } from "./types";
import { packShape } from "../data/QueryShape";
import { EDGE_DEBUG_MODES } from "../engine/Tune";
import type {
  BenchmarkOptions,
  BenchmarkResult,
  CameraAnimOptions,
  CameraFitOptions,
  CameraLimits,
  CameraRotateOptions,
  CameraView,
  CopyOption,
  DebugRecording,
  DebugTune,
  GraphCamera,
  GraphCanvas,
  GraphCaps,
  GraphDebug,
  GraphEdges,
  GraphEvents,
  GraphIcons,
  GraphInputApi,
  GraphNodes,
  GraphQuery,
  GraphStyleApi,
  GraphInput,
  GraphOptions,
  GraphStats,
  GraphStyle,
  Hit,
  LabelSnapshot,
  EdgeData,
  EdgeUpdate,
  IconSource,
  NodeData,
  NodeStream,
  NodeStreamChannels,
  NodeUpdate,
  Polygon,
  Rect,
  WorldBounds,
} from "./types";

const DEFAULT_FIT_PADDING = 24;
const FLAG_BITS = Flag.selected | Flag.dimmed | Flag.hidden | Flag.focused;
const DEFAULT_NODE_RESERVE = 100;

type Listener<K extends keyof GraphEvents> = (payload: GraphEvents[K]) => void;

/** A graph drawn with WebGPU in a render worker. */
export class Graph {
  /** Moves the canvas to a render worker, starts WebGPU and resolves with the graph. */
  static async create(canvas: HTMLCanvasElement, options: GraphOptions = {}): Promise<Graph> {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      throw new UnsupportedError("webgpu-unavailable", "WebGPU is not available in this browser.");
    }
    if (typeof canvas.transferControlToOffscreen !== "function") {
      throw new UnsupportedError("offscreen-canvas-unavailable", "OffscreenCanvas is not supported in this browser.");
    }
    const nodeReserve = options.nodeReserve ?? DEFAULT_NODE_RESERVE;
    if (!Number.isInteger(nodeReserve) || nodeReserve < 0) throw new GraphError("invalid-argument", `Graph.create: nodeReserve must be an integer >= 0, got ${nodeReserve}`);

    const shared = typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
    const ring = shared ? InputRing.create() : null;
    const state = createStateBuffer(shared);
    const pixelRatio = options.pixelRatio ?? globalThis.devicePixelRatio ?? 1;
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "vhult-graph" });

    const { width, height } = canvasDeviceSize(canvas, pixelRatio);
    const offscreen = canvas.transferControlToOffscreen();
    const input = mergeInput(DEFAULT_INPUT, options.input && copyInput(options.input, "Graph.create: input"));
    const init: ToWorker = {
      t: "init",
      canvas: offscreen,
      width,
      height,
      pixelRatio,
      ring: ring ? ring.buffer : null,
      state: shared ? (state.buffer as SharedArrayBuffer) : null,
      options: {
        style: resolveStyle(options.style),
        input,
        timeOrigin: performance.timeOrigin,
        nodeReserve,
      },
    };

    const caps = await new Promise<GraphCaps>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<FromWorker>) => {
        const m = ev.data;
        if (m.t === "ready") resolve(m.caps);
        else if (m.t === "error" && m.fatal) {
          worker.terminate();
          reject(errorFromCode(m.code, m.message));
        }
      };
      worker.onerror = (ev) => {
        worker.terminate();
        reject(new GraphError("internal", `Render worker failed to start: ${ev.message}`));
      };
      worker.postMessage(init, [offscreen]);
    });

    return new Graph(canvas, worker, caps, ring, state, pixelRatio, options.autoResize ?? true, input);
  }

  /** Camera: view, fit, rotation, limits and coordinate conversion. */
  readonly camera: GraphCamera = {
    fit: (opts: CameraFitOptions = {}): void => this.fitImpl(opts),
    set: (view: Partial<CameraView>, anim?: CameraAnimOptions): void => this.setViewImpl(view, anim),
    get: (): CameraView => this.cssView(this.state[STATE_SLOT.CAMERA_X]!, this.state[STATE_SLOT.CAMERA_Y]!, this.state[STATE_SLOT.CAMERA_ZOOM]!, this.state[STATE_SLOT.CAMERA_ROTATION]!),
    rotate: (angle: number, opts: CameraRotateOptions = {}): void => this.rotateImpl(angle, opts),
    limits: (l: CameraLimits): void => this.limitsImpl(l),
    toWorld: (x: number, y: number, out: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } => {
      this.publishedCamera().screenToWorld(x, y, out);
      return out;
    },
    toScreen: (x: number, y: number, out: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } => {
      this.publishedCamera().worldToScreen(x, y, out);
      return out;
    },
  };

  /** Nodes: set, add, remove, update, flag and stream node channels. */
  readonly nodes: GraphNodes = this.nodesApi();

  /** Edges: set, add, remove, update and flag edge channels. */
  readonly edges: GraphEdges = this.edgesApi();

  /** Style: the look of the graph. */
  readonly style: GraphStyleApi = {
    set: (style: GraphStyle): void => this.send({ t: "style", style }),
  };

  /** Input: interactions and picking. */
  readonly input: GraphInputApi = {
    set: (partial: GraphInput): void => this.setInputImpl(partial),
  };

  /** Icons: the icon set nodes draw from. */
  readonly icons: GraphIcons = {
    define: (sources: readonly IconSource[]): Promise<void> => this.defineIconsImpl(sources),
    add: (sources: readonly IconSource[]): Promise<Uint16Array> => this.addIconsImpl(sources),
    replace: (id: number, source: IconSource): Promise<void> => this.replaceIconImpl(id, source),
    remove: (ids: readonly number[] | Uint16Array): void => this.removeIconsImpl(ids),
  };

  /** Query: what is at a point or inside a shape. */
  readonly query: GraphQuery = {
    at: (x: number, y: number): Promise<Hit> => this.queryAtImpl(x, y),
    inside: (shape: Rect | Polygon): Promise<Uint32Array> => this.queryInsideImpl(shape),
  };

  /** Canvas: size, frames and snapshots. */
  readonly canvas: GraphCanvas = {
    resize: (width: number, height: number): void =>
      this.send({ t: "resize", width: width * this.pixelRatio, height: height * this.pixelRatio, pixelRatio: this.pixelRatio }),
    render: (): void => this.send({ t: "render" }),
    snapshot: (type = "image/png"): Promise<Blob> => this.snapshotImpl(type),
  };

  /** Debug: the overlay, recordings, benchmarks and engine tuning. */
  readonly debug: GraphDebug = {
    open: (): void => this.overlay().show(),
    close: (): void => this.debugOverlay?.hide(),
    toggle: (): void => (this.debugOverlay?.open ? this.debugOverlay.hide() : this.overlay().show()),
    isOpen: (): boolean => this.debugOverlay?.open ?? false,
    expand: (expanded = true): void => this.overlay().setExpanded(expanded),
    record: (): Promise<DebugRecording> => (this.destroyed ? Promise.reject(new GraphError("destroyed", "Graph destroyed")) : this.overlay().record()),
    stop: (): void => this.debugOverlay?.stopRecord(),
    benchmark: (options: BenchmarkOptions): Promise<BenchmarkResult> => this.benchmarkImpl(options),
    labelSnapshot: (): Promise<LabelSnapshot> => this.labelSnapshotImpl(),
    tune: (tune: DebugTune): void => this.send({ t: "tune", tune: checkTune(tune) }),
  };

  private debugOverlay: DebugOverlay | null = null;
  private debugRing: Extract<FromWorker, { t: "debugRing" }> | null = null;
  private readonly nodeSlots = new Slots();
  private readonly edgeSlots = new Slots();
  private slotGen = 0;
  private genSlots = 0;
  private removalSeq = 0;
  private readonly removals = new Map<number, number>();
  private edgeEpoch = 0;
  private logBase = 0;
  private readonly edgeLog: (Uint32Array | null)[] = [];
  private destroyed = false;
  private replySeq = 0;
  private benchId = 0;
  private readonly replies = new Map<number, { resolve: (value: never) => void; reject: (e: Error) => void }>();
  private readonly iconSlots = new Slots();
  private readonly listeners: { [K in keyof GraphEvents]: Set<Listener<K>> } = {
    error: new Set(),
    hover: new Set(),
    click: new Set(),
    doubleClick: new Set(),
    contextMenu: new Set(),
    pan: new Set(),
    zoom: new Set(),
    rotate: new Set(),
    dragStart: new Set(),
    drag: new Set(),
    dragEnd: new Set(),
    select: new Set(),
    edgesRemoved: new Set(),
    view: new Set(),
  };
  private readonly viewCamera = new Camera2D();
  private listenKey = "";
  private readonly pointer: PointerInput;
  private readonly resizeObserver: ResizeObserver | null = null;

  private constructor(
    private readonly canvasEl: HTMLCanvasElement,
    private readonly worker: Worker,
    /** What this GPU and page support. */
    readonly caps: GraphCaps,
    private readonly ring: InputRing | null,
    private readonly state: Float64Array,
    private pixelRatio: number,
    autoResize: boolean,
    private inputState: ResolvedInput,
  ) {
    worker.onmessage = this.onMessage;
    worker.onerror = (ev) => this.emitError(new GraphError("internal", ev.message));

    const sink: InputSink = ring
      ? (type, t, x, y, dx, dy, buttons, mods, button) => {
          ring.push(type, t, x, y, dx, dy, buttons, mods, button);
          if (ring.claimWake()) this.worker.postMessage({ t: "wake" } satisfies ToWorker);
        }
      : (type, t, x, y, dx, dy, buttons, mods, button) => this.send({ t: "inputRecord", r: [type, t, x, y, dx, dy, buttons, mods, button] });
    this.pointer = new PointerInput(canvasEl, sink, () => this.pixelRatio);
    this.pointer.zoom = inputState.zoom !== false;

    if (autoResize && typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onResize);
      try {
        this.resizeObserver.observe(canvasEl, { box: "device-pixel-content-box" });
      } catch {
        this.resizeObserver.observe(canvasEl);
      }
    }
  }

  // ---- data ---------------------------------------------------------------------

  private nodesApi(): GraphNodes {
    const graph = this;
    return {
      set: (data: NodeData, opts?: CopyOption): void => this.setNodesImpl(data, opts),
      add: (data: NodeData, opts?: CopyOption): Uint32Array => this.addNodesImpl(data, opts),
      remove: (indices: Uint32Array | number[]): void => this.removeNodesImpl(indices),
      update: (indices: Uint32Array, data: NodeUpdate, opts?: CopyOption): void => this.updateAtImpl(indices, data, opts),
      updateAll: (data: NodeUpdate, opts?: CopyOption): void => this.updateAllImpl(data, opts),
      stream: (channels: NodeStreamChannels): NodeStream => this.streamImpl(channels),
      flag: (target: Uint32Array | "all", flags: number, on: boolean): void => this.flagImpl(target, flags, on),
      clear: (): void => this.setNodesImpl({ count: 0 }),
      compact: (): Uint32Array => this.compactNodesImpl(),
      get count(): number {
        return graph.nodeSlots.count;
      },
      get slots(): number {
        return graph.nodeSlots.slots;
      },
    };
  }

  /** Bulk-load nodes. The fastest path: arrays are transferred, uploaded via mappedAtCreation. */
  private setNodesImpl(data: NodeData, opts?: CopyOption): void {
    const t0 = this.apiStart();
    const n = data.count;
    if (!Number.isInteger(n) || n < 0) throw new GraphError("invalid-argument", "nodes.set: count must be a non-negative integer");
    if (n > MAX_NODES) throw new GraphError("limits-exceeded", `nodes.set: at most ${MAX_NODES} nodes, got ${n}`);
    const transfer: Transferable[] = [];
    const arrays = nodeArrays(data, n, opts, transfer);
    const labels = data.labels ? convertLabels(data.labels, n, "nodes.set: labels") : [];
    this.nodeSlots.reset(n);
    this.edgeSlots.reset(0);
    this.edgesRenumbered(null);
    this.slotsChanged();
    this.send({ t: "nodes", count: n, labels, ...arrays }, transfer);
    if (t0) this.apiEnd("nodes.set", t0);
  }

  private addNodesImpl(data: NodeData, opts?: CopyOption): Uint32Array {
    const n = data.count;
    if (!Number.isInteger(n) || n < 0) throw new GraphError("invalid-argument", "nodes.add: count must be a non-negative integer");
    const s = this.nodeSlots;
    if (s.slots + Math.max(0, n - (s.slots - s.count)) > MAX_NODES) throw new GraphError("limits-exceeded", `nodes.add: at most ${MAX_NODES} node slots`);
    const t0 = this.apiStart();
    const transfer: Transferable[] = [];
    const arrays = nodeArrays(data, n, opts, transfer);
    const labels = data.labels ? convertLabels(data.labels, n, "nodes.add: labels") : undefined;
    if (n === 0) return new Uint32Array(0);
    const indices = s.take(n);
    this.slotsChanged();
    const sent = indices.slice();
    transfer.push(sent.buffer);
    this.send({ t: "addNodes", indices: sent, slots: s.slots, labels, ...arrays }, transfer);
    if (t0) this.apiEnd("nodes.add", t0);
    return indices;
  }

  private removeNodesImpl(list: Uint32Array | number[]): void {
    const t0 = this.apiStart();
    const indices = releaseImpl(this.nodeSlots, list, "nodes.remove");
    if (!indices) return;
    const id = ++this.removalSeq;
    this.removals.set(id, this.edgeEpoch);
    this.send({ t: "removeNodes", id, indices }, [indices.buffer]);
    if (t0) this.apiEnd("nodes.remove", t0);
  }

  private compactNodesImpl(): Uint32Array {
    const t0 = this.apiStart();
    const same = this.nodeSlots.count === this.nodeSlots.slots;
    const remap = this.nodeSlots.compact();
    if (same) return remap;
    this.slotsChanged();
    const copy = remap.slice();
    this.send({ t: "compactNodes", remap: copy }, [copy.buffer]);
    if (t0) this.apiEnd("nodes.compact", t0);
    return remap;
  }

  private updateAllImpl(data: NodeUpdate, opts?: CopyOption, clampZ = false): void {
    const n = updateCount(data, "nodes.updateAll");
    if (n === 0 && data.labels === undefined) return;
    const slots = this.nodeSlots.slots;
    if (n > 0 && n !== slots) throw new GraphError("invalid-argument", `nodes.updateAll: arrays must cover ${slots} node slots, got ${n}`);
    const t0 = this.apiStart();
    const transfer: Transferable[] = [];
    const labels = convertUpdateLabels(data.labels, slots, "nodes.updateAll: labels");
    this.send({ t: "updateNodes", start: 0, labels, ...nodeArrays(data, n, opts, transfer, clampZ) }, transfer);
    if (t0) this.apiEnd("nodes.updateAll", t0);
  }

  private slotsChanged(): void {
    if (this.nodeSlots.slots === this.genSlots) return;
    this.genSlots = this.nodeSlots.slots;
    this.slotGen++;
  }

  private edgesRenumbered(remap: Uint32Array | null): void {
    this.edgeEpoch++;
    if (this.removals.size === 0) this.logBase = this.edgeEpoch;
    else this.edgeLog.push(remap);
  }

  private onEdgesRemoved(id: number, removed: Uint32Array): void {
    const epoch = this.removals.get(id);
    if (epoch === undefined) return;
    this.removals.delete(id);
    let edges = removed;
    for (let k = epoch; k < this.edgeEpoch; k++) {
      const remap = this.edgeLog[k - this.logBase];
      edges = remap ? remapIndices(edges, remap) : new Uint32Array(0);
    }
    if (this.removals.size === 0) {
      this.edgeLog.length = 0;
      this.logBase = this.edgeEpoch;
    }
    this.edgeSlots.release(edges);
    for (const fn of this.listeners.edgesRemoved) fn(edges);
  }

  private updateAtImpl(indices: Uint32Array, data: NodeUpdate, opts?: CopyOption): void {
    const transfer: Transferable[] = [];
    const idx = indexedUpdate(indices, data.labels, hasNodeArrays(data), "nodes.update", opts, transfer);
    if (!idx) return;
    const t0 = this.apiStart();
    const arrays = nodeArrays(data, idx.length, opts, transfer);
    const labels = data.labels ? convertLabels(data.labels, idx.length, "nodes.update: labels") : undefined;
    this.nodeSlots.check(idx, "nodes.update");
    this.send({ t: "updateNodesAt", indices: idx, labels, ...arrays }, transfer);
    if (t0) this.apiEnd("nodes.update", t0);
  }

  private flagImpl(target: Uint32Array | "all", flags: number, on: boolean, edges = false): void {
    const name = edges ? "edges.flag" : "nodes.flag";
    const t = edges ? "flagEdges" : "flagNodes";
    if (!Number.isInteger(flags) || flags <= 0 || (flags & ~FLAG_BITS) !== 0) {
      throw new GraphError("invalid-argument", `${name}: flags must combine Flag values, got ${flags}`);
    }
    if (target === "all") {
      const t0 = this.apiStart();
      this.send({ t, indices: null, flags, on });
      if (t0) this.apiEnd(name, t0);
      return;
    }
    if (!(target instanceof Uint32Array)) throw new GraphError("invalid-argument", `${name}: target must be a Uint32Array or "all"`);
    checkAttached(target, `${name}: target`);
    if (target.length === 0) return;
    const t0 = this.apiStart();
    (edges ? this.edgeSlots : this.nodeSlots).check(target, name);
    this.send({ t, indices: target, flags, on });
    if (t0) this.apiEnd(name, t0);
  }

  private edgesApi(): GraphEdges {
    const graph = this;
    return {
      set: (data: EdgeData, opts?: CopyOption): void => this.setEdgesImpl(data, opts),
      add: (data: EdgeData, opts?: CopyOption): Uint32Array => this.addEdgesImpl(data, opts),
      remove: (indices: Uint32Array | number[]): void => this.removeEdgesImpl(indices),
      update: (indices: Uint32Array, data: EdgeUpdate, opts?: CopyOption): void => this.updateEdgesAtImpl(indices, data, opts),
      updateAll: (data: EdgeUpdate, opts?: CopyOption): void => this.updateEdgesImpl(data, opts),
      flag: (target: Uint32Array | "all", flags: number, on: boolean): void => this.flagImpl(target, flags, on, true),
      clear: (): void => this.setEdgesImpl({ count: 0, indices: new Uint32Array(0) }),
      compact: (): Uint32Array => this.compactEdgesImpl(),
      get count(): number {
        return graph.edgeSlots.count;
      },
      get slots(): number {
        return graph.edgeSlots.slots;
      },
    };
  }

  /** Bulk-load edges. `indices` holds source/target NODE INDICES interleaved. `nodes.set` clears them. */
  private setEdgesImpl(data: EdgeData, opts?: CopyOption): void {
    const t0 = this.apiStart();
    const n = data.count;
    if (!Number.isInteger(n) || n < 0) throw new GraphError("invalid-argument", "edges.set: count must be a non-negative integer");
    const transfer: Transferable[] = [];
    const arrays = edgeArrays(data, n, opts, transfer);
    const labels = data.labels ? convertLabels(data.labels, n, "edges.set: labels") : [];
    this.edgeSlots.reset(n);
    this.edgesRenumbered(null);
    this.send({ t: "edges", count: n, labels, ...arrays }, transfer);
    if (t0) this.apiEnd("edges.set", t0);
  }

  private addEdgesImpl(data: EdgeData, opts?: CopyOption): Uint32Array {
    const n = data.count;
    if (!Number.isInteger(n) || n < 0) throw new GraphError("invalid-argument", "edges.add: count must be a non-negative integer");
    if (!(data.indices instanceof Uint32Array)) throw new GraphError("invalid-argument", "edges.add: indices must be a Uint32Array");
    const t0 = this.apiStart();
    const transfer: Transferable[] = [];
    const arrays = edgeArrays(data, n, opts, transfer);
    const labels = data.labels ? convertLabels(data.labels, n, "edges.add: labels") : undefined;
    this.checkEnds(arrays.indices!, "edges.add");
    if (n === 0) return new Uint32Array(0);
    const indices = this.edgeSlots.take(n, this.removals.size === 0);
    this.send({ t: "addEdges", at: indices.slice(), count: this.edgeSlots.slots, labels, ...arrays }, transfer);
    if (t0) this.apiEnd("edges.add", t0);
    return indices;
  }

  private removeEdgesImpl(list: Uint32Array | number[]): void {
    const t0 = this.apiStart();
    const indices = releaseImpl(this.edgeSlots, list, "edges.remove");
    if (!indices) return;
    this.send({ t: "removeEdges", indices }, [indices.buffer]);
    if (t0) this.apiEnd("edges.remove", t0);
  }

  private updateEdgesAtImpl(indices: Uint32Array, data: EdgeUpdate, opts?: CopyOption): void {
    const transfer: Transferable[] = [];
    const at = indexedUpdate(indices, data.labels, hasEdgeArrays(data), "edges.update", opts, transfer);
    if (!at) return;
    const t0 = this.apiStart();
    const arrays = edgeArrays(data, at.length, opts, transfer);
    const labels = data.labels ? convertLabels(data.labels, at.length, "edges.update: labels") : undefined;
    this.edgeSlots.check(at, "edges.update");
    if (arrays.indices) this.checkEnds(arrays.indices, "edges.update");
    this.send({ t: "updateEdgesAt", at, labels, ...arrays }, transfer);
    if (t0) this.apiEnd("edges.update", t0);
  }

  private updateEdgesImpl(data: EdgeUpdate, opts?: CopyOption): void {
    if (!hasEdgeArrays(data) && data.labels === undefined) return;
    const n = this.edgeSlots.slots;
    const t0 = this.apiStart();
    const transfer: Transferable[] = [];
    const arrays = edgeArrays(data, n, opts, transfer);
    const labels = convertUpdateLabels(data.labels, n, "edges.updateAll: labels");
    if (arrays.indices) this.checkEnds(arrays.indices, "edges.updateAll", true);
    this.send({ t: "updateEdges", labels, ...arrays }, transfer);
    if (t0) this.apiEnd("edges.updateAll", t0);
  }

  private compactEdgesImpl(): Uint32Array {
    const same = this.edgeSlots.count === this.edgeSlots.slots;
    const remap = this.edgeSlots.compact();
    if (same) return remap;
    this.edgesRenumbered(this.removals.size > 0 ? remap.slice() : null);
    const copy = remap.slice();
    this.send({ t: "compactEdges", remap: copy }, [copy.buffer]);
    return remap;
  }

  private checkEnds(ends: Uint32Array, name: string, liveEdgesOnly = false): void {
    const nodes = this.nodeSlots;
    for (let j = 0; j < ends.length; j++) {
      if (liveEdgesOnly && !this.edgeSlots.isLive(j >> 1)) continue;
      if (!nodes.isLive(ends[j]!)) throw new GraphError("invalid-argument", `${name}: end ${ends[j]} of edge ${j >> 1} is not a live node slot`);
    }
  }

  private defineIconsImpl(icons: readonly IconSource[]): Promise<void> {
    if (this.destroyed) return Promise.reject(new GraphError("destroyed", "Graph destroyed"));
    const t0 = this.apiStart();
    const list = iconList(icons, "icons.define");
    const max = this.caps.maxIcons;
    if (list.length > max) throw new GraphError("limits-exceeded", `icons.define: this GPU holds at most ${max} icons, got ${list.length}`);
    this.iconSlots.reset(list.length);
    const done = this.request<void>((id) => ({ t: "defineIcons", id, icons: list }));
    if (t0) this.apiEnd("icons.define", t0);
    return done;
  }

  private addIconsImpl(icons: readonly IconSource[]): Promise<Uint16Array> {
    if (this.destroyed) return Promise.reject(new GraphError("destroyed", "Graph destroyed"));
    const list = iconList(icons, "icons.add");
    const slots = this.iconSlots;
    const max = this.caps.maxIcons;
    if (slots.count + list.length > max) throw new GraphError("limits-exceeded", `icons.add: this GPU holds at most ${max} icons, ${slots.count} are in use`);
    const ids = Uint16Array.from(slots.take(list.length));
    if (ids.length === 0) return Promise.resolve(ids);
    return this.request<void>((id) => ({ t: "setIcons", id, ids: ids.slice(), icons: list })).then(() => ids);
  }

  private replaceIconImpl(icon: number, source: IconSource): Promise<void> {
    if (this.destroyed) return Promise.reject(new GraphError("destroyed", "Graph destroyed"));
    if (!this.iconSlots.isLive(icon)) throw new GraphError("invalid-argument", `icons.replace: ${icon} is not an icon id in use`);
    const list = iconList([source], "icons.replace");
    return this.request<void>((id) => ({ t: "setIcons", id, ids: new Uint16Array([icon]), icons: list }));
  }

  private removeIconsImpl(ids: readonly number[] | Uint16Array): void {
    this.iconSlots.check(ids, "icons.remove");
    if (ids.length === 0) return;
    this.iconSlots.release(ids);
    this.send({ t: "removeIcons", ids: Uint16Array.from(ids) });
  }

  private streamImpl(channels: NodeStreamChannels): NodeStream {
    const count = this.nodeSlots.slots;
    const gen = this.slotGen;
    const current = (): void => {
      if (this.slotGen !== gen) throw new GraphError("invalid-argument", "nodes.stream: the node slots changed; take a new stream");
    };
    const positions = channels.positions === true;
    const colors = channels.colors === true;
    const zIndex = channels.zIndex === true;
    const ring = this.ring;
    if (!ring) {
      const p = new Float32Array(positions ? count * 2 : 0);
      const c = new Uint32Array(colors ? count : 0);
      const z = new Uint8Array(zIndex ? count : 0);
      const commit = (): void => {
        current();
        this.updateAllImpl({ positions: positions ? p : undefined, colors: colors ? c : undefined, zIndex: zIndex ? z : undefined }, { copy: true }, true);
      };
      return { positions: p, colors: c, zIndex: z, commit };
    }
    const slots = StreamSlots.create(count, positions, colors, zIndex);
    this.send({ t: "nodeStream", buffer: slots.buffer, count, positions, colors, zIndex });
    return {
      get positions() {
        return slots.data.positions;
      },
      get colors() {
        return slots.data.colors;
      },
      get zIndex() {
        return slots.data.zIndex;
      },
      commit: () => {
        current();
        slots.commit();
        if (ring.claimWake()) this.worker.postMessage({ t: "wake" } satisfies ToWorker);
      },
    };
  }

  // ---- lifecycle -----------------------------------------------------------------

  /**
   * Play a camera path one step per rendered frame and record per-frame CPU,
   * GPU (total and per pass), frame interval and visible counts. Frame N always
   * shows the same view, so runs are comparable across machines and commits.
   * Rendering is continuous while it runs; one benchmark at a time.
   */
  private benchmarkImpl(options: BenchmarkOptions): Promise<BenchmarkResult> {
    if (this.destroyed) return Promise.reject(new GraphError("destroyed", "Graph destroyed"));
    if (this.benchId !== 0) return Promise.reject(new GraphError("invalid-argument", "A benchmark is already running"));
    if (options.path.length === 0 || !(options.frames > 0)) {
      return Promise.reject(new GraphError("invalid-argument", "debug.benchmark: path needs ≥ 1 key and frames > 0"));
    }
    const done = this.request<BenchmarkResult>((id) => ({ t: "benchmark", id, options: { path: options.path.map((k) => ({ ...k })), frames: options.frames, warmup: options.warmup, timing: options.timing } }));
    this.benchId = this.replySeq;
    return done;
  }

  /** Candidates and decisions of the next label placement. */
  private labelSnapshotImpl(): Promise<LabelSnapshot> {
    return this.request((id) => ({ t: "labelSnapshot", id }));
  }

  private snapshotImpl(type: string): Promise<Blob> {
    if (this.destroyed) return Promise.reject(new GraphError("destroyed", "Graph destroyed"));
    if (typeof type !== "string") throw new GraphError("invalid-argument", `canvas.snapshot: type must be a string, got ${String(type)}`);
    return this.request((id) => ({ t: "snapshot", id, type }));
  }

  private queryAtImpl(x: number, y: number): Promise<Hit> {
    if (this.destroyed) return Promise.reject(new GraphError("destroyed", "Graph destroyed"));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new GraphError("invalid-argument", `query.at: x and y must be finite numbers, got ${x} and ${y}`);
    return this.request((id) => ({ t: "queryAt", id, x, y }));
  }

  private queryInsideImpl(shape: Rect | Polygon): Promise<Uint32Array> {
    if (this.destroyed) return Promise.reject(new GraphError("destroyed", "Graph destroyed"));
    const points = packShape(shape, this.pixelRatio);
    return this.request((id) => ({ t: "queryInside", id, points }), [points.buffer]);
  }

  private request<T>(make: (id: number) => ToWorker, transfer?: Transferable[]): Promise<T> {
    if (this.destroyed) return Promise.reject(new GraphError("destroyed", "Graph destroyed"));
    const id = ++this.replySeq;
    return new Promise<T>((resolve, reject) => {
      this.replies.set(id, { resolve: resolve as (value: never) => void, reject });
      this.send(make(id), transfer);
    });
  }

  /** Returns the latest frame numbers, written into `out` when given. */
  stats(out: GraphStats = {} as GraphStats): GraphStats {
    const s = this.state;
    out.frameIndex = s[STATE_SLOT.FRAME_INDEX]!;
    out.renderedFrames = s[STATE_SLOT.RENDERED_FRAMES]!;
    out.cpuMs = s[STATE_SLOT.CPU_MS_LAST]!;
    out.cpuMsAvg = s[STATE_SLOT.CPU_MS_AVG]!;
    out.nodeCount = s[STATE_SLOT.NODE_COUNT]!;
    out.edgeCount = s[STATE_SLOT.EDGE_COUNT]!;
    out.viewportWidth = s[STATE_SLOT.VIEWPORT_W]!;
    out.viewportHeight = s[STATE_SLOT.VIEWPORT_H]!;
    out.uploadBytes = s[STATE_SLOT.UPLOAD_BYTES]!;
    out.gpuBytes = s[STATE_SLOT.GPU_BYTES]!;
    out.peakGpuBytes = s[STATE_SLOT.PEAK_GPU_BYTES]!;
    out.pixelRatio = this.pixelRatio;
    out.gpuMs = s[STATE_SLOT.GPU_MS_AVG]!;
    out.visibleNodes = s[STATE_SLOT.VISIBLE_NODES]!;
    out.visibleEdges = s[STATE_SLOT.VISIBLE_EDGES]!;
    out.labelsShown = s[STATE_SLOT.LABELS_SHOWN]!;
    out.labelSolves = s[STATE_SLOT.LABEL_SOLVES]!;
    out.labelsAdded = s[STATE_SLOT.LABELS_ADDED]!;
    out.labelsRemoved = s[STATE_SLOT.LABELS_REMOVED]!;
    out.droppedSamples = s[STATE_SLOT.PROFILER_DROPPED]!;
    out.passMs ??= {};
    const slots = this.caps.profilerSlots;
    for (let k = 0; k < slots.length; k++) out.passMs[slots[k]!] = s[STATE_SLOT.SLOT_MS_BASE + k]!;
    return out;
  }

  /** Subscribes to an event and returns the function that unsubscribes. */
  on<K extends keyof GraphEvents>(event: K, fn: (payload: GraphEvents[K]) => void): () => void {
    this.listeners[event].add(fn);
    this.syncListen();
    return () => {
      this.listeners[event].delete(fn);
      this.syncListen();
    };
  }

  private setInputImpl(partial: GraphInput): void {
    const input = copyInput(partial, "input.set");
    this.send({ t: "input", input });
    this.inputState = mergeInput(this.inputState, input);
    this.pointer.zoom = this.inputState.zoom !== false;
  }

  private syncListen(): void {
    if (this.destroyed) return;
    const events = WORKER_EVENTS.filter((e) => this.listeners[e].size > 0);
    this.pointer.menu = this.listeners.contextMenu.size > 0;
    const key = events.join();
    if (key === this.listenKey) return;
    this.listenKey = key;
    this.send({ t: "listen", events });
  }

  private cssView(x: number, y: number, zoom: number, rotation: number): CameraView {
    return { x, y, zoom: zoom / this.pixelRatio, rotation };
  }

  private publishedCamera(): Camera2D {
    const s = this.state;
    const c = this.viewCamera;
    const r = this.pixelRatio;
    c.x = s[STATE_SLOT.CAMERA_X]!;
    c.y = s[STATE_SLOT.CAMERA_Y]!;
    c.zoom = s[STATE_SLOT.CAMERA_ZOOM]! / r;
    c.rotation = s[STATE_SLOT.CAMERA_ROTATION]!;
    c.viewportW = s[STATE_SLOT.VIEWPORT_W]! / r;
    c.viewportH = s[STATE_SLOT.VIEWPORT_H]! / r;
    return c;
  }

  private setViewImpl(view: Partial<CameraView>, anim: CameraAnimOptions | undefined): void {
    if (!anim) {
      this.send({ t: "view", view });
      return;
    }
    const duration = checkDuration(anim.duration, "camera.set");
    const easing = anim.easing;
    if (easing !== undefined && easing !== "linear" && easing !== "ease") throw new GraphError("invalid-argument", `camera.set: easing must be "linear" or "ease", got ${String(easing)}`);
    this.send({ t: "view", view, duration, easing });
  }

  private fitImpl(opts: CameraFitOptions): void {
    const padding = opts.padding ?? DEFAULT_FIT_PADDING;
    if (!Number.isFinite(padding) || padding < 0) throw new GraphError("invalid-argument", `camera.fit: padding must be a finite number >= 0, got ${padding}`);
    const duration = checkDuration(opts.duration, "camera.fit");
    if (opts.nodes !== undefined && opts.bounds !== undefined) throw new GraphError("invalid-argument", "camera.fit: pass nodes or bounds, not both");
    const bounds = opts.bounds === undefined ? undefined : checkBounds(opts.bounds, "camera.fit");
    const list = opts.nodes;
    if (list === undefined) {
      this.send({ t: "fit", padding, bounds, duration });
      return;
    }
    if (!(list instanceof Uint32Array)) throw new GraphError("invalid-argument", "camera.fit: nodes must be a Uint32Array");
    checkAttached(list, "camera.fit: nodes");
    if (list.length === 0) return;
    this.nodeSlots.check(list, "camera.fit");
    const nodes = list.slice();
    this.send({ t: "fit", padding, nodes, duration }, [nodes.buffer]);
  }

  private rotateImpl(angle: number, opts: CameraRotateOptions): void {
    if (!Number.isFinite(angle)) throw new GraphError("invalid-argument", `camera.rotate: angle must be a finite number, got ${angle}`);
    const { x, y } = opts;
    if ((x !== undefined && !Number.isFinite(x)) || (y !== undefined && !Number.isFinite(y))) throw new GraphError("invalid-argument", "camera.rotate: x and y must be finite numbers");
    const duration = checkDuration(opts.duration, "camera.rotate");
    this.send({ t: "rotate", angle, x, y, duration });
  }

  private limitsImpl(l: CameraLimits): void {
    const minZoom = l.minZoom ?? 0;
    const maxZoom = l.maxZoom ?? Infinity;
    if (!(minZoom >= 0) || !(maxZoom > 0) || minZoom > maxZoom || minZoom === Infinity) {
      throw new GraphError("invalid-argument", `camera.limits: need 0 <= minZoom <= maxZoom and maxZoom > 0, got ${minZoom} and ${maxZoom}`);
    }
    const bounds = l.bounds === undefined ? null : checkBounds(l.bounds, "camera.limits");
    this.send({ t: "limits", minZoom, maxZoom, bounds });
  }

  /** Releases the worker, the GPU device and every listener; safe to call twice. */
  destroy(): void {
    if (this.destroyed) return;
    this.debugOverlay?.destroy();
    this.send({ t: "destroy" });
    this.destroyed = true;
    for (const p of this.replies.values()) p.reject(new GraphError("destroyed", "Graph destroyed"));
    this.replies.clear();
    this.pointer.dispose();
    this.resizeObserver?.disconnect();
    // The worker closes itself after releasing the device; terminate as a backstop.
    setTimeout(() => this.worker.terminate(), 1000);
  }

  // ---- internals -----------------------------------------------------------------

  private overlay(): DebugOverlay {
    if (this.destroyed) throw new GraphError("destroyed", "Graph has been destroyed");
    if (!this.debugOverlay) {
      this.debugOverlay = new DebugOverlay(this.canvasEl, {
        caps: this.caps,
        send: (msg) => this.send(msg),
        readStats: (out) => this.stats(out),
        pixelRatio: () => this.pixelRatio,
      });
      const r = this.debugRing;
      if (r) this.debugOverlay.onRing(r.columns, r.gpuGroups, r.frames, r.buffer);
    }
    return this.debugOverlay;
  }

  private apiStart(): number {
    return this.debugOverlay?.timingApi ? performance.now() : 0;
  }

  private apiEnd(name: string, t0: number): void {
    this.debugOverlay?.apiCall(name, performance.now() - t0);
  }

  private send(msg: ToWorker, transfer?: Transferable[]): void {
    if (this.destroyed) throw new GraphError("destroyed", "Graph has been destroyed");
    this.worker.postMessage(msg, transfer ?? []);
  }

  private readonly onMessage = (ev: MessageEvent<FromWorker>): void => {
    const m = ev.data;
    switch (m.t) {
      case "error":
        this.emitError(errorFromCode(m.code, m.message));
        return;
      case "state":
        this.state.set(m.data);
        return;
      case "reply": {
        const p = this.replies.get(m.id);
        this.replies.delete(m.id);
        if (m.id === this.benchId) this.benchId = 0;
        if (m.code) p?.reject(errorFromCode(m.code, m.message ?? ""));
        else p?.resolve(m.value as never);
        return;
      }
      case "debugRing":
        this.debugRing = m;
        this.debugOverlay?.onRing(m.columns, m.gpuGroups, m.frames, m.buffer);
        return;
      case "debugRows":
        this.debugOverlay?.onRows(m.data);
        return;
      case "debugTotals":
        this.debugOverlay?.onTotals(m.messages);
        return;
      case "debugRecording":
        this.debugOverlay?.onRecording(m.columns, m.gpuGroups, m.data, m.rows, m.durationMs, m.messages);
        return;
      case "hover":
      case "click":
      case "doubleClick":
      case "contextMenu":
        for (const fn of this.listeners[m.t]) fn(m.hit);
        return;
      case "pan":
        for (const fn of this.listeners.pan) fn(m.event);
        return;
      case "zoom":
        for (const fn of this.listeners.zoom) fn(m.event);
        return;
      case "rotate":
        for (const fn of this.listeners.rotate) fn(m.event);
        return;
      case "dragStart": {
        const e = { index: m.index, nodes: m.nodes, x: m.x, y: m.y };
        for (const fn of this.listeners.dragStart) fn(e);
        return;
      }
      case "drag":
      case "dragEnd": {
        const e = { index: m.index, dx: m.dx, dy: m.dy };
        for (const fn of this.listeners[m.t]) fn(e);
        return;
      }
      case "select": {
        const e = { nodes: m.nodes, shape: m.shape, shift: m.shift, ctrl: m.ctrl, alt: m.alt, meta: m.meta };
        for (const fn of this.listeners.select) fn(e);
        return;
      }
      case "view": {
        if (this.listeners.view.size === 0) return;
        const v = this.cssView(m.x, m.y, m.zoom, m.rotation);
        for (const fn of this.listeners.view) fn(v);
        return;
      }
      case "edgesRemoved":
        this.onEdgesRemoved(m.id, m.edges);
        return;
      case "destroyed":
        this.worker.terminate();
        return;
    }
  };

  private readonly onResize = (entries: ResizeObserverEntry[]): void => {
    const e = entries[entries.length - 1]!;
    // The exact device-pixel box is only valid when rendering at the native ratio.
    const dp = this.pixelRatio === globalThis.devicePixelRatio ? e.devicePixelContentBoxSize?.[0] : undefined;
    const width = dp ? dp.inlineSize : Math.round(e.contentRect.width * this.pixelRatio);
    const height = dp ? dp.blockSize : Math.round(e.contentRect.height * this.pixelRatio);
    this.pointer.refreshRect();
    if (!this.destroyed) this.send({ t: "resize", width, height, pixelRatio: this.pixelRatio });
  };

  private emitError(err: GraphError): void {
    if (this.listeners.error.size === 0) console.error(err);
    for (const fn of this.listeners.error) fn(err);
  }
}

function canvasDeviceSize(canvas: HTMLCanvasElement, pixelRatio: number): { width: number; height: number } {
  const r = canvas.getBoundingClientRect();
  return { width: Math.max(1, Math.round(r.width * pixelRatio)), height: Math.max(1, Math.round(r.height * pixelRatio)) };
}

function iconList(icons: readonly IconSource[], name: string): IconSource[] {
  return icons.map((icon, i): IconSource => {
    if ("svg" in icon && typeof icon.svg === "string") return { svg: icon.svg };
    if ("path" in icon && (typeof icon.path === "string" || Array.isArray(icon.path))) {
      const viewBox = icon.viewBox ? ([...icon.viewBox] as [number, number, number, number]) : undefined;
      return { path: typeof icon.path === "string" ? icon.path : [...icon.path], viewBox, fillRule: icon.fillRule };
    }
    throw new GraphError("invalid-argument", `${name}: icon ${i} needs a "path" or an "svg"`);
  });
}

function asWords(colors: Uint32Array | Uint8Array, name: string): Uint32Array {
  if (colors instanceof Uint32Array) return colors;
  if (colors.byteOffset % 4 === 0 && colors.length % 4 === 0) {
    return new Uint32Array(colors.buffer, colors.byteOffset, colors.length / 4);
  }
  throw new GraphError("invalid-argument", `${name}: Uint8Array must be 4-byte aligned RGBA`);
}

function nodeArrays(data: NodeUpdate, n: number, opts: CopyOption | undefined, transfer: Transferable[], clampZ = false): NodeArrays {
  const zIndex = data.zIndex && take(data.zIndex, n, "zIndex", opts, transfer);
  const max = CONSTANTS.STYLE_ZLAYER_MASK;
  for (let i = 0; zIndex && i < zIndex.length; i++) {
    if (zIndex[i]! <= max) continue;
    if (!clampZ) throw new GraphError("invalid-argument", `zIndex: ${zIndex[i]} at ${i} is above ${max}`);
    zIndex[i] = max;
  }
  return {
    positions: data.positions && take(data.positions, n * 2, "positions", opts, transfer),
    colors: data.colors && take(asWords(data.colors, "colors"), n, "colors", opts, transfer),
    sizes: data.sizes && take(data.sizes, n, "sizes", opts, transfer),
    shapes: data.shapes && take(data.shapes, n, "shapes", opts, transfer),
    zIndex,
    icons: data.icons && take(data.icons, n, "icons", opts, transfer),
    iconColors: data.iconColors && take(asWords(data.iconColors, "iconColors"), n, "iconColors", opts, transfer),
  };
}

function edgeArrays(data: EdgeUpdate, n: number, opts: CopyOption | undefined, transfer: Transferable[]): EdgeArrays {
  return {
    indices: data.indices && take(data.indices, n * 2, "indices", opts, transfer),
    styles: data.styles && take(data.styles, n, "styles", opts, transfer),
    colors: data.colors && take(data.colors, n * 2, "colors", opts, transfer),
  };
}

function hasEdgeArrays(data: EdgeUpdate): boolean {
  return !!(data.indices || data.styles || data.colors);
}

function releaseImpl(slots: Slots, list: Uint32Array | number[], name: string): Uint32Array | null {
  checkAttached(list, `${name}: indices`);
  if (list.length === 0) return null;
  slots.check(list, name);
  const indices = Uint32Array.from(list);
  slots.release(indices);
  return indices;
}

function indexedUpdate(indices: Uint32Array, labels: unknown, arrays: boolean, name: string, opts: CopyOption | undefined, transfer: Transferable[]): Uint32Array | null {
  if (!(indices instanceof Uint32Array)) throw new GraphError("invalid-argument", `${name}: indices must be a Uint32Array`);
  if (labels === null) throw new GraphError("invalid-argument", `${name}: labels cannot be null; null only clears labels in ${name}All`);
  if (!arrays && labels === undefined) return null;
  const idx = take(indices, indices.length, "indices", opts, transfer);
  return idx.length > 0 ? idx : null;
}

function checkAttached(arr: unknown, name: string): void {
  if (arr instanceof Uint32Array && isDetached(arr.buffer)) throw new GraphError("detached-array", `${name} array is detached (it was transferred earlier)`);
}

function checkTune(t: DebugTune): DebugTune {
  for (const k of ["lodTargetPx", "edgeMaxOverdraw", "edgeMinLengthPx", "pickRate"] as const) {
    const v = t[k];
    const min = k === "pickRate" ? 1 : 0;
    if (v !== undefined && !(Number.isFinite(v) && v >= min)) throw new GraphError("invalid-argument", `debug.tune: ${k} must be a finite number >= ${min}, got ${v}`);
  }
  if (t.edgeMode !== undefined && !EDGE_DEBUG_MODES.includes(t.edgeMode)) throw new GraphError("invalid-argument", `debug.tune: edgeMode must be one of ${EDGE_DEBUG_MODES.join(", ")}, got ${String(t.edgeMode)}`);
  return t;
}

function remapIndices(indices: Uint32Array, remap: Uint32Array): Uint32Array {
  const out: number[] = [];
  for (let j = 0; j < indices.length; j++) {
    const r = remap[indices[j]!];
    if (r !== undefined && r !== NO_INDEX) out.push(r);
  }
  return Uint32Array.from(out);
}

function hasNodeArrays(data: NodeUpdate): boolean {
  return !!(data.positions || data.colors || data.sizes || data.shapes || data.zIndex || data.icons || data.iconColors);
}

function updateCount(data: NodeUpdate, name: string): number {
  const counts: number[] = [];
  if (data.positions) counts.push(data.positions.length / 2);
  if (data.colors) counts.push(data.colors instanceof Uint8Array ? data.colors.length / 4 : data.colors.length);
  if (data.sizes) counts.push(data.sizes.length);
  if (data.shapes) counts.push(data.shapes.length);
  if (data.zIndex) counts.push(data.zIndex.length);
  if (data.icons) counts.push(data.icons.length);
  if (data.iconColors) counts.push(data.iconColors instanceof Uint8Array ? data.iconColors.length / 4 : data.iconColors.length);
  if (data.labels) counts.push(data.labels.length);
  const n = counts[0] ?? 0;
  if (counts.some((c) => c !== n) || !Number.isInteger(n)) throw new GraphError("invalid-argument", `${name}: every array must cover the same nodes`);
  return n;
}

function convertLabels(labels: readonly (string | null | undefined)[], expected: number, name: string): string[] {
  if (labels.length !== expected) throw new GraphError("invalid-argument", `${name}: expected length ${expected}, got ${labels.length}`);
  return Array.from(labels, (s) => s ?? "");
}

function convertUpdateLabels(labels: readonly (string | null | undefined)[] | null | undefined, expected: number, name: string): string[] | null | undefined {
  if (labels === undefined) return undefined;
  if (labels === null) return null;
  return convertLabels(labels, expected, name);
}

function checkDuration(duration: number | undefined, name: string): number {
  if (duration === undefined) return 0;
  if (!Number.isFinite(duration) || duration < 0) throw new GraphError("invalid-argument", `${name}: duration must be a finite number of ms >= 0, got ${duration}`);
  return duration;
}

function checkBounds(b: WorldBounds, name: string): WorldBounds {
  const { minX, minY, maxX, maxY } = b;
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || minX > maxX || minY > maxY) {
    throw new GraphError("invalid-argument", `${name}: bounds need finite minX <= maxX and minY <= maxY`);
  }
  return { minX, minY, maxX, maxY };
}

function isDetached(buf: ArrayBufferLike): boolean {
  const d = (buf as ArrayBuffer & { detached?: boolean }).detached;
  return d === true;
}

/**
 * Validate length, then either copy or mark the backing buffer for transfer.
 * Transfer detaches the WHOLE backing buffer, including other views over it.
 */
function take<T extends Float32Array | Uint32Array | Uint16Array | Uint8Array>(arr: T, expected: number, name: string, opts: CopyOption | undefined, transfer: Transferable[]): T {
  if (isDetached(arr.buffer)) {
    throw new GraphError("detached-array", `${name}: array is detached (it was transferred earlier). Pass { copy: true } to keep using it.`);
  }
  if (arr.length !== expected) {
    throw new GraphError("invalid-argument", `${name}: expected length ${expected}, got ${arr.length}`);
  }
  if (opts?.copy) {
    const c = arr.slice() as T;
    transfer.push(c.buffer as ArrayBuffer);
    return c;
  }
  const isShared = typeof SharedArrayBuffer !== "undefined" && arr.buffer instanceof SharedArrayBuffer;
  if (!isShared && !transfer.includes(arr.buffer as ArrayBuffer)) transfer.push(arr.buffer as ArrayBuffer);
  return arr;
}
