import { beforeAll, describe, expect, it, vi } from "vitest";

type LabelsCtor = typeof import("../src/labels/Labels").Labels;
let Labels: LabelsCtor;

interface MirroredBuffer extends GPUBuffer {
  mirror: Uint32Array;
}

function fakeBuffer(size: number): MirroredBuffer {
  const bytes = Math.max(4, size);
  return { size: bytes, mirror: new Uint32Array(Math.ceil(bytes / 4)), destroy() {}, unmap() {}, getMappedRange: () => new ArrayBuffer(bytes) } as unknown as MirroredBuffer;
}

class FakeContext2D {
  font = "";
  measureText(text: string): TextMetrics {
    return { width: text.length * 10 } as TextMetrics;
  }
}

class FakeOffscreenCanvas {
  width = 64;
  height = 64;
  getContext(): unknown {
    return new FakeContext2D();
  }
}

function fakeDevice(): GPUDevice {
  return {
    createBuffer: (d: GPUBufferDescriptor) => fakeBuffer(d.size),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    queue: {
      writeBuffer(buffer: MirroredBuffer, bufferOffset: number, data: ArrayBufferView, dataOffset = 0, size?: number) {
        const words = data as Uint32Array;
        const n = size ?? words.length - dataOffset;
        const at = bufferOffset / 4;
        for (let i = 0; i < n; i++) buffer.mirror[at + i] = words[dataOffset + i]!;
      },
      writeTexture() {},
    },
  } as unknown as GPUDevice;
}

function widthAt(buffer: GPUBuffer, i: number): number {
  const word = (buffer as unknown as MirroredBuffer).mirror[i >>> 1]!;
  return i & 1 ? word >>> 16 : word & 0xffff;
}

beforeAll(async () => {
  vi.stubGlobal("GPUBufferUsage", { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  ({ Labels } = await import("../src/labels/Labels"));
});

describe("Labels per-index text", () => {
  it("setNodeTextAt recomputes only the touched index's width", () => {
    const labels = new Labels(fakeDevice(), { sizeCssPx: 12, paddingCssPx: 2, font: "sans-serif" });
    labels.setPixelRatio(1);
    labels.setNodeCount(3);
    labels.setNodeText(["a", "bb", "ccc"]);
    labels.stepWidths();
    const before = [widthAt(labels.nodeWidths, 0), widthAt(labels.nodeWidths, 1), widthAt(labels.nodeWidths, 2)];
    expect(before.every((w) => w > 0)).toBe(true);

    labels.setNodeTextAt(new Uint32Array([1]), ["longer text"]);

    expect(widthAt(labels.nodeWidths, 0)).toBe(before[0]);
    expect(widthAt(labels.nodeWidths, 1)).toBeGreaterThan(before[1]!);
    expect(widthAt(labels.nodeWidths, 2)).toBe(before[2]);
  });

  it("setStyle remeasures on a new size and changes the padding", () => {
    const labels = new Labels(fakeDevice(), { sizeCssPx: 12, paddingCssPx: 2, font: "sans-serif" });
    labels.setPixelRatio(2);
    const before = labels.metrics();
    expect(labels.setStyle({ sizeCssPx: 12, paddingCssPx: 2, font: "sans-serif" })).toBe(false);
    expect(labels.setStyle({ sizeCssPx: 24, paddingCssPx: 5, font: "sans-serif" })).toBe(true);
    const after = labels.metrics();
    expect(after.textH).toBeGreaterThan(before.textH);
    expect(after.padding).toBe(10);
  });

  it("clearing text that was never set does no work", () => {
    const device = fakeDevice();
    const create = vi.spyOn(device, "createBuffer");
    const labels = new Labels(device, { sizeCssPx: 12, paddingCssPx: 2, font: "sans-serif" });
    labels.setPixelRatio(1);
    labels.setNodeCount(3);
    labels.setEdgeCount(3);
    const created = create.mock.calls.length;
    const generation = labels.generation;

    expect(labels.setNodeText([])).toBe(false);
    expect(labels.setEdgeText([])).toBe(false);

    expect(create.mock.calls.length).toBe(created);
    expect(labels.generation).toBe(generation);
  });

  it("setting or clearing text that exists does the work", () => {
    const device = fakeDevice();
    const create = vi.spyOn(device, "createBuffer");
    const labels = new Labels(device, { sizeCssPx: 12, paddingCssPx: 2, font: "sans-serif" });
    labels.setPixelRatio(1);
    labels.setNodeCount(2);
    labels.setEdgeCount(2);

    expect(labels.setNodeText(["a", "b"])).toBe(true);
    expect(labels.setEdgeText(["a", "b"])).toBe(true);
    const created = create.mock.calls.length;
    expect(labels.setNodeText([])).toBe(true);
    expect(labels.setEdgeText([])).toBe(true);
    expect(create.mock.calls.length).toBe(created + 2);
    expect(labels.hasNodeText).toBe(false);
    expect(labels.hasEdgeText).toBe(false);
  });

  it("setEdgeTextAt recomputes only the touched index's width", () => {
    const labels = new Labels(fakeDevice(), { sizeCssPx: 12, paddingCssPx: 2, font: "sans-serif" });
    labels.setPixelRatio(1);
    labels.setEdgeCount(3);
    labels.setEdgeText(["a", "bb", "ccc"]);
    labels.stepWidths();
    const before = [widthAt(labels.edgeWidths, 0), widthAt(labels.edgeWidths, 1), widthAt(labels.edgeWidths, 2)];
    expect(before.every((w) => w > 0)).toBe(true);

    labels.setEdgeTextAt(new Uint32Array([0]), [""]);

    expect(widthAt(labels.edgeWidths, 0)).toBe(0);
    expect(widthAt(labels.edgeWidths, 1)).toBe(before[1]);
    expect(widthAt(labels.edgeWidths, 2)).toBe(before[2]);
  });

  it("clearEdges drops the edge text so a later edge count does not bring it back", () => {
    const labels = new Labels(fakeDevice(), { sizeCssPx: 12, paddingCssPx: 2, font: "sans-serif" });
    labels.setPixelRatio(1);
    labels.setEdgeCount(2);
    labels.setEdgeText(["a", "b"]);
    expect(labels.hasEdgeText).toBe(true);

    labels.clearEdges();
    expect(labels.hasEdgeText).toBe(false);
    labels.setEdgeCount(2);
    expect(labels.hasEdgeText).toBe(false);
  });
});
