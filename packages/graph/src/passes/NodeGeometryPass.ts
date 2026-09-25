/**
 * NODE_GEOMETRY: instanced SDF quads from the culled instance list.
 * One `drawIndirect` per bucket, NORMAL then FOREGROUND (drawn last).
 * Premultiplied alpha, no vertex buffers.
 */
import { ENGINE_CONSTANTS } from "../data/Layouts";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { Stage, type FrameContext, type RenderNode } from "../gpu/FrameGraph";
import { Lazy } from "../gpu/Lazy";
import { createShaderModule } from "../gpu/ShaderModules";
import type { IconAtlas } from "../icons/IconAtlas";
import type { HoverPass } from "./HoverPass";
import type { NodeOrderPass } from "./NodeOrderPass";
import type { CullOutputs, IconOptions } from "./TransformCullPass";

const DRAW_ARGS_BYTES = 16;
const BUCKETS = [ENGINE_CONSTANTS.BUCKET_NORMAL, ENGINE_CONSTANTS.BUCKET_FOREGROUND] as const;

interface Variant {
  layout: GPUBindGroupLayout;
  pipelines: readonly (readonly GPURenderPipeline[])[];
}

interface CachedGroup {
  group: GPUBindGroup | null;
  cull: number;
  order: number;
  atlas: number;
}

const emptyGroup = (): CachedGroup => ({ group: null, cull: -1, order: -1, atlas: -1 });

export class NodeGeometryPass implements RenderNode {
  readonly stage = Stage.NODE_GEOMETRY;
  readonly name = "nodes";

  shapes = false;
  layers = false;
  hover: HoverPass | null = null;
  order: NodeOrderPass | null = null;
  readonly iconVariant: Lazy<Variant>;

  private readonly groups = [emptyGroup(), emptyGroup(), emptyGroup(), emptyGroup()];
  private scratch: GPUBuffer | null = null;
  private instances: GPUBuffer | null = null;
  private boundVersion = -1;

  private constructor(
    private readonly device: GPUDevice,
    private readonly plain: Variant,
    makeIcons: () => Promise<Variant>,
  ) {
    this.iconVariant = new Lazy(makeIcons);
  }

  static async create(device: GPUDevice, format: GPUTextureFormat, layouts: ContractLayouts, icon: IconOptions): Promise<NodeGeometryPass> {
    const module = await createShaderModule(device, "passes/node_geometry.wgsl");
    const blend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const V = GPUShaderStage.VERTEX;
    const F = GPUShaderStage.FRAGMENT;
    const variant = async (icons: boolean): Promise<Variant> => {
      const entries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: V, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: V, buffer: { type: "read-only-storage" } },
      ];
      if (icons) {
        entries.push(
          { binding: 8, visibility: F, texture: { sampleType: "float", viewDimension: "2d-array" } },
          { binding: 9, visibility: V, texture: { sampleType: "float" } },
          { binding: 10, visibility: F, buffer: { type: "read-only-storage" } },
        );
      }
      const layout = device.createBindGroupLayout({ label: icons ? "group2/nodes.icons" : "group2/nodes", entries });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layouts.frame, layouts.graph, layout] });
      const iconConstants: Record<string, number> = icons ? { ICON_SCALE: icon.scale, ICON_MIN_PX: icon.minPx } : {};
      const make = (bucket: number, shapes: number) =>
        device.createRenderPipelineAsync({
          label: `nodes/bucket${bucket}#${shapes}${icons ? "#icons" : ""}`,
          layout: pipelineLayout,
          vertex: { module, entryPoint: icons ? "vs_icons" : "vs", constants: { BUCKET: bucket, NODE_SHAPES: shapes, ...iconConstants } },
          fragment: { module, entryPoint: icons ? "fs_icons" : "fs", targets: [{ format, blend }], constants: { NODE_SHAPES: shapes, ...iconConstants } },
          primitive: { topology: "triangle-strip" },
        });
      const byShapes = async (shapes: number) => {
        const built = await Promise.all(BUCKETS.map((b) => make(b, shapes)));
        const pipelines: GPURenderPipeline[] = [];
        BUCKETS.forEach((b, k) => (pipelines[b] = built[k]!));
        return pipelines;
      };
      return { layout, pipelines: await Promise.all([byShapes(0), byShapes(1)]) };
    };
    return new NodeGeometryPass(device, await variant(false), () => variant(true));
  }

  /** (Re)bind the cull outputs; cheap no-op when unchanged. */
  bind(outputs: CullOutputs): void {
    if (outputs.version === this.boundVersion) return;
    this.boundVersion = outputs.version;
    this.scratch = outputs.scratch;
    this.instances = outputs.instances;
  }

  encode(pass: GPURenderPassEncoder, ctx: FrameContext): void {
    if (ctx.nodeCount === 0 || !this.scratch) return;
    const atlas = ctx.icons;
    const iconVariant = atlas ? this.iconVariant.value : null;
    const variant = iconVariant ?? this.plain;
    const icons = iconVariant ? atlas : null;
    const main = this.group(variant, icons, false);
    if (!main) return;
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, ctx.graphBindGroup);
    const pipelines = variant.pipelines[this.shapes ? 1 : 0]!;
    const layered = this.layers ? this.group(variant, icons, true) : null;
    for (let k = 0; k < BUCKETS.length; k++) {
      const b = BUCKETS[k]!;
      pass.setBindGroup(2, layered && b === ENGINE_CONSTANTS.BUCKET_NORMAL ? layered : main);
      pass.setPipeline(pipelines[b]!);
      pass.drawIndirect(this.scratch, ENGINE_CONSTANTS.SCRATCH_DRAW_ARGS * 4 + b * DRAW_ARGS_BYTES);
    }
    this.hover?.encodeNode(pass, ctx);
  }

  private group(variant: Variant, icons: IconAtlas | null, layered: boolean): GPUBindGroup | null {
    const instances = layered ? this.order?.layered : this.instances;
    if (!instances || !this.scratch) return null;
    const slot = this.groups[(icons ? 2 : 0) + (layered ? 1 : 0)]!;
    const order = layered ? this.order!.version : 0;
    const atlas = icons ? icons.version : 0;
    if (slot.group && slot.cull === this.boundVersion && slot.order === order && slot.atlas === atlas) return slot.group;
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.scratch } },
      { binding: 1, resource: { buffer: instances } },
    ];
    if (icons) entries.push({ binding: 8, resource: icons.sdfView }, { binding: 9, resource: icons.paletteView }, { binding: 10, resource: { buffer: icons.data } });
    slot.group = this.device.createBindGroup({ label: `group2/nodes${layered ? ".layered" : ""}${icons ? ".icons" : ""}`, layout: variant.layout, entries });
    slot.cull = this.boundVersion;
    slot.order = order;
    slot.atlas = atlas;
    return slot.group;
  }
}
