import type { Graph } from "@vhult/graph";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fitted(graph: Graph, settleMs = 1500): Promise<number> {
  const frames = graph.stats().renderedFrames;
  graph.camera.fit();
  while (graph.stats().renderedFrames <= frames + 2 || graph.camera.get().zoom <= 1e-6) await sleep(50);
  await sleep(settleMs);
  return graph.camera.get().zoom;
}
