import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToWorker } from "../src/bridge/protocol";
import { STATE_SLOT, STATE_SLOTS } from "../src/bridge/SharedState";
import { Graph } from "../src/api/Graph";
import { GraphError } from "../src/api/errors";
import { NO_INDEX } from "../src/api/Slots";
import { Flag, type GraphCaps, type GraphOptions, type Hit } from "../src/api/types";

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
  maxIcons: 8,
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

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof GraphError ? e.code : String(e);
  }
  return "none";
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

  it("sends the background in the first style, opaque by default", async () => {
    const init = (w: FakeWorker) => w.sent.find((m) => m.t === "init") as Extract<ToWorker, { t: "init" }>;
    await createGraph();
    expect(init(FakeWorker.last).options.style.background).toEqual([0.04, 0.04, 0.06, 1]);
    await createGraph({ style: { background: [0, 0, 0, 0.5] } });
    expect(init(FakeWorker.last).options.style.background).toEqual([0, 0, 0, 0.5]);
  });

  it("style.set posts the partial style", async () => {
    const graph = await createGraph();
    graph.style.set({ label: { color: [1, 0, 0, 1] } });
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "style" }>;
    expect(last).toEqual({ t: "style", style: { label: { color: [1, 0, 0, 1] } } });
  });

  it("style.set posts looks as they are", async () => {
    const graph = await createGraph();
    graph.style.set({ hover: false });
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "style", style: { hover: false } });
    graph.style.set({ selected: { outline: { color: [1, 0, 0, 1] } } });
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "style", style: { selected: { outline: { color: [1, 0, 0, 1] } } } });
  });

  it("create resolves hover false", async () => {
    await createGraph({ style: { hover: false } });
    const init = FakeWorker.last.sent[0] as Extract<ToWorker, { t: "init" }>;
    expect(init.options.style.hover).toBe(false);
    expect(init.options.style.dimmed.alpha).toBe(0.25);
  });

  it("create takes the first style", async () => {
    await createGraph({ style: { background: [0, 0, 0, 0], edge: { width: 2 } } });
    const init = FakeWorker.last.sent[0] as Extract<ToWorker, { t: "init" }>;
    expect(init.options.style.background).toEqual([0, 0, 0, 0]);
    expect(init.options.style.edge.width).toBe(2);
    expect(init.options.style.edge.color).toEqual([0.24, 0.27, 0.31, 0.4]);
    expect(init.options.style.label).toEqual({ size: 12, font: "system-ui, -apple-system, 'Segoe UI', sans-serif", color: [0.914, 0.929, 0.953, 1], padding: 2 });
    expect(init.options.style.icon).toEqual({ scale: 0.6, minPx: 6 });
  });

  it("sends drag at init, auto by default, and on input.set", async () => {
    const init = (w: FakeWorker) => w.sent.find((m) => m.t === "init") as Extract<ToWorker, { t: "init" }>;
    await createGraph();
    expect(init(FakeWorker.last).options.input.drag).toBe("auto");
    const graph = await createGraph({ input: { drag: "manual" } });
    expect(init(FakeWorker.last).options.input.drag).toBe("manual");
    graph.input.set({ drag: false });
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "input", input: { drag: false } });
    expect(() => graph.input.set({ drag: true as never })).toThrow(GraphError);
  });

  it("tells the worker which events have listeners", async () => {
    const graph = await createGraph();
    const off = graph.on("contextMenu", () => {});
    const listens = () => FakeWorker.last.sent.filter((m) => (m as ToWorker).t === "listen") as Extract<ToWorker, { t: "listen" }>[];
    expect(listens().at(-1)!.events).toContain("contextMenu");
    graph.on("error", () => {});
    expect(listens()).toHaveLength(1);
    const offHover = graph.on("hover", () => {});
    expect(listens().at(-1)!.events).toEqual(expect.arrayContaining(["contextMenu", "hover"]));
    off();
    offHover();
    expect(listens().at(-1)!.events).toEqual([]);
    expect(FakeWorker.last.sent.some((m) => (m as { t: string }).t === "pick")).toBe(false);
  });

  it("hover and click carry a Hit", async () => {
    const graph = await createGraph();
    const hits: Hit[] = [];
    graph.on("click", (h) => hits.push(h));
    const hit = { node: 3, edge: null, group: null, x: 1, y: 2, screenX: 10, screenY: 20, button: 0, shift: true, ctrl: false, alt: false, meta: false };
    FakeWorker.last.onmessage?.({ data: { t: "click", hit } } as MessageEvent);
    expect(hits).toEqual([hit]);
  });

  it("delivers hover, doubleClick and contextMenu hits to their listeners", async () => {
    const graph = await createGraph();
    const got: [string, Hit][] = [];
    graph.on("hover", (h) => got.push(["hover", h]));
    graph.on("doubleClick", (h) => got.push(["doubleClick", h]));
    graph.on("contextMenu", (h) => got.push(["contextMenu", h]));
    const hit = (node: number | null, edge: number | null, button: number): Hit => ({ node, edge, group: null, x: 0, y: 0, screenX: 0, screenY: 0, button, shift: false, ctrl: false, alt: false, meta: false });
    const post = (t: string, h: Hit) => FakeWorker.last.onmessage?.({ data: { t, hit: h } } as MessageEvent);
    post("hover", hit(null, 4, -1));
    post("doubleClick", hit(2, null, 0));
    post("contextMenu", hit(null, null, 2));
    expect(got).toEqual([
      ["hover", hit(null, 4, -1)],
      ["doubleClick", hit(2, null, 0)],
      ["contextMenu", hit(null, null, 2)],
    ]);
  });

  it("input.set posts the partial input", async () => {
    const graph = await createGraph();
    graph.input.set({ pick: { edges: false } });
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "input" }>;
    expect(last).toEqual({ t: "input", input: { pick: { edges: false } } });
  });

  it("input.set rejects a negative or non-finite pick radius", async () => {
    const graph = await createGraph();
    expect(() => graph.input.set({ pickRadius: -1 })).toThrow(GraphError);
    expect(() => graph.input.set({ edgePickRadius: Number.NaN })).toThrow(GraphError);
  });

  it("sends the resolved input at create", async () => {
    const init = () => FakeWorker.last.sent.find((m) => m.t === "init") as Extract<ToWorker, { t: "init" }>;
    await createGraph();
    expect(init().options.input.pick).toEqual({ nodes: true, edges: true, groups: false });
    expect(init().options.input.pickRadius).toBe(0);
    expect(init().options.input.edgePickRadius).toBe(4);
    await createGraph({ input: { pick: { edges: false }, pickRadius: 2 } });
    expect(init().options.input.pick).toEqual({ nodes: true, edges: false, groups: false });
    expect(init().options.input.pickRadius).toBe(2);
  });

  it("lets the page scroll on wheel when zoom is off", async () => {
    const wheel = () => {
      const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
      document.querySelector("canvas")!.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const graph = await createGraph();
    expect(wheel()).toBe(true);
    graph.input.set({ zoom: false });
    expect(wheel()).toBe(false);
    graph.input.set({ zoom: "manual" });
    expect(wheel()).toBe(true);
    graph.destroy();
    document.body.replaceChildren();
    await createGraph({ input: { zoom: false } });
    expect(wheel()).toBe(false);
  });

  it("sends the interaction modes at create, rotate off by default", async () => {
    const init = () => FakeWorker.last.sent.find((m) => m.t === "init") as Extract<ToWorker, { t: "init" }>;
    await createGraph();
    expect(init().options.input).toMatchObject({ pan: "auto", zoom: "auto", rotate: false });
    await createGraph({ input: { pan: false, zoom: "manual", rotate: "auto" } });
    expect(init().options.input).toMatchObject({ pan: false, zoom: "manual", rotate: "auto" });
  });

  it("input.set rejects an unknown mode", async () => {
    const graph = await createGraph();
    expect(() => graph.input.set({ pan: "on" as never })).toThrow(GraphError);
    expect(() => graph.input.set({ rotate: true as never })).toThrow(GraphError);
  });

  it("delivers pan, zoom and rotate events and listens for them", async () => {
    const graph = await createGraph();
    const got: unknown[] = [];
    graph.on("pan", (e) => got.push(e));
    graph.on("zoom", (e) => got.push(e));
    graph.on("rotate", (e) => got.push(e));
    const listen = FakeWorker.last.sent.filter((m) => m.t === "listen").at(-1) as Extract<ToWorker, { t: "listen" }>;
    expect(listen.events).toEqual(expect.arrayContaining(["pan", "zoom", "rotate"]));
    const mods = { shift: false, ctrl: true, alt: false, meta: false };
    const pan = { phase: "start", dx: 3, dy: 4, x: 10, y: 20, ...mods };
    const zoom = { phase: "move", factor: 1.5, x: 10, y: 20, ...mods };
    const rotate = { phase: "end", angle: 0, x: 10, y: 20, ...mods };
    const post = (data: unknown) => FakeWorker.last.onmessage?.({ data });
    post({ t: "pan", event: pan });
    post({ t: "zoom", event: zoom });
    post({ t: "rotate", event: rotate });
    expect(got).toEqual([pan, zoom, rotate]);
  });

  it("prevents the context menu only while a contextMenu listener exists", async () => {
    const graph = await createGraph();
    const canvas = document.querySelector("canvas")!;
    const menu = () => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      canvas.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(menu()).toBe(false);
    const off = graph.on("contextMenu", () => {});
    expect(menu()).toBe(true);
    off();
    expect(menu()).toBe(false);
  });

  it("forwards the context menu as an input record only while a contextMenu listener exists", async () => {
    const graph = await createGraph();
    const canvas = document.querySelector("canvas")!;
    const records = () => FakeWorker.last.sent.filter((m) => m.t === "inputRecord").length;
    const menu = (init: MouseEventInit) => canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, ...init }));
    const before = records();
    menu({ clientX: 5, clientY: 6, button: 2 });
    expect(records()).toBe(before);
    graph.on("contextMenu", () => {});
    menu({ clientX: 5, clientY: 6, button: 0, ctrlKey: true });
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "inputRecord" }>;
    expect(last.t).toBe("inputRecord");
    expect(last.r[0]).toBe(8);
    expect(last.r[2]).toBe(5);
    expect(last.r[3]).toBe(6);
    expect(last.r[7]).toBe(2);
    expect(last.r[8]).toBe(0);
  });

  describe("long press", () => {
    const menus = () => FakeWorker.last.sent.filter((m): m is Extract<ToWorker, { t: "inputRecord" }> => m.t === "inputRecord" && m.r[0] === 8);
    const setup = async (listen = true) => {
      const graph = await createGraph();
      const canvas = document.querySelector("canvas")!;
      canvas.setPointerCapture = () => {};
      if (listen) graph.on("contextMenu", () => {});
      const pointer = (type: string, init: PointerEventInit = {}) =>
        canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 1, buttons: 1, clientX: 5, clientY: 6, ...init }));
      return { canvas, pointer };
    };

    it("sends a menu record at the press point after a 500 ms touch hold", async () => {
      const { pointer } = await setup();
      pointer("pointerdown");
      vi.advanceTimersByTime(499);
      expect(menus()).toHaveLength(0);
      vi.advanceTimersByTime(1);
      const [m] = menus();
      expect(m?.r[2]).toBe(5);
      expect(m?.r[3]).toBe(6);
      expect(m?.r[8]).toBe(0);
      expect(m!.r[7]! & 16).toBe(16);
    });

    it("holds with a pen too, within the slop", async () => {
      const { pointer } = await setup();
      pointer("pointerdown", { pointerType: "pen" });
      pointer("pointermove", { pointerType: "pen", clientX: 7, clientY: 7 });
      vi.advanceTimersByTime(500);
      expect(menus()).toHaveLength(1);
    });

    it("cancels when the press moves past the slop, lifts, or a second finger lands", async () => {
      const { pointer } = await setup();
      pointer("pointerdown");
      pointer("pointermove", { clientX: 9 });
      vi.advanceTimersByTime(500);
      pointer("pointerup");
      pointer("pointerdown");
      vi.advanceTimersByTime(300);
      pointer("pointerup");
      vi.advanceTimersByTime(500);
      pointer("pointerdown");
      pointer("pointerdown", { pointerId: 2, clientX: 50 });
      vi.advanceTimersByTime(500);
      expect(menus()).toHaveLength(0);
    });

    it("does not hold for a mouse press or without a contextMenu listener", async () => {
      const { pointer } = await setup(false);
      pointer("pointerdown");
      vi.advanceTimersByTime(500);
      pointer("pointerup");
      expect(menus()).toHaveLength(0);
    });

    it("ignores the mouse button press but still sends a right click", async () => {
      const { canvas, pointer } = await setup();
      pointer("pointerdown", { pointerType: "mouse" });
      vi.advanceTimersByTime(500);
      expect(menus()).toHaveLength(0);
      canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
      expect(menus()).toHaveLength(1);
    });

    it("blocks the native touch menu without sending a second record", async () => {
      const { canvas, pointer } = await setup();
      pointer("pointerdown");
      vi.advanceTimersByTime(500);
      const e = new PointerEvent("contextmenu", { bubbles: true, cancelable: true, pointerType: "touch" });
      canvas.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
      expect(menus()).toHaveLength(1);
    });
  });

  it("forwards a double click as an input record with the changed button", async () => {
    await createGraph();
    const canvas = document.querySelector("canvas")!;
    canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 5, clientY: 6, button: 0, shiftKey: true }));
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "inputRecord" }>;
    expect(last.t).toBe("inputRecord");
    expect(last.r[0]).toBe(7);
    expect(last.r[7]).toBe(1);
    expect(last.r[8]).toBe(0);
  });

  it("nodes.update sends indices and values", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 10 });
    graph.nodes.update(new Uint32Array([4, 7]), { sizes: new Float32Array([2, 3]) });
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "updateNodesAt" }>;
    expect(last.t).toBe("updateNodesAt");
    expect(Array.from(last.indices)).toEqual([4, 7]);
    expect(Array.from(last.sizes!)).toEqual([2, 3]);
  });

  it("nodes.update rejects an index listed twice", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 10 });
    expect(() => graph.nodes.update(new Uint32Array([4, 4]), { sizes: new Float32Array([1, 1]) })).toThrow(/listed twice/);
  });

  it("nodes.update rejects an index past the slots", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 10 });
    expect(() => graph.nodes.update(new Uint32Array([10]), { sizes: new Float32Array([1]) })).toThrow(GraphError);
  });

  it("nodes.flag sends the index list and the bits", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 5 });
    graph.nodes.flag(new Uint32Array([1, 3]), Flag.hidden | Flag.dimmed, true);
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "flagNodes" }>;
    expect(last).toMatchObject({ t: "flagNodes", flags: Flag.hidden | Flag.dimmed, on: true });
    expect(Array.from(last.indices!)).toEqual([1, 3]);
  });

  it("nodes.flag all sends null indices", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 5 });
    graph.nodes.flag("all", Flag.dimmed, false);
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "flagNodes" }>;
    expect(last.indices).toBeNull();
  });

  it("nodes.flag rejects unknown bits", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 5 });
    expect(() => graph.nodes.flag(new Uint32Array([0]), 1, true)).toThrow(GraphError);
  });

  it("nodes.flag rejects an index listed twice", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 5 });
    expect(() => graph.nodes.flag(new Uint32Array([2, 2]), Flag.selected, true)).toThrow(/listed twice/);
  });

  it("nodes.update rejects a detached indices or data array with detached-array", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 10 });
    const code = (fn: () => void): string | undefined => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(GraphError);
        return (e as GraphError).code;
      }
      return undefined;
    };
    const idx = new Uint32Array([1]);
    structuredClone(idx, { transfer: [idx.buffer] });
    expect(code(() => graph.nodes.update(idx, { sizes: new Float32Array([2]) }))).toBe("detached-array");
    const sizes = new Float32Array([2]);
    structuredClone(sizes, { transfer: [sizes.buffer] });
    expect(code(() => graph.nodes.update(new Uint32Array([1]), { sizes }))).toBe("detached-array");
  });

  it("nodes.update transfers indices and data unless copy is set", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 10 });
    const idx = new Uint32Array([1]);
    const sizes = new Float32Array([2]);
    graph.nodes.update(idx, { sizes }, { copy: true });
    const copied = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "updateNodesAt" }>;
    expect(copied.indices).not.toBe(idx);
    expect(copied.sizes).not.toBe(sizes);
    graph.nodes.update(idx, { sizes });
    const moved = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "updateNodesAt" }>;
    expect(moved.indices).toBe(idx);
    expect(moved.sizes).toBe(sizes);
  });

  it("icons.define resolves or rejects with the worker's answer", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const done = graph.icons.define([{ path: "M0 0H1V1Z" }, { svg: "<svg/>" }]);
    const msg = worker.sent.at(-1) as Extract<ToWorker, { t: "defineIcons" }>;
    expect(msg.t).toBe("defineIcons");
    expect(msg.icons).toEqual([{ path: "M0 0H1V1Z", viewBox: undefined, fillRule: undefined }, { svg: "<svg/>" }]);
    worker.onmessage?.({ data: { t: "reply", id: msg.id } });
    await expect(done).resolves.toBeUndefined();
    const failed = graph.icons.define([{ path: "X" }]);
    const second = worker.sent.at(-1) as Extract<ToWorker, { t: "defineIcons" }>;
    worker.onmessage?.({ data: { t: "reply", id: second.id, code: "invalid-argument", message: "bad" } });
    await expect(failed).rejects.toThrow("bad");
    expect(() => graph.icons.define([{} as never])).toThrow(/path/);
  });

  it("icons.add resolves with its ids, reuses removed ids and keeps the ids of a bad icon", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const reply = (id: number, error?: { code: string; message: string }) => worker.onmessage?.({ data: { t: "reply", id, ...error } });
    const last = () => worker.sent.at(-1) as Extract<ToWorker, { t: "setIcons" }>;
    const square = { path: "M0 0H1V1Z" };
    const defined = graph.icons.define([square, square]);
    reply((worker.sent.at(-1) as Extract<ToWorker, { t: "defineIcons" }>).id);
    await defined;

    const added = graph.icons.add([{ svg: "<svg/>" }]);
    expect(last()).toMatchObject({ t: "setIcons", icons: [{ svg: "<svg/>" }] });
    expect(Array.from(last().ids)).toEqual([2]);
    reply(last().id);
    expect(Array.from(await added)).toEqual([2]);

    graph.icons.remove([0]);
    expect(worker.sent.at(-1)).toEqual({ t: "removeIcons", ids: new Uint16Array([0]) });
    const again = graph.icons.add([square, square]);
    expect(Array.from(last().ids)).toEqual([0, 3]);
    reply(last().id);
    expect(Array.from(await again)).toEqual([0, 3]);

    const replaced = graph.icons.replace(3, { svg: "<svg/>" });
    expect(last()).toMatchObject({ t: "setIcons", icons: [{ svg: "<svg/>" }] });
    expect(Array.from(last().ids)).toEqual([3]);
    reply(last().id);
    await expect(replaced).resolves.toBeUndefined();

    const errors: string[] = [];
    graph.on("error", (e) => errors.push(e.message));
    const bad = graph.icons.add([{ path: "X" }]);
    expect(Array.from(last().ids)).toEqual([4]);
    worker.onmessage?.({ data: { t: "error", code: "invalid-argument", message: "icons: icon 0: bad", fatal: false } });
    reply(last().id);
    expect(Array.from(await bad)).toEqual([4]);
    expect(errors).toEqual(["icons: icon 0: bad"]);
    graph.icons.add([square]);
    expect(Array.from(last().ids)).toEqual([5]);
  });

  it("icons.remove and icons.replace of an unknown id throw, and add stops at maxIcons", async () => {
    const graph = await createGraph();
    const square = { path: "M0 0H1V1Z" };
    void graph.icons.define([square, square]);
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof GraphError ? e.code : String(e);
      }
      return "none";
    };
    expect(code(() => graph.icons.remove([5]))).toBe("invalid-argument");
    expect(() => graph.icons.remove([1, 1])).toThrow(/twice/);
    expect(code(() => graph.icons.replace(2, square))).toBe("invalid-argument");
    graph.icons.remove([1]);
    expect(code(() => graph.icons.replace(1, square))).toBe("invalid-argument");
    expect(code(() => graph.icons.remove([1]))).toBe("invalid-argument");
    void graph.icons.add(Array.from({ length: CAPS.maxIcons - 1 }, () => square));
    expect(code(() => graph.icons.add([square]))).toBe("limits-exceeded");
  });

  it("icons.define over maxIcons throws before posting and keeps the ids in use", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const square = { path: "M0 0H1V1Z" };
    const defined = graph.icons.define([square, square]);
    worker.onmessage?.({ data: { t: "reply", id: (worker.sent.at(-1) as Extract<ToWorker, { t: "defineIcons" }>).id } });
    await defined;
    const sent = worker.sent.length;
    let err: unknown;
    try {
      void graph.icons.define(Array.from({ length: CAPS.maxIcons + 1 }, () => square));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).code).toBe("limits-exceeded");
    expect(worker.sent.length).toBe(sent);
    void graph.icons.add([square]);
    expect(Array.from((worker.sent.at(-1) as Extract<ToWorker, { t: "setIcons" }>).ids)).toEqual([2]);
    void graph.icons.add(Array.from({ length: CAPS.maxIcons - 3 }, () => square));
    expect(() => graph.icons.add([square])).toThrow(GraphError);
  });

  it("streams through messages without shared memory", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    graph.nodes.set({ count: 3 });
    const stream = graph.nodes.stream({ positions: true, colors: true });
    stream.positions.set([1, 2, 3, 4, 5, 6]);
    stream.colors.set([1, 2, 3]);
    stream.commit();
    const update = worker.sent.at(-1) as Extract<ToWorker, { t: "updateNodes" }>;
    expect(update.t).toBe("updateNodes");
    expect(update.start).toBe(0);
    expect(Array.from(update.positions!)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(update.colors!)).toEqual([1, 2, 3]);
    expect(update.colors).not.toBe(stream.colors);
    expect(worker.sent.some((m) => m.t === "nodeStream")).toBe(false);
  });

  it("sends z-index with the nodes", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    graph.nodes.set({ count: 2, zIndex: new Uint8Array([3, 1]) });
    const last = worker.sent.at(-1) as Extract<ToWorker, { t: "nodes" }>;
    expect(last.t).toBe("nodes");
    expect(Array.from(last.zIndex!)).toEqual([3, 1]);
  });

  it("gives empty arrays for channels not asked for", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    const stream = graph.nodes.stream({ colors: true });
    expect(stream.positions.length).toBe(0);
    expect(stream.colors.length).toBe(3);
  });

  it("delivers drag events", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const got: unknown[] = [];
    graph.on("dragStart", (e) => got.push(["start", e]));
    graph.on("drag", (e) => got.push(["drag", e]));
    graph.on("dragEnd", (e) => got.push(["end", e]));
    const listens = worker.sent.filter((m) => m.t === "listen") as Extract<ToWorker, { t: "listen" }>[];
    expect(listens.at(-1)!.events).toEqual(expect.arrayContaining(["dragStart", "drag", "dragEnd"]));
    const post = (data: unknown) => worker.onmessage?.({ data });
    post({ t: "dragStart", index: 2, nodes: new Uint32Array([2, 5]), x: 1, y: 2 });
    post({ t: "drag", index: 2, dx: 3, dy: -1 });
    post({ t: "dragEnd", index: 2, dx: 4, dy: -2 });
    expect(got).toEqual([
      ["start", { index: 2, nodes: new Uint32Array([2, 5]), x: 1, y: 2 }],
      ["drag", { index: 2, dx: 3, dy: -1 }],
      ["end", { index: 2, dx: 4, dy: -2 }],
    ]);
  });

  it("query.inside posts the shape in device px and resolves with the nodes", async () => {
    const graph = await createGraph({ pixelRatio: 2 });
    const worker = FakeWorker.last;
    const found = graph.query.inside({ x: 1, y: 2, width: 3, height: 4 });
    const msg = worker.sent.at(-1) as Extract<ToWorker, { t: "queryInside" }>;
    expect(msg.t).toBe("queryInside");
    expect(Array.from(msg.points)).toEqual([2, 4, 8, 4, 8, 12, 2, 12]);
    worker.onmessage?.({ data: { t: "reply", id: msg.id, value: new Uint32Array([4, 9]) } });
    await expect(found).resolves.toEqual(new Uint32Array([4, 9]));
    expect(() => graph.query.inside({ points: [0, 0] })).toThrow();
  });

  it("query.inside rejects with a GraphError when the worker reports a failure", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const found = graph.query.inside({ x: 0, y: 0, width: 5, height: 5 });
    const msg = worker.sent.at(-1) as Extract<ToWorker, { t: "queryInside" }>;
    worker.onmessage?.({ data: { t: "reply", id: msg.id, code: "internal", message: "query.inside: readback failed" } });
    await expect(found).rejects.toBeInstanceOf(GraphError);
    await expect(found).rejects.toMatchObject({ code: "internal", message: "query.inside: readback failed" });
  });

  it("rejects every queued query.inside and emits one GraphError when the query pipeline fails to load", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const errors: GraphError[] = [];
    graph.on("error", (e) => errors.push(e));
    const first = graph.query.inside({ x: 0, y: 0, width: 5, height: 5 });
    const firstId = (worker.sent.at(-1) as Extract<ToWorker, { t: "queryInside" }>).id;
    const second = graph.query.inside({ points: [0, 0, 10, 0, 0, 10] });
    const secondId = (worker.sent.at(-1) as Extract<ToWorker, { t: "queryInside" }>).id;
    const message = "query.inside: pipeline failed to load: no pipeline";
    worker.onmessage?.({ data: { t: "error", code: "internal", message } });
    worker.onmessage?.({ data: { t: "reply", id: firstId, code: "internal", message } });
    worker.onmessage?.({ data: { t: "reply", id: secondId, code: "internal", message } });
    await expect(first).rejects.toBeInstanceOf(GraphError);
    await expect(second).rejects.toMatchObject({ code: "internal", message });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(GraphError);
  });

  it("query.at posts CSS px and resolves with the hit", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const found = graph.query.at(10, 20);
    const msg = worker.sent.at(-1) as Extract<ToWorker, { t: "queryAt" }>;
    expect(msg).toMatchObject({ t: "queryAt", x: 10, y: 20 });
    const hit: Hit = { node: 3, edge: null, group: null, x: 1, y: 2, screenX: 10, screenY: 20, button: -1, shift: false, ctrl: false, alt: false, meta: false };
    worker.onmessage?.({ data: { t: "reply", id: msg.id, value: hit } });
    await expect(found).resolves.toEqual(hit);
    expect(() => graph.query.at(NaN, 0)).toThrow();
  });

  it("sends select at init, auto by default, and on input.set", async () => {
    await createGraph();
    const init = FakeWorker.last.sent[0] as Extract<ToWorker, { t: "init" }>;
    expect(init.options.input).toMatchObject({ select: "auto", selectShape: "box", selectKey: "shift" });
    const graph = await createGraph({ input: { selectKey: null } });
    const init2 = FakeWorker.last.sent[0] as Extract<ToWorker, { t: "init" }>;
    expect(init2.options.input.selectKey).toBe(null);
    graph.input.set({ select: false, selectShape: "lasso" });
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "input", input: { select: false, selectShape: "lasso" } });
    expect(() => graph.input.set({ selectShape: "circle" as never })).toThrow();
    expect(() => graph.input.set({ selectKey: "tab" as never })).toThrow();
  });

  it("delivers select events", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const got: unknown[] = [];
    graph.on("select", (e) => got.push(e));
    const listens = worker.sent.filter((m) => m.t === "listen") as Extract<ToWorker, { t: "listen" }>[];
    expect(listens.at(-1)!.events).toContain("select");
    worker.onmessage?.({ data: { t: "select", nodes: new Uint32Array([1, 4]), shape: "box", shift: true, ctrl: false, alt: false, meta: false } });
    expect(got).toEqual([{ nodes: new Uint32Array([1, 4]), shape: "box", shift: true, ctrl: false, alt: false, meta: false }]);
  });

  it("canvas.snapshot posts the type, resolves with the worker's blob and rejects on destroy", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const shot = graph.canvas.snapshot();
    const msg = worker.sent.at(-1) as Extract<ToWorker, { t: "snapshot" }>;
    expect(msg).toEqual({ t: "snapshot", id: msg.id, type: "image/png" });
    const blob = new Blob(["png"], { type: "image/png" });
    worker.onmessage?.({ data: { t: "reply", id: msg.id, value: blob } });
    await expect(shot).resolves.toBe(blob);
    const jpeg = graph.canvas.snapshot("image/jpeg");
    const second = worker.sent.at(-1) as Extract<ToWorker, { t: "snapshot" }>;
    expect(second.type).toBe("image/jpeg");
    worker.onmessage?.({ data: { t: "reply", id: second.id, code: "internal", message: "no image" } });
    await expect(jpeg).rejects.toThrow("no image");
    const pending = graph.canvas.snapshot();
    graph.destroy();
    await expect(pending).rejects.toThrow(/destroyed/);
    await expect(graph.canvas.snapshot()).rejects.toThrow(/destroyed/);
  });

  it("rejects pending queries on destroy", async () => {
    const graph = await createGraph();
    const inside = graph.query.inside({ points: [0, 0, 10, 0, 0, 10] });
    const at = graph.query.at(1, 1);
    graph.destroy();
    await expect(inside).rejects.toThrow(/destroyed/);
    await expect(at).rejects.toThrow(/destroyed/);
    await expect(graph.query.at(1, 1)).rejects.toThrow(/destroyed/);
  });
});

