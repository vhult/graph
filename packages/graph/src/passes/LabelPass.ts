import type { LabelSnapshot } from "../api/types";
import { LABEL_CANDIDATE, LABEL_CONSTANTS, LABEL_PARAMS, chunkCount, edgeChunkCount, labelledWordOffset } from "../data/Layouts";
import { Dirty } from "../engine/Dirty";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { Stage, type ComputeNode, type FrameContext } from "../gpu/FrameGraph";
import type { GraphBuffers } from "../gpu/GraphBuffers";
import { createShaderModule } from "../gpu/ShaderModules";
import type { Labels } from "../labels/Labels";
import type { EdgeCullPass } from "./EdgeCullPass";
import type { TransformCullPass } from "./TransformCullPass";

const C = LABEL_CONSTANTS;
const BUDGET_MS = 0.5;
const PLAN_MS = BUDGET_MS * 0.9;
const ESTIMATE_BLEND = 0.2;
const ESTIMATE_SPREAD = 2;
const HISTORY = 16;
const BONUS = 1.5;
const CANDIDATES_PER_LABEL_AREA = 32;
const MAX_CAPACITY = 1 << 18;
const READ_WORDS = 16;
const TREE_LEVELS_PER_PASS = 8;
const SOLVE_TRIGGERS = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.CAMERA | Dirty.STYLE | Dirty.STATE | Dirty.RESIZE | Dirty.EDGES | Dirty.LABEL_QUERY;
const EDGE_TREE_DIRTY = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.EDGES;

type Access = "uniform" | "read-only-storage" | "storage";
type Table = Record<string, readonly [number, Access]>;

const TREE: Table = {
  scratch: [0, "storage"],
  params: [1, "uniform"],
  sizes: [2, "read-only-storage"],
  labelIndex: [3, "storage"],
  treeBox: [4, "storage"],
  phase: [5, "uniform"],
  edgeState: [6, "read-only-storage"],
  positions: [7, "read-only-storage"],
  ends: [8, "read-only-storage"],
  edgeTops: [9, "storage"],
  edgeTreeBox: [10, "storage"],
  edgeTreeLen: [11, "storage"],
};

const PLACE: Table = {
  scratch: [0, "storage"],
  params: [1, "uniform"],
  positions: [2, "read-only-storage"],
  sizes: [3, "read-only-storage"],
  states: [4, "read-only-storage"],
  order: [5, "read-only-storage"],
  widths: [6, "read-only-storage"],
  labelIndex: [7, "read-only-storage"],
  treeBox: [8, "read-only-storage"],
  candidates: [9, "storage"],
  work: [10, "storage"],
  args: [11, "storage"],
  cellCount: [12, "storage"],
  cellStart: [13, "storage"],
  cellItems: [14, "storage"],
  decision: [15, "storage"],
  lists: [16, "storage"],
  neighbours: [17, "storage"],
  shown: [18, "storage"],
  phase: [19, "uniform"],
  ends: [20, "read-only-storage"],
  edgeOrder: [21, "read-only-storage"],
  edgeWidths: [22, "read-only-storage"],
  edgeTops: [23, "read-only-storage"],
  edgeTreeBox: [24, "read-only-storage"],
  edgeBits: [25, "read-only-storage"],
  edgeTreeLen: [26, "read-only-storage"],
};

const MARK: Table = {
  nodeBits: [0, "storage"],
  params: [1, "uniform"],
  live: [2, "read-only-storage"],
  edgeBits: [3, "storage"],
};

const MARK_ENTRIES = {
  label_clear_bits: ["nodeBits", "params", "edgeBits"],
  label_mark_bits: ["nodeBits", "params", "live", "edgeBits"],
} as const;

const TREE_ENTRIES = {
  label_order: ["params", "sizes", "labelIndex"],
  label_merge: ["params", "sizes", "labelIndex", "phase"],
  label_boxes: ["scratch", "params", "treeBox", "phase"],
  label_edge_boxes: ["params", "edgeState", "edgeTreeBox", "edgeTreeLen", "phase"],
  label_edge_tops: ["params", "edgeTops"],
  label_edge_merge: ["params", "positions", "ends", "edgeTops", "phase"],
} as const;

