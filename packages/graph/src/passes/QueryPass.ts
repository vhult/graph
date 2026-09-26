import { GraphError } from "../api/errors";
import { MAX_SHAPE_POINTS } from "../data/QueryShape";
import { WORKGROUP_SIZE } from "../data/Layouts";
import type { ContractLayouts } from "../gpu/BindLayouts";
import type { GraphBuffers } from "../gpu/GraphBuffers";
import { Lazy } from "../gpu/Lazy";
import { createShaderModule } from "../gpu/ShaderModules";

export type QueryDone = (nodes: Uint32Array) => void;
export type QueryFail = (error: GraphError) => void;

interface Job {
  points: Float32Array;
  done: QueryDone;
  fail: QueryFail;
}

const PARAM_BYTES = 32;
const MAX_GROUPS_X = 65535;

export class QueryPass {
  private readonly params: GPUBuffer;
  private readonly paramData = new ArrayBuffer(PARAM_BYTES);
  private readonly paramF32 = new Float32Array(this.paramData);
  private readonly paramU32 = new Uint32Array(this.paramData);
  private readonly points: GPUBuffer;
  private readonly countRead: GPUBuffer;
  private readonly pipeline: Lazy<GPUComputePipeline>;
  private readonly graphLayout: GPUBindGroupLayout;
  private readonly layout: GPUBindGroupLayout;
  private readonly key: unknown[] = [null, null, null, null];
  private readonly jobs: Job[] = [];
  private out: GPUBuffer | null = null;
  private graphGroup: GPUBindGroup | null = null;
  private group: GPUBindGroup | null = null;
  private busy = false;
  private destroyed = false;
  private loadError: GraphError | null = null;

