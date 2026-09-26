import { describe, expect, it } from "vitest";
import { GraphError } from "../src/api/errors";
import { DEFAULT_NODE_COLOR, GraphStore } from "../src/data/GraphStore";
import { Flag } from "../src/api/types";
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

  it("streamed z-index syncs into the layer bits and keeps the shape", () => {
    const s = new GraphStore();
    s.setNodes(3, { shapes: new Uint8Array([1, 2, 0]) });
    s.syncZIndex(new Uint8Array([3, 0, 99]));
    const words = s.channels.nodeStyle.data;
    expect(s.hasZLayers).toBe(true);
    expect(Array.from(words, (w) => (w >>> CONSTANTS.STYLE_ZLAYER_SHIFT) & CONSTANTS.STYLE_ZLAYER_MASK)).toEqual([3, 0, 15]);
    expect(Array.from(words, (w) => w & CONSTANTS.STYLE_SHAPE_MASK)).toEqual([1, 2, 0]);
    s.syncZIndex(new Uint8Array(3));
    expect(s.hasZLayers).toBe(false);
  });

  it("updateNodes writes only its range of the style and size words", () => {
    const s = new GraphStore();
    const { STYLE_ICON_SHIFT, STYLE_ICON_MASK, STYLE_SHAPE_MASK, SIZE_ICON_COLOR_SHIFT } = CONSTANTS;
    s.setNodes(10, { shapes: new Uint8Array(10).fill(1), sizes: new Float32Array(10).fill(2) });
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.markClean();
    s.updateNodes(3, { icons: new Uint16Array([4, 5]), iconColors: new Uint32Array([0xff0000ff, 0xffffffff]) });
    const style = s.channels.nodeStyle;
    const size = s.channels.nodeSize;
    expect(s.hasIcons).toBe(true);
    expect(style.realloc).toBe(false);
    expect([style.dirty.start(0), style.dirty.end(0)]).toEqual([3, 5]);
    expect([size.dirty.start(0), size.dirty.end(0)]).toEqual([3, 5]);
    expect(Array.from(style.data.slice(2, 6), (w) => (w >>> STYLE_ICON_SHIFT) & STYLE_ICON_MASK)).toEqual([CONSTANTS.NO_ICON, 4, 5, CONSTANTS.NO_ICON]);
    expect(Array.from(style.data.slice(2, 6), (w) => w & STYLE_SHAPE_MASK)).toEqual([1, 1, 1, 1]);
    expect(Array.from(size.data.slice(2, 6), (w) => w >>> SIZE_ICON_COLOR_SHIFT)).toEqual([0, 1, 0, 0]);
    expect(Array.from(size.data.slice(2, 6), (w) => w & 0xffff)).toEqual([0x4000, 0x4000, 0x4000, 0x4000]);
  });

  it("clearIcons sets the nodes using the given icons to no icon over one dirty range", () => {
    const s = new GraphStore();
    const { STYLE_ICON_SHIFT, STYLE_ICON_MASK, STYLE_SHAPE_MASK, NO_ICON } = CONSTANTS;
    s.setNodes(8, { shapes: new Uint8Array(8).fill(2), icons: new Uint16Array([0, 1, 2, 1, 0, 3, NO_ICON, 2]) });
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.markClean();
    expect(s.clearIcons(new Uint16Array([1, 3]))).toBe(true);
    const style = s.channels.nodeStyle;
    expect(Array.from(style.data, (w) => (w >>> STYLE_ICON_SHIFT) & STYLE_ICON_MASK)).toEqual([0, NO_ICON, 2, NO_ICON, 0, NO_ICON, NO_ICON, 2]);
    expect(Array.from(style.data, (w) => w & STYLE_SHAPE_MASK)).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    expect([style.dirty.start(0), style.dirty.end(0)]).toEqual([1, 6]);
    expect(s.dirty).toBe(true);
    s.markClean();
    expect(s.clearIcons(new Uint16Array([9]))).toBe(false);
    expect(s.dirty).toBe(false);
  });

  it("updateNodes appends new icon colours to the palette and keeps old indices", () => {
    const s = new GraphStore();
    s.setNodes(2, { iconColors: new Uint32Array([0xff0000ff, 0xff00ff00]) });
    const version = s.paletteVersion;
    s.updateNodes(0, { iconColors: new Uint32Array([0xffff0000]) });
    expect(Array.from(s.iconPalette)).toEqual([0xffffffff, 0xff0000ff, 0xff00ff00, 0xffff0000]);
    expect(Array.from(s.channels.nodeSize.data, (w) => w >>> CONSTANTS.SIZE_ICON_COLOR_SHIFT)).toEqual([3, 2]);
    expect(s.paletteVersion).toBe(version + 1);
  });

  it("updateNodes sizes and positions go through dirty ranges and grow the largest size", () => {
    const s = new GraphStore();
    s.setNodes(4, { sizes: new Float32Array(4).fill(1) });
    s.updateNodes(1, { sizes: new Float32Array([8]), positions: new Float32Array([5, 6]) });
    expect(s.maxNodeSize).toBe(8);
    expect(Array.from(s.channels.nodePos.data.slice(2, 4))).toEqual([5, 6]);
    expect(() => s.updateNodes(3, { sizes: new Float32Array(2) })).toThrow(RangeError);
  });

  it("updates scattered nodes by index", () => {
    const s = new GraphStore();
    s.setNodes(4, {});
    s.updateNodesAt(new Uint32Array([3, 1]), { positions: new Float32Array([7, 8, 5, 6]) });
    const pos = s.channels.nodePos.data as Float32Array;
    expect(Array.from(pos.subarray(2, 4))).toEqual([5, 6]);
    expect(Array.from(pos.subarray(6, 8))).toEqual([7, 8]);
  });

  it("sets and clears state bits by index and for all", () => {
    const s = new GraphStore();
    s.setNodes(3, {});
    s.flagNodes(new Uint32Array([0, 2]), 8 | 4, true);
    s.flagNodes(new Uint32Array([2]), 4, false);
    const st = s.channels.nodeState.data as Uint32Array;
    expect(Array.from(st)).toEqual([12, 0, 8]);
    s.flagNodes(null, 2, true);
    expect(Array.from(st)).toEqual([14, 2, 10]);
  });

  it("counts nodes flagged hidden exactly", () => {
    const s = new GraphStore();
    s.setNodes(4, {});
    const H = CONSTANTS.STATE_HIDDEN;
    s.flagNodes(new Uint32Array([1, 3]), H, true);
    expect(s.hiddenCount).toBe(2);
    s.flagNodes(new Uint32Array([3]), H | CONSTANTS.STATE_DIMMED, true);
    expect(s.hiddenCount).toBe(2);
    s.flagNodes(new Uint32Array([1]), H, false);
    expect(s.hiddenCount).toBe(1);
    s.flagNodes(new Uint32Array([0]), CONSTANTS.STATE_SELECTED, true);
    expect(s.hiddenCount).toBe(1);
    s.flagNodes(null, H, false);
    expect(s.hiddenCount).toBe(0);
    s.flagNodes(null, H, true);
    expect(s.hiddenCount).toBe(4);
    s.flagNodes(null, CONSTANTS.STATE_DIMMED, true);
    expect(s.hiddenCount).toBe(4);
    s.setNodes(4, {});
    expect(s.hiddenCount).toBe(0);
    expect(Array.from(s.channels.nodeState.data)).toEqual([0, 0, 0, 0]);
  });

  it("counts nodes flagged dimmed exactly", () => {
    const s = new GraphStore();
    s.setNodes(4, {}, 1);
    const D = CONSTANTS.STATE_DIMMED;
    s.flagNodes(new Uint32Array([1, 3]), D, true);
    expect(s.dimmedCount).toBe(2);
    s.flagNodes(new Uint32Array([3]), D | CONSTANTS.STATE_SELECTED, true);
    expect(s.dimmedCount).toBe(2);
    s.removeNodes(new Uint32Array([1]));
    expect(s.dimmedCount).toBe(1);
    s.flagNodes(null, D, true);
    expect(s.dimmedCount).toBe(3);
    s.flagNodes(new Uint32Array([0]), D, false);
    expect(s.dimmedCount).toBe(2);
    s.setNodes(4, {});
    expect(s.dimmedCount).toBe(0);
  });

  it("lists the nodes carrying a state bit", () => {
    const s = new GraphStore();
    s.setNodes(5, {});
    s.flagNodes(new Uint32Array([4, 1]), CONSTANTS.STATE_SELECTED, true);
    s.flagNodes(new Uint32Array([2]), CONSTANTS.STATE_FOCUSED, true);
    const out = new Uint32Array(8);
    expect(s.listNodes(CONSTANTS.STATE_SELECTED, out, 0)).toBe(2);
    expect(s.listNodes(CONSTANTS.STATE_FOCUSED, out, 2)).toBe(1);
    expect(Array.from(out.subarray(0, 3))).toEqual([1, 4, 2]);
    s.removeNodes(new Uint32Array([4]));
    expect(s.listNodes(CONSTANTS.STATE_SELECTED, out, 0)).toBe(1);
  });

  it("setNodes keeps a hidden reserve past the slots that bounds and the hidden count skip", () => {
    const s = new GraphStore();
    const H = CONSTANTS.STATE_HIDDEN;
    s.setNodes(2, { positions: new Float32Array([1, 2, 3, 4]), colors: new Uint32Array([7, 8]) }, 2);
    expect(s.nodeCount).toBe(4);
    expect(s.nodeSlots).toBe(2);
    expect(Array.from(s.channels.nodePos.data)).toEqual([1, 2, 3, 4, 0, 0, 0, 0]);
    expect(Array.from(s.channels.nodeColor.data)).toEqual([7, 8, DEFAULT_NODE_COLOR, DEFAULT_NODE_COLOR]);
    expect(s.channels.nodeStyle.data.length).toBe(4);
    const st = s.channels.nodeState.data as Uint32Array;
    expect([st[0]! & H, st[1]! & H, st[2]! & H, st[3]! & H]).toEqual([0, 0, H, H]);
    expect(s.hiddenCount).toBe(0);
    expect(s.bounds).toEqual({ minX: 1, minY: 2, maxX: 3, maxY: 4 });
  });

  it("removeNodes hides the nodes and returns the live edges that touch them", () => {
    const s = new GraphStore();
    const H = CONSTANTS.STATE_HIDDEN;
    s.setNodes(4, {}, 1);
    s.setEdges(4, { indices: new Uint32Array([0, 1, 1, 2, 2, 3, 3, 1]) });
    s.hideEdges(new Uint32Array([3]));
    s.flagNodes(new Uint32Array([1]), H, true);
    expect(s.hiddenCount).toBe(1);
    expect(Array.from(s.removeNodes(new Uint32Array([1])))).toEqual([0, 1]);
    expect(s.hiddenCount).toBe(0);
    expect((s.channels.nodeState.data as Uint32Array)[1]! & H).toBe(H);
    expect(s.channels.nodeState.scattered.count).toBe(1);
    expect(Array.from(s.removeNodes(new Uint32Array([2])))).toEqual([1, 2]);
    expect(Array.from(s.removeNodes(new Uint32Array([0])))).toEqual([0]);
  });

  it("flagNodes on all leaves removed and reserve nodes hidden", () => {
    const s = new GraphStore();
    const H = CONSTANTS.STATE_HIDDEN;
    s.setNodes(3, {}, 1);
    s.removeNodes(new Uint32Array([1]));
    s.flagNodes(null, H, true);
    expect(s.hiddenCount).toBe(2);
    s.flagNodes(null, H | CONSTANTS.STATE_SELECTED, false);
    expect(s.hiddenCount).toBe(0);
    const st = s.channels.nodeState.data as Uint32Array;
    expect([st[0]! & H, st[1]! & H, st[2]! & H, st[3]! & H]).toEqual([0, H, 0, H]);
  });

  it("addNodes shows the nodes and writes defaults for missing channels", () => {
    const s = new GraphStore();
    s.setNodes(2, { colors: new Uint32Array([7, 8]), positions: new Float32Array([1, 1, 2, 2]) }, 2);
    s.removeNodes(new Uint32Array([0]));
    s.addNodes(new Uint32Array([0, 2]), 3, { positions: new Float32Array([5, 6, -3, 9]) });
    expect(s.nodeSlots).toBe(3);
    expect(s.nodeCount).toBe(4);
    const st = s.channels.nodeState.data as Uint32Array;
    expect([st[0], st[1], st[2]]).toEqual([0, 0, 0]);
    expect(st[3]! & CONSTANTS.STATE_HIDDEN).toBe(CONSTANTS.STATE_HIDDEN);
    expect(Array.from(s.channels.nodeColor.data.slice(0, 3))).toEqual([DEFAULT_NODE_COLOR, 8, DEFAULT_NODE_COLOR]);
    expect(Array.from(s.channels.nodePos.data.slice(0, 6))).toEqual([5, 6, 2, 2, -3, 9]);
    expect(s.bounds).toEqual({ minX: -3, minY: 1, maxX: 5, maxY: 9 });
    expect(() => s.addNodes(new Uint32Array([4]), 5, {})).toThrow(RangeError);
  });

  it("growNodes adds hidden default slots and keeps the data", () => {
    const s = new GraphStore();
    s.setNodes(2, { colors: new Uint32Array([7, 8]) }, 1);
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.growNodes(6);
    expect(s.nodeCount).toBe(6);
    expect(s.nodeSlots).toBe(2);
    expect(s.channels.nodePos.realloc).toBe(true);
    expect(Array.from(s.channels.nodeColor.data)).toEqual([7, 8, DEFAULT_NODE_COLOR, DEFAULT_NODE_COLOR, DEFAULT_NODE_COLOR, DEFAULT_NODE_COLOR]);
    const st = s.channels.nodeState.data as Uint32Array;
    expect(Array.from(st, (w) => w & CONSTANTS.STATE_HIDDEN)).toEqual([0, 0, 8, 8, 8, 8]);
  });

  it("compactNodes packs the node mirrors, keeps a reserve and remaps edge ends", () => {
    const s = new GraphStore();
    s.setNodes(3, { positions: new Float32Array([1, 1, 2, 2, 3, 3]), colors: new Uint32Array([1, 2, 3]) }, 1);
    s.nodeLabels = ["a", "b", "c"];
    s.setEdges(3, { indices: new Uint32Array([1, 2, 0, 1, 2, 0]) });
    s.hideEdges(s.removeNodes(new Uint32Array([0])));
    s.flagNodes(new Uint32Array([2]), CONSTANTS.STATE_HIDDEN, true);
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.compactNodes(new Uint32Array([0xffffffff, 0, 1]), 2);
    expect(s.nodeSlots).toBe(2);
    expect(s.nodeCount).toBe(4);
    expect(Array.from(s.channels.nodePos.data)).toEqual([2, 2, 3, 3, 0, 0, 0, 0]);
    expect(Array.from(s.channels.nodeColor.data)).toEqual([2, 3, DEFAULT_NODE_COLOR, DEFAULT_NODE_COLOR]);
    expect(Array.from(s.channels.nodeState.data, (w) => w & CONSTANTS.STATE_HIDDEN)).toEqual([0, 8, 8, 8]);
    expect(s.hiddenCount).toBe(1);
    expect(s.nodeLabels).toEqual(["b", "c"]);
    expect(Array.from(s.channels.edgeIdx.data)).toEqual([0, 1, 0, 0, 1, 1]);
    expect(s.channels.edgeIdx.realloc).toBe(true);
    expect(s.channels.nodeState.realloc).toBe(true);
    expect(s.bounds).toEqual({ minX: 2, minY: 2, maxX: 2, maxY: 2 });
  });

  it("rejects scattered indices past the node count", () => {
    const s = new GraphStore();
    s.setNodes(2, {});
    expect(() => s.updateNodesAt(new Uint32Array([2]), { colors: new Uint32Array([1]) })).toThrow(RangeError);
  });

  it("too many icon colours throw before anything changes", () => {
    const s = new GraphStore();
    s.setNodes(3, {});
    const n = 70_000;
    expect(() => s.setNodes(n, { iconColors: Uint32Array.from({ length: n }, (_, i) => i) })).toThrow(GraphError);
    expect(s.nodeCount).toBe(3);
    expect(s.channels.nodePos.data.length).toBe(6);
    expect(s.channels.nodeSize.data.length).toBe(3);
  });

  it("drawn bounds grow the node centres by the largest radius", () => {
    const s = new GraphStore();
    s.setNodes(3, { positions: new Float32Array([-40, 0, 0, 0, 40, 0]), sizes: new Float32Array([20, 10, 20]) });
    expect(s.maxNodeSize).toBe(20);
    expect(s.drawnBounds(1)).toEqual({ minX: -50, minY: -10, maxX: 50, maxY: 10 });
    expect(s.drawnBounds(2)).toEqual({ minX: -60, minY: -20, maxX: 60, maxY: 20 });
  });

  it("node bounds read the stream and fall back to the mirror past its end", () => {
    const s = new GraphStore();
    s.setNodes(3, { positions: new Float32Array([-40, 0, 0, 0, 40, 0]), sizes: new Float32Array([20, 20, 20]) });
    const streamed = new Float32Array([100, 100, 5, 5]);
    expect(s.nodeBounds(new Uint32Array([0, 2]), 1, streamed)).toEqual({ minX: 30, minY: -10, maxX: 110, maxY: 110 });
    expect(s.nodeBounds(new Uint32Array([2]), 1, null)).toEqual({ minX: 30, minY: -10, maxX: 50, maxY: 10 });
    expect(s.nodeBounds(new Uint32Array([7]), 1, streamed)).toBeNull();
  });

  it("new nodes without sizes count at the default size", () => {
    const s = new GraphStore();
    s.setNodes(2, { sizes: new Float32Array([1, 2]) });
    expect(s.maxNodeSize).toBe(2);
    s.setNodes(3, {});
    expect(s.maxNodeSize).toBe(4);
  });

  it("addEdges grows the mirrors to the slots, writes the new edges and re-sorts", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array([0, 1, 1, 2]) });
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.addEdges(new Uint32Array([2]), 3, { indices: new Uint32Array([2, 0]) }, 0);
    expect(s.edgeCount).toBe(3);
    expect(s.liveEdges).toBe(3);
    expect(Array.from(s.channels.edgeIdx.data)).toEqual([0, 1, 1, 2, 2, 0]);
    expect(s.channels.edgeIdx.realloc).toBe(true);
  });

  it("hideEdges hides edges on the GPU, counts them once and keeps them hidden", () => {
    const s = new GraphStore();
    s.setEdges(3, { indices: new Uint32Array([0, 1, 1, 2, 2, 0]) });
    s.hideEdges(new Uint32Array([1]));
    s.hideEdges(new Uint32Array([1]));
    expect(s.liveEdges).toBe(2);
    expect(s.edgeState![1]! & CONSTANTS.EDGE_STATE_HIDDEN).toBe(CONSTANTS.EDGE_STATE_HIDDEN);
    expect(s.edgeStateUploads.count).toBe(1);
    s.flagEdges(null, Flag.hidden, false);
    expect(s.edgeState![1]! & CONSTANTS.EDGE_STATE_HIDDEN).toBe(CONSTANTS.EDGE_STATE_HIDDEN);
    expect(s.edgeState![0]! & CONSTANTS.EDGE_STATE_HIDDEN).toBe(0);
    expect(s.edgeRankWanted).toBe(true);
  });

  it("flagEdges maps public flags to edge state bits by index and for all", () => {
    const s = new GraphStore();
    s.setEdges(3, { indices: new Uint32Array(6) });
    expect(s.edgeState).toBeNull();
    s.flagEdges(new Uint32Array([0, 2]), Flag.dimmed | Flag.selected, true);
    s.flagEdges(new Uint32Array([2]), Flag.selected, false);
    const D = CONSTANTS.EDGE_STATE_DIMMED;
    const S = CONSTANTS.EDGE_STATE_SELECTED;
    expect(Array.from(s.edgeState!)).toEqual([D | S, 0, D]);
    s.flagEdges(null, Flag.focused, true);
    const F = CONSTANTS.EDGE_STATE_FOCUSED;
    expect(Array.from(s.edgeState!)).toEqual([D | S | F, F, D | F]);
    expect(s.edgeStateAll).toBe(true);
  });

  it("a first per-edge style allocates the channel and re-sorts, later ones scatter", () => {
    const s = new GraphStore();
    s.setEdges(3, { indices: new Uint32Array(6) });
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.updateEdgesAt(new Uint32Array([1]), { styles: new Uint32Array([7]) }, 0);
    expect(s.hasEdgeStyles).toBe(true);
    expect(Array.from(s.channels.edgeStyle.data)).toEqual([0, 7, 0]);
    expect(s.channels.edgeIdx.realloc).toBe(true);
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.updateEdgesAt(new Uint32Array([2]), { styles: new Uint32Array([9]) }, 0);
    expect(s.channels.edgeStyle.realloc).toBe(false);
    expect(s.channels.edgeStyle.scattered.count).toBe(1);
    expect(Array.from(s.channels.edgeStyle.data)).toEqual([0, 7, 9]);
  });

  it("a first per-edge colour fills the other edges with the tint", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array(4) });
    s.updateEdgesAt(new Uint32Array([1]), { colors: new Uint32Array([1, 2]) }, 5);
    expect(s.hasEdgeColors).toBe(true);
    expect(Array.from(s.channels.edgeColor.data)).toEqual([5, 5, 1, 2]);
  });

  it("edge updates with ends rewrite the mirror and re-sort", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array([0, 1, 1, 2]) });
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.updateEdgesAt(new Uint32Array([1]), { indices: new Uint32Array([2, 0]) }, 0);
    expect(Array.from(s.channels.edgeIdx.data)).toEqual([0, 1, 2, 0]);
    expect(s.channels.edgeIdx.realloc).toBe(true);
  });

  it("updateEdges writes styles for every slot through a range", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array(4), styles: new Uint32Array([1, 2]) });
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.updateEdges({ styles: new Uint32Array([3, 4]) });
    expect(Array.from(s.channels.edgeStyle.data)).toEqual([3, 4]);
    expect(s.channels.edgeStyle.dirty.isEmpty).toBe(false);
    expect(s.channels.edgeStyle.realloc).toBe(false);
  });

  it("addEdges into a removed slot clears its state", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array([0, 1, 1, 0]) });
    s.hideEdges(new Uint32Array([0]));
    s.addEdges(new Uint32Array([0]), 2, { indices: new Uint32Array([1, 1]) }, 0);
    expect(s.edgeState![0]).toBe(0);
    expect(s.liveEdges).toBe(2);
  });

  it("compactEdges packs every mirror by the remap", () => {
    const s = new GraphStore();
    s.setEdges(3, { indices: new Uint32Array([0, 1, 1, 2, 2, 0]), styles: new Uint32Array([1, 2, 3]), colors: new Uint32Array([1, 1, 2, 2, 3, 3]) });
    s.hideEdges(new Uint32Array([1]));
    s.flagEdges(new Uint32Array([2]), Flag.dimmed, true);
    s.compactEdges(new Uint32Array([0, 0xffffffff, 1]));
    expect(s.edgeCount).toBe(2);
    expect(s.liveEdges).toBe(2);
    expect(Array.from(s.channels.edgeIdx.data)).toEqual([0, 1, 2, 0]);
    expect(Array.from(s.channels.edgeStyle.data)).toEqual([1, 3]);
    expect(Array.from(s.channels.edgeColor.data)).toEqual([1, 1, 3, 3]);
    expect(Array.from(s.edgeState!)).toEqual([0, CONSTANTS.EDGE_STATE_DIMMED]);
    expect(s.channels.edgeIdx.realloc).toBe(true);
  });

  it("setEdges starts over", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array(4) });
    s.hideEdges(new Uint32Array([0]));
    s.setEdges(1, { indices: new Uint32Array(2) });
    expect(s.edgeState).toBeNull();
    expect(s.liveEdges).toBe(1);
    expect(s.edgeRankWanted).toBe(false);
  });

  it("hasDirected follows the directed flag on every style write", () => {
    const D = CONSTANTS.EDGE_FLAG_DIRECTED;
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array(4), styles: new Uint32Array([8, 8]) });
    expect(s.hasDirected).toBe(false);
    s.addEdges(new Uint32Array([2]), 3, { indices: new Uint32Array(2), styles: new Uint32Array([D]) }, 0);
    expect(s.hasDirected).toBe(true);
    s.updateEdges({ styles: new Uint32Array([1, 2, 3]) });
    expect(s.hasDirected).toBe(false);
    s.updateEdgesAt(new Uint32Array([1]), { styles: new Uint32Array([D | 8]) }, 0);
    expect(s.hasDirected).toBe(true);
    s.setEdges(1, { indices: new Uint32Array(2) });
    expect(s.hasDirected).toBe(false);
    s.setEdges(1, { indices: new Uint32Array(2), styles: new Uint32Array([D]) });
    expect(s.hasDirected).toBe(true);
  });

  it("lists the edges carrying a state bit and follows remove, compact and set", () => {
    const SEL = CONSTANTS.EDGE_STATE_SELECTED;
    const FOC = CONSTANTS.EDGE_STATE_FOCUSED;
    const s = new GraphStore();
    s.setEdges(4, { indices: new Uint32Array(8) });
    const out = new Uint32Array(4);
    expect(s.listEdges(SEL, out, 0)).toBe(0);
    s.flagEdges(new Uint32Array([1, 3]), Flag.selected, true);
    s.flagEdges(new Uint32Array([2]), Flag.focused, true);
    expect(s.listEdges(SEL, out, 0)).toBe(2);
    expect(Array.from(out.subarray(0, 2))).toEqual([1, 3]);
    expect(s.listEdges(FOC, out, 2)).toBe(1);
    expect(out[2]).toBe(2);
    expect(s.listEdges(SEL, new Uint32Array(1), 0)).toBe(2);

    s.hideEdges(new Uint32Array([3]));
    expect(s.listEdges(SEL, out, 0)).toBe(1);
    expect(out[0]).toBe(1);

    s.compactEdges(new Uint32Array([0xffffffff, 0, 1, 0xffffffff]));
    expect(s.listEdges(SEL, out, 0)).toBe(1);
    expect(out[0]).toBe(0);
    expect(s.listEdges(FOC, out, 0)).toBe(1);
    expect(out[0]).toBe(1);

    s.setEdges(2, { indices: new Uint32Array(4) });
    expect(s.listEdges(SEL, out, 0)).toBe(0);
    expect(s.listEdges(FOC, out, 0)).toBe(0);
  });

  it("edges of a removed node leave the edge look list", () => {
    const s = new GraphStore();
    s.setNodes(3, {});
    s.setEdges(2, { indices: new Uint32Array([0, 1, 1, 2]) });
    s.flagEdges(null, Flag.selected, true);
    s.hideEdges(s.removeNodes(new Uint32Array([2])));
    const out = new Uint32Array(2);
    expect(s.listEdges(CONSTANTS.EDGE_STATE_SELECTED, out, 0)).toBe(1);
    expect(out[0]).toBe(0);
  });

  it("edges filled with the tint follow a tint change and host colours stay", () => {
    const s = new GraphStore();
    s.setEdges(3, { indices: new Uint32Array(6) });
    s.updateEdgesAt(new Uint32Array([1]), { colors: new Uint32Array([1, 2]) }, 5);
    for (const ch of Object.values(s.channels)) {
      ch.realloc = false;
      ch.dirty.clear();
      ch.scattered.clear();
    }
    s.edgeRankWanted = false;
    expect(s.retintEdges(9)).toBe(2);
    expect(Array.from(s.channels.edgeColor.data)).toEqual([9, 9, 1, 2, 9, 9]);
    expect(s.channels.edgeColor.dirty.isEmpty).toBe(false);
    expect(s.channels.edgeColor.realloc).toBe(false);
    expect(s.edgeRankWanted).toBe(true);
  });

  it("a host colour clears the tint bit and new edges without colours take it", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array(4), colors: new Uint32Array([1, 1, 2, 2]) });
    expect(s.retintEdges(9)).toBe(0);
    s.addEdges(new Uint32Array([2]), 3, { indices: new Uint32Array(2) }, 7);
    expect(Array.from(s.channels.edgeColor.data)).toEqual([1, 1, 2, 2, 7, 7]);
    expect(s.retintEdges(9)).toBe(1);
    expect(Array.from(s.channels.edgeColor.data)).toEqual([1, 1, 2, 2, 9, 9]);
    s.updateEdgesAt(new Uint32Array([2]), { colors: new Uint32Array([3, 3]) }, 9);
    expect(s.retintEdges(4)).toBe(0);
    s.addEdges(new Uint32Array([0]), 3, { indices: new Uint32Array(2) }, 4);
    s.updateEdges({ colors: new Uint32Array([5, 5, 6, 6, 7, 7]) });
    expect(s.retintEdges(8)).toBe(0);
  });

  it("the first colours given on add fill the other edges with the tint, and they follow it", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array(4) });
    s.addEdges(new Uint32Array([2]), 3, { indices: new Uint32Array(2), colors: new Uint32Array([3, 3]) }, 5);
    expect(Array.from(s.channels.edgeColor.data)).toEqual([5, 5, 5, 5, 3, 3]);
    expect(s.retintEdges(9)).toBe(2);
    expect(Array.from(s.channels.edgeColor.data)).toEqual([9, 9, 9, 9, 3, 3]);
  });

  it("compact and set keep the tint mask right", () => {
    const s = new GraphStore();
    s.setEdges(3, { indices: new Uint32Array(6) });
    s.updateEdgesAt(new Uint32Array([1]), { colors: new Uint32Array([1, 1]) }, 5);
    s.compactEdges(new Uint32Array([0xffffffff, 0, 1]));
    expect(s.retintEdges(9)).toBe(1);
    expect(Array.from(s.channels.edgeColor.data)).toEqual([1, 1, 9, 9]);
    s.setEdges(2, { indices: new Uint32Array(4) });
    expect(s.retintEdges(4)).toBe(0);
  });

  it("shrinks the scatter slot tables when the store resets", () => {
    const s = new GraphStore();
    s.setNodes(100000, {});
    s.flagNodes(new Uint32Array([99999]), CONSTANTS.STATE_SELECTED, true);
    s.updateNodesAt(new Uint32Array([99998]), { colors: new Uint32Array([1]) });
    expect(s.channels.nodeState.scattered.slotCapacity).toBeGreaterThanOrEqual(100000);
    expect(s.channels.nodeColor.scattered.slotCapacity).toBeGreaterThanOrEqual(99999);
    s.setNodes(10, {});
    expect(s.channels.nodeState.scattered.slotCapacity).toBeLessThanOrEqual(10);
    expect(s.channels.nodeColor.scattered.slotCapacity).toBeLessThanOrEqual(10);

    s.setNodes(100000, {});
    s.flagNodes(new Uint32Array([99999]), CONSTANTS.STATE_SELECTED, true);
    const remap = new Uint32Array(100000).fill(0xffffffff);
    remap[0] = 0;
    remap[1] = 1;
    s.compactNodes(remap);
    expect(s.channels.nodeState.scattered.slotCapacity).toBeLessThanOrEqual(2);

    s.setEdges(50000, { indices: new Uint32Array(100000), styles: new Uint32Array(50000) });
    s.flagEdges(new Uint32Array([49999]), Flag.selected, true);
    s.updateEdgesAt(new Uint32Array([49999]), { styles: new Uint32Array([1]) }, 0);
    expect(s.edgeStateUploads.slotCapacity).toBeGreaterThanOrEqual(50000);
    expect(s.channels.edgeStyle.scattered.slotCapacity).toBeGreaterThanOrEqual(50000);
    s.setEdges(5, { indices: new Uint32Array(10), styles: new Uint32Array(5) });
    expect(s.edgeStateUploads.slotCapacity).toBeLessThanOrEqual(5);
    expect(s.channels.edgeStyle.scattered.slotCapacity).toBeLessThanOrEqual(5);

    s.setEdges(50000, { indices: new Uint32Array(100000), styles: new Uint32Array(50000) });
    s.flagEdges(new Uint32Array([49999]), Flag.selected, true);
    s.updateEdgesAt(new Uint32Array([49999]), { styles: new Uint32Array([1]) }, 0);
    const edgeRemap = new Uint32Array(50000).fill(0xffffffff);
    edgeRemap[0] = 0;
    s.compactEdges(edgeRemap);
    expect(s.edgeStateUploads.slotCapacity).toBeLessThanOrEqual(1);
    expect(s.channels.edgeStyle.scattered.slotCapacity).toBeLessThanOrEqual(1);
  });
});
