import { describe, expect, it } from "vitest";
import { Flag } from "../src/api/types";
import { CONSTANTS, FRAME, defineStruct } from "../src/data/Layouts";
import { emitLayoutsWgsl } from "../src/data/LayoutsWgsl";
import { edgeStateBits } from "../src/data/Pack";
import onDisk from "../src/shaders/common/layouts.wgsl?raw";

describe("Layouts", () => {
  it("Frame matches the byte layout", () => {
    expect(FRAME.size).toBe(120);
    expect(FRAME.align).toBe(8);
    expect(FRAME.offset.originHi).toBe(0);
    expect(FRAME.offset.zoom).toBe(52);
    expect(FRAME.offset.pointerPx).toBe(64);
    expect(FRAME.offset.rasterDim).toBe(72);
    expect(FRAME.offset.flags).toBe(96);
    expect(FRAME.offset.globalEdgeColor).toBe(100);
    expect(FRAME.offset.iconScale).toBe(104);
    expect(FRAME.offset.iconMinPx).toBe(108);
  });

  it("applies WGSL alignment rules", () => {
    const s = defineStruct("S", [
      { name: "a", type: "f32" },
      { name: "b", type: "vec4<f32>" },
      { name: "c", type: "f32" },
    ] as const);
    expect(s.offset.b).toBe(16);
    expect(s.offset.c).toBe(32);
    expect(s.size).toBe(48);
  });

  it("focused is a foreground state bit", () => {
    expect(CONSTANTS.STATE_FOCUSED).toBe(64);
    expect(CONSTANTS.STATE_FOREGROUND_MASK & CONSTANTS.STATE_FOCUSED).toBe(CONSTANTS.STATE_FOCUSED);
  });

  it("Flag values are the engine state bits", () => {
    expect(Flag.selected).toBe(CONSTANTS.STATE_SELECTED);
    expect(Flag.dimmed).toBe(CONSTANTS.STATE_DIMMED);
    expect(Flag.hidden).toBe(CONSTANTS.STATE_HIDDEN);
    expect(Flag.focused).toBe(CONSTANTS.STATE_FOCUSED);
  });

  it("Flag values map to the edge state bits above the edge end", () => {
    expect(edgeStateBits(Flag.hidden)).toBe(CONSTANTS.EDGE_STATE_HIDDEN);
    expect(edgeStateBits(Flag.selected)).toBe(CONSTANTS.EDGE_STATE_SELECTED);
    expect(edgeStateBits(Flag.dimmed)).toBe(CONSTANTS.EDGE_STATE_DIMMED);
    expect(edgeStateBits(Flag.focused)).toBe(CONSTANTS.EDGE_STATE_FOCUSED);
    expect(edgeStateBits(Flag.hidden | Flag.focused)).toBe(CONSTANTS.EDGE_STATE_HIDDEN | CONSTANTS.EDGE_STATE_FOCUSED);
    const all = CONSTANTS.EDGE_STATE_HIDDEN | CONSTANTS.EDGE_STATE_SELECTED | CONSTANTS.EDGE_STATE_DIMMED | CONSTANTS.EDGE_STATE_FOCUSED;
    expect(((all << CONSTANTS.EDGE_STATE_SHIFT) >>> 0) & CONSTANTS.EDGE_END_MASK).toBe(0);
    expect(CONSTANTS.EDGE_END_MASK + 1).toBe(2 ** CONSTANTS.EDGE_STATE_SHIFT);
    expect((((all << CONSTANTS.EDGE_STATE_SHIFT) | CONSTANTS.EDGE_END_MASK) >>> 0)).toBe(0xffffffff);
  });

  it("checked-in layouts.wgsl is up to date (run `npm run gen`)", () => {
    expect(onDisk).toBe(emitLayoutsWgsl());
  });
});
