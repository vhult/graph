import { describe, expect, it } from "vitest";
import { HoverGate } from "../src/engine/HoverGate";

describe("HoverGate", () => {
  it("opens when picking is on and the hover look or a hover listener wants it", () => {
    const g = new HoverGate();
    expect(g.open).toBe(false);
    expect(g.update(1, true, false)).toBe(1);
    expect(g.open).toBe(true);
    expect(g.update(1, true, false)).toBe(0);
  });

  it("closes when the hover look is turned off with no listener, and opens again when it comes back", () => {
    const g = new HoverGate();
    g.update(1, true, false);
    expect(g.update(1, false, false)).toBe(-1);
    expect(g.open).toBe(false);
    expect(g.update(1, true, false)).toBe(1);
  });

  it("stays open while a hover listener exists", () => {
    const g = new HoverGate();
    g.update(1, false, true);
    expect(g.open).toBe(true);
    expect(g.update(1, true, true)).toBe(0);
    expect(g.update(1, false, true)).toBe(0);
    expect(g.update(1, false, false)).toBe(-1);
  });

  it("stays closed while picking is off", () => {
    const g = new HoverGate();
    expect(g.update(0, true, true)).toBe(0);
    expect(g.open).toBe(false);
    g.update(2, true, false);
    expect(g.update(0, true, true)).toBe(-1);
  });
});
