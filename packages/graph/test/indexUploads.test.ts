import { describe, expect, it } from "vitest";
import { IndexUploads } from "../src/data/IndexUploads";

describe("IndexUploads", () => {
  it("packs one pair and one value block per index", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([9, 3]), new Uint32Array([10, 11, 30, 31]), 2, 1024);
    expect(Array.from(u.pairs())).toEqual([9, 0, 3, 1]);
    expect(Array.from(u.values())).toEqual([10, 11, 30, 31]);
    expect(u.count).toBe(2);
  });

  it("keeps the last value when an index is written twice in one frame", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([5]), new Uint32Array([1]), 1, 1024);
    u.add(new Uint32Array([5]), new Uint32Array([2]), 1, 1024);
    expect(u.count).toBe(1);
    expect(Array.from(u.values())).toEqual([2]);
  });

  it("grows past its first capacity with two words per item", () => {
    const u = new IndexUploads();
    const n = 150;
    const idx = Uint32Array.from({ length: n }, (_, k) => 1000 - k);
    const words = Uint32Array.from({ length: n * 2 }, (_, k) => k + 7);
    u.add(idx, words, 2, 1024);
    expect(u.count).toBe(n);
    expect(Array.from(u.values())).toEqual(Array.from(words));
    expect(Array.from(u.pairs())).toEqual(Array.from({ length: n * 2 }, (_, k) => (k % 2 === 0 ? 1000 - k / 2 : (k - 1) / 2)));
  });

  it("reuses its slots across clear with no stale entry", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([3, 7, 40]), new Uint32Array([30, 70, 400]), 1, 1024);
    u.clear();
    u.add(new Uint32Array([7]), new Uint32Array([71]), 1, 1024);
    u.add(new Uint32Array([3]), new Uint32Array([31]), 1, 1024);
    u.add(new Uint32Array([7]), new Uint32Array([72]), 1, 1024);
    expect(u.count).toBe(2);
    expect(Array.from(u.pairs())).toEqual([7, 0, 3, 1]);
    expect(Array.from(u.values())).toEqual([72, 31]);
    u.clear();
    u.add(new Uint32Array([500, 40]), new Uint32Array([5, 4]), 1, 1024);
    expect(Array.from(u.pairs())).toEqual([500, 0, 40, 1]);
    expect(Array.from(u.values())).toEqual([5, 4]);
  });

  it("clears", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([1]), new Uint32Array([1]), 1, 1024);
    u.clear();
    expect(u.count).toBe(0);
  });

  it("grows its slot table geometrically, capped at the slot count", () => {
    const u = new IndexUploads();
    const sizes = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      u.add(new Uint32Array([i]), new Uint32Array([i]), 1, 1000);
      u.clear();
      sizes.add(u.slotCapacity);
    }
    expect(sizes.size).toBeLessThanOrEqual(11);
    expect(u.slotCapacity).toBe(1000);
    const v = new IndexUploads();
    v.add(new Uint32Array([10]), new Uint32Array([1]), 1, 1000);
    expect(v.slotCapacity).toBe(11);
    v.add(new Uint32Array([12]), new Uint32Array([1]), 1, 1000);
    expect(v.slotCapacity).toBe(22);
    v.add(new Uint32Array([800]), new Uint32Array([1]), 1, 1000);
    expect(v.slotCapacity).toBe(801);
    v.add(new Uint32Array([801]), new Uint32Array([1]), 1, 1000);
    expect(v.slotCapacity).toBe(1000);
  });

  it("reset drops pending entries and releases a slot table larger than the slot count", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([5000]), new Uint32Array([1]), 1, 10000);
    u.reset(20000);
    expect(u.count).toBe(0);
    expect(u.slotCapacity).toBe(5001);
    u.add(new Uint32Array([7]), new Uint32Array([1]), 1, 20000);
    u.reset(100);
    expect(u.count).toBe(0);
    expect(u.slotCapacity).toBe(0);
    u.add(new Uint32Array([3, 9]), new Uint32Array([30, 90]), 1, 100);
    expect(Array.from(u.pairs())).toEqual([3, 0, 9, 1]);
    expect(Array.from(u.values())).toEqual([30, 90]);
  });
});
