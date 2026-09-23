import type { Graph, NodePositionStream } from "@vhult/graph";

export interface GpuMotionSpec {
  count: number;
  data: Float32Array;
  params: readonly number[];
  wgsl: string;
}

const PARAMS = 32;
const WG = 256;
const READBACKS = 3;

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

export class GpuMotion {
  speed = 1;
  private time = 0;
  private last = 0;
  private raf = 0;
  private stopped = false;
  private sentTime = -1;
  private readonly free: GPUBuffer[] = [];
  private readonly uniform = new ArrayBuffer(16 + PARAMS * 4);

  private constructor(
    private readonly device: GPUDevice,
    private readonly stream: NodePositionStream,
    private readonly count: number,
    private readonly pipeline: GPUComputePipeline,
    private readonly bindGroup: GPUBindGroup,
    private readonly params: GPUBuffer,
    private readonly out: GPUBuffer,
    readbacks: GPUBuffer[],
    private readonly groups: [number, number],
    values: readonly number[],
  ) {
    this.free.push(...readbacks);
    const u = new Uint32Array(this.uniform);
    u[1] = count;
    u[2] = groups[0];
    new Float32Array(this.uniform, 16, PARAMS).set(values.slice(0, PARAMS));
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
    const module = device.createShaderModule({ label: "motion", code: prelude + spec.wgsl + entry });
    const pipeline = await device.createComputePipelineAsync({ label: "motion", layout: "auto", compute: { module, entryPoint: "main" } });
    const bytes = spec.count * 8;
    const params = device.createBuffer({ label: "motion/params", size: 16 + PARAMS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const data = device.createBuffer({ label: "motion/data", size: Math.max(16, spec.data.byteLength), usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
    new Float32Array(data.getMappedRange()).set(spec.data);
    data.unmap();
    const out = device.createBuffer({ label: "motion/out", size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readbacks = Array.from({ length: READBACKS }, (_, k) =>
      device.createBuffer({ label: `motion/readback${k}`, size: Math.max(16, bytes), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    );
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: { buffer: data } },
        { binding: 2, resource: { buffer: out } },
      ],
    });
    const total = Math.ceil(spec.count / WG);
    const gx = Math.min(total, device.limits.maxComputeWorkgroupsPerDimension);
    const motion = new GpuMotion(device, graph.streamNodePositions(), spec.count, pipeline, bindGroup, params, out, readbacks, [gx, Math.ceil(total / gx)], spec.params);
    motion.raf = requestAnimationFrame(motion.tick);
    return motion;
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
    const buf = this.free.pop();
    if (buf && this.time !== this.sentTime) this.step(buf);
    this.raf = requestAnimationFrame(this.tick);
  };

  private step(buf: GPUBuffer): void {
    this.sentTime = this.time;
    new Float32Array(this.uniform, 0, 1)[0] = this.time;
    this.device.queue.writeBuffer(this.params, 0, this.uniform);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(this.groups[0], this.groups[1]);
    pass.end();
    enc.copyBufferToBuffer(this.out, 0, buf, 0, this.count * 8);
    this.device.queue.submit([enc.finish()]);
    buf.mapAsync(GPUMapMode.READ).then(
      () => {
        if (this.stopped) return;
        this.stream.positions.set(new Float32Array(buf.getMappedRange(0, this.count * 8)));
        buf.unmap();
        this.stream.commit();
        this.free.push(buf);
      },
      () => undefined,
    );
  }
}
