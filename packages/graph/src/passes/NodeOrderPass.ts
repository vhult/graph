import { CONSTANTS, ENGINE_CONSTANTS } from "../data/Layouts";
import { Stage, type ComputeNode, type FrameContext } from "../gpu/FrameGraph";
import { createShaderModule } from "../gpu/ShaderModules";
import type { TransformCullPass } from "./TransformCullPass";

export class NodeOrderPass implements ComputeNode {
  readonly stage = Stage.NODE_ORDER;
  readonly name = "order";
  readonly phases = ["order.count", "order.scan", "order.scatter"] as const;
  readonly runsOn: number;

  layers = false;
  layered: GPUBuffer | null = null;
  version = 0;

  private hist: GPUBuffer | null = null;
  private group: GPUBindGroup | null = null;
  private readonly params: GPUBuffer;
  private readonly paramData = new Uint32Array(4);
  private n = -1;
  private cullVersion = -1;
  private gx = 1;
  private gy = 1;
  private readonly maxGroupsX: number;

  private constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    private readonly empty: GPUBindGroup,
    private readonly pipelines: readonly [GPUComputePipeline, GPUComputePipeline, GPUComputePipeline],
    private readonly cull: TransformCullPass,
    private readonly retire: (b: GPUBuffer) => void,
  ) {
    this.runsOn = cull.runsOn;
    this.maxGroupsX = device.limits.maxComputeWorkgroupsPerDimension;
    this.params = device.createBuffer({ label: "order/params", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  static async create(device: GPUDevice, cull: TransformCullPass, retire: (b: GPUBuffer) => void): Promise<NodeOrderPass> {
    const module = await createShaderModule(device, "passes/node_order.wgsl");
    const s = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const layout = device.createBindGroupLayout({
      label: "group2/order",
      entries: [s(0, "uniform"), s(1, "read-only-storage"), s(2, "read-only-storage"), s(3, "storage"), s(4, "storage")],
    });
    const emptyLayout = device.createBindGroupLayout({ label: "empty", entries: [] });
    const pl = device.createPipelineLayout({ bindGroupLayouts: [emptyLayout, emptyLayout, layout] });
    const make = (entryPoint: string) => device.createComputePipelineAsync({ label: `order/${entryPoint}`, layout: pl, compute: { module, entryPoint } });
    const pipelines = (await Promise.all([make("order_count"), make("order_scan"), make("order_scatter")])) as [GPUComputePipeline, GPUComputePipeline, GPUComputePipeline];
    return new NodeOrderPass(device, layout, device.createBindGroup({ layout: emptyLayout, entries: [] }), pipelines, cull, retire);
  }

  active(): boolean {
    return this.layers;
  }

  prepare(ctx: FrameContext): void {
    const out = this.cull.outputs!;
    if (ctx.nodeCount === this.n && out.version === this.cullVersion && this.group) return;
    if (this.hist) this.retire(this.hist);
    if (this.layered) this.retire(this.layered);
    this.n = ctx.nodeCount;
    this.cullVersion = out.version;
    const blocks = Math.max(1, Math.ceil(this.n / ENGINE_CONSTANTS.CHUNK_SIZE));
    const hist = this.device.createBuffer({ label: "order/hist", size: Math.max(16, blocks * CONSTANTS.Z_LAYERS * 4), usage: GPUBufferUsage.STORAGE });
    const layered = this.device.createBuffer({ label: "order/instances", size: out.instances.size, usage: GPUBufferUsage.STORAGE });
    this.hist = hist;
    this.layered = layered;
    this.version++;
    this.gx = Math.min(blocks, this.maxGroupsX);
    this.gy = Math.ceil(blocks / this.gx);
    this.paramData[0] = blocks;
    this.device.queue.writeBuffer(this.params, 0, this.paramData);
    const buffers = [this.params, out.scratch, out.instances, hist, layered];
    this.group = this.device.createBindGroup({
      label: "group2/order",
      layout: this.layout,
      entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  encodePhase(phase: number, pass: GPUComputePassEncoder): void {
    pass.setBindGroup(0, this.empty);
    pass.setBindGroup(1, this.empty);
    pass.setBindGroup(2, this.group!);
    pass.setPipeline(this.pipelines[phase as 0 | 1 | 2]);
    if (phase === 1) pass.dispatchWorkgroups(1);
    else pass.dispatchWorkgroups(this.gx, this.gy);
  }

  destroy(): void {
    this.params.destroy();
    this.hist?.destroy();
    this.layered?.destroy();
  }
}
