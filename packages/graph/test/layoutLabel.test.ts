import { describe, expect, it } from "vitest";
import { LABEL_CONSTANTS } from "../src/data/Layouts";
import { createRun, ELLIPSIS, layoutLabel } from "../src/labels/layoutLabel";

const ten = () => 10;

describe("layoutLabel", () => {
  it("lays out glyphs at whole pixel pens and adds the inset on both sides", () => {
    const run = createRun();
    expect(layoutLabel("abc", ten, 1000, 3, run)).toBe(36);
    expect(run.count).toBe(3);
    expect(Array.from(run.pens.subarray(0, 3))).toEqual([0, 10, 20]);
    expect(Array.from(run.codes.subarray(0, 3))).toEqual([97, 98, 99]);
  });

  it("gives width 0 to an empty string", () => {
    const run = createRun();
    expect(layoutLabel("", ten, 1000, 3, run)).toBe(0);
    expect(run.count).toBe(0);
  });

  it("cuts at the maximum width and ends with an ellipsis that fits", () => {
    const run = createRun();
    const width = layoutLabel("abcdefghij", ten, 56, 3, run);
    expect(run.count).toBe(5);
    expect(run.codes[4]).toBe(ELLIPSIS);
    expect(width).toBeLessThanOrEqual(56);
    expect(width).toBe(56);
  });

  it("never uses more glyph slots than a label holds", () => {
    const run = createRun();
    layoutLabel("x".repeat(100), () => 1, 10_000, 0, run);
    expect(run.count).toBe(LABEL_CONSTANTS.LABEL_GLYPHS);
    expect(run.codes[LABEL_CONSTANTS.LABEL_GLYPHS - 1]).toBe(ELLIPSIS);
  });

  it("reads a surrogate pair as one code point", () => {
    const run = createRun();
    layoutLabel("a😀b", ten, 1000, 0, run);
    expect(run.count).toBe(3);
    expect(run.codes[1]).toBe(0x1f600);
  });

  it("rounds pens of fractional advances but keeps the exact total", () => {
    const run = createRun();
    expect(layoutLabel("aaa", () => 2.4, 1000, 0, run)).toBe(8);
    expect(Array.from(run.pens.subarray(0, 3))).toEqual([0, 2, 5]);
  });
});
