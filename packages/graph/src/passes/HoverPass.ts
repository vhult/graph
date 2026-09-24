import { HOVER_PARAMS, PICK_CONSTANTS } from "../data/Layouts";
import type { ContractLayouts } from "../gpu/BindLayouts";
import type { FrameContext } from "../gpu/FrameGraph";
import type { GraphBuffers } from "../gpu/GraphBuffers";
import { createShaderModule } from "../gpu/ShaderModules";

export interface HoverStyleWords {
  nodeColor: number;
  nodeScale: number;
  edgeColor: number;
  edgeWidth: number;
}

const O = HOVER_PARAMS.offset;
const F = (byteOffset: number) => byteOffset >> 2;

export class HoverPass {
  node = -1;
  edge = -1;
  private readonly params: GPUBuffer;
  private readonly data = new ArrayBuffer(HOVER_PARAMS.size);
  private readonly f32 = new Float32Array(this.data);
  private readonly u32 = new Uint32Array(this.data);
  private group: GPUBindGroup | null = null;
  private rank: GPUBuffer | null = null;
  private lodScale = 0;
  private shapes = false;

  private constructor(
    private readonly device: GPUDevice,
    private readonly graph: GraphBuffers,
    private readonly layout: GPUBindGroupLayout,
    private readonly nodePipe: GPURenderPipeline,
    private readonly edgePipe: GPURenderPipeline,
    private readonly edgeVertices: number,
    style: HoverStyleWords,
  ) {
    this.params = device.createBuffer({ label: "hover/params", size: Math.ceil(HOVER_PARAMS.size / 16) * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.f32[F(O.nodeGrow)] = style.nodeScale;
    this.u32[F(O.nodeColor)] = style.nodeColor;
    this.u32[F(O.edgeColor)] = style.edgeColor;
    this.f32[F(O.edgeWidth)] = style.edgeWidth;
  }

  static async create(device: GPUDevice, format: GPUTextureFormat, contract: ContractLayouts, graph: GraphBuffers, directed: boolean, style: HoverStyleWords): Promise<HoverPass> {
    const module = await createShaderModule(device, "passes/hover.wgsl");
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      label: "group2/hover",
      entries: [
        { binding: 0, visibility: VF, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [contract.frame, contract.graph, layout] });
    const blend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const constants = { EDGE_ARROWS: directed ? 1 : 0 };
    const make = (vs: string, fs: string) =>
      device.createRenderPipelineAsync({
        label: `hover/${vs}`,
        layout: pipelineLayout,
        vertex: { module, entryPoint: vs, constants },
        fragment: { module, entryPoint: fs, targets: [{ format, blend }], constants },
        primitive: { topology: "triangle-strip" },
      });
    const [nodePipe, edgePipe] = await Promise.all([make("node_vs", "node_fs"), make("edge_vs", "edge_fs")]);
    return new HoverPass(device, graph, layout, nodePipe, edgePipe, directed ? 10 : 4, style);
  }

  setNode(node: number, lodScale: number, shapes: boolean): boolean {
    if (node === this.node && (node < 0 || (lodScale === this.lodScale && shapes === this.shapes))) return false;
    this.node = node;
    this.lodScale = lodScale;
    this.shapes = shapes;
    if (node >= 0) {
      this.u32[F(O.node)] = node;
      this.f32[F(O.lodScale)] = lodScale;
      this.u32[F(O.flags)] = shapes ? PICK_CONSTANTS.HOVER_FLAG_SHAPES : 0;
      this.device.queue.writeBuffer(this.params, 0, this.data);
    }
    return true;
  }

  setEdge(edge: number, a: number, b: number, style: number): boolean {
    if (edge === this.edge) return false;
    this.edge = edge;
    if (edge >= 0) {
      this.u32[F(O.edgeA)] = a;
      this.u32[F(O.edgeB)] = b;
      this.u32[F(O.edgeStyle)] = style;
      this.device.queue.writeBuffer(this.params, 0, this.data);
    }
    return true;
  }

  encodeNode(pass: GPURenderPassEncoder, ctx: FrameContext): void {
    if (this.node < 0 || this.node >= ctx.nodeCount) return;
    this.draw(pass, ctx, this.nodePipe, 4);
  }

  encodeEdge(pass: GPURenderPassEncoder, ctx: FrameContext): void {
    if (this.edge < 0 || this.edge >= ctx.edgeCount) return;
    this.draw(pass, ctx, this.edgePipe, this.edgeVertices);
  }

  private draw(pass: GPURenderPassEncoder, ctx: FrameContext, pipe: GPURenderPipeline, vertices: number): void {
    const rank = this.graph.rank;
    if (rank !== this.rank || !this.group) {
      this.rank = rank;
      this.group = this.device.createBindGroup({
        label: "group2/hover",
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: rank } },
        ],
      });
    }
    pass.setPipeline(pipe);
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, ctx.graphBindGroup);
    pass.setBindGroup(2, this.group);
    pass.draw(vertices);
  }

  destroy(): void {
    this.params.destroy();
  }
}
