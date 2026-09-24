import { PICK_CONSTANTS, PICK_PARAMS, pickOutWords } from "../data/Layouts";
import type { ContractLayouts } from "../gpu/BindLayouts";
import type { FrameContext } from "../gpu/FrameGraph";
import type { GraphBuffers } from "../gpu/GraphBuffers";
import { createShaderModule } from "../gpu/ShaderModules";
import type { EdgeCullOptions, EdgeCullPass } from "./EdgeCullPass";
import type { TransformCullPass } from "./TransformCullPass";

export interface PickRequest {
  x: number;
  y: number;
  radiusPx: number;
  edgeRadiusPx: number;
  nodes: boolean;
  edges: boolean;
  shapes: boolean;
  edgeColors: boolean;
  token: number;
}

export type PickResult = (node: number, edge: number, nodeScale: number, engine: number, token: number) => void;

interface Slot {
  buffer: GPUBuffer;
  busy: boolean;
  token: number;
  read: () => void;
}

interface Pipelines {
  nodeSelect: GPUComputePipeline;
  nodeTest: GPUComputePipeline;
  nodeResolve: GPUComputePipeline;
  edgeSelect: GPUComputePipeline;
  edgeTest: GPUComputePipeline;
  edgeResolve: GPUComputePipeline;
}

interface Groups {
  nodeGraph: GPUBindGroup;
  nodeState: GPUBindGroup;
  edgeGraph: GPUBindGroup | null;
  edgeState: GPUBindGroup | null;
  select: GPUBindGroup;
  test: GPUBindGroup;
  nodeResolve: GPUBindGroup;
  edgeResolve: GPUBindGroup | null;
}

const C = PICK_CONSTANTS;
const SLOTS = 3;
const KEY_SIZE = 14;
const READBACK_BYTES = 20;

export const PICKED_NODES = 1;
export const PICKED_EDGES = 2;

export class PickPass {
  private readonly params: GPUBuffer;
  private readonly paramData = new ArrayBuffer(PICK_PARAMS.size);
  private readonly paramF32 = new Float32Array(this.paramData);
  private readonly paramU32 = new Uint32Array(this.paramData);
  private readonly args: GPUBuffer;
  private readonly empty: GPUBindGroup;
  private readonly slots: Slot[] = [];
  private readonly key: unknown[] = new Array<unknown>(KEY_SIZE).fill(null);
  private out: GPUBuffer | null = null;
  private groups: Groups | null = null;
  private pending: Slot | null = null;
  onResult: PickResult | null = null;

