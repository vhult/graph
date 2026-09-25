import { GraphError } from "../api/errors";
import type { IconSource } from "../api/types";
import { ICON_CONSTANTS } from "../data/Layouts";
import { maxIcons } from "../gpu/Caps";
import type { Gpu } from "../gpu/Device";
import { createShaderModule } from "../gpu/ShaderModules";
import { buildIcons } from "./IconGeometry";

const { ICON_TILE, ICON_PALETTE_WIDTH } = ICON_CONSTANTS;
const LEVELS = 4;
const ROW_BYTES = 256;
const SDF_WG = 64;
const SDF_TEXEL_BYTES = 2;

export class IconAtlas {
  count = 0;
  version = 0;
  paletteVersion = -1;
  sdfView: GPUTextureView;
  paletteView: GPUTextureView;
  data: GPUBuffer;
  private sdf: GPUTexture;
  private palette: GPUTexture;
  private paletteRows = 0;

  private constructor(
    private readonly device: GPUDevice,
    private readonly memory: Gpu["memory"],
    private readonly layout: GPUBindGroupLayout,
    private readonly boundary: GPUComputePipeline,
    private readonly field: GPUComputePipeline,
    private readonly empty: GPUBindGroup,
  ) {
    this.sdf = this.sdfTexture(1);
    this.sdfView = this.sdf.createView({ dimension: "2d-array" });
    this.palette = this.paletteTexture(1);
    this.paletteView = this.palette.createView();
    this.data = this.dataBuffer(new Uint32Array(4));
  }

  static async create(gpu: Gpu): Promise<IconAtlas> {
    const device = gpu.device;
    const module = await createShaderModule(device, "passes/icon_sdf.wgsl");
    const e = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    const layout = device.createBindGroupLayout({ label: "group2/icons.sdf", entries: [e(0, "uniform"), e(1, "read-only-storage"), e(2, "storage"), e(3, "storage")] });
    const emptyLayout = device.createBindGroupLayout({ label: "empty", entries: [] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [emptyLayout, emptyLayout, layout] });
    const make = (entryPoint: string) => device.createComputePipelineAsync({ label: `icons/${entryPoint}`, layout: pipelineLayout, compute: { module, entryPoint } });
    const [boundary, field] = await Promise.all([make("icon_boundary"), make("icon_sdf")]);
    return new IconAtlas(device, gpu.memory, layout, boundary, field, device.createBindGroup({ layout: emptyLayout, entries: [] }));
  }

  define(sources: readonly IconSource[]): void {
    const max = maxIcons(this.device);
    if (sources.length > max) throw new GraphError("limits-exceeded", `defineIcons: this GPU holds at most ${max} icons`);
    const set = buildIcons(sources);
    const data = this.dataBuffer(set.data);
    const sdf = this.sdfTexture(Math.max(1, set.count));
    if (set.count > 0) this.generate(data, sdf, set.count, set.curves, set.maxCurves);
    this.data.destroy();
    this.dropSdf();
    this.data = data;
    this.sdf = sdf;
    this.sdfView = sdf.createView({ dimension: "2d-array" });
    this.count = set.count;
    this.version++;
  }

  setPalette(colors: Uint32Array, version: number): void {
    const rows = Math.max(1, Math.ceil(colors.length / ICON_PALETTE_WIDTH));
    if (rows > this.paletteRows) {
      this.palette.destroy();
      this.track(-this.paletteRows * ICON_PALETTE_WIDTH * 4);
      this.palette = this.paletteTexture(rows);
      this.paletteView = this.palette.createView();
      this.version++;
    }
    const texels = new Uint32Array(rows * ICON_PALETTE_WIDTH);
    texels.set(colors);
    this.device.queue.writeTexture({ texture: this.palette }, texels, { bytesPerRow: ICON_PALETTE_WIDTH * 4 }, [ICON_PALETTE_WIDTH, rows]);
    this.paletteVersion = version;
  }

  destroy(): void {
    this.dropSdf();
    this.palette.destroy();
    this.track(-this.paletteRows * ICON_PALETTE_WIDTH * 4);
    this.paletteRows = 0;
    this.data.destroy();
  }

