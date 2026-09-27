import { describe, expect, it } from "vitest";
import { DEFAULT_STYLE, mergeStyle, resolveStyle } from "../src/api/style";

describe("style", () => {
  it("resolveStyle fills every field from the defaults", () => {
    expect(resolveStyle(undefined)).toEqual(DEFAULT_STYLE);
    expect(resolveStyle({ nodeScale: 2 }).nodeScale).toBe(2);
    expect(resolveStyle({ nodeScale: 2 }).edge).toEqual(DEFAULT_STYLE.edge);
  });

  it("mergeStyle keeps the fields left out", () => {
    const a = mergeStyle(DEFAULT_STYLE, { edge: { width: 3 }, label: { color: [1, 0, 0, 1] } });
    const b = mergeStyle(a, { label: { size: 20 } });
    expect(b.edge).toEqual({ color: DEFAULT_STYLE.edge.color, width: 3 });
    expect(b.label).toEqual({ ...DEFAULT_STYLE.label, color: [1, 0, 0, 1], size: 20 });
    expect(b.background).toEqual(DEFAULT_STYLE.background);
  });

  it("selected and focused default to the hover look", () => {
    expect(DEFAULT_STYLE.hover).toEqual({ outline: { color: [1, 1, 1, 1], scale: 0.08, minWidth: 3, maxWidth: 12 }, edgeColor: [1, 1, 1, 1], edgeWidth: 2 });
    expect(DEFAULT_STYLE.selected).toEqual(DEFAULT_STYLE.hover);
    expect(DEFAULT_STYLE.focused).toEqual(DEFAULT_STYLE.hover);
    expect(DEFAULT_STYLE.dimmed).toEqual({ alpha: 0.25 });
  });

  it("mergeStyle merges looks field by field and turns hover off and on", () => {
    const a = mergeStyle(DEFAULT_STYLE, { selected: { outline: { color: [1, 0, 0, 1] } }, dimmed: { alpha: 2 } });
    expect(a.selected.outline).toEqual({ ...DEFAULT_STYLE.selected.outline, color: [1, 0, 0, 1] });
    expect(a.selected.edgeWidth).toBe(2);
    expect(a.dimmed.alpha).toBe(1);
    const off = mergeStyle(a, { hover: false });
    expect(off.hover).toBe(false);
    expect(mergeStyle(off, { label: { size: 14 } }).hover).toBe(false);
    const on = mergeStyle(off, { hover: { outline: { scale: 0.2 } } });
    expect(on.hover).toEqual({ ...DEFAULT_STYLE.hover, outline: { ...(DEFAULT_STYLE.hover as { outline: object }).outline, scale: 0.2 } });
  });

  it("mergeStyle clamps out-of-range values", () => {
    const s = mergeStyle(DEFAULT_STYLE, { edge: { width: -1 }, label: { size: 0, padding: -2 }, icon: { scale: 5, minPx: -1 } });
    expect(s.edge.width).toBe(0);
    expect(s.label.size).toBe(1);
    expect(s.label.padding).toBe(0);
    expect(s.icon).toEqual({ scale: 1, minPx: 0 });
  });
});
