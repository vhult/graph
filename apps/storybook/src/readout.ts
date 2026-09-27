import type { Graph, Hit } from "@vhult/graph";

export interface ReadoutText {
  node?: (i: number) => string;
  edge?: (i: number) => string;
}

const readouts = new WeakMap<Graph, (text: ReadoutText) => void>();

const numbered = (i: number) => `#${i}`;
const at = (x: number, y: number) => `${x.toFixed(1)}, ${y.toFixed(1)}`;

export function showReadout(graph: Graph, root: HTMLElement, text: ReadoutText = {}): void {
  const retext = readouts.get(graph);
  if (retext) return retext(text);
  const box = document.createElement("div");
  box.className = "stage-note stage-readout";
  box.style.cssText = "top: 8px; right: 8px; left: auto; bottom: auto";
  root.append(box);
  let node = text.node ?? numbered;
  let edge = text.edge ?? numbered;
  let hover: Hit | null = null;
  let click: Hit | null = null;
  let drag = "—";
  let from = { x: 0, y: 0, who: "" };
  const name = (h: Hit, empty: string) => (h.node !== null ? node(h.node) : h.edge !== null ? edge(h.edge) : empty);
  const render = () => {
    box.textContent = [
      `hover: ${hover ? name(hover, "—") : "—"}`,
      `click: ${click ? name(click, "empty space") : "—"}`,
      `drag: ${drag}`,
    ].join("\n");
  };
  readouts.set(graph, (t) => {
    node = t.node ?? numbered;
    edge = t.edge ?? numbered;
    render();
  });
  graph.on("hover", (h) => {
    hover = h;
    render();
  });
  graph.on("click", (h) => {
    click = h;
    render();
  });
  graph.on("dragStart", (e) => {
    from = { x: e.x, y: e.y, who: e.nodes.length > 1 ? `${node(e.index)} +${e.nodes.length - 1}` : node(e.index) };
    drag = `${from.who} from ${at(e.x, e.y)}`;
    render();
  });
  graph.on("drag", (e) => {
    drag = `${from.who} at ${at(from.x + e.dx, from.y + e.dy)}`;
    render();
  });
  graph.on("dragEnd", (e) => {
    drag = `${from.who} dropped at ${at(from.x + e.dx, from.y + e.dy)}`;
    render();
  });
  render();
}
