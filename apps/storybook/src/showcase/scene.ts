import { packEdgeStyle, type Graph } from "@vhult/graph";
import { rgbToWord } from "@vhult/graph-bench";
import { showcaseIconId } from "./icons";
import type { Kind, Relation, Scenario } from "./scenario";

const EDGE_ALPHA = 0.85;
const DARK_ICON = rgbToWord(0x1b2230);
const LIGHT_ICON = 0xffffffff;

function iconColor(rgb: number): number {
  const l = (0.299 * ((rgb >>> 16) & 0xff) + 0.587 * ((rgb >>> 8) & 0xff) + 0.114 * (rgb & 0xff)) / 255;
  return l > 0.75 ? DARK_ICON : LIGHT_ICON;
}

function edgeStyle(rel: Relation, width?: number): number {
  return packEdgeStyle({ width: width ?? rel.width ?? 1.5, directed: rel.directed, pattern: rel.pattern, tapered: rel.tapered });
}

export class Scene {
  scenario: Scenario | null = null;
  readonly names: string[] = [];
  readonly colors: number[] = [];
  readonly x: number[] = [];
  readonly y: number[] = [];
  readonly ends: number[] = [];
  readonly rels: number[] = [];
  private readonly gone: boolean[] = [];
  private readonly added: number[] = [];
  private dragged: { i: number; x: number; y: number }[] = [];

  constructor(private readonly graph: Graph) {
    graph.on("dragStart", (e) => {
      this.dragged = Array.from(e.nodes, (i) => ({ i, x: this.x[i] ?? 0, y: this.y[i] ?? 0 }));
    });
    graph.on("drag", (e) => this.moveDragged(e.dx, e.dy));
    graph.on("dragEnd", (e) => this.moveDragged(e.dx, e.dy));
  }

  load(s: Scenario): void {
    this.scenario = s;
    for (const a of [this.names, this.colors, this.x, this.y, this.ends, this.rels, this.gone]) a.length = 0;
    this.added.length = 0;
    this.added.push(...s.kinds.map(() => 0));
    const n = s.nodes.length;
    const positions = new Float32Array(n * 2);
    const colors = new Uint32Array(n);
    const sizes = new Float32Array(n);
    const shapes = new Uint8Array(n);
    const zIndex = new Uint8Array(n);
    const icons = new Uint16Array(n);
    const iconColors = new Uint32Array(n);
    s.nodes.forEach((node, i) => {
      const kind = s.kinds[node.kind]!;
      const rgb = node.color ?? kind.color;
      positions[i * 2] = node.x;
      positions[i * 2 + 1] = node.y;
      colors[i] = rgbToWord(rgb);
      sizes[i] = node.size ?? kind.size;
      shapes[i] = kind.shape;
      zIndex[i] = kind.layer ?? 0;
      icons[i] = showcaseIconId(node.icon ?? kind.icon);
      iconColors[i] = iconColor(rgb);
      this.remember(node.name, rgb, node.x, node.y);
    });
    const m = s.edges.length;
    const indices = new Uint32Array(m * 2);
    const styles = new Uint32Array(m);
    const edgeColors = new Uint32Array(m * 2);
    const labels: string[] = [];
    s.edges.forEach((e, k) => {
      const rel = s.relations[e.rel]!;
      indices[k * 2] = e.a;
      indices[k * 2 + 1] = e.b;
      styles[k] = edgeStyle(rel, e.width);
      edgeColors[k * 2] = rgbToWord(rel.color ?? this.colors[e.a]!, EDGE_ALPHA);
      edgeColors[k * 2 + 1] = rgbToWord(rel.color ?? this.colors[e.b]!, EDGE_ALPHA);
      labels.push(e.label ?? rel.label);
      this.connect(e.a, e.b, e.rel);
    });
    this.graph.nodes.set({ count: n, positions, colors, sizes, shapes, zIndex, icons, iconColors, labels: this.names.slice() });
    this.graph.edges.set({ count: m, indices, styles, colors: edgeColors, labels });
  }

