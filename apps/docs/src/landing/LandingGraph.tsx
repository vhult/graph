import { Graph } from "@vhult/graph";
import { useEffect, useRef, useState } from "react";
import { demoGraph } from "./demo";
import "./landing-graph.css";

export function LandingGraph() {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const canvas = document.createElement("canvas");
    el.append(canvas);
    let graph: Graph | null = null;
    let live = true;
    Graph.create(canvas).then(
      (g) => {
        if (!live) return g.destroy();
        graph = g;
        const { nodes, edges } = demoGraph();
        g.nodes.set(nodes);
        g.edges.set(edges);
        g.camera.fit();
        g.on("click", (hit) => console.log(hit.node));
      },
      (e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "The graph could not start.");
      },
    );
    return () => {
      live = false;
      graph?.destroy();
      canvas.remove();
    };
  }, []);

  return (
    <div className="landing-graph" ref={host}>
      {error && <p className="landing-graph-error">{error}</p>}
    </div>
  );
}
