import type { Meta, StoryObj } from "@storybook/html-vite";
import { cached } from "../../src/data";
import { galaxy, GALAXY_PARAMS, GALAXY_WGSL } from "../../src/galaxy";
import { GpuMotion } from "../../src/gpuMotion";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";

interface Args extends GraphArgs {
  speed: number;
}

const SIZES = [100_000, 1_000_000, 2_000_000] as const;
let motion: GpuMotion | null = null;
let run = 0;

const stars = (a: Args) => cached(`galaxy:${a.nodes}:${a.seed}`, () => galaxy(a.nodes, a.seed));

function load(a: Args) {
  const l = stars(a);
  return { data: l.data.graph, genMs: l.genMs };
}

function stop(): void {
  run++;
  motion?.stop();
  motion = null;
}

const meta: Meta<Args> = {
  title: "Experiments/Galaxy",
  render: renderGraph<Args>({
    describe: () => "Galaxy · stars on density-wave orbits, positions computed on the GPU and streamed",
    load,
    options: () => ({ nodeDrag: false }),
    onLoad: (graph, g, a) => {
      stop();
      const id = run;
      graph.setBackground([0, 0, 0.012, 1]);
      const orbits = stars(a).data.orbits;
      void GpuMotion.start(graph, { count: g.nodes.count, data: orbits, params: GALAXY_PARAMS, wgsl: GALAXY_WGSL }).then((m) => {
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
  argTypes: graphArgTypes<Args>(SIZES, { speed: { control: { type: "range", min: 0, max: 4, step: 0.1 } } }),
  args: { nodes: 1_000_000, speed: 1, ...GRAPH_ARGS, edges: false, lodTargetPx: 0 },
  parameters: { controls: { include: ["nodes", "speed"] } },
};

export default meta;

export const Galaxy: StoryObj<Args> = {};
