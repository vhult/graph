import type { Meta, StoryObj } from "@storybook/html-vite";
import { PALETTE, rgbToWord } from "@vhult/graph-bench";
import { EDGE_DIRECTED } from "../../src/graphStory";
import { stage, toggles } from "../../src/stage";

interface Edge {
  width: number;
  directed?: boolean;
  from: number;
  to: number;
  label: string;
}

const LINE = 0xb8c4d6;
const WIDTH_UNIT = 8;
const COLUMN = 180;
const LENGTH = 140;
const ROW = 90;
const NODE_SIZE = 10;

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;

const ROWS: Edge[][] = [
  [0.5, 1, 2, 3, 4, 6].map((w) => ({ width: w, from: LINE, to: LINE, label: `${w} px` })),
  [1, 2, 4].map((w) => ({ width: w, directed: true, from: LINE, to: LINE, label: `arrow ${w} px` })),
  PALETTE.slice(0, 4).map((c) => ({ width: 3, from: c, to: c, label: hex(c) })),
  PALETTE.slice(0, 4).map((c, i) => ({ width: 3, from: c, to: PALETTE[i + 4]!, label: "gradient" })),
];

function build() {
  const edges = ROWS.flat();
  const count = edges.length;
  const positions = new Float32Array(count * 4);
  const nodeColors = new Uint32Array(count * 2);
  const indices = new Uint32Array(count * 2);
  const styles = new Uint32Array(count);
  const colors = new Uint32Array(count * 2);
  let e = 0;
  ROWS.forEach((row, r) => {
    row.forEach((edge, c) => {
      const a = e * 2;
      positions.set([c * COLUMN, r * ROW, c * COLUMN + LENGTH, r * ROW], a * 2);
      nodeColors[a] = rgbToWord(edge.from);
      nodeColors[a + 1] = rgbToWord(edge.to);
      indices[a] = a;
      indices[a + 1] = a + 1;
      styles[e] = (Math.round(edge.width * WIDTH_UNIT) & 0xff) | (edge.directed ? EDGE_DIRECTED : 0);
      colors[a] = rgbToWord(edge.from);
      colors[a + 1] = rgbToWord(edge.to);
      e++;
    });
  });
  return {
    nodes: { count: count * 2, positions, colors: nodeColors, sizes: new Float32Array(count * 2).fill(NODE_SIZE) },
    edges: { count, indices, styles, colors },
    labels: edges.map((edge) => edge.label),
  };
}

const meta: Meta = {
  title: "Edges/Styles",
  render: (args, ctx) =>
    stage({ ...args, labels: toggles(ctx).labels }, ctx, {
      options: () => ({ directedEdges: true }),
      setup: (graph, a, hud) => {
        const g = build();
        graph.setNodes(g.nodes);
        graph.setEdges(g.edges);
        graph.setEdgeLabels(a.labels ? g.labels : []);
        graph.camera.fit();
        hud.setNote("Edge styles · width, arrowheads, per-edge colour, gradient, labels");
      },
      update: (graph, a, prev) => {
        if (a.labels !== prev.labels) graph.setEdgeLabels(a.labels ? build().labels : []);
      },
    }),
};

export default meta;

export const Styles: StoryObj = {};
