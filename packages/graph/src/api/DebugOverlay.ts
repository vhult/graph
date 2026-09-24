import type { DebugLevel, MessageTotals, ToWorker } from "../bridge/protocol";
import type { DebugRecording, DebugSummary, GraphCaps, GraphStats } from "./types";

const POLL_MS = 250;
const PAGE_MEMORY_MS = 10_000;
const WINDOW_MS = 1000;
const CHART_W = 360;
const CHART_H = 64;
const HEADER = 4;

const PALETTE = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac", "#86bcb6", "#d37295"];

const CPU_GROUPS: [string, string[]][] = [
  ["input", ["cpu.input"]],
  ["labels", ["cpu.labels"]],
  ["upload", ["cpu.upload"]],
  ["setup", ["cpu.reserve", "cpu.uniform", "cpu.texture"]],
  ["encode", []],
  ["readback", ["cpu.readback"]],
  ["submit", ["cpu.finish", "cpu.submit", "cpu.after"]],
  ["async", ["cpu.async.profile", "cpu.async.labels"]],
  ["messages", ["cpu.messages"]],
];

const STYLE = `
:host { all: initial; position: absolute; z-index: 10; }
.panel { background: rgba(10, 10, 15, 0.82); color: #cfd3dc; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; border-radius: 4px; padding: 6px 8px; white-space: pre; contain: layout paint style; cursor: pointer; user-select: none; }
.panel.open { cursor: default; user-select: text; max-height: var(--max-h, 80vh); overflow: auto; scrollbar-width: thin; scrollbar-color: #3a3f4b transparent; }
.bar { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.bar .title { color: #e6e9ef; margin-right: auto; }
button { padding: 2px 8px; border: 1px solid #3a3f4b; border-radius: 3px; background: #1a1d24; color: #e6e9ef; font: inherit; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
.status { color: #8b919c; margin-bottom: 4px; }
canvas { display: block; width: ${CHART_W}px; height: ${CHART_H}px; margin: 2px 0; }
.legend { white-space: normal; max-width: ${CHART_W}px; margin-bottom: 6px; }
.legend span { margin-right: 8px; }
.legend i { display: inline-block; width: 8px; height: 8px; margin-right: 3px; }
.h { color: #9aa1ad; }
`;

type MemoryMeasure = () => Promise<{ bytes: number }>;

export interface OverlayHost {
  readonly caps: GraphCaps;
  send(msg: ToWorker): void;
  readStats(out: GraphStats): GraphStats;
  pixelRatio(): number;
}

interface Stat {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface Group {
  name: string;
  cols: number[];
  color: string;
}

const EMPTY: Stat = { n: 0, mean: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN };

export class DebugOverlay {
  private readonly host: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly text: HTMLElement;
  private readonly body: HTMLElement;
  private readonly details: HTMLElement;
  private readonly status: HTMLElement;
  private readonly legend: HTMLElement;
  private readonly gpuChart: HTMLCanvasElement;
  private readonly cpuChart: HTMLCanvasElement;
  private readonly recordButton: HTMLButtonElement;
  private readonly exportButton: HTMLButtonElement;
  private readonly stats = {} as GraphStats;
  private columns: string[] = [];
  private index = new Map<string, number>();
  private gpuGroups: string[] = [];
  private gpuSets: Group[] = [];
  private cpuSets: Group[] = [];
  private ring: Float64Array | null = null;
  private frames = 0;
  private width = 0;
  private scratch = new Float64Array(0);
  private sums = new Float64Array(0);
  private messages: MessageTotals = {};
  private readonly api = new Map<string, [number, number, number]>();
  private recApi: Map<string, [number, number, number]> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private memoryTimer: ReturnType<typeof setInterval> | undefined;
  private pageBytes = NaN;
  private lastHead = -2;
  private lastText = "";
  private lastBody = "";
  private recStart = 0;
  private recording: DebugRecording | null = null;
  private pendingRecord: { resolve: (r: DebugRecording) => void; reject: (e: Error) => void } | null = null;
  private isOpen = false;
  expanded = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly graph: OverlayHost,
  ) {
    this.host = document.createElement("div");
    const root = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.panel = el("div", "panel");
    const bar = el("div", "bar");
    const title = el("span", "title");
    title.textContent = "graph debug";
    this.recordButton = button("Record", () => (this.pendingRecord ? this.stopRecord() : void this.record().catch(() => {})));
    this.exportButton = button("Export JSON", () => this.recording && download(this.recording));
    this.exportButton.disabled = true;
    bar.append(title, this.recordButton, this.exportButton, button("−", () => this.setExpanded(false)));
    this.status = el("div", "status");
    this.gpuChart = chart();
    this.cpuChart = chart();
    this.legend = el("div", "legend");
    this.text = el("div", "");
    this.body = el("div", "");
    this.details = el("div", "");
    this.body.append(bar, this.status, this.gpuChart, this.cpuChart, this.legend, this.details);
    this.panel.append(this.text, this.body);
    root.append(style, this.panel);
    this.panel.addEventListener("click", () => !this.expanded && this.setExpanded(true));
    this.body.hidden = true;
  }

