import type { Graph, NodeDragEvent } from "@vhult/graph";

export interface ReadoutText {
  node?: (i: number) => string;
  edge?: (i: number) => string;
}

const readouts = new WeakMap<Graph, (text: ReadoutText) => void>();

const numbered = (i: number) => `#${i}`;
const at = (e: NodeDragEvent) => `${e.x.toFixed(1)}, ${e.y.toFixed(1)}`;

export function showReadout(graph: Graph, root: HTMLElement, text: ReadoutText = {}): void {
  const retext = readouts.get(graph);
  if (retext) return retext(text);
  const box = document.createElement("div");
  box.className = "stage-note";
  box.style.cssText = "top: 8px; right: 8px; left: auto; bottom: auto";
  root.append(box);
  let node = text.node ?? numbered;
  let edge = text.edge ?? numbered;
  let hoverNode: number | null = null;
  let hoverEdge: number | null = null;
  let clickNode: number | null = null;
  let clickEdge: number | null = null;
  let clicked = false;
  let drag = "—";
  const render = () => {
    const click = !clicked ? "—" : clickNode !== null ? node(clickNode) : clickEdge !== null ? edge(clickEdge) : "empty space";
    box.textContent = [
      `hover node: ${hoverNode === null ? "—" : node(hoverNode)}`,
      `hover edge: ${hoverEdge === null ? "—" : edge(hoverEdge)}`,
      `click: ${click}`,
      `drag: ${drag}`,
    ].join("\n");
  };
  readouts.set(graph, (t) => {
    node = t.node ?? numbered;
    edge = t.edge ?? numbered;
    render();
  });
  graph.on("nodeHover", (i) => {
    hoverNode = i;
    render();
  });
  graph.on("edgeHover", (i) => {
    hoverEdge = i;
    render();
  });
  graph.on("nodeClick", (i) => {
    clicked = true;
    clickNode = i;
    render();
  });
  graph.on("edgeClick", (i) => {
    clicked = true;
    clickEdge = i;
    render();
  });
  graph.on("nodeDragStart", (e) => {
    drag = `${node(e.index)} from ${at(e)}`;
    render();
  });
  graph.on("nodeDrag", (e) => {
    drag = `${node(e.index)} at ${at(e)}`;
    render();
  });
  graph.on("nodeDragEnd", (e) => {
    drag = `${node(e.index)} dropped at ${at(e)}`;
    render();
  });
  render();
}
