/**
 * EDGE_CULL: per chunk of 1024 sorted edges, never per edge.
 *
 *   edge.bounds  1 workgroup / chunk        (data changes only)   edge_cull.wgsl
 *   edge.cull    1 workgroup                (every frame): which chunks, how
 *                                           many of each, draw + dispatch args
 *   edge.expand  1 workgroup / listed chunk (indirect): the draw list   edge_expand.wgsl
 *
 * Owns the edge state buffer and the draw list, which the draw reads directly.
 * No CPU readback.
 */
import { GraphError } from "../api/errors";
import { EDGE_CONSTANTS, edgeChunkCount, edgeMoveWordOffset, edgeScratchWords, ENGINE_CONSTANTS, WORKGROUP_SIZE } from "../data/Layouts";
import { Dirty } from "../engine/Dirty";
import { edgeConstants, edgeKey, type Tune } from "../engine/Tune";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { Stage, type ComputeNode, type FrameContext } from "../gpu/FrameGraph";
import { Tuned } from "../gpu/Lazy";
import type { ScatterSlot } from "../gpu/PermuteKernels";
import { createShaderModule } from "../gpu/ShaderModules";

/** Grow with headroom so edge additions don't reallocate every time. */
const GROWTH = 1.25;
/** Chunk records depend on endpoint positions and on which edges exist. */
const BOUNDS_DIRTY = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.EDGES;
export const RESTYLE_STYLES = 0;
export const RESTYLE_STATES = 1;

export interface EdgeCullOutputs {
  /** Draw args, chunk list and chunk records. */
  scratch: GPUBuffer;
  /** One edge index per drawn edge. */
  list: GPUBuffer;
}

export class EdgeCullPass implements ComputeNode {
  readonly stage = Stage.EDGE_CULL;
  readonly name = "edgeCull";
  readonly phases = ["edge.bounds", "edge.cull", "edge.expand"] as const;
  readonly runsOn = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.MOVED | Dirty.CAMERA | Dirty.STYLE | Dirty.STATE | Dirty.RESIZE | Dirty.EDGES;

  /** Null before the first reserve. */
  outputs: EdgeCullOutputs | null = null;
  lines: GPUBuffer | null = null;
  linesReady = false;
  private linesOn = false;
  private groups: { state: GPUBindGroup; bounds: GPUBindGroup; expand: GPUBindGroup; touch: GPUBindGroup } | null = null;
  private readonly moveHead = new Uint32Array(1);
  private moving = false;
  private touchPending = false;
  private readonly restyles = [0, 1].map(() => ({ count: 0, group: null as GPUBindGroup | null, key: [] as readonly GPUBuffer[] }));
  private boundsStale = true;
  private capacity = 0;
  private gx = 0;
  private gy = 0;
  private readonly dummy: GPUBuffer;

  private constructor(
    private readonly device: GPUDevice,
    private readonly layouts: { state: GPUBindGroupLayout; bounds: GPUBindGroupLayout; expand: GPUBindGroupLayout; touch: GPUBindGroupLayout; restyle: GPUBindGroupLayout },
    private readonly bounds: GPUComputePipeline,
    private readonly boundsLines: GPUComputePipeline,
    private readonly boundsList: GPUComputePipeline,
    private readonly boundsListLines: GPUComputePipeline,
    private readonly touch: GPUComputePipeline,
    private readonly restylePipe: GPUComputePipeline,
    readonly pipes: Tuned<{ cull: GPUComputePipeline; expand: GPUComputePipeline }>,
    private readonly empty: GPUBindGroup,
  ) {
    this.dummy = device.createBuffer({ label: "edge/lines-dummy", size: 16, usage: GPUBufferUsage.STORAGE });
  }

