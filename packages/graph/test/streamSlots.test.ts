import { describe, expect, it } from "vitest";
import { StreamSlots } from "../src/bridge/StreamSlots";

describe("StreamSlots", () => {
  it("hands the reader the latest committed frame and never the one being written", () => {
    const writer = StreamSlots.create(2, true, false);
    const reader = new StreamSlots(writer.buffer, 2, true, false);
    expect(reader.take()).toBeNull();

    writer.data.positions.set([1, 1, 1, 1]);
    writer.commit();
    writer.data.positions.set([2, 2, 2, 2]);
    writer.commit();
    const a = reader.take()!;
    expect(Array.from(a.positions)).toEqual([2, 2, 2, 2]);
    expect(reader.take()).toBeNull();

    writer.data.positions.set([3, 3, 3, 3]);
    expect(writer.data.positions).not.toBe(a.positions);
    writer.commit();
    expect(reader.pending).toBe(true);
    expect(Array.from(reader.take()!.positions)).toEqual([3, 3, 3, 3]);
  });

  it("keeps the three slots distinct across many swaps", () => {
    const writer = StreamSlots.create(1, true, false);
    const reader = new StreamSlots(writer.buffer, 1, true, false);
    let held: Float32Array | null = null;
    for (let f = 0; f < 20; f++) {
      expect(writer.data.positions).not.toBe(held);
      writer.data.positions.set([f, f]);
      writer.commit();
      if (f % 3 !== 0) {
        held = reader.take()!.positions;
        expect(held[0]).toBe(f);
      }
    }
  });

  it("carries positions and colours of one frame together, without overlap", () => {
    const writer = StreamSlots.create(3, true, true);
    const reader = new StreamSlots(writer.buffer, 3, true, true);
    writer.data.positions.set([1, 2, 3, 4, 5, 6]);
    writer.data.colors.set([0xff0000ff, 0xff00ff00, 0xffff0000]);
    writer.commit();
    const slot = reader.take()!;
    expect(Array.from(slot.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(slot.colors)).toEqual([0xff0000ff, 0xff00ff00, 0xffff0000]);
  });

  it("gives an empty array for a channel that is not streamed", () => {
    const writer = StreamSlots.create(4, false, true);
    expect(writer.data.positions.length).toBe(0);
    expect(writer.data.colors.length).toBe(4);
    expect(writer.buffer.byteLength).toBe(16 + 3 * 4 * 4);
  });
});
