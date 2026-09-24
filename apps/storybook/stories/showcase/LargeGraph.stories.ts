import type { Meta, StoryObj } from "@storybook/html-vite";
import { LAYOUT_OPTIONS, loadLayout, NODE_COUNTS, type LayoutName } from "../../src/data";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";
import { showReadout } from "../../src/readout";

interface Args extends GraphArgs {
  layout: LayoutName;
}

const meta: Meta<Args> = {
  title: "Showcase/Large graph",
  render: renderGraph<Args>({
    describe: (a) => `Large graph · ${a.layout}`,
    load: (a) => loadLayout(a.layout, a.nodes, a.seed),
    dataArgs: ["layout"],
    options: () => ({ nodeDrag: true }),
    onLoad: (graph, _g, _a, root) => showReadout(graph, root),
  }),
  argTypes: { layout: { control: "select", options: LAYOUT_OPTIONS }, ...graphArgTypes<Args>(NODE_COUNTS) },
  args: { layout: "communities", nodes: 100_000, ...GRAPH_ARGS },
  parameters: { controls: { include: ["layout", "nodes", "labels", "edges"] } },
};

export default meta;

export const LargeGraph: StoryObj<Args> = { name: "Large graph" };
