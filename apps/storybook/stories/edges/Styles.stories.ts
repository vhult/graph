import type { Meta, StoryObj } from "@storybook/html-vite";
import { NodeShape, packEdgeStyle } from "@vhult/graph";
import { PALETTE, rgbToWord } from "@vhult/graph-bench";
import { stage } from "../../src/stage";

interface Line {
  pattern?: "dashed" | "dotted" | "dashDot" | "double";
  tapered?: boolean;
}

interface Edge extends Line {
  width: number;
  label: string;
  directed?: boolean;
  curve?: number;
  from?: number;
  to?: number;
  alpha?: number;
  shape?: NodeShape;
  size?: number;
  length?: number;
  back?: boolean;
}

const LINE = 0xb8c4d6;
const LENGTH = 200;
const GAP = 40;
const ROW = 90;
const NODE_SIZE = 10;

const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;

const LINES: { name: string; line: Line }[] = [
  { name: "solid", line: {} },
  { name: "dashed", line: { pattern: "dashed" } },
  { name: "dotted", line: { pattern: "dotted" } },
  { name: "dash-dot", line: { pattern: "dashDot" } },
  { name: "double", line: { pattern: "double" } },
  { name: "tapered", line: { tapered: true } },
  { name: "tapered dashed", line: { tapered: true, pattern: "dashed" } },
];

const WIDTHS = [0.5, 1, 2, 3, 4, 6];
const PATTERN_WIDTHS = [1, 2, 4, 6];
const COLORS = PALETTE.slice(0, 4);
const ALPHAS = [1, 0.75, 0.5, 0.25];
const BENDS = [0, 0.1, 0.2, 0.25];
const SHAPES = Object.entries(NodeShape);

function grid(rows: Edge[][]) {
  const edges = rows.flat();
  const nodeCount = edges.length * 2;
  const positions = new Float32Array(nodeCount * 2);
  const nodeColors = new Uint32Array(nodeCount);
  const sizes = new Float32Array(nodeCount);
  const shapes = new Uint8Array(nodeCount);
  const indices: number[] = [];
  const styles: number[] = [];
  const colors: number[] = [];
  const labels: string[] = [];
  let y = 0;
  let n = 0;
  let top = 0;
  let bottom = 0;
  let right = 0;
  for (const row of rows) {
    let x = 0;
    let bulge = 0;
    let up = 0;
    for (const edge of row) {
      const length = edge.length ?? LENGTH;
      const from = rgbToWord(edge.from ?? LINE, edge.alpha);
      const to = rgbToWord(edge.to ?? edge.from ?? LINE, edge.alpha);
      positions.set([x, y, x + length, y], n * 2);
      nodeColors[n] = rgbToWord(edge.from ?? LINE);
      nodeColors[n + 1] = rgbToWord(edge.to ?? edge.from ?? LINE);
      sizes[n] = NODE_SIZE;
      sizes[n + 1] = edge.size ?? NODE_SIZE;
      shapes[n + 1] = edge.shape ?? NodeShape.circle;
      const style = packEdgeStyle(edge);
      indices.push(n, n + 1);
      styles.push(style);
      colors.push(from, to);
      labels.push(edge.label);
      if (edge.back) {
        shapes[n] = shapes[n + 1]!;
        sizes[n] = sizes[n + 1]!;
        indices.push(n + 1, n);
        styles.push(style);
        colors.push(to, from);
        labels.push("");
      }
      bulge = Math.max(bulge, (edge.curve ?? 0) * length);
      if (edge.back) up = Math.max(up, (edge.curve ?? 0) * length);
      right = Math.max(right, x + length + (edge.size ?? NODE_SIZE));
      x += length + GAP + (edge.size ?? NODE_SIZE);
      n += 2;
    }
    top = Math.min(top, y - up);
    bottom = Math.max(bottom, y + bulge);
    y += ROW + bulge + up;
  }
  const count = styles.length;
  return {
    bounds: { minX: -NODE_SIZE, minY: top - NODE_SIZE, maxX: right, maxY: bottom + NODE_SIZE },
    nodes: { count: nodeCount, positions, colors: nodeColors, sizes, shapes },
    edges: { count, indices: new Uint32Array(indices), styles: new Uint32Array(styles), colors: new Uint32Array(colors), labels },
  };
}

function story(name: string, note: string, rows: Edge[][]): StoryObj {
  return {
    name,
    render: (args, ctx) =>
      stage(args, ctx, {
        setup: (graph, _a, hud) => {
          const g = grid(rows);
          graph.nodes.set(g.nodes);
          graph.edges.set(g.edges);
          graph.camera.fit({ bounds: g.bounds, padding: 96 });
          hud.setNote(note);
        },
      }),
  };
}

const meta: Meta = { title: "Edges/Styles" };

export default meta;

export const Widths = story("Widths", "Edge widths · 0.5 to 6 px, plain and with an arrowhead", [
  WIDTHS.map((w) => ({ width: w, label: `${w} px` })),
  WIDTHS.map((w) => ({ width: w, directed: true, label: `arrow ${w} px` })),
]);

export const Colors = story("Colors", "Edge colours · flat, source to target gradient, alpha", [
  COLORS.map((c) => ({ width: 3, from: c, label: hex(c) })),
  COLORS.map((c, i) => ({ width: 3, from: c, to: PALETTE[i + 4]!, label: "gradient" })),
  ALPHAS.map((a) => ({ width: 3, from: PALETTE[1]!, alpha: a, label: `alpha ${a}` })),
]);

export const Patterns = story(
  "Patterns",
  "Line styles · solid, dashed, dotted, dash-dot, double, tapered, at 1 to 6 px",
  LINES.map(({ name, line }) => PATTERN_WIDTHS.map((w) => ({ ...line, width: w, label: `${name} · ${w} px` }))),
);

export const Arrows = story("Arrows", "Arrowheads · every line style, straight and curved · into each node shape, small and large", [
  ...LINES.map(({ name, line }) =>
    BENDS.map((c) => ({ ...line, width: 3, directed: true, curve: c, label: c === 0 ? name : `curve ${c}` })),
  ),
  SHAPES.flatMap(([name, shape]) => [0, 0.2].map((c) => ({ width: 3, directed: true, curve: c, shape, size: 30, label: c === 0 ? name : "curve" }))),
  SHAPES.flatMap(([name, shape]) => [0, 0.2].map((c) => ({ width: 2, directed: true, curve: c, shape, label: c === 0 ? `small ${name}` : "curve" }))),
]);

export const Curves = story("Curves", "Curved edges · bend 0 to 0.25 · two-way edges bend to opposite sides · gradient and width along the arc", [
  [0, 0.05, 0.1, 0.15, 0.2, 0.25].map((c) => ({ width: 2, curve: c, label: `curve ${c}` })),
  [0.1, 0.2, 0.25].map((c) => ({ width: 2, curve: c, directed: true, back: true, label: `two-way ${c}` })),
  [
    { width: 3, curve: 0.2, from: PALETTE[1]!, to: PALETTE[5]!, label: "gradient" },
    { width: 6, curve: 0.2, label: "6 px" },
    { width: 6, curve: 0.2, tapered: true, label: "tapered 6 px" },
    { width: 3, curve: 0.2, pattern: "dotted", from: PALETTE[0]!, to: PALETTE[4]!, label: "dotted gradient" },
  ],
  [0.1, 0.25].map((c) => ({ width: 2, curve: c, directed: true, length: 420, label: `long · curve ${c}` })),
]);
