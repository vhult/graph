import { describe, expect, it } from "vitest";
import { GraphError } from "../src/api/errors";
import type { IconSource } from "../src/api/types";
import { ICON_CONSTANTS } from "../src/data/Layouts";
import { buildIcons, type IconSet } from "../src/icons/IconGeometry";

const { ICON_HEADER_WORDS, ICON_RECORD_WORDS, ICON_CURVE_WORDS, ICON_BANDS_MASK, ICON_FLAG_EVEN_ODD } = ICON_CONSTANTS;

function record(set: IconSet, icon: number) {
  const r = ICON_HEADER_WORDS + icon * ICON_RECORD_WORDS;
  const w = set.data[r + 1]!;
  return { bands: set.data[r]!, nb: w & ICON_BANDS_MASK, evenOdd: (w & ICON_FLAG_EVEN_ODD) !== 0, curves: set.data[r + 2]!, count: set.data[r + 3]! };
}

function points(set: IconSet, icon: number): [number, number][] {
  const f = new Float32Array(set.data.buffer);
  const r = record(set, icon);
  const out: [number, number][] = [];
  for (let k = 0; k < r.count * 3; k++) out.push([f[r.curves + k * 2]!, f[r.curves + k * 2 + 1]!]);
  return out;
}

const one = (icon: IconSource) => buildIcons([icon]);

describe("buildIcons", () => {
  it("turns a square path into four line curves inside the unit box", () => {
    const set = one({ path: "M4 4H20V20H4Z" });
    expect(set.count).toBe(1);
    expect(record(set, 0).count).toBe(4);
    const xs = points(set, 0).map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(4 / 24, 5);
    expect(Math.max(...xs)).toBeCloseTo(20 / 24, 5);
  });

  it("parses relative, implicit and smooth commands", () => {
    const set = one({ path: "m2 2 l4 0 0 4 -4 0z m10 0 c2 0 2 4 0 4 s-2-4 0-4z m0 10 q2 2 0 4 t0 4z" });
    expect(record(set, 0).count).toBeGreaterThan(8);
    for (const [x, y] of points(set, 0)) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it("turns arcs into curves that stay on the circle", () => {
    const set = one({ path: "M2 12A10 10 0 1 0 22 12A10 10 0 1 0 2 12Z" });
    const f = new Float32Array(set.data.buffer);
    const r = record(set, 0);
    for (let k = 0; k < r.count; k++) {
      const at = r.curves + k * ICON_CURVE_WORDS;
      expect(Math.hypot(f[at]! - 0.5, f[at + 1]! - 0.5)).toBeCloseTo(10 / 24, 3);
      expect(Math.hypot(f[at + 4]! - 0.5, f[at + 5]! - 0.5)).toBeCloseTo(10 / 24, 3);
    }
  });

  it("reads numbers with exponents", () => {
    expect(record(one({ path: "M1e1 0L2e1 0L2e1 1e1Z" }), 0).count).toBe(3);
  });

  it("rejects anything but a command after Z instead of looping", () => {
    for (const path of ["M0 0L10 0L10 10Z 5", "M0 0L10 0L10 10Z5", "M0 0L10 0L10 10z;"]) {
      expect(() => one({ path })).toThrow(GraphError);
    }
  });

  it("rejects geometry that is not finite", () => {
    expect(() => one({ path: "M0 0H1V1Z", viewBox: [0, 0, 0, 24] })).toThrow(GraphError);
    expect(() => one({ path: "M0 0H1V1Z", viewBox: [0, 0, -24, 24] })).toThrow(GraphError);
    expect(() => one({ path: "M0 0L1e999 0L0 1Z" })).toThrow(GraphError);
  });

  it("applies SVG transforms and turns shapes into paths", () => {
    const set = one({ svg: '<svg viewBox="0 0 24 24"><g transform="translate(12 0)"><rect width="12" height="24"/></g></svg>' });
    const xs = points(set, 0).map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(0.5, 5);
    expect(Math.max(...xs)).toBeCloseTo(1, 5);
    expect(record(one({ svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/><polygon points="0,0 4,0 0,4"/></svg>' }), 0).count).toBeGreaterThan(4);
  });

  it("skips hidden groups even when a child sets its own fill, and unfilled paths", () => {
    const set = one({
      svg: '<svg viewBox="0 0 24 24"><g display="none"><path fill="#000" d="M0 0H4V4Z"/></g><path fill="none" d="M0 0H4V4Z"/><path d="M10 10H14V14Z"/></svg>',
    });
    expect(record(set, 0).count).toBe(3);
    for (const [x] of points(set, 0)) expect(x).toBeGreaterThanOrEqual(10 / 24 - 1e-6);
  });

  it("rejects markup with nothing filled", () => {
    expect(() => one({ svg: '<svg viewBox="0 0 24 24"><path fill="none" d="M0 0H4V4Z"/></svg>' })).toThrow(GraphError);
  });

  it("flags even-odd only when every path is even-odd", () => {
    expect(record(one({ path: "M0 0H24V24H0Z M6 6H18V18H6Z", fillRule: "evenodd" }), 0).evenOdd).toBe(true);
    expect(record(one({ path: "M0 0H24V24H0Z" }), 0).evenOdd).toBe(false);
    const mixed = one({ svg: '<svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="M0 0H10V10H0Z"/><path d="M12 12H20V20Z"/></svg>' });
    expect(record(mixed, 0).evenOdd).toBe(false);
  });

  it("sorts each band's curves for both ray directions", () => {
    const set = one({ path: "M2 12A10 10 0 1 0 22 12A10 10 0 1 0 2 12Z M8 4H16V20H8Z", fillRule: "evenodd" });
    const f = new Float32Array(set.data.buffer);
    const r = record(set, 0);
    const xs = (w: number) => [f[w]!, f[w + 2]!, f[w + 4]!];
    for (let b = 0; b < r.nb; b++) {
      const list = set.data[r.bands + b * 2]!;
      const count = set.data[r.bands + b * 2 + 1]!;
      const plus = Array.from(set.data.subarray(list, list + count), (w) => Math.max(...xs(w)));
      const minus = Array.from(set.data.subarray(list + count, list + 2 * count), (w) => Math.min(...xs(w)));
      for (let k = 1; k < count; k++) {
        expect(plus[k]!).toBeLessThanOrEqual(plus[k - 1]!);
        expect(minus[k]!).toBeGreaterThanOrEqual(minus[k - 1]!);
      }
    }
  });

  it("writes one record per icon and counts every curve in the header", () => {
    const set = buildIcons([{ path: "M0 0H24V24Z" }, { path: "M0 0H24V24H0Z" }]);
    expect(set.data[0]).toBe(2);
    expect(set.data[1]).toBe(record(set, 0).curves);
    expect(set.data[2]).toBe(7);
    expect(set.curves).toBe(7);
    expect(set.maxCurves).toBe(4);
  });

  it("names the icon that failed", () => {
    expect(() => buildIcons([{ path: "M0 0H1V1Z" }, { path: "X" }])).toThrow(/icon 1/);
  });
});