  private constructor(
    private readonly device: GPUDevice,
    private readonly layouts: Record<"nodeGraph" | "nodeState" | "edgeGraph" | "edgeState" | "select" | "test" | "resolve" | "empty", GPUBindGroupLayout>,
    private readonly pipelines: Pipelines,
  ) {
    this.params = device.createBuffer({ label: "pick/params", size: PICK_PARAMS.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.args = device.createBuffer({ label: "pick/args", size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT });
    this.empty = device.createBindGroup({ label: "pick/empty", layout: layouts.empty, entries: [] });
    for (let k = 0; k < SLOTS; k++) {
      const slot: Slot = {
        buffer: device.createBuffer({ label: `pick/readback${k}`, size: READBACK_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        busy: false,
        token: 0,
        read: () => {
          const range = slot.buffer.getMappedRange();
          const w = new Uint32Array(range);
          const node = w[0]! - 1;
          const edge = w[1]! - 1;
          const scale = new Float32Array(range)[3]!;
          const engine = w[4]!;
          slot.buffer.unmap();
          slot.busy = false;
          this.onResult?.(node, edge, scale, engine, slot.token);
        },
      };
      this.slots.push(slot);
    }
  }

  static async create(device: GPUDevice, contract: ContractLayouts, lodTargetPx: number, edge: EdgeCullOptions): Promise<PickPass> {
    const [nodeModule, edgeModule] = await Promise.all([createShaderModule(device, "passes/pick_nodes.wgsl"), createShaderModule(device, "passes/pick_edges.wgsl")]);
    const STAGE = GPUShaderStage.COMPUTE;
    const ro = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: STAGE, buffer: { type: "read-only-storage" } });
    const rw = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: STAGE, buffer: { type: "storage" } });
    const un = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: STAGE, buffer: { type: "uniform" } });
    const L = (label: string, entries: GPUBindGroupLayoutEntry[]) => device.createBindGroupLayout({ label: `pick/${label}`, entries });
    const layouts = {
      nodeGraph: L("nodeGraph", [ro(0), ro(1), ro(2), ro(3), ro(4)]),
      nodeState: L("nodeState", [rw(0)]),
      edgeGraph: L("edgeGraph", [ro(0), ro(1), ro(2), ro(5), ro(6), ro(7)]),
      edgeState: L("edgeState", [rw(0), rw(1)]),
      select: L("select", [un(0), rw(1), rw(3)]),
      test: L("test", [un(0), rw(1)]),
      resolve: L("resolve", [un(0), rw(1), ro(2)]),
      empty: L("empty", []),
    };
    const nodeConstants = { LOD_TARGET_PX: lodTargetPx };
    const edgeConstants = {
      EDGE_ARROWS: edge.directed ? 1 : 0,
      EDGE_MAX_OVERDRAW: edge.maxOverdraw,
      EDGE_MIN_LEN_PX: edge.minLengthPx,
      EDGE_DEBUG: edge.debug,
    };
    const make = (module: GPUShaderModule, entryPoint: string, groups: GPUBindGroupLayout[], constants: Record<string, number>) =>
      device.createComputePipelineAsync({
        label: `pick/${entryPoint}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [contract.frame, ...groups] }),
        compute: { module, entryPoint, constants },
      });
    const [nodeSelect, nodeTest, nodeResolve, edgeSelect, edgeTest, edgeResolve] = await Promise.all([
      make(nodeModule, "pick_nodes_select", [layouts.nodeGraph, layouts.nodeState, layouts.select], nodeConstants),
      make(nodeModule, "pick_nodes_test", [layouts.nodeGraph, layouts.nodeState, layouts.test], nodeConstants),
      make(nodeModule, "pick_nodes_resolve", [layouts.nodeGraph, layouts.nodeState, layouts.resolve], nodeConstants),
      make(edgeModule, "pick_edges_select", [layouts.edgeGraph, layouts.edgeState, layouts.select], edgeConstants),
      make(edgeModule, "pick_edges_test", [layouts.edgeGraph, layouts.edgeState, layouts.test], edgeConstants),
      make(edgeModule, "pick_edges_resolve", [layouts.empty, layouts.empty, layouts.resolve], edgeConstants),
    ]);
    return new PickPass(device, layouts, { nodeSelect, nodeTest, nodeResolve, edgeSelect, edgeTest, edgeResolve });
  }

  get free(): boolean {
    for (let k = 0; k < SLOTS; k++) if (!this.slots[k]!.busy) return true;
    return false;
  }

  encode(encoder: GPUCommandEncoder, ctx: FrameContext, graph: GraphBuffers, cull: TransformCullPass, edgeCull: EdgeCullPass, req: PickRequest): number {
    let slot: Slot | null = null;
    for (let k = 0; k < SLOTS; k++) {
      if (!this.slots[k]!.busy) {
        slot = this.slots[k]!;
        break;
      }
    }
    const cullOut = cull.outputs;
    const edgeOut = edgeCull.outputs;
    const nodes = req.nodes && cullOut !== null && ctx.nodeCount > 0;
    const edges = req.edges && edgeOut !== null && edgeCull.lines !== null && graph.edgeOrder !== null && ctx.edgeCount > 0 && ctx.nodeCount > 0;
    if (!slot || !cullOut || (!nodes && !edges)) return 0;

    const words = pickOutWords(ctx.nodeCount, ctx.edgeCount);
    if (!this.out || this.out.size < words * 4) {
      this.out?.destroy();
      this.out = this.device.createBuffer({ label: "pick/out", size: words * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    }
    const groups = this.bind(graph, cullOut.scratch, edgeOut?.scratch ?? null, edgeCull.lines, this.out);

    this.paramF32[0] = req.x;
    this.paramF32[1] = req.y;
    this.paramF32[2] = req.radiusPx;
    this.paramF32[4] = req.edgeRadiusPx;
    this.paramU32[3] =
      (nodes ? C.PICK_FLAG_NODES : 0) | (edges ? C.PICK_FLAG_EDGES : 0) | (req.shapes ? C.PICK_FLAG_SHAPES : 0) | (req.edgeColors ? C.PICK_FLAG_EDGE_COLORS : 0);
    this.device.queue.writeBuffer(this.params, 0, this.paramData);

    const p = this.pipelines;
    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, ctx.frameBindGroup);
    if (nodes) {
      pass.setBindGroup(1, groups.nodeGraph);
      pass.setBindGroup(2, groups.nodeState);
      pass.setBindGroup(3, groups.select);
      pass.setPipeline(p.nodeSelect);
      pass.dispatchWorkgroups(1);
      pass.setBindGroup(3, groups.test);
      pass.setPipeline(p.nodeTest);
      pass.dispatchWorkgroupsIndirect(this.args, 0);
      pass.setBindGroup(3, groups.nodeResolve);
      pass.setPipeline(p.nodeResolve);
      pass.dispatchWorkgroups(1);
    }
    if (edges) {
      pass.setBindGroup(1, groups.edgeGraph!);
      pass.setBindGroup(2, groups.edgeState!);
      pass.setBindGroup(3, groups.select);
      pass.setPipeline(p.edgeSelect);
      pass.dispatchWorkgroups(1);
      pass.setBindGroup(3, groups.test);
      pass.setPipeline(p.edgeTest);
      pass.dispatchWorkgroupsIndirect(this.args, 0);
      pass.setBindGroup(1, this.empty);
      pass.setBindGroup(2, this.empty);
      pass.setBindGroup(3, groups.edgeResolve!);
      pass.setPipeline(p.edgeResolve);
      pass.dispatchWorkgroups(1);
    }
    pass.end();
    encoder.copyBufferToBuffer(this.out, C.PICK_NODE_RESULT * 4, slot.buffer, 0, READBACK_BYTES);
    const picked = (nodes ? PICKED_NODES : 0) | (edges ? PICKED_EDGES : 0);
    slot.busy = true;
    slot.token = req.token * 4 + picked;
    this.pending = slot;
    return picked;
  }

  afterSubmit(): void {
    const slot = this.pending;
    if (!slot) return;
    this.pending = null;
    slot.buffer.mapAsync(GPUMapMode.READ).then(slot.read, () => (slot.busy = false));
  }

  private bind(graph: GraphBuffers, nodeState: GPUBuffer, edgeState: GPUBuffer | null, lines: GPUBuffer | null, out: GPUBuffer): Groups {
    const b = graph.buffers;
    let same = this.groups !== null;
    same = this.keep(0, b.nodePos) && same;
    same = this.keep(1, b.nodeStyle) && same;
    same = this.keep(2, b.nodeSize) && same;
    same = this.keep(3, b.nodeColor) && same;
    same = this.keep(4, b.nodeState) && same;
    same = this.keep(5, b.edgeIdx) && same;
    same = this.keep(6, b.edgeStyle) && same;
    same = this.keep(7, b.edgeColor) && same;
    same = this.keep(8, graph.order) && same;
    same = this.keep(9, graph.edgeOrder) && same;
    same = this.keep(10, nodeState) && same;
    same = this.keep(11, edgeState) && same;
    same = this.keep(12, lines) && same;
    same = this.keep(13, out) && same;
    if (same) return this.groups!;
    const group = (layout: GPUBindGroupLayout, entries: [number, GPUBuffer][]) =>
      this.device.createBindGroup({ layout, entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
    const l = this.layouts;
    const edgeReady = edgeState !== null && lines !== null && graph.edgeOrder !== null;
    this.groups = {
      nodeGraph: group(l.nodeGraph, [[0, b.nodePos], [1, b.nodeStyle], [2, b.nodeSize], [3, b.nodeColor], [4, b.nodeState]]),
      nodeState: group(l.nodeState, [[0, nodeState]]),
      edgeGraph: group(l.edgeGraph, [[0, b.nodePos], [1, b.nodeStyle], [2, b.nodeSize], [5, b.edgeIdx], [6, b.edgeStyle], [7, b.edgeColor]]),
      edgeState: edgeReady ? group(l.edgeState, [[0, edgeState], [1, lines]]) : null,
      select: group(l.select, [[0, this.params], [1, out], [3, this.args]]),
      test: group(l.test, [[0, this.params], [1, out]]),
      nodeResolve: group(l.resolve, [[0, this.params], [1, out], [2, graph.order]]),
      edgeResolve: edgeReady ? group(l.resolve, [[0, this.params], [1, out], [2, graph.edgeOrder!]]) : null,
    };
    return this.groups;
  }

  private keep(k: number, v: unknown): boolean {
    const same = this.key[k] === v;
    this.key[k] = v;
    return same;
  }

  destroy(): void {
    this.params.destroy();
    this.args.destroy();
    this.out?.destroy();
    for (const s of this.slots) s.buffer.destroy();
  }
}