  get open(): boolean {
    return this.isOpen;
  }

  get full(): boolean {
    return this.isOpen && this.expanded;
  }

  get timingApi(): boolean {
    return this.full || this.recApi !== null;
  }

  show(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.canvas.after(this.host);
    this.sendLevel();
    this.timer = setInterval(this.poll, POLL_MS);
    this.poll();
  }

  hide(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    clearInterval(this.timer);
    this.stopMemory();
    this.host.remove();
    this.sendLevel();
  }

  setExpanded(expanded: boolean): void {
    if (expanded === this.expanded) return;
    this.expanded = expanded;
    this.body.hidden = !expanded;
    this.panel.classList.toggle("open", expanded);
    this.lastText = "";
    this.lastBody = "";
    this.lastHead = -2;
    this.sendLevel();
    if (expanded && this.isOpen) this.startMemory();
    else this.stopMemory();
    if (this.isOpen) this.poll();
  }

  record(): Promise<DebugRecording> {
    if (this.pendingRecord) return Promise.reject(new Error("A recording is already running"));
    return new Promise<DebugRecording>((resolve, reject) => {
      this.pendingRecord = { resolve, reject };
      this.recApi = new Map();
      this.recStart = performance.now();
      this.recordButton.textContent = "Stop";
      this.graph.send({ t: "debugRecord", on: true });
    });
  }

  stopRecord(): void {
    if (this.pendingRecord) this.graph.send({ t: "debugRecord", on: false });
  }

  apiCall(name: string, ms: number): void {
    add(this.api, name, ms);
    if (this.recApi) add(this.recApi, name, ms);
  }

  onRing(columns: string[], gpuGroups: string[], frames: number, buffer: SharedArrayBuffer | null): void {
    this.columns = columns;
    this.gpuGroups = gpuGroups;
    this.index = new Map(columns.map((c, k) => [c, k]));
    this.frames = frames;
    this.width = columns.length;
    this.ring = buffer ? new Float64Array(buffer) : null;
    this.scratch = new Float64Array(frames);
    this.sums = new Float64Array(frames);
    this.buildSets();
  }

  onRows(data: Float64Array): void {
    this.ring = data;
  }

  onTotals(messages: MessageTotals): void {
    this.messages = messages;
  }