  constructor(
    private readonly device: GPUDevice,
    contract: ContractLayouts,
    private readonly wake: () => void,
    onError: (e: GraphError) => void,
  ) {
    const STAGE = GPUShaderStage.COMPUTE;
    this.params = device.createBuffer({ label: "query/params", size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.points = device.createBuffer({ label: "query/points", size: MAX_SHAPE_POINTS * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.countRead = device.createBuffer({ label: "query/count", size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.graphLayout = device.createBindGroupLayout({
      label: "query/graph",
      entries: [
        { binding: 0, visibility: STAGE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: STAGE, buffer: { type: "read-only-storage" } },
      ],
    });
    this.layout = device.createBindGroupLayout({
      label: "query/io",
      entries: [
        { binding: 0, visibility: STAGE, buffer: { type: "uniform" } },
        { binding: 1, visibility: STAGE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: STAGE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: STAGE, buffer: { type: "storage" } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [contract.frame, this.graphLayout, this.layout] });
    this.pipeline = new Lazy(async () =>
      device.createComputePipelineAsync({
        label: "query/inside",
        layout,
        compute: { module: await createShaderModule(device, "passes/query_inside.wgsl"), entryPoint: "query_inside" },
      }),
    );
    this.pipeline.load().then(
      () => this.wake(),
      (e: unknown) => {
        const err = e instanceof GraphError ? e : new GraphError("internal", `query.inside: pipeline failed to load: ${String(e)}`);
        this.loadError = err;
        onError(err);
        if (this.destroyed) return;
        for (const job of this.jobs.splice(0)) job.fail(err);
      },
    );
  }

  get ready(): boolean {
    return !this.busy && this.jobs.length > 0 && this.pipeline.value !== null;
  }

  request(points: Float32Array, done: QueryDone, fail: QueryFail): void {
    if (this.loadError) return fail(this.loadError);
    this.jobs.push({ points, done, fail });
    this.wake();
  }

  run(frameGroup: GPUBindGroup, graph: GraphBuffers, nodeCount: number): void {
    const pipeline = this.pipeline.value;
    if (!pipeline || this.busy || this.destroyed) return;
    while (this.jobs.length > 0 && nodeCount === 0) this.jobs.shift()!.done(new Uint32Array(0));
    const job = this.jobs.shift();
    if (!job) return;
    const pts = job.points;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < pts.length; k += 2) {
      x0 = Math.min(x0, pts[k]!);
      x1 = Math.max(x1, pts[k]!);
      y0 = Math.min(y0, pts[k + 1]!);
      y1 = Math.max(y1, pts[k + 1]!);
    }
    const groups = Math.ceil(nodeCount / WORKGROUP_SIZE);
    const gridX = Math.min(groups, MAX_GROUPS_X);
    const gridY = Math.ceil(groups / gridX);
    const f = this.paramF32;
    const u = this.paramU32;
    f[0] = x0;
    f[1] = y0;
    f[2] = x1;
    f[3] = y1;
    u[4] = pts.length / 2;
    u[5] = nodeCount;
    u[6] = gridX;
    const device = this.device;
    device.queue.writeBuffer(this.params, 0, this.paramData);
    device.queue.writeBuffer(this.points, 0, pts);

    const bytes = (nodeCount + 1) * 4;
    if (!this.out || this.out.size < bytes) {
      this.out?.destroy();
      this.out = device.createBuffer({ label: "query/out", size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    }
    const out = this.out;
    this.bind(graph, out);
    const encoder = device.createCommandEncoder();
    encoder.clearBuffer(out, 0, 4);
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, frameGroup);
    pass.setBindGroup(1, this.graphGroup!);
    pass.setBindGroup(2, this.group!);
    pass.dispatchWorkgroups(gridX, gridY);
    pass.end();
    encoder.copyBufferToBuffer(out, 0, this.countRead, 0, 4);
    device.queue.submit([encoder.finish()]);
    this.busy = true;
    this.countRead.mapAsync(GPUMapMode.READ).then(
      () => {
        const n = new Uint32Array(this.countRead.getMappedRange())[0]!;
        this.countRead.unmap();
        if (this.destroyed) return;
        if (n === 0) this.finish(job, new Uint32Array(0));
        else this.readNodes(job, out, n);
      },
      (e: unknown) => this.fail(job, e),
    );
  }

  private readNodes(job: Job, out: GPUBuffer, n: number): void {
    const device = this.device;
    const read = device.createBuffer({ label: "query/read", size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(out, 4, read, 0, n * 4);
    device.queue.submit([encoder.finish()]);
    read.mapAsync(GPUMapMode.READ).then(
      () => {
        const nodes = new Uint32Array(read.getMappedRange()).slice();
        read.destroy();
        this.finish(job, nodes);
      },
      (e: unknown) => {
        read.destroy();
        this.fail(job, e);
      },
    );
  }

  private finish(job: Job, nodes: Uint32Array): void {
    this.busy = false;
    if (this.destroyed) return;
    job.done(nodes);
    if (this.jobs.length > 0) this.wake();
  }

  private fail(job: Job, e: unknown): void {
    this.busy = false;
    if (this.destroyed) return;
    job.fail(new GraphError("internal", `query.inside: readback failed: ${String(e)}`));
    if (this.jobs.length > 0) this.wake();
  }

  private bind(graph: GraphBuffers, out: GPUBuffer): void {
    const b = graph.buffers;
    const k = this.key;
    if (k[0] !== b.nodePos || k[1] !== b.nodeState || !this.graphGroup) {
      k[0] = b.nodePos;
      k[1] = b.nodeState;
      this.graphGroup = this.device.createBindGroup({
        label: "query/graph",
        layout: this.graphLayout,
        entries: [
          { binding: 0, resource: { buffer: b.nodePos } },
          { binding: 4, resource: { buffer: b.nodeState } },
        ],
      });
    }
    if (k[2] !== graph.order || k[3] !== out || !this.group) {
      k[2] = graph.order;
      k[3] = out;
      this.group = this.device.createBindGroup({
        label: "query/io",
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.params } },
          { binding: 1, resource: { buffer: this.points } },
          { binding: 2, resource: { buffer: graph.order } },
          { binding: 3, resource: { buffer: out } },
        ],
      });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.params.destroy();
    this.points.destroy();
    this.countRead.destroy();
    this.out?.destroy();
  }
}
