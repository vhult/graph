import type { Meta, StoryObj } from "@storybook/html-vite";
import type { Graph, GraphStats, LabelSnapshot } from "@vhult/graph";
import { GRAPH_OPTIONS, setGraph, type GraphName } from "../../src/data";
import { fitted } from "../../src/fitted";
import { stage } from "../../src/stage";

interface Args {
  dataset: GraphName;
  count: number;
}

interface Motion {
  name: string;
  zoom: number;
  frames: number;
  step: (t: number, fit: number) => { dx: number; zoom: number };
}

interface Row {
  name: string;
  seconds: number;
  solves: number;
  shown: number;
  added: number;
  removed: number;
  churnPerSolve: number;
  changesPerSecond: number;
  quality: number;
}

function quality(snap: LabelSnapshot): number {
  const n = snap.index.length;
  const edge = (k: number) => snap.index[k]! >= 0x80000000;
  const key = (k: number) => (edge(k) ? -1 / snap.size[k]! : snap.size[k]!);
  const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => key(b) - key(a) || snap.index[a]! - snap.index[b]!);
  const placed: number[] = [];
  let fresh = 0;
  let shown = 0;
  for (const k of order) {
    if (snap.decision[k] === 1 && !edge(k)) shown += snap.size[k]!;
    const x = snap.center[2 * k]!, y = snap.center[2 * k + 1]!, w = snap.halfWidth[k]!, h = snap.halfHeight[k]!;
    if (placed.some((j) => Math.abs(snap.center[2 * j]! - x) < snap.halfWidth[j]! + w && Math.abs(snap.center[2 * j + 1]! - y) < snap.halfHeight[j]! + h)) continue;
    placed.push(k);
    if (!edge(k)) fresh += snap.size[k]!;
  }
  return fresh > 0 ? shown / fresh : 1;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

const MOTIONS: Motion[] = [
  { name: "still", zoom: 4, frames: 120, step: () => ({ dx: 0, zoom: 1 }) },
  { name: "pan", zoom: 4, frames: 240, step: () => ({ dx: 1.5, zoom: 1 }) },
  { name: "zoom in", zoom: 1, frames: 240, step: () => ({ dx: 0, zoom: 1.006 }) },
  { name: "zoom out", zoom: 4, frames: 240, step: () => ({ dx: 0, zoom: 1 / 1.006 }) },
  { name: "pan + zoom", zoom: 2, frames: 240, step: (t) => ({ dx: 1, zoom: t < 120 ? 1.004 : 1 / 1.004 }) },
];

async function measure(graph: Graph, a: Args, report: (rows: Row[]) => void): Promise<Row[]> {
  setGraph(graph, a.dataset, a.count, { nodes: true, edges: true });
  await fitted(graph);
  const fit = graph.camera.getView();
  const rows: Row[] = [];
  const s0 = {} as GraphStats;
  const s1 = {} as GraphStats;
  for (const m of MOTIONS) {
    let view = { x: fit.x, y: fit.y, zoom: fit.zoom * m.zoom, rotation: 0 };
    graph.camera.setView(view);
    await sleep(800);
    graph.readStats(s0);
    const t0 = performance.now();
    for (let t = 0; t < m.frames; t++) {
      const s = m.step(t, fit.zoom);
      view = { ...view, x: view.x + s.dx / view.zoom, zoom: view.zoom * s.zoom };
      graph.camera.setView(view);
      await frame();
    }
    const seconds = (performance.now() - t0) / 1000;
    const q = quality(await graph.readLabelSnapshot());
    await sleep(400);
    graph.readStats(s1);
    const solves = s1.labelSolves - s0.labelSolves;
    const added = s1.labelsAdded - s0.labelsAdded;
    const removed = s1.labelsRemoved - s0.labelsRemoved;
    const shown = (s0.labelsShown + s1.labelsShown) / 2;
    rows.push({
      name: m.name,
      seconds,
      solves,
      shown,
      added,
      removed,
      churnPerSolve: (added + removed) / Math.max(1, solves) / Math.max(1, shown),
      changesPerSecond: (added + removed) / seconds,
      quality: q,
    });
    report(rows);
  }
  return rows;
}

function render(panel: HTMLElement, rows: Row[], done: boolean): void {
  const body = rows
    .map((r) => `<tr><td>${r.name}</td><td>${r.seconds.toFixed(1)}</td><td>${r.solves}</td><td>${r.shown.toFixed(0)}</td><td>${r.added}</td><td>${r.removed}</td><td>${(r.churnPerSolve * 100).toFixed(1)} %</td><td>${r.changesPerSecond.toFixed(0)}</td><td>${(r.quality * 100).toFixed(1)} %</td></tr>`)
    .join("");
  panel.innerHTML = `<div class="caption">Label flicker${done ? "" : " — running…"}</div><table><thead><tr><th>motion</th><th>s</th><th>solves</th><th>shown</th><th>added</th><th>removed</th><th>churn / solve</th><th>changes / s</th><th>size kept</th></tr></thead><tbody>${body}</tbody></table>`;
}

const meta: Meta<Args> = {
  title: "Developer/Label flicker",
  render: (args, ctx) =>
    stage(args, ctx, {
      options: () => ({ controls: false }),
      setup: async (graph, a, hud, root) => {
        const panel = document.createElement("div");
        panel.className = "bench-panel";
        root.append(panel);
        hud.setNote(`label flicker · ${a.dataset} · ${a.count.toLocaleString("en-US")} nodes`);
        const run = async () => {
          const rows = await measure(graph, a, (r) => render(panel, r, false));
          render(panel, rows, true);
          return rows;
        };
        (globalThis as { __labelFlicker?: unknown }).__labelFlicker = { result: run() };
      },
    }),
  argTypes: {
    dataset: { control: "select", options: GRAPH_OPTIONS },
    count: { control: "select", options: [10_000, 100_000, 1_000_000, 10_000_000] },
  },
  args: { dataset: "communities", count: 1_000_000 },
};

export default meta;
type Story = StoryObj<Args>;

export const LabelFlicker: Story = { name: "Label flicker" };
