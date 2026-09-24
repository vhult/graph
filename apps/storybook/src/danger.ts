import type { Graph, GraphStats } from "@vhult/graph";
import type { GraphDataset } from "@vhult/graph-bench";
import { clearCache } from "./data";
import type { GraphArgs } from "./graphStory";

export interface DangerArgs extends GraphArgs {
  dangerZone: boolean;
  vramGB: number;
  neighbours: number;
}

interface Sample {
  nodes: number;
  edges: number;
  peakBytes: number;
}

interface Loaded {
  graph: Graph;
  key: string;
  nodes: number;
}

interface Plan {
  nodes: number;
  edges: number;
  peakBytes: number;
  bufferBytes: number;
  limitBytes: number;
  byLimit: boolean;
  ramBytes: number;
  sample: Sample;
}

const GIB = 2 ** 30;
const FILL = 0.95;
const STEP = 1_000_000;
const INSTANCE_BYTES = 20;
const EDGE_BUFFER_BYTES = 8;
const NODE_DATA_BYTES = 16;
const EDGE_DATA_BYTES = 8;
const EDGE_COLOR_BYTES = 8;

const fmt = (n: number) => n.toLocaleString("en-US");
const gb = (bytes: number) => `${(bytes / GIB).toFixed(2)} GB`;
const key = (a: DangerArgs) => `${a.neighbours}:${a.edges}:${a.edgeColor}:${a.labels}`;

export class DangerZone {
  private readonly samples = new Map<string, Sample>();
  private readonly largest = new WeakMap<Graph, number>();
  private readonly stats = {} as GraphStats;
  private current: Loaded | null = null;
  private panel: HTMLElement | null = null;
  private token: object | null = null;
  private releasing = false;

  gate<A extends DangerArgs>(graph: Graph, a: A, root: HTMLElement): Promise<A | null> {
    this.measure(graph);
    this.token = null;
    this.hide();
    if (!a.dangerZone) return Promise.resolve(a);
    const token = {};
    this.token = token;
    return new Promise((resolve) => {
      const plan = this.plan(graph, a);
      this.panel = panel(plan, a.vramGB, () => {
        requestAnimationFrame(() =>
          setTimeout(() => {
            if (this.token !== token || !plan) return;
            this.token = null;
            this.releasing = true;
            clearCache();
            resolve({ ...a, nodes: plan.nodes });
          }),
        );
      });
      root.append(this.panel);
    });
  }

  loaded(graph: Graph, g: GraphDataset, a: DangerArgs): void {
    this.current = { graph, key: key(a), nodes: g.nodes.count };
    this.largest.set(graph, Math.max(this.largest.get(graph) ?? 0, g.nodes.count));
    if (!this.releasing) return;
    this.releasing = false;
    this.hide();
  }

  private hide(): void {
    this.panel?.remove();
    this.panel = null;
  }

  private measure(graph: Graph): void {
    const c = this.current;
    if (!c || c.graph !== graph || c.nodes === 0) return;
    const st = graph.readStats(this.stats);
    if (st.nodeCount !== c.nodes || st.renderedFrames === 0) return;
    if (c.nodes < (this.largest.get(graph) ?? 0)) return;
    this.samples.set(c.key, { nodes: c.nodes, edges: st.edgeCount, peakBytes: st.peakGpuBytes });
  }

  private plan(graph: Graph, a: DangerArgs): Plan | null {
    const sample = this.samples.get(key(a));
    if (!sample) return null;
    const bytesPerNode = sample.peakBytes / sample.nodes;
    const edgesPerNode = sample.edges / sample.nodes;
    const bufferPerNode = Math.max(INSTANCE_BYTES, EDGE_BUFFER_BYTES * edgesPerNode);
    const limitBytes = Math.min(graph.caps.maxBufferSize, graph.caps.maxStorageBufferBindingSize);
    const byVram = (FILL * a.vramGB * GIB) / bytesPerNode;
    const byLimit = (FILL * limitBytes) / bufferPerNode;
    const nodes = Math.max(STEP, Math.floor(Math.min(byVram, byLimit) / STEP) * STEP);
    const edges = Math.round(nodes * edgesPerNode);
    const colors = a.edges && a.edgeColor === "nodes" ? EDGE_COLOR_BYTES * edges : 0;
    return {
      nodes,
      edges,
      peakBytes: nodes * bytesPerNode,
      bufferBytes: nodes * bufferPerNode,
      limitBytes,
      byLimit: byLimit < byVram,
      ramBytes: 2 * (NODE_DATA_BYTES * nodes + EDGE_DATA_BYTES * edges) + colors,
      sample,
    };
  }
}

function panel(plan: Plan | null, vramGB: number, onLoad: () => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "danger-panel";
  const title = document.createElement("div");
  title.className = "danger-title";
  title.textContent = "DANGER ZONE";
  const body = document.createElement("div");
  el.append(title, body);
  if (!plan) {
    body.textContent =
      "No measurement for these settings yet.\n" + "Turn the danger zone off, let the graph load, then turn it on again.";
    return el;
  }
  const s = plan.sample;
  body.textContent = [
    `This loads ${fmt(plan.nodes)} nodes and about ${fmt(plan.edges)} edges.`,
    "It may freeze or crash the tab, or reset the GPU driver, on a machine that is not high end.",
    "",
    `GPU memory at peak   ${gb(plan.peakBytes)} of ${vramGB} GB (target ${FILL * 100}%)`,
    `largest GPU buffer   ${gb(plan.bufferBytes)} of ${gb(plan.limitBytes)} this GPU allows`,
    `tab memory           at least ${gb(plan.ramBytes)}`,
    `node count set by    ${plan.byLimit ? "the GPU buffer limit" : "the VRAM slider"}`,
    `measured on          ${fmt(s.nodes)} nodes, ${fmt(s.edges)} edges, ${gb(s.peakBytes)} peak`,
    "",
    "The browser cannot see how much VRAM this GPU has: the slider is your figure.",
    "The tab freezes while the graph is generated.",
  ].join("\n");
  const button = document.createElement("button");
  button.textContent = "Load anyway";
  button.onclick = () => {
    button.disabled = true;
    button.textContent = "generating…";
    onLoad();
  };
  el.append(button);
  return el;
}
