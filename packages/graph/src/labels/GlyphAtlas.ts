import { LABEL_CONSTANTS } from "../data/Layouts";

const SIZE = 2048;
const PAD = 1;

export class GlyphAtlas {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly table = new Uint32Array(LABEL_CONSTANTS.LABEL_GLYPH_MAX * 2);
  tableDirty = false;
  inset = 0;
  height = 0;
  private font = "";
  private halo = 0;
  private readonly ascii = new Float64Array(128);
  private readonly advances = new Map<number, number>();
  private readonly ids = new Map<number, number>();
  private next = 1;
  private x = 0;
  private y = 0;
  private rowH = 0;
  private readonly canvas = new OffscreenCanvas(64, 64);
  private readonly ctx: OffscreenCanvasRenderingContext2D;

  constructor(private readonly device: GPUDevice) {
    this.texture = device.createTexture({
      label: "labels/glyphs",
      size: [SIZE, SIZE],
      format: "rg8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.view = this.texture.createView();
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  configure(px: number, family: string): boolean {
    const font = `${px}px ${family}`;
    if (font === this.font) return false;
    this.font = font;
    this.halo = Math.max(2, Math.round(px / 5));
    this.inset = this.halo + PAD;
    this.height = Math.ceil(px * 1.35) + 2 * this.inset;
    this.ascii.fill(-1);
    this.advances.clear();
    this.ids.clear();
    this.table.fill(0);
    this.tableDirty = true;
    this.next = 1;
    this.x = this.y = this.rowH = 0;
    this.ctx.font = font;
    return true;
  }

  readonly advance = (code: number): number => {
    if (code < 128) {
      const a = this.ascii[code]!;
      if (a >= 0) return a;
      return (this.ascii[code] = this.measure(code));
    }
    let a = this.advances.get(code);
    if (a === undefined) {
      a = this.measure(code);
      this.advances.set(code, a);
    }
    return a;
  };

  glyph(code: number): number {
    const known = this.ids.get(code);
    if (known !== undefined) return known;
    const w = Math.ceil(this.advance(code)) + 2 * this.inset;
    const h = this.height;
    if (this.x + w > SIZE) {
      this.x = 0;
      this.y += this.rowH + PAD;
      this.rowH = 0;
    }
    if (this.y + h > SIZE || this.next >= LABEL_CONSTANTS.LABEL_GLYPH_MAX) {
      this.ids.set(code, 0);
      return 0;
    }
    const id = this.next++;
    this.raster(code, w, h);
    this.table[id * 2] = (this.x | (this.y << 16)) >>> 0;
    this.table[id * 2 + 1] = (w | (h << 16)) >>> 0;
    this.tableDirty = true;
    this.ids.set(code, id);
    this.x += w + PAD;
    this.rowH = Math.max(this.rowH, h);
    return id;
  }

  destroy(): void {
    this.texture.destroy();
  }

  private measure(code: number): number {
    return this.ctx.measureText(String.fromCodePoint(code)).width;
  }

  private raster(code: number, w: number, h: number): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (canvas.width < w || canvas.height < h) {
      canvas.width = Math.max(canvas.width, w);
      canvas.height = Math.max(canvas.height, h);
    }
    const text = String.fromCodePoint(code);
    ctx.font = this.font;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = this.halo * 2;
    ctx.fillStyle = ctx.strokeStyle = "#fff";
    ctx.clearRect(0, 0, w, h);
    ctx.strokeText(text, this.inset, h / 2);
    const halo = ctx.getImageData(0, 0, w, h).data;
    ctx.clearRect(0, 0, w, h);
    ctx.fillText(text, this.inset, h / 2);
    const fill = ctx.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h * 2);
    for (let p = 0; p < w * h; p++) {
      out[p * 2] = fill[p * 4 + 3]!;
      out[p * 2 + 1] = Math.max(halo[p * 4 + 3]!, fill[p * 4 + 3]!);
    }
    this.device.queue.writeTexture({ texture: this.texture, origin: { x: this.x, y: this.y } }, out, { bytesPerRow: w * 2 }, [w, h]);
  }
}
