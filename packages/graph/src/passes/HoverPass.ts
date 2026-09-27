import type { ResolvedLook } from "../api/style";
import { CONSTANTS, HOVER_PARAMS, LOOK_PARAMS, PICK_CONSTANTS } from "../data/Layouts";
import type { LookList } from "../data/LookList";
import { packRgba } from "../data/Pack";
import type { Tune } from "../engine/Tune";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { PREMULTIPLIED, type FrameContext } from "../gpu/FrameGraph";
import type { GraphBuffers } from "../gpu/GraphBuffers";
import { Lazy, Tuned } from "../gpu/Lazy";
import { createShaderModule } from "../gpu/ShaderModules";
import type { IconAtlas } from "../icons/IconAtlas";

const O = HOVER_PARAMS.offset;
const L = LOOK_PARAMS.offset;
const F = (byteOffset: number) => byteOffset >> 2;
const LOOK_BYTES = Math.ceil(LOOK_PARAMS.size / 16) * 16;
const LOOK_BITS = [CONSTANTS.STATE_SELECTED, CONSTANTS.STATE_FOCUSED] as const;
const EDGE_LOOK_BITS = [CONSTANTS.EDGE_STATE_SELECTED, CONSTANTS.EDGE_STATE_FOCUSED] as const;
const EDGE_LOOK_MASKS = [
  CONSTANTS.EDGE_STATE_SELECTED | CONSTANTS.EDGE_STATE_FOCUSED | CONSTANTS.EDGE_STATE_HIDDEN,
  CONSTANTS.EDGE_STATE_FOCUSED | CONSTANTS.EDGE_STATE_HIDDEN,
] as const;
const arrowKey = (t: Tune) => (t.arrows ? "1" : "0");

interface EdgePipes {
  edge: GPURenderPipeline;
  look: GPURenderPipeline;
  vertices: number;
}
const LOOK_NODES = 0;
const LOOK_EDGES = 1;
const LIST_BINDINGS = [
  [1, 3],
  [4, 5],
] as const;

interface LookDraw {
  list: GPUBuffer;
  count: number;
  version: number;
  group: GPUBindGroup | null;
}

