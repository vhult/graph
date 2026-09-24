/**
 * Benchmark harness. A fixed camera path is replayed one step per
 * rendered frame inside the render worker; per-frame GPU (total and per pass),
 * worker CPU, frame interval and visible counts are recorded there and returned
 * in one message. The main thread does nothing during a run.
 *
 * - Run: the dataset/count/path selected in Controls.
 * - Run suite: the benchmark datasets, with targets.
 * - Download JSON: summaries + raw series, to diff against later runs.
 *
 * For unquantized GPU timestamps in Chrome, enable
 * chrome://flags/#enable-webgpu-developer-features.
 */
import type { Meta, StoryObj } from "@storybook/html-vite";
import type { Graph } from "@vhult/graph";
import { PATHS, type PathName } from "@vhult/graph-bench";
import { BenchPanel } from "../../src/bench";
import { COUNT_OPTIONS, GRAPH_OPTIONS, setGraph, type GraphName } from "../../src/data";
import type { Hud } from "../../src/hud";
import { stage } from "../../src/stage";

interface Args {
  dataset: GraphName;
  count: number;
  path: PathName;
  /** 0 disables LOD; see docs/decisions.md 0022. */
  lodTargetPx: number;
  nodeLabels: boolean;
  edgeLabels: boolean;
}

/** Latest args, read by the panel when "Run" is clicked. */
let current: Args | null = null;

function load(graph: Graph, a: Args, hud: Hud): void {
  const { genMs } = setGraph(graph, a.dataset, a.count, { nodes: a.nodeLabels, edges: a.edgeLabels });
  hud.measureLoad(graph, genMs, a.count);
  graph.camera.fit();
  hud.setNote(`${a.dataset} · path ${a.path}`);
}

const meta: Meta<Args> = {
  title: "Developer/Benchmark",
  render: (args, ctx) =>
    stage(args, ctx, {
      // Changing this recreates the engine, so LOD on/off is a clean A/B.
      options: (a) => ({ lodTargetPx: a.lodTargetPx, controls: false }),
      setup: (graph, a, hud, root) => {
        current = a;
        load(graph, a, hud);
        new BenchPanel(root, graph, () => ({
          name: "custom",
          dataset: current!.dataset,
          count: current!.count,
          path: current!.path,
          nodeLabels: current!.nodeLabels,
          edgeLabels: current!.edgeLabels,
        }));
      },
      update: (graph, a, prev, hud) => {
        current = a;
        if (a.dataset !== prev.dataset || a.count !== prev.count || a.nodeLabels !== prev.nodeLabels || a.edgeLabels !== prev.edgeLabels) load(graph, a, hud);
        else if (a.path !== prev.path) hud.setNote(`${a.dataset} · path ${a.path}`);
      },
    }),
  argTypes: {
    dataset: { control: "select", options: GRAPH_OPTIONS },
    count: {
      control: "select",
      options: COUNT_OPTIONS,
      labels: Object.fromEntries(COUNT_OPTIONS.map((n) => [n, n.toLocaleString("en-US")])),
    },
    path: { control: "select", options: Object.keys(PATHS) as PathName[] },
    lodTargetPx: { control: { type: "number", min: 0, step: 0.5 } },
    nodeLabels: { control: "boolean" },
    edgeLabels: { control: "boolean" },
  },
  args: {
    dataset: "communities",
    count: 1_000_000,
    path: "standard",
    lodTargetPx: 2.5,
    nodeLabels: true,
    edgeLabels: true,
  },
};

export default meta;
type Story = StoryObj<Args>;

export const Benchmark: Story = {};
