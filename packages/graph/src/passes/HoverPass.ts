import { HOVER_PARAMS, PICK_CONSTANTS } from "../data/Layouts";
import type { ContractLayouts } from "../gpu/BindLayouts";
import type { FrameContext } from "../gpu/FrameGraph";
import type { GraphBuffers } from "../gpu/GraphBuffers";
import { Lazy } from "../gpu/Lazy";
import { createShaderModule } from "../gpu/ShaderModules";
import type { IconAtlas } from "../icons/IconAtlas";
import type { IconOptions } from "./TransformCullPass";

export interface HoverStyleWords {
  nodeOutlineColor: number;
  nodeOutlineScale: number;
  nodeOutlineMinWidth: number;
  nodeOutlineMaxWidth: number;
  edgeColor: number;
  edgeWidth: number;
}

const O = HOVER_PARAMS.offset;
const F = (byteOffset: number) => byteOffset >> 2;

export class HoverPass {
  node = -1;
  edge = -1;
  readonly iconPipe: Lazy<GPURenderPipeline>;
  private iconGroup: GPUBindGroup | null = null;
  private iconRank: GPUBuffer | null = null;
  private iconVersion = -1;
  private readonly params: GPUBuffer;
  private readonly data = new ArrayBuffer(HOVER_PARAMS.size);
  private readonly f32 = new Float32Array(this.data);
  private readonly u32 = new Uint32Array(this.data);
  private group: GPUBindGroup | null = null;
  private rank: GPUBuffer | null = null;
  private lodScale = 0;
  private shapes = false;
  private pixelRatio = 0;
  private readonly outlineMin: number;
  private readonly outlineMax: number;

  private constructor(
    private readonly device: GPUDevice,
    private readonly graph: GraphBuffers,
    private readonly layout: GPUBindGroupLayout,
    private readonly iconLayout: GPUBindGroupLayout,
    makeIconPipe: () => Promise<GPURenderPipeline>,
    private readonly nodePipe: GPURenderPipeline,
    private readonly edgePipe: GPURenderPipeline,
    private readonly edgeVertices: number,
    style: HoverStyleWords,
  ) {
    this.iconPipe = new Lazy(makeIconPipe);
    this.params = device.createBuffer({ label: "hover/params", size: Math.ceil(HOVER_PARAMS.size / 16) * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.outlineMin = style.nodeOutlineMinWidth;
    this.outlineMax = style.nodeOutlineMaxWidth;
    this.f32[F(O.nodeOutlineScale)] = style.nodeOutlineScale;
    this.u32[F(O.nodeOutlineColor)] = style.nodeOutlineColor;
    this.u32[F(O.edgeColor)] = style.edgeColor;
    this.f32[F(O.edgeWidth)] = style.edgeWidth;
  }

  static async create(device: GPUDevice, format: GPUTextureFormat, contract: ContractLayouts, graph: GraphBuffers, directed: boolean, style: HoverStyleWords, icon: IconOptions): Promise<HoverPass> {
    const module = await createShaderModule(device, "passes/hover.wgsl");
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      label: "group2/hover",
      entries: [
        { binding: 0, visibility: VF, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    const iconLayout = device.createBindGroupLayout({
      label: "group2/hover.icons",
      entries: [
        { binding: 0, visibility: VF, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
        { binding: 9, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "float" } },
        { binding: 10, visibility: VF, buffer: { type: "read-only-storage" } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [contract.frame, contract.graph, layout] });
    const iconPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [contract.frame, contract.graph, iconLayout] });
    const blend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const make = (vs: string, fs: string, layout = pipelineLayout, extra: Record<string, number> = {}) => {
      const constants = { EDGE_ARROWS: directed ? 1 : 0, ...extra };
      return device.createRenderPipelineAsync({
        label: `hover/${vs}`,
        layout,
        vertex: { module, entryPoint: vs, constants },
        fragment: { module, entryPoint: fs, targets: [{ format, blend }], constants },
        primitive: { topology: "triangle-strip" },
      });
    };
    const makeIconPipe = () => make("node_vs_icons", "node_fs_icons", iconPipelineLayout, { ICON_SCALE: icon.scale, ICON_MIN_PX: icon.minPx });
    const [nodePipe, edgePipe] = await Promise.all([make("node_vs", "node_fs"), make("edge_vs", "edge_fs")]);
    return new HoverPass(device, graph, layout, iconLayout, makeIconPipe, nodePipe, edgePipe, directed ? 10 : 4, style);
  }

  setNode(node: number, lodScale: number, shapes: boolean, pixelRatio: number): boolean {
    if (node === this.node && (node < 0 || (lodScale === this.lodScale && shapes === this.shapes && pixelRatio === this.pixelRatio))) return false;
    this.node = node;
    this.lodScale = lodScale;
    this.shapes = shapes;
    this.pixelRatio = pixelRatio;
    if (node >= 0) {
      this.u32[F(O.node)] = node;
      this.f32[F(O.lodScale)] = lodScale;
      this.f32[F(O.nodeOutlineMinPx)] = this.outlineMin * pixelRatio;
      this.f32[F(O.nodeOutlineMaxPx)] = this.outlineMax * pixelRatio;
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
    const icons = ctx.icons;
    const iconPipe = icons ? this.iconPipe.value : null;
    if (icons && iconPipe) this.draw(pass, ctx, iconPipe, 4, this.iconBindGroup(icons));
    else this.draw(pass, ctx, this.nodePipe, 4, this.bindGroup());
  }

  encodeEdge(pass: GPURenderPassEncoder, ctx: FrameContext): void {
    if (this.edge < 0 || this.edge >= ctx.edgeCount) return;
    this.draw(pass, ctx, this.edgePipe, this.edgeVertices, this.bindGroup());
  }

  private bindGroup(): GPUBindGroup {
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
    return this.group;
  }

  private iconBindGroup(atlas: IconAtlas): GPUBindGroup {
    const rank = this.graph.rank;
    if (!this.iconGroup || rank !== this.iconRank || atlas.version !== this.iconVersion) {
      this.iconRank = rank;
      this.iconVersion = atlas.version;
      this.iconGroup = this.device.createBindGroup({
        label: "group2/hover.icons",
        layout: this.iconLayout,
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: rank } },
          { binding: 8, resource: atlas.sdfView },
          { binding: 9, resource: atlas.paletteView },
          { binding: 10, resource: { buffer: atlas.data } },
        ],
      });
    }
    return this.iconGroup;
  }

  private draw(pass: GPURenderPassEncoder, ctx: FrameContext, pipe: GPURenderPipeline, vertices: number, group: GPUBindGroup): void {
    pass.setPipeline(pipe);
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, ctx.graphBindGroup);
    pass.setBindGroup(2, group);
    pass.draw(vertices);
  }

  destroy(): void {
    this.params.destroy();
  }
}
