/**
 * STRESS: the Communities graph at up to 25M nodes and ~70M edges: the memory
 * ceiling (buffer sizes, upload) and the cost of touching every edge's
 * endpoints each frame.
 *
 * Generation runs on the main thread and takes seconds at this size; the HUD
 * reports it separately from the engine's load time.
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import { communities } from "@vhult/graph-bench";
import { DangerZone, type DangerArgs } from "../../src/danger";
import { cached } from "../../src/data";
import { countControl, GRAPH_ARGS, graphArgTypes, renderGraph } from "../../src/graphStory";

type Args = DangerArgs;

const SIZES = [5_000_000, 10_000_000, 25_000_000] as const;

const danger = new DangerZone();

const meta: Meta<Args> = {
  title: "Stress/Scale",
  render: renderGraph<Args>({
    describe: (a) => `Scale · communities, ${a.neighbours} nearest neighbours${a.dangerZone ? " · danger zone" : ""}`,
    load: (a) => cached(`communities:${a.nodes}:${a.neighbours}:${a.seed}`, () => communities(a.nodes, a.neighbours, a.seed)),
    dataArgs: ["neighbours", "dangerZone", "vramGB"],
    gate: (graph, a, root) => danger.gate(graph, a, root),
    onLoad: (graph, g, a) => danger.loaded(graph, g, a),
  }),
  argTypes: graphArgTypes<Args>(SIZES, {
    nodes: { ...countControl(SIZES), if: { arg: "dangerZone", truthy: false } },
    neighbours: { control: { type: "range", min: 1, max: 4, step: 1 } },
    dangerZone: { control: "boolean" },
    vramGB: { control: { type: "range", min: 2, max: 32, step: 1 }, if: { arg: "dangerZone" } },
  }),
  args: { nodes: 10_000_000, neighbours: 2, dangerZone: false, vramGB: 8, ...GRAPH_ARGS, edgeAlpha: 0.25 },
  parameters: { controls: { include: ["nodes", "neighbours", "dangerZone", "vramGB"] } },
};

export default meta;

export const Scale: StoryObj<Args> = {};
