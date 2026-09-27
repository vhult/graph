/**
 * EDGE_GEOMETRY: one indirect instanced draw over the draw list EDGE_CULL
 * wrote, before the nodes in the shared render pass so edges sit under them.
 * Premultiplied alpha, no vertex buffers.
 */
import { EDGE_CONSTANTS } from "../data/Layouts";
import { edgeConstants, edgeKey, type Tune } from "../engine/Tune";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { PREMULTIPLIED, Stage, type FrameContext, type RenderNode } from "../gpu/FrameGraph";
import { Tuned } from "../gpu/Lazy";
import { createShaderModule } from "../gpu/ShaderModules";
import type { EdgeCullOutputs } from "./EdgeCullPass";
import type { HoverPass } from "./HoverPass";

/** Pipeline variant index: style level (0 none, 1 per-edge style, 2 with line patterns) + 3 × per-edge colour + 6 × node shapes. */
const VARIANTS = 6;
const SHAPE_VARIANTS = 12;

export class EdgeGeometryPass implements RenderNode {
  readonly stage = Stage.EDGE_GEOMETRY;
  readonly name = "edges";

  /** Set by the engine from what the store holds. */
  perEdgeStyle = false;
  linePatterns = false;
  perEdgeColor = false;
  shapes = false;
  hover: HoverPass | null = null;

  private bound: EdgeCullOutputs | null = null;
  private bindGroup: GPUBindGroup | null = null;

  private constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    readonly pipelines: Tuned<readonly GPURenderPipeline[]>,
  ) {}

  static async create(device: GPUDevice, format: GPUTextureFormat, layouts: ContractLayouts, tune: Tune): Promise<EdgeGeometryPass> {
    const module = await createShaderModule(device, "passes/edge_geometry.wgsl");
    const read = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } });
    const layout = device.createBindGroupLayout({ label: "group2/edges", entries: [read(0), read(1)] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.graph, layout] });
    // Every variant is built up front: choosing one must never wait inside a frame.
    const make = (t: Tune, v: number) => {
      const level = v % 3;
      const constants = {
        ...edgeConstants(t),
        EDGE_PER_EDGE_STYLE: level > 0 ? 1 : 0,
        EDGE_PATTERNS: level === 2 ? 1 : 0,
        EDGE_PER_EDGE_COLOR: Math.floor(v / 3) % 2,
        NODE_SHAPES: Math.floor(v / 6),
      };
      return device.createRenderPipelineAsync({
        label: `edges#${v}`,
        layout: pipelineLayout,
        vertex: { module, entryPoint: "vs", constants },
        fragment: { module, entryPoint: "fs", targets: [{ format, blend: PREMULTIPLIED }], constants },
        primitive: { topology: "triangle-strip" },
      });
    };
    const pipelines = new Tuned(edgeKey, (t) => Promise.all(Array.from({ length: t.arrows ? SHAPE_VARIANTS : VARIANTS }, (_, v) => make(t, v))));
    await pipelines.loadTune(tune);
    pipelines.useTune(tune);
    return new EdgeGeometryPass(device, layout, pipelines);
  }

  /** (Re)bind the cull outputs; a no-op when unchanged. */
  bind(outputs: EdgeCullOutputs): void {
    if (outputs.scratch === this.bound?.scratch && outputs.list === this.bound.list) return;
    this.bound = { ...outputs };
    this.bindGroup = this.device.createBindGroup({
      label: "group2/edges",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: outputs.scratch } },
        { binding: 1, resource: { buffer: outputs.list } },
      ],
    });
  }

  encode(pass: GPURenderPassEncoder, ctx: FrameContext): void {
    if (ctx.edgeCount === 0 || ctx.nodeCount === 0 || !this.bindGroup || !this.bound) return;
    const pipes = this.pipelines.value!;
    const level = this.perEdgeStyle ? (this.linePatterns ? 2 : 1) : 0;
    pass.setPipeline(pipes[level + (this.perEdgeColor ? 3 : 0) + (this.shapes && pipes.length > VARIANTS ? 6 : 0)]!);
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, ctx.graphBindGroup);
    pass.setBindGroup(2, this.bindGroup);
    // Instance count is written by the cull: the CPU never learns it.
    pass.drawIndirect(this.bound.scratch, EDGE_CONSTANTS.EDGE_SCRATCH_DRAW_ARGS * 4);
    this.hover?.encodeEdge(pass, ctx);
  }
}
