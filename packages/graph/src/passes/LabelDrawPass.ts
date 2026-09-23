import { LABEL_CONSTANTS } from "../data/Layouts";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { Stage, type FrameContext, type RenderNode } from "../gpu/FrameGraph";
import type { GraphBuffers } from "../gpu/GraphBuffers";
import { createShaderModule } from "../gpu/ShaderModules";
import type { Labels } from "../labels/Labels";

export class LabelDrawPass implements RenderNode {
  readonly stage = Stage.LABEL_DRAW;
  readonly name = "labels";

  private bindGroup: GPUBindGroup | null = null;
  private boundGraph: GPUBindGroup | null = null;

  private constructor(
    private readonly device: GPUDevice,
    private readonly graph: GraphBuffers,
    private readonly labels: Labels,
    private readonly layout: GPUBindGroupLayout,
    private readonly empty: GPUBindGroup,
    private readonly halo: GPURenderPipeline,
    private readonly fill: GPURenderPipeline,
  ) {}

  static async create(device: GPUDevice, format: GPUTextureFormat, layouts: ContractLayouts, graph: GraphBuffers, labels: Labels): Promise<LabelDrawPass> {
    const module = await createShaderModule(device, "passes/label_draw.wgsl");
    const V = GPUShaderStage.VERTEX;
    const layout = device.createBindGroupLayout({
      label: "group2/labels",
      entries: [
        { binding: 0, visibility: V, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: V, buffer: { type: "uniform" } },
        { binding: 2, visibility: V, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: V, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: V, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: V | GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 6, visibility: V, buffer: { type: "read-only-storage" } },
      ],
    });
    const emptyLayout = device.createBindGroupLayout({ label: "empty", entries: [] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, emptyLayout, layout] });
    const blend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const make = (halo: boolean) =>
      device.createRenderPipelineAsync({
        label: halo ? "labels/halo" : "labels/fill",
        layout: pipelineLayout,
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format, blend }], constants: { HALO: halo ? 1 : 0 } },
        primitive: { topology: "triangle-strip" },
      });
    const [halo, fill] = await Promise.all([make(true), make(false)]);
    const empty = device.createBindGroup({ layout: emptyLayout, entries: [] });
    return new LabelDrawPass(device, graph, labels, layout, empty, halo, fill);
  }

  encode(pass: GPURenderPassEncoder, ctx: FrameContext): void {
    const n = this.labels.liveCount;
    if (n === 0 || ctx.nodeCount === 0) return;
    if (ctx.graphBindGroup !== this.boundGraph) {
      this.boundGraph = ctx.graphBindGroup;
      const l = this.labels;
      this.bindGroup = this.device.createBindGroup({
        label: "group2/labels",
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.graph.buffers.nodePos } },
          { binding: 1, resource: { buffer: l.params } },
          { binding: 2, resource: { buffer: this.graph.buffers.nodeSize } },
          { binding: 3, resource: { buffer: l.liveBuffer } },
          { binding: 4, resource: { buffer: l.textBuffer } },
          { binding: 5, resource: l.atlas.view },
          { binding: 6, resource: { buffer: this.graph.buffers.edgeIdx } },
        ],
      });
    }
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, this.empty);
    pass.setBindGroup(2, this.bindGroup!);
    for (const p of [this.halo, this.fill]) {
      pass.setPipeline(p);
      pass.draw(4, n * LABEL_CONSTANTS.LABEL_GLYPHS);
    }
  }
}
