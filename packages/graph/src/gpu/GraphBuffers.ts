/**
 * GPU residency of the graph data (@group(1)) and every path that writes it.
 *
 * Node buffers are kept in ENGINE order (Morton order after the first sort) so
 * every per-frame pass reads spatially coherent memory. Two tables map between
 * orders: `order[engine] = user`, `rank[user] = engine`. The CPU never needs them:
 *
 * - Bulk load (node count changed): upload in user order via `mappedAtCreation`,
 *   order/rank = identity, then SORT permutes on the GPU.
 * - Whole-channel replace (same count): upload in user order to a temp buffer,
 *   GPU-gather it into engine order.
 * - Partial updates: per-range writeBuffer into a staging buffer, then one
 *   scatter_update dispatch through `rank` per channel. Never a full re-upload.
 *
 * Edge channels are uploaded in the user's order;
 * EDGE_SORT then turns them into engine-indexed, sorted buffers in place
 * (`adoptSortedEdges`). A node re-sort renumbers the nodes, so it re-uploads
 * the edges from the CPU mirror and they are sorted again from scratch.
 *
 * Buffers replaced during a frame are retired and destroyed after submit.
 */
import type { Channel, GraphStore } from "../data/GraphStore";
import { CONSTANTS, GRAPH_BINDINGS, GRAPH_BUFFER_WORDS, type GraphBufferName } from "../data/Layouts";
import type { LayerSlot, PermuteKernels, ScatterSlot } from "./PermuteKernels";

/** Smallest buffer we create: bindings need non-zero size, vec2 arrays need ≥ 8 B. */
const MIN_BUFFER_BYTES = 16;

export const NODE_CHANNELS = ["nodePos", "nodeStyle", "nodeSize", "nodeColor", "nodeState"] as const satisfies readonly GraphBufferName[];
export type NodeChannel = (typeof NODE_CHANNELS)[number];
const isNodeChannel = (n: GraphBufferName): n is NodeChannel => (NODE_CHANNELS as readonly string[]).includes(n);
const SCATTER_CHANNELS = [...NODE_CHANNELS, "edgeStyle", "edgeColor"] as const satisfies readonly GraphBufferName[];
const STREAM_CHANNELS = ["nodePos", "nodeColor"] as const satisfies readonly NodeChannel[];
type StreamChannel = (typeof STREAM_CHANNELS)[number];
const JOB_NODE = 0;
const JOB_EDGE = 1;
const JOB_EDGE_STATE = 2;
const EDGE_STATE_TOP = ~CONSTANTS.EDGE_END_MASK;

const USAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

interface ScatterJob {
  readonly name: GraphBufferName;
  readonly slot: ScatterSlot;
  readonly kind: number;
  total: number;
  ranges: number;
}

const queued = (ch: Channel): boolean => !ch.dirty.isEmpty || ch.scattered.count > 0;

export class GraphBuffers {
  readonly buffers = {} as Record<GraphBufferName, GPUBuffer>;
  /** order[engine index] = user index. */
  order!: GPUBuffer;
  /** rank[user index] = engine index. */
  rank!: GPUBuffer;
  /** @group(1) bind group; rebuilt whenever a buffer is swapped. */
  bindGroup!: GPUBindGroup;
  /** Node positions changed wholesale: engine order must be rebuilt by SORT. */
  needsSort = false;
  /** Edge channels hold the user's order (fresh upload): EDGE_SORT must run. */
  edgesUnsorted = false;
  /**
   * edgeOrder[sorted edge] = the user's edge index, kept from the last EDGE_SORT
   * while edge labels need it (their text is in the user's order); else null.
   */
  edgeOrder: GPUBuffer | null = null;
  /** Keep `edgeOrder` at the next sort (set by the engine). */
  keepEdgeOrder = false;
  edgeRank: GPUBuffer | null = null;
  restyledEdges = 0;
  restyledStates = 0;
  /** Bytes uploaded by the last flush. */
  lastUploadBytes = 0;

