import type { Meta, StoryObj } from "@storybook/html-vite";
import { packEdgeStyle } from "@vhult/graph";
import { rng } from "@vhult/graph-bench";
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

const MIX: readonly [number, number][] = [
  [0.6, packEdgeStyle({})],
  [0.7, packEdgeStyle({ pattern: "dashed" })],
  [0.8, packEdgeStyle({ pattern: "dotted" })],
  [0.88, packEdgeStyle({ pattern: "dashDot" })],
  [0.96, packEdgeStyle({ width: 2, tapered: true })],
  [1, packEdgeStyle({ width: 3, pattern: "double" })],
];

function randomStyles(count: number, seed: number): Uint32Array {
  const r = rng(seed);
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const v = r();
    out[i] = MIX.find(([p]) => v < p)![1];
  }
  return out;
}

const meta: Meta<Args> = {
  title: "Showcase/Large graph",
  render: renderGraph<Args>({
    describe: (a) => `Large graph · ${a.layout} · ${DESCRIBE[a.layout]}`,
    load: (a) => loadMap(a.layout, a.nodes, a.seed),
    dataArgs: ["layout"],
    onLoad: (graph, g, a, root) => {
      showReadout(graph, root);
      if (a.edges && g.edges.count > 0) graph.edges.updateAll({ styles: randomStyles(g.edges.count, a.seed) });
    },
  }),
  argTypes: { layout: { control: "select", options: MAP_OPTIONS }, ...graphArgTypes<Args>(NODE_COUNTS) },
  args: { layout: "cosmic web", ...GRAPH_ARGS, nodes: 1_000_000, edgeColor: "nodes", edgeAlpha: 0.6 },
  parameters: { controls: { include: ["layout", "nodes", "seed", "labels"] } },
};

export default meta;

export const LargeGraph: StoryObj<Args> = { name: "Large graph" };
