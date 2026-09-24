import type { Meta, StoryObj } from "@storybook/html-vite";
import { cached } from "../../src/data";
import { GpuMotion } from "../../src/gpuMotion";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";
import { LORENZ, lorenz, LORENZ_WGSL } from "../../src/lorenz";

interface Args extends GraphArgs {
  speed: number;
  depthOrder: boolean;
}

const SIZES = [250_000, 1_000_000, 2_000_000] as const;
let motion: GpuMotion | null = null;
let run = 0;
let frame: (() => void) | null = null;

const attractor = (a: Args) => cached(`lorenz:${a.nodes}:${a.seed}`, () => lorenz(a.nodes, a.seed));

function stop(): void {
  run++;
  motion?.stop();
  motion = null;
  if (frame) removeEventListener("resize", frame);
  frame = null;
}

const meta: Meta<Args> = {
  title: "Experiments/Lorenz",
  render: renderGraph<Args>({
    describe: () => "Lorenz · points flowing along the attractor as it turns in 3D, depth streamed as z-index every frame",
    options: () => ({ hoverStyle: false }),
    load: (a) => {
      const l = attractor(a);
      return { data: l.data.graph, genMs: l.genMs };
    },
    onLoad: (graph, g, a) => {
      stop();
      const id = run;
      graph.setBackground([0.01, 0.005, 0.03, 1]);
      frame = () => graph.camera.setView({ x: 0, y: 0, rotation: 0, zoom: (Math.min(innerWidth, innerHeight) * devicePixelRatio) / (2 * LORENZ.extent * LORENZ.scale) });
      frame();
      addEventListener("resize", frame);
      const l = attractor(a).data;
      void GpuMotion.start(graph, { count: g.nodes.count, data: l.data, params: l.params, wgsl: LORENZ_WGSL, depth: true, colors: true }).then((m) => {
        if (id !== run) return m.stop();
        m.speed = a.speed;
        m.depthOn = a.depthOrder;
        motion = m;
      });
    },
    onUpdate: (_graph, a) => {
      if (!motion) return;
      motion.speed = a.speed;
      motion.depthOn = a.depthOrder;
    },
    dispose: stop,
  }),
  argTypes: graphArgTypes<Args>(SIZES, {
    speed: { control: { type: "range", min: 0, max: 4, step: 0.1 } },
    depthOrder: { control: "boolean" },
  }),
  args: { nodes: 1_000_000, speed: 1, depthOrder: true, ...GRAPH_ARGS, edges: false, lodTargetPx: 0 },
  parameters: { controls: { include: ["nodes", "speed", "depthOrder"] } },
};

export default meta;

export const Lorenz: StoryObj<Args> = {};
