import type { Meta, StoryObj } from "@storybook/html-vite";
import { loadMap, MAP_OPTIONS, NODE_COUNTS, type MapName } from "../../src/data";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";
import { showReadout } from "../../src/readout";

interface Args extends GraphArgs {
  layout: MapName;
}

const DESCRIBE: Record<MapName, string> = {
  "cosmic web": "galaxies in clusters, filaments, walls and voids, linked to their nearest neighbours",
  brain: "white-matter fibres traced through both hemispheres, coloured by direction, with the cortex around them",
  rivers: "every stream of a continent draining to the sea, sized by flow and coloured by basin",
  "deep field": "thousands of galaxies at every distance, spirals, ellipticals and irregulars, with a few foreground stars",
};

const meta: Meta<Args> = {
  title: "Showcase/Large graph",
  render: renderGraph<Args>({
    describe: (a) => `Large graph · ${a.layout} · ${DESCRIBE[a.layout]}`,
    load: (a) => loadMap(a.layout, a.nodes, a.seed),
    dataArgs: ["layout"],
    onLoad: (graph, _g, _a, root) => showReadout(graph, root),
  }),
  argTypes: { layout: { control: "select", options: MAP_OPTIONS }, ...graphArgTypes<Args>(NODE_COUNTS) },
  args: { layout: "cosmic web", ...GRAPH_ARGS, nodes: 1_000_000, edgeColor: "nodes", edgeAlpha: 0.6 },
  parameters: { controls: { include: ["layout", "nodes", "seed", "labels"] } },
};

export default meta;

export const LargeGraph: StoryObj<Args> = { name: "Large graph" };