  private nodeCount = -1;
  private orderIsIdentity = true;
  private readonly gathers: { name: NodeChannel; userOrder: GPUBuffer }[] = [];
  private readonly jobs: Partial<Record<GraphBufferName, ScatterJob>>;
  private readonly streams: Record<StreamChannel, ScatterJob>;
  private readonly stateJob: ScatterJob;
  private readonly queue: readonly ScatterJob[];
  private invertEdges = false;
  private readonly layerSlot: LayerSlot;
  private layerJob = 0;
  private rangeScratch = new Uint32Array(128);
  private valueScratch = new Uint32Array(64);
  private valueScratchF32 = new Float32Array(this.valueScratch.buffer);
  private readonly retired: GPUBuffer[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    private readonly store: GraphStore,
    private readonly kernels: PermuteKernels,
  ) {
    const job = (name: GraphBufferName, label: string, kind: number): ScatterJob => ({ name, slot: kernels.createScatterSlot(label), kind, total: 0, ranges: 0 });
    this.streams = Object.fromEntries(STREAM_CHANNELS.map((n) => [n, job(n, `${n}/stream`, JOB_NODE)])) as Record<StreamChannel, ScatterJob>;
    this.jobs = Object.fromEntries(SCATTER_CHANNELS.map((n) => [n, job(n, n, isNodeChannel(n) ? JOB_NODE : JOB_EDGE)]));
    this.stateJob = job("edgeIdx", "edgeState", JOB_EDGE_STATE);
    this.queue = [...Object.values(this.streams), ...Object.values(this.jobs), this.stateJob];
    this.layerSlot = kernels.createLayerSlot();
  }

  /** GPU work queued by `flush` that must be encoded this frame. */
  get hasPendingWork(): boolean {
    if (this.gathers.length > 0 || this.layerJob > 0 || this.invertEdges) return true;
    for (const s of this.queue) if (s.total > 0) return true;
    return false;
  }

  /** CPU side of the upload: create/fill buffers and stage partial updates. */
  flush(): boolean {
    this.restyledEdges = 0;
    this.restyledStates = 0;
    if (!this.store.dirty) return false;
    const store = this.store;
    let bytes = 0;
    let rebind = false;

    if (store.nodeCount !== this.nodeCount) {
      // Topology change: every node channel arrives in user order.
      this.nodeCount = store.nodeCount;
      this.retire(this.order, this.rank);
      this.order = this.identity("order", this.nodeCount);
      this.rank = this.identity("rank", this.nodeCount);
      this.orderIsIdentity = true;
      this.needsSort = this.nodeCount > 0;
      bytes += this.nodeCount * 8;
    }
    // A sort is coming (topology, or positions replaced wholesale): the edges on
    // the GPU are indexed by the old numbering, so bring back the user's copy.
    if ((this.needsSort || store.channels.nodePos.realloc) && store.edgeCount > 0) store.reloadEdges();
    this.prepareEdgeWrites();

    for (const b of GRAPH_BINDINGS) {
      const name = b.name;
      const ch = store.channels[name];
      if (ch.realloc) {
        const filled = this.createFilled(name, ch.data, name === "edgeIdx" ? store.edgeState : null);
        bytes += ch.data.byteLength;
        if (isNodeChannel(name) && !this.orderIsIdentity) {
          this.gathers.push({ name, userOrder: filled }); // permuted on the GPU in encode()
        } else {
          this.retire(this.buffers[name]);
          this.buffers[name] = filled;
          rebind = true;
        }
        if (name === "nodePos") this.needsSort = this.nodeCount > 0;
        if (name === "edgeIdx") {
          this.edgesUnsorted = true;
          store.edgeStateChannel.dirty.clear();
          store.edgeStateChannel.scattered.clear();
        }
        ch.realloc = false;
        ch.dirty.clear();
        ch.scattered.clear();
        continue;
      }
      const job = this.jobs[name];
      if (job) bytes += this.stage(ch, job);
    }
    bytes += this.stage(store.edgeStateChannel, this.stateJob);
    this.restyledEdges = this.jobs.edgeStyle!.total;
    this.restyledStates = this.stateJob.total;

    if (rebind || !this.bindGroup) this.rebind();
    store.markClean();
    this.lastUploadBytes = bytes;
    return true;
  }

