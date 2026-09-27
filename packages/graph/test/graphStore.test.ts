import { describe, expect, it } from "vitest";
import { GraphError } from "../src/api/errors";
import { DEFAULT_NODE_COLOR, GraphStore } from "../src/data/GraphStore";
import { Flag } from "../src/api/types";
import { CONSTANTS, DEFAULT_NODE_STYLE, MAX_NODES } from "../src/data/Layouts";

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
    const s = new GraphStore(1);
    s.setNodes(4, {});
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
    const st = () => s.channels.nodeState.data as Uint32Array;
    expect(Array.from(s.looks.nodes[0].entries(st()))).toEqual([4, 1]);
    expect(Array.from(s.looks.nodes[1].entries(st()))).toEqual([2]);
    s.removeNodes(new Uint32Array([4]));
    expect(Array.from(s.looks.nodes[0].entries(st()))).toEqual([1]);
  });

  it("setNodes keeps a hidden reserve past the slots that bounds and the hidden count skip", () => {
    const s = new GraphStore(2);
    const H = CONSTANTS.STATE_HIDDEN;
    s.setNodes(2, { positions: new Float32Array([1, 2, 3, 4]), colors: new Uint32Array([7, 8]) });
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
    const s = new GraphStore(1);
    const H = CONSTANTS.STATE_HIDDEN;
    s.setNodes(4, {});
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
    const s = new GraphStore(1);
    const H = CONSTANTS.STATE_HIDDEN;
    s.setNodes(3, {});
    s.removeNodes(new Uint32Array([1]));
    s.flagNodes(null, H, true);
    expect(s.hiddenCount).toBe(2);
    s.flagNodes(null, H | CONSTANTS.STATE_SELECTED, false);
    expect(s.hiddenCount).toBe(0);
    const st = s.channels.nodeState.data as Uint32Array;
    expect([st[0]! & H, st[1]! & H, st[2]! & H, st[3]! & H]).toEqual([0, H, 0, H]);
  });

  it("addNodes shows the nodes and writes defaults for missing channels", () => {
    const s = new GraphStore(2);
    s.setNodes(2, { colors: new Uint32Array([7, 8]), positions: new Float32Array([1, 1, 2, 2]) });
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
    const s = new GraphStore(1);
    s.setNodes(2, { colors: new Uint32Array([7, 8]) });
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.growNodes(5);
    expect(s.nodeCount).toBe(6);
    expect(s.nodeSlots).toBe(2);
    expect(s.channels.nodePos.realloc).toBe(true);
    expect(Array.from(s.channels.nodeColor.data)).toEqual([7, 8, DEFAULT_NODE_COLOR, DEFAULT_NODE_COLOR, DEFAULT_NODE_COLOR, DEFAULT_NODE_COLOR]);
    const st = s.channels.nodeState.data as Uint32Array;
    expect(Array.from(st, (w) => w & CONSTANTS.STATE_HIDDEN)).toEqual([0, 0, 8, 8, 8, 8]);
  });

  it("compactNodes packs the node mirrors, keeps a reserve and remaps edge ends", () => {
    const s = new GraphStore(2);
    s.setNodes(3, { positions: new Float32Array([1, 1, 2, 2, 3, 3]), colors: new Uint32Array([1, 2, 3]) });
    s.setEdges(3, { indices: new Uint32Array([1, 2, 0, 1, 2, 0]) });
    s.hideEdges(s.removeNodes(new Uint32Array([0])));
    s.flagNodes(new Uint32Array([2]), CONSTANTS.STATE_HIDDEN, true);
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.compactNodes(new Uint32Array([0xffffffff, 0, 1]));
    expect(s.nodeSlots).toBe(2);
    expect(s.nodeCount).toBe(4);
    expect(Array.from(s.channels.nodePos.data)).toEqual([2, 2, 3, 3, 0, 0, 0, 0]);
    expect(Array.from(s.channels.nodeColor.data)).toEqual([2, 3, DEFAULT_NODE_COLOR, DEFAULT_NODE_COLOR]);
    expect(Array.from(s.channels.nodeState.data, (w) => w & CONSTANTS.STATE_HIDDEN)).toEqual([0, 8, 8, 8]);
    expect(s.hiddenCount).toBe(1);
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
    s.addEdges(new Uint32Array([2]), 3, { indices: new Uint32Array([2, 0]) });
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
    expect(s.edgeStateChannel.scattered.count).toBe(1);
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
    expect(s.edgeStateChannel.dirty.count).toBe(1);
  });

  it("a first per-edge style allocates the channel and re-sorts, later ones scatter", () => {
    const s = new GraphStore();
    s.setEdges(3, { indices: new Uint32Array(6) });
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.updateEdgesAt(new Uint32Array([1]), { styles: new Uint32Array([7]) });
    expect(s.hasEdgeStyles).toBe(true);
    expect(Array.from(s.channels.edgeStyle.data)).toEqual([0, 7, 0]);
    expect(s.channels.edgeIdx.realloc).toBe(true);
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.updateEdgesAt(new Uint32Array([2]), { styles: new Uint32Array([9]) });
    expect(s.channels.edgeStyle.realloc).toBe(false);
    expect(s.channels.edgeStyle.scattered.count).toBe(1);
    expect(Array.from(s.channels.edgeStyle.data)).toEqual([0, 7, 9]);
  });

  it("a first per-edge colour fills the other edges with 0", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array(4) });
    s.updateEdgesAt(new Uint32Array([1]), { colors: new Uint32Array([1, 2]) });
    expect(s.hasEdgeColors).toBe(true);
    expect(Array.from(s.channels.edgeColor.data)).toEqual([0, 0, 1, 2]);
  });

  it("edge updates with ends rewrite the mirror and re-sort", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array([0, 1, 1, 2]) });
    for (const ch of Object.values(s.channels)) ch.realloc = false;
    s.updateEdgesAt(new Uint32Array([1]), { indices: new Uint32Array([2, 0]) });
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
    s.addEdges(new Uint32Array([0]), 2, { indices: new Uint32Array([1, 1]) });
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
    s.addEdges(new Uint32Array([2]), 3, { indices: new Uint32Array(2), styles: new Uint32Array([D]) });
    expect(s.hasDirected).toBe(true);
    s.updateEdges({ styles: new Uint32Array([1, 2, 3]) });
    expect(s.hasDirected).toBe(false);
    s.updateEdgesAt(new Uint32Array([1]), { styles: new Uint32Array([D | 8]) });
    expect(s.hasDirected).toBe(true);
    s.setEdges(1, { indices: new Uint32Array(2) });
    expect(s.hasDirected).toBe(false);
    s.setEdges(1, { indices: new Uint32Array(2), styles: new Uint32Array([D]) });
    expect(s.hasDirected).toBe(true);
  });

  it("lists the edges carrying a state bit and follows remove, compact and set", () => {
    const s = new GraphStore();
    s.setEdges(4, { indices: new Uint32Array(8) });
    const [sel, foc] = s.looks.edges;
    const list = (l: typeof sel) => Array.from(l.entries(s.edgeState ?? new Uint32Array(0)));
    expect(list(sel)).toEqual([]);
    s.flagEdges(new Uint32Array([1, 3]), Flag.selected, true);
    s.flagEdges(new Uint32Array([2]), Flag.focused, true);
    expect(list(sel)).toEqual([1, 3]);
    expect(list(foc)).toEqual([2]);

    s.hideEdges(new Uint32Array([3]));
    expect(list(sel)).toEqual([1]);

    s.compactEdges(new Uint32Array([0xffffffff, 0, 1, 0xffffffff]));
    expect(list(sel)).toEqual([0]);
    expect(list(foc)).toEqual([1]);

    s.setEdges(2, { indices: new Uint32Array(4) });
    expect(list(sel)).toEqual([]);
    expect(list(foc)).toEqual([]);
  });

  it("edges of a removed node leave the edge look list", () => {
    const s = new GraphStore();
    s.setNodes(3, {});
    s.setEdges(2, { indices: new Uint32Array([0, 1, 1, 2]) });
    s.flagEdges(null, Flag.selected, true);
    s.hideEdges(s.removeNodes(new Uint32Array([2])));
    expect(Array.from(s.looks.edges[0].entries(s.edgeState!))).toEqual([0]);
  });

  it("shrinks the scatter slot tables when the store resets", () => {
    const s = new GraphStore();
    s.setNodes(100000, {});
    s.flagNodes(new Uint32Array([99999]), CONSTANTS.STATE_SELECTED, true);
    s.updateNodesAt(new Uint32Array([99998]), { colors: new Uint32Array([1]) });
    expect(s.channels.nodeState.scattered.capacity).toBeGreaterThanOrEqual(100000);
    expect(s.channels.nodeColor.scattered.capacity).toBeGreaterThanOrEqual(99999);
    s.setNodes(10, {});
    expect(s.channels.nodeState.scattered.capacity).toBeLessThanOrEqual(10);
    expect(s.channels.nodeColor.scattered.capacity).toBeLessThanOrEqual(10);

    s.setNodes(100000, {});
    s.flagNodes(new Uint32Array([99999]), CONSTANTS.STATE_SELECTED, true);
    const remap = new Uint32Array(100000).fill(0xffffffff);
    remap[0] = 0;
    remap[1] = 1;
    s.compactNodes(remap);
    expect(s.channels.nodeState.scattered.capacity).toBeLessThanOrEqual(2);

    s.setEdges(50000, { indices: new Uint32Array(100000), styles: new Uint32Array(50000) });
    s.flagEdges(new Uint32Array([49999]), Flag.selected, true);
    s.updateEdgesAt(new Uint32Array([49999]), { styles: new Uint32Array([1]) });
    expect(s.edgeStateChannel.scattered.capacity).toBeGreaterThanOrEqual(50000);
    expect(s.channels.edgeStyle.scattered.capacity).toBeGreaterThanOrEqual(50000);
    s.setEdges(5, { indices: new Uint32Array(10), styles: new Uint32Array(5) });
    expect(s.edgeStateChannel.scattered.capacity).toBeLessThanOrEqual(5);
    expect(s.channels.edgeStyle.scattered.capacity).toBeLessThanOrEqual(5);

    s.setEdges(50000, { indices: new Uint32Array(100000), styles: new Uint32Array(50000) });
    s.flagEdges(new Uint32Array([49999]), Flag.selected, true);
    s.updateEdgesAt(new Uint32Array([49999]), { styles: new Uint32Array([1]) });
    const edgeRemap = new Uint32Array(50000).fill(0xffffffff);
    edgeRemap[0] = 0;
    s.compactEdges(edgeRemap);
    expect(s.edgeStateChannel.scattered.capacity).toBeLessThanOrEqual(1);
    expect(s.channels.edgeStyle.scattered.capacity).toBeLessThanOrEqual(1);
  });
});

