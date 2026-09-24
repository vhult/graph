import type { Meta, StoryObj } from "@storybook/html-vite";
import { PALETTE, rgbToWord } from "@vhult/graph-bench";
import { stage } from "../../src/stage";

const COUNT = 10;
const SIZE = 40;
const SPACING = SIZE / 2;

const meta: Meta = {
  title: "Nodes/Z-index",
  render: (args, ctx) =>
    stage(args, ctx, {
      options: () => ({ nodeDrag: true }),
      setup: (graph, _a, hud) => {
        const positions = new Float32Array(COUNT * 2);
        const colors = new Uint32Array(COUNT);
        const sizes = new Float32Array(COUNT).fill(SIZE);
        const zIndex = new Uint8Array(COUNT);
        for (let i = 0; i < COUNT; i++) {
          const place = COUNT - 1 - i;
          positions[i * 2] = (place - (COUNT - 1) / 2) * SPACING;
          colors[i] = rgbToWord(PALETTE[place % PALETTE.length]!);
          zIndex[i] = place;
        }
        graph.setNodes({ count: COUNT, positions, colors, sizes, zIndex });
        graph.setEdges({ count: 0, indices: new Uint32Array(0) });
        graph.camera.fit();
        hud.setNote("Z-index · z grows from 0 on the left to 9 on the right, so each node covers the one on its left\nwithout z-index the engine picks its own order and the stack comes out mixed");
      },
    }),
};

export default meta;

export const ZIndex: StoryObj = { name: "Z-index" };
