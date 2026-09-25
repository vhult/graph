/**
 * Main-thread facade. Every setter is synchronous and cheap: it posts to
 * the render worker and returns. The main thread never touches the GPU.
 */
import { InputRing } from "../bridge/InputRing";
import { StreamSlots } from "../bridge/StreamSlots";
import type { FromWorker, ToWorker } from "../bridge/protocol";
import type { NodeArrays } from "../data/GraphStore";
import { createStateBuffer, STATE_SLOT } from "../bridge/SharedState";
import { DebugOverlay } from "./DebugOverlay";
import { errorFromCode, GraphError, UnsupportedError } from "./errors";
import { PointerInput, type InputSink } from "./PointerInput";
import type {
  BenchmarkOptions,
  BenchmarkResult,
  CameraView,
  CopyOption,
  DebugRecording,
  GraphCaps,
  GraphEvents,
  GraphOptions,
  GraphStats,
  LabelSnapshot,
  EdgeData,
  IconSource,
  NodeData,
  NodeStream,
  NodeStreamChannels,
  NodeUpdate,
  RGBA,
} from "./types";

const DEFAULT_BACKGROUND: RGBA = [0.04, 0.04, 0.06, 1];
/** Dim blue-grey: visible against the default background without fighting the nodes. */
const DEFAULT_EDGE_COLOR_RGBA: RGBA = [0.24, 0.27, 0.31, 0.4];
/** Sampled-node spacing, device px, chosen by eye in Storybook. */
const DEFAULT_LOD_TARGET_PX = 2.5;
/** How much crowded areas of edges are thinned: lower draws fewer edges. */
const DEFAULT_EDGE_MAX_OVERDRAW = 1.5;
/** CSS px: shorter edges do not read as lines. */
const DEFAULT_EDGE_MIN_LENGTH_PX = 6;
const DEFAULT_LABEL_SIZE = 12;
const DEFAULT_LABEL_PADDING = 2;
const DEFAULT_LABEL_FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const DEFAULT_FIT_PADDING = 24;
const DEFAULT_PICK_RATE = 60;
const DEFAULT_EDGE_PICK_RADIUS = 4;
const HOVER_WHITE: RGBA = [1, 1, 1, 1];
const DEFAULT_ICON_SCALE = 0.6;
const DEFAULT_ICON_MIN_PX = 6;

type Listener<K extends keyof GraphEvents> = (payload: GraphEvents[K]) => void;

export class Graph {
  /**
   * Create an engine bound to `canvas`. The canvas is transferred to a render
   * worker; afterwards it can no longer be drawn to from the main thread.
   */
  static async create(canvas: HTMLCanvasElement, options: GraphOptions = {}): Promise<Graph> {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      throw new UnsupportedError("webgpu-unavailable", "WebGPU is not available in this browser.");
    }
    if (typeof canvas.transferControlToOffscreen !== "function") {
      throw new UnsupportedError("offscreen-canvas-unavailable", "OffscreenCanvas is not supported in this browser.");
    }

