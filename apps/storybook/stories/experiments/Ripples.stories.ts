import type { Meta, StoryObj } from "@storybook/html-vite";
import { cached } from "../../src/data";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";
import { pool, Water } from "../../src/ripples";

let water: Water | null = null;

function stop(): void {
  water?.stop();
  water = null;
  (globalThis as { __water?: Water | null }).__water = null;
}

const meta: Meta<GraphArgs> = {
  title: "Experiments/Ripples",
  render: renderGraph<GraphArgs>({
    describe: () => "Ripples · hover the water to drop into it, waves travel along the graph, computed on the main thread and streamed every frame",
    options: () => ({ transparent: true, hoverStyle: false, nodeDrag: false }),
    backdrop: "radial-gradient(ellipse at 35% 30%, #0c2a44 0%, #071a2c 45%, #030a14 100%)",
    load: (a) => cached(`pool:${a.nodes}:${a.seed}`, () => pool(a.nodes, a.seed)),
    onLoad: (graph, g, _a, root) => {
      stop();
      graph.setBackground([0, 0, 0, 0]);
      water = new Water(graph, g, root);
      (globalThis as { __water?: Water | null }).__water = water;
    },
    dispose: stop,
  }),
  argTypes: graphArgTypes<GraphArgs>([100_000, 1_000_000]),
  args: { nodes: 100_000, ...GRAPH_ARGS, edges: false },
  parameters: { controls: { include: ["nodes"] } },
};

export default meta;

export const Ripples: StoryObj<GraphArgs> = {};