  onRecording(columns: string[], gpuGroups: string[], data: Float64Array, rows: number, durationMs: number, messages: MessageTotals): void {
    const p = this.pendingRecord;
    this.pendingRecord = null;
    this.recordButton.textContent = "Record";
    const s = this.graph.readStats(this.stats);
    const series: Record<string, number[]> = {};
    const summary: Record<string, DebugSummary> = {};
    const w = columns.length;
    const values = new Float64Array(rows);
    columns.forEach((name, c) => {
      const out = new Array<number>(rows);
      let n = 0;
      for (let k = 0; k < rows; k++) {
        const v = data[k * w + c]!;
        out[k] = v;
        if (v === v) values[n++] = v;
      }
      series[name] = out;
      const st = stat(values, n);
      summary[name] = { n: st.n, ran: rows > 0 ? st.n / rows : 0, mean: st.mean, p50: st.p50, p95: st.p95, p99: st.p99, max: st.max };
    });
    const groups: Record<string, string> = {};
    const slotBase = slotStart(columns);
    gpuGroups.forEach((g, k) => (groups[columns[slotBase + k]!] = g));
    const rec: DebugRecording = {
      schema: 1,
      date: new Date().toISOString(),
      userAgent: navigator.userAgent,
      adapter: this.graph.caps.adapter,
      caps: this.graph.caps,
      nodeCount: s.nodeCount,
      edgeCount: s.edgeCount,
      viewport: [s.viewportWidth, s.viewportHeight],
      pixelRatio: this.graph.pixelRatio(),
      durationMs,
      frames: rows,
      gpuGroups: groups,
      summary,
      series,
      workerMessages: totals(Object.entries(messages)),
      mainThread: totals([...(this.recApi ?? new Map()).entries()]),
    };
    this.recApi = null;
    this.recording = rec;
    this.exportButton.disabled = false;
    this.lastBody = "";
    p?.resolve(rec);
  }

  destroy(): void {
    this.hide();
    this.pendingRecord?.reject(new Error("Graph destroyed"));
    this.pendingRecord = null;
  }

  private sendLevel(): void {
    const level: DebugLevel = !this.isOpen ? 0 : this.expanded ? 2 : 1;
    this.graph.send({ t: "debug", level });
  }

  private startMemory(): void {
    const measure = (performance as unknown as { measureUserAgentSpecificMemory?: MemoryMeasure }).measureUserAgentSpecificMemory;
    if (!measure || !globalThis.crossOriginIsolated || this.memoryTimer) return;
    const run = () => measure.call(performance).then((r) => (this.pageBytes = r.bytes), () => this.stopMemory());
    run();
    this.memoryTimer = setInterval(run, PAGE_MEMORY_MS);
  }

  private stopMemory(): void {
    clearInterval(this.memoryTimer);
    this.memoryTimer = undefined;
  }

  private buildSets(): void {
    const slotBase = slotStart(this.columns);
    const byGroup = new Map<string, number[]>();
    this.gpuGroups.forEach((g, k) => {
      const list = byGroup.get(g) ?? [];
      list.push(slotBase + k);
      byGroup.set(g, list);
    });
    const gap = this.index.get("gpu.gap")!;
    this.gpuSets = [...byGroup.entries(), ["gap", [gap]] as [string, number[]]].map(([name, cols], k) => ({ name, cols, color: PALETTE[k % PALETTE.length]! }));
    this.cpuSets = CPU_GROUPS.map(([name, cols], k) => ({
      name,
      cols: name === "encode" ? this.columns.flatMap((c, i) => (c.startsWith("cpu.encode.") ? [i] : [])) : cols.map((c) => this.index.get(c)!),
      color: PALETTE[k % PALETTE.length]!,
    }));
    const legend = (title: string, sets: Group[]) => {
      const line = el("div", "");
      const h = el("span", "h");
      h.textContent = title;
      line.append(h);
      for (const g of sets) {
        const span = document.createElement("span");
        const dot = document.createElement("i");
        dot.style.background = g.color;
        span.append(dot, g.name);
        line.append(span);
      }
      return line;
    };
    this.legend.replaceChildren(legend("gpu ", this.gpuSets), legend("cpu ", this.cpuSets));
  }

  private readonly poll = (): void => {
    this.host.style.left = `${this.canvas.offsetLeft + 8}px`;
    this.host.style.top = `${this.canvas.offsetTop + 8}px`;
    this.panel.style.setProperty("--max-h", `${Math.max(120, this.canvas.clientHeight - 16)}px`);
    if (this.pendingRecord) this.status.textContent = `recording ${((performance.now() - this.recStart) / 1000).toFixed(1)} s…`;
    else if (this.recording) this.status.textContent = `recorded ${this.recording.frames.toLocaleString("en-US")} frames · ${(this.recording.durationMs / 1000).toFixed(1)} s`;
    else this.status.textContent = "no recording yet (10 s max)";
    const ring = this.ring;
    if (!ring) {
      this.setText("waiting for frames…");
      return;
    }
    const head = ring[0]!;
    const s = this.graph.readStats(this.stats);
    this.setText(this.small(ring, head, s));
    if (!this.expanded) return;
    if (head !== this.lastHead) {
      this.drawChart(this.gpuChart, ring, head, this.gpuSets, true);
      this.drawChart(this.cpuChart, ring, head, this.cpuSets, false);
    }
    this.lastHead = head;
    const body = this.detailText(ring, head, s);
    if (body !== this.lastBody) {
      this.lastBody = body;
      this.details.textContent = body;
    }
  };

