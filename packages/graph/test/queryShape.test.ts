import { describe, expect, it } from "vitest";
import { packShape } from "../src/data/QueryShape";

describe("packShape", () => {
  it("turns a rect into four device-px points", () => {
    expect(Array.from(packShape({ x: 1, y: 2, width: 3, height: 4 }, 2))).toEqual([2, 4, 8, 4, 8, 12, 2, 12]);
  });
  it("rejects fewer than 3 points", () => {
    expect(() => packShape({ points: [0, 0, 1, 1] }, 1)).toThrow();
  });
  it("scales polygon points to device px", () => {
    expect(Array.from(packShape({ points: [0, 0, 10, 0, 0, 5] }, 2))).toEqual([0, 0, 20, 0, 0, 10]);
  });
  it("rejects more than 1,024 points, an odd length and non-finite values", () => {
    expect(() => packShape({ points: new Array<number>(2050).fill(1) }, 1)).toThrow(/1024/);
    expect(() => packShape({ points: [0, 0, 1, 1, 2] }, 1)).toThrow();
    expect(() => packShape({ points: [0, 0, 1, NaN, 2, 2] }, 1)).toThrow();
    expect(() => packShape({ x: 0, y: 0, width: -1, height: 2 }, 1)).toThrow();
  });
});