describe("0.3 namespaces", () => {
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

  it("sends nodeReserve to the worker, 100 by default", async () => {
    await createGraph();
    const init = () => FakeWorker.last.sent[0] as Extract<ToWorker, { t: "init" }>;
    expect(init().options.nodeReserve).toBe(100);
    await createGraph({ nodeReserve: 0 });
    expect(init().options.nodeReserve).toBe(0);
    await createGraph({ nodeReserve: 100_000 });
    expect(init().options.nodeReserve).toBe(100_000);
  });

  it("rejects a nodeReserve that is not an integer >= 0", async () => {
    for (const nodeReserve of [-1, 1.5, NaN, Infinity, -Infinity]) {
      await expect(createGraph({ nodeReserve })).rejects.toMatchObject({ code: "invalid-argument", message: expect.stringMatching(/nodeReserve/) });
    }
  });

  it("nodes.set sends a nodes message", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "nodes" }>;
    expect(last.t).toBe("nodes");
    expect(last.count).toBe(3);
  });

  it("nodes.updateAll updates every node from 0", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    graph.nodes.updateAll({ colors: new Uint32Array([1, 2]) });
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "updateNodes" }>;
    expect(last.t).toBe("updateNodes");
    expect(last.start).toBe(0);
    expect(Array.from(last.colors!)).toEqual([1, 2]);
  });

  it("nodes.updateAll rejects arrays that don't cover every node", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    expect(() => graph.nodes.updateAll({ colors: new Uint32Array([1, 2]) })).toThrow(GraphError);
  });

  it("labels travel with nodes.set", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2, labels: ["a", null] });
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "nodes" }>;
    expect(last.labels).toEqual(["a", ""]);
  });

  it("updateAll with labels null clears every label", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2, labels: ["a", "b"] });
    graph.nodes.updateAll({ labels: null });
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "updateNodes" }>;
    expect(last.labels).toBeNull();
  });

  it("labels must cover the listed nodes", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    expect(() => graph.nodes.update(new Uint32Array([0, 1]), { labels: ["x"] })).toThrow(GraphError);
  });

  it("nodes.update rejects labels null", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2, labels: ["a", "b"] });
    const sent = FakeWorker.last.sent.length;
    const indices = new Uint32Array([0]);
    expect(() => graph.nodes.update(indices, { labels: null })).toThrow(expect.objectContaining({ code: "invalid-argument", message: expect.stringMatching(/updateAll/) }));
    expect(FakeWorker.last.sent.length).toBe(sent);
    expect(indices.length).toBe(1);
  });

  it("edges.update rejects labels null", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    graph.edges.set({ count: 1, indices: new Uint32Array([0, 1]), labels: ["a"] });
    const sent = FakeWorker.last.sent.length;
    const indices = new Uint32Array([0]);
    expect(() => graph.edges.update(indices, { labels: null })).toThrow(expect.objectContaining({ code: "invalid-argument", message: expect.stringMatching(/updateAll/) }));
    expect(FakeWorker.last.sent.length).toBe(sent);
    expect(indices.length).toBe(1);
  });

  it("edge labels travel with edges.set and edges.updateAll", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 0]), labels: ["a", null] });
    const setMsg = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "edges" }>;
    expect(setMsg.labels).toEqual(["a", ""]);
    graph.edges.updateAll({ labels: null });
    const updateMsg = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "updateEdges" }>;
    expect(updateMsg.labels).toBeNull();
  });

  it("edges.add returns new indices and reuses removed ones", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 4 });
    graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) });
    graph.edges.remove([0]);
    const added = graph.edges.add({ count: 2, indices: new Uint32Array([2, 3, 3, 0]) });
    expect(Array.from(added).sort()).toEqual([0, 2]);
    expect(graph.edges.count).toBe(3);
    expect(graph.edges.slots).toBe(3);
  });

  it("edges.add rejects an end past the node slots", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    graph.edges.set({ count: 0, indices: new Uint32Array(0) });
    expect(() => graph.edges.add({ count: 1, indices: new Uint32Array([0, 5]) })).toThrow(GraphError);
  });

  it("edges.remove rejects an edge already removed", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    graph.edges.set({ count: 1, indices: new Uint32Array([0, 1]) });
    graph.edges.remove([0]);
    expect(() => graph.edges.remove([0])).toThrow(/not a live slot/);
  });

  it("edges.compact returns the remap table and resets slots", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.edges.set({ count: 3, indices: new Uint32Array([0, 1, 1, 2, 2, 0]) });
    graph.edges.remove([1]);
    expect(Array.from(graph.edges.compact())).toEqual([0, NO_INDEX, 1]);
    expect(graph.edges.slots).toBe(2);
  });

  it("edges.clear removes every edge", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    graph.edges.set({ count: 1, indices: new Uint32Array([0, 1]) });
    graph.edges.clear();
    expect(graph.edges.count).toBe(0);
  });

  it("edges.add sends the new slots and the new slot count", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.edges.set({ count: 1, indices: new Uint32Array([0, 1]) });
    graph.edges.add({ count: 1, indices: new Uint32Array([1, 2]), styles: new Uint32Array([5]) });
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "addEdges" }>;
    expect(last.t).toBe("addEdges");
    expect(Array.from(last.at)).toEqual([1]);
    expect(last.count).toBe(2);
    expect(Array.from(last.indices!)).toEqual([1, 2]);
    expect(Array.from(last.styles!)).toEqual([5]);
  });

  it("edges.update sends indices and only the given channels", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.edges.set({ count: 3, indices: new Uint32Array([0, 1, 1, 2, 2, 0]) });
    graph.edges.update(new Uint32Array([2, 0]), { colors: new Uint32Array([1, 2, 3, 4]) });
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "updateEdgesAt" }>;
    expect(last.t).toBe("updateEdgesAt");
    expect(Array.from(last.at)).toEqual([2, 0]);
    expect(Array.from(last.colors!)).toEqual([1, 2, 3, 4]);
    expect(last.indices).toBeUndefined();
  });

  it("edges.update rejects a removed edge and an end past the node slots", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) });
    graph.edges.remove([1]);
    expect(() => graph.edges.update(new Uint32Array([1]), { styles: new Uint32Array([1]) })).toThrow(/not a live slot/);
    expect(() => graph.edges.update(new Uint32Array([0]), { indices: new Uint32Array([0, 3]) })).toThrow(GraphError);
  });

  it("edges.updateAll arrays cover every slot", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) });
    graph.edges.remove([1]);
    expect(() => graph.edges.updateAll({ styles: new Uint32Array([1]) })).toThrow(GraphError);
    graph.edges.updateAll({ styles: new Uint32Array([1, 2]) });
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "updateEdges" }>;
    expect(last.t).toBe("updateEdges");
    expect(Array.from(last.styles!)).toEqual([1, 2]);
  });

  it("edges.flag checks live slots and sends the bits", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.edges.set({ count: 3, indices: new Uint32Array([0, 1, 1, 2, 2, 0]) });
    graph.edges.remove([2]);
    expect(() => graph.edges.flag(new Uint32Array([2]), Flag.dimmed, true)).toThrow(/not a live slot/);
    expect(() => graph.edges.flag(new Uint32Array([0, 0]), Flag.dimmed, true)).toThrow(/listed twice/);
    expect(() => graph.edges.flag(new Uint32Array([0]), 1, true)).toThrow(GraphError);
    graph.edges.flag(new Uint32Array([1]), Flag.selected, true);
    const last = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "flagEdges" }>;
    expect(last).toMatchObject({ t: "flagEdges", flags: Flag.selected, on: true });
    expect(Array.from(last.indices!)).toEqual([1]);
    graph.edges.flag("all", Flag.selected, false);
    expect((FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "flagEdges" }>).indices).toBeNull();
  });

  it("nodes.set rejects more nodes than edge ends can address", async () => {
    const graph = await createGraph();
    expect(() => graph.nodes.set({ count: 2 ** 28 + 1 })).toThrow(/limit|at most/);
  });

  it("nodes.add reuses removed slots and returns them", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.nodes.remove([1]);
    graph.nodes.remove([2]);
    FakeWorker.last.onmessage?.({ data: { t: "edgesRemoved", id: 1, edges: new Uint32Array(0) } } as MessageEvent);
    FakeWorker.last.onmessage?.({ data: { t: "edgesRemoved", id: 2, edges: new Uint32Array(0) } } as MessageEvent);
    const added = graph.nodes.add({ count: 3 });
    expect(Array.from(added).sort()).toEqual([1, 2, 3]);
    expect(graph.nodes.count).toBe(4);
    expect(graph.nodes.slots).toBe(4);
  });

  it("nodes.add sends labels when given, and nothing when not", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 1, labels: ["a"] });
    graph.nodes.add({ count: 1, labels: ["b"] });
    const withLabels = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "addNodes" }>;
    expect(withLabels.labels).toEqual(["b"]);
    graph.nodes.add({ count: 1 });
    const withoutLabels = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "addNodes" }>;
    expect(withoutLabels.labels).toBeUndefined();
  });

  it("nodes.remove rejects a node already removed", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    graph.nodes.remove([0]);
    expect(() => graph.nodes.remove([0])).toThrow(/not a live slot/);
  });

  it("edgesRemoved frees edge slots and reaches listeners", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) });
    const got: number[][] = [];
    graph.on("edgesRemoved", (e) => got.push(Array.from(e)));
    graph.nodes.remove([1]);
    FakeWorker.last.onmessage?.({ data: { t: "edgesRemoved", id: 1, edges: new Uint32Array([0, 1]) } } as MessageEvent);
    expect(got).toEqual([[0, 1]]);
    expect(graph.edges.count).toBe(0);
  });

  it("edges.add does not reuse edge slots while a node removal is in flight", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) });
    graph.edges.remove([0]);
    graph.nodes.remove([2]);
    const added = graph.edges.add({ count: 1, indices: new Uint32Array([0, 1]) });
    expect(Array.from(added)).toEqual([2]);
    FakeWorker.last.onmessage?.({ data: { t: "edgesRemoved", id: 1, edges: new Uint32Array([1]) } } as MessageEvent);
    expect(Array.from(graph.edges.add({ count: 1, indices: new Uint32Array([0, 1]) }))[0]).toBeLessThan(2);
  });

  it("edges.add rejects an end on a removed node", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    graph.edges.set({ count: 0, indices: new Uint32Array(0) });
    graph.nodes.remove([1]);
    expect(() => graph.edges.add({ count: 1, indices: new Uint32Array([0, 1]) })).toThrow(GraphError);
  });

  it("nodes.set clears the edges", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    graph.edges.set({ count: 1, indices: new Uint32Array([0, 1]) });
    graph.nodes.set({ count: 2 });
    expect(graph.edges.count).toBe(0);
  });

  it("nodes.compact returns the remap and resets slots", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.nodes.remove([0]);
    expect(Array.from(graph.nodes.compact())).toEqual([NO_INDEX, 0, 1]);
    expect(graph.nodes.slots).toBe(2);
  });

  it("rejects z-index above 15", async () => {
    const graph = await createGraph();
    expect(() => graph.nodes.set({ count: 1, zIndex: new Uint8Array([16]) })).toThrow(GraphError);
  });

  it("a stream taken before the slots changed refuses to commit", async () => {
    vi.stubGlobal("SharedArrayBuffer", undefined);
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    const s = graph.nodes.stream({ positions: true });
    graph.nodes.add({ count: 1 });
    expect(() => s.commit()).toThrow(/take a new stream/);
  });

  it("nodes.add, remove and compact send their messages", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    const added = graph.nodes.add({ count: 1, positions: new Float32Array([5, 6]) });
    const add = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "addNodes" }>;
    expect(add).toMatchObject({ t: "addNodes", slots: 3 });
    expect(Array.from(add.indices)).toEqual([2]);
    expect(add.indices).not.toBe(added);
    expect(Array.from(add.positions!)).toEqual([5, 6]);
    graph.nodes.remove(new Uint32Array([0]));
    const remove = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "removeNodes" }>;
    expect(remove).toMatchObject({ t: "removeNodes", id: 1 });
    expect(Array.from(remove.indices)).toEqual([0]);
    const remap = graph.nodes.compact();
    const compact = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "compactNodes" }>;
    expect(compact.t).toBe("compactNodes");
    expect(Array.from(compact.remap)).toEqual(Array.from(remap));
    expect(compact.remap).not.toBe(remap);
  });

  it("nodes.updateAll covers the node slots, removed ones included", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.nodes.remove([1]);
    expect(() => graph.nodes.updateAll({ colors: new Uint32Array(2) })).toThrow(GraphError);
    graph.nodes.updateAll({ colors: new Uint32Array(3) });
    expect(FakeWorker.last.sent.at(-1)!.t).toBe("updateNodes");
  });

  it("edgesRemoved after edges.compact frees the remapped slots", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.edges.set({ count: 3, indices: new Uint32Array([0, 1, 1, 2, 0, 2]) });
    const got: number[][] = [];
    graph.on("edgesRemoved", (e) => got.push(Array.from(e)));
    graph.edges.remove([0]);
    graph.nodes.remove([2]);
    expect(Array.from(graph.edges.compact())).toEqual([NO_INDEX, 0, 1]);
    FakeWorker.last.onmessage?.({ data: { t: "edgesRemoved", id: 1, edges: new Uint32Array([1, 2]) } } as MessageEvent);
    expect(got).toEqual([[0, 1]]);
    expect(graph.edges.count).toBe(0);
  });

  it("edgesRemoved after edges.set frees nothing", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) });
    const got: number[][] = [];
    graph.on("edgesRemoved", (e) => got.push(Array.from(e)));
    graph.nodes.remove([2]);
    graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 0]) });
    FakeWorker.last.onmessage?.({ data: { t: "edgesRemoved", id: 1, edges: new Uint32Array([1]) } } as MessageEvent);
    expect(got).toEqual([[]]);
    expect(graph.edges.count).toBe(2);
  });

  it("camera.set and canvas.render post view and render", async () => {
    const graph = await createGraph();
    graph.camera.set({ zoom: 2 });
    graph.canvas.render();
    const kinds = FakeWorker.last.sent.map((m) => (m as ToWorker).t);
    expect(kinds).toContain("view");
    expect(kinds).toContain("render");
  });

  it("camera.get reports zoom in CSS px", async () => {
    const graph = await createGraph({ pixelRatio: 2 });
    const data = new Float64Array(STATE_SLOTS);
    data[STATE_SLOT.CAMERA_ZOOM] = 4;
    FakeWorker.last.onmessage?.({ data: { t: "state", data } } as MessageEvent);
    expect(graph.camera.get().zoom).toBe(2);
  });

  it("camera.set posts the animation", async () => {
    const graph = await createGraph();
    graph.camera.set({ x: 3 }, { duration: 200, easing: "linear" });
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "view", view: { x: 3 }, duration: 200, easing: "linear" });
    expect(() => graph.camera.set({ x: 3 }, { duration: -1 })).toThrow(GraphError);
    expect(() => graph.camera.set({ x: 3 }, { duration: 10, easing: "bounce" as "ease" })).toThrow(GraphError);
  });

  it("camera.fit posts nodes, padding and duration", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.camera.fit({ nodes: new Uint32Array([1]), duration: 300 });
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "fit", padding: 24, nodes: new Uint32Array([1]), duration: 300 });
    graph.camera.fit({ bounds: { minX: 0, minY: 1, maxX: 2, maxY: 3 }, padding: 0 });
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "fit", padding: 0, bounds: { minX: 0, minY: 1, maxX: 2, maxY: 3 }, duration: 0 });
    graph.camera.fit();
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "fit", padding: 24, duration: 0 });
  });

  it("camera.fit rejects dead or out-of-range nodes and bad bounds", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.nodes.remove([2]);
    expect(() => graph.camera.fit({ nodes: new Uint32Array([2]) })).toThrow(/not a live slot/);
    expect(() => graph.camera.fit({ nodes: new Uint32Array([7]) })).toThrow(/not a live slot/);
    expect(() => graph.camera.fit({ bounds: { minX: 1, minY: 0, maxX: 0, maxY: 1 } })).toThrow(GraphError);
    expect(() => graph.camera.fit({ nodes: new Uint32Array([0]), bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } })).toThrow(GraphError);
    expect(() => graph.camera.fit({ padding: -1 })).toThrow(GraphError);
  });

  it("camera.rotate and camera.limits post their messages", async () => {
    const graph = await createGraph();
    graph.camera.rotate(0.5, { x: 10, y: 20, duration: 100 });
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "rotate", angle: 0.5, x: 10, y: 20, duration: 100 });
    graph.camera.rotate(-1);
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "rotate", angle: -1, duration: 0 });
    graph.camera.limits({ minZoom: 0.5, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } });
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "limits", minZoom: 0.5, maxZoom: Infinity, bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } });
    graph.camera.limits({});
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "limits", minZoom: 0, maxZoom: Infinity, bounds: null });
    expect(() => graph.camera.limits({ minZoom: 2, maxZoom: 1 })).toThrow(GraphError);
    expect(() => graph.camera.rotate(NaN)).toThrow(GraphError);
  });

  it("camera.toScreen and toWorld use the published view in CSS px", async () => {
    const graph = await createGraph({ pixelRatio: 2 });
    const data = new Float64Array(STATE_SLOTS);
    data[STATE_SLOT.CAMERA_X] = 10;
    data[STATE_SLOT.CAMERA_Y] = 20;
    data[STATE_SLOT.CAMERA_ZOOM] = 4;
    data[STATE_SLOT.CAMERA_ROTATION] = 0.3;
    data[STATE_SLOT.VIEWPORT_W] = 800;
    data[STATE_SLOT.VIEWPORT_H] = 600;
    FakeWorker.last.onmessage?.({ data: { t: "state", data } } as MessageEvent);
    expect(graph.camera.toScreen(10, 20)).toEqual({ x: 200, y: 150 });
    const out = { x: 0, y: 0 };
    expect(graph.camera.toWorld(200, 150, out)).toBe(out);
    expect(out.x).toBeCloseTo(10, 9);
    expect(out.y).toBeCloseTo(20, 9);
    graph.camera.toScreen(12, 21, out);
    graph.camera.toWorld(out.x, out.y, out);
    expect(out.x).toBeCloseTo(12, 9);
    expect(out.y).toBeCloseTo(21, 9);
    graph.camera.toScreen(11, 20, out);
    expect(Math.hypot(out.x - 200, out.y - 150)).toBeCloseTo(2, 9);
  });

  it("the view event tells the worker to listen and delivers CSS zoom", async () => {
    const graph = await createGraph({ pixelRatio: 2 });
    const worker = FakeWorker.last;
    const got: unknown[] = [];
    const off = graph.on("view", (v) => got.push(v));
    expect(worker.sent.at(-1)).toEqual({ t: "listen", events: ["view"] });
    worker.onmessage?.({ data: { t: "view", x: 1, y: 2, zoom: 8, rotation: 0.5 } } as MessageEvent);
    expect(got).toEqual([{ x: 1, y: 2, zoom: 4, rotation: 0.5 }]);
    off();
    expect(worker.sent.at(-1)).toEqual({ t: "listen", events: [] });
  });

  it("debug.tune posts the tuning as given", async () => {
    const graph = await createGraph();
    graph.debug.tune({ lodTargetPx: 0 });
    expect(FakeWorker.last.sent.at(-1)).toEqual({ t: "tune", tune: { lodTargetPx: 0 } });
  });

  it("debug.tune rejects NaN, Infinity, negative values, a pickRate below 1 and an unknown edge mode, and posts nothing", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const sent = worker.sent.length;
    const bad = [{ lodTargetPx: NaN }, { edgeMaxOverdraw: Infinity }, { edgeMinLengthPx: -1 }, { pickRate: 0.5 }, { pickRate: -Infinity }, { edgeMode: "blue" as never }];
    for (const tune of bad) expect(errorCode(() => graph.debug.tune(tune))).toBe("invalid-argument");
    expect(worker.sent.length).toBe(sent);
    graph.debug.tune({ pickRate: 1, edgeMinLengthPx: 0, edgeMode: "chunk" });
    expect(worker.sent.at(-1)).toEqual({ t: "tune", tune: { pickRate: 1, edgeMinLengthPx: 0, edgeMode: "chunk" } });
  });

  it("the fallback stream clamps z-index above 15 and leaves the host array as written", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    graph.nodes.set({ count: 3 });
    const stream = graph.nodes.stream({ zIndex: true });
    stream.zIndex.set([20, 3, 255]);
    stream.commit();
    const update = worker.sent.at(-1) as Extract<ToWorker, { t: "updateNodes" }>;
    expect(Array.from(update.zIndex!)).toEqual([15, 3, 15]);
    expect(Array.from(stream.zIndex)).toEqual([20, 3, 255]);
  });

  it("z-index above 15 throws on add, update and updateAll", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    const sent = FakeWorker.last.sent.length;
    expect(errorCode(() => graph.nodes.add({ count: 1, zIndex: new Uint8Array([16]) }))).toBe("invalid-argument");
    expect(errorCode(() => graph.nodes.update(new Uint32Array([0]), { zIndex: new Uint8Array([16]) }))).toBe("invalid-argument");
    expect(errorCode(() => graph.nodes.updateAll({ zIndex: new Uint8Array([0, 16]) }))).toBe("invalid-argument");
    expect(FakeWorker.last.sent.length).toBe(sent);
  });

  it("the shared-memory stream refuses to commit once the slots changed", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    const s = graph.nodes.stream({ positions: true });
    expect(FakeWorker.last.sent.at(-1)).toMatchObject({ t: "nodeStream", count: 2, positions: true });
    s.positions.set([1, 2, 3, 4]);
    expect(() => s.commit()).not.toThrow();
    graph.nodes.add({ count: 1 });
    expect(() => s.commit()).toThrow(/take a new stream/);
  });

  it("compact with nothing removed returns the identity table and posts nothing", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    graph.nodes.set({ count: 3 });
    graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) });
    const sent = worker.sent.length;
    expect(Array.from(graph.nodes.compact())).toEqual([0, 1, 2]);
    expect(Array.from(graph.edges.compact())).toEqual([0, 1]);
    expect(worker.sent.length).toBe(sent);
    expect(Array.from(graph.nodes.add({ count: 1 }))).toEqual([3]);
    expect(Array.from(graph.edges.add({ count: 1, indices: new Uint32Array([0, 3]) }))).toEqual([2]);
  });

  it("edges.add with count 0 and icons.add with no icons post nothing", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    graph.nodes.set({ count: 2 });
    const sent = worker.sent.length;
    expect(graph.edges.add({ count: 0, indices: new Uint32Array(0) })).toEqual(new Uint32Array(0));
    await expect(graph.icons.add([])).resolves.toEqual(new Uint16Array(0));
    expect(worker.sent.length).toBe(sent);
  });

  it("debug.benchmark, icons.define and icons.add reject with destroyed after destroy", async () => {
    const graph = await createGraph();
    const running = graph.debug.benchmark({ path: [{ x: 0.5, y: 0.5, zoom: 1 }], frames: 1 });
    graph.destroy();
    await expect(running).rejects.toMatchObject({ code: "destroyed" });
    await expect(graph.debug.benchmark({ path: [{ x: 0.5, y: 0.5, zoom: 1 }], frames: 1 })).rejects.toMatchObject({ code: "destroyed" });
    await expect(graph.icons.define([{ path: "M0 0H1V1Z" }])).rejects.toMatchObject({ code: "destroyed" });
    await expect(graph.icons.add([{ path: "M0 0H1V1Z" }])).rejects.toMatchObject({ code: "destroyed" });
    await expect(graph.icons.add([])).rejects.toMatchObject({ code: "destroyed" });
    await expect(graph.icons.define([{} as never])).rejects.toMatchObject({ code: "destroyed" });
  });

  it("a define with a bad icon resolves, reports it through error and keeps its id in use", async () => {
    const graph = await createGraph();
    const worker = FakeWorker.last;
    const errors: GraphError[] = [];
    graph.on("error", (e) => errors.push(e));
    const square = { path: "M0 0H1V1Z" };
    const defined = graph.icons.define([square, { path: "X" }, square]);
    const msg = worker.sent.at(-1) as Extract<ToWorker, { t: "defineIcons" }>;
    worker.onmessage?.({ data: { t: "error", code: "invalid-argument", message: "icons: icon 1: bad", fatal: false } });
    worker.onmessage?.({ data: { t: "reply", id: msg.id } });
    await expect(defined).resolves.toBeUndefined();
    expect(errors.map((e) => [e.code, e.message])).toEqual([["invalid-argument", "icons: icon 1: bad"]]);
    void graph.icons.add([square]);
    expect(Array.from((worker.sent.at(-1) as Extract<ToWorker, { t: "setIcons" }>).ids)).toEqual([3]);
    expect(() => graph.icons.replace(1, square)).not.toThrow();
  });

  it("remove rejects an index that is not an integer", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 3 });
    graph.edges.set({ count: 1, indices: new Uint32Array([0, 1]) });
    expect(errorCode(() => graph.nodes.remove([1.5]))).toBe("invalid-argument");
    expect(errorCode(() => graph.edges.remove([0.5]))).toBe("invalid-argument");
    expect(graph.nodes.count).toBe(3);
    expect(graph.edges.count).toBe(1);
  });

  it("the compact table the caller gets is not the one sent to the worker", async () => {
    const graph = await createGraph();
    graph.nodes.set({ count: 2 });
    graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 0]) });
    graph.edges.remove([0]);
    const remap = graph.edges.compact();
    const msg = FakeWorker.last.sent.at(-1) as Extract<ToWorker, { t: "compactEdges" }>;
    expect(msg.remap.buffer).not.toBe(remap.buffer);
    expect(Array.from(remap)).toEqual([NO_INDEX, 0]);
  });
});
