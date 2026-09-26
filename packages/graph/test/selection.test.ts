import { describe, expect, it } from "vitest";
import { MOD } from "../src/bridge/InputRing";
import { Selection, shapeAdds } from "../src/engine/Selection";

describe("Selection", () => {
  it("click selects one, shift-click toggles, empty click clears", () => {
    const s = new Selection();
    s.click(3, false);
    expect(Array.from(s.nodes)).toEqual([3]);
    s.click(5, true);
    expect(Array.from(s.nodes).sort()).toEqual([3, 5]);
    s.click(3, true);
    expect(Array.from(s.nodes)).toEqual([5]);
    s.click(null, false);
    expect(s.nodes.length).toBe(0);
  });

  it("a shape replaces, a shift shape adds", () => {
    const s = new Selection();
    s.shape(new Uint32Array([1, 2]), false);
    s.shape(new Uint32Array([4]), true);
    expect(Array.from(s.nodes).sort()).toEqual([1, 2, 4]);
    s.shape(new Uint32Array([7]), false);
    expect(Array.from(s.nodes)).toEqual([7]);
  });

  it("gives the flag changes of the last step", () => {
    const s = new Selection();
    s.load(new Uint32Array([1, 2, 3]));
    expect(s.added.length + s.removed.length).toBe(0);
    s.shape(new Uint32Array([9, 3, 4]), false);
    expect(Array.from(s.added)).toEqual([4, 9]);
    expect(Array.from(s.removed)).toEqual([1, 2]);
    s.click(4, false);
    expect(Array.from(s.added)).toEqual([]);
    expect(Array.from(s.removed)).toEqual([3, 9]);
    s.click(null, true);
    expect(Array.from(s.nodes)).toEqual([4]);
    s.clear();
    expect(Array.from(s.removed)).toEqual([4]);
    expect(s.nodes.length).toBe(0);
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
