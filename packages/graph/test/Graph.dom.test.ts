import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToWorker } from "../src/bridge/protocol";
import { Graph } from "../src/api/Graph";
import type { GraphCaps } from "../src/api/types";

const CAPS: GraphCaps = {
  timestampQuery: false,
  indirectFirstInstance: false,
  subgroups: false,
  float32Filterable: false,
  shaderF16: false,
  maxBufferSize: 0,
  maxStorageBufferBindingSize: 0,
  maxTextureDimension2D: 0,
  maxStorageBuffersPerShaderStage: 0,
  sharedMemory: false,
  adapter: "fake",
  profilerSlots: [],
};

class FakeWorker {
  static last: FakeWorker;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  readonly sent: ToWorker[] = [];
  terminated = false;

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(msg: ToWorker): void {
    this.sent.push(msg);
    if (msg.t === "init") queueMicrotask(() => this.onmessage?.({ data: { t: "ready", caps: CAPS } }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function createGraph(): Promise<Graph> {
  const canvas = document.createElement("canvas");
  Object.assign(canvas, { transferControlToOffscreen: () => ({}) });
  document.body.append(canvas);
  return Graph.create(canvas, { autoResize: false });
}

describe("Graph.destroy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    Object.defineProperty(navigator, "gpu", { value: {}, configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("runs to the end with the debug overlay open", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    graph.debug.open();

    expect(() => graph.destroy()).not.toThrow();
    expect(worker.sent.map((m) => m.t).slice(-2)).toEqual(["debug", "destroy"]);
    expect(graph.debug.isOpen()).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(worker.terminated).toBe(true);
  });
});
