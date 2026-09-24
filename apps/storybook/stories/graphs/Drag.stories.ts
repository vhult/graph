import type { Meta, StoryObj } from "@storybook/html-vite";
import { communities } from "@vhult/graph-bench";
import { cached } from "../../src/data";
import { removeDragBox, showDragBox } from "../../src/dragBox";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";

interface Args extends GraphArgs {
  nodeDrag: boolean;
}

const SIZES = [10_000, 100_000, 1_000_000, 10_000_000] as const;

const meta: Meta<Args> = {
  title: "Graphs/Drag",
  render: renderGraph<Args>({
    describe: () => "Drag · communities, drag a node, click a node or an edge",
    load: (a) => cached(`communities:${a.nodes}:2:${a.seed}`, () => communities(a.nodes, 2, a.seed)),
    onLoad: (graph, _g, a) => {
      graph.setNodeDrag(a.nodeDrag);
      showDragBox(graph);
    },
    onUpdate: (graph, a, prev) => {
      if (a.nodeDrag !== prev.nodeDrag) graph.setNodeDrag(a.nodeDrag);
    },
    dispose: removeDragBox,
  }),
  argTypes: graphArgTypes<Args>(SIZES, { nodeDrag: { control: "boolean" } }),
  args: { nodes: 10_000, nodeDrag: true, ...GRAPH_ARGS },
};

export default meta;

export const Drag: StoryObj<Args> = {};
