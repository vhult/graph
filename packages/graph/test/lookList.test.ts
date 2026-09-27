import { describe, expect, it } from "vitest";
import { LookList } from "../src/data/LookList";

const BIT = 2;
const GONE = 128;

function flag(l: LookList, st: Uint32Array, i: number, next: number): void {
  l.update(i, st[i]!, next);
  st[i] = next;
}

describe("LookList", () => {
  it("grows past its first list and bit word, in insertion order", () => {
    const l = new LookList(BIT, GONE);
    const st = new Uint32Array(100);
    const order = Array.from({ length: 40 }, (_, k) => 99 - k * 2);
    for (const i of order) flag(l, st, i, BIT);
    expect(l.live).toBe(40);
    expect(Array.from(l.entries(st))).toEqual(order);
  });

  it("does not list an index twice when it goes off and on", () => {
    const l = new LookList(BIT, GONE);
    const st = new Uint32Array(8);
    flag(l, st, 3, BIT);
    flag(l, st, 5, BIT);
    flag(l, st, 3, 0);
    flag(l, st, 3, BIT);
    expect(l.count).toBe(2);
    expect(Array.from(l.entries(st))).toEqual([3, 5]);
  });

  it("does not count a removed index", () => {
    const l = new LookList(BIT, GONE);
    const st = new Uint32Array(4);
    flag(l, st, 1, BIT);
    flag(l, st, 1, BIT | GONE);
    expect(l.live).toBe(0);
    expect(Array.from(l.entries(st))).toEqual([]);
  });

  it("drops stale entries on compact only once they outnumber the live ones", () => {
    const l = new LookList(BIT, GONE);
    const st = new Uint32Array(8);
    for (const i of [0, 1, 2, 3]) flag(l, st, i, BIT);
    flag(l, st, 0, 0);
    flag(l, st, 1, 0);
    l.compact(st);
    expect(l.count).toBe(4);
    flag(l, st, 2, 0);
    l.compact(st);
    expect(l.count).toBe(1);
    expect(Array.from(l.entries(st))).toEqual([3]);
    flag(l, st, 0, BIT);
    expect(Array.from(l.entries(st))).toEqual([3, 0]);
  });

  it("resets when nothing is live and bumps the version on every change", () => {
    const l = new LookList(BIT, GONE);
    const st = new Uint32Array(4);
    const v0 = l.version;
    flag(l, st, 2, BIT);
    expect(l.version).toBeGreaterThan(v0);
    flag(l, st, 2, 0);
    const v1 = l.version;
    l.compact(st);
    expect(l.count).toBe(0);
    expect(l.version).toBeGreaterThan(v1);
  });
});
