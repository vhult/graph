import type { Graph, NodeDragEvent } from "@vhult/graph";

let box: HTMLElement | null = null;
const hooked = new WeakSet<Graph>();

const at = (e: NodeDragEvent) => `#${e.index} at ${e.x.toFixed(1)}, ${e.y.toFixed(1)}`;

export function showDragBox(graph: Graph): void {
  if (!box) {
    box = document.createElement("div");
    box.className = "stage-note";
    box.style.cssText = "position: fixed; top: 8px; right: 8px; left: auto; bottom: auto";
    (document.querySelector("#storybook-root") ?? document.body).append(box);
  }
  if (hooked.has(graph)) return;
  hooked.add(graph);
  let hover: number | null = null;
  let nodeClick = "—";
  let edgeClick = "—";
  let drag = "—";
  let moves = 0;
  const render = () => {
    if (!box) return;
    box.textContent = [
      `hover: ${hover === null ? "—" : `#${hover}`}`,
      `node click: ${nodeClick}`,
      `edge click: ${edgeClick}`,
      `drag: ${drag}`,
      `drag moves: ${moves}`,
    ].join("\n");
  };
  graph.on("nodeHover", (i) => {
    hover = i;
    render();
  });
  graph.on("nodeClick", (i) => {
    nodeClick = i === null ? "empty" : `#${i}`;
    render();
  });
  graph.on("edgeClick", (i) => {
    edgeClick = i === null ? "empty" : `#${i}`;
    render();
  });
  graph.on("nodeDragStart", (e) => {
    moves = 0;
    drag = `start ${at(e)}`;
    render();
  });
  graph.on("nodeDrag", (e) => {
    moves++;
    drag = `move ${at(e)}`;
    render();
  });
  graph.on("nodeDragEnd", (e) => {
    drag = `end ${at(e)}`;
    render();
  });
  render();
}

export function removeDragBox(): void {
  box?.remove();
  box = null;
}
