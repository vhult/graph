import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LabelSnapshot } from "../src/api/types";
import { Dirty } from "../src/engine/Dirty";
import type { FrameContext } from "../src/gpu/FrameGraph";
import type { LabelPass as LabelPassType } from "../src/passes/LabelPass";

let LabelPass: typeof import("../src/passes/LabelPass").LabelPass;

vi.mock("../src/gpu/ShaderModules", () => ({ createShaderModule: () => Promise.reject(new Error("no GPU in tests")) }));

beforeAll(async () => {
  vi.stubGlobal("GPUBufferUsage", { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
  ({ LabelPass } = await import("../src/passes/LabelPass"));
});

function frame(nodeCount: number, edgeCount = 0): FrameContext {
  return { frameBindGroup: {} as GPUBindGroup, graphBindGroup: {} as GPUBindGroup, nodeCount, edgeCount, dirty: Dirty.LABEL_QUERY, icons: null };
}

function setup(opts: { nodeText?: boolean; culled?: boolean } = {}) {
  const device = { createBuffer: (d: GPUBufferDescriptor) => ({ label: d.label, size: d.size, destroy() {} }) } as unknown as GPUDevice;
  const cull = { outputs: opts.culled === false ? null : { scratch: {} } };
  const labels = { hasNodeText: opts.nodeText ?? false, hasEdgeText: false };
  const Ctor = LabelPass as unknown as new (...args: unknown[]) => LabelPassType;
  const pass = new Ctor(device, { edgeOrder: null }, cull, { outputs: null }, labels, {}, {});
  const replies: [number, LabelSnapshot][] = [];
  pass.onSnapshot = (id, s) => replies.push([id, s]);
  return { pass, replies, encoder: {} as GPUCommandEncoder };
}

function expectEmpty(s: LabelSnapshot): void {
  expect(s.found).toBe(0);
  expect(s.capacity).toBe(0);
  for (const a of [s.center, s.halfWidth, s.halfHeight, s.rank, s.size, s.index, s.decision]) expect(a.length).toBe(0);
  expect(s.center).toBeInstanceOf(Float32Array);
  expect(s.index).toBeInstanceOf(Uint32Array);
  expect(s.decision).toBeInstanceOf(Uint8Array);
}

describe("LabelPass snapshot replies", () => {
  it("answers every request with an empty snapshot on an empty graph", () => {
    const { pass, replies, encoder } = setup({ nodeText: true });
    pass.requestSnapshot(1);
    pass.requestSnapshot(2);
    pass.recordReadback(encoder, frame(0));
    expect(replies.map(([id]) => id)).toEqual([1, 2]);
    for (const [, s] of replies) expectEmpty(s);
    expect(replies[0]![1].center).not.toBe(replies[1]![1].center);
  });

  it("answers with an empty snapshot when no label has text", () => {
    const { pass, replies, encoder } = setup();
    pass.requestSnapshot(3);
    pass.recordReadback(encoder, frame(100));
    expect(replies.map(([id]) => id)).toEqual([3]);
    expectEmpty(replies[0]![1]);
  });

  it("answers with an empty snapshot when the cull buffers are missing", () => {
    const { pass, replies, encoder } = setup({ nodeText: true, culled: false });
    pass.requestSnapshot(4);
    pass.recordReadback(encoder, frame(100));
    expect(replies.map(([id]) => id)).toEqual([4]);
  });

  it("keeps the request for the next placement when there is text to place", () => {
    const { pass, replies, encoder } = setup({ nodeText: true });
    pass.requestSnapshot(5);
    pass.recordReadback(encoder, frame(100));
    expect(replies).toEqual([]);
  });

  it("stops a running placement when the graph empties", () => {
    const { pass, encoder } = setup({ nodeText: true });
    (pass as unknown as { step: number }).step = 3;
    expect(pass.busy).toBe(true);
    pass.recordReadback(encoder, frame(0));
    expect(pass.busy).toBe(false);
  });

  it("answers with an empty snapshot when the snapshot readback fails", async () => {
    const { pass, replies } = setup({ nodeText: true });
    const buf = { mapAsync: () => Promise.reject(new Error("lost")), destroy: vi.fn() };
    (pass as unknown as { pendingSnapshot: unknown }).pendingSnapshot = { buf, ids: [6, 7], cap: 1024 };
    pass.afterSubmit();
    await vi.waitFor(() => expect(replies.map(([id]) => id)).toEqual([6, 7]));
    expectEmpty(replies[0]![1]);
    expect(buf.destroy).toHaveBeenCalled();
  });
});
