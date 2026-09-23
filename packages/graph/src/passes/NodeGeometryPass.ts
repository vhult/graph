/**
 * NODE_GEOMETRY: instanced SDF quads from the culled instance list.
 * One `drawIndirect` per bucket, NORMAL then FOREGROUND (drawn last).
 * Premultiplied alpha, no vertex buffers.
 */
import { ENGINE_CONSTANTS } from "../data/Layouts";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { Stage, type FrameContext, type RenderNode } from "../gpu/FrameGraph";
import { createShaderModule } from "../gpu/ShaderModules";
import type { CullOutputs } from "./TransformCullPass";

const DRAW_ARGS_BYTES = 16;
const BUCKETS = [ENGINE_CONSTANTS.BUCKET_NORMAL, ENGINE_CONSTANTS.BUCKET_FOREGROUND] as const;

export class NodeGeometryPass implements RenderNode {
  readonly stage = Stage.NODE_GEOMETRY;
  readonly name = "nodes";

  shapes = false;

  private bindGroup: GPUBindGroup | null = null;
  private scratch: GPUBuffer | null = null;
  private boundVersion = -1;

  private constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    private readonly pipelines: readonly (readonly GPURenderPipeline[])[],
  ) {}

  static async create(device: GPUDevice, format: GPUTextureFormat, layouts: ContractLayouts): Promise<NodeGeometryPass> {
    const module = await createShaderModule(device, "passes/node_geometry.wgsl");
    const layout = device.createBindGroupLayout({
      label: "group2/nodes",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.graph, layout] });
    const blend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const make = (bucket: number, shapes: number) =>
      device.createRenderPipelineAsync({
        label: `nodes/bucket${bucket}#${shapes}`,
        layout: pipelineLayout,
        vertex: { module, entryPoint: "vs", constants: { BUCKET: bucket, NODE_SHAPES: shapes } },
        fragment: { module, entryPoint: "fs", targets: [{ format, blend }], constants: { NODE_SHAPES: shapes } },
        primitive: { topology: "triangle-strip" },
      });
    const variant = async (shapes: number) => {
      const built = await Promise.all(BUCKETS.map((b) => make(b, shapes)));
      const pipelines: GPURenderPipeline[] = [];
      BUCKETS.forEach((b, k) => (pipelines[b] = built[k]!));
      return pipelines;
    };
    const pipelines = await Promise.all([variant(0), variant(1)]);
    return new NodeGeometryPass(device, layout, pipelines);
  }

  /** (Re)bind the cull outputs; cheap no-op when unchanged. */
  bind(outputs: CullOutputs): void {
    if (outputs.version === this.boundVersion) return;
    this.boundVersion = outputs.version;
    this.scratch = outputs.scratch;
    this.bindGroup = this.device.createBindGroup({
      label: "group2/nodes",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: outputs.scratch } },
        { binding: 1, resource: { buffer: outputs.instances } },
      ],
    });
  }

  encode(pass: GPURenderPassEncoder, ctx: FrameContext): void {
    if (ctx.nodeCount === 0 || !this.bindGroup || !this.scratch) return;
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, ctx.graphBindGroup);
    pass.setBindGroup(2, this.bindGroup);
    const pipelines = this.pipelines[this.shapes ? 1 : 0]!;
    for (let k = 0; k < BUCKETS.length; k++) {
      const b = BUCKETS[k]!;
      pass.setPipeline(pipelines[b]!);
      pass.drawIndirect(this.scratch, ENGINE_CONSTANTS.SCRATCH_DRAW_ARGS * 4 + b * DRAW_ARGS_BYTES);
    }
  }
}