  private setText(text: string): void {
    if (text === this.lastText) return;
    this.lastText = text;
    this.text.textContent = text;
  }

  private rowCount(head: number): number {
    return head < 0 ? 0 : Math.min(this.frames, head + 1);
  }

  private at(head: number, back: number): number {
    return HEADER + ((head - back) % this.frames) * this.width;
  }

  private small(ring: Float64Array, head: number, s: GraphStats): string {
    const n = this.rowCount(head);
    const now = performance.timeOrigin + performance.now();
    const T = this.index.get("t")!;
    const I = this.index.get("interval")!;
    const G = this.index.get("gpu")!;
    const S = this.index.get("sampled")!;
    const C = this.index.get("cpu.frame")!;
    const N = this.index.get("nodes")!;
    const E = this.index.get("edges")!;
    let frames = 0;
    let interval = 0;
    let intervals = 0;
    let gpu = 0;
    let gpus = 0;
    let cpu = 0;
    let cpus = 0;
    let nodes = NaN;
    let edges = NaN;
    for (let b = 0; b < n; b++) {
      const r = this.at(head, b);
      const recent = now - ring[r + T]! <= WINDOW_MS;
      if (recent) {
        frames++;
        const iv = ring[r + I]!;
        if (iv === iv) {
          interval += iv;
          intervals++;
        }
        const c = ring[r + C]!;
        if (c === c) {
          cpu += c;
          cpus++;
        }
      }
      if (ring[r + S] === 1) {
        if (nodes !== nodes) {
          nodes = ring[r + N]!;
          edges = ring[r + E]!;
        }
        const g = ring[r + G]!;
        if (g === g && (recent || gpus === 0)) {
          gpu += g;
          gpus++;
        }
      }
      if (!recent && nodes === nodes && gpus > 0) break;
    }
    const pad = (v: string, w: number) => v.padEnd(w);
    const fps = frames === 0 ? "idle" : frames === this.frames ? `${frames}+` : String(frames);
    return [
      `${pad(`fps   ${fps}`, 17)}frame ${intervals ? ms(interval / intervals) : "—"} ms`,
      `${pad(`gpu   ${gpus ? ms(gpu / gpus) : "—"} ms`, 17)}cpu   ${cpus ? ms(cpu / cpus) : "—"} ms`,
      `nodes ${count(nodes)} / ${count(s.nodeCount)}`,
      `edges ${count(edges)} / ${count(s.edgeCount)}`,
    ].join("\n");
  }

