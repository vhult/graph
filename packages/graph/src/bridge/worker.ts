/**
 * Render worker entry. Pure message dispatch — all logic lives in Engine.
 */
import { toGraphError } from "../api/errors";
import { Engine } from "../engine/Engine";
import { InputRing, type InputRecord } from "./InputRing";
import { StreamSlots } from "./StreamSlots";
import type { FromWorker, ToWorker } from "./protocol";
import { createStateBuffer } from "./SharedState";

interface WorkerScope {
  postMessage(msg: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
  requestAnimationFrame?: (cb: (t: number) => void) => number;
  navigator: { gpu?: GPU };
  close(): void;
}

const scope = self as unknown as WorkerScope;
const post = (msg: FromWorker, transfer?: Transferable[]) => scope.postMessage(msg, transfer);

/** OffscreenCanvas workers get rAF in Chromium and Firefox; fall back to a timer elsewhere. */
const requestFrame: (cb: (t: number) => void) => void = scope.requestAnimationFrame
  ? (cb) => scope.requestAnimationFrame!(cb)
  : (cb) => setTimeout(() => cb(performance.now()), 16);

/** How often the non-shared state block is posted back (fallback path only). */
const STATE_POST_INTERVAL_MS = 200;

let engine: Engine | null = null;
let state: Float64Array | null = null;
let stateShared = false;
let stateTimer: ReturnType<typeof setInterval> | undefined;
const pending: ToWorker[] = [];
const fallbackRec: InputRecord = { type: 0, t: 0, x: 0, y: 0, dx: 0, dy: 0, buttons: 0, mods: 0, button: -1 };

function fail(e: unknown, fatal: boolean): void {
  const err = toGraphError(e);
  post({ t: "error", code: err.code, message: err.message, fatal });
}

async function init(msg: Extract<ToWorker, { t: "init" }>): Promise<void> {
  stateShared = msg.state !== null;
  state = msg.state ? new Float64Array(msg.state) : createStateBuffer(false);
  try {
    engine = await Engine.create({
      canvas: msg.canvas,
      width: msg.width,
      height: msg.height,
      pixelRatio: msg.pixelRatio,
      ring: msg.ring ? new InputRing(msg.ring) : null,
      state,
      options: msg.options,
      gpu: scope.navigator.gpu,
      requestFrame,
      onError: fail,
      onReply: (id, value, error, transfer) => post(error ? { t: "reply", id, code: error.code, message: error.message } : { t: "reply", id, value }, transfer),
      onHit: (event, hit) => post({ t: event, hit }),
      onGesture: (msg) => post(msg),
      onDragStart: (index, nodes, x, y) => post({ t: "dragStart", index, nodes, x, y }, [nodes.buffer as ArrayBuffer]),
      onDrag: (event, index, dx, dy) => post({ t: event, index, dx, dy }),
      onView: (x, y, zoom, rotation) => post({ t: "view", x, y, zoom, rotation }),
      onSelect: (event) => post({ t: "select", ...event }, [event.nodes.buffer as ArrayBuffer]),
      probeSink: {
        ring: (layout, frames, buffer) => post({ t: "debugRing", columns: layout.columns, gpuGroups: layout.gpuGroups, frames, buffer }),
        rows: (data) => post({ t: "debugRows", data }, [data.buffer as ArrayBuffer]),
        totals: (messages) => post({ t: "debugTotals", messages }),
        recording: (layout, data, rows, durationMs, messages) =>
          post({ t: "debugRecording", columns: layout.columns, gpuGroups: layout.gpuGroups, data, rows, durationMs, messages }, [data.buffer as ArrayBuffer]),
      },
    });
  } catch (e) {
    fail(e, true);
    return;
  }
  if (!stateShared) startStatePosting();
  post({ t: "ready", caps: engine.caps });
  for (const m of pending.splice(0)) {
    try {
      dispatch(m);
    } catch (e) {
      fail(e, false);
    }
  }
}

function startStatePosting(): void {
  let lastFrame = -1;
  stateTimer = setInterval(() => {
    if (!state || state[0] === lastFrame) return;
    lastFrame = state[0]!;
    post({ t: "state", data: state.slice() });
  }, STATE_POST_INTERVAL_MS);
}

function dispatch(msg: ToWorker): void {
  const e = engine!;
  switch (msg.t) {
    case "resize":
      return e.resize(msg.width, msg.height, msg.pixelRatio);
    case "wake":
      return e.wake();
    case "inputRecord": {
      const [type, t, x, y, dx, dy, buttons, mods, button] = msg.r;
      Object.assign(fallbackRec, { type, t, x, y, dx, dy, buttons, mods, button });
      e.input(fallbackRec);
      return e.wake();
    }
    case "input":
      return e.setInput(msg.input);
    case "nodes":
      return e.setNodes(msg.count, msg, msg.labels ?? []);
    case "defineIcons":
      return e.defineIcons(msg.id, msg.icons);
    case "setIcons":
      return e.defineIcons(msg.id, msg.icons, msg.ids);
    case "removeIcons":
      return e.removeIcons(msg.ids);
    case "nodeStream":
      return e.setStream(new StreamSlots(msg.buffer, msg.count, msg.positions, msg.colors, msg.zIndex));
    case "edges":
      return e.setEdges(msg.count, msg, msg.labels ?? []);
    case "addEdges":
      return e.addEdges(msg.at, msg.count, msg, msg.labels);
    case "removeEdges":
      return e.hideEdges(msg.indices);
    case "updateEdgesAt":
      return e.updateEdgesAt(msg.at, msg, msg.labels);
    case "updateEdges":
      return e.updateEdges(msg, msg.labels);
    case "flagEdges":
      return e.flagEdges(msg.indices, msg.flags, msg.on);
    case "compactEdges":
      return e.compactEdges(msg.remap);
    case "updateNodes":
      return e.updateNodes(msg.start, msg, msg.labels);
    case "updateNodesAt":
      return e.updateNodesAt(msg.indices, msg, msg.labels);
    case "flagNodes":
      return e.flagNodes(msg.indices, msg.flags, msg.on);
    case "addNodes":
      return e.addNodes(msg.indices, msg.slots, msg, msg.labels);
    case "removeNodes": {
      const edges = e.removeNodes(msg.indices);
      post({ t: "edgesRemoved", id: msg.id, edges }, [edges.buffer as ArrayBuffer]);
      return;
    }
    case "compactNodes":
      return e.compactNodes(msg.remap);
    case "view":
      return e.setView(msg.view, msg.duration ?? 0, msg.easing ?? "ease");
    case "fit":
      return e.fit(msg.padding, msg.nodes ?? null, msg.bounds ?? null, msg.duration);
    case "rotate":
      return e.rotate(msg.angle, msg.x, msg.y, msg.duration);
    case "limits":
      return e.limits(msg.minZoom, msg.maxZoom, msg.bounds);
    case "listen":
      return e.listen(msg.events);
    case "style":
      return e.setStyle(msg.style);
    case "render":
      return e.requestRender();
    case "benchmark":
      return e.benchmark(msg.id, msg.options);
    case "labelSnapshot":
      return e.labelSnapshot(msg.id);
    case "snapshot":
      return e.snapshot(msg.id, msg.type);
    case "queryAt":
      return e.queryAt(msg.id, msg.x, msg.y);
    case "queryInside":
      return e.queryInside(msg.id, msg.points);
    case "tune":
      return e.tune(msg.tune);
    case "debug":
      return e.probe.setLevel(msg.level);
    case "debugRecord":
      return e.probe.record(msg.on);
    case "destroy":
      clearInterval(stateTimer);
      e.destroy();
      engine = null;
      post({ t: "destroyed" });
      scope.close();
      return;
    case "init":
      return; // handled before dispatch
  }
}

scope.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.t === "init") {
    void init(msg);
    return;
  }
  if (!engine) {
    pending.push(msg);
    return;
  }
  try {
    if (engine.probe.full) {
      const t0 = performance.now();
      dispatch(msg);
      engine?.probe.message(msg.t, performance.now() - t0);
    } else dispatch(msg);
  } catch (e) {
    fail(e, false);
  }
};