const D = CONSTANTS.EDGE_FLAG_DIRECTED;
const settle = (s: GraphStore) => {
  for (const ch of Object.values(s.channels)) ch.realloc = false;
};

describe("GraphStore directed count", () => {
  it("counts a removed edge once, however often it is hidden", () => {
    const s = new GraphStore();
    s.setEdges(3, { indices: new Uint32Array(6), styles: new Uint32Array([D, D, 0]) });
    expect(s.directedEdges).toBe(2);
    s.hideEdges(new Uint32Array([0]));
    s.hideEdges(new Uint32Array([0]));
    expect(s.directedEdges).toBe(1);
    s.hideEdges(new Uint32Array([1, 1]));
    expect(s.directedEdges).toBe(0);
    expect(s.hasDirected).toBe(false);
  });

  it("keeps counting an edge hidden with a flag, which is not removed", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array(4), styles: new Uint32Array([D, 0]) });
    s.flagEdges(new Uint32Array([0]), Flag.hidden, true);
    expect(s.hasDirected).toBe(true);
  });

  it("recounts on compact without the removed edges", () => {
    const s = new GraphStore();
    s.setEdges(3, { indices: new Uint32Array(6), styles: new Uint32Array([D, 0, D]) });
    s.hideEdges(new Uint32Array([2]));
    s.compactEdges(new Uint32Array([0, 1, 0xffffffff]));
    expect(s.directedEdges).toBe(1);
    s.hideEdges(new Uint32Array([0]));
    s.compactEdges(new Uint32Array([0xffffffff, 0]));
    expect(s.directedEdges).toBe(0);
  });

  it("counts a slot listed twice in one add once, and a restyle of a removed edge not at all", () => {
    const s = new GraphStore();
    s.setEdges(1, { indices: new Uint32Array(2), styles: new Uint32Array([0]) });
    s.addEdges(new Uint32Array([1, 1]), 2, { indices: new Uint32Array(4), styles: new Uint32Array([D, D]) });
    expect(s.directedEdges).toBe(1);
    s.hideEdges(new Uint32Array([0]));
    s.updateEdgesAt(new Uint32Array([0]), { styles: new Uint32Array([D]) });
    expect(s.directedEdges).toBe(1);
    s.addEdges(new Uint32Array([0]), 2, { indices: new Uint32Array(2), styles: new Uint32Array([D]) });
    expect(s.directedEdges).toBe(2);
  });
});

