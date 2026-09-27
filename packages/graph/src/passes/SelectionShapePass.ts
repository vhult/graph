import type { RGBA } from "../api/types";
import { MAX_SHAPE_POINTS } from "../data/QueryShape";
import type { ContractLayouts } from "../gpu/BindLayouts";
import { PREMULTIPLIED, type FrameContext } from "../gpu/FrameGraph";
import { createShaderModule } from "../gpu/ShaderModules";

const PARAM_BYTES = 64;

export class SelectionShapePass {
  private readonly params: GPUBuffer;
  private readonly points: GPUBuffer;
  private readonly paramData = new ArrayBuffer(PARAM_BYTES);
  private readonly f32 = new Float32Array(this.paramData);
  private readonly u32 = new Uint32Array(this.paramData);
  private readonly group: GPUBindGroup;
  private count = 0;

  private constructor(
    private readonly device: GPUDevice,
    layout: GPUBindGroupLayout,
    private readonly empty: GPUBindGroup,
    private readonly fill: GPURenderPipeline,
    private readonly stroke: GPURenderPipeline,
  ) {
    this.params = device.createBuffer({ label: "selection/params", size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.points = device.createBuffer({ label: "selection/points", size: MAX_SHAPE_POINTS * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.group = device.createBindGroup({
      label: "selection",
      layout,
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.points } },
      ],
    });
  }

  static async create(device: GPUDevice, format: GPUTextureFormat, contract: ContractLayouts): Promise<SelectionShapePass> {
    const module = await createShaderModule(device, "passes/selection_shape.wgsl");
    const V = GPUShaderStage.VERTEX;
    const F = GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      label: "selection",
      entries: [
        { binding: 0, visibility: V | F, buffer: { type: "uniform" } },
        { binding: 1, visibility: V | F, buffer: { type: "read-only-storage" } },
      ],
    });
    const emptyLayout = device.createBindGroupLayout({ label: "empty", entries: [] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [contract.frame, emptyLayout, layout] });
    const make = (stage: "fill" | "stroke") =>
      device.createRenderPipelineAsync({
        label: `selection/${stage}`,
        layout: pipelineLayout,
        vertex: { module, entryPoint: `vs_${stage}` },
        fragment: { module, entryPoint: `fs_${stage}`, targets: [{ format, blend: PREMULTIPLIED }] },
        primitive: { topology: "triangle-strip" },
      });
    const [fill, stroke] = await Promise.all([make("fill"), make("stroke")]);
    const empty = device.createBindGroup({ layout: emptyLayout, entries: [] });
    return new SelectionShapePass(device, layout, empty, fill, stroke);
  }

  setColors(fill: RGBA, stroke: RGBA): void {
    const f = this.f32;
    for (let k = 0; k < 3; k++) {
      f[4 + k] = fill[k]! * fill[3];
      f[8 + k] = stroke[k]! * stroke[3];
    }
    f[7] = fill[3];
    f[11] = stroke[3];
    this.device.queue.writeBuffer(this.params, 0, this.paramData);
  }

  setShape(points: Float32Array, count: number, strokePx: number): void {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < count * 2; k += 2) {
      x0 = Math.min(x0, points[k]!);
      x1 = Math.max(x1, points[k]!);
      y0 = Math.min(y0, points[k + 1]!);
      y1 = Math.max(y1, points[k + 1]!);
    }
    const f = this.f32;
    f[0] = x0;
    f[1] = y0;
    f[2] = x1;
    f[3] = y1;
    this.u32[12] = count;
    f[13] = strokePx;
    this.count = count;
    this.device.queue.writeBuffer(this.points, 0, points, 0, count * 2);
    this.device.queue.writeBuffer(this.params, 0, this.paramData);
  }

  hide(): void {
    this.count = 0;
  }

  encode(pass: GPURenderPassEncoder, ctx: FrameContext): void {
    if (this.count < 2) return;
    pass.setBindGroup(0, ctx.frameBindGroup);
    pass.setBindGroup(1, this.empty);
    pass.setBindGroup(2, this.group);
    if (this.count > 2) {
      pass.setPipeline(this.fill);
      pass.draw(4);
    }
    pass.setPipeline(this.stroke);
    pass.draw(4, this.count);
  }

  destroy(): void {
    this.params.destroy();
    this.points.destroy();
  }
}