const PLACE_ENTRIES = {
  label_traverse: ["params", "treeBox", "edgeTreeBox", "work"],
  label_traverse_edges: ["params", "treeBox", "edgeTreeBox", "edgeTreeLen", "work"],
  label_job_args: ["work", "args"],
  label_emit: ["scratch", "params", "positions", "sizes", "states", "order", "widths", "labelIndex", "candidates", "work"],
  label_emit_edges: ["params", "positions", "ends", "edgeOrder", "edgeWidths", "edgeTops", "edgeBits", "candidates", "work", "phase"],
  label_count: ["params", "candidates", "work", "cellCount"],
  label_scan: ["params", "work", "args", "cellCount", "cellStart"],
  label_scatter: ["params", "candidates", "work", "cellCount", "cellStart", "cellItems", "decision"],
  label_build: ["params", "candidates", "work", "cellStart", "cellItems", "decision", "lists", "neighbours", "phase"],
  label_first_args: ["work", "args"],
  label_round: ["params", "candidates", "work", "cellStart", "cellItems", "decision", "lists", "neighbours", "phase"],
  label_next_args: ["work", "args", "phase"],
  label_collect: ["params", "candidates", "work", "decision", "shown", "order", "edgeOrder"],
} as const;

type Entry = keyof typeof MARK_ENTRIES | keyof typeof TREE_ENTRIES | keyof typeof PLACE_ENTRIES;

interface Step {
  tree?: boolean;
  edges?: number;
  nodes?: boolean;
  lists?: number;
  rounds?: readonly number[];
}

const STEPS: readonly Step[] = [
  { tree: true },
  ...Array.from({ length: C.LABEL_EDGE_PARTS }, (_, p) => ({ edges: p })),
  { nodes: true },
  ...Array.from({ length: C.LABEL_LIST_PARTS }, (_, p) => ({ lists: p })),
  ...Array.from({ length: C.LABEL_ROUNDS }, (_, r) => ({ rounds: [r] })),
];

const PHASE = { mark: 0, order: 1, tree: 2, edges: 3, candidates: 4, lists: 5, rounds: 6 } as const;

function stepPhases(k: number): number[] {
  const step = STEPS[k]!;
  const out: number[] = step.tree ? [PHASE.tree] : [];
  if (step.edges !== undefined) out.push(PHASE.edges);
  if (step.nodes) out.push(PHASE.candidates);
  if (step.lists !== undefined) out.push(PHASE.lists);
  if (step.rounds) out.push(PHASE.rounds);
  return out;
}

interface Kernel {
  pipeline: GPUComputePipeline;
  layout: GPUBindGroupLayout;
  names: readonly string[];
  table: Table;
}

interface View {
  capacity: number;
  gridW: number;
  gridH: number;
  edges: boolean;
  buffers: Record<string, GPUBuffer>;
}

interface Tree {
  nodeCount: number;
  chunks: number;
  levels: number;
  edgeCount: number;
  edgeChunks: number;
  edgeLevels: number;
  buffers: Record<string, GPUBuffer>;
}

interface Snapshot {
  buf: GPUBuffer;
  ids: number[];
  cap: number;
}

interface Readback {
  buffer: GPUBuffer;
  busy: boolean;
}

const levelsFor = (chunks: number) => Math.ceil(Math.log2(Math.max(1, chunks)));

export class LabelPass implements ComputeNode {
  readonly stage = Stage.LABEL_PLACE;
  readonly phases = ["label.mark", "label.order", "label.tree", "label.edges", "label.candidates", "label.lists", "label.rounds"] as const;
  readonly runsOn = SOLVE_TRIGGERS | Dirty.LABELS | Dirty.LABELLED;

  onShown: (shown: Uint32Array, count: number) => void = () => {};
  requestSolve: () => void = () => {};
  onSnapshot: (id: number, snapshot: LabelSnapshot) => void = () => {};
  marked = false;

  private readonly args: GPUBuffer;
  private readonly shown: GPUBuffer;
  private readonly readbacks: Readback[];
  private readonly dummy: GPUBuffer;
  private readonly paramData = new ArrayBuffer(LABEL_PARAMS.size);
  private readonly phaseBuffers = new Map<string, GPUBuffer>();
  private tree: Tree | null = null;
  private view: View | null = null;
  private viewport: [number, number] = [1, 1];
  private groups = new Map<string, GPUBindGroup>();
  private groupsKey: unknown[] = [];
  private step = -1;
  private frameSteps: number[] = [];
  private readonly costMean = new Float64Array(STEPS.length).fill(BUDGET_MS);
  private readonly costSpread = new Float64Array(STEPS.length);
  private readonly costSeen = new Uint8Array(STEPS.length);
  private readonly history = new Map<number, number[]>();
  private markedScratch: GPUBuffer | null = null;
  private runMark = false;
  private solveId = 0;
  private solveReadback = -1;
  private appliedSolve = 0;
  private scheduledReadback = -1;
  private orderStale = true;
  private runOrder = false;
  private edgeTreeStale = true;
  private runEdgeTree = false;
  private nodesOn = false;
  private edgesOn = false;
  private wanted = true;
  private generation = 0;
  private collected = false;
  private snapshotRequests: number[] = [];
  private solveSnapshots: number[] = [];
  private pendingSnapshot: Snapshot | null = null;

