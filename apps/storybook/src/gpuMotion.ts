import type { Graph, NodeStream } from "@vhult/graph";

export interface GpuMotionSpec {
  count: number;
  data: Float32Array;
  params: readonly number[];
  wgsl: string;
  depth?: boolean;
  colors?: boolean;
}

const PARAMS = 32;
const WG = 256;
const READBACKS = 3;
const LAYERS = 16;

const prelude = `
struct Motion {
  time : f32,
  count : u32,
  groupsX : u32,
  _pad : u32,
  params : array<vec4<f32>, ${PARAMS / 4}>,
}
@group(0) @binding(0) var<uniform> motion : Motion;
@group(0) @binding(1) var<storage, read> data : array<f32>;
@group(0) @binding(2) var<storage, read_write> out : array<vec2<f32>>;

fn param(k : u32) -> f32 {
  return motion.params[k / 4u][k % 4u];
}
`;

const entry = `
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) id : vec3<u32>) {
  let i = id.x + id.y * motion.groupsX * ${WG}u;
  if (i >= motion.count) {
    return;
  }
  out[i] = nodePosition(i, motion.time);
}
`;

const depthEntry = (colors: boolean) => `
@group(0) @binding(3) var<storage, read_write> layers : array<u32>;
${colors ? "@group(0) @binding(4) var<storage, read_write> colorsOut : array<u32>;" : ""}
var<workgroup> lanes : array<u32, ${WG}>;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) id : vec3<u32>, @builtin(local_invocation_index) lane : u32) {
  let i = id.x + id.y * motion.groupsX * ${WG}u;
  var layer = 0u;
  if (i < motion.count) {
    let p = nodePosition(i, motion.time);
    out[i] = p.xy;
    layer = u32(clamp(p.z, 0.0, 0.9999) * ${LAYERS}.0);
    ${colors ? "colorsOut[i] = pack4x8unorm(nodeColor(i, motion.time, p));" : ""}
  }
  lanes[lane] = layer;
  workgroupBarrier();
  if (lane % 4u == 0u && i < motion.count) {
    layers[i / 4u] = lanes[lane] | (lanes[lane + 1u] << 8u) | (lanes[lane + 2u] << 16u) | (lanes[lane + 3u] << 24u);
  }
}
`;

interface Readback {
  buffer: GPUBuffer;
  land: () => void;
}

const ignore = (): undefined => undefined;

const layerBytes = (count: number): number => Math.ceil(count / 4) * 4;

export class GpuMotion {
  speed = 1;
  depthOn = true;
  private time = 0;
  private last = 0;
  private raf = 0;
  private stopped = false;
  private sentTime = -1;
  private readonly free: Readback[] = [];
  private readonly uniform = new ArrayBuffer(16 + PARAMS * 4);
  private readonly timeWord = new Float32Array(this.uniform, 0, 1);
  private readonly paramWords = new Float32Array(this.uniform, 16, PARAMS);
  private readonly colorsAt: number;
  private readonly layersAt: number;
  private readonly layerBytes: number;

  private constructor(
    private readonly device: GPUDevice,
    private readonly stream: NodeStream,
    private readonly count: number,
    private readonly pipeline: GPUComputePipeline,
    private readonly bindGroup: GPUBindGroup,
    private readonly params: GPUBuffer,
    private readonly out: GPUBuffer,
    private readonly layers: GPUBuffer | null,
    private readonly colorsOut: GPUBuffer | null,
    readbacks: GPUBuffer[],
    private readonly groups: [number, number],
    values: readonly number[],
  ) {
    this.colorsAt = count * 8;
    this.layersAt = this.colorsAt + (colorsOut ? count * 4 : 0);
    this.layerBytes = layerBytes(count);
    for (const buffer of readbacks) {
      const r: Readback = { buffer, land: ignore };
      r.land = () => this.land(r);
      this.free.push(r);
    }
    const u = new Uint32Array(this.uniform);
    u[1] = count;
    u[2] = groups[0];
    this.paramWords.set(values.slice(0, PARAMS));
  }