  private generate(data: GPUBuffer, sdf: GPUTexture, layers: number, curves: number, maxCurves: number): void {
    const device = this.device;
    const maxX = device.limits.maxComputeWorkgroupsPerDimension;
    const offsets: number[] = [];
    let bytes = 0;
    for (let level = 0; level < LEVELS; level++) {
      offsets.push(bytes);
      bytes += ROW_BYTES * (ICON_TILE >> level) * layers;
    }
    const out = device.createBuffer({ label: "icons/sdf.out", size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const edges = device.createBuffer({ label: "icons/sdf.edges", size: Math.max(16, Math.ceil((curves * 4) / 16) * 16), usage: GPUBufferUsage.STORAGE });
    const params = device.createBuffer({ label: "icons/sdf.params", size: 256 * LEVELS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const words = new Uint32Array(64 * LEVELS);
    const group = (level: number) =>
      device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: params, offset: level * 256, size: 16 } },
          { binding: 1, resource: { buffer: data } },
          { binding: 2, resource: { buffer: out, offset: offsets[level]!, size: ROW_BYTES * (ICON_TILE >> level) * layers } },
          { binding: 3, resource: { buffer: edges } },
        ],
      });
    const encoder = device.createCommandEncoder({ label: "icons/sdf" });
    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, this.empty);
    pass.setBindGroup(1, this.empty);
    pass.setPipeline(this.boundary);
    pass.setBindGroup(2, group(0));
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(maxCurves / SDF_WG)), layers);
    pass.setPipeline(this.field);
    for (let level = 0; level < LEVELS; level++) {
      const res = ICON_TILE >> level;
      const groups = Math.ceil(((res / 2) * res * layers) / SDF_WG);
      const gx = Math.min(groups, maxX);
      words.set([res, layers, ROW_BYTES / 4, gx], level * 64);
      pass.setBindGroup(2, group(level));
      pass.dispatchWorkgroups(gx, Math.ceil(groups / gx));
    }
    pass.end();
    for (let level = 0; level < LEVELS; level++) {
      const res = ICON_TILE >> level;
      encoder.copyBufferToTexture({ buffer: out, offset: offsets[level]!, bytesPerRow: ROW_BYTES, rowsPerImage: res }, { texture: sdf, mipLevel: level }, [res, res, layers]);
    }
    device.queue.writeBuffer(params, 0, words);
    device.queue.submit([encoder.finish()]);
    out.destroy();
    edges.destroy();
    params.destroy();
  }

  private sdfTexture(layers: number): GPUTexture {
    let bytes = 0;
    for (let level = 0; level < LEVELS; level++) bytes += (ICON_TILE >> level) ** 2 * layers * SDF_TEXEL_BYTES;
    this.track(bytes);
    return this.device.createTexture({
      label: "icons/sdf",
      size: [ICON_TILE, ICON_TILE, layers],
      mipLevelCount: LEVELS,
      format: "r16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  private dropSdf(): void {
    let bytes = 0;
    for (let level = 0; level < LEVELS; level++) bytes += (ICON_TILE >> level) ** 2 * this.sdf.depthOrArrayLayers * SDF_TEXEL_BYTES;
    this.sdf.destroy();
    this.track(-bytes);
  }

  private paletteTexture(rows: number): GPUTexture {
    this.paletteRows = rows;
    this.track(rows * ICON_PALETTE_WIDTH * 4);
    return this.device.createTexture({
      label: "icons/palette",
      size: [ICON_PALETTE_WIDTH, rows],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  private track(bytes: number): void {
    const m = this.memory;
    m.bytes += bytes;
    m.peak = Math.max(m.peak, m.bytes);
  }

  private dataBuffer(words: Uint32Array): GPUBuffer {
    const buffer = this.device.createBuffer({ label: "icons/data", size: Math.max(16, Math.ceil(words.byteLength / 16) * 16), usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
    new Uint32Array(buffer.getMappedRange(0, words.byteLength)).set(words);
    buffer.unmap();
    return buffer;
  }
}
