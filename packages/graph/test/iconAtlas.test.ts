import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Gpu } from "../src/gpu/Device";

vi.mock("../src/gpu/ShaderModules", () => ({ createShaderModule: async () => ({}) }));

type AtlasCtor = typeof import("../src/icons/IconAtlas").IconAtlas;
let IconAtlas: AtlasCtor;

const SQUARE = { path: "M0 0H1V1H0Z" };
const BAD = { path: "M0 0 n" };

beforeAll(async () => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 });
  vi.stubGlobal("GPUBufferUsage", { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
  vi.stubGlobal("GPUTextureUsage", { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4 });
  ({ IconAtlas } = await import("../src/icons/IconAtlas"));
});

function fakeGpu() {
  const blanked: number[] = [];
  const built: number[] = [];
  const pass = { setBindGroup() {}, setPipeline() {}, dispatchWorkgroups() {}, end() {} };
  const device = {
    limits: { maxTextureArrayLayers: 256, maxComputeWorkgroupsPerDimension: 65535 },
    createTexture: (d: { size: number[] }) => ({ depthOrArrayLayers: d.size[2] ?? 1, createView: () => ({}), destroy() {} }),
    createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, getMappedRange: (_o = 0, len = d.size) => new ArrayBuffer(len), unmap() {}, destroy() {} }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createBindGroup: () => ({}),
    createComputePipelineAsync: async () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => pass,
      copyTextureToTexture() {},
      copyBufferToTexture: (_src: unknown, dst: { mipLevel: number; origin: { z: number } }, size: number[]) => {
        if (dst.mipLevel === 0) for (let k = 0; k < size[2]!; k++) built.push(dst.origin.z + k);
      },
      finish: () => ({}),
    }),
    queue: {
      writeTexture: (dst: { mipLevel: number; origin: { z: number } }) => {
        if (dst.mipLevel === 0) blanked.push(dst.origin.z);
      },
      writeBuffer() {},
      submit() {},
    },
  };
  return { gpu: { device, memory: { bytes: 0, peak: 0 } } as unknown as Gpu, blanked, built };
}

describe("IconAtlas", () => {
  it("builds the good icons of a define, blanks the bad one and packs once", async () => {
    const { gpu, blanked, built } = fakeGpu();
    const atlas = await IconAtlas.create(gpu);
    const version = atlas.version;
    const failed = atlas.define([SQUARE, BAD, SQUARE]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/icon 1/);
    expect(built).toEqual([0, 2]);
    expect(blanked).toEqual([1]);
    expect(atlas.count).toBe(3);
    expect(atlas.version).toBe(version + 1);
  });

  it("resolves a define where every icon is bad, with each one blank", async () => {
    const { gpu, blanked, built } = fakeGpu();
    const atlas = await IconAtlas.create(gpu);
    const version = atlas.version;
    expect(atlas.define([BAD, BAD])).toHaveLength(2);
    expect(built).toEqual([]);
    expect(blanked).toEqual([0, 1]);
    expect(atlas.count).toBe(2);
    expect(atlas.version).toBe(version + 1);
  });

  it("keeps the id of a bad icon added past the set and blanks its layer", async () => {
    const { gpu, blanked } = fakeGpu();
    const atlas = await IconAtlas.create(gpu);
    atlas.define([SQUARE, SQUARE]);
    const failed = atlas.defineAt(new Uint16Array([4]), [BAD]);
    expect(failed).toHaveLength(1);
    expect(atlas.count).toBe(5);
    expect(blanked).toEqual([4]);
  });

  it("clear blanks the ids in the set and ignores ids past it", async () => {
    const { gpu, blanked } = fakeGpu();
    const atlas = await IconAtlas.create(gpu);
    atlas.define([SQUARE, SQUARE]);
    const version = atlas.version;
    atlas.clear(new Uint16Array([9]));
    expect(atlas.version).toBe(version);
    atlas.clear(new Uint16Array([1]));
    expect(blanked).toEqual([1]);
    expect(atlas.version).toBe(version + 1);
  });
});
