import type { Meta, StoryObj } from "@storybook/html-vite";
import { communities } from "@vhult/graph-bench";
import { cached } from "../../src/data";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";
import { removeHoverBox, showHoverBox } from "../../src/hoverBox";

const SIZES = [100_000, 1_000_000, 5_000_000, 10_000_000] as const;

const meta: Meta<GraphArgs> = {
  title: "Graphs/Hover",
  render: renderGraph<GraphArgs>({
    describe: () => "Hover · communities, hover a node or an edge",
    load: (a) => cached(`communities:${a.nodes}:2:${a.seed}`, () => communities(a.nodes, 2, a.seed)),
    onLoad: (graph, g) => {
      const ends = g.edges.indices;
      showHoverBox(graph, {
        node: (i) => `#${i}`,
        edge: (e) => `#${e} (#${ends[e * 2]} → #${ends[e * 2 + 1]})`,
      });
    },
    dispose: removeHoverBox,
  }),
  argTypes: graphArgTypes<GraphArgs>(SIZES),
  args: { nodes: 1_000_000, ...GRAPH_ARGS },
};

export default meta;

export const Hover: StoryObj<GraphArgs> = {};
