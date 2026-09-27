import { beforeAll, describe, expect, it, vi } from "vitest";
import { Dirty } from "../src/engine/Dirty";
import type { FrameContext } from "../src/gpu/FrameGraph";
import type { ScatterSlot } from "../src/gpu/PermuteKernels";

type EdgeCull = typeof import("../src/passes/EdgeCullPass").EdgeCullPass;
type TransformCull = typeof import("../src/passes/TransformCullPass").TransformCullPass;
let EdgeCullPass: EdgeCull;
let TransformCullPass: TransformCull;

vi.mock("../src/gpu/ShaderModules", () => ({ createShaderModule: () => Promise.reject(new Error("no GPU in tests")) }));

beforeAll(async () => {
  vi.stubGlobal("GPUBufferUsage", { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 });
  ({ EdgeCullPass } = await import("../src/passes/EdgeCullPass"));
  ({ TransformCullPass } = await import("../src/passes/TransformCullPass"));
});

function fakeGpu() {
  const writes: { buffer: string; offset: number }[] = [];
  const pipes: string[] = [];
  const device = {
    limits: { maxStorageBufferBindingSize: 2 ** 30, maxBufferSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535 },
    createBuffer: (d: GPUBufferDescriptor) => ({ label: d.label, size: d.size, destroy() {} }),
    createBindGroup: () => ({}),
    queue: { writeBuffer: (b: GPUBuffer, offset: number) => writes.push({ buffer: b.label, offset }) },
  } as unknown as GPUDevice;
  const encoder = {
    setPipeline: (p: string) => pipes.push(p),
    setBindGroup() {},
    dispatchWorkgroups() {},
    dispatchWorkgroupsIndirect() {},
  } as unknown as GPUComputePassEncoder;
  return { device, encoder, writes, pipes };
}

function frame(nodeCount: number, edgeCount: number, dirty: number): FrameContext {
  return { frameBindGroup: {} as GPUBindGroup, graphBindGroup: {} as GPUBindGroup, nodeCount, edgeCount, dirty, icons: null };
}

function edgePass(device: GPUDevice) {
  const Ctor = EdgeCullPass as unknown as new (...args: unknown[]) => import("../src/passes/EdgeCullPass").EdgeCullPass;
  const layouts = { state: {}, bounds: {}, expand: {}, touch: {}, restyle: {} };
  return new Ctor(device, layouts, "bounds", "boundsLines", "boundsList", "boundsListLines", "touch", "restyle", () => Promise.resolve("cull"), "expand", {});
}

function cullPass(device: GPUDevice) {
  const Ctor = TransformCullPass as unknown as new (...args: unknown[]) => import("../src/passes/TransformCullPass").TransformCullPass;
  const layouts = { state: {}, scan: {}, scatter: {}, list: {}, touch: {} };
  return new Ctor(device, layouts, "bounds", "boundsList", "touch", "reduce", "scan", "down", () => Promise.resolve({}));
}

describe("edge cull move state", () => {
  const E = 4096;

  function ready() {
    const gpu = fakeGpu();
    const pass = edgePass(gpu.device);
    pass.reserve(E, () => {});
    const full = frame(0, E, Dirty.POSITIONS);
    pass.prepare(full);
    pass.encodePhase(0, gpu.encoder, full);
    gpu.pipes.length = 0;
    gpu.writes.length = 0;
    return { ...gpu, pass };
  }

  it("runs the bounds phase for a pending touch on a frame with no move", () => {
    const { pass } = ready();
    expect(pass.phaseActive(0, frame(0, E, 0))).toBe(false);
    pass.moveNodes(E);
    expect(pass.phaseActive(0, frame(0, E, 0))).toBe(true);
  });

  it("refits the move list until the move ends, then leaves moved frames alone", () => {
    const { pass, encoder, pipes } = ready();
    pass.moveNodes(E);
    const moved = frame(0, E, Dirty.MOVED);
    pass.encodePhase(0, encoder, moved);
    expect(pipes).toEqual(["touch", "boundsList"]);
    expect(pass.phaseActive(0, moved)).toBe(true);
    pass.endMove();
    expect(pass.phaseActive(0, moved)).toBe(false);
  });

  it("refits every chunk for a restyle during a move and starts a fresh list once it ends", () => {
    const { pass, encoder, pipes, writes } = ready();
    const slot = { ranges: {}, params: {} } as ScatterSlot;
    pass.moveNodes(E);
    writes.length = 0;
    pass.restyle(0, {} as GPUBuffer, slot, 3, E);
    expect(writes).toEqual([]);
    pass.encodePhase(0, encoder, frame(0, E, Dirty.MOVED));
    expect(pipes).toEqual(["bounds"]);
    pass.endMove();
    pass.restyle(0, {} as GPUBuffer, slot, 3, E);
    expect(writes.map((w) => w.buffer)).toEqual(["edge/state"]);
  });

  it("drops a touch that never ran when the move ends", () => {
    const { pass } = ready();
    pass.moveNodes(E);
    pass.endMove();
    expect(pass.phaseActive(0, frame(0, E, Dirty.MOVED))).toBe(false);
  });
});

describe("transform cull move state", () => {
  const N = 4096;

  function ready() {
    const gpu = fakeGpu();
    const pass = cullPass(gpu.device);
    pass.reserve(N, () => {}, false);
    const full = frame(N, 0, Dirty.POSITIONS);
    pass.prepare(full);
    pass.encodePhase(0, gpu.encoder, full);
    gpu.pipes.length = 0;
    return { ...gpu, pass };
  }

  it("refits the move list until the move ends, then leaves moved frames alone", () => {
    const { pass, encoder, pipes } = ready();
    expect(pass.phaseActive(0, frame(N, 0, Dirty.MOVED))).toBe(false);
    pass.moveNodes();
    expect(pass.phaseActive(0, frame(N, 0, 0))).toBe(true);
    const moved = frame(N, 0, Dirty.MOVED);
    pass.encodePhase(0, encoder, moved);
    expect(pipes).toEqual(["touch", "boundsList"]);
    expect(pass.phaseActive(0, moved)).toBe(true);
    pass.endMove();
    expect(pass.phaseActive(0, moved)).toBe(false);
  });

  it("drops a touch that never ran when the move ends", () => {
    const { pass } = ready();
    pass.moveNodes();
    pass.endMove();
    expect(pass.phaseActive(0, frame(N, 0, Dirty.MOVED))).toBe(false);
  });
});
