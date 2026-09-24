import type { Meta, StoryObj } from "@storybook/html-vite";
import { blackHole, HOLE, holeParams, HOLE_WGSL } from "../../src/blackhole";
import { cached } from "../../src/data";
import { GpuMotion } from "../../src/gpuMotion";
import { countControl, GRAPH_ARGS, renderGraph, type GraphArgs } from "../../src/graphStory";

interface Args extends GraphArgs {
  speed: number;
}

const SIZES = [250_000, 1_000_000, 2_000_000, 5_000_000] as const;
let motion: GpuMotion | null = null;
let run = 0;
let frame: (() => void) | null = null;

const hole = (a: Args) => cached(`blackhole:${a.nodes}:${a.seed}`, () => blackHole(a.nodes, HOLE.tilt, a.seed));

function stop(): void {
  run++;
  motion?.stop();
  motion = null;
  if (frame) removeEventListener("resize", frame);
  frame = null;
}

const meta: Meta<Args> = {
  title: "Experiments/Black hole",
  render: renderGraph<Args>({
    describe: () => "Black hole · lensed accretion disk, positions computed on the GPU and streamed",
    options: () => ({ controls: false, transparent: true }),
    backdrop: "radial-gradient(ellipse at center, #5a4744 0%, #33282a 22%, #1a1517 48%, #0b090a 80%)",
    load: (a) => {
      const l = hole(a);
      return { data: l.data.graph, genMs: l.genMs };
    },
    onLoad: (graph, g, a) => {
      stop();
      const id = run;
      graph.setBackground([0, 0, 0, 0]);
      frame = () => graph.camera.setView({ x: 0, y: 0, rotation: 0, zoom: (innerWidth * devicePixelRatio) / (2 * HOLE.frame * HOLE.scale) });
      frame();
      addEventListener("resize", frame);
      const h = hole(a).data;
      void GpuMotion.start(graph, { count: g.nodes.count, data: h.data, params: holeParams(HOLE.tilt, h.tableOffset), wgsl: HOLE_WGSL }).then((m) => {
        if (id !== run) return m.stop();
        m.speed = a.speed;
        motion = m;
      });
    },
    onUpdate: (_graph, a) => {
      if (motion) motion.speed = a.speed;
    },
    dispose: stop,
  }),
  argTypes: {
    nodes: countControl(SIZES),
    speed: { control: { type: "range", min: 0, max: 4, step: 0.1 } },
  },
  args: { ...GRAPH_ARGS, nodes: 1_000_000, speed: 0.1, edges: false, lodTargetPx: 0 },
  parameters: { controls: { include: ["nodes", "speed"] } },
};

export default meta;

export const BlackHole: StoryObj<Args> = { name: "Black hole" };