  static async create(device: GPUDevice, layouts: ContractLayouts, tune: Tune): Promise<EdgeCullPass> {
    const [module, expandModule] = await Promise.all([
      createShaderModule(device, "passes/edge_cull.wgsl"),
      createShaderModule(device, "passes/edge_expand.wgsl"),
    ]);
    const e = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const phase = {
      state: device.createBindGroupLayout({ label: "group2/edge-state", entries: [e(0, "storage")] }),
      bounds: device.createBindGroupLayout({ label: "group2/edge-bounds", entries: [e(0, "storage"), e(1, "storage")] }),
      // Read-only: the same buffer holds the dispatch args this phase runs from.
      expand: device.createBindGroupLayout({ label: "group2/edge-expand", entries: [e(0, "read-only-storage"), e(1, "storage")] }),
      touch: device.createBindGroupLayout({ label: "group2/edge-touch", entries: [e(2, "storage")] }),
      restyle: device.createBindGroupLayout({
        label: "group2/edge-restyle",
        entries: [e(2, "storage"), e(3, "read-only-storage"), e(4, "read-only-storage"), e(5, "uniform")],
      }),
    };
    const make = (m: GPUShaderModule, entryPoint: string, layout: GPUBindGroupLayout, constants?: Record<string, number>) =>
      device.createComputePipelineAsync({
        label: `edge/${entryPoint}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.graph, layout] }),
        compute: { module: m, entryPoint, constants },
      });
    const emptyLayout = device.createBindGroupLayout({ label: "empty", entries: [] });
    const pipes = new Tuned(edgeKey, (t) =>
      Promise.all([make(module, "edge_cull", phase.state, edgeConstants(t)), make(expandModule, "edge_expand", phase.expand, { EDGE_CURVE: t.curved ? 1 : 0 })]).then(
        ([cull, expand]) => ({ cull, expand }),
      ),
    );
    const [bounds, boundsLines, boundsList, boundsListLines, touch, restyle] = await Promise.all([
      make(module, "edge_bounds", phase.bounds, { EDGE_LINES: 0 }),
      make(module, "edge_bounds", phase.bounds, { EDGE_LINES: 1 }),
      make(module, "edge_bounds_list", phase.bounds, { EDGE_LINES: 0 }),
      make(module, "edge_bounds_list", phase.bounds, { EDGE_LINES: 1 }),
      make(module, "edge_touch", phase.touch),
      device.createComputePipelineAsync({
        label: "edge/edge_restyle",
        layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, emptyLayout, phase.restyle] }),
        compute: { module, entryPoint: "edge_restyle" },
      }),
    ]);
    const empty = device.createBindGroup({ layout: emptyLayout, entries: [] });
    await pipes.loadTune(tune);
    pipes.useTune(tune);
    return new EdgeCullPass(device, phase, bounds, boundsLines, boundsList, boundsListLines, touch, restyle, pipes, empty);
  }

  /** Ensure the buffers fit `edgeCount` edges. Old ones go to `retire`. */
  reserve(edgeCount: number, retire: (b: GPUBuffer) => void): void {
    if (edgeCount <= this.capacity && this.outputs) return;
    const cap = Math.max(1024, Math.ceil(edgeCount * GROWTH));
    const scratchBytes = edgeScratchWords(cap) * 4;
    const listBytes = cap * 4;
    if (Math.max(scratchBytes, listBytes) > this.device.limits.maxStorageBufferBindingSize) {
      throw new GraphError("limits-exceeded", `${edgeCount.toLocaleString("en-US")} edges exceed this GPU's storage binding size.`);
    }
    if (this.outputs) {
      retire(this.outputs.scratch);
      retire(this.outputs.list);
    }
    this.moving = false;
    const scratch = this.device.createBuffer({
      label: "edge/state",
      size: scratchBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const list = this.device.createBuffer({ label: "edge/list", size: listBytes, usage: GPUBufferUsage.STORAGE });
    this.outputs = { scratch, list };
    this.capacity = cap;
    if (this.linesOn) this.allocLines(retire);
    this.buildGroups();
    this.boundsStale = true;
  }

  moveNodes(edgeCount: number): void {
    const out = this.outputs;
    this.moving = out !== null && edgeCount > 0;
    if (!this.moving) return;
    this.device.queue.writeBuffer(out!.scratch, (edgeMoveWordOffset(edgeCount) + ENGINE_CONSTANTS.MOVE_COUNT) * 4, this.moveHead);
    this.touchPending = true;
  }

  endMove(): void {
    this.moving = false;
    this.touchPending = false;
  }

  restyle(k: number, rank: GPUBuffer, slot: ScatterSlot, count: number, edgeCount: number): void {
    const out = this.outputs;
    if (!out || count === 0 || edgeCount === 0) return;
    if (this.moving || count >= edgeCount) {
      this.boundsStale = true;
      return;
    }
    this.device.queue.writeBuffer(out.scratch, (edgeMoveWordOffset(edgeCount) + ENGINE_CONSTANTS.MOVE_COUNT) * 4, this.moveHead);
    const r = this.restyles[k]!;
    if (r.key[0] !== out.scratch || r.key[1] !== rank || r.key[2] !== slot.ranges || r.key[3] !== slot.params) {
      r.key = [out.scratch, rank, slot.ranges, slot.params];
      r.group = this.device.createBindGroup({ layout: this.layouts.restyle, entries: r.key.map((buffer, i) => ({ binding: i + 2, resource: { buffer } })) });
    }
    r.count = count;
  }

  setLines(on: boolean, retire: (b: GPUBuffer) => void): void {
    if (on === this.linesOn) return;
    this.linesOn = on;
    if (on) this.allocLines(retire);
    else if (this.lines) {
      retire(this.lines);
      this.lines = null;
      this.linesReady = false;
    }
    this.buildGroups();
    this.boundsStale = true;
  }

  private allocLines(retire: (b: GPUBuffer) => void): void {
    if (this.lines) retire(this.lines);
    this.lines = this.capacity > 0 ? this.device.createBuffer({ label: "edge/lines", size: this.capacity * 8, usage: GPUBufferUsage.STORAGE }) : null;
    this.linesReady = false;
  }

  private buildGroups(): void {
    const out = this.outputs;
    if (!out) return;
    const group = (layout: GPUBindGroupLayout, buffers: GPUBuffer[]) =>
      this.device.createBindGroup({ layout, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    this.groups = {
      state: group(this.layouts.state, [out.scratch]),
      bounds: group(this.layouts.bounds, [out.scratch, this.lines ?? this.dummy]),
      expand: group(this.layouts.expand, [out.scratch, out.list]),
      touch: this.device.createBindGroup({ layout: this.layouts.touch, entries: [{ binding: 2, resource: { buffer: out.scratch } }] }),
    };
  }

  phaseActive(phase: number, ctx: FrameContext): boolean {
    if (ctx.edgeCount === 0 || !this.groups) return false;
    return phase !== 0 || this.boundsStale || this.restyles[0]!.count > 0 || this.restyles[1]!.count > 0 || this.touchPending || (ctx.dirty & BOUNDS_DIRTY) !== 0 || (this.moving && (ctx.dirty & Dirty.MOVED) !== 0);
  }

  prepare(ctx: FrameContext): void {
    const chunks = Math.max(1, edgeChunkCount(ctx.edgeCount));
    this.gx = Math.min(chunks, this.device.limits.maxComputeWorkgroupsPerDimension);
    this.gy = Math.ceil(chunks / this.gx);
  }

  encodePhase(phase: number, pass: GPUComputePassEncoder, ctx: FrameContext): void {
    const g = this.groups!;
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, ctx.graphBindGroup);
    switch (phase) {
      case 0:
        if (!this.boundsStale && (ctx.dirty & BOUNDS_DIRTY) === 0) {
          for (const r of this.restyles) {
            if (r.count === 0) continue;
            const groups = Math.ceil(r.count / WORKGROUP_SIZE);
            const gx = Math.min(groups, this.device.limits.maxComputeWorkgroupsPerDimension);
            pass.setPipeline(this.restylePipe);
            pass.setBindGroup(1, this.empty);
            pass.setBindGroup(2, r.group!);
            pass.dispatchWorkgroups(gx, Math.ceil(groups / gx));
            pass.setBindGroup(1, ctx.graphBindGroup);
            r.count = 0;
          }
          if (this.touchPending) {
            pass.setPipeline(this.touch);
            pass.setBindGroup(2, g.touch);
            pass.dispatchWorkgroups(this.gx, this.gy);
            this.touchPending = false;
          }
          pass.setPipeline(this.lines ? this.boundsListLines : this.boundsList);
          pass.setBindGroup(2, g.bounds);
          pass.dispatchWorkgroups(ENGINE_CONSTANTS.MOVE_GROUPS);
          return;
        }
        pass.setPipeline(this.lines ? this.boundsLines : this.bounds);
        pass.setBindGroup(2, g.bounds);
        pass.dispatchWorkgroups(this.gx, this.gy);
        this.boundsStale = false;
        for (const r of this.restyles) r.count = 0;
        this.linesReady = this.lines !== null;
        return;
      case 1:
        pass.setPipeline(this.pipes.value!.cull);
        pass.setBindGroup(2, g.state);
        pass.dispatchWorkgroups(1);
        return;
      case 2:
        pass.setPipeline(this.pipes.value!.expand);
        pass.setBindGroup(2, g.expand);
        pass.dispatchWorkgroupsIndirect(this.outputs!.scratch, EDGE_CONSTANTS.EDGE_SCRATCH_DISPATCH * 4);
        return;
    }
  }

  destroy(): void {
    this.outputs?.scratch.destroy();
    this.outputs?.list.destroy();
    this.lines?.destroy();
    this.dummy.destroy();
  }
}
