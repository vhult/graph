import type { DebugLevel } from "../bridge/protocol";
import type { ProfileSample } from "../gpu/Profiler";

export const DEBUG_RING_FRAMES = 600;
export const DEBUG_HEADER = 4;
const RECORD_CHUNK = 1024;
const RECORD_MAX_MS = 10_000;
const RECORD_MAX_ROWS = 20_000;
const RECORD_SAMPLE_WAIT_MS = 1000;
const POST_MS = 250;
const IDLE_GAP_MS = 1000;

export const DEBUG_BUCKETS = ["normal", "foreground", "tiny", "cluster"] as const;

export const COL = {
  FRAME: 0,
  T: 1,
  INTERVAL: 2,
  DIRTY: 3,
  SAMPLED: 4,
  GPU: 5,
  GPU_GAP: 6,
  NODES: 7,
  EDGES: 8,
  UPLOAD_BYTES: 9,
  LABELS_SHOWN: 10,
  LABEL_SOLVE_MS: 11,
  INPUT_AGE: 12,
  INPUT_COUNT: 13,
  BUCKETS: 14,
} as const;

const FIXED = [
  "frame",
  "t",
  "interval",
  "dirty",
  "sampled",
  "gpu",
  "gpu.gap",
  "nodes",
  "edges",
  "upload.bytes",
  "labels.shown",
  "labels.solve",
  "input.age",
  "input.count",
  ...DEBUG_BUCKETS.map((b) => `nodes.${b}`),
];

export const CPU = {
  FRAME: 0,
  INPUT: 1,
  LABELS: 2,
  UPLOAD: 3,
  RESERVE: 4,
  UNIFORM: 5,
  READBACK: 6,
  FINISH: 7,
  SUBMIT: 8,
  AFTER: 9,
  ASYNC_PROFILE: 10,
  ASYNC_LABELS: 11,
  MESSAGES: 12,
  TEXTURE: 13,
  ENCODE: 14,
} as const;

const CPU_FIXED = ["frame", "input", "labels", "upload", "reserve", "uniform", "readback", "finish", "submit", "after", "async.profile", "async.labels", "messages", "texture"];

export interface ProbeLayout {
  columns: string[];
  gpuGroups: string[];
}

export interface ProbeSink {
  ring(layout: ProbeLayout, frames: number, buffer: SharedArrayBuffer | null): void;
  rows(data: Float64Array): void;
  totals(messages: Record<string, [count: number, totalMs: number, maxMs: number]>): void;
  recording(layout: ProbeLayout, data: Float64Array, rows: number, durationMs: number, messages: Record<string, [number, number, number]>): void;
}

interface Recording {
  start: number;
  t0: number;
  stopAt: number;
  rows: number;
  chunks: Float64Array[];
  stopped: boolean;
  deadline: number;
  messages: Map<string, [number, number, number]>;
}

export class Probe {
  level: DebugLevel = 0;
  private requested: DebugLevel = 0;
  private override: DebugLevel | null = null;
  readonly layout: ProbeLayout;
  readonly width: number;
  readonly row: Float64Array;
  readonly cpuBase: number;
  readonly gpuBase: number;
  readonly encodeBase: number;
  private ring: Float64Array | null = null;
  private shared: boolean;
  private last = 0;
  private lastT0 = NaN;
  private readonly pending: Float64Array;
  private inputAge = -Infinity;
  private inputCount = 0;
  private readonly messages = new Map<string, [number, number, number]>();
  private messagesChanged = false;
  private rowsChanged = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticks = 0;
  private rec: Recording | null = null;
  private recTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly epoch = performance.timeOrigin;

  constructor(
    slotNames: readonly string[],
    gpuGroups: string[],
    computeNames: readonly string[],
    shared: boolean,
    private readonly pageTimeOrigin: number,
    private readonly sink: ProbeSink,
  ) {
    const cpu = [...CPU_FIXED, ...computeNames.map((n) => `encode.${n}`), "encode.render"];
    this.gpuBase = FIXED.length;
    this.cpuBase = this.gpuBase + slotNames.length;
    this.encodeBase = this.cpuBase + CPU.ENCODE;
    this.layout = { columns: [...FIXED, ...slotNames.map((n) => `gpu.${n}`), ...cpu.map((n) => `cpu.${n}`)], gpuGroups };
    this.width = this.layout.columns.length;
    this.row = new Float64Array(this.width);
    this.pending = new Float64Array(3);
    this.shared = shared && typeof SharedArrayBuffer !== "undefined";
  }

