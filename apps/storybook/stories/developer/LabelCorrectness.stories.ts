import type { Meta, StoryObj } from "@storybook/html-vite";
import type { Graph, LabelSnapshot } from "@vhult/graph";
import { GRAPH_OPTIONS, setGraph, type GraphName } from "../../src/data";
import { fitted } from "../../src/fitted";
import { stage } from "../../src/stage";

interface Args {
  dataset: GraphName;
  count: number;
  edgeLabels: boolean;
}

interface Check {
  name: string;
  candidates: number;
  shown: number;
  edges: number;
  overlaps: number;
  differences: number;
  undecided: number;
  overflow: boolean;
  pass: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 500;
const SHOWN = 1;
const UNDECIDED = 0;

function spatial(snap: LabelSnapshot) {
  let maxHalf = 0;
  let maxHalfH = 0;
  for (const h of snap.halfWidth) maxHalf = Math.max(maxHalf, h);
  for (const h of snap.halfHeight) maxHalfH = Math.max(maxHalfH, h);
  const cw = Math.max(1, 2 * maxHalf);
  const ch = Math.max(1, 2 * maxHalfH);
  const cells = new Map<number, number[]>();
  const key = (x: number, y: number) => Math.floor(y / ch) * 1_000_003 + Math.floor(x / cw);
  const overlaps = (a: number, b: number) =>
    Math.abs(snap.center[2 * a]! - snap.center[2 * b]!) < snap.halfWidth[a]! + snap.halfWidth[b]! &&
    Math.abs(snap.center[2 * a + 1]! - snap.center[2 * b + 1]!) < snap.halfHeight[a]! + snap.halfHeight[b]!;
  const hits = (k: number) => {
    const x = snap.center[2 * k]!, y = snap.center[2 * k + 1]!;
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) for (const j of cells.get(key(x + dx * cw, y + dy * ch)) ?? []) if (overlaps(j, k)) out.push(j);
    return out;
  };
  const add = (k: number) => {
    const kk = key(snap.center[2 * k]!, snap.center[2 * k + 1]!);
    let l = cells.get(kk);
    if (!l) cells.set(kk, (l = []));
    l.push(k);
  };
  return { hits, add };
}

function verify(name: string, snap: LabelSnapshot): Check {
  const n = snap.index.length;
  const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => snap.rank[b]! - snap.rank[a]! || snap.index[a]! - snap.index[b]!);
  const cpu = new Uint8Array(n);
  const greedy = spatial(snap);
  for (const k of order) {
    if (greedy.hits(k).length > 0) continue;
    cpu[k] = 1;
    greedy.add(k);
  }
  const shownGrid = spatial(snap);
  let shown = 0, edges = 0, overlaps = 0, differences = 0, undecided = 0;
  for (let k = 0; k < n; k++) {
    const gpu = snap.decision[k] === SHOWN;
    if (snap.decision[k] === UNDECIDED) undecided++;
    if (gpu !== (cpu[k] === 1)) differences++;
    if (!gpu) continue;
    shown++;
    if (snap.index[k]! >= 0x80000000) edges++;
    overlaps += shownGrid.hits(k).length;
    shownGrid.add(k);
  }
  const overflow = snap.found > snap.capacity;
  return { name, candidates: n, shown, edges, overlaps, differences, undecided, overflow, pass: n > 0 && !overflow && overlaps === 0 && (differences === 0 || undecided > 0) };
}

async function runChecks(graph: Graph, a: Args, report: (c: Check[]) => void): Promise<Check[]> {
  const data = setGraph(graph, a.dataset, a.count, { nodes: true, edges: a.edgeLabels }).data.nodes;
  const fitZoom = await fitted(graph);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < data.count; i++) {
    const x = data.positions[2 * i]!, y = data.positions[2 * i + 1]!;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const views: [number, number, number, number][] = [
    [0.5, 0.5, 1, 0], [0.5, 0.5, 4, 0], [0.5, 0.5, 16, 0], [0.62, 0.41, 70, 0], [0.3, 0.7, 30, 0], [0.9, 0.1, 5, 0], [0.45, 0.55, 8, 0.6], [0.2, 0.3, 300, 0],
  ];
  const checks: Check[] = [];
  for (const [fx, fy, z, rotation] of views) {
    graph.camera.setView({ x: minX + fx * (maxX - minX), y: minY + fy * (maxY - minY), zoom: fitZoom * z, rotation });
    await sleep(SETTLE_MS);
    checks.push(verify(`(${fx}, ${fy}) ×${z}${rotation ? ` rot ${rotation}` : ""}`, await graph.readLabelSnapshot()));
    report(checks);
  }
  return checks;
}

function render(panel: HTMLElement, checks: Check[], done: boolean): void {
  const failed = checks.filter((c) => !c.pass).length;
  const f = (n: number) => n.toLocaleString("en-US");
  const rows = checks
    .map((c) => `<tr><td>${c.name}</td><td>${f(c.candidates)}</td><td>${f(c.shown)}</td><td>${f(c.edges)}</td><td>${c.overlaps}</td><td>${c.differences}</td><td>${c.undecided}</td><td>${c.overflow ? "overflow" : ""}</td><td>${c.pass ? "✓" : "✗"}</td></tr>`)
    .join("");
  const status = !done ? "running…" : failed === 0 ? `PASS — ${checks.length} views` : `FAIL — ${failed} of ${checks.length}`;
  panel.innerHTML = `<div class="caption">Labels vs CPU greedy: ${status}</div><table><thead><tr><th>view</th><th>candidates</th><th>shown</th><th>edge labels</th><th>overlaps</th><th>differences</th><th>undecided</th><th>capacity</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

const meta: Meta<Args> = {
  title: "Developer/Label correctness",
  render: (args, ctx) =>
    stage(args, ctx, {
      options: () => ({ controls: false }),
      setup: async (graph, a, hud, root) => {
        const panel = document.createElement("div");
        panel.className = "bench-panel";
        root.append(panel);
        hud.setNote(`label correctness · ${a.dataset} · ${a.count.toLocaleString("en-US")} nodes`);
        const run = async () => {
          const checks = await runChecks(graph, a, (c) => render(panel, c, false));
          render(panel, checks, true);
          return { passed: checks.every((c) => c.pass), checks };
        };
        (globalThis as { __labelCorrectness?: unknown }).__labelCorrectness = { result: run() };
      },
    }),
  argTypes: {
    dataset: { control: "select", options: GRAPH_OPTIONS },
    count: { control: "select", options: [10_000, 100_000, 1_000_000] },
    edgeLabels: { control: "boolean" },
  },
  args: { dataset: "communities", count: 1_000_000, edgeLabels: true },
};

export default meta;
type Story = StoryObj<Args>;

export const LabelCorrectness: Story = { name: "Label correctness" };
