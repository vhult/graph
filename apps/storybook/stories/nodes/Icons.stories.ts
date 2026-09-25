import type { Meta, StoryObj } from "@storybook/html-vite";
import { NodeShape } from "@vhult/graph";
import { hslToWord, PALETTE, rgbToWord } from "@vhult/graph-bench";
import { DEMO_ICON_LIST, DEMO_ICON_NAMES, iconId, type DemoIcon } from "../../src/icons";
import { stage, toggles } from "../../src/stage";

interface Node {
  x: number;
  y: number;
  size: number;
  color: number;
  shape: number;
  icon: DemoIcon;
  tint: number;
  z: number;
  label: string;
}

const WHITE = 0xffffffff;
const SIZES = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 160];
const TINTS = 8;
const OVERLAP = 6;

function layout(): Node[] {
  const nodes: Node[] = [];
  const add = (n: Partial<Node> & Pick<Node, "x" | "y" | "icon" | "label">) =>
    nodes.push({ size: 40, color: rgbToWord(PALETTE[0]!), shape: NodeShape.circle, tint: WHITE, z: 0, ...n });

  let x = 0;
  SIZES.forEach((size, k) => {
    x += (k === 0 ? 0 : SIZES[k - 1]! / 2 + 12) + size / 2;
    add({ x, y: 0, size, icon: "gear", label: `${size}` });
  });

  DEMO_ICON_NAMES.forEach((icon, k) => add({ x: k * 60, y: 170, icon, color: rgbToWord(PALETTE[(k + 1) % PALETTE.length]!), label: icon }));

  Object.entries(NodeShape).forEach(([name, shape], k) => add({ x: k * 60, y: 250, shape, icon: "person", color: rgbToWord(PALETTE[3]!), label: name }));

  for (let k = 0; k < TINTS; k++) add({ x: 240 + k * 60, y: 250, icon: "star", color: rgbToWord(0x2a3140), tint: hslToWord(k / TINTS, 0.85, 0.65), label: `tint ${k}` });

  for (let k = 0; k < OVERLAP; k++) {
    add({ x: k * 22, y: 330, icon: DEMO_ICON_NAMES[k % DEMO_ICON_NAMES.length]!, color: rgbToWord(PALETTE[(k + 4) % PALETTE.length]!), z: k, label: `z ${k}` });
  }
  return nodes;
}

const NODES = layout();

const meta: Meta = {
  title: "Nodes/Icons",
  render: (args, ctx) =>
    stage({ ...args, labels: toggles(ctx).labels }, ctx, {
      setup: async (graph, a, hud) => {
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
          icons[i] = iconId(node.icon);
          iconColors[i] = node.tint;
        });
        graph.setNodes({ count: n, positions, colors, sizes, shapes, zIndex, icons, iconColors });
        graph.setEdges({ count: 0, indices: new Uint32Array(0) });
        graph.setNodeLabels(a.labels ? NODES.map((node) => node.label) : []);
        graph.camera.fit();
        hud.setNote(
          "Icons · top: one icon from 2 to 160 world units; zoom in to see it fade in, then turn exact above 96 px\n" +
            "middle: every demo icon (path data and SVG markup; the pentagram even-odd, then nonzero)\n" +
            "bottom: node shapes, per-node tints, and overlapping nodes with z-index",
        );
        await graph.defineIcons(DEMO_ICON_LIST).catch((e: unknown) => hud.setNote(`defineIcons failed: ${e instanceof Error ? e.message : String(e)}`));
      },
      update: (graph, a, prev) => {
        if (a.labels !== prev.labels) graph.setNodeLabels(a.labels ? NODES.map((node) => node.label) : []);
      },
    }),
};

export default meta;

export const Icons: StoryObj = {};
