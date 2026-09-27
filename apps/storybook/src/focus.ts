import { Flag, type Graph } from "@vhult/graph";

export interface FocusOptions {
  neighbors: (node: number) => readonly number[];
  busy?: () => boolean;
}

export interface Focus {
  clear(): void;
}

export function attachFocus(graph: Graph, opts: FocusOptions): Focus {
  let on = false;
  const clear = () => {
    if (!on) return;
    on = false;
    graph.nodes.flag("all", Flag.dimmed | Flag.focused, false);
  };
  const focus = (i: number) => {
    const near = opts.neighbors(i);
    graph.nodes.flag("all", Flag.focused, false);
    graph.nodes.flag("all", Flag.dimmed, true);
    graph.nodes.flag(Uint32Array.from([i, ...near]), Flag.dimmed, false);
    if (near.length > 0) graph.nodes.flag(Uint32Array.from(near), Flag.focused, true);
    on = true;
  };
  graph.on("click", (h) => {
    if (opts.busy?.()) return;
    if (h.node !== null) focus(h.node);
    else clear();
  });
  graph.on("doubleClick", (h) => {
    if (opts.busy?.() || h.node === null) return;
    graph.camera.fit({ nodes: Uint32Array.from([h.node, ...opts.neighbors(h.node)]), padding: 80, duration: 500 });
  });
  return { clear };
}
