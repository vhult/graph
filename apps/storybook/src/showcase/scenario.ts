import type { NodeShape, packEdgeStyle } from "@vhult/graph";
import type { ShowcaseIcon } from "./icons";

export type Pattern = NonNullable<Parameters<typeof packEdgeStyle>[0]["pattern"]>;

export interface Kind {
  label: string;
  icon: ShowcaseIcon;
  color: number;
  shape: NodeShape;
  size: number;
  layer?: number;
}

export interface Relation {
  label: string;
  pattern?: Pattern;
  tapered?: boolean;
  directed?: boolean;
  width?: number;
  color?: number;
}

export interface SceneNode {
  name: string;
  kind: number;
  x: number;
  y: number;
  size?: number;
  color?: number;
  icon?: ShowcaseIcon;
}

export interface SceneEdge {
  a: number;
  b: number;
  rel: number;
  label?: string;
  width?: number;
}

export interface Scenario {
  title: string;
  nodeScale: number;
  kinds: readonly Kind[];
  relations: readonly Relation[];
  nodes: readonly SceneNode[];
  edges: readonly SceneEdge[];
}

export class ScenarioBuilder<K extends string, R extends string> {
  readonly nodes: SceneNode[] = [];
  readonly edges: SceneEdge[] = [];
  private readonly kindIds: Record<string, number>;
  private readonly relIds: Record<string, number>;

  constructor(
    readonly title: string,
    private readonly kinds: Record<K, Kind>,
    private readonly relations: Record<R, Relation>,
    private readonly nodeScale = 1,
  ) {
    this.kindIds = Object.fromEntries(Object.keys(kinds).map((k, i) => [k, i]));
    this.relIds = Object.fromEntries(Object.keys(relations).map((k, i) => [k, i]));
  }

  node(name: string, kind: K, x: number, y: number, extra: Pick<SceneNode, "size" | "color" | "icon"> = {}): number {
    this.nodes.push({ name, kind: this.kindIds[kind]!, x, y, ...extra });
    return this.nodes.length - 1;
  }

  link(a: number, b: number, rel: R, label?: string, width?: number): void {
    this.edges.push({ a, b, rel: this.relIds[rel]!, label, width });
  }

  build(): Scenario {
    return { title: this.title, nodeScale: this.nodeScale, kinds: Object.values(this.kinds), relations: Object.values(this.relations), nodes: this.nodes, edges: this.edges };
  }
}

