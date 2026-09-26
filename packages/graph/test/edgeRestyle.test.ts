import { beforeAll, describe, expect, it, vi } from "vitest";
import { Dirty, edgeUpdateDirty } from "../src/engine/Dirty";
import { GraphStore } from "../src/data/GraphStore";

type Buffers = typeof import("../src/gpu/GraphBuffers").GraphBuffers;
let GraphBuffers: Buffers;

beforeAll(async () => {
  vi.stubGlobal("GPUBufferUsage", { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 });
  ({ GraphBuffers } = await import("../src/gpu/GraphBuffers"));
});

function fakeBuffer(size: number): GPUBuffer {
  return { size, destroy() {}, unmap() {}, getMappedRange: () => new ArrayBuffer(size) } as unknown as GPUBuffer;
}

function setup(styles: boolean) {
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => fakeBuffer(d.size),
    createBindGroup: () => ({}),
    queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
  const slot = (label: string) => ({ label, params: fakeBuffer(16), ranges: fakeBuffer(512), upload: null, bindGroup: null, key: [] });
  const kernels = { createScatterSlot: slot, createLayerSlot: () => ({ params: fakeBuffer(16), upload: null, bindGroup: null, key: [] }) };
  const store = new GraphStore();
  store.setNodes(4, {});
  store.setEdges(3, { indices: new Uint32Array([0, 1, 1, 2, 2, 3]), styles: styles ? new Uint32Array(3) : undefined });
  const buffers = new GraphBuffers(device, {} as GPUBindGroupLayout, store, kernels as never);
  buffers.flush();
  buffers.edgesUnsorted = false;
  buffers.needsSort = false;
  buffers.setEdgeOrder(fakeBuffer(16));
  return { store, buffers };
}

describe("edge restyle", () => {
  it("updateAll with styles rebuilds every edge bound, index updates only restyle", () => {
    expect(edgeUpdateDirty({ styles: 1 }, true) & Dirty.EDGES).toBe(Dirty.EDGES);
    expect(edgeUpdateDirty({ indices: 1 }, false) & Dirty.EDGES).toBe(Dirty.EDGES);
    expect(edgeUpdateDirty({ styles: 1 }, false)).toBe(Dirty.STYLE);
    expect(edgeUpdateDirty({ colors: 1 } as { styles?: unknown }, true)).toBe(Dirty.STYLE);
  });

  it("a style update by index lists the restyled edges for the chunk bounds", () => {
    const { store, buffers } = setup(true);
    store.updateEdgesAt(new Uint32Array([2, 0]), { styles: new Uint32Array([64, 8]) }, 0);
    buffers.flush();
    expect(buffers.edgeRank).not.toBeNull();
    expect(buffers.restyledEdges).toBe(2);
    buffers.flush();
    expect(buffers.restyledEdges).toBe(0);
  });

  it("colour and state updates list nothing", () => {
    const { store, buffers } = setup(true);
    store.updateEdgesAt(new Uint32Array([1]), { colors: new Uint32Array([1, 2]) }, 0);
    store.flagEdges(new Uint32Array([1]), 8, true);
    buffers.flush();
    expect(buffers.restyledEdges).toBe(0);
  });
});
