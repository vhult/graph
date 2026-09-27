import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphError } from "../src/api/errors";
import type { ContractLayouts } from "../src/gpu/BindLayouts";
import { QueryPass } from "../src/passes/QueryPass";

vi.mock("../src/gpu/ShaderModules", () => ({ createShaderModule: async () => ({}) }));

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 });
  vi.stubGlobal("GPUBufferUsage", { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});

function failingDevice(): GPUDevice {
  return {
    createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, destroy() {} }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipelineAsync: () => Promise.reject(new Error("no pipeline")),
  } as unknown as GPUDevice;
}

describe("QueryPass", () => {
  it("fails every queued job and every later job when the pipeline does not load", async () => {
    const errors: GraphError[] = [];
    const failed: GraphError[] = [];
    const pass = new QueryPass(failingDevice(), { frame: {} } as ContractLayouts, () => {}, (e) => errors.push(e));
    const done = vi.fn();
    pass.request(new Float32Array(6), done, (e) => failed.push(e));
    pass.request(new Float32Array(6), done, (e) => failed.push(e));
    await vi.waitFor(() => expect(failed).toHaveLength(2));
    pass.request(new Float32Array(6), done, (e) => failed.push(e));
    expect(failed).toHaveLength(3);
    expect(errors).toHaveLength(1);
    for (const e of failed) expect(e).toBeInstanceOf(GraphError);
    expect(failed[0]!.message).toMatch(/no pipeline/);
    expect(done).not.toHaveBeenCalled();
    expect(pass.ready).toBe(false);
  });
});
