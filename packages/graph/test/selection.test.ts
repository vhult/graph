import { describe, expect, it } from "vitest";
import { MOD } from "../src/bridge/InputRing";
import { GraphStore } from "../src/data/GraphStore";
import { selectClick, selectedNodes, selectShape, shapeAdds } from "../src/engine/Interaction";

function store(): GraphStore {
  const s = new GraphStore();
  s.setNodes(10, {});
  return s;
}

const sel = (s: GraphStore) => Array.from(selectedNodes(s));

describe("Selection", () => {
  it("click selects one, shift-click toggles, empty click clears", () => {
    const s = store();
    selectClick(s, 3, false);
    expect(sel(s)).toEqual([3]);
    selectClick(s, 5, true);
    expect(sel(s).sort()).toEqual([3, 5]);
    selectClick(s, 3, true);
    expect(sel(s)).toEqual([5]);
    selectClick(s, -1, false);
    expect(sel(s).length).toBe(0);
  });

  it("a shape replaces, a shift shape adds", () => {
    const s = store();
    selectShape(s, new Uint32Array([1, 2]), false);
    selectShape(s, new Uint32Array([4]), true);
    expect(sel(s).sort()).toEqual([1, 2, 4]);
    selectShape(s, new Uint32Array([7]), false);
    expect(sel(s)).toEqual([7]);
  });

  it("says whether a step changed the selection", () => {
    const s = store();
    expect(selectShape(s, new Uint32Array([1, 2, 3]), false)).toBe(true);
    expect(selectShape(s, new Uint32Array([9, 3, 4]), false)).toBe(true);
    expect(sel(s)).toEqual([9, 3, 4]);
    expect(selectClick(s, 4, false)).toBe(true);
    expect(selectClick(s, 4, false)).toBe(false);
    expect(selectClick(s, -1, true)).toBe(false);
    expect(sel(s)).toEqual([4]);
    expect(selectClick(s, -1, false)).toBe(true);
    expect(selectClick(s, -1, false)).toBe(false);
    expect(sel(s).length).toBe(0);
  });

  it("lists the selection in first-selection order, and a node toggled off and on keeps its place", () => {
    const s = store();
    selectShape(s, new Uint32Array([7, 2]), false);
    selectClick(s, 5, true);
    selectClick(s, 0, true);
    expect(sel(s)).toEqual([7, 2, 5, 0]);
    selectClick(s, 2, true);
    expect(sel(s)).toEqual([7, 5, 0]);
    selectClick(s, 2, true);
    expect(sel(s)).toEqual([7, 2, 5, 0]);
  });

  it("with selectKey shift, a plain shape replaces and ctrl or meta adds", () => {
    expect(shapeAdds(MOD.SHIFT, "shift")).toBe(false);
    expect(shapeAdds(MOD.SHIFT | MOD.CTRL, "shift")).toBe(true);
    expect(shapeAdds(MOD.SHIFT | MOD.META, "shift")).toBe(true);
    expect(shapeAdds(MOD.SHIFT | MOD.ALT, "shift")).toBe(false);
  });

  it("with another selectKey or null, shift adds", () => {
    expect(shapeAdds(MOD.ALT, "alt")).toBe(false);
    expect(shapeAdds(MOD.ALT | MOD.SHIFT, "alt")).toBe(true);
    expect(shapeAdds(MOD.CTRL | MOD.SHIFT, "ctrl")).toBe(true);
    expect(shapeAdds(MOD.META, "meta")).toBe(false);
    expect(shapeAdds(0, null)).toBe(false);
    expect(shapeAdds(MOD.SHIFT, null)).toBe(true);
    expect(shapeAdds(MOD.CTRL, null)).toBe(false);
  });
});