  get on(): boolean {
    return this.level > 0;
  }

  get full(): boolean {
    return this.level === 2;
  }

  get recording(): boolean {
    return this.rec !== null;
  }

  setLevel(level: DebugLevel): void {
    this.requested = level;
    if (level > 0 && !this.ring) this.createRing();
    if (level > 0) this.messages.clear();
    this.apply();
  }

  setOverride(level: DebugLevel | null): void {
    this.override = level;
    if (level && !this.ring) this.createRing();
    this.apply();
  }

  record(on: boolean): void {
    if (on) {
      if (this.rec) return;
      if (!this.ring) this.createRing();
      this.rec = { start: -1, t0: performance.now(), stopAt: 0, rows: 0, chunks: [], stopped: false, deadline: Infinity, messages: new Map() };
      this.recTimer = setTimeout(() => this.record(false), RECORD_MAX_MS);
      this.apply();
      return;
    }
    const r = this.rec;
    if (!r || r.stopped) return;
    clearTimeout(this.recTimer);
    r.stopped = true;
    r.stopAt = performance.now();
    r.deadline = performance.now() + RECORD_SAMPLE_WAIT_MS;
    this.recTimer = setTimeout(() => this.finishRecording(true), RECORD_SAMPLE_WAIT_MS);
    this.finishRecording(false);
  }

  begin(t0: number): void {
    const row = this.row;
    row.fill(NaN);
    this.last = t0;
    if (this.full) row.fill(0, this.cpuBase, this.width);
  }

  mark(cpu: number): void {
    const now = performance.now();
    this.row[this.cpuBase + cpu] = now - this.last;
    this.last = now;
  }

  sync(): void {
    this.last = performance.now();
  }

  input(t: number): void {
    const age = this.epoch + performance.now() - (this.pageTimeOrigin + t);
    if (age > this.inputAge) this.inputAge = age;
    this.inputCount++;
  }

  async(cpu: number, ms: number): void {
    this.pending[cpu - CPU.ASYNC_PROFILE] += ms;
  }

  message(type: string, ms: number): void {
    this.pending[CPU.MESSAGES - CPU.ASYNC_PROFILE] += ms;
    add(this.messages, type, ms);
    if (this.rec && !this.rec.stopped) add(this.rec.messages, type, ms);
    this.messagesChanged = true;
  }

  end(frameIndex: number, t0: number, cpuMs: number, dirty: number, uploadBytes: number, labelsShown: number, labelSolveMs: number): void {
    const row = this.row;
    row[COL.FRAME] = frameIndex;
    row[COL.T] = this.epoch + t0;
    const interval = t0 - this.lastT0;
    row[COL.INTERVAL] = interval <= IDLE_GAP_MS ? interval : NaN;
    this.lastT0 = t0;
    row[COL.DIRTY] = dirty;
    row[COL.SAMPLED] = 0;
    row[COL.UPLOAD_BYTES] = uploadBytes;
    row[COL.LABELS_SHOWN] = labelsShown;
    row[COL.LABEL_SOLVE_MS] = labelSolveMs;
    row[COL.INPUT_COUNT] = this.inputCount;
    row[COL.INPUT_AGE] = this.inputCount > 0 ? this.inputAge : NaN;
    this.inputAge = -Infinity;
    this.inputCount = 0;
    const c = this.cpuBase;
    row[c + CPU.FRAME] = cpuMs;
    if (this.full) {
      row[c + CPU.ASYNC_PROFILE] = this.pending[0]!;
      row[c + CPU.ASYNC_LABELS] = this.pending[1]!;
      row[c + CPU.MESSAGES] = this.pending[2]!;
    }
    this.pending.fill(0);
    const ring = this.ring!;
    ring.set(row, DEBUG_HEADER + (frameIndex % DEBUG_RING_FRAMES) * this.width);
    ring[0] = frameIndex;
    this.rowsChanged = true;
    const r = this.rec;
    if (r && !r.stopped) {
      if (r.start < 0) r.start = frameIndex;
      const k = frameIndex - r.start;
      const chunk = Math.floor(k / RECORD_CHUNK);
      if (chunk >= r.chunks.length) r.chunks.push(new Float64Array(RECORD_CHUNK * this.width).fill(NaN));
      r.chunks[chunk]!.set(row, (k % RECORD_CHUNK) * this.width);
      r.rows = k + 1;
      if (r.rows >= RECORD_MAX_ROWS) this.record(false);
    }
  }