  private constructor(
    private readonly device: GPUDevice,
    private readonly graph: GraphBuffers,
    private readonly cull: TransformCullPass,
    private readonly edgeCull: EdgeCullPass,
    private readonly labels: Labels,
    private readonly kernels: Record<Entry, Kernel>,
    private readonly empty: GPUBindGroup,
  ) {
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.args = device.createBuffer({ label: "labels/args", size: (C.ARGS_ROUND + C.LABEL_ROUNDS + 1) * 16, usage: storage | GPUBufferUsage.INDIRECT });
    this.shown = device.createBuffer({ label: "labels/shown", size: C.LABEL_SHOWN_MAX * 8, usage: storage });
    this.readbacks = [0, 1].map(() => ({
      buffer: device.createBuffer({ label: "labels/readback", size: READ_WORDS * 4 + C.LABEL_SHOWN_MAX * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      busy: false,
    }));
    this.dummy = device.createBuffer({ label: "labels/none", size: 16, usage: GPUBufferUsage.STORAGE });
  }

  static async create(device: GPUDevice, layouts: ContractLayouts, graph: GraphBuffers, cull: TransformCullPass, edgeCull: EdgeCullPass, labels: Labels): Promise<LabelPass> {
    const [markModule, treeModule, placeModule] = await Promise.all([
      createShaderModule(device, "passes/label_mark.wgsl"),
      createShaderModule(device, "passes/label_tree.wgsl"),
      createShaderModule(device, "passes/label_place.wgsl"),
    ]);
    const emptyLayout = device.createBindGroupLayout({ label: "empty", entries: [] });
    const make = async (module: GPUShaderModule, table: Table, entry: string, names: readonly string[]): Promise<Kernel> => {
      const layout = device.createBindGroupLayout({
        label: `group2/${entry}`,
        entries: names.map((n) => ({ binding: table[n]![0], visibility: GPUShaderStage.COMPUTE, buffer: { type: table[n]![1] } })),
      });
      const pipeline = await device.createComputePipelineAsync({
        label: `labels/${entry}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, emptyLayout, layout] }),
        compute: { module, entryPoint: entry },
      });
      return { pipeline, layout, names, table };
    };
    const built = await Promise.all([
      ...Object.entries(MARK_ENTRIES).map(([e, n]) => make(markModule, MARK, e, n)),
      ...Object.entries(TREE_ENTRIES).map(([e, n]) => make(treeModule, TREE, e, n)),
      ...Object.entries(PLACE_ENTRIES).map(([e, n]) => make(placeModule, PLACE, e, n)),
    ]);
    const entries = [...Object.keys(MARK_ENTRIES), ...Object.keys(TREE_ENTRIES), ...Object.keys(PLACE_ENTRIES)];
    const kernels = Object.fromEntries(entries.map((e, k) => [e, built[k]!])) as Record<Entry, Kernel>;
    const empty = device.createBindGroup({ layout: emptyLayout, entries: [] });
    return new LabelPass(device, graph, cull, edgeCull, labels, kernels, empty);
  }

  get busy(): boolean {
    return this.step >= 0;
  }

  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
    this.view = null;
    this.abort();
  }

  requestSnapshot(id: number): void {
    this.snapshotRequests.push(id);
    this.wanted = true;
  }

  active(ctx: FrameContext): boolean {
    this.frameSteps = [];
    this.runOrder = false;
    this.runEdgeTree = false;
    this.runMark = false;
    if (ctx.nodeCount === 0 || !this.cull.outputs) return false;
    const nodesOn = this.labels.hasNodeText;
    const edgesOn = this.labels.hasEdgeText && ctx.edgeCount > 0 && this.graph.edgeOrder !== null && this.edgeCull.outputs !== null;
    if (nodesOn !== this.nodesOn || edgesOn !== this.edgesOn) {
      this.nodesOn = nodesOn;
      this.edgesOn = edgesOn;
      this.view = null;
      this.abort();
    }
    const t = this.tree;
    if ((ctx.dirty & Dirty.TOPOLOGY) !== 0 || !t || t.nodeCount !== ctx.nodeCount || t.edgeCount !== ctx.edgeCount) {
      this.reserveTree(ctx.nodeCount, ctx.edgeCount);
      this.orderStale = true;
      this.abort();
    }
    if (!this.view) this.reserveView();
    const scratch = this.cull.outputs.scratch;
    if (scratch !== this.markedScratch) {
      this.markedScratch = scratch;
      this.labels.marksDirty = true;
    }
    this.runMark = this.labels.marksDirty;
    if (!nodesOn && !edgesOn) return this.runMark;
    if ((ctx.dirty & SOLVE_TRIGGERS) !== 0) this.wanted = true;
    if ((ctx.dirty & EDGE_TREE_DIRTY) !== 0) this.edgeTreeStale = true;
    this.runOrder = this.orderStale && nodesOn;
    if (this.runOrder) this.orderStale = false;
    if (this.step < 0 && this.wanted) this.startSolve();
    if (this.step >= 0) this.planFrame();
    return this.runMark || this.runOrder || this.frameSteps.length > 0;
  }

  prepare(ctx: FrameContext): void {
    this.writeParams();
    this.bindGroupsFor(ctx);
    if (this.frameSteps[0] === 0) {
      const q = this.device.queue;
      q.writeBuffer(this.tree!.buffers.work!, 0, new Uint32Array(C.WORK_JOB_LIST));
      q.writeBuffer(this.view!.buffers.cellCount!, 0, new Uint32Array(this.view!.gridW * this.view!.gridH));
    }
  }

  phaseActive(phase: number): boolean {
    if (phase === PHASE.mark) return this.runMark;
    if (phase === PHASE.order) return this.runOrder;
    return this.frameSteps.some((k) => stepPhases(k).includes(phase) && (phase !== PHASE.edges || this.edgesOn));
  }

  encodePhase(phase: number, pass: GPUComputePassEncoder, ctx: FrameContext): void {
    const t = this.tree!;
    const v = this.view!;
    const size0 = 1 << t.levels;
    const edgeSize0 = 1 << t.edgeLevels;
    const run = (entry: Entry, groupKey: string, groups: number | { args: number }) => {
      pass.setPipeline(this.kernels[entry].pipeline);
      pass.setBindGroup(0, ctx.frameBindGroup);
      pass.setBindGroup(1, this.empty);
      pass.setBindGroup(2, this.groups.get(groupKey)!);
      if (typeof groups === "number") {
        const g = Math.max(1, groups);
        const gx = Math.min(g, 65535);
        pass.dispatchWorkgroups(gx, Math.ceil(g / gx));
      } else {
        pass.dispatchWorkgroupsIndirect(this.args, groups.args * 16);
      }
    };
    const steps = this.frameSteps.map((k) => STEPS[k]!);
    switch (phase) {
      case PHASE.mark: {
        const words = Math.max(Math.ceil(t.nodeCount / 32), Math.ceil(t.edgeCount / 32));
        run("label_clear_bits", "label_clear_bits", Math.ceil(words / 256));
        run("label_mark_bits", "label_mark_bits", Math.ceil(this.labels.liveCount / 256));
        this.labels.marksDirty = false;
        this.marked = true;
        return;
      }
      case PHASE.order:
        run("label_order", "label_order", size0);
        for (let g = 1; g <= t.levels; g++) run("label_merge", `label_merge/${g}`, Math.ceil((size0 >> g) / 256));
        return;
      case PHASE.tree:
        if (this.nodesOn) {
          for (let first = 0; first < Math.max(1, t.levels); first += TREE_LEVELS_PER_PASS) {
            run("label_boxes", `label_boxes/${first}`, Math.ceil((size0 >> first) / 256));
          }
        }
        if (this.edgesOn) {
          for (let first = 0; first < Math.max(1, t.edgeLevels); first += TREE_LEVELS_PER_PASS) {
            run("label_edge_boxes", `label_edge_boxes/${first}`, Math.ceil((edgeSize0 >> first) / 256));
          }
        }
        if (this.runEdgeTree) {
          run("label_edge_tops", "label_edge_tops", Math.ceil(edgeSize0 / 256));
          for (let g = 1; g <= t.edgeLevels; g++) run("label_edge_merge", `label_edge_merge/${g}`, Math.ceil((edgeSize0 >> g) / 256));
        }
        return;
      case PHASE.edges:
        for (const step of steps) {
          if (step.edges === undefined) continue;
          if (step.edges === 0) {
            run("label_traverse_edges", "label_traverse_edges", Math.ceil(t.edgeChunks / 64));
            run("label_job_args", "label_job_args", 1);
          }
          run("label_emit_edges", `label_emit_edges/${step.edges}`, { args: C.ARGS_EDGE_JOBS + step.edges });
        }
        return;
      case PHASE.candidates:
        if (this.nodesOn) {
          run("label_traverse", "label_traverse", Math.ceil(t.chunks / 64));
          run("label_job_args", "label_job_args", 1);
          run("label_emit", "label_emit", { args: C.ARGS_JOBS });
        }
        run("label_count", "label_count", Math.ceil(v.capacity / 256));
        run("label_scan", "label_scan", 1);
        run("label_scatter", "label_scatter", Math.ceil(v.capacity / 256));
        return;
      case PHASE.lists:
        for (const step of steps) {
          if (step.lists === undefined) continue;
          run("label_build", `label_build/${step.lists}`, { args: C.ARGS_LISTS + step.lists });
          if (step.lists === C.LABEL_LIST_PARTS - 1) run("label_first_args", "label_first_args", 1);
        }
        return;
      case PHASE.rounds:
        for (const step of steps) {
          for (const r of step.rounds ?? []) {
            run("label_round", `label_round/${r}`, { args: C.ARGS_ROUND + r });
            if (r + 1 < C.LABEL_ROUNDS) run("label_next_args", `label_next_args/${r}`, 1);
          }
        }
        if (this.frameSteps.at(-1) === STEPS.length - 1) {
          run("label_collect", "label_collect", Math.ceil(v.capacity / 256));
          this.collected = true;
        }
        return;
    }
  }

  recordFrame(frameIndex: number): void {
    if (this.frameSteps.length === 0) return;
    this.history.set(frameIndex, this.frameSteps);
    if (this.history.size > HISTORY) this.history.delete(this.history.keys().next().value!);
  }

  onProfile(frameIndex: number, slotMs: Float64Array, slotNames: readonly string[]): void {
    const steps = this.history.get(frameIndex);
    if (!steps) return;
    this.history.delete(frameIndex);
    const observed = new Map<number, number>();
    for (let phase = PHASE.tree; phase <= PHASE.rounds; phase++) {
      const ms = slotMs[slotNames.indexOf(this.phases[phase])];
      if (ms === undefined || !Number.isFinite(ms)) continue;
      const members = steps.filter((k) => stepPhases(k).includes(phase));
      const total = members.reduce((sum, k) => sum + this.costMean[k]!, 0);
      for (const k of members) observed.set(k, (observed.get(k) ?? 0) + (ms * this.costMean[k]!) / total);
    }
    for (const [k, ms] of observed) {
      if (!this.costSeen[k]) {
        this.costSeen[k] = 1;
        this.costMean[k] = ms;
        continue;
      }
      const d = ms - this.costMean[k]!;
      this.costMean[k]! += d * ESTIMATE_BLEND;
      this.costSpread[k]! += (Math.abs(d) - this.costSpread[k]!) * ESTIMATE_BLEND;
    }
  }

  private startSolve(): void {
    const free = this.readbacks.findIndex((r) => !r.busy);
    if (free < 0) return;
    this.readbacks[free]!.busy = true;
    this.solveReadback = free;
    this.solveId++;
    this.step = 0;
    this.wanted = false;
    this.generation = this.labels.generation;
    this.solveSnapshots = this.snapshotRequests.splice(0);
    if (this.edgesOn && this.edgeTreeStale) {
      this.runEdgeTree = true;
      this.edgeTreeStale = false;
    }
  }

  private planFrame(): void {
    let spent = 0;
    let k = this.step;
    while (k < STEPS.length) {
      if (STEPS[k]!.edges !== undefined && !this.edgesOn) {
        k++;
        continue;
      }
      const cost = this.costMean[k]! + ESTIMATE_SPREAD * this.costSpread[k]!;
      if (this.frameSteps.length > 0 && spent + cost > PLAN_MS) break;
      this.frameSteps.push(k);
      spent += cost;
      k++;
    }
    this.step = k < STEPS.length ? k : -1;
  }

  recordReadback(encoder: GPUCommandEncoder): void {
    if (!this.collected) return;
    this.collected = false;
    const target = this.readbacks[this.solveReadback]!.buffer;
    encoder.copyBufferToBuffer(this.tree!.buffers.work!, 0, target, 0, READ_WORDS * 4);
    encoder.copyBufferToBuffer(this.shown, 0, target, READ_WORDS * 4, C.LABEL_SHOWN_MAX * 8);
    this.scheduledReadback = this.solveReadback;
    if (this.solveSnapshots.length > 0) this.recordSnapshot(encoder, this.solveSnapshots.splice(0));
  }

  afterSubmit(): void {
    const snap = this.pendingSnapshot;
    if (snap) {
      this.pendingSnapshot = null;
      snap.buf.mapAsync(GPUMapMode.READ).then(
        () => this.readSnapshot(snap),
        () => snap.buf.destroy(),
      );
    }
    if (this.scheduledReadback < 0) return;
    const readback = this.readbacks[this.scheduledReadback]!;
    this.scheduledReadback = -1;
    const solve = this.solveId;
    const generation = this.generation;
    readback.buffer.mapAsync(GPUMapMode.READ).then(
      () => this.read(readback, solve, generation),
      () => (readback.busy = false),
    );
  }

  destroy(): void {
    for (const b of [this.args, this.shown, this.dummy, ...this.readbacks.map((r) => r.buffer), ...this.phaseBuffers.values()]) b.destroy();
    this.destroyTree();
    this.destroyView();
  }

  private recordSnapshot(encoder: GPUCommandEncoder, ids: number[]): void {
    const v = this.view!;
    const cap = v.capacity;
    const bytes = READ_WORDS * 4 + cap * (LABEL_CANDIDATE.size + 4);
    const buf = this.device.createBuffer({ label: "labels/snapshot", size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    encoder.copyBufferToBuffer(this.tree!.buffers.work!, 0, buf, 0, READ_WORDS * 4);
    encoder.copyBufferToBuffer(v.buffers.candidates!, 0, buf, READ_WORDS * 4, cap * LABEL_CANDIDATE.size);
    encoder.copyBufferToBuffer(v.buffers.decision!, 0, buf, READ_WORDS * 4 + cap * LABEL_CANDIDATE.size, cap * 4);
    this.pendingSnapshot = { buf, ids, cap };
  }

  private readSnapshot(snap: Snapshot): void {
    const data = snap.buf.getMappedRange();
    const found = new Uint32Array(data, 0, READ_WORDS)[C.WORK_CANDIDATES]!;
    const n = Math.min(found, snap.cap);
    const f32 = new Float32Array(data, READ_WORDS * 4, snap.cap * (LABEL_CANDIDATE.size / 4));
    const u32 = new Uint32Array(data, READ_WORDS * 4, snap.cap * (LABEL_CANDIDATE.size / 4));
    const decisions = new Uint32Array(data, READ_WORDS * 4 + snap.cap * LABEL_CANDIDATE.size, snap.cap);
    const o = LABEL_CANDIDATE.offset;
    const stride = LABEL_CANDIDATE.size / 4;
    for (const id of snap.ids) {
      const s: LabelSnapshot = {
        found,
        capacity: snap.cap,
        center: new Float32Array(2 * n),
        halfWidth: new Float32Array(n),
        halfHeight: new Float32Array(n),
        rank: new Float32Array(n),
        size: new Float32Array(n),
        index: new Uint32Array(n),
        decision: new Uint8Array(n),
      };
      for (let k = 0; k < n; k++) {
        const b = k * stride;
        s.center[2 * k] = f32[b + o.center / 4]!;
        s.center[2 * k + 1] = f32[b + o.center / 4 + 1]!;
        s.halfWidth[k] = f32[b + o.halfW / 4]!;
        s.halfHeight[k] = f32[b + o.halfH / 4]!;
        s.rank[k] = f32[b + o.rank / 4]!;
        s.size[k] = f32[b + o.size / 4]!;
        s.index[k] = u32[b + o.index / 4]!;
        s.decision[k] = decisions[k]!;
      }
      this.onSnapshot(id, s);
    }
    snap.buf.unmap();
    snap.buf.destroy();
  }

  private read(readback: Readback, solve: number, generation: number): void {
    const words = new Uint32Array(readback.buffer.getMappedRange()).slice();
    readback.buffer.unmap();
    readback.busy = false;
    const count = Math.min(words[C.WORK_SHOWN]!, C.LABEL_SHOWN_MAX);
    if (solve > this.appliedSolve && generation === this.labels.generation) {
      this.appliedSolve = solve;
      this.onShown(words.subarray(READ_WORDS, READ_WORDS + 2 * count), count);
    }
    if (this.wanted) this.requestSolve();
  }

  private abort(): void {
    this.snapshotRequests.unshift(...this.solveSnapshots.splice(0));
    if (this.step >= 0 && this.solveReadback >= 0) this.readbacks[this.solveReadback]!.busy = false;
    this.step = -1;
    this.collected = false;
    this.wanted = true;
  }

  private dims() {
    const m = this.labels.metrics();
    const labelH = m.textH + m.padding;
    const edgeHalf = (m.maxWidth + m.textH + m.padding) / 2;
    const maxHalfW = this.edgesOn ? edgeHalf : (m.maxWidth + m.padding) / 2;
    const maxHalfH = this.edgesOn ? edgeHalf : labelH / 2;
    const cellW = 2 * labelH;
    const [w, h] = this.viewport;
    const labelArea = m.textH * m.textH * 4;
    return {
      m,
      labelH,
      maxHalfW,
      maxHalfH,
      cellW,
      labelArea,
      gridW: Math.ceil((w + 2 * maxHalfW) / cellW) + 1,
      gridH: Math.ceil((h + 2 * maxHalfH) / labelH) + 1,
      capacity: Math.min(MAX_CAPACITY, Math.max(1024, Math.ceil(((w * h) / labelArea) * CANDIDATES_PER_LABEL_AREA))),
    };
  }

  private writeParams(): void {
    const d = this.dims();
    const t = this.tree!;
    const f = new Float32Array(this.paramData);
    const u = new Uint32Array(this.paramData);
    const o = LABEL_PARAMS.offset;
    f[o.textH / 4] = d.m.textH;
    f[o.labelH / 4] = d.labelH;
    f[o.gap / 4] = d.m.gap;
    f[o.padding / 4] = d.m.padding;
    f[o.maxHalfW / 4] = d.maxHalfW;
    f[o.maxHalfH / 4] = d.maxHalfH;
    f[o.minEdgeW / 4] = Math.min(1e30, this.labels.edgeMinWidth);
    f[o.labelArea / 4] = d.labelArea;
    f[o.cellW / 4] = d.cellW;
    f[o.bonus / 4] = BONUS;
    f[o.fadeS / 4] = d.m.fadeS;
    u[o.glyphTable / 4] = d.m.glyphTable;
    u[o.gridW / 4] = this.view!.gridW;
    u[o.gridH / 4] = this.view!.gridH;
    u[o.capacity / 4] = this.view!.capacity;
    u[o.chunks / 4] = t.chunks;
    u[o.levels / 4] = t.levels;
    u[o.nodeCount / 4] = t.nodeCount;
    u[o.edgeChunks / 4] = t.edgeChunks;
    u[o.edgeLevels / 4] = t.edgeLevels;
    u[o.edgeCount / 4] = t.edgeCount;
    u[o.bitsOffset / 4] = labelledWordOffset(t.nodeCount);
    u[o.liveCount / 4] = this.labels.liveCount;
    this.device.queue.writeBuffer(this.labels.params, 0, this.paramData);
  }

  private reserveTree(nodeCount: number, edgeCount: number): void {
    this.destroyTree();
    const chunks = chunkCount(nodeCount);
    const levels = levelsFor(chunks);
    const groups = 2 * (1 << levels) - 1;
    const edgeChunks = edgeChunkCount(edgeCount);
    const edgeLevels = levelsFor(edgeChunks);
    const edgeGroups = 2 * (1 << edgeLevels) - 1;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const buf = (label: string, bytes: number) => this.device.createBuffer({ label: `labels/${label}`, size: Math.max(16, bytes), usage: storage });
    this.tree = {
      nodeCount,
      chunks,
      levels,
      edgeCount,
      edgeChunks,
      edgeLevels,
      buffers: {
        labelIndex: buf("index", (nodeCount + groups * C.LABEL_TREE_TOP) * 4),
        treeBox: buf("treeBox", groups * 16),
        edgeTops: buf("edgeTops", edgeGroups * C.LABEL_TREE_TOP * 4),
        edgeTreeBox: buf("edgeTreeBox", edgeGroups * 16),
        edgeTreeLen: buf("edgeTreeLen", edgeGroups * 4),
        work: buf("work", (C.WORK_JOB_LIST + 2 * (chunks + edgeChunks)) * 4),
      },
    };
    this.edgeTreeStale = true;
  }

  private reserveView(): void {
    this.destroyView();
    const d = this.dims();
    const cap = d.capacity;
    const cells = d.gridW * d.gridH;
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const buf = (label: string, bytes: number) => this.device.createBuffer({ label: `labels/${label}`, size: Math.max(16, bytes), usage: storage });
    this.view = {
      capacity: cap,
      gridW: d.gridW,
      gridH: d.gridH,
      edges: this.edgesOn,
      buffers: {
        candidates: buf("candidates", cap * LABEL_CANDIDATE.size),
        cellCount: buf("cellCount", cells * 4),
        cellStart: buf("cellStart", (cells + 1) * 4),
        cellItems: buf("cellItems", cap * 4),
        decision: buf("decision", cap * 4),
        lists: buf("lists", cap * 8),
        neighbours: buf("neighbours", cap * (C.LABEL_NEIGHBOURS + 1) * 4),
      },
    };
    this.groupsKey = [];
  }

  private destroyTree(): void {
    if (this.tree) for (const b of Object.values(this.tree.buffers)) b.destroy();
    this.tree = null;
    this.groupsKey = [];
  }

  private destroyView(): void {
    if (this.view) for (const b of Object.values(this.view.buffers)) b.destroy();
    this.view = null;
    this.groupsKey = [];
  }

  private phaseBuffer(x: number, y = 0): GPUBuffer {
    const key = `${x},${y}`;
    let b = this.phaseBuffers.get(key);
    if (!b) {
      b = this.device.createBuffer({ label: `labels/phase${key}`, size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
      new Uint32Array(b.getMappedRange()).set([x, y, 0, 0]);
      b.unmap();
      this.phaseBuffers.set(key, b);
    }
    return b;
  }

  private bindGroupsFor(ctx: FrameContext): void {
    const g = this.graph;
    const scratch = this.cull.outputs!.scratch;
    const edgeState = this.edgesOn ? this.edgeCull.outputs!.scratch : this.dummy;
    const edgeOrder = this.edgesOn ? g.edgeOrder! : this.dummy;
    const key = [ctx.graphBindGroup, scratch, edgeState, edgeOrder, this.labels.nodeWidths, this.labels.edgeWidths, this.labels.edgeBitsBuffer, this.tree, this.view];
    if (key.length === this.groupsKey.length && key.every((k, i) => k === this.groupsKey[i])) return;
    this.groupsKey = key;
    const common: Record<string, GPUBuffer> = {
      scratch,
      nodeBits: scratch,
      live: this.labels.liveBuffer,
      params: this.labels.params,
      positions: g.buffers.nodePos,
      sizes: g.buffers.nodeSize,
      states: g.buffers.nodeState,
      order: g.order,
      widths: this.labels.nodeWidths,
      ends: g.buffers.edgeIdx,
      edgeState,
      edgeOrder,
      edgeWidths: this.labels.edgeWidths,
      edgeBits: this.labels.edgeBitsBuffer,
      args: this.args,
      shown: this.shown,
      ...this.tree!.buffers,
      ...this.view!.buffers,
    };
    const groups = new Map<string, GPUBindGroup>();
    const add = (entry: Entry, key: string, phase?: GPUBuffer) => {
      const k = this.kernels[entry];
      const buffers: Record<string, GPUBuffer> = phase ? { ...common, phase } : common;
      groups.set(
        key,
        this.device.createBindGroup({
          label: `group2/${key}`,
          layout: k.layout,
          entries: k.names.map((n) => ({ binding: k.table[n]![0], resource: { buffer: buffers[n]! } })),
        }),
      );
    };
    const t = this.tree!;
    add("label_clear_bits", "label_clear_bits");
    add("label_mark_bits", "label_mark_bits");
    add("label_order", "label_order");
    for (let l = 1; l <= t.levels; l++) add("label_merge", `label_merge/${l}`, this.phaseBuffer(l));
    for (let first = 0; first < Math.max(1, t.levels); first += TREE_LEVELS_PER_PASS) {
      add("label_boxes", `label_boxes/${first}`, this.phaseBuffer(first, Math.min(TREE_LEVELS_PER_PASS, t.levels - first)));
    }
    for (const e of ["label_traverse", "label_job_args", "label_emit", "label_count", "label_scan", "label_scatter", "label_first_args", "label_collect"] as const) add(e, e);
    if (this.edgesOn) {
      for (let first = 0; first < Math.max(1, t.edgeLevels); first += TREE_LEVELS_PER_PASS) {
        add("label_edge_boxes", `label_edge_boxes/${first}`, this.phaseBuffer(first, Math.min(TREE_LEVELS_PER_PASS, t.edgeLevels - first)));
      }
      add("label_edge_tops", "label_edge_tops");
      for (let l = 1; l <= t.edgeLevels; l++) add("label_edge_merge", `label_edge_merge/${l}`, this.phaseBuffer(l));
      add("label_traverse_edges", "label_traverse_edges");
      for (let p = 0; p < C.LABEL_EDGE_PARTS; p++) add("label_emit_edges", `label_emit_edges/${p}`, this.phaseBuffer(p));
    }
    for (let p = 0; p < C.LABEL_LIST_PARTS; p++) add("label_build", `label_build/${p}`, this.phaseBuffer(p));
    for (let r = 0; r < C.LABEL_ROUNDS; r++) {
      add("label_round", `label_round/${r}`, this.phaseBuffer(r));
      if (r + 1 < C.LABEL_ROUNDS) add("label_next_args", `label_next_args/${r}`, this.phaseBuffer(r));
    }
    this.groups = groups;
  }
}
