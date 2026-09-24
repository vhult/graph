/**
 * Dataset cache for stories. Generation is excluded from engine timings and
 * done once per key; stories upload copies so the cached master stays intact
 * across arg changes and engine re-creation.
 *
 * Small LRU: a 10M-node graph is ~300 MB of typed arrays.
 */
import type { Graph } from "@vhult/graph";
import { brain, communities, cosmicWeb, deepField, generate, gridGraph, hierarchy, mesh, rivers, type GeneratorName, type GraphDataset, type NodeDataset } from "@vhult/graph-bench";

const MAX_ENTRIES = 2;
const cache = new Map<string, unknown>();

export interface Loaded<T> {
  data: T;
  /** Generation time in ms; 0 on cache hit. */
  genMs: number;
}

/** Build once per `key`, then serve from the cache. */
export function cached<T>(key: string, build: () => T): Loaded<T> {
  const hit = cache.get(key) as T | undefined;
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return { data: hit, genMs: 0 };
  }
  const t0 = performance.now();
  const data = build();
  const genMs = performance.now() - t0;
  cache.set(key, data);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return { data, genMs };
}

export function clearCache(): void {
  cache.clear();
}

export function loadDataset(name: GeneratorName, count: number, seed = 1): Loaded<NodeDataset> {
  return cached(`nodes:${name}:${count}:${seed}`, () => generate(name, count, seed));
}

export type GraphName = "communities" | "mesh" | "grid" | "hierarchy";

export const GRAPH_OPTIONS: readonly GraphName[] = ["communities", "mesh", "grid", "hierarchy"];

const GRAPHS: Record<GraphName, (count: number) => GraphDataset> = {
  communities: (n) => communities(n),
  mesh: (n) => mesh(n),
  grid: (n) => gridGraph(n),
  hierarchy: (n) => hierarchy(n),
};

export function loadGraph(name: GraphName, count: number): Loaded<GraphDataset> {
  return cached(`graph:${name}:${count}`, () => GRAPHS[name](count));
}

export const LAYOUTS = {
  communities: (n: number, seed: number) => communities(n, 2, seed),
  grid: (n: number, seed: number) => gridGraph(n, seed),
  mesh: (n: number, seed: number) => mesh(n, 3, seed),
  "hierarchy nested": (n: number, seed: number) => hierarchy(n, "nested", seed),
  "hierarchy layered": (n: number, seed: number) => hierarchy(n, "layered", seed),
} as const;

export type LayoutName = keyof typeof LAYOUTS;

export const LAYOUT_OPTIONS = Object.keys(LAYOUTS) as LayoutName[];

export const MAPS = {
  "cosmic web": cosmicWeb,
  brain,
  rivers,
  "deep field": deepField,
} as const;

export type MapName = keyof typeof MAPS;

export const MAP_OPTIONS = Object.keys(MAPS) as MapName[];

export function loadMap(name: MapName, count: number, seed: number): Loaded<GraphDataset> {
  return cached(`map:${name}:${count}:${seed}`, () => MAPS[name](count, seed));
}

export const NODE_COUNTS = [100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000] as const;

export function loadLayout(name: LayoutName, count: number, seed: number): Loaded<GraphDataset> {
  return cached(`layout:${name}:${count}:${seed}`, () => LAYOUTS[name](count, seed));
}

export interface GraphText {
  nodes: string[];
  edges: string[];
}

export function graphText(name: GraphName, count: number, g: GraphDataset): GraphText {
  return cached(`text:${name}:${count}`, () => ({
    nodes: Array.from({ length: g.nodes.count }, (_, i) => `#${i}`),
    edges: Array.from({ length: g.edges.count }, (_, i) => `e${i}`),
  })).data;
}

export function setGraph(graph: Graph, name: GraphName, count: number, labels: { nodes: boolean; edges: boolean }): { data: GraphDataset; genMs: number } {
  const { data, genMs } = loadGraph(name, count);
  graph.setNodes(data.nodes, { copy: true });
  graph.setEdges(data.edges, { copy: true });
  const text = labels.nodes || labels.edges ? graphText(name, count, data) : null;
  graph.setNodeLabels(labels.nodes && text ? text.nodes : []);
  graph.setEdgeLabels(labels.edges && text ? text.edges : []);
  return { data, genMs };
}

export const COUNT_OPTIONS = [10_000, 100_000, 250_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000] as const;
export const GENERATOR_OPTIONS: readonly GeneratorName[] = ["clustered", "galaxy", "uniform", "grid", "towns"];
