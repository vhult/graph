/**
 * TRANSFORM_CULL: chunk-level rejection, per-node classification,
 * compaction into NodeInstance records per bucket and drawIndirect args.
 * No CPU readback, ever. See transform_cull.wgsl / chunk_bounds.wgsl.
 *
 *   cull.bounds        1 workgroup / chunk   (only on data changes)
 *   cull.count         1 workgroup / chunk
 *   cull.scan.reduce   1 workgroup / scan block
 *   cull.scan.blocks   1 workgroup
 *   cull.scan.down     1 workgroup / scan block
 *   cull.scatter       indirect: 1 workgroup / non-empty chunk
 *
 * Owns the cull state buffer (counts, offsets, chunk list, chunk bounds).
 */
import { GraphError } from "../api/errors";
import {
  chunkCount, cullCellCount, cullScratchWords, drawPositions, drawTableWordOffset, ENGINE_CONSTANTS, NODE_INSTANCE } from "../data/Layouts";
import { Dirty } from "../engine/Dirty";
import { lodKey, type Tunable, type Tune } from "../engine/Tune";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { Stage, type ComputeNode, type FrameContext } from "../gpu/FrameGraph";
import { Lazy, Variants } from "../gpu/Lazy";
import { createShaderModule } from "../gpu/ShaderModules";

/** Outputs consumed by the draw passes. `version` bumps when buffers are recreated. */
export interface CullOutputs {
  scratch: GPUBuffer;
  instances: GPUBuffer;
  version: number;
}

/** Grow with headroom so streaming node additions don't reallocate every frame. */
const GROWTH = 1.25;

interface PhaseLayouts {
  state: GPUBindGroupLayout;
  scan: GPUBindGroupLayout;
  scatter: GPUBindGroupLayout;
  list: GPUBindGroupLayout;
  touch: GPUBindGroupLayout;
}

const BOUNDS_DIRTY = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.STATE;

interface CullPipes {
  count: GPUComputePipeline;
  scatter: readonly GPUComputePipeline[];
  iconScatter: Lazy<GPUComputePipeline[]>;
}

export class TransformCullPass implements ComputeNode, Tunable {
  readonly stage = Stage.TRANSFORM_CULL;
  readonly name = "cull";
  readonly phases = ["cull.bounds", "cull.count", "cull.scan.reduce", "cull.scan.blocks", "cull.scan.down", "cull.scatter"] as const;
  // Everything that moves, resizes, recolours or restyles nodes on screen. Not CLEAR_COLOR.
  readonly runsOn = Dirty.TOPOLOGY | Dirty.POSITIONS | Dirty.MOVED | Dirty.CAMERA | Dirty.STYLE | Dirty.STATE | Dirty.RESIZE | Dirty.LABELLED;

  outputs: CullOutputs | null = null;
  shapes = false;
  layers = false;
  tailed = false;
  private icons = false;
  private readonly pipes = new Variants<CullPipes>();
  private iconCount = 0;
  private readonly scratchWords = new Uint32Array(2);
  private dispatchArgs: GPUBuffer;
  private groups: { state: GPUBindGroup; scan: GPUBindGroup; scatter: GPUBindGroup; list: GPUBindGroup; touch: GPUBindGroup } | null = null;
  private moveList: GPUBuffer;
  private moveChunks = 0;
  private readonly moveHead = new Uint32Array(1);
  private moving = false;
  private touchPending = false;
  /** Chunk bounds / LOD clusters in the state buffer are stale (new buffer or data change). */
  private boundsStale = true;
  private capacity = 0;
  private gx = 0;
  private gy = 0;
  private sx = 0;
  private sy = 0;
  /** Chunk count the draw stride in the state buffer was written for (-1: stale). */
  private tableChunks = -1;
  private readonly maxGroupsX: number;