  private drawChart(canvas: HTMLCanvasElement, ring: Float64Array, head: number, sets: Group[], gpu: boolean): void {
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.round(CHART_W * dpr);
    const h = Math.round(CHART_H * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    const n = Math.min(this.rowCount(head), CHART_W);
    const S = this.index.get("sampled")!;
    const totals = this.sums;
    let m = 0;
    for (let b = 0; b < n; b++) {
      const r = this.at(head, b);
      let t = 0;
      if (!gpu || ring[r + S] === 1) for (const g of sets) for (const c of g.cols) t += fin(ring[r + c]!);
      totals[b] = t;
      if (t > m) m = t;
    }
    const scale = niceMax(m);
    const k = (h - 10 * dpr) / scale;
    const bw = w / CHART_W;
    for (let b = 0; b < n; b++) {
      const r = this.at(head, b);
      const x = w - (b + 1) * bw;
      if (gpu && ring[r + S] !== 1) continue;
      let y = h;
      for (const g of sets) {
        let v = 0;
        for (const c of g.cols) v += fin(ring[r + c]!);
        if (v <= 0) continue;
        const hh = v * k;
        ctx.fillStyle = g.color;
        ctx.fillRect(x, y - hh, Math.max(1, bw), hh);
        y -= hh;
      }
    }
    ctx.fillStyle = "#9aa1ad";
    ctx.font = `${10 * dpr}px ui-monospace, monospace`;
    ctx.fillText(`${gpu ? "gpu" : "cpu"} ${ms(scale)} ms`, 2 * dpr, 9 * dpr);
    ctx.fillStyle = "rgba(154,161,173,0.35)";
    ctx.fillRect(0, 10 * dpr, w, 1);
  }

  private columnStat(ring: Float64Array, head: number, cols: number[], sampledOnly: boolean): [Stat, number] {
    const n = this.rowCount(head);
    const S = this.index.get("sampled")!;
    const v = this.scratch;
    let k = 0;
    let rows = 0;
    for (let b = 0; b < n; b++) {
      const r = this.at(head, b);
      if (sampledOnly && ring[r + S] !== 1) continue;
      rows++;
      let t = 0;
      let any = false;
      for (const c of cols) {
        const x = ring[r + c]!;
        if (x === x) {
          t += x;
          any = true;
        }
      }
      if (any) v[k++] = t;
    }
    return [stat(v, k), rows];
  }

  private detailText(ring: Float64Array, head: number, s: GraphStats): string {
    const lines: string[] = [];
    const row = (label: string, st: Stat, rows: number, digits = 3) =>
      lines.push(`${label.padEnd(24)}${num(st.mean, digits)}${num(st.p95, digits)}${num(st.max, digits)}${rows > 0 ? `${Math.round((st.n / rows) * 100)}%`.padStart(6) : "     —"}`);
    const header = (title: string) => lines.push("", `${title.padEnd(24)}${"mean".padStart(9)}${"p95".padStart(9)}${"max".padStart(9)}${"ran".padStart(6)}`);
    const n = this.rowCount(head);
    const S = this.index.get("sampled")!;
    let sampled = 0;
    for (let b = 0; b < n; b++) if (ring[this.at(head, b) + S] === 1) sampled++;

    header(`GPU ms (${sampled}/${n} frames)`);
    const one = (name: string) => [this.index.get(name)!];
    const [total, rows] = this.columnStat(ring, head, one("gpu"), true);
    row("total", total, rows);
    for (const g of this.gpuSets) {
      if (g.name === "gap") continue;
      const [st, r] = this.columnStat(ring, head, g.cols, true);
      if (st.n === 0) continue;
      row(g.name, st, r);
      if (g.cols.length > 1)
        for (const c of g.cols) {
          const [cs, cr] = this.columnStat(ring, head, [c], true);
          if (cs.n > 0) row(`  ${this.columns[c]!.slice(4)}`, cs, cr);
        }
    }
    const [gap, gr] = this.columnStat(ring, head, one("gpu.gap"), true);
    row("idle gap", gap, gr);

    header("CPU ms (worker)");
    const cpuCols = this.columns.flatMap((c, i) => (c.startsWith("cpu.") ? [i] : []));
    for (const c of cpuCols) {
      const [st, r] = this.columnStat(ring, head, [c], false);
      if (st.n === 0) continue;
      const name = this.columns[c]!.slice(4);
      row(name === "frame" ? "frame (tick)" : `  ${name}`, st, r);
    }
    const [iv, ir] = this.columnStat(ring, head, one("interval"), false);
    row("frame interval", iv, ir, 2);
    const [age, ar] = this.columnStat(ring, head, one("input.age"), false);
    row("input → frame", age, ar, 2);

    header("Counts");
    const last = (name: string) => {
      const c = this.index.get(name)!;
      for (let b = 0; b < n; b++) {
        const r = this.at(head, b);
        if (ring[r + S] === 1) return ring[r + c]!;
      }
      return NaN;
    };
    lines.push(`${"nodes drawn".padEnd(24)}${count(last("nodes"))} / ${count(s.nodeCount)}`);
    for (const b of ["normal", "foreground", "tiny", "cluster"]) lines.push(`${`  ${b}`.padEnd(24)}${count(last(`nodes.${b}`))}`);
    lines.push(`${"edges drawn".padEnd(24)}${count(last("edges"))} / ${count(s.edgeCount)}`);
    lines.push(`${"labels shown".padEnd(24)}${count(s.labelsShown)} · ${count(s.labelSolves)} solves · +${count(s.labelsAdded)} −${count(s.labelsRemoved)}`);
    const [solve] = this.columnStat(ring, head, one("labels.solve"), false);
    lines.push(`${"label solve ms".padEnd(24)}${solve.n ? `${ms(solve.mean)} mean · ${ms(solve.max)} max (${solve.n})` : "—"}`);
    const [up] = this.columnStat(ring, head, one("upload.bytes"), false);
    lines.push(`${"upload".padEnd(24)}${up.n ? `${bytes(up.mean * up.n)} over ${up.n} frames` : "—"}`);

    const table = (title: string, entries: [string, [number, number, number]][]) => {
      if (entries.length === 0) return;
      lines.push("", `${title.padEnd(24)}${"count".padStart(9)}${"total".padStart(9)}${"max".padStart(9)}`);
      for (const [k, [c, t, m]] of entries.sort((a, b) => b[1][1] - a[1][1])) lines.push(`${`  ${k}`.padEnd(24)}${String(c).padStart(9)}${num(t, 2)}${num(m, 2)}`);
    };
    table("Worker messages ms", Object.entries(this.messages));
    table("Main thread API ms", [...this.api.entries()]);

    lines.push("", "System");
    const c = this.graph.caps;
    lines.push(`${"adapter".padEnd(24)}${c.adapter}`);
    lines.push(`${"viewport".padEnd(24)}${s.viewportWidth}×${s.viewportHeight} px @${s.pixelRatio}x`);
    lines.push(`${"timestamps".padEnd(24)}${c.timestampQuery ? "yes" : "no (GPU times unavailable)"}`);
    lines.push(`${"samples".padEnd(24)}${count(s.droppedSamples)} dropped (readback busy)`);
    lines.push(`${"memory".padEnd(24)}gpu ${bytes(s.gpuBytes)} (engine) · page ${bytes(this.pageBytes)}`);
    lines.push(`${"shared memory".padEnd(24)}${c.sharedMemory ? "SharedArrayBuffer" : "postMessage fallback"}`);
    return lines.join("\n");
  }
}

function slotStart(columns: string[]): number {
  return columns.findIndex((c) => c.startsWith("gpu.") && c !== "gpu.gap");
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function chart(): HTMLCanvasElement {
  return document.createElement("canvas");
}

function add(map: Map<string, [number, number, number]>, name: string, ms: number): void {
  const e = map.get(name);
  if (e) {
    e[0]++;
    e[1] += ms;
    if (ms > e[2]) e[2] = ms;
  } else map.set(name, [1, ms, ms]);
}

function totals(entries: [string, [number, number, number]][]): Record<string, { count: number; totalMs: number; maxMs: number }> {
  return Object.fromEntries(entries.map(([k, [count, totalMs, maxMs]]) => [k, { count, totalMs, maxMs }]));
}

function stat(values: Float64Array, n: number): Stat {
  if (n === 0) return EMPTY;
  const v = values.subarray(0, n).sort();
  let sum = 0;
  for (let k = 0; k < n; k++) sum += v[k]!;
  const q = (p: number) => v[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]!;
  return { n, mean: sum / n, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: v[n - 1]! };
}

function fin(v: number): number {
  return v === v ? v : 0;
}

function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

function ms(v: number): string {
  return v !== v ? "—" : v < 10 ? v.toFixed(2) : v.toFixed(1);
}

function num(v: number, digits: number): string {
  return (v !== v ? "—" : v.toFixed(digits)).padStart(9);
}

function count(v: number): string {
  return v !== v ? "—" : Math.round(v).toLocaleString("en-US");
}

function bytes(v: number): string {
  if (!(v >= 0)) return "—";
  if (v >= 2 ** 30) return `${(v / 2 ** 30).toFixed(2)} GB`;
  if (v >= 2 ** 20) return `${(v / 2 ** 20).toFixed(1)} MB`;
  return `${(v / 1024).toFixed(0)} KB`;
}

function download(rec: DebugRecording): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(rec)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `graph-debug-${rec.date.slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
