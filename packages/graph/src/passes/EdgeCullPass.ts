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
import type { EdgeDebugMode } from "../api/types";
import { EDGE_CONSTANTS, edgeChunkCount, edgeMoveWordOffset, edgeScratchWords, ENGINE_CONSTANTS } from "../data/Layouts";
import { Dirty } from "../engine/Dirty";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { Stage, type ComputeNode, type FrameContext } from "../gpu/FrameGraph";
import { createShaderModule } from "../gpu/ShaderModules";

/** Grow with headroom so edge additions don't reallocate every time. */
const GROWTH = 1.25;
/** Chunk records depend on endpoint positions and on which edges exist. */
const BOUNDS_DIRTY = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.EDGES;

export interface EdgeCullOutputs {
  /** Draw args, chunk list and chunk records. */
  scratch: GPUBuffer;
  /** One edge index per drawn edge. */
  list: GPUBuffer;
}

/** EDGE_DEBUG values in edges.wgsl, by index. */
export const EDGE_DEBUG_MODES: readonly EdgeDebugMode[] = ["off", "length", "thinning", "chunk"];

export interface EdgeCullOptions {
  directed: boolean;
  /** Edges per pixel a crowded length level is thinned to; 0 = never. */
  maxOverdraw: number;
  /** Edges this short on screen or shorter are not drawn, CSS px. */
  minLengthPx: number;
  /** Index into EDGE_DEBUG_MODES. */
  debug: number;
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
  private readonly moveHead = new Uint32Array(2);
  private moving = false;
  private touchPending = false;
  private boundsStale = true;
  private capacity = 0;
  private gx = 0;
  private gy = 0;
  private readonly dummy: GPUBuffer;

  private constructor(
    private readonly device: GPUDevice,
    private readonly layouts: { state: GPUBindGroupLayout; bounds: GPUBindGroupLayout; expand: GPUBindGroupLayout; touch: GPUBindGroupLayout },
    private readonly bounds: GPUComputePipeline,
    private readonly boundsLines: GPUComputePipeline,
    private readonly boundsList: GPUComputePipeline,
    private readonly boundsListLines: GPUComputePipeline,
    private readonly touch: GPUComputePipeline,
    private readonly cull: GPUComputePipeline,
    private readonly expand: GPUComputePipeline,
  ) {
    this.dummy = device.createBuffer({ label: "edge/lines-dummy", size: 16, usage: GPUBufferUsage.STORAGE });
  }

  static async create(device: GPUDevice, layouts: ContractLayouts, opts: EdgeCullOptions): Promise<EdgeCullPass> {
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
    };
    const make = (m: GPUShaderModule, entryPoint: string, layout: GPUBindGroupLayout, constants?: Record<string, number>) =>
      device.createComputePipelineAsync({
        label: `edge/${entryPoint}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.graph, layout] }),
        compute: { module: m, entryPoint, constants },
      });
    const [bounds, boundsLines, boundsList, boundsListLines, touch, cull, expand] = await Promise.all([
      make(module, "edge_bounds", phase.bounds, { EDGE_LINES: 0 }),
      make(module, "edge_bounds", phase.bounds, { EDGE_LINES: 1 }),
      make(module, "edge_bounds_list", phase.bounds, { EDGE_LINES: 0 }),
      make(module, "edge_bounds_list", phase.bounds, { EDGE_LINES: 1 }),
      make(module, "edge_touch", phase.touch),
      make(module, "edge_cull", phase.state, {
        EDGE_ARROWS: opts.directed ? 1 : 0,
        EDGE_MAX_OVERDRAW: opts.maxOverdraw,
        EDGE_MIN_LEN_PX: opts.minLengthPx,
        EDGE_DEBUG: opts.debug,
      }),
      make(expandModule, "edge_expand", phase.expand),
    ]);
    return new EdgeCullPass(device, phase, bounds, boundsLines, boundsList, boundsListLines, touch, cull, expand);
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

  moveNode(engine: number, edgeCount: number): void {
    const out = this.outputs;
    this.moving = out !== null && edgeCount > 0;
    if (!this.moving) return;
    const h = this.moveHead;
    h[ENGINE_CONSTANTS.MOVE_COUNT] = 0;
    h[ENGINE_CONSTANTS.MOVE_NODE] = engine;
    this.device.queue.writeBuffer(out!.scratch, edgeMoveWordOffset(edgeCount) * 4, h);
    this.touchPending = true;
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
    return phase !== 0 || this.boundsStale || (ctx.dirty & BOUNDS_DIRTY) !== 0 || (this.moving && (ctx.dirty & Dirty.MOVED) !== 0);
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
        this.linesReady = this.lines !== null;
        return;
      case 1:
        pass.setPipeline(this.cull);
        pass.setBindGroup(2, g.state);
        pass.dispatchWorkgroups(1);
        return;
      case 2:
        pass.setPipeline(this.expand);
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
