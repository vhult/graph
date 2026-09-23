import type { Meta, StoryObj } from "@storybook/html-vite";
import { blackHole, HOLE, holeParams, HOLE_WGSL } from "../../src/blackhole";
import { cached } from "../../src/data";
import { GpuMotion } from "../../src/gpuMotion";
import { countControl, GRAPH_ARGS, renderGraph, type GraphArgs } from "../../src/graphStory";

interface Args extends GraphArgs {
  speed: number;
  tilt: number;
}

const SIZES = [250_000, 1_000_000] as const;
let motion: GpuMotion | null = null;
let run = 0;

const hole = (a: Args) => cached(`blackhole:${a.nodes}:${a.seed}`, () => blackHole(a.nodes, a.tilt, a.seed));

function stop(): void {
  run++;
  motion?.stop();
  motion = null;
}

const meta: Meta<Args> = {
  title: "Demos/Black hole",
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
      graph.camera.setView({ x: 0, y: 0, rotation: 0, zoom: (innerWidth * devicePixelRatio) / (2 * HOLE.frame * HOLE.scale) });
      const h = hole(a).data;
      void GpuMotion.start(graph, { count: g.nodes.count, data: h.data, params: holeParams(a.tilt, h.tableOffset), wgsl: HOLE_WGSL }).then((m) => {
        if (id !== run) return m.stop();
        m.speed = a.speed;
        motion = m;
      });
    },
    onUpdate: (_graph, a, prev) => {
      if (!motion) return;
      motion.speed = a.speed;
      if (a.tilt !== prev.tilt) motion.setParam(0, (a.tilt * Math.PI) / 180);
    },
    dispose: stop,
  }),
  argTypes: {
    nodes: countControl(SIZES),
    speed: { control: { type: "range", min: 0, max: 4, step: 0.1 } },
    tilt: { control: { type: "range", min: 80, max: 90, step: 0.25 } },
    seed: { control: { type: "number", min: 1, step: 1 } },
    nodeScale: { control: { type: "range", min: 0.1, max: 4, step: 0.1 } },
    lodTargetPx: { control: { type: "range", min: 0, max: 8, step: 0.5 } },
  },
  args: { ...GRAPH_ARGS, nodes: 1_000_000, speed: 1, tilt: 89, edges: false, lodTargetPx: 0 },
  parameters: { controls: { include: ["nodes", "speed", "tilt", "seed", "nodeScale", "lodTargetPx"] } },
};

export default meta;

export const BlackHole: StoryObj<Args> = { name: "Black hole" };
