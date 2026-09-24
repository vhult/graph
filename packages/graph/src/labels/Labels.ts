import { LABEL_CONSTANTS, LABEL_PARAMS, LIVE_LABEL } from "../data/Layouts";
import { GlyphAtlas } from "./GlyphAtlas";
import { createRun, layoutLabel } from "./layoutLabel";
import { LiveLabels } from "./LiveLabels";

const { LABEL_GLYPHS, LABEL_SLOTS, LABEL_GLYPH_MAX, LABEL_EDGE_BIT } = LABEL_CONSTANTS;
const MAX_WIDTH_CSS_PX = 200;
const GAP_CSS_PX = 4;
const FADE_S = 0.2;
const WIDTH_SLICE_MS = 4;
const WIDTH_BATCH = 2048;
const GLYPH_TABLE = LABEL_SLOTS * LABEL_GLYPHS;
const LIVE_WORDS = LIVE_LABEL.size / 4;

export interface LabelOptions {
  sizeCssPx: number;
  paddingCssPx: number;
  font: string;
}

export interface LabelMetrics {
  textH: number;
  gap: number;
  padding: number;
  maxWidth: number;
  fadeS: number;
  glyphTable: number;
}

interface TextSet {
  texts: readonly string[] | null;
  count: number;
  minWidth: number;
  words: Uint32Array;
  cursor: number;
  buffer: GPUBuffer;
}

export class Labels {
  readonly atlas: GlyphAtlas;
  readonly live = new LiveLabels(LABEL_SLOTS, FADE_S);
  readonly params: GPUBuffer;
  readonly liveBuffer: GPUBuffer;
  readonly textBuffer: GPUBuffer;
  edgeBitsBuffer: GPUBuffer;
  marksDirty = true;
  generation = 0;
  liveCount = 0;
  solves = 0;
  private readonly nodes: TextSet;
  private readonly edges: TextSet;
  private pixelRatio = 1;
  private readonly run = createRun();
  private readonly slotWords = new Uint32Array(LABEL_GLYPHS);
  private readonly liveData = new ArrayBuffer(LABEL_SLOTS * LIVE_LABEL.size);

