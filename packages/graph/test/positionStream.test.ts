import { describe, expect, it } from "vitest";
import { PositionStream } from "../src/bridge/PositionStream";

describe("PositionStream", () => {
  it("hands the reader the latest committed frame and never the one being written", () => {
    const writer = PositionStream.create(2);
    const reader = new PositionStream(writer.buffer, 2);
    expect(reader.take()).toBeNull();

    writer.positions.set([1, 1, 1, 1]);
    writer.commit();
    writer.positions.set([2, 2, 2, 2]);
    writer.commit();
    const a = reader.take()!;
    expect(Array.from(a)).toEqual([2, 2, 2, 2]);
    expect(reader.take()).toBeNull();

    writer.positions.set([3, 3, 3, 3]);
    expect(writer.positions).not.toBe(a);
    writer.commit();
    expect(reader.pending).toBe(true);
    expect(Array.from(reader.take()!)).toEqual([3, 3, 3, 3]);
  });

  it("keeps the three slots distinct across many swaps", () => {
    const writer = PositionStream.create(1);
    const reader = new PositionStream(writer.buffer, 1);
    let held: Float32Array | null = null;
    for (let f = 0; f < 20; f++) {
      expect(writer.positions).not.toBe(held);
      writer.positions.set([f, f]);
      writer.commit();
      if (f % 3 !== 0) {
        held = reader.take();
        expect(held![0]).toBe(f);
      }
    }
  });
});
