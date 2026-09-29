import type { Meta, StoryObj } from "@storybook/html-vite";
import { packEdgeStyle } from "@vhult/graph";
import { PALETTE, rgbToWord } from "@vhult/graph-bench";
import { stage } from "../../src/stage";

interface Edge {
  width: number;
  directed?: boolean;
  pattern?: "dashed" | "dotted" | "dashDot" | "double";
  tapered?: boolean;
  curve?: number;
  from: number;
  to: number;
  label: string;
}

const LINE = 0xb8c4d6;
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
  (["dashed", "dotted", "dashDot", "double"] as const).map((p) => ({ width: 2, pattern: p, from: LINE, to: LINE, label: p })),
  (["dashed", "dotted", "dashDot", "double"] as const).map((p) => ({ width: 4, pattern: p, from: LINE, to: LINE, label: `${p} 4 px` })),
  [
    { width: 3, tapered: true, from: LINE, to: LINE, label: "tapered" },
    { width: 6, tapered: true, from: LINE, to: LINE, label: "tapered 6 px" },
    { width: 3, tapered: true, pattern: "dashed", from: LINE, to: LINE, label: "tapered dashed" },
    { width: 2, directed: true, pattern: "dashed", from: LINE, to: LINE, label: "dashed arrow" },
    { width: 3, pattern: "dotted", from: PALETTE[0]!, to: PALETTE[4]!, label: "dotted gradient" },
  ],
  [0.1, 0.2, 0.25].map((c) => ({ width: 2, curve: c, from: LINE, to: LINE, label: `curve ${c}` })),
  [
    { width: 2, curve: 0.2, directed: true, from: LINE, to: LINE, label: "curved arrow" },
    { width: 2, curve: 0.2, pattern: "dashed", from: LINE, to: LINE, label: "curved dashed" },
    { width: 4, curve: 0.2, tapered: true, from: LINE, to: LINE, label: "curved tapered" },
    { width: 3, curve: 0.2, from: PALETTE[1]!, to: PALETTE[5]!, label: "curved gradient" },
  ],
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
      styles[e] = packEdgeStyle(edge);
      colors[a] = rgbToWord(edge.from);
      colors[a + 1] = rgbToWord(edge.to);
      e++;
    });
  });
  return {
    nodes: { count: count * 2, positions, colors: nodeColors, sizes: new Float32Array(count * 2).fill(NODE_SIZE) },
    edges: { count, indices, styles, colors, labels: edges.map((edge) => edge.label) },
  };
}

const meta: Meta = {
  title: "Edges/Styles",
  render: (args, ctx) =>
    stage(args, ctx, {
      setup: (graph, _a, hud) => {
        const g = build();
        graph.nodes.set(g.nodes);
        graph.edges.set(g.edges);
        graph.camera.fit({ padding: 96 });
        hud.setNote("Edge styles · width, arrowheads, per-edge colour, gradient, patterns, taper, curves, labels");
      },
    }),
};

export default meta;

export const Styles: StoryObj = {};
