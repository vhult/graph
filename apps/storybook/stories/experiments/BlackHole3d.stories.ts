import type { Meta, StoryObj } from "@storybook/html-vite";
import { blackHole3d, HOLE3D, HOLE3D_WGSL } from "../../src/blackhole3d";
import { cached } from "../../src/data";
import { GpuMotion } from "../../src/gpuMotion";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";

interface Args extends GraphArgs {
  speed: number;
  inclination: number;
  beaming: number;
  glow: boolean;
  depthOrder: boolean;
}

const SIZES = [300_000, 1_500_000, 3_000_000] as const;
const INCLINATION = 7;
const BEAMING = 12;
const GLOW = "drop-shadow(0 0 4px rgba(255, 232, 224, 0.95)) drop-shadow(0 0 24px rgba(255, 212, 198, 0.7)) drop-shadow(0 0 80px rgba(250, 185, 170, 0.36))";
let motion: GpuMotion | null = null;
let run = 0;
let frame: (() => void) | null = null;

const hole = (a: Args) => cached(`hole3d:${a.nodes}:${a.seed}`, () => blackHole3d(a.nodes, a.seed));

function stop(): void {
  run++;
  motion?.stop();
  motion = null;
  if (frame) removeEventListener("resize", frame);
  frame = null;
}

const meta: Meta<Args> = {
  title: "Experiments/Black hole 3D",
  render: renderGraph<Args>({
    describe: () =>
      "Black hole 3D · a thin disk on Keplerian orbits around a Schwarzschild black hole, each particle drawn as its direct image and the two thin rings of light that circle the hole, bent through a traced photon table, shifted by the gas motion and by gravity\nthe inner edge is pulled in to 4.5M, closer than a non-spinning hole allows, for the look of a fast-spinning one like Gargantua",
    options: () => ({ hoverStyle: false, transparent: true }),
    backdrop: "radial-gradient(ellipse 70% 80% at center, #34292a 0%, #241c1c 35%, #130f0f 70%, #0a0807 100%)",
    load: (a) => {
      const l = hole(a);
      return { data: l.data.graph, genMs: l.genMs };
    },
    onLoad: (graph, g, a, root) => {
      stop();
      const id = run;
      graph.setBackground([0, 0, 0, 0]);
      const canvas = root.querySelector("canvas");
      if (canvas) canvas.style.filter = a.glow ? GLOW : "";
      frame = () => graph.camera.setView({ x: 0, y: 0, rotation: 0, zoom: (Math.min(innerWidth, innerHeight) * devicePixelRatio) / (2 * HOLE3D.extent * HOLE3D.scale) });
      frame();
      addEventListener("resize", frame);
      const h = hole(a).data;
      void GpuMotion.start(graph, { count: g.nodes.count, data: h.data, params: h.params, wgsl: HOLE3D_WGSL, depth: true, colors: true }).then((m) => {
        if (id !== run) return m.stop();
        m.speed = a.speed;
        m.depthOn = a.depthOrder;
        m.setParam(INCLINATION, (a.inclination * Math.PI) / 180);
        m.setParam(BEAMING, a.beaming);
        motion = m;
      });
    },
    onUpdate: (_graph, a) => {
      const canvas = document.querySelector<HTMLCanvasElement>(".stage canvas");
      if (canvas) canvas.style.filter = a.glow ? GLOW : "";
      if (!motion) return;
      motion.speed = a.speed;
      motion.depthOn = a.depthOrder;
      motion.setParam(INCLINATION, (a.inclination * Math.PI) / 180);
      motion.setParam(BEAMING, a.beaming);
    },
    dispose: stop,
  }),
  argTypes: graphArgTypes<Args>(SIZES, {
    speed: { control: { type: "range", min: 0, max: 4, step: 0.1 } },
    inclination: { control: { type: "range", min: 45, max: 89, step: 1 } },
    beaming: { control: { type: "range", min: 0, max: 1, step: 0.05 } },
    glow: { control: "boolean" },
    depthOrder: { control: "boolean" },
  }),
  args: { nodes: 1_500_000, speed: 1, inclination: HOLE3D.inclination, beaming: HOLE3D.beaming, glow: true, depthOrder: true, ...GRAPH_ARGS, edges: false, lodTargetPx: 0 },
  parameters: { controls: { include: ["nodes", "speed", "inclination", "beaming", "glow", "depthOrder"] } },
};

export default meta;

export const BlackHole3d: StoryObj<Args> = { name: "Black hole 3D" };
