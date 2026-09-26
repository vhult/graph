import { describe, expect, it } from "vitest";
import { NO_INDEX, Slots } from "../src/api/Slots";

describe("Slots", () => {
  it("reuses freed slots before appending", () => {
    const s = new Slots();
    s.reset(4);
    s.release([1, 2]);
    expect(s.count).toBe(2);
    const got = Array.from(s.take(3)).sort((a, b) => a - b);
    expect(got).toEqual([1, 2, 4]);
    expect(s.slots).toBe(5);
    expect(s.count).toBe(5);
  });

  it("appends only when reuse is off", () => {
    const s = new Slots();
    s.reset(2);
    s.release([0]);
    expect(Array.from(s.take(1, false))).toEqual([2]);
  });

  it("rejects dead and duplicate indices", () => {
    const s = new Slots();
    s.reset(3);
    s.release([1]);
    expect(() => s.check([1], "x")).toThrow(/not a live slot/);
    expect(() => s.check([2, 2], "x")).toThrow(/listed twice/);
    expect(() => s.check([0, 2], "x")).not.toThrow();
  });

  it("ignores releasing a slot twice", () => {
    const s = new Slots();
    s.reset(2);
    s.release([0]);
    s.release([0]);
    expect(s.count).toBe(1);
  });

  it("compacts to a remap table", () => {
    const s = new Slots();
    s.reset(4);
    s.release([0, 2]);
    expect(Array.from(s.compact())).toEqual([NO_INDEX, 0, NO_INDEX, 1]);
    expect(s.slots).toBe(2);
    expect(s.count).toBe(2);
  });
});
