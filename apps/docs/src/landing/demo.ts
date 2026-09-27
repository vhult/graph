import { packRgba, type EdgeData, type NodeData } from "@vhult/graph";

export function demoGraph(): { nodes: NodeData; edges: EdgeData } {
  return {
    nodes: {
      count: 3,
      positions: new Float32Array([0, 0, 100, 0, 50, 80]),
      sizes: new Float32Array([10, 10, 10]),
      colors: new Uint32Array(3).fill(packRgba(1, 0.4, 0.2)),
    },
    edges: { count: 2, indices: new Uint32Array([0, 1, 1, 2]) },
  };
}
