import type { Graph, GraphStats } from "@vhult/graph";

export class Hud {
  private readonly el: HTMLElement;
  private readonly stats = {} as GraphStats;
  private graph: Graph | null = null;
  private note = "";
  private load = "";

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "stage-note";
    parent.append(this.el);
  }

  attach(graph: Graph): void {
    this.graph = graph;
  }

  detach(): void {
    this.graph = null;
  }

  setNote(note: string): void {
    this.note = note;
    this.render();
  }

  error(e: Error): void {
    this.note = `error: ${e.message}`;
    this.render();
  }

  measureLoad(graph: Graph, genMs: number, expectedNodes: number): void {
    this.load = `gen ${genMs.toFixed(0)} ms`;
    this.render();
    const t0 = performance.now();
    const startFrames = graph.readStats(this.stats).renderedFrames;
    const check = (): void => {
      if (this.graph !== graph) return;
      const st = graph.readStats(this.stats);
      if (st.renderedFrames > startFrames && st.nodeCount === expectedNodes) {
        this.load = `load ${(performance.now() - t0).toFixed(0)} ms upload→frame (gen ${genMs.toFixed(0)} ms)`;
        this.render();
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  private render(): void {
    this.el.textContent = [this.note, this.load].filter(Boolean).join("\n");
  }
}