    const shared = typeof SharedArrayBuffer !== "undefined" && globalThis.crossOriginIsolated === true;
    const ring = shared ? InputRing.create() : null;
    const state = createStateBuffer(shared);
    const pixelRatio = options.pixelRatio ?? globalThis.devicePixelRatio ?? 1;
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "vhult-graph" });

    const { width, height } = canvasDeviceSize(canvas, pixelRatio);
    const offscreen = canvas.transferControlToOffscreen();
    const init: ToWorker = {
      t: "init",
      canvas: offscreen,
      width,
      height,
      pixelRatio,
      ring: ring ? ring.buffer : null,
      state: shared ? (state.buffer as SharedArrayBuffer) : null,
      options: {
        background: options.background ?? DEFAULT_BACKGROUND,
        transparent: options.transparent ?? false,
        controls: options.controls ?? true,
        nodeScale: options.nodeScale ?? 1,
        edgeWidth: options.edgeWidth ?? 1,
        edgeColor: options.edgeColor ?? DEFAULT_EDGE_COLOR_RGBA,
        directedEdges: options.directedEdges ?? false,
        edgeMaxOverdraw: Math.max(0, options.edgeMaxOverdraw ?? DEFAULT_EDGE_MAX_OVERDRAW),
        edgeMinLengthPx: Math.max(0, options.edgeMinLengthPx ?? DEFAULT_EDGE_MIN_LENGTH_PX),
        edgeDebug: options.edgeDebug ?? "off",
        labelSize: Math.max(1, options.labelSize ?? DEFAULT_LABEL_SIZE),
        labelPadding: Math.max(0, options.labelPadding ?? DEFAULT_LABEL_PADDING),
        labelFont: options.labelFont ?? DEFAULT_LABEL_FONT,
        lodTargetPx: Math.max(0, options.lodTargetPx ?? DEFAULT_LOD_TARGET_PX),
        pickRate: Math.max(1, options.pickRate ?? DEFAULT_PICK_RATE),
        pickRadius: Math.max(0, options.pickRadius ?? 0),
        edgePickRadius: Math.max(0, options.edgePickRadius ?? DEFAULT_EDGE_PICK_RADIUS),
        hoverStyle:
          options.hoverStyle === false
            ? null
            : {
                nodeColor: options.hoverStyle?.nodeColor ?? HOVER_WHITE,
                nodeScale: Math.max(0, options.hoverStyle?.nodeScale ?? 1.25),
                edgeColor: options.hoverStyle?.edgeColor ?? HOVER_WHITE,
                edgeWidth: Math.max(0, options.hoverStyle?.edgeWidth ?? 2),
              },
        nodeDrag: options.nodeDrag ?? false,
        iconScale: Math.min(1, Math.max(0.01, options.iconScale ?? DEFAULT_ICON_SCALE)),
        iconMinPx: Math.max(0, options.iconMinPx ?? DEFAULT_ICON_MIN_PX),
        timeOrigin: performance.timeOrigin,
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

    return new Graph(canvas, worker, caps, ring, state, pixelRatio, options.autoResize ?? true);
  }

  readonly camera = {
    /** Fit all nodes in view, `padding` in CSS px. */
    fit: (padding = DEFAULT_FIT_PADDING): void => this.send({ t: "fit", padding }),
    setView: (view: Partial<CameraView>): void => this.send({ t: "view", view }),
    /** Last view rendered by the worker (≤ 1 frame stale). */
    getView: (): CameraView => ({
      x: this.state[STATE_SLOT.CAMERA_X]!,
      y: this.state[STATE_SLOT.CAMERA_Y]!,
      zoom: this.state[STATE_SLOT.CAMERA_ZOOM]!,
      rotation: this.state[STATE_SLOT.CAMERA_ROTATION]!,
    }),
  };

  readonly debug = {
    open: (): void => this.overlay().show(),
    close: (): void => this.debugOverlay?.hide(),
    toggle: (): void => (this.debugOverlay?.open ? this.debugOverlay.hide() : this.overlay().show()),
    isOpen: (): boolean => this.debugOverlay?.open ?? false,
    expand: (expanded = true): void => this.overlay().setExpanded(expanded),
    record: (): Promise<DebugRecording> => (this.destroyed ? Promise.reject(new GraphError("destroyed", "Graph destroyed")) : this.overlay().record()),
    stop: (): void => this.debugOverlay?.stopRecord(),
  };

  private debugOverlay: DebugOverlay | null = null;
  private debugRing: Extract<FromWorker, { t: "debugRing" }> | null = null;
  private nodeCount = 0;
  private edgeCount = 0;
  private destroyed = false;
  private benchSeq = 0;
  private benchPending: { id: number; resolve: (r: BenchmarkResult) => void; reject: (e: Error) => void } | null = null;
  private readonly snapshotPending = new Map<number, { resolve: (s: LabelSnapshot) => void; reject: (e: Error) => void }>();
  private readonly iconsPending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private readonly listeners: { [K in keyof GraphEvents]: Set<Listener<K>> } = {
    error: new Set(),
    nodeHover: new Set(),
    edgeHover: new Set(),
    nodeClick: new Set(),
    edgeClick: new Set(),
    nodeDragStart: new Set(),
    nodeDrag: new Set(),
    nodeDragEnd: new Set(),
  };
  private pickHover = 0;
  private pickClick = 0;
  private pickDrag = false;
  private readonly pointer: PointerInput;
  private readonly resizeObserver: ResizeObserver | null = null;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly worker: Worker,
    readonly caps: GraphCaps,
    private readonly ring: InputRing | null,
    private readonly state: Float64Array,
    private pixelRatio: number,
    autoResize: boolean,
  ) {
    worker.onmessage = this.onMessage;
    worker.onerror = (ev) => this.emitError(new GraphError("internal", ev.message));

    const sink: InputSink = ring
      ? (type, t, x, y, dx, dy, buttons, mods) => {
          ring.push(type, t, x, y, dx, dy, buttons, mods);
          if (ring.claimWake()) this.worker.postMessage({ t: "wake" } satisfies ToWorker);
        }
      : (type, t, x, y, dx, dy, buttons, mods) => this.send({ t: "input", r: [type, t, x, y, dx, dy, buttons, mods] });
    this.pointer = new PointerInput(canvas, sink, () => this.pixelRatio);

    if (autoResize && typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onResize);
      try {
        this.resizeObserver.observe(canvas, { box: "device-pixel-content-box" });
      } catch {
        this.resizeObserver.observe(canvas);
      }
    }
  }

  // ---- data ---------------------------------------------------------------------

  /** Bulk-load nodes. The fastest path: arrays are transferred, uploaded via mappedAtCreation. */
  setNodes(data: NodeData, opts?: CopyOption): void {
    const t0 = this.apiStart();
    const n = data.count;
    if (!Number.isInteger(n) || n < 0) throw new GraphError("invalid-argument", "setNodes: count must be a non-negative integer");
    const transfer: Transferable[] = [];
    const positions = data.positions && take(data.positions, n * 2, "positions", opts, transfer);
    this.nodeCount = n;
    this.send({ t: "nodes", count: n, ...nodeArrays(data, n, opts, transfer) }, transfer);
    if (t0) this.apiEnd("setNodes", t0);
  }

  updateNodes(start: number, data: NodeUpdate, opts?: CopyOption): void {
    const n = updateCount(data);
    if (n === 0) return;
    if (!Number.isInteger(start) || start < 0 || start + n > this.nodeCount) {
      throw new GraphError("invalid-argument", "updateNodes: range exceeds node count");
    }
    const t0 = this.apiStart();
    const transfer: Transferable[] = [];
    this.send({ t: "updateNodes", start, ...nodeArrays(data, n, opts, transfer) }, transfer);
    if (t0) this.apiEnd("updateNodes", t0);
  }

  /**
   * Bulk-load edges. `indices` holds source/target NODE INDICES interleaved.
   *
   * Edges are tied to the node indices that were current when they were set:
   * a later `setNodes` that changes the node count invalidates them, so set
   * nodes first, then edges.
   */
  setEdges(data: EdgeData, opts?: CopyOption): void {
    const t0 = this.apiStart();
    const n = data.count;
    if (!Number.isInteger(n) || n < 0) throw new GraphError("invalid-argument", "setEdges: count must be a non-negative integer");
    const transfer: Transferable[] = [];
    const indices = data.indices && take(data.indices, n * 2, "indices", opts, transfer);
    const styles = data.styles && take(data.styles, n, "styles", opts, transfer);
    const colors = data.colors && take(data.colors, n * 2, "colors", opts, transfer);
    this.edgeCount = n;
    this.send({ t: "edges", count: n, indices, styles, colors }, transfer);
    if (t0) this.apiEnd("setEdges", t0);
  }

  /**
   * Label text per node, in the order of `setNodes` (empty or missing = no
   * label). Only as many as fit are shown, bigger nodes first. Pass `[]` to
   * remove every node label.
   */
  setNodeLabels(labels: readonly (string | null | undefined)[]): void {
    const t0 = this.apiStart();
    this.send({ t: "nodeLabels", labels: Array.from(labels, (s) => s ?? "") });
    if (t0) this.apiEnd("setNodeLabels", t0);
  }

  /**
   * Label text per edge, in the order of `setEdges`. An edge label is shown
   * only where its text fits along the edge and overlaps no other label. Pass
   * `[]` to remove every edge label.
   */
  setEdgeLabels(labels: readonly (string | null | undefined)[]): void {
    const t0 = this.apiStart();
    this.send({ t: "edgeLabels", labels: Array.from(labels, (s) => s ?? "") });
    if (t0) this.apiEnd("setEdgeLabels", t0);
  }

  /** Change the node count; existing data is preserved prefix-wise, new nodes get defaults. */
  setNodeCount(count: number): void {
    this.setNodes({ count });
  }

  setNodePositions(positions: Float32Array, opts?: CopyOption): void {
    this.setNodes({ count: this.nodeCount, positions }, opts);
  }

  setNodeColors(colors: Uint32Array | Uint8Array, opts?: CopyOption): void {
    this.setNodes({ count: this.nodeCount, colors }, opts);
  }

  setNodeSizes(sizes: Float32Array, opts?: CopyOption): void {
    this.setNodes({ count: this.nodeCount, sizes }, opts);
  }

  setNodeShapes(shapes: Uint8Array, opts?: CopyOption): void {
    this.setNodes({ count: this.nodeCount, shapes }, opts);
  }

  setNodeZIndex(zIndex: Uint8Array, opts?: CopyOption): void {
    this.setNodes({ count: this.nodeCount, zIndex }, opts);
  }

  defineIcons(icons: readonly IconSource[]): Promise<void> {
    if (this.destroyed) return Promise.reject(new GraphError("destroyed", "Graph destroyed"));
    const t0 = this.apiStart();
    const list = icons.map((icon, i): IconSource => {
      if ("svg" in icon && typeof icon.svg === "string") return { svg: icon.svg };
      if ("path" in icon && (typeof icon.path === "string" || Array.isArray(icon.path))) {
        const viewBox = icon.viewBox ? ([...icon.viewBox] as [number, number, number, number]) : undefined;
        return { path: typeof icon.path === "string" ? icon.path : [...icon.path], viewBox, fillRule: icon.fillRule };
      }
      throw new GraphError("invalid-argument", `defineIcons: icon ${i} needs a "path" or an "svg"`);
    });
    const id = ++this.benchSeq;
    const done = new Promise<void>((resolve, reject) => this.iconsPending.set(id, { resolve, reject }));
    this.send({ t: "defineIcons", id, icons: list });
    if (t0) this.apiEnd("defineIcons", t0);
    return done;
  }

  setNodeIcons(icons: Uint16Array, opts?: CopyOption): void {
    this.setNodes({ count: this.nodeCount, icons }, opts);
  }

  setNodeIconColors(colors: Uint32Array | Uint8Array, opts?: CopyOption): void {
    this.setNodes({ count: this.nodeCount, iconColors: colors }, opts);
  }

  streamNodes(channels: NodeStreamChannels): NodeStream {
    const count = this.nodeCount;
    const positions = channels.positions === true;
    const colors = channels.colors === true;
    const zIndex = channels.zIndex === true;
    const ring = this.ring;
    if (!ring) {
      const p = new Float32Array(positions ? count * 2 : 0);
      const c = new Uint32Array(colors ? count : 0);
      const z = new Uint8Array(zIndex ? count : 0);
      const commit = (): void => {
        this.updateNodes(0, { positions: positions ? p : undefined, colors: colors ? c : undefined, zIndex: zIndex ? z : undefined }, { copy: true });
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
        slots.commit();
        if (ring.claimWake()) this.worker.postMessage({ t: "wake" } satisfies ToWorker);
      },
    };
  }

  // ---- style ---------------------------------------------------------------------

  setBackground(rgba: RGBA): void {
    this.send({ t: "background", rgba });
  }

  setNodeScale(value: number): void {
    this.send({ t: "nodeScale", value });
  }

  setNodeDrag(enabled: boolean): void {
    this.send({ t: "nodeDrag", on: enabled });
  }

  // ---- lifecycle -----------------------------------------------------------------

  /** Manual resize in CSS px (only needed with `autoResize: false`). */
  resize(cssWidth: number, cssHeight: number): void {
    this.send({ t: "resize", width: cssWidth * this.pixelRatio, height: cssHeight * this.pixelRatio, pixelRatio: this.pixelRatio });
  }

  /** Force one frame, e.g. for external animation drivers. */
  requestRender(): void {
    this.send({ t: "render" });
  }

  /**
   * Play a camera path one step per rendered frame and record per-frame CPU,
   * GPU (total and per pass), frame interval and visible counts. Frame N always
   * shows the same view, so runs are comparable across machines and commits.
   * Rendering is continuous while it runs; one benchmark at a time.
   */
  benchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
    if (this.benchPending) return Promise.reject(new GraphError("invalid-argument", "A benchmark is already running"));
    if (options.path.length === 0 || !(options.frames > 0)) {
      return Promise.reject(new GraphError("invalid-argument", "benchmark: path needs ≥ 1 key and frames > 0"));
    }
    const id = ++this.benchSeq;
    return new Promise<BenchmarkResult>((resolve, reject) => {
      this.benchPending = { id, resolve, reject };
      this.send({ t: "benchmark", id, options: { path: options.path.map((k) => ({ ...k })), frames: options.frames, warmup: options.warmup, timing: options.timing } });
    });
  }

  /** Candidates and decisions of the next label placement. */
  readLabelSnapshot(): Promise<LabelSnapshot> {
    if (this.destroyed) return Promise.reject(new GraphError("destroyed", "Graph destroyed"));
    const id = ++this.benchSeq;
    return new Promise<LabelSnapshot>((resolve, reject) => {
      this.snapshotPending.set(id, { resolve, reject });
      this.send({ t: "labelSnapshot", id });
    });
  }

  /** Copy the latest frame stats into `out` (allocation-free when `out` is reused). */
  readStats(out: GraphStats = {} as GraphStats): GraphStats {
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

  on<K extends keyof GraphEvents>(event: K, fn: Listener<K>): () => void {
    this.listeners[event].add(fn);
    this.syncPicking();
    return () => {
      this.listeners[event].delete(fn);
      this.syncPicking();
    };
  }

  private syncPicking(): void {
    const l = this.listeners;
    const hover = (l.nodeHover.size > 0 ? 1 : 0) | (l.edgeHover.size > 0 ? 2 : 0);
    const click = (l.nodeClick.size > 0 ? 1 : 0) | (l.edgeClick.size > 0 ? 2 : 0);
    const drag = l.nodeDragStart.size > 0 || l.nodeDrag.size > 0 || l.nodeDragEnd.size > 0;
    if (this.destroyed || (hover === this.pickHover && click === this.pickClick && drag === this.pickDrag)) return;
    this.pickHover = hover;
    this.pickClick = click;
    this.pickDrag = drag;
    this.send({ t: "pick", hover, click, drag });
  }

  /** Release the worker, the GPU device and all listeners. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.debugOverlay?.destroy();
    this.send({ t: "destroy" });
    this.destroyed = true;
    this.benchPending?.reject(new GraphError("destroyed", "Graph destroyed during benchmark"));
    this.benchPending = null;
    for (const p of this.snapshotPending.values()) p.reject(new GraphError("destroyed", "Graph destroyed"));
    this.snapshotPending.clear();
    for (const p of this.iconsPending.values()) p.reject(new GraphError("destroyed", "Graph destroyed"));
    this.iconsPending.clear();
    this.pointer.dispose();
    this.resizeObserver?.disconnect();
    // The worker closes itself after releasing the device; terminate as a backstop.
    setTimeout(() => this.worker.terminate(), 1000);
  }

  // ---- internals -----------------------------------------------------------------

  private overlay(): DebugOverlay {
    if (this.destroyed) throw new GraphError("destroyed", "Graph has been destroyed");
    if (!this.debugOverlay) {
      this.debugOverlay = new DebugOverlay(this.canvas, {
        caps: this.caps,
        send: (msg) => this.send(msg),
        readStats: (out) => this.readStats(out),
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
      case "benchmark": {
        const p = this.benchPending;
        if (p && p.id === m.id) {
          this.benchPending = null;
          p.resolve(m.result);
        }
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
        if (m.node !== undefined) for (const fn of this.listeners.nodeHover) fn(m.node < 0 ? null : m.node);
        if (m.edge !== undefined) for (const fn of this.listeners.edgeHover) fn(m.edge < 0 ? null : m.edge);
        return;
      case "click":
        if (m.node !== undefined) for (const fn of this.listeners.nodeClick) fn(m.node < 0 ? null : m.node);
        if (m.edge !== undefined) for (const fn of this.listeners.edgeClick) fn(m.edge < 0 ? null : m.edge);
        return;
      case "drag": {
        const e = { index: m.index, x: m.x, y: m.y };
        for (const fn of this.listeners[m.event]) fn(e);
        return;
      }
      case "defineIcons": {
        const p = this.iconsPending.get(m.id);
        this.iconsPending.delete(m.id);
        if (m.code) p?.reject(errorFromCode(m.code, m.message ?? ""));
        else p?.resolve();
        return;
      }
      case "labelSnapshot": {
        const p = this.snapshotPending.get(m.id);
        this.snapshotPending.delete(m.id);
        p?.resolve(m.snapshot);
        return;
      }
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

  private emitError(err: Error): void {
    if (this.listeners.error.size === 0) console.error(err);
    for (const fn of this.listeners.error) fn(err);
  }
}

function canvasDeviceSize(canvas: HTMLCanvasElement, pixelRatio: number): { width: number; height: number } {
  const r = canvas.getBoundingClientRect();
  return { width: Math.max(1, Math.round(r.width * pixelRatio)), height: Math.max(1, Math.round(r.height * pixelRatio)) };
}

function asWords(colors: Uint32Array | Uint8Array, name: string): Uint32Array {
  if (colors instanceof Uint32Array) return colors;
  if (colors.byteOffset % 4 === 0 && colors.length % 4 === 0) {
    return new Uint32Array(colors.buffer, colors.byteOffset, colors.length / 4);
  }
  throw new GraphError("invalid-argument", `${name}: Uint8Array must be 4-byte aligned RGBA`);
}

function nodeArrays(data: NodeUpdate, n: number, opts: CopyOption | undefined, transfer: Transferable[]): NodeArrays {
  return {
    positions: data.positions && take(data.positions, n * 2, "positions", opts, transfer),
    colors: data.colors && take(asWords(data.colors, "colors"), n, "colors", opts, transfer),
    sizes: data.sizes && take(data.sizes, n, "sizes", opts, transfer),
    shapes: data.shapes && take(data.shapes, n, "shapes", opts, transfer),
    zIndex: data.zIndex && take(data.zIndex, n, "zIndex", opts, transfer),
    icons: data.icons && take(data.icons, n, "icons", opts, transfer),
    iconColors: data.iconColors && take(asWords(data.iconColors, "iconColors"), n, "iconColors", opts, transfer),
  };
}

function updateCount(data: NodeUpdate): number {
  const counts: number[] = [];
  if (data.positions) counts.push(data.positions.length / 2);
  if (data.colors) counts.push(data.colors instanceof Uint8Array ? data.colors.length / 4 : data.colors.length);
  if (data.sizes) counts.push(data.sizes.length);
  if (data.shapes) counts.push(data.shapes.length);
  if (data.zIndex) counts.push(data.zIndex.length);
  if (data.icons) counts.push(data.icons.length);
  if (data.iconColors) counts.push(data.iconColors instanceof Uint8Array ? data.iconColors.length / 4 : data.iconColors.length);
  const n = counts[0] ?? 0;
  if (counts.some((c) => c !== n) || !Number.isInteger(n)) throw new GraphError("invalid-argument", "updateNodes: every array must cover the same nodes");
  return n;
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
