import type { ArgTypes, Meta, StoryObj } from "@storybook/html-vite";
import type { RGBA } from "@vhult/graph";
import { cached, LAYOUT_OPTIONS, loadLayout, NODE_COUNTS, type LayoutName } from "../../src/data";
import { EDGE_DIRECTED, GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";
import { showReadout } from "../../src/readout";

interface Args extends GraphArgs {
  layout: LayoutName;
  edgeLabels: boolean;
  directed: boolean;
  labelSize: number;
  labelPadding: number;
  nodeDrag: boolean;
  pickRate: number;
  pickRadius: number;
  edgePickRadius: number;
  hover: boolean;
  hoverNodeScale: number;
  hoverEdgeWidth: number;
  pixelRatio: number;
  background: string;
}

const CATEGORY: Record<string, string> = {
  layout: "Data",
  nodes: "Data",
  seed: "Data",
  edges: "Data",
  edgeColor: "Data",
  labels: "Data",
  edgeLabels: "Data",
  nodeScale: "Nodes",
  lodTargetPx: "Nodes",
  edgeWidth: "Edges",
  edgeAlpha: "Edges",
  edgeMaxOverdraw: "Edges",
  edgeMinLengthPx: "Edges",
  directed: "Edges",
  edgeDebug: "Edges",
  labelSize: "Labels",
  labelPadding: "Labels",
  nodeDrag: "Interaction",
  pickRate: "Interaction",
  pickRadius: "Interaction",
  edgePickRadius: "Interaction",
  hover: "Interaction",
  hoverNodeScale: "Interaction",
  hoverEdgeWidth: "Interaction",
  pixelRatio: "Engine",
  background: "Engine",
};

const range = (min: number, max: number, step: number) => ({ control: { type: "range", min, max, step } }) as const;

const own: Partial<ArgTypes<Args>> = {
  layout: { control: "select", options: LAYOUT_OPTIONS },
  edgeLabels: { control: "boolean" },
  directed: { control: "boolean" },
  labelSize: range(6, 32, 1),
  labelPadding: range(0, 16, 1),
  nodeDrag: { control: "boolean" },
  pickRate: range(1, 240, 1),
  pickRadius: range(0, 16, 0.5),
  edgePickRadius: range(0, 16, 0.5),
  hover: { control: "boolean" },
  hoverNodeScale: { ...range(0.5, 3, 0.05), if: { arg: "hover" } },
  hoverEdgeWidth: { ...range(0.5, 6, 0.25), if: { arg: "hover" } },
  pixelRatio: range(0.5, 3, 0.25),
  background: { control: "color" },
};

function categorized(types: Partial<ArgTypes<Args>>): Partial<ArgTypes<Args>> {
  const out: Record<string, object> = {};
  for (const [name, type] of Object.entries(types)) out[name] = { ...type, table: { category: CATEGORY[name] ?? "Data" } };
  return out as Partial<ArgTypes<Args>>;
}

function toRgba(color: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const v = parseInt(hex[1]!, 16);
    return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255, 1];
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(color);
  if (rgb) {
    const [r = 0, g = 0, b = 0, a = 1] = rgb[1]!.split(",").map((s) => parseFloat(s));
    return [r / 255, g / 255, b / 255, a];
  }
  return [0.04, 0.04, 0.06, 1];
}

const numbered = (count: number, prefix: string) => cached(`text:${prefix}:${count}`, () => Array.from({ length: count }, (_, i) => `${prefix}${i}`)).data;

function edgeText(a: Args): string[] {
  if (!a.labels || !a.edgeLabels || !a.edges) return [];
  return numbered(loadLayout(a.layout, a.nodes, a.seed).data.edges.count, "e");
}

const meta: Meta<Args> = {
  title: "Developer/Sandbox",
  render: renderGraph<Args>({
    describe: (a) => `Sandbox · ${a.layout}`,
    load: (a) => loadLayout(a.layout, a.nodes, a.seed),
    dataArgs: ["layout"],
    options: (a) => ({
      directedEdges: a.directed,
      labelSize: a.labelSize,
      labelPadding: a.labelPadding,
      pickRate: a.pickRate,
      pickRadius: a.pickRadius,
      edgePickRadius: a.edgePickRadius,
      hoverStyle: a.hover ? { nodeScale: a.hoverNodeScale, edgeWidth: a.hoverEdgeWidth } : false,
      pixelRatio: a.pixelRatio,
      background: toRgba(a.background),
    }),
    edgeStyle: (a) => (a.directed ? EDGE_DIRECTED : undefined),
    labels: (g, a) => ({ nodes: numbered(g.nodes.count, "#"), edges: edgeText(a) }),
    onLoad: (graph, _g, a, root) => {
      graph.setNodeDrag(a.nodeDrag);
      showReadout(graph, root);
    },
    onUpdate: (graph, a, prev) => {
      if (a.nodeDrag !== prev.nodeDrag) graph.setNodeDrag(a.nodeDrag);
      if (a.edgeLabels !== prev.edgeLabels) graph.setEdgeLabels(edgeText(a));
    },
  }),
  argTypes: categorized({ layout: own.layout, ...graphArgTypes<Args>(NODE_COUNTS, own) }),
  args: {
    layout: "communities",
    nodes: 100_000,
    ...GRAPH_ARGS,
    edgeLabels: false,
    directed: false,
    labelSize: 12,
    labelPadding: 2,
    nodeDrag: true,
    pickRate: 60,
    pickRadius: 0,
    edgePickRadius: 4,
    hover: true,
    hoverNodeScale: 1.25,
    hoverEdgeWidth: 2,
    pixelRatio: globalThis.devicePixelRatio ?? 1,
    background: "#0a0a0f",
  },
};

export default meta;

export const Sandbox: StoryObj<Args> = {};
