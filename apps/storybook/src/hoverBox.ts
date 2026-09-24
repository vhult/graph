import type { Graph } from "@vhult/graph";

export interface HoverText {
  node: (i: number) => string;
  edge: (i: number) => string;
}

let box: HTMLElement | null = null;
let text: HoverText | null = null;
const hooked = new WeakSet<Graph>();

export function showHoverBox(graph: Graph, describe: HoverText): void {
  text = describe;
  if (!box) {
    box = document.createElement("div");
    box.className = "stage-note";
    box.style.cssText = "position: fixed; top: 8px; right: 8px; left: auto; bottom: auto";
    (document.querySelector("#storybook-root") ?? document.body).append(box);
  }
  if (hooked.has(graph)) return;
  hooked.add(graph);
  let node: number | null = null;
  let edge: number | null = null;
  const render = () => {
    if (!box || !text) return;
    box.textContent = `node: ${node === null ? "—" : text.node(node)}\nedge: ${edge === null ? "—" : text.edge(edge)}`;
  };
  graph.on("nodeHover", (i) => {
    node = i;
    render();
  });
  graph.on("edgeHover", (i) => {
    edge = i;
    render();
  });
  render();
}

export function removeHoverBox(): void {
  box?.remove();
  box = null;
  text = null;
}