  neighbors(i: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.rels.length; k++) {
      if (this.rels[k]! < 0) continue;
      const a = this.ends[k * 2]!;
      const b = this.ends[k * 2 + 1]!;
      if (a === i) out.push(b);
      else if (b === i) out.push(a);
    }
    return out;
  }

  alive(i: number): boolean {
    return i < this.names.length && !this.gone[i];
  }

  position(i: number): { x: number; y: number } | null {
    return this.alive(i) ? { x: this.x[i]!, y: this.y[i]! } : null;
  }

  relation(e: number): Relation | undefined {
    return this.scenario?.relations[this.rels[e]!];
  }

  addNode(kindIndex: number, x: number, y: number): void {
    const s = this.scenario;
    const kind: Kind | undefined = s?.kinds[kindIndex];
    if (!kind) return;
    const name = `New ${kind.label.toLowerCase()} ${++this.added[kindIndex]!}`;
    const [i] = this.graph.nodes.add({
      count: 1,
      positions: Float32Array.of(x, y),
      colors: Uint32Array.of(rgbToWord(kind.color)),
      sizes: Float32Array.of(kind.size),
      shapes: Uint8Array.of(kind.shape),
      zIndex: Uint8Array.of(kind.layer ?? 0),
      icons: Uint16Array.of(showcaseIconId(kind.icon)),
      iconColors: Uint32Array.of(iconColor(kind.color)),
      labels: [name],
    });
    this.remember(name, kind.color, x, y, i);
  }

  removeNode(i: number): void {
    if (!this.alive(i)) return;
    this.graph.nodes.remove([i]);
    this.gone[i] = true;
    for (let k = 0; k < this.rels.length; k++) {
      if (this.ends[k * 2] === i || this.ends[k * 2 + 1] === i) this.rels[k] = -1;
    }
  }

  removeEdge(k: number): void {
    if (!(this.rels[k]! >= 0)) return;
    this.graph.edges.remove([k]);
    this.rels[k] = -1;
  }

  restyleEdge(k: number, relIndex: number): void {
    const rel = this.scenario?.relations[relIndex];
    if (!rel || !(this.rels[k]! >= 0)) return;
    const a = this.ends[k * 2]!;
    const b = this.ends[k * 2 + 1]!;
    this.graph.edges.update(Uint32Array.of(k), {
      styles: Uint32Array.of(edgeStyle(rel)),
      colors: Uint32Array.of(rgbToWord(rel.color ?? this.colors[a]!, EDGE_ALPHA), rgbToWord(rel.color ?? this.colors[b]!, EDGE_ALPHA)),
      labels: [rel.label],
    });
    this.rels[k] = relIndex;
  }

  addEdge(relIndex: number, a: number, b: number): void {
    const rel = this.scenario?.relations[relIndex];
    if (!rel) return;
    const [k] = this.graph.edges.add({
      count: 1,
      indices: Uint32Array.of(a, b),
      styles: Uint32Array.of(edgeStyle(rel)),
      colors: Uint32Array.of(rgbToWord(rel.color ?? this.colors[a]!, EDGE_ALPHA), rgbToWord(rel.color ?? this.colors[b]!, EDGE_ALPHA)),
      labels: [rel.label],
    });
    this.connect(a, b, relIndex, k);
  }

  private remember(name: string, rgb: number, x: number, y: number, i = this.names.length): void {
    this.names[i] = name;
    this.colors[i] = rgb;
    this.x[i] = x;
    this.y[i] = y;
    this.gone[i] = false;
  }

  private connect(a: number, b: number, rel: number, k = this.rels.length): void {
    this.ends[k * 2] = a;
    this.ends[k * 2 + 1] = b;
    this.rels[k] = rel;
  }

  private moveDragged(dx: number, dy: number): void {
    for (const d of this.dragged) {
      this.x[d.i] = d.x + dx;
      this.y[d.i] = d.y + dy;
    }
  }
}