  /** GPU side of the upload: permute replaced channels, apply partial updates. */
  encode(pass: GPUComputePassEncoder): void {
    for (const g of this.gathers) {
      const words = GRAPH_BUFFER_WORDS[g.name];
      const dst = this.device.createBuffer({ label: g.name, size: g.userOrder.size, usage: USAGE });
      const params = this.kernels.gather(pass, this.order, g.userOrder, dst, this.nodeCount, words);
      this.retire(g.userOrder, this.buffers[g.name], params);
      this.buffers[g.name] = dst;
    }
    if (this.gathers.length > 0) this.rebind();
    this.gathers.length = 0;

    if (this.invertEdges) {
      this.invertEdges = false;
      if (this.edgeOrder && this.edgeRank) this.retire(this.kernels.invert(pass, this.edgeOrder, this.edgeRank, this.store.edgeCount));
    }
    for (const s of this.queue) {
      if (s.total === 0) continue;
      const rank = s.kind === JOB_NODE ? this.rank : this.edgeRank!;
      this.kernels.scatter(pass, s.slot, rank, this.buffers[s.name], s.total, s.ranges, GRAPH_BUFFER_WORDS[s.name], s.kind === JOB_EDGE_STATE);
      s.total = 0;
    }

    if (this.layerJob > 0) {
      this.kernels.mergeLayers(pass, this.layerSlot, this.order, this.buffers.nodeStyle, this.layerJob);
      this.layerJob = 0;
    }
  }

  /**
   * Re-order every node channel by `perm` (perm[newEngine] = oldEngine) and
   * update order/rank. Called by SORT inside its compute pass.
   */
  permute(pass: GPUComputePassEncoder, perm: GPUBuffer): void {
    const n = this.nodeCount;
    for (const name of NODE_CHANNELS) {
      const src = this.buffers[name];
      const dst = this.device.createBuffer({ label: name, size: src.size, usage: USAGE });
      const params = this.kernels.gather(pass, perm, src, dst, n, GRAPH_BUFFER_WORDS[name]);
      this.retire(src, params);
      this.buffers[name] = dst;
    }
    const order = this.device.createBuffer({ label: "order", size: this.order.size, usage: USAGE });
    const rank = this.device.createBuffer({ label: "rank", size: this.rank.size, usage: USAGE });
    const params = this.kernels.compose(pass, perm, this.order, order, rank, n);
    this.retire(this.order, this.rank, params);
    this.order = order;
    this.rank = rank;
    this.orderIsIdentity = false;
    this.needsSort = false;
    this.rebind();
  }

  /**
   * Replace the edge channels with their sorted form: `edgeIdx` gathered from
   * `engineIdx` (engine endpoints, user order), styles and colours gathered
   * from themselves, all through `perm` (perm[sorted] = user). Channels the
   * user never supplied stay as their placeholder.
   */
  adoptSortedEdges(pass: GPUComputePassEncoder, perm: GPUBuffer, engineIdx: GPUBuffer, edgeCount: number): void {
    const jobs: [GraphBufferName, GPUBuffer][] = [["edgeIdx", engineIdx]];
    if (this.store.hasEdgeStyles) jobs.push(["edgeStyle", this.buffers.edgeStyle]);
    if (this.store.hasEdgeColors) jobs.push(["edgeColor", this.buffers.edgeColor]);
    for (const [name, src] of jobs) {
      const dst = this.device.createBuffer({ label: name, size: src.size, usage: USAGE });
      const params = this.kernels.gather(pass, perm, src, dst, edgeCount, GRAPH_BUFFER_WORDS[name]);
      this.retire(this.buffers[name], params);
      this.buffers[name] = dst;
    }
    if (this.store.edgeRankWanted) {
      const rank = this.device.createBuffer({ label: "edgeRank", size: Math.max(MIN_BUFFER_BYTES, edgeCount * 4), usage: GPUBufferUsage.STORAGE });
      this.retire(this.edgeRank ?? undefined, this.kernels.invert(pass, perm, rank, edgeCount));
      this.edgeRank = rank;
    }
    this.invertEdges = false;
    this.edgesUnsorted = false;
    this.rebind();
  }

