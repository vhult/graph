import { describe, expect, it } from "vitest";
import { IndexUploads } from "../src/data/IndexUploads";

const listed = (u: IndexUploads): number[] => Array.from(u.list.subarray(0, u.count));

describe("IndexUploads", () => {
  it("lists each index once, in first-write order", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([9, 3]));
    expect(listed(u)).toEqual([9, 3]);
    expect(u.count).toBe(2);
  });

  it("keeps one entry when an index is written twice in one frame", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([5]));
    u.add(new Uint32Array([5]));
    expect(u.count).toBe(1);
  });

  it("grows past its first capacity", () => {
    const u = new IndexUploads();
    const idx = Uint32Array.from({ length: 150 }, (_, k) => 1000 - k);
    u.add(idx);
    expect(u.count).toBe(150);
    expect(listed(u)).toEqual(Array.from(idx));
  });

  it("reuses its bits across clear with no stale entry", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([3, 7, 40]));
    u.clear();
    u.add(new Uint32Array([7]));
    u.add(new Uint32Array([3]));
    u.add(new Uint32Array([7]));
    expect(listed(u)).toEqual([7, 3]);
    u.clear();
    u.add(new Uint32Array([500, 40]));
    expect(listed(u)).toEqual([500, 40]);
  });

  it("keeps indices that share a bit word apart", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([31, 32, 0, 63, 64]));
    u.add(new Uint32Array([32, 31, 1]));
    expect(listed(u)).toEqual([31, 32, 0, 63, 64, 1]);
  });

  it("still dedupes an index written before the bits grew", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([3]));
    u.add(new Uint32Array([100000, 3]));
    expect(listed(u)).toEqual([3, 100000]);
  });

  it("ignores an empty list", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array(0));
    expect(u.count).toBe(0);
    expect(u.capacity).toBe(0);
  });

  it("clears only the words it set, so a cleared index can be listed again", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([2, 33]));
    u.clear();
    u.add(new Uint32Array([33, 2, 33]));
    expect(listed(u)).toEqual([33, 2]);
  });

  it("clears", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([1]));
    u.clear();
    expect(u.count).toBe(0);
  });

  it("reset drops pending entries and releases bits past the slot count", () => {
    const u = new IndexUploads();
    u.add(new Uint32Array([5000]));
    u.reset(20000);
    expect(u.count).toBe(0);
    expect(u.capacity).toBeGreaterThan(5000);
    u.add(new Uint32Array([7]));
    u.reset(100);
    expect(u.count).toBe(0);
    expect(u.capacity).toBe(0);
    u.add(new Uint32Array([3, 9]));
    expect(listed(u)).toEqual([3, 9]);
  });
});
