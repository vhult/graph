import { describe, expect, it } from "vitest";
import { DEFAULT_NODE_COLOR, GraphStore } from "../src/data/GraphStore";
import { CONSTANTS, DEFAULT_NODE_STYLE } from "../src/data/Layouts";

describe("GraphStore", () => {
  it("bulk set flags node channels for reallocation and computes bounds", () => {
    const s = new GraphStore();
    s.setNodes(3, { positions: new Float32Array([0, 0, 10, -5, -2, 7]) });
    expect(s.channels.nodePos.realloc).toBe(true);
    expect(s.channels.nodeColor.data[2]).toBe(DEFAULT_NODE_COLOR);
    expect(s.bounds).toEqual({ minX: -2, minY: -5, maxX: 10, maxY: 7 });
  });

  it("partial position updates produce dirty ranges, not reallocations", () => {
    const s = new GraphStore();
    s.setNodes(100, {});
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.markClean();
    s.updatePositions(10, new Float32Array(10));
    expect(s.dirty).toBe(true);
    expect(s.channels.nodePos.realloc).toBe(false);
    expect(s.channels.nodePos.dirty.start(0)).toBe(10);
    expect(s.channels.nodePos.dirty.end(0)).toBe(15);
  });

  it("rejects updates past the node count", () => {
    const s = new GraphStore();
    s.setNodes(4, {});
    expect(() => s.updatePositions(3, new Float32Array(4))).toThrow(RangeError);
    expect(() => s.updateColors(3, new Uint32Array(2))).toThrow(RangeError);
  });

  it("colour updates write the mirror and produce a dirty range", () => {
    const s = new GraphStore();
    s.setNodes(10, {});
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.markClean();
    s.updateColors(4, new Uint32Array([7, 8]));
    expect(s.dirty).toBe(true);
    expect(s.channels.nodeColor.realloc).toBe(false);
    expect(Array.from(s.channels.nodeColor.data.slice(4, 6))).toEqual([7, 8]);
    expect(s.channels.nodeColor.dirty.start(0)).toBe(4);
    expect(s.channels.nodeColor.dirty.end(0)).toBe(6);
  });

  it("shapes go in the low byte of the node style and flag the store", () => {
    const s = new GraphStore();
    s.setNodes(3, {});
    expect(s.hasNodeShapes).toBe(false);
    expect(s.channels.nodeStyle.data[1]).toBe(DEFAULT_NODE_STYLE);
    s.setNodes(3, { shapes: new Uint8Array([0, 1, 2]) });
    expect(s.hasNodeShapes).toBe(true);
    expect(s.channels.nodeStyle.realloc).toBe(true);
    expect(Array.from(s.channels.nodeStyle.data, (w) => w & CONSTANTS.STYLE_SHAPE_MASK)).toEqual([0, 1, 2]);
    expect(s.channels.nodeStyle.data[2]! & ~CONSTANTS.STYLE_SHAPE_MASK).toBe(DEFAULT_NODE_STYLE);
    s.setNodes(3, { shapes: new Uint8Array(3) });
    expect(s.hasNodeShapes).toBe(false);
  });

  it("z-index goes in the layer bits of the node style, keeps the shape and flags the store", () => {
    const s = new GraphStore();
    const layer = (w: number) => (w >>> CONSTANTS.STYLE_ZLAYER_SHIFT) & CONSTANTS.STYLE_ZLAYER_MASK;
    s.setNodes(3, { shapes: new Uint8Array([1, 2, 0]) });
    expect(s.hasZLayers).toBe(false);
    s.setNodes(3, { zIndex: new Uint8Array([0, 5, 40]) });
    expect(s.hasZLayers).toBe(true);
    expect(Array.from(s.channels.nodeStyle.data, layer)).toEqual([0, 5, 15]);
    expect(Array.from(s.channels.nodeStyle.data, (w) => w & CONSTANTS.STYLE_SHAPE_MASK)).toEqual([1, 2, 0]);
    s.setNodes(3, { shapes: new Uint8Array([2, 2, 2]) });
    expect(Array.from(s.channels.nodeStyle.data, layer)).toEqual([0, 5, 15]);
    s.setNodes(3, { zIndex: new Uint8Array(3) });
    expect(s.hasZLayers).toBe(false);
  });

  it("drawn bounds grow the node centres by the largest radius", () => {
    const s = new GraphStore();
    s.setNodes(3, { positions: new Float32Array([-40, 0, 0, 0, 40, 0]), sizes: new Float32Array([20, 10, 20]) });
    expect(s.maxNodeSize).toBe(20);
    expect(s.drawnBounds(1)).toEqual({ minX: -50, minY: -10, maxX: 50, maxY: 10 });
    expect(s.drawnBounds(2)).toEqual({ minX: -60, minY: -20, maxX: 60, maxY: 20 });
  });

  it("new nodes without sizes count at the default size", () => {
    const s = new GraphStore();
    s.setNodes(2, { sizes: new Float32Array([1, 2]) });
    expect(s.maxNodeSize).toBe(2);
    s.setNodes(3, {});
    expect(s.maxNodeSize).toBe(4);
  });
});
