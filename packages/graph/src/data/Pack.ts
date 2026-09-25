/** CPU-side packing helpers matching the GPU layouts in `Layouts.ts`. */
import { CONSTANTS, DEFAULT_NODE_STYLE } from "./Layouts";

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE-754 binary16 bits for `v`, round-to-nearest-even. */
export function toHalfBits(v: number): number {
  f32[0] = v;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const abs = x & 0x7fffffff;
  if (abs >= 0x7f800000) return sign | 0x7c00 | (abs > 0x7f800000 ? 0x200 : 0); // inf / nan
  const exp = (abs >>> 23) - 112;
  if (exp >= 31) return sign | 0x7c00; // overflow -> inf
  const mant = abs & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign; // underflow -> 0
    const m = (mant | 0x800000) >>> (1 - exp);
    return sign | ((m + 0xfff + ((m >>> 13) & 1)) >>> 13);
  }
  // `+` (not `|`) so a rounding carry propagates into the exponent.
  return sign | ((exp << 10) + ((mant + 0xfff + ((mant >>> 13) & 1)) >>> 13));
}

type Float16ArrayCtor = new (buffer: ArrayBufferLike, byteOffset?: number, length?: number) => { [i: number]: number };
const Float16 = (globalThis as { Float16Array?: Float16ArrayCtor }).Float16Array;

/**
 * Pack diameters into the `nodeSize` layout: low half = size (f16), high half =
 * icon colour index, kept from `previous[start + i]`. Uses native `Float16Array` when available.
 */
export function packNodeSizes(sizes: Float32Array, previous: Uint32Array, start = 0): Uint32Array {
  const { SIZE_ICON_COLOR_SHIFT } = CONSTANTS;
  const n = sizes.length;
  const out = new Uint32Array(n);
  const m = Math.max(0, Math.min(n, previous.length - start));
  if (Float16) {
    const h = new Float16(out.buffer, out.byteOffset, n * 2);
    for (let i = 0; i < n; i++) h[i * 2] = sizes[i]!;
    const hi = new Uint16Array(out.buffer, out.byteOffset, n * 2);
    for (let i = 0; i < m; i++) hi[i * 2 + 1] = previous[start + i]! >>> SIZE_ICON_COLOR_SHIFT;
  } else {
    for (let i = 0; i < n; i++) out[i] = (toHalfBits(sizes[i]!) | (i < m ? (previous[start + i]! >>> SIZE_ICON_COLOR_SHIFT) << SIZE_ICON_COLOR_SHIFT : 0)) >>> 0;
  }
  return out;
}

export function packIconColors(words: Uint32Array, indices: Uint16Array): Uint32Array {
  const { SIZE_ICON_COLOR_SHIFT } = CONSTANTS;
  const low = (1 << SIZE_ICON_COLOR_SHIFT) - 1;
  const n = words.length;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = ((words[i]! & low) | (indices[i]! << SIZE_ICON_COLOR_SHIFT)) >>> 0;
  return out;
}

export function packNodeStyle(count: number, previous: Uint32Array, shapes?: Uint8Array, layers?: Uint8Array, icons?: Uint16Array, start = 0): Uint32Array {
  const { STYLE_SHAPE_MASK, STYLE_ZLAYER_SHIFT, STYLE_ZLAYER_MASK, STYLE_ICON_SHIFT, STYLE_ICON_MASK } = CONSTANTS;
  const keep = ~(STYLE_SHAPE_MASK | (STYLE_ZLAYER_MASK << STYLE_ZLAYER_SHIFT) | (STYLE_ICON_MASK << STYLE_ICON_SHIFT));
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const old = start + i < previous.length ? previous[start + i]! : DEFAULT_NODE_STYLE;
    const shape = shapes ? shapes[i]! : old & STYLE_SHAPE_MASK;
    const layer = layers ? Math.min(layers[i]!, STYLE_ZLAYER_MASK) : (old >>> STYLE_ZLAYER_SHIFT) & STYLE_ZLAYER_MASK;
    const icon = icons ? icons[i]! : (old >>> STYLE_ICON_SHIFT) & STYLE_ICON_MASK;
    out[i] = ((old & keep) | shape | (icon << STYLE_ICON_SHIFT) | (layer << STYLE_ZLAYER_SHIFT)) >>> 0;
  }
  return out;
}

export const ICON_PALETTE_MAX = 1 << 16;
const WHITE = 0xffffffff;
const FIBONACCI_HASH = 0x9e3779b1;

export interface PaletteIndices {
  indices: Uint16Array;
  palette: Uint32Array;
}

export function paletteIndices(colors: Uint32Array, palette: Uint32Array): PaletteIndices | null {
  const seed = palette.length > 0 ? palette : new Uint32Array([WHITE]);
  const bits = Math.max(4, Math.ceil(Math.log2(2 * Math.min(seed.length + colors.length, ICON_PALETTE_MAX))));
  const mask = (1 << bits) - 1;
  const keys = new Uint32Array(1 << bits);
  const slots = new Int32Array(1 << bits).fill(-1);
  const find = (c: number): number => {
    let h = Math.imul(c, FIBONACCI_HASH) >>> (32 - bits);
    while (slots[h]! >= 0 && keys[h] !== c) h = (h + 1) & mask;
    return h;
  };
  const out: number[] = Array.from(seed);
  for (let k = 0; k < seed.length; k++) {
    const h = find(seed[k]!);
    keys[h] = seed[k]!;
    slots[h] = k;
  }
  const indices = new Uint16Array(colors.length);
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i]! >>> 0;
    const h = find(c);
    let k = slots[h]!;
    if (k < 0) {
      if (out.length >= ICON_PALETTE_MAX) return null;
      k = out.length;
      out.push(c);
      keys[h] = c;
      slots[h] = k;
    }
    indices[i] = k;
  }
  return { indices, palette: out.length === seed.length && palette.length > 0 ? palette : Uint32Array.from(out) };
}

/** Pack normalized RGBA [0..1] into an rgba8unorm word (little-endian: R in low byte). */
export function packRgba(r: number, g: number, b: number, a = 1): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (c(r) | (c(g) << 8) | (c(b) << 16) | (c(a) << 24)) >>> 0;
}