  /** Replace the kept edge order (null drops it). */
  setEdgeOrder(order: GPUBuffer | null): void {
    if (order !== this.edgeOrder) this.retire(this.edgeOrder ?? undefined);
    this.edgeOrder = order;
  }

  /** Queue buffers used by this frame's commands for destruction after submit. */
  retireAfterSubmit(...buffers: GPUBuffer[]): void {
    this.retire(...buffers);
  }

  /** Destroy buffers replaced during the frame. Call after `queue.submit`. */
  afterSubmit(): void {
    for (const b of this.retired) b.destroy();
    this.retired.length = 0;
  }

  destroy(): void {
    this.layerSlot.params.destroy();
    this.layerSlot.upload?.destroy();
    this.afterSubmit();
    for (const b of GRAPH_BINDINGS) this.buffers[b.name]?.destroy();
    this.order?.destroy();
    this.rank?.destroy();
    this.edgeOrder?.destroy();
    this.edgeRank?.destroy();
    for (const { slot } of this.queue) {
      slot.params.destroy();
      slot.ranges.destroy();
      slot.upload?.destroy();
    }
  }

  // ---- internals ----------------------------------------------------------------

  get restyleSlot(): ScatterSlot {
    return this.jobs.edgeStyle!.slot;
  }

  get stateSlot(): ScatterSlot {
    return this.stateJob.slot;
  }

  canStream(name: NodeChannel, count: number): boolean {
    const ch = this.store.channels[name];
    return this.nodeCount === count && !ch.realloc && !queued(ch);
  }