interface LookSlot {
  readonly buffer: GPUBuffer;
  readonly data: ArrayBuffer;
  readonly f32: Float32Array;
  readonly u32: Uint32Array;
  look: ResolvedLook | null;
  readonly draws: readonly [LookDraw, LookDraw];
}

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
  private hoverLook: ResolvedLook | false = false;
  private readonly looks: readonly [LookSlot, LookSlot];
  private readonly listRanks: (GPUBuffer | null)[] = [null, null];
  private readonly listLayouts: readonly [GPUBindGroupLayout, GPUBindGroupLayout];
  private lookShapes = false;
  private lookEdgeStyles = false;
  private lookPixelRatio = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly graph: GraphBuffers,
    private readonly layout: GPUBindGroupLayout,
    private readonly iconLayout: GPUBindGroupLayout,
    lookLayout: GPUBindGroupLayout,
    edgeLookLayout: GPUBindGroupLayout,
    makeIconPipe: () => Promise<GPURenderPipeline>,
    private readonly nodePipe: GPURenderPipeline,
    readonly edgePipes: Tuned<EdgePipes>,
    private readonly lookPipe: GPURenderPipeline,
    private readonly retire: (b: GPUBuffer) => void,
  ) {
    this.iconPipe = new Lazy(makeIconPipe);
    this.params = device.createBuffer({ label: "hover/params", size: Math.ceil(HOVER_PARAMS.size / 16) * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.listLayouts = [lookLayout, edgeLookLayout];
    const draw = (): LookDraw => ({ list: this.createList(16), count: 0, version: -1, group: null });
    const slot = (name: string): LookSlot => {
      const data = new ArrayBuffer(LOOK_BYTES);
      const buffer = device.createBuffer({ label: `hover/look.${name}`, size: LOOK_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      return { buffer, data, f32: new Float32Array(data), u32: new Uint32Array(data), look: null, draws: [draw(), draw()] };
    };
    this.looks = [slot("selected"), slot("focused")];
  }

  static async create(device: GPUDevice, format: GPUTextureFormat, contract: ContractLayouts, graph: GraphBuffers, tune: Tune, retire: (b: GPUBuffer) => void): Promise<HoverPass> {
    const module = await createShaderModule(device, "passes/hover.wgsl");
    const V = GPUShaderStage.VERTEX;
    const VF = V | GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      label: "group2/hover",
      entries: [
        { binding: 0, visibility: VF, buffer: { type: "uniform" } },
        { binding: 1, visibility: V, buffer: { type: "read-only-storage" } },
      ],
    });
    const iconLayout = device.createBindGroupLayout({
      label: "group2/hover.icons",
      entries: [
        { binding: 0, visibility: VF, buffer: { type: "uniform" } },
        { binding: 1, visibility: V, buffer: { type: "read-only-storage" } },
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
        { binding: 9, visibility: V, texture: { sampleType: "float" } },
        { binding: 10, visibility: VF, buffer: { type: "read-only-storage" } },
      ],
    });
    const lookLayout = device.createBindGroupLayout({
      label: "group2/hover.looks",
      entries: [
        { binding: 1, visibility: V, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: VF, buffer: { type: "uniform" } },
        { binding: 3, visibility: V, buffer: { type: "read-only-storage" } },
      ],
    });
    const edgeLookLayout = device.createBindGroupLayout({
      label: "group2/hover.edgeLooks",
      entries: [
        { binding: 2, visibility: VF, buffer: { type: "uniform" } },
        { binding: 4, visibility: V, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: V, buffer: { type: "read-only-storage" } },
      ],
    });
    const layoutOf = (l: GPUBindGroupLayout) => device.createPipelineLayout({ bindGroupLayouts: [contract.frame, contract.graph, l] });
    const make = (vs: string, fs: string, l = layout, constants: Record<string, number> = {}) =>
      device.createRenderPipelineAsync({
        label: `hover/${vs}`,
        layout: layoutOf(l),
        vertex: { module, entryPoint: vs, constants },
        fragment: { module, entryPoint: fs, targets: [{ format, blend: PREMULTIPLIED }], constants },
        primitive: { topology: "triangle-strip" },
      });
    const makeIconPipe = () => make("node_vs_icons", "node_fs_icons", iconLayout);
    const edgePipes = new Tuned(arrowKey, (t) =>
      Promise.all([make("edge_vs", "edge_fs", layout, { EDGE_ARROWS: t.arrows ? 1 : 0 }), make("edge_look_vs", "edge_look_fs", edgeLookLayout, { EDGE_ARROWS: t.arrows ? 1 : 0 })]).then(([edge, look]) => ({ edge, look, vertices: t.arrows ? 10 : 4 })),
    );
    const [nodePipe, lookPipe] = await Promise.all([make("node_vs", "node_fs"), make("look_vs", "look_fs", lookLayout)]);
    await edgePipes.loadTune(tune);
    edgePipes.useTune(tune);
    return new HoverPass(device, graph, layout, iconLayout, lookLayout, edgeLookLayout, makeIconPipe, nodePipe, edgePipes, lookPipe, retire);
  }

  setHoverLook(look: ResolvedLook | false): void {
    this.hoverLook = look;
    if (!look) return;
    this.u32[F(O.nodeOutlineColor)] = packRgba(...look.outline.color);
    this.f32[F(O.nodeOutlineScale)] = look.outline.scale;
    this.u32[F(O.edgeColor)] = packRgba(...look.edgeColor);
    this.f32[F(O.edgeWidth)] = look.edgeWidth;
    this.writeOutlinePx();
    this.device.queue.writeBuffer(this.params, 0, this.data);
  }

  setLooks(selected: ResolvedLook, focused: ResolvedLook): void {
    this.looks[0].look = selected;
    this.looks[1].look = focused;
    this.writeLooks();
  }

  syncLists(looks: { readonly nodes: readonly [LookList, LookList]; readonly edges: readonly [LookList, LookList] }): void {
    for (let k = 0; k < 2; k++) {
      this.setList(LOOK_NODES, k, looks.nodes[k]!);
      this.setList(LOOK_EDGES, k, looks.edges[k]!);
    }
  }

  private lookCount(kind: number): number {
    return this.looks[0].draws[kind]!.count + this.looks[1].draws[kind]!.count;
  }

  syncLooks(shapes: boolean, edgeStyles: boolean, pixelRatio: number): void {
    if (shapes === this.lookShapes && edgeStyles === this.lookEdgeStyles && pixelRatio === this.lookPixelRatio) return;
    this.lookShapes = shapes;
    this.lookEdgeStyles = edgeStyles;
    this.lookPixelRatio = pixelRatio;
    this.writeLooks();
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
      this.writeOutlinePx();
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
    if (this.lookCount(LOOK_NODES) > 0) this.encodeList(LOOK_NODES, pass, ctx);
    if (!this.hoverLook || this.node < 0 || this.node >= ctx.nodeCount) return;
    const icons = ctx.icons;
    const iconPipe = icons ? this.iconPipe.value : null;
    if (icons && iconPipe) this.draw(pass, ctx, iconPipe, 4, 1, this.iconBindGroup(icons));
    else this.draw(pass, ctx, this.nodePipe, 4, 1, this.bindGroup());
  }

  encodeEdge(pass: GPURenderPassEncoder, ctx: FrameContext): void {
    if (this.lookCount(LOOK_EDGES) > 0) this.encodeList(LOOK_EDGES, pass, ctx);
    if (!this.hoverLook || this.edge < 0 || this.edge >= ctx.edgeCount) return;
    const edge = this.edgePipes.value!;
    this.draw(pass, ctx, edge.edge, edge.vertices, 1, this.bindGroup());
  }

  private setList(kind: number, k: number, l: LookList): void {
    const d = this.looks[k]!.draws[kind]!;
    if (d.version === l.version) return;
    d.version = l.version;
    d.count = l.count;
    if (l.count * 4 > d.list.size) {
      this.retire(d.list);
      d.list = this.createList(l.count * 2);
      d.group = null;
    }
    if (l.count > 0) this.device.queue.writeBuffer(d.list, 0, l.list, 0, l.count);
  }

  private encodeList(kind: number, pass: GPURenderPassEncoder, ctx: FrameContext): void {
    const rank: GPUBuffer | null = kind === LOOK_NODES ? this.graph.rank : this.graph.edgeRank;
    if (ctx.nodeCount === 0 || rank === null || (kind === LOOK_EDGES && ctx.edgeCount === 0)) return;
    const looks = this.looks;
    if (rank !== this.listRanks[kind]) {
      this.listRanks[kind] = rank;
      looks[0].draws[kind]!.group = null;
      looks[1].draws[kind]!.group = null;
    }
    const pipe = kind === LOOK_NODES ? this.lookPipe : this.edgePipes.value!.look;
    const vertices = kind === LOOK_NODES ? 4 : this.edgePipes.value!.vertices;
    for (let k = 0; k < looks.length; k++) {
      const s = looks[k]!;
      const d = s.draws[kind]!;
      if (d.count === 0) continue;
      d.group ??= this.device.createBindGroup({
        label: "group2/hover.looks",
        layout: this.listLayouts[kind]!,
        entries: [
          { binding: LIST_BINDINGS[kind]![0], resource: { buffer: rank } },
          { binding: 2, resource: { buffer: s.buffer } },
          { binding: LIST_BINDINGS[kind]![1], resource: { buffer: d.list } },
        ],
      });
      this.draw(pass, ctx, pipe, vertices, d.count, d.group);
    }
  }

  private writeOutlinePx(): void {
    const look = this.hoverLook;
    if (!look) return;
    this.f32[F(O.nodeOutlineMinPx)] = look.outline.minWidth * this.pixelRatio;
    this.f32[F(O.nodeOutlineMaxPx)] = look.outline.maxWidth * this.pixelRatio;
  }

  private writeLooks(): void {
    this.looks.forEach((s, k) => {
      const look = s.look;
      if (!look) return;
      s.u32[F(L.outlineColor)] = packRgba(...look.outline.color);
      s.f32[F(L.outlineScale)] = look.outline.scale;
      s.f32[F(L.outlineMinPx)] = look.outline.minWidth * this.lookPixelRatio;
      s.f32[F(L.outlineMaxPx)] = look.outline.maxWidth * this.lookPixelRatio;
      s.u32[F(L.bit)] = LOOK_BITS[k]!;
      s.u32[F(L.flags)] = (this.lookShapes ? PICK_CONSTANTS.HOVER_FLAG_SHAPES : 0) | (this.lookEdgeStyles ? PICK_CONSTANTS.HOVER_FLAG_EDGE_STYLES : 0);
      s.u32[F(L.edgeColor)] = packRgba(...look.edgeColor);
      s.f32[F(L.edgeWidth)] = look.edgeWidth;
      s.u32[F(L.edgeBit)] = EDGE_LOOK_BITS[k]!;
      s.u32[F(L.edgeMask)] = EDGE_LOOK_MASKS[k]!;
      this.device.queue.writeBuffer(s.buffer, 0, s.data);
    });
  }

  private createList(entries: number): GPUBuffer {
    return this.device.createBuffer({ label: "hover/lookList", size: Math.max(16, entries * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
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

  private draw(pass: GPURenderPassEncoder, ctx: FrameContext, pipe: GPURenderPipeline, vertices: number, instances: number, group: GPUBindGroup): void {
    pass.setPipeline(pipe);
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, ctx.graphBindGroup);
    pass.setBindGroup(2, group);
    pass.draw(vertices, instances);
  }

  destroy(): void {
    this.params.destroy();
    for (const s of this.looks) {
      s.buffer.destroy();
      for (const d of s.draws) d.list.destroy();
    }
  }
}