describe("GraphStore edge reload", () => {
  it("edges.set at the same count reloads the edge buffer, with or without new ends", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array([0, 1, 1, 0]) });
    settle(s);
    s.setEdges(2, { indices: new Uint32Array([1, 1, 0, 0]) });
    expect(s.channels.edgeIdx.realloc).toBe(true);
    expect(Array.from(s.channels.edgeIdx.data)).toEqual([1, 1, 0, 0]);
    settle(s);
    s.setEdges(2, { styles: new Uint32Array(2) });
    expect(s.channels.edgeIdx.realloc).toBe(true);
  });
});

describe("GraphStore edge colour word 0", () => {
  it("fills the other edges with 0 when the first colours come with an add", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array(4) });
    s.addEdges(new Uint32Array([2]), 3, { indices: new Uint32Array(2), colors: new Uint32Array([5, 6]) });
    expect(s.hasEdgeColors).toBe(true);
    expect(Array.from(s.channels.edgeColor.data)).toEqual([0, 0, 0, 0, 5, 6]);
  });

  it("writes 0 for a new edge without colours among coloured edges", () => {
    const s = new GraphStore();
    s.setEdges(1, { indices: new Uint32Array(2), colors: new Uint32Array([5, 6]) });
    s.addEdges(new Uint32Array([1]), 2, { indices: new Uint32Array(2) });
    expect(Array.from(s.channels.edgeColor.data)).toEqual([5, 6, 0, 0]);
  });

  it("scatters a colour update back to 0 without a reload", () => {
    const s = new GraphStore();
    s.setEdges(2, { indices: new Uint32Array(4), colors: new Uint32Array([5, 6, 7, 8]) });
    settle(s);
    s.updateEdgesAt(new Uint32Array([1]), { colors: new Uint32Array([0, 0]) });
    expect(Array.from(s.channels.edgeColor.data)).toEqual([5, 6, 0, 0]);
    expect(s.channels.edgeColor.realloc).toBe(false);
    expect(s.channels.edgeColor.scattered.count).toBe(1);
  });

  it("keeps colour word 0 through a compact", () => {
    const s = new GraphStore();
    s.setEdges(3, { indices: new Uint32Array(6), colors: new Uint32Array([0, 0, 5, 6, 0, 0]) });
    s.hideEdges(new Uint32Array([1]));
    s.compactEdges(new Uint32Array([0, 0xffffffff, 1]));
    expect(Array.from(s.channels.edgeColor.data)).toEqual([0, 0, 0, 0]);
  });
});