  private constructor(
    private readonly device: GPUDevice,
    private readonly layouts: PhaseLayouts,
    private readonly bounds: GPUComputePipeline,
    private readonly boundsList: GPUComputePipeline,
    private readonly touch: GPUComputePipeline,
    private readonly reduce: GPUComputePipeline,
    private readonly scan: GPUComputePipeline,
    private readonly down: GPUComputePipeline,
    private readonly make: (t: Tune) => Promise<CullPipes>,
  ) {
    this.maxGroupsX = device.limits.maxComputeWorkgroupsPerDimension;
    // Separate buffer: indirect args must not be bound in the dispatch that consumes them.
    this.dispatchArgs = device.createBuffer({ label: "cull/dispatchArgs", size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT });
    this.moveList = this.createMoveList(0);
  }

  moveNodes(): void {
    this.moving = true;
    this.touchPending = true;
    this.device.queue.writeBuffer(this.moveList, ENGINE_CONSTANTS.MOVE_COUNT * 4, this.moveHead);
  }

  endMove(): void {
    this.moving = false;
    this.touchPending = false;
  }

  private createMoveList(chunks: number): GPUBuffer {
    this.moveChunks = chunks;
    return this.device.createBuffer({ label: "cull/moveList", size: Math.max(16, (ENGINE_CONSTANTS.MOVE_LIST + chunks) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  static async create(device: GPUDevice, layouts: ContractLayouts, tune: Tune): Promise<TransformCullPass> {
    const [module, boundsModule] = await Promise.all([
      createShaderModule(device, "passes/transform_cull.wgsl"),
      createShaderModule(device, "passes/chunk_bounds.wgsl"),
    ]);
    const e = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    // One layout per phase keeps each dispatch at <= 8 (graph) + 2 storage buffers, and
    // the indirect args buffer out of the dispatch that consumes it.
    const phase: PhaseLayouts = {
      state: device.createBindGroupLayout({ label: "group2/cull.state", entries: [e(0, "storage")] }),
      scan: device.createBindGroupLayout({ label: "group2/cull.scan", entries: [e(0, "storage"), e(2, "storage")] }),
      scatter: device.createBindGroupLayout({ label: "group2/cull.scatter", entries: [e(0, "storage"), e(3, "storage")] }),
      list: device.createBindGroupLayout({ label: "group2/cull.list", entries: [e(0, "storage"), e(1, "read-only-storage")] }),
      touch: device.createBindGroupLayout({ label: "group2/cull.touch", entries: [e(2, "storage")] }),
    };
    const make = (m: GPUShaderModule, entryPoint: string, layout: GPUBindGroupLayout, constants?: Record<string, number>) =>
      device.createComputePipelineAsync({
        label: "cull/" + entryPoint + (constants ? `#${Object.values(constants).join(",")}` : ""),
        layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.graph, layout] }),
        compute: { module: m, entryPoint, constants },
      });
    const makePipes = async (t: Tune): Promise<CullPipes> => {
      const lod = t.lodTargetPx;
      const scatterVariant = (shapes: number, layers: number, icons = 0) =>
        make(module, "cull_scatter", phase.scatter, {
          LOD_TARGET_PX: lod,
          NODE_SHAPES: shapes,
          NODE_LAYERS: layers,
          ...(icons ? { NODE_ICONS: 1 } : {}),
        });
      const [count, ...scatter] = await Promise.all([
        make(module, "cull_count", phase.state, { LOD_TARGET_PX: lod }),
        scatterVariant(0, 0),
        scatterVariant(1, 0),
        scatterVariant(0, 1),
        scatterVariant(1, 1),
      ]);
      const iconScatter = new Lazy(() => Promise.all([scatterVariant(0, 0, 1), scatterVariant(1, 0, 1), scatterVariant(0, 1, 1), scatterVariant(1, 1, 1)]));
      return { count, scatter, iconScatter };
    };
    const [bounds, boundsList, touch, reduce, scan, down] = await Promise.all([
      make(boundsModule, "chunk_bounds", phase.state),
      make(boundsModule, "chunk_bounds_list", phase.list),
      make(boundsModule, "chunk_touch", phase.touch),
      make(module, "scan_reduce", phase.state),
      make(module, "scan_blocks", phase.scan),
      make(module, "scan_down", phase.state),
    ]);
    const pass = new TransformCullPass(device, phase, bounds, boundsList, touch, reduce, scan, down, makePipes);
    await pass.loadTune(tune);
    pass.useTune(tune);
    return pass;
  }

  loadTune(t: Tune): Promise<unknown> {
    return this.pipes.load(lodKey(t), () => this.make(t)).then((p): Promise<unknown> | CullPipes => (this.icons ? p.iconScatter.load() : p));
  }

  hasTune(t: Tune): boolean {
    const p = this.pipes.get(lodKey(t));
    return p !== null && (!this.icons || p.iconScatter.value !== null);
  }

  useTune(t: Tune): void {
    this.pipes.use(lodKey(t));
  }

  loadIcons(): Promise<unknown> {
    this.icons = true;
    return this.pipes.value!.iconScatter.load();
  }

  fits(nodeCount: number, icons: boolean): boolean {
    const bytes = instanceBytes(capacityFor(nodeCount), icons);
    const limits = this.device.limits;
    return bytes <= limits.maxStorageBufferBindingSize && bytes <= limits.maxBufferSize;
  }

  /** Ensure buffers fit `nodeCount`. Old buffers go to `retire`. */
  reserve(nodeCount: number, retire: (b: GPUBuffer) => void, icons: boolean): void {
    if (nodeCount <= this.capacity && this.outputs && icons === this.tailed) return;
    const cap = capacityFor(nodeCount);
    const bytes = instanceBytes(cap, icons);
    const limits = this.device.limits;
    if (bytes > limits.maxStorageBufferBindingSize || bytes > limits.maxBufferSize) {
      // Buffer chunking above binding limits is milestone 9.
      throw new GraphError(
        "limits-exceeded",
        `${nodeCount.toLocaleString("en-US")} nodes need a ${(bytes / 2 ** 20).toFixed(0)} MiB instance buffer; ` +
          `this GPU binds at most ${(limits.maxStorageBufferBindingSize / 2 ** 20).toFixed(0)} MiB.`,
      );
    }
    if (this.outputs) {
      retire(this.outputs.scratch);
      retire(this.outputs.instances);
    }
    const scratch = this.device.createBuffer({
      label: "cull/scratch",
      size: cullScratchWords(cap) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    const instances = this.device.createBuffer({ label: "cull/instances", size: bytes, usage: GPUBufferUsage.STORAGE });
    this.outputs = { scratch, instances, version: (this.outputs?.version ?? 0) + 1 };
    this.capacity = cap;
    this.tailed = icons;
    this.iconCount = -1;
    this.groups = null; // rebuilt in prepare()
    this.boundsStale = true;
    this.tableChunks = -1;
    if (chunkCount(cap) > this.moveChunks) {
      retire(this.moveList);
      this.moveList = this.createMoveList(chunkCount(cap));
      if (this.moving) this.moveNodes();
    }
  }

  phaseActive(phase: number, ctx: FrameContext): boolean {
    return phase !== 0 || this.boundsStale || this.touchPending || (ctx.dirty & BOUNDS_DIRTY) !== 0 || (this.moving && (ctx.dirty & Dirty.MOVED) !== 0);
  }

  prepare(ctx: FrameContext): void {
    const out = this.outputs!;
    const iconCount = ctx.icons?.count ?? 0;
    if (iconCount !== this.iconCount) {
      this.iconCount = iconCount;
      this.scratchWords[0] = this.capacity;
      this.scratchWords[1] = iconCount;
      this.device.queue.writeBuffer(out.scratch, ENGINE_CONSTANTS.SCRATCH_ICON_BASE * 4, this.scratchWords);
    }
    if (!this.groups) {
      const bg = (layout: GPUBindGroupLayout, entries: [number, GPUBuffer][]) =>
        this.device.createBindGroup({ layout, entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
      this.groups = {
        state: bg(this.layouts.state, [[0, out.scratch]]),
        scan: bg(this.layouts.scan, [[0, out.scratch], [2, this.dispatchArgs]]),
        scatter: bg(this.layouts.scatter, [[0, out.scratch], [3, out.instances]]),
        list: bg(this.layouts.list, [[0, out.scratch], [1, this.moveList]]),
        touch: this.device.createBindGroup({ layout: this.layouts.touch, entries: [{ binding: 2, resource: { buffer: this.moveList } }] }),
      };
    }
    const chunks = chunkCount(ctx.nodeCount);
    if (chunks !== this.tableChunks) {
      this.device.queue.writeBuffer(out.scratch, drawTableWordOffset(ctx.nodeCount) * 4, drawPositions(chunks));
      this.tableChunks = chunks;
    }
    this.gx = Math.min(chunks, this.maxGroupsX);
    this.gy = Math.ceil(chunks / this.gx);
    const blocks = Math.max(1, Math.ceil(cullCellCount(ctx.nodeCount) / ENGINE_CONSTANTS.CHUNK_SIZE));
    this.sx = Math.min(blocks, this.maxGroupsX);
    this.sy = Math.ceil(blocks / this.sx);
  }

  encodePhase(phase: number, pass: GPUComputePassEncoder, ctx: FrameContext): void {
    const g = this.groups!;
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, ctx.graphBindGroup);
    switch (phase) {
      case 0:
        if (this.touchPending) {
          pass.setPipeline(this.touch);
          pass.setBindGroup(2, g.touch);
          pass.dispatchWorkgroups(this.gx, this.gy);
          this.touchPending = false;
        }
        if (!this.boundsStale && (ctx.dirty & BOUNDS_DIRTY) === 0) {
          pass.setPipeline(this.boundsList);
          pass.setBindGroup(2, g.list);
          pass.dispatchWorkgroups(ENGINE_CONSTANTS.MOVE_GROUPS);
          return;
        }
        pass.setPipeline(this.bounds);
        pass.setBindGroup(2, g.state);
        pass.dispatchWorkgroups(this.gx, this.gy);
        this.boundsStale = false;
        return;
      case 1:
        pass.setPipeline(this.pipes.value!.count);
        pass.setBindGroup(2, g.state);
        pass.dispatchWorkgroups(this.gx, this.gy);
        return;
      case 2:
        pass.setPipeline(this.reduce);
        pass.setBindGroup(2, g.state);
        pass.dispatchWorkgroups(this.sx, this.sy);
        return;
      case 3:
        pass.setPipeline(this.scan);
        pass.setBindGroup(2, g.scan);
        pass.dispatchWorkgroups(1);
        return;
      case 4:
        pass.setPipeline(this.down);
        pass.setBindGroup(2, g.state);
        pass.dispatchWorkgroups(this.sx, this.sy);
        return;
      case 5: {
        const pipes = this.pipes.value!;
        pass.setPipeline(((ctx.icons && pipes.iconScatter.value) || pipes.scatter)[(this.shapes ? 1 : 0) + (this.layers ? 2 : 0)]!);
        pass.setBindGroup(2, g.scatter);
        pass.dispatchWorkgroupsIndirect(this.dispatchArgs, 0);
        return;
      }
    }
  }

  /** Indirect args of cull_scatter: one workgroup per chunk with a visible node. */
  get dispatch(): GPUBuffer {
    return this.dispatchArgs;
  }

  destroy(): void {
    this.outputs?.scratch.destroy();
    this.outputs?.instances.destroy();
    this.dispatchArgs.destroy();
    this.moveList.destroy();
  }
}

function capacityFor(nodeCount: number): number {
  return Math.ceil(Math.max(1024, Math.ceil(nodeCount * GROWTH)) / 4) * 4;
}

function instanceBytes(capacity: number, icons: boolean): number {
  return capacity * NODE_INSTANCE.size + (icons ? capacity * 4 : 0);
}
