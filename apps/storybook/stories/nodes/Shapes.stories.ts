import type { Meta, StoryObj } from "@storybook/html-vite";
import { NodeShape } from "@vhult/graph";
import { PALETTE, rgbToWord } from "@vhult/graph-bench";
import { stage, toggles } from "../../src/stage";

const SHAPES = Object.entries(NodeShape);
const SIZE = 20;
const SPACING = 40;

const meta: Meta = {
  title: "Nodes/Shapes",
  render: (args, ctx) =>
    stage({ ...args, labels: toggles(ctx).labels }, ctx, {
      setup: (graph, a, hud) => {
        const n = SHAPES.length;
        const positions = new Float32Array(n * 2);
        const colors = new Uint32Array(n);
        const sizes = new Float32Array(n).fill(SIZE);
        const shapes = new Uint8Array(n);
        SHAPES.forEach(([, shape], i) => {
          positions[i * 2] = (i - (n - 1) / 2) * SPACING;
          colors[i] = rgbToWord(PALETTE[i % PALETTE.length]!);
          shapes[i] = shape;
        });
        graph.setNodes({ count: n, positions, colors, sizes, shapes });
        graph.setEdges({ count: 0, indices: new Uint32Array(0) });
        graph.setNodeLabels(a.labels ? SHAPES.map(([name]) => name) : []);
        graph.camera.fit();
        hud.setNote(`Shapes · ${SHAPES.map(([name]) => name).join(", ")}`);
      },
      update: (graph, a, prev) => {
        if (a.labels !== prev.labels) graph.setNodeLabels(a.labels ? SHAPES.map(([name]) => name) : []);
      },
    }),
};

export default meta;

export const Shapes: StoryObj = {};
