import { describe, expect, it } from "vitest";
import { LiveLabels } from "../src/labels/LiveLabels";

const shownOf = (...pairs: [number, number][]) => new Uint32Array(pairs.flat());
const build = () => 7;

describe("LiveLabels", () => {
  it("adds shown labels, fading in, and marks their nodes", () => {
    const live = new LiveLabels(4, 0.2);
    live.update(shownOf([3, 30], [40, 400]), 2, 1, build);
    expect(live.entries.map((e) => e.index).sort((a, b) => a - b)).toEqual([3, 40]);
    expect(live.alpha(live.entries[0]!, 1)).toBe(0);
    expect(live.alpha(live.entries[0]!, 1.2)).toBeCloseTo(1);
  });

  it("fades out a label no longer shown from its current alpha, then frees it", () => {
    const live = new LiveLabels(4, 0.2);
    live.update(shownOf([1, 1]), 1, 0, build);
    live.update(shownOf(), 0, 0.1, build);
    const e = live.entries[0]!;
    expect(e.fadeOut).toBe(true);
    expect(live.alpha(e, 0.1)).toBeCloseTo(0.5);
    expect(live.settle(0.15)).toBe(false);
    expect(live.settle(0.2)).toBe(true);
    expect(live.entries).toHaveLength(0);
  });

  it("turns a fading-out label back without a jump", () => {
    const live = new LiveLabels(4, 0.2);
    live.update(shownOf([1, 1]), 1, 0, build);
    live.update(shownOf(), 0, 0.2, build);
    live.update(shownOf([1, 1]), 1, 0.25, build);
    const e = live.entries[0]!;
    expect(e.fadeOut).toBe(false);
    expect(live.alpha(e, 0.25)).toBeCloseTo(0.75);
  });

  it("reuses the slot of the faintest fading label when full", () => {
    const live = new LiveLabels(1, 0.2);
    live.update(shownOf([1, 1]), 1, 0, build);
    live.update(shownOf([2, 2]), 1, 1, build);
    expect(live.entries.map((e) => e.index)).toEqual([2]);
  });

  it("skips a label whose text is empty", () => {
    const live = new LiveLabels(2, 0.2);
    live.update(shownOf([1, 1]), 1, 0, () => 0);
    expect(live.entries).toHaveLength(0);
  });

  it("clears edge labels alone", () => {
    const live = new LiveLabels(4, 0.2);
    live.update(shownOf([2, 2], [(0x80000000 | 5) >>> 0, 5]), 2, 0, build);
    live.clearEdges();
    expect(live.entries.map((e) => e.index)).toEqual([2]);
  });
});
