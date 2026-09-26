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
import type { GraphStore } from "../data/GraphStore";
import { DirtyRanges } from "../data/DirtyRanges";
import type { IndexUploads } from "../data/IndexUploads";
import { CONSTANTS, GRAPH_BINDINGS, GRAPH_BUFFER_WORDS, type GraphBufferName } from "../data/Layouts";
import type { LayerSlot, PermuteKernels, ScatterSlot } from "./PermuteKernels";

/** Smallest buffer we create: bindings need non-zero size, vec2 arrays need ≥ 8 B. */
const MIN_BUFFER_BYTES = 16;

export const NODE_CHANNELS = ["nodePos", "nodeStyle", "nodeSize", "nodeColor", "nodeState"] as const satisfies readonly GraphBufferName[];
export type NodeChannel = (typeof NODE_CHANNELS)[number];
const isNodeChannel = (n: GraphBufferName): n is NodeChannel => (NODE_CHANNELS as readonly string[]).includes(n);
const SCATTER_CHANNELS = [...NODE_CHANNELS, "edgeStyle", "edgeColor"] as const satisfies readonly GraphBufferName[];
type ScatterChannel = (typeof SCATTER_CHANNELS)[number];
const isScatterChannel = (n: GraphBufferName): n is ScatterChannel => (SCATTER_CHANNELS as readonly string[]).includes(n);
const JOB_NODE = 0;
const JOB_EDGE = 1;
const JOB_EDGE_STATE = 2;
const EDGE_STATE_TOP = ~CONSTANTS.EDGE_END_MASK;

const USAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;

