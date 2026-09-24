import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToWorker } from "../src/bridge/protocol";
import { Graph } from "../src/api/Graph";
import type { GraphCaps, GraphOptions } from "../src/api/types";

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

async function createGraph(options: GraphOptions = {}): Promise<Graph> {
  const canvas = document.createElement("canvas");
  Object.assign(canvas, { transferControlToOffscreen: () => ({}) });
  document.body.append(canvas);
  return Graph.create(canvas, { autoResize: false, ...options });
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

  it("sends the transparent option to the worker, off by default", async () => {
    const init = (w: FakeWorker) => w.sent.find((m) => m.t === "init") as Extract<ToWorker, { t: "init" }>;
    await createGraph();
    expect(init(FakeWorker.last).options.transparent).toBe(false);
    await createGraph({ transparent: true });
    expect(init(FakeWorker.last).options.transparent).toBe(true);
  });

  it("sends nodeDrag at init, off by default, and on setNodeDrag", async () => {
    const init = (w: FakeWorker) => w.sent.find((m) => m.t === "init") as Extract<ToWorker, { t: "init" }>;
    await createGraph();
    expect(init(FakeWorker.last).options.nodeDrag).toBe(false);
    const graph = await createGraph({ nodeDrag: true });
    expect(init(FakeWorker.last).options.nodeDrag).toBe(true);
    graph.setNodeDrag(false);
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "nodeDrag", on: false });
  });

  it("tells the worker which events have handlers", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const picks = () => worker.sent.filter((m) => m.t === "pick");
    const offClick = graph.on("edgeClick", () => {});
    expect(picks().at(-1)).toEqual({ t: "pick", hover: 0, click: 2, drag: false });
    const offDrag = graph.on("nodeDragEnd", () => {});
    expect(picks().at(-1)).toEqual({ t: "pick", hover: 0, click: 2, drag: true });
    graph.on("nodeHover", () => {});
    expect(picks().at(-1)).toEqual({ t: "pick", hover: 1, click: 2, drag: true });
    offClick();
    offDrag();
    expect(picks().at(-1)).toEqual({ t: "pick", hover: 1, click: 0, drag: false });
    expect(picks()).toHaveLength(5);
  });

  it("streams through messages without shared memory", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    graph.setNodes({ count: 3 });
    const stream = graph.streamNodes({ positions: true, colors: true });
    stream.positions.set([1, 2, 3, 4, 5, 6]);
    stream.colors.set([1, 2, 3]);
    stream.commit();
    const [positions, colors] = worker.sent.slice(-2) as [Extract<ToWorker, { t: "updatePositions" }>, Extract<ToWorker, { t: "nodes" }>];
    expect(positions.t).toBe("updatePositions");
    expect(Array.from(positions.data)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(colors.t).toBe("nodes");
    expect(Array.from(colors.colors!)).toEqual([1, 2, 3]);
    expect(colors.colors).not.toBe(stream.colors);
    expect(worker.sent.some((m) => m.t === "nodeStream")).toBe(false);
  });

  it("gives empty arrays for channels not asked for", async () => {
    const graph = await createGraph();
    graph.setNodes({ count: 3 });
    const stream = graph.streamNodes({ colors: true });
    expect(stream.positions.length).toBe(0);
    expect(stream.colors.length).toBe(3);
  });

  it("delivers click and drag events", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const got: unknown[] = [];
    graph.on("nodeClick", (i) => got.push(["nodeClick", i]));
    graph.on("edgeClick", (i) => got.push(["edgeClick", i]));
    graph.on("nodeDragStart", (e) => got.push(["start", e]));
    graph.on("nodeDrag", (e) => got.push(["drag", e]));
    graph.on("nodeDragEnd", (e) => got.push(["end", e]));
    const post = (data: unknown) => worker.onmessage?.({ data });
    post({ t: "click", node: 3, edge: -1 });
    post({ t: "click", node: -1 });
    post({ t: "drag", event: "nodeDragStart", index: 3, x: 1, y: 2 });
    post({ t: "drag", event: "nodeDrag", index: 3, x: 4, y: 5 });
    post({ t: "drag", event: "nodeDragEnd", index: 3, x: 4, y: 5 });
    expect(got).toEqual([
      ["nodeClick", 3],
      ["edgeClick", null],
      ["nodeClick", null],
      ["start", { index: 3, x: 1, y: 2 }],
      ["drag", { index: 3, x: 4, y: 5 }],
      ["end", { index: 3, x: 4, y: 5 }],
    ]);
  });
});
