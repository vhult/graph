import { packRgba, type EdgeData, type NodeData } from "@vhult/graph";

const COLORS = [packRgba(0.3, 0.6, 1), packRgba(0.71, 0.48, 1), packRgba(0.21, 0.79, 0.56)];

export function demoGraph(): { nodes: NodeData; edges: EdgeData } {
  const positions: number[] = [0, 0];
  const sizes: number[] = [18];
  const colors: number[] = [COLORS[0]];
  const indices: number[] = [];
  const inner = 6;
  for (let i = 0; i < inner; i++) {
    const a = (i / inner) * Math.PI * 2;
    positions.push(Math.cos(a) * 120, Math.sin(a) * 120);
    sizes.push(12);
    colors.push(COLORS[1]);
    indices.push(0, 1 + i, 1 + i, 1 + ((i + 1) % inner));
  }
  for (let i = 0; i < inner * 2; i++) {
    const a = ((i + 0.5) / (inner * 2)) * Math.PI * 2;
    positions.push(Math.cos(a) * 230, Math.sin(a) * 230);
    sizes.push(8);
    colors.push(COLORS[2]);
    indices.push(1 + Math.floor(i / 2), 1 + inner + i);
  }
  const count = sizes.length;
  return {
    nodes: {
      count,
      positions: new Float32Array(positions),
      sizes: new Float32Array(sizes),
      colors: new Uint32Array(colors),
    },
    edges: { count: indices.length / 2, indices: new Uint32Array(indices) },
  };
}
