import { describe, expect, it } from "vitest";
import { CONSTANTS, DEFAULT_NODE_STYLE } from "../src/data/Layouts";
import { ICON_PALETTE_MAX, packIconColors, packNodeSizes, packNodeStyle, packRgba, paletteIndices, toHalfBits } from "../src/data/Pack";

type F16Ctor = new (n: number) => { [i: number]: number; buffer: ArrayBuffer };

describe("Pack", () => {
  it("toHalfBits matches known binary16 encodings", () => {
    expect(toHalfBits(0)).toBe(0x0000);
    expect(toHalfBits(-0)).toBe(0x8000);
    expect(toHalfBits(1)).toBe(0x3c00);
    expect(toHalfBits(-2)).toBe(0xc000);
    expect(toHalfBits(0.5)).toBe(0x3800);
    expect(toHalfBits(65504)).toBe(0x7bff);
    expect(toHalfBits(1e6)).toBe(0x7c00);
    expect(toHalfBits(2 ** -24)).toBe(0x0001);
    expect(toHalfBits(Infinity)).toBe(0x7c00);
    expect(toHalfBits(NaN) & 0x7c00).toBe(0x7c00);
  });

  it("toHalfBits agrees with native Float16Array", () => {
    const F16 = (globalThis as { Float16Array?: F16Ctor }).Float16Array;
    if (!F16) return;
    const h = new F16(1);
    const bits = new Uint16Array(h.buffer);
    for (const v of [0.1, 3.14159, 1234.5, 7.999, 1e-5, 42]) {
      h[0] = v;
      expect(toHalfBits(v)).toBe(bits[0]);
    }
  });

  it("packNodeSizes puts size in the low half and keeps the icon colour index", () => {
    const out = packNodeSizes(new Float32Array([1, 2]), new Uint32Array(2));
    expect(out[0]).toBe(0x3c00);
    expect(out[1]).toBe(0x4000);
    const kept = packNodeSizes(new Float32Array([1, 2]), new Uint32Array([0, 5 << 16, 7 << 16]), 1);
    expect(Array.from(kept)).toEqual([0x3c00 | (5 << 16), (0x4000 | (7 << 16)) >>> 0]);
    expect(packNodeSizes(new Float32Array([1, 2]), new Uint32Array([9 << 16]))[1]).toBe(0x4000);
  });

  it("packIconColors writes the high half and keeps the size", () => {
    expect(Array.from(packIconColors(new Uint32Array([0x3c00 | (4 << 16), 0x4000]), new Uint16Array([2, 65535])))).toEqual([0x3c00 | (2 << 16), (0x4000 | (65535 << 16)) >>> 0]);
  });

  it("packNodeStyle writes icons and keeps shapes and layers, from any start", () => {
    const { STYLE_ICON_SHIFT, STYLE_ICON_MASK, STYLE_SHAPE_MASK, STYLE_ZLAYER_SHIFT, NO_ICON } = CONSTANTS;
    const icon = (w: number) => (w >>> STYLE_ICON_SHIFT) & STYLE_ICON_MASK;
    const prev = packNodeStyle(3, new Uint32Array(0), new Uint8Array([1, 2, 0]), new Uint8Array([3, 4, 5]));
    expect(Array.from(prev, icon)).toEqual([NO_ICON, NO_ICON, NO_ICON]);
    const out = packNodeStyle(2, prev, undefined, undefined, new Uint16Array([7, 8]), 1);
    expect(Array.from(out, icon)).toEqual([7, 8]);
    expect(Array.from(out, (w) => w & STYLE_SHAPE_MASK)).toEqual([2, 0]);
    expect(Array.from(out, (w) => (w >>> STYLE_ZLAYER_SHIFT) & 0xf)).toEqual([4, 5]);
    expect(packNodeStyle(1, new Uint32Array(0), undefined, undefined, undefined, 4)[0]).toBe(DEFAULT_NODE_STYLE);
  });

  it("paletteIndices dedups colours with white first", () => {
    const p = paletteIndices(new Uint32Array([0xff0000ff, 0xffffffff, 0xff0000ff, 0xff00ff00]), new Uint32Array(0))!;
    expect(Array.from(p.indices)).toEqual([1, 0, 1, 2]);
    expect(Array.from(p.palette)).toEqual([0xffffffff, 0xff0000ff, 0xff00ff00]);
  });

  it("paletteIndices keeps an existing palette and appends to it", () => {
    const first = paletteIndices(new Uint32Array([0xff0000ff]), new Uint32Array(0))!;
    const next = paletteIndices(new Uint32Array([0xff00ff00, 0xff0000ff]), first.palette)!;
    expect(Array.from(next.indices)).toEqual([2, 1]);
    expect(Array.from(next.palette)).toEqual([0xffffffff, 0xff0000ff, 0xff00ff00]);
    expect(paletteIndices(new Uint32Array([0xff0000ff]), first.palette)!.palette).toBe(first.palette);
  });

  it("paletteIndices gives up past the palette size", () => {
    const colors = Uint32Array.from({ length: ICON_PALETTE_MAX + 1 }, (_, i) => i);
    expect(paletteIndices(colors, new Uint32Array(0))).toBeNull();
    expect(paletteIndices(colors.subarray(0, ICON_PALETTE_MAX - 1), new Uint32Array(0))).not.toBeNull();
  });

  it("packRgba is little-endian rgba8unorm", () => {
    expect(packRgba(1, 0, 0, 1)).toBe(0xff0000ff);
    expect(packRgba(0, 0, 1, 0)).toBe(0x00ff0000);
  });
});