interface ScatterJob {
  name: GraphBufferName;
  slot: ScatterSlot;
  total: number;
  ranges: number;
  kind: number;
}

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
  /** Bytes uploaded by the last flush. */
  lastUploadBytes = 0;

  private nodeCount = -1;
  private orderIsIdentity = true;
  private readonly gathers: { name: NodeChannel; userOrder: GPUBuffer }[] = [];
  private readonly scatters: ScatterJob[] = [];
  private readonly slots: Record<ScatterChannel, ScatterSlot>;
  private readonly indexSlots: Record<ScatterChannel, ScatterSlot>;
  private readonly edgeStateSlot: ScatterSlot;
  private invertEdges = false;
  private readonly layerSlot: LayerSlot;
  private layerJob = 0;
  private readonly rangeTable = new Uint32Array(DirtyRanges.CAPACITY * 2);
  private readonly retired: GPUBuffer[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    private readonly store: GraphStore,
    private readonly kernels: PermuteKernels,
  ) {
    this.slots = Object.fromEntries(SCATTER_CHANNELS.map((n) => [n, kernels.createScatterSlot(n)])) as Record<ScatterChannel, ScatterSlot>;
    this.indexSlots = Object.fromEntries(SCATTER_CHANNELS.map((n) => [n, kernels.createScatterSlot(`${n}/indexed`)])) as Record<ScatterChannel, ScatterSlot>;
    this.edgeStateSlot = kernels.createScatterSlot("edgeState");
    this.layerSlot = kernels.createLayerSlot();
  }

  /** GPU work queued by `flush` that must be encoded this frame. */
  get hasPendingWork(): boolean {
    return this.gathers.length > 0 || this.scatters.length > 0 || this.layerJob > 0 || this.invertEdges;
  }

  /** CPU side of the upload: create/fill buffers and stage partial updates. */
  flush(): boolean {
    this.restyledEdges = 0;
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
          store.edgeStateUploads.clear();
          store.edgeStateAll = false;
        }
        ch.realloc = false;
        ch.dirty.clear();
        ch.scattered.clear();
        continue;
      }
      if (!isScatterChannel(name)) continue;
      const kind = isNodeChannel(name) ? JOB_NODE : JOB_EDGE;
      if (kind === JOB_EDGE && !this.edgeRank) {
        ch.scattered.clear();
        ch.dirty.clear();
        continue;
      }
      if (ch.scattered.count > 0) {
        bytes += this.stageIndexed(this.indexSlots[name], name, ch.scattered, kind);
        ch.scattered.clear();
      }
      const d = ch.dirty;
      if (d.isEmpty) continue;
      bytes += this.stageScatter(name, ch.data, ch.words, d, kind);
      d.clear();
    }
    if (store.edgeStateAll || store.edgeStateUploads.count > 0) {
      if (this.edgeRank && store.edgeState) bytes += this.stageEdgeState(store.edgeState, store.edgeStateAll, store.edgeStateUploads);
      store.edgeStateUploads.clear();
      store.edgeStateAll = false;
    }

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
    for (const s of this.scatters) {
      const rank = s.kind === JOB_NODE ? this.rank : this.edgeRank!;
      this.kernels.scatter(pass, s.slot, rank, this.buffers[s.name], s.total, s.ranges, GRAPH_BUFFER_WORDS[s.name], s.kind === JOB_EDGE_STATE);
    }
    this.scatters.length = 0;

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
    for (const s of [...Object.values(this.slots), ...Object.values(this.indexSlots), this.edgeStateSlot]) {
      s.params.destroy();
      s.ranges.destroy();
      s.upload?.destroy();
    }
  }

  // ---- internals ----------------------------------------------------------------

  get restyleSlot(): ScatterSlot {
    return this.indexSlots.edgeStyle;
  }

  canStream(name: NodeChannel, count: number): boolean {
    const ch = this.store.channels[name];
    return this.nodeCount === count && !ch.realloc && ch.dirty.isEmpty && ch.scattered.count === 0;
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

  streamChannel(name: NodeChannel, data: Float32Array | Uint32Array): number {
    const total = data.length / GRAPH_BUFFER_WORDS[name];
    const slot = this.slots[name];
    const upload = this.reserve(slot, "upload", data.byteLength);
    const queue = this.device.queue;
    queue.writeBuffer(upload, 0, data);
    this.rangeTable[0] = 0;
    this.rangeTable[1] = 0;
    queue.writeBuffer(slot.ranges, 0, this.rangeTable, 0, 2);
    this.scatters.push({ name, slot, total, ranges: 1, kind: JOB_NODE });
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
    const pending =
      store.edgeStateAll ||
      store.edgeStateUploads.count > 0 ||
      ch.edgeStyle.scattered.count > 0 ||
      ch.edgeColor.scattered.count > 0 ||
      !ch.edgeStyle.dirty.isEmpty ||
      !ch.edgeColor.dirty.isEmpty;
    if (!pending || store.edgeCount === 0 || ch.edgeIdx.realloc || (this.edgeRank && !this.edgesUnsorted)) return;
    if (this.edgesUnsorted || !this.edgeOrder) {
      store.reloadEdges();
      return;
    }
    this.edgeRank = this.device.createBuffer({ label: "edgeRank", size: Math.max(MIN_BUFFER_BYTES, store.edgeCount * 4), usage: GPUBufferUsage.STORAGE });
    this.invertEdges = true;
  }

  private stageIndexed(slot: ScatterSlot, name: GraphBufferName, uploads: IndexUploads, kind: number): number {
    const pairs = uploads.pairs();
    const values = uploads.values();
    const queue = this.device.queue;
    queue.writeBuffer(this.reserve(slot, "ranges", pairs.byteLength), 0, pairs);
    queue.writeBuffer(this.reserve(slot, "upload", values.byteLength), 0, values);
    this.scatters.push({ name, slot, total: uploads.count, ranges: uploads.count, kind });
    if (name === "edgeStyle") this.restyledEdges = uploads.count;
    return pairs.byteLength + values.byteLength;
  }

  private stageEdgeState(state: Uint32Array, all: boolean, uploads: IndexUploads): number {
    const slot = this.edgeStateSlot;
    if (!all) return this.stageIndexed(slot, "edgeIdx", uploads, JOB_EDGE_STATE);
    const n = this.store.edgeCount;
    const queue = this.device.queue;
    queue.writeBuffer(this.reserve(slot, "upload", n * 4), 0, state, 0, n);
    this.rangeTable[0] = 0;
    this.rangeTable[1] = 0;
    queue.writeBuffer(this.reserve(slot, "ranges", 8), 0, this.rangeTable, 0, 2);
    this.scatters.push({ name: "edgeIdx", slot, total: n, ranges: 1, kind: JOB_EDGE_STATE });
    return n * 4 + 8;
  }

  /** Copy dirty user-order ranges into the channel's staging buffer; returns bytes. */
  private stageScatter(name: ScatterChannel, data: Uint32Array | Float32Array, words: number, d: DirtyRanges, kind: number): number {
    const slot = this.slots[name];
    let total = 0;
    for (let r = 0; r < d.count; r++) total += d.end(r) - d.start(r);
    const bytes = total * words * 4;
    this.reserve(slot, "upload", bytes);
    const queue = this.device.queue;
    let prefix = 0;
    for (let r = 0; r < d.count; r++) {
      const start = d.start(r);
      const count = d.end(r) - start;
      queue.writeBuffer(slot.upload!, prefix * words * 4, data, start * words, count * words);
      this.rangeTable[r * 2] = start;
      this.rangeTable[r * 2 + 1] = prefix;
      prefix += count;
    }
    queue.writeBuffer(slot.ranges, 0, this.rangeTable, 0, d.count * 2);
    this.scatters.push({ name, slot, total, ranges: d.count, kind });
    return bytes + d.count * 8;
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