  constructor(
    private readonly device: GPUDevice,
    private readonly opts: LabelOptions,
  ) {
    this.atlas = new GlyphAtlas(device);
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    this.params = device.createBuffer({ label: "labels/params", size: LABEL_PARAMS.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.liveBuffer = device.createBuffer({ label: "labels/live", size: LABEL_SLOTS * LIVE_LABEL.size, usage: storage });
    this.textBuffer = device.createBuffer({ label: "labels/text", size: (GLYPH_TABLE + LABEL_GLYPH_MAX * 2) * 4, usage: storage });
    this.edgeBitsBuffer = this.createBuffer("labels/edgeBits", 0);
    this.nodes = this.createSet();
    this.edges = this.createSet();
  }

  get hasNodeText(): boolean {
    return this.nodes.texts !== null && this.nodes.count > 0;
  }

  get hasEdgeText(): boolean {
    return this.edges.texts !== null && this.edges.count > 0;
  }

  get nodeWidths(): GPUBuffer {
    return this.nodes.buffer;
  }

  get edgeWidths(): GPUBuffer {
    return this.edges.buffer;
  }

  get edgeMinWidth(): number {
    return this.edges.minWidth;
  }

  metrics(): LabelMetrics {
    const r = this.pixelRatio;
    return {
      textH: this.atlas.height,
      gap: GAP_CSS_PX * r,
      padding: this.opts.paddingCssPx * r,
      maxWidth: MAX_WIDTH_CSS_PX * r,
      fadeS: FADE_S,
      glyphTable: GLYPH_TABLE,
    };
  }

  setPixelRatio(pixelRatio: number): void {
    this.pixelRatio = pixelRatio;
    if (!this.atlas.configure(Math.round(this.opts.sizeCssPx * pixelRatio), this.opts.font)) return;
    this.restart(this.nodes);
    this.restart(this.edges);
    this.reset();
  }

  setNodeText(texts: readonly string[]): void {
    this.nodes.texts = texts.length > 0 ? texts : null;
    this.restart(this.nodes);
    this.reset();
  }

  setEdgeText(texts: readonly string[]): void {
    this.edges.texts = texts.length > 0 ? texts : null;
    this.restart(this.edges);
    this.resetEdges();
  }

  setNodeCount(nodeCount: number): void {
    this.nodes.count = nodeCount;
    this.restart(this.nodes);
    this.reset();
  }

  setEdgeCount(edgeCount: number): void {
    this.edges.count = edgeCount;
    this.edgeBitsBuffer.destroy();
    this.edgeBitsBuffer = this.createBuffer("labels/edgeBits", Math.ceil(edgeCount / 32) * 4);
    this.restart(this.edges);
    this.resetEdges();
  }

  reset(): void {
    this.live.clear();
    this.generation++;
    this.upload();
  }

  stepWidths(): boolean {
    const t0 = performance.now();
    const a = this.stepSet(this.nodes, t0);
    const b = this.stepSet(this.edges, t0);
    return a || b;
  }

  applyShown(shown: Uint32Array, count: number, now: number): void {
    this.live.update(shown, count, now, this.build);
    this.solves++;
    this.upload();
  }

  settle(now: number): boolean {
    if (!this.live.settle(now)) return false;
    this.upload();
    return true;
  }

  animating(now: number): boolean {
    return now < this.live.animatingUntil();
  }

  destroy(): void {
    this.atlas.destroy();
    for (const b of [this.params, this.liveBuffer, this.textBuffer, this.edgeBitsBuffer, this.nodes.buffer, this.edges.buffer]) b.destroy();
  }

  private resetEdges(): void {
    this.live.clearEdges();
    this.generation++;
    this.upload();
  }

  private createSet(): TextSet {
    return { texts: null, count: 0, minWidth: Infinity, words: new Uint32Array(0), cursor: 0, buffer: this.createBuffer("labels/widths", 0) };
  }

  private createBuffer(label: string, bytes: number): GPUBuffer {
    return this.device.createBuffer({ label, size: Math.max(16, Math.ceil(bytes / 4) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private restart(set: TextSet): void {
    set.buffer.destroy();
    set.buffer = this.createBuffer("labels/widths", Math.ceil(set.count / 2) * 4);
    set.words = new Uint32Array(Math.ceil(set.count / 2));
    set.cursor = 0;
    set.minWidth = Infinity;
  }

  private stepSet(set: TextSet, t0: number): boolean {
    const texts = set.texts;
    if (!texts || set.cursor >= set.count || performance.now() - t0 >= WIDTH_SLICE_MS) return false;
    const m = this.metrics();
    const from = set.cursor;
    let i = from;
    while (i < set.count && performance.now() - t0 < WIDTH_SLICE_MS) {
      const end = Math.min(set.count, i + WIDTH_BATCH);
      for (; i < end; i++) {
        const text = texts[i];
        const w = text ? layoutLabel(text, this.atlas.advance, m.maxWidth, this.atlas.inset, this.run) : 0;
        if (w > 0 && w < set.minWidth) set.minWidth = w;
        const word = i >>> 1;
        set.words[word] = i & 1 ? (set.words[word]! & 0xffff) | (w << 16) : w;
      }
    }
    set.cursor = i;
    const w0 = from >>> 1;
    this.device.queue.writeBuffer(set.buffer, w0 * 4, set.words, w0, Math.ceil(i / 2) - w0);
    return true;
  }

  private readonly build = (user: number, slot: number, index: number): number => {
    const set = (index & LABEL_EDGE_BIT) !== 0 ? this.edges : this.nodes;
    const text = set.texts?.[user];
    if (!text) return 0;
    const run = this.run;
    const width = layoutLabel(text, this.atlas.advance, this.metrics().maxWidth, this.atlas.inset, run);
    if (width === 0) return 0;
    for (let g = 0; g < run.count; g++) this.slotWords[g] = (this.atlas.glyph(run.codes[g]!) | (run.pens[g]! << 16)) >>> 0;
    this.device.queue.writeBuffer(this.textBuffer, slot * LABEL_GLYPHS * 4, this.slotWords, 0, run.count);
    return run.count | (width << 8);
  };

  private upload(): void {
    const entries = this.live.entries;
    const u32 = new Uint32Array(this.liveData);
    const f32 = new Float32Array(this.liveData);
    const at = LIVE_LABEL.offset;
    entries.forEach((e, k) => {
      const o = k * LIVE_WORDS;
      u32[o + at.index / 4] = e.index;
      u32[o + at.slot / 4] = e.slot;
      u32[o + at.run / 4] = e.run;
      f32[o + at.start / 4] = e.start;
      u32[o + at.fadeOut / 4] = e.fadeOut ? 1 : 0;
    });
    this.liveCount = entries.length;
    if (entries.length > 0) this.device.queue.writeBuffer(this.liveBuffer, 0, this.liveData, 0, entries.length * LIVE_LABEL.size);
    if (this.atlas.tableDirty) {
      this.atlas.tableDirty = false;
      this.device.queue.writeBuffer(this.textBuffer, GLYPH_TABLE * 4, this.atlas.table);
    }
    this.marksDirty = true;
  }
}