  static async start(graph: Graph, spec: GpuMotionSpec): Promise<GpuMotion> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("GpuMotion: no WebGPU adapter");
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    const depth = spec.depth === true;
    const colors = depth && spec.colors === true;
    const module = device.createShaderModule({ label: "motion", code: prelude + spec.wgsl + (depth ? depthEntry(colors) : entry) });
    const pipeline = await device.createComputePipelineAsync({ label: "motion", layout: "auto", compute: { module, entryPoint: "main" } });
    const bytes = spec.count * 8;
    const params = device.createBuffer({ label: "motion/params", size: 16 + PARAMS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const data = device.createBuffer({ label: "motion/data", size: Math.max(16, spec.data.byteLength), usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
    new Float32Array(data.getMappedRange()).set(spec.data);
    data.unmap();
    const out = device.createBuffer({ label: "motion/out", size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const layers = depth ? device.createBuffer({ label: "motion/layers", size: Math.max(16, layerBytes(spec.count)), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }) : null;
    const colorsOut = colors ? device.createBuffer({ label: "motion/colors", size: Math.max(16, spec.count * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }) : null;
    const readBytes = bytes + (colors ? spec.count * 4 : 0) + (depth ? layerBytes(spec.count) : 0);
    const readbacks = Array.from({ length: READBACKS }, (_, k) =>
      device.createBuffer({ label: `motion/readback${k}`, size: Math.max(16, readBytes), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    );
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: { buffer: data } },
        { binding: 2, resource: { buffer: out } },
        ...(layers ? [{ binding: 3, resource: { buffer: layers } }] : []),
        ...(colorsOut ? [{ binding: 4, resource: { buffer: colorsOut } }] : []),
      ],
    });
    const total = Math.ceil(spec.count / WG);
    const gx = Math.min(total, device.limits.maxComputeWorkgroupsPerDimension);
    const stream = graph.nodes.stream({ positions: true, zIndex: depth, colors });
    const motion = new GpuMotion(device, stream, spec.count, pipeline, bindGroup, params, out, layers, colorsOut, readbacks, [gx, Math.ceil(total / gx)], spec.params);
    motion.raf = requestAnimationFrame(motion.tick);
    return motion;
  }

  get elapsed(): number {
    return this.time;
  }

  setParam(index: number, value: number): void {
    this.paramWords[index] = value;
    this.sentTime = -1;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    this.device.destroy();
  }

  private readonly tick = (now: number): void => {
    if (this.stopped) return;
    const dt = this.last === 0 ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt * this.speed;
    if (this.free.length > 0 && this.time !== this.sentTime) this.step(this.free.pop()!);
    this.raf = requestAnimationFrame(this.tick);
  };

  private step(r: Readback): void {
    const buf = r.buffer;
    this.sentTime = this.time;
    this.timeWord[0] = this.time;
    this.device.queue.writeBuffer(this.params, 0, this.uniform);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(this.groups[0], this.groups[1]);
    pass.end();
    enc.copyBufferToBuffer(this.out, 0, buf, 0, this.count * 8);
    if (this.colorsOut) enc.copyBufferToBuffer(this.colorsOut, 0, buf, this.colorsAt, this.count * 4);
    if (this.layers) enc.copyBufferToBuffer(this.layers, 0, buf, this.layersAt, this.layerBytes);
    this.device.queue.submit([enc.finish()]);
    buf.mapAsync(GPUMapMode.READ).then(r.land, ignore);
  }

  private land(r: Readback): void {
    if (this.stopped) return;
    const bytes = r.buffer.getMappedRange();
    const s = this.stream;
    s.positions.set(new Float32Array(bytes, 0, this.count * 2));
    if (this.colorsOut) s.colors.set(new Uint32Array(bytes, this.colorsAt, this.count));
    if (this.layers) {
      if (this.depthOn) s.zIndex.set(new Uint8Array(bytes, this.layersAt, this.count));
      else s.zIndex.fill(0);
    }
    r.buffer.unmap();
    s.commit();
    this.free.push(r);
  }
}
