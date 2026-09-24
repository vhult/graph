import type { Meta, StoryObj } from "@storybook/html-vite";
import { cached } from "../../src/data";
import { askToDownload, DOOM, DoomGame, screen } from "../../src/doom";
import { GRAPH_ARGS, graphArgTypes, renderGraph, type GraphArgs } from "../../src/graphStory";

let game: DoomGame | null = null;
let run = 0;

function stop(): void {
  run++;
  game?.stop();
  game = null;
}

const meta: Meta<GraphArgs> = {
  title: "Experiments/Doom",
  render: renderGraph<GraphArgs>({
    describe: () =>
      `Doom · one square node per pixel, colours streamed ${DOOM.rate} times a second\nclick the graph, then: arrows move · Ctrl fire · Space use · Enter / Esc menu · scroll to zoom`,
    options: () => ({ hoverStyle: false }),
    gate: (_graph, a, root) => askToDownload(root).then((ok) => (ok ? a : null)),
    load: () => cached("doom:screen", () => screen()),
    onLoad: (graph) => {
      stop();
      const id = run;
      graph.setBackground([0, 0, 0, 1]);
      void DoomGame.start(graph).then((g) => {
        if (id !== run) return g.stop();
        game = g;
      });
    },
    dispose: stop,
  }),
  argTypes: graphArgTypes<GraphArgs>([DOOM.width * DOOM.height]),
  args: { ...GRAPH_ARGS, nodes: DOOM.width * DOOM.height, edges: false, lodTargetPx: 0 },
  parameters: { controls: { include: [] } },
};

export default meta;

export const Doom: StoryObj<GraphArgs> = {};