  streamLayers(words: Uint32Array): number {
    const slot = this.layerSlot;
    if (!slot.upload || slot.upload.size < words.byteLength) {
      if (slot.upload) this.retire(slot.upload);
      slot.upload = this.device.createBuffer({ label: "layers/upload", size: Math.max(MIN_BUFFER_BYTES, Math.ceil((words.byteLength * 1.5) / 16) * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    this.device.queue.writeBuffer(slot.upload, 0, words);
    this.layerJob = this.nodeCount;
    return words.byteLength;
  }

  streamChannel(name: StreamChannel, data: Float32Array | Uint32Array): number {
    const job = this.streams[name];
    const queue = this.device.queue;
    queue.writeBuffer(this.reserve(job.slot, "upload", data.byteLength), 0, data);
    this.rangeScratch[0] = 0;
    this.rangeScratch[1] = 0;
    queue.writeBuffer(job.slot.ranges, 0, this.rangeScratch, 0, 2);
    job.total = data.length / GRAPH_BUFFER_WORDS[name];
    job.ranges = 1;
    return data.byteLength + 8;
  }

  private reserve(slot: ScatterSlot, key: "upload" | "ranges", bytes: number): GPUBuffer {
    const current = slot[key];
    if (current && current.size >= bytes) return current;
    if (current) this.retire(current);
    const size = Math.max(MIN_BUFFER_BYTES, 2 ** Math.ceil(Math.log2(Math.max(1, bytes))));
    const buffer = this.device.createBuffer({ label: `${slot.label}/${key}`, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    slot[key] = buffer;
    return buffer;
  }

  private prepareEdgeWrites(): void {
    const store = this.store;
    if (!store.edgeRankWanted && this.edgeRank) {
      this.retire(this.edgeRank);
      this.edgeRank = null;
    }
    const ch = store.channels;
    const pending = queued(ch.edgeStyle) || queued(ch.edgeColor) || queued(store.edgeStateChannel);
    if (!pending || store.edgeCount === 0 || ch.edgeIdx.realloc || (this.edgeRank && !this.edgesUnsorted)) return;
    if (this.edgesUnsorted || !this.edgeOrder) {
      store.reloadEdges();
      return;
    }
    this.edgeRank = this.device.createBuffer({ label: "edgeRank", size: Math.max(MIN_BUFFER_BYTES, store.edgeCount * 4), usage: GPUBufferUsage.STORAGE });
    this.invertEdges = true;
  }

  private stage(ch: Channel, job: ScatterJob): number {
    if (!queued(ch)) return 0;
    const d = ch.dirty;
    const list = ch.scattered;
    if (job.kind !== JOB_NODE && !this.edgeRank) {
      d.clear();
      list.clear();
      return 0;
    }
    const w = ch.words;
    const n = list.count;
    const ranges = d.count + n;
    if (this.rangeScratch.length < ranges * 2) this.rangeScratch = new Uint32Array(Math.max(ranges * 2, this.rangeScratch.length * 2));
    const table = this.rangeScratch;
    let prefix = 0;
    for (let r = 0; r < d.count; r++) {
      table[r * 2] = d.start(r);
      table[r * 2 + 1] = prefix;
      prefix += d.end(r) - d.start(r);
    }
    const upload = this.reserve(job.slot, "upload", (prefix + n) * w * 4);
    const queue = this.device.queue;
    for (let r = 0; r < d.count; r++) queue.writeBuffer(upload, table[r * 2 + 1]! * w * 4, ch.data, d.start(r) * w, (d.end(r) - d.start(r)) * w);
    if (n > 0) {
      if (this.valueScratch.length < n * w) {
        this.valueScratch = new Uint32Array(Math.max(n * w, this.valueScratch.length * 2));
        this.valueScratchF32 = new Float32Array(this.valueScratch.buffer);
      }
      const src = ch.data;
      const dst = src instanceof Float32Array ? this.valueScratchF32 : this.valueScratch;
      const idx = list.list;
      for (let j = 0; j < n; j++) {
        const i = idx[j]!;
        table[(d.count + j) * 2] = i;
        table[(d.count + j) * 2 + 1] = prefix + j;
        for (let k = 0; k < w; k++) dst[j * w + k] = src[i * w + k]!;
      }
      queue.writeBuffer(upload, prefix * w * 4, this.valueScratch, 0, n * w);
    }
    queue.writeBuffer(this.reserve(job.slot, "ranges", ranges * 8), 0, table, 0, ranges * 2);
    job.total = prefix + n;
    job.ranges = ranges;
    d.clear();
    list.clear();
    return (prefix + n) * w * 4 + ranges * 8;
  }

  private createFilled(label: string, data: Uint32Array | Float32Array, edgeState: Uint32Array | null = null): GPUBuffer {
    const size = Math.max(MIN_BUFFER_BYTES, Math.ceil(data.byteLength / 16) * 16);
    const buffer = this.device.createBuffer({ label, size, usage: USAGE, mappedAtCreation: true });
    if (data.byteLength > 0) {
      const words = new Uint32Array(buffer.getMappedRange(0, data.byteLength));
      words.set(new Uint32Array(data.buffer, data.byteOffset, data.length));
      if (edgeState) {
        const shift = CONSTANTS.EDGE_STATE_SHIFT;
        const n = Math.min(edgeState.length, words.length >> 1);
        for (let i = 0; i < n; i++) {
          const b = edgeState[i]!;
          if (b !== 0) words[i * 2] = (words[i * 2]! | ((b << shift) & EDGE_STATE_TOP)) >>> 0;
        }
      }
    }
    buffer.unmap();
    return buffer;
  }

  private identity(label: string, n: number): GPUBuffer {
    const size = Math.max(MIN_BUFFER_BYTES, Math.ceil((n * 4) / 16) * 16);
    const buffer = this.device.createBuffer({ label, size, usage: USAGE, mappedAtCreation: true });
    const words = new Uint32Array(buffer.getMappedRange());
    for (let i = 0; i < n; i++) words[i] = i;
    buffer.unmap();
    return buffer;
  }

  private retire(...buffers: (GPUBuffer | undefined)[]): void {
    for (const b of buffers) if (b) this.retired.push(b);
  }

  private rebind(): void {
    this.bindGroup = this.device.createBindGroup({
      label: "group1/graph",
      layout: this.layout,
      entries: GRAPH_BINDINGS.map((b) => ({ binding: b.binding, resource: { buffer: this.buffers[b.name] } })),
    });
  }
}
