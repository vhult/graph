import type { IconSource } from "../api/types";
import { ICON_CONSTANTS } from "../data/Layouts";
import { maxIcons } from "../gpu/Caps";
import type { Gpu } from "../gpu/Device";
import { createShaderModule } from "../gpu/ShaderModules";
import { packIcons, parseIcons, type BuiltIcon } from "./IconGeometry";

const { ICON_TILE, ICON_PALETTE_WIDTH } = ICON_CONSTANTS;
const LEVELS = 4;
const ROW_BYTES = 256;
const SDF_WG = 64;
const SDF_TEXEL_BYTES = 2;
const FAR_HALF = 0x3c00;

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
  private built: (BuiltIcon | null)[] = [];

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

  define(sources: readonly IconSource[]): string[] {
    this.dropSdf();
    this.setSdf(this.sdfTexture(Math.max(1, sources.length)));
    this.built = [];
    return this.defineAt(Uint16Array.from(sources.keys()), sources);
  }

  defineAt(ids: Uint16Array, sources: readonly IconSource[]): string[] {
    const { icons, failed } = parseIcons(sources);
    let top = 0;
    for (let k = 0; k < ids.length; k++) top = Math.max(top, ids[k]! + 1);
    while (this.built.length < top) this.built.push(null);
    const good: number[] = [];
    const bad: number[] = [];
    for (let k = 0; k < ids.length; k++) {
      this.built[ids[k]!] = icons[k]!;
      (icons[k] ? good : bad).push(k);
    }
    const layers = this.sdf.depthOrArrayLayers;
    if (top > layers) this.grow(Math.min(maxIcons(this.device), Math.max(top, layers * 2)));
    if (bad.length > 0) this.blank(Uint16Array.from(bad, (k) => ids[k]!));
    this.build(Uint16Array.from(good, (k) => ids[k]!), good.map((k) => icons[k]!));
    return failed;
  }

  clear(ids: Uint16Array): void {
    if (this.blank(ids)) this.pack();
  }

  private blank(ids: Uint16Array): boolean {
    const blank = new Uint16Array(ICON_TILE * ICON_TILE).fill(FAR_HALF);
    const queue = this.device.queue;
    let any = false;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]!;
      if (id >= this.built.length) continue;
      this.built[id] = null;
      any = true;
      for (let level = 0; level < LEVELS; level++) {
        const res = ICON_TILE >> level;
        queue.writeTexture({ texture: this.sdf, mipLevel: level, origin: { x: 0, y: 0, z: id } }, blank, { bytesPerRow: res * SDF_TEXEL_BYTES, rowsPerImage: res }, [res, res, 1]);
      }
    }
    return any;
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

  private build(ids: Uint16Array, built: readonly BuiltIcon[]): void {
    if (built.length > 0) {
      const set = packIcons(built);
      const data = this.dataBuffer(set.data);
      this.generate(data, ids, set.curves, set.maxCurves);
      data.destroy();
    }
    this.pack();
  }

  private pack(): void {
    const set = packIcons(this.built);
    this.data.destroy();
    this.data = this.dataBuffer(set.data);
    this.count = set.count;
    this.version++;
  }

  private grow(layers: number): void {
    const old = this.sdf;
    const next = this.sdfTexture(layers);
    const encoder = this.device.createCommandEncoder({ label: "icons/grow" });
    for (let level = 0; level < LEVELS; level++) {
      const res = ICON_TILE >> level;
      encoder.copyTextureToTexture({ texture: old, mipLevel: level }, { texture: next, mipLevel: level }, [res, res, old.depthOrArrayLayers]);
    }
    this.device.queue.submit([encoder.finish()]);
    this.dropSdf();
    this.setSdf(next);
  }

  private setSdf(sdf: GPUTexture): void {
    this.sdf = sdf;
    this.sdfView = sdf.createView({ dimension: "2d-array" });
  }

  private generate(data: GPUBuffer, ids: Uint16Array, curves: number, maxCurves: number): void {
    const layers = ids.length;
    const sdf = this.sdf;
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
    for (let k = 0; k < layers; ) {
      let run = 1;
      while (k + run < layers && ids[k + run] === ids[k]! + run) run++;
      for (let level = 0; level < LEVELS; level++) {
        const res = ICON_TILE >> level;
        encoder.copyBufferToTexture(
          { buffer: out, offset: offsets[level]! + k * ROW_BYTES * res, bytesPerRow: ROW_BYTES, rowsPerImage: res },
          { texture: sdf, mipLevel: level, origin: { x: 0, y: 0, z: ids[k]! } },
          [res, res, run],
        );
      }
      k += run;
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
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
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
