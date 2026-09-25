import type { Meta, StoryObj } from "@storybook/html-vite";
import { NO_ICON, NodeShape } from "@vhult/graph";
import { hslToWord, PALETTE, rgbToWord } from "@vhult/graph-bench";
import { EDGE_DIRECTED } from "../../src/graphStory";
import { DEMO_ICON_LIST, DEMO_ICON_NAMES, iconId, type DemoIcon } from "../../src/icons";
import { showReadout } from "../../src/readout";
import { stage } from "../../src/stage";

interface Node {
  x: number;
  y: number;
  size: number;
  color: number;
  shape: number;
  icon: DemoIcon | null;
  tint: number;
  z: number;
  label: string;
}

const WHITE = 0xffffffff;
const SIZES = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 160];
const ALPHAS = [1, 0.75, 0.5, 0.25];
const STACK = 10;
const TINTS = 8;

function layout(): { nodes: Node[]; edges: number[] } {
  const nodes: Node[] = [];
  const edges: number[] = [];
  const row = (build: () => void) => {
    const first = nodes.length;
    build();
    for (let i = first + 1; i < nodes.length; i++) edges.push(i - 1, i);
  };
  const add = (n: Partial<Node> & Pick<Node, "x" | "y" | "label">) =>
    nodes.push({ size: 30, color: rgbToWord(PALETTE[0]!), shape: NodeShape.circle, icon: null, tint: WHITE, z: 0, ...n });

  row(() => {
    PALETTE.forEach((rgb, k) => add({ x: k * 50, y: 0, color: rgbToWord(rgb), label: `#${rgb.toString(16).padStart(6, "0")}` }));
    ALPHAS.forEach((a, k) => add({ x: 560 + k * 50, y: 0, color: rgbToWord(PALETTE[1]!, a), label: `alpha ${a}` }));
  });

  row(() => {
    let x = 0;
    SIZES.forEach((size, k) => {
      x += (k === 0 ? 0 : SIZES[k - 1]! / 2 + 12) + size / 2;
      add({ x, y: 170, size, icon: "gear", label: `${size}` });
    });
  });

  row(() => {
    const shapes = Object.entries(NodeShape);
    shapes.forEach(([name, shape], k) => add({ x: k * 60, y: 330, shape, color: rgbToWord(PALETTE[3]!), label: name }));
    shapes.forEach(([name, shape], k) => add({ x: 200 + k * 60, y: 330, shape, icon: "person", color: rgbToWord(PALETTE[2]!), label: `${name} + icon` }));
  });

  row(() => {
    for (let k = 0; k < STACK; k++) {
      add({ x: k * 20, y: 430, size: 40, z: k, icon: DEMO_ICON_NAMES[k % DEMO_ICON_NAMES.length]!, color: rgbToWord(PALETTE[k % PALETTE.length]!), label: `z ${k}` });
    }
  });

  row(() => {
    DEMO_ICON_NAMES.forEach((icon, k) => add({ x: k * 60, y: 530, size: 40, icon, color: rgbToWord(PALETTE[(k + 1) % PALETTE.length]!), label: icon }));
  });

  row(() => {
    for (let k = 0; k < TINTS; k++) add({ x: k * 60, y: 610, size: 40, icon: "star", color: rgbToWord(0x2a3140), tint: hslToWord(k / TINTS, 0.85, 0.65), label: `tint ${k}` });
  });

  return { nodes, edges };
}

const { nodes: NODES, edges: EDGES } = layout();
const NAMES = NODES.map((n) => n.label);

const meta: Meta = {
  title: "Nodes/Styles",
  render: (args, ctx) =>
    stage(args, ctx, {
      options: () => ({ directedEdges: true, edgeWidth: 1.5, edgeColor: [0.6, 0.7, 0.9, 0.8] }),
      setup: async (graph, _a, hud, root) => {
        const n = NODES.length;
        const positions = new Float32Array(n * 2);
        const colors = new Uint32Array(n);
        const sizes = new Float32Array(n);
        const shapes = new Uint8Array(n);
        const zIndex = new Uint8Array(n);
        const icons = new Uint16Array(n);
        const iconColors = new Uint32Array(n);
        NODES.forEach((node, i) => {
          positions[i * 2] = node.x;
          positions[i * 2 + 1] = node.y;
          colors[i] = node.color;
          sizes[i] = node.size;
          shapes[i] = node.shape;
          zIndex[i] = node.z;
          icons[i] = node.icon ? iconId(node.icon) : NO_ICON;
          iconColors[i] = node.tint;
        });
        const count = EDGES.length / 2;
        graph.setNodes({ count: n, positions, colors, sizes, shapes, zIndex, icons, iconColors });
        graph.setEdges({ count, indices: new Uint32Array(EDGES), styles: new Uint32Array(count).fill(EDGE_DIRECTED) });
        graph.setNodeLabels(NAMES);
        graph.camera.fit();
        showReadout(graph, root, { node: (i) => `${NAMES[i]} (#${i})`, edge: (e) => `${NAMES[EDGES[e * 2]!]} → ${NAMES[EDGES[e * 2 + 1]!]} (#${e})` });
        hud.setNote(
          "Node styles · colours and alpha · one icon from 2 to 160 world units: zoom in to see it fade in, then turn exact above 96 px\n" +
            "shapes, plain and with an icon, with arrowheads stopping at their edge · z-index 0 to 9, each covering the one on its left\n" +
            "every demo icon (path data and SVG markup; the pentagram even-odd, then nonzero) · per-node icon tints",
        );
        await graph.defineIcons(DEMO_ICON_LIST).catch((e: unknown) => hud.setNote(`defineIcons failed: ${e instanceof Error ? e.message : String(e)}`));
      },
    }),
};

export default meta;

export const Styles: StoryObj = {};
