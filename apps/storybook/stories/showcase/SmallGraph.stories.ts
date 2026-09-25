/**
 * A small graph built by hand to look good up close: a hub, six groups around
 * it, each a head with its members fanned outward. Few enough nodes to see
 * every shape, border, gradient and arrowhead — the place to judge how things
 * LOOK. The other stories are where to judge speed.
 *
 * What to check:
 *   - Edges meet nodes cleanly; with `directed`, arrowheads touch the target's rim.
 *   - Node sizes, colours and edge gradients read well at every zoom.
 *   - Labels: every node named, relations along the edges where they fit.
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import { NO_ICON, NodeShape, type Graph } from "@vhult/graph";
import { PALETTE, rgbToWord, type GraphDataset } from "@vhult/graph-bench";
import { EDGE_DIRECTED, GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs, type GraphLabels } from "../../src/graphStory";
import { DEMO_ICON_LIST, iconId, type DemoIcon } from "../../src/icons";
import { showReadout } from "../../src/readout";

interface Args extends GraphArgs {
  directed: boolean;
  icons: boolean;
}

const GROUPS = 6;
const MEMBERS = 5;
const NODES = 1 + GROUPS * (1 + MEMBERS);
/** World units: hub to heads, head to members. */
const HEAD_RADIUS = 110;
const MEMBER_RADIUS = 40;
/** Angle a group's members fan across, radians. */
const FAN = 2.2;
const GROUP_NAMES = ["Design", "Research", "Engineering", "Sales", "Support", "Operations"];
const GROUP_ICONS: readonly DemoIcon[] = ["pen", "flask", "gear", "chart", "chat", "bolt"];
const PEOPLE = ["Ada", "Ben", "Cleo", "Dev", "Eli", "Fay", "Gus", "Hana", "Ivo", "June", "Kai", "Lena", "Milo", "Nina", "Otto"];

function smallGraph(): { graph: GraphDataset; labels: GraphLabels; icons: Uint16Array; iconColors: Uint32Array } {
  const positions = new Float32Array(NODES * 2);
  const colors = new Uint32Array(NODES);
  const sizes = new Float32Array(NODES);
  const shapes = new Uint8Array(NODES);
  const icons = new Uint16Array(NODES);
  const iconColors = new Uint32Array(NODES).fill(0xffffffff);
  const put = (i: number, x: number, y: number, size: number, rgb: number, shape: NodeShape, icon: DemoIcon) => {
    positions[i * 2] = x;
    positions[i * 2 + 1] = y;
    sizes[i] = size;
    colors[i] = rgbToWord(rgb);
    shapes[i] = shape;
    icons[i] = iconId(icon);
  };
  const headOf = (g: number) => 1 + (g % GROUPS) * (1 + MEMBERS);

  const pairs: number[] = [];
  const nodeNames: string[] = ["Company"];
  const edgeNames: string[] = [];
  const link = (a: number, b: number, name: string) => {
    pairs.push(a, b);
    edgeNames.push(name);
  };
  put(0, 0, 0, 18, 0xf2f4f8, NodeShape.hexagon, "building");
  iconColors[0] = rgbToWord(0x1b2230);
  for (let g = 0; g < GROUPS; g++) {
    const a = (g / GROUPS) * Math.PI * 2;
    const head = headOf(g);
    const hx = Math.cos(a) * HEAD_RADIUS;
    const hy = Math.sin(a) * HEAD_RADIUS;
    const rgb = PALETTE[g % PALETTE.length]!;
    put(head, hx, hy, 10, rgb, NodeShape.square, GROUP_ICONS[g % GROUP_ICONS.length]!);
    nodeNames[head] = GROUP_NAMES[g % GROUP_NAMES.length]!;
    link(0, head, "runs");
    link(head, headOf(g + 1), "works with"); // ring of heads
    for (let m = 0; m < MEMBERS; m++) {
      const b = a + (m / (MEMBERS - 1) - 0.5) * FAN;
      const member = head + 1 + m;
      put(member, hx + Math.cos(b) * MEMBER_RADIUS, hy + Math.sin(b) * MEMBER_RADIUS, 5 + (m % 3), rgb, NodeShape.circle, "person");
      nodeNames[member] = `${PEOPLE[(g * MEMBERS + m) % PEOPLE.length]} ${String.fromCharCode(65 + g)}.`;
      link(head, member, "has");
      if (m > 0) link(member - 1, member, "pairs with"); // members of a group know each other
    }
    link(head + MEMBERS, headOf(g + 1) + 1, "helps"); // neighbouring groups touch at their edges
  }
  return {
    graph: {
      nodes: { count: NODES, positions, colors, sizes, shapes },
      edges: { count: pairs.length / 2, indices: new Uint32Array(pairs) },
    },
    labels: { nodes: nodeNames, edges: edgeNames },
    icons,
    iconColors,
  };
}

const DEMO = smallGraph();
const names = DEMO.labels.nodes ?? [];
const relations = DEMO.labels.edges ?? [];
const ends = DEMO.graph.edges.indices;
const NO_ICONS = new Uint16Array(NODES).fill(NO_ICON);
const defined = new WeakSet<Graph>();

function showIcons(graph: Graph, on: boolean): void {
  if (!defined.has(graph)) {
    defined.add(graph);
    graph.defineIcons(DEMO_ICON_LIST).catch((e: unknown) => console.error(e));
  }
  graph.updateNodes(0, { icons: on ? DEMO.icons : NO_ICONS, iconColors: DEMO.iconColors }, { copy: true });
}

const meta: Meta<Args> = {
  title: "Showcase/Small graph",
  render: renderGraph<Args>({
    describe: (a) => `Small graph · a hub and ${GROUPS} groups${a.directed ? ", directed" : ""}`,
    load: () => ({ data: DEMO.graph, genMs: 0 }),
    labels: () => DEMO.labels,
    // Arrowheads are compiled into the edge shader, so this is an engine option.
    options: (a) => ({ directedEdges: a.directed }),
    edgeStyle: (a) => (a.directed ? EDGE_DIRECTED : undefined),
    onLoad: (graph, _g, a, root) => {
      showIcons(graph, a.icons);
      showReadout(graph, root, {
        node: (i) => `${names[i]} (#${i})`,
        edge: (e) => `${names[ends[e * 2]!]} → ${names[ends[e * 2 + 1]!]} · ${relations[e]} (#${e})`,
      });
    },
    onUpdate: (graph, a, prev) => {
      if (a.icons !== prev.icons) showIcons(graph, a.icons);
    },
  }),
  argTypes: graphArgTypes<Args>([NODES], { directed: { control: "boolean" }, icons: { control: "boolean" } }),
  args: { nodes: NODES, directed: true, icons: true, ...GRAPH_ARGS, edgeColor: "nodes", edgeWidth: 1.5, edgeAlpha: 0.8, labels: true },
  parameters: { controls: { include: ["directed", "icons"] } },
};

export default meta;

export const SmallGraph: StoryObj<Args> = { name: "Small graph" };