const R = 100;

describe("GraphStore node removal and reserve", () => {
  it("compact collapses an edge whose two ends were removed", () => {
    const s = new GraphStore();
    s.setNodes(3, {});
    s.setEdges(2, { indices: new Uint32Array([0, 1, 1, 2]) });
    s.hideEdges(s.removeNodes(new Uint32Array([0, 1])));
    s.compactNodes(new Uint32Array([0xffffffff, 0xffffffff, 0]));
    expect(Array.from(s.channels.edgeIdx.data)).toEqual([0, 0, 0, 0]);
    expect(s.liveEdges).toBe(0);
  });

  it("an add inside the reserve is a scatter and leaves the rest of the reserve hidden", () => {
    const s = new GraphStore(R);
    s.setNodes(10, {});
    expect(s.nodeCount).toBe(10 + R);
    settle(s);
    const added = Uint32Array.from({ length: R - 1 }, (_, k) => 10 + k);
    s.addNodes(added, 10 + R - 1, {});
    expect(Object.values(s.channels).some((ch) => ch.realloc)).toBe(false);
    expect(s.channels.nodeState.scattered.count).toBe(R - 1);
    expect(s.nodeCount).toBe(10 + R);
    const st = s.channels.nodeState.data as Uint32Array;
    expect(st[10 + R - 2]).toBe(0);
    expect(st[10 + R - 1]! & CONSTANTS.STATE_HIDDEN).toBe(CONSTANTS.STATE_HIDDEN);
  });

  it("growing by the reserve keeps the nodes and hides the new slots", () => {
    const s = new GraphStore(R);
    s.setNodes(2, { colors: new Uint32Array([7, 8]) });
    s.addNodes(Uint32Array.from({ length: R }, (_, k) => 2 + k), 2 + R, {});
    settle(s);
    s.growNodes(2 + R);
    expect(s.nodeCount).toBe(2 + 2 * R);
    expect(s.channels.nodeState.realloc).toBe(true);
    expect(Array.from(s.channels.nodeColor.data.slice(0, 2))).toEqual([7, 8]);
    const st = s.channels.nodeState.data as Uint32Array;
    let hidden = 0;
    for (let i = 0; i < st.length; i++) if ((st[i]! & CONSTANTS.STATE_HIDDEN) !== 0) hidden++;
    expect(hidden).toBe(R);
    expect(s.hiddenCount).toBe(0);
  });
  it("keeps exactly the reserve hidden after set, compact and a growth", () => {
    for (const reserve of [0, 7]) {
      const s = new GraphStore(reserve);
      const tailHidden = () => {
        const st = s.channels.nodeState.data as Uint32Array;
        expect(s.nodeCount - s.nodeSlots).toBe(reserve);
        expect(st.length).toBe(s.nodeCount);
        for (let i = s.nodeSlots; i < s.nodeCount; i++) expect(st[i]! & CONSTANTS.STATE_HIDDEN).toBe(CONSTANTS.STATE_HIDDEN);
      };
      s.setNodes(5, {});
      tailHidden();
      s.removeNodes(new Uint32Array([1, 3]));
      s.compactNodes(new Uint32Array([0, 0xffffffff, 1, 0xffffffff, 2]));
      expect(s.nodeSlots).toBe(3);
      tailHidden();
      const added = Math.max(1, reserve);
      expect(s.needsGrowth(3 + added - 1)).toBe(false);
      expect(s.needsGrowth(3 + added)).toBe(true);
      s.growNodes(3 + added);
      s.addNodes(Uint32Array.from({ length: added }, (_, k) => 3 + k), 3 + added, {});
      expect(s.nodeSlots).toBe(3 + added);
      tailHidden();
    }
  });

  it("does not grow for an add that reuses freed slots", () => {
    const s = new GraphStore(0);
    s.setNodes(3, {});
    s.removeNodes(new Uint32Array([1]));
    expect(s.needsGrowth(3)).toBe(false);
    expect(s.needsGrowth(4)).toBe(true);
    s.growNodes(4);
    expect(s.nodeCount).toBe(4);
  });

  it("clamps the reserve so the node count never passes the node limit", () => {
    expect(MAX_NODES).toBe(CONSTANTS.EDGE_END_MASK + 1);
    expect(new GraphStore(100).withReserve(10)).toBe(110);
    expect(new GraphStore(100).withReserve(MAX_NODES - 40)).toBe(MAX_NODES);
    expect(new GraphStore(100).withReserve(MAX_NODES)).toBe(MAX_NODES);
    expect(new GraphStore(2 ** 40).withReserve(1)).toBe(MAX_NODES);
    expect(new GraphStore(0).withReserve(MAX_NODES)).toBe(MAX_NODES);
  });
});