  onSample(s: ProfileSample): void {
    if (this.ring) {
      const at = DEBUG_HEADER + (s.frameIndex % DEBUG_RING_FRAMES) * this.width;
      if (this.ring[at + COL.FRAME] === s.frameIndex) this.writeSample(this.ring, at, s);
    }
    const r = this.rec;
    if (r && r.start >= 0) {
      const k = s.frameIndex - r.start;
      if (k >= 0 && k < r.rows) this.writeSample(r.chunks[Math.floor(k / RECORD_CHUNK)]!, (k % RECORD_CHUNK) * this.width, s);
      if (r.stopped) this.finishRecording(false);
    }
  }

  destroy(): void {
    clearInterval(this.timer);
    clearTimeout(this.recTimer);
  }

  private writeSample(dst: Float64Array, at: number, s: ProfileSample): void {
    dst[at + COL.SAMPLED] = 1;
    let visible = 0;
    for (let b = 0; b < s.bucketCounts.length; b++) {
      visible += s.bucketCounts[b]!;
      dst[at + COL.BUCKETS + b] = s.bucketCounts[b]!;
    }
    dst[at + COL.NODES] = visible;
    dst[at + COL.EDGES] = s.edgeCount;
    dst[at + COL.GPU] = s.gpuTotalMs;
    let sum = 0;
    const g = at + this.gpuBase;
    for (let k = 0; k < this.cpuBase - this.gpuBase; k++) {
      const v = s.slotMs[k]!;
      dst[g + k] = v;
      if (v === v) sum += v;
    }
    dst[at + COL.GPU_GAP] = s.gpuTotalMs === s.gpuTotalMs ? Math.max(0, s.gpuTotalMs - sum) : NaN;
  }

  private apply(): void {
    const level = this.override ?? (this.rec ? 2 : this.requested);
    this.level = level;
    if (this.requested > 0 && !this.timer) this.timer = setInterval(this.post, POST_MS);
    if (this.requested === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private createRing(): void {
    const bytes = (DEBUG_HEADER + DEBUG_RING_FRAMES * this.width) * 8;
    const buffer = this.shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
    this.ring = new Float64Array(buffer).fill(NaN);
    this.ring[0] = -1;
    this.ring[1] = this.width;
    this.ring[2] = DEBUG_RING_FRAMES;
    this.sink.ring(this.layout, DEBUG_RING_FRAMES, this.shared ? (buffer as SharedArrayBuffer) : null);
  }

  private readonly post = (): void => {
    if (!this.shared && this.rowsChanged && this.ring) this.sink.rows(this.ring.slice());
    this.rowsChanged = false;
    if (++this.ticks % 4 === 0 && this.messagesChanged) {
      this.messagesChanged = false;
      this.sink.totals(Object.fromEntries(this.messages));
    }
  };

  private finishRecording(force: boolean): void {
    const r = this.rec;
    if (!r || !r.stopped) return;
    if (!force && performance.now() < r.deadline && !this.allSampled(r)) return;
    clearTimeout(this.recTimer);
    this.rec = null;
    this.apply();
    const w = this.width;
    const data = new Float64Array(r.rows * w);
    for (let k = 0; k < r.chunks.length; k++) {
      const rows = Math.min(RECORD_CHUNK, r.rows - k * RECORD_CHUNK);
      if (rows > 0) data.set(r.chunks[k]!.subarray(0, rows * w), k * RECORD_CHUNK * w);
    }
    this.sink.recording(this.layout, data, r.rows, r.stopAt - r.t0, Object.fromEntries(r.messages));
  }

  private allSampled(r: Recording): boolean {
    const w = this.width;
    for (let k = 0; k < r.rows; k++) {
      const v = r.chunks[Math.floor(k / RECORD_CHUNK)]![(k % RECORD_CHUNK) * w + COL.SAMPLED];
      if (v !== 1) return false;
    }
    return true;
  }
}

function add(map: Map<string, [number, number, number]>, type: string, ms: number): void {
  const e = map.get(type);
  if (e) {
    e[0]++;
    e[1] += ms;
    if (ms > e[2]) e[2] = ms;
  } else map.set(type, [1, ms, ms]);
}
