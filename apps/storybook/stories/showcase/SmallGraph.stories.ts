import type { Meta, StoryObj } from "@storybook/html-vite";
import type { Graph, Hit } from "@vhult/graph";
import { attachFocus, type Focus } from "../../src/focus";
import { showReadout } from "../../src/readout";
import { iconMarkup, SHOWCASE_ICON_LIST } from "../../src/showcase/icons";
import { Legend, type LegendItem } from "../../src/showcase/legend";
import { Scene } from "../../src/showcase/scene";
import type { Scenario } from "../../src/showcase/scenario";
import { SCENARIOS, type ScenarioName } from "../../src/showcase/scenarios";
import { stage } from "../../src/stage";
import { attachWheel, type Wheel, type WheelAction, type WheelMenu } from "../../src/wheel";

interface Args {
  scenario: ScenarioName;
}

const GREY = 0x9aa6bd;
const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;

function items(s: Scenario): { kinds: LegendItem[]; relations: LegendItem[] } {
  return {
    kinds: s.kinds.map((k) => ({ label: k.label, color: hex(k.color), icon: iconMarkup(k.icon) })),
    relations: s.relations.map((r) => ({
      label: r.label,
      color: hex(r.color ?? GREY),
      line: { pattern: r.pattern, tapered: r.tapered, directed: r.directed, curve: r.curve, width: r.width ?? 3, color: hex(r.color ?? GREY) },
    })),
  };
}

interface Showcase {
  scene: Scene;
  wheel: Wheel;
  focus: Focus;
  legend: Legend;
}

const showcases = new WeakMap<Graph, Showcase>();

function menu(scene: Scene, focus: Focus, h: Hit): WheelMenu | null {
  const s = scene.scenario;
  if (!s) return null;
  const { kinds, relations } = items(s);
  if (h.node !== null) {
    const from = h.node;
    const link: WheelAction[] = relations.map((r, k) => ({
      ...r,
      run: () => ({ from, line: r.line!, prompt: `link as "${r.label}"`, done: (to: number) => scene.addEdge(k, from, to) }),
    }));
    const remove: WheelAction = {
      label: "Delete node",
      color: "",
      danger: true,
      run: () => {
        focus.clear();
        scene.removeNode(from);
      },
    };
    return { title: scene.names[from] ?? "Node", items: [...link, remove] };
  }
  if (h.edge !== null) {
    const e = h.edge;
    const current = scene.rels[e];
    const change: WheelAction[] = relations.map((r, k) => ({ ...r, current: k === current, run: () => scene.restyleEdge(e, k) }));
    const remove: WheelAction = { label: "Delete edge", color: "", danger: true, run: () => scene.removeEdge(e) };
    const title = `${scene.relation(e)?.label ?? "Edge"}\n${scene.names[scene.ends[e * 2]!]} → ${scene.names[scene.ends[e * 2 + 1]!]}`;
    return { title, items: [...change, remove] };
  }
  return { title: "Add node", items: kinds.map((k, i) => ({ ...k, run: () => scene.addNode(i, h.x, h.y) })) };
}

function create(graph: Graph, root: HTMLElement): Showcase {
  const scene = new Scene(graph);
  const focus = attachFocus(graph, { neighbors: (i) => scene.neighbors(i), busy: () => wheel.busy });
  const wheel = attachWheel(graph, root, { menu: (h) => menu(scene, focus, h), position: (i) => scene.position(i) });
  showReadout(graph, root, {
    node: (i) => scene.names[i] ?? `#${i}`,
    edge: (e) => `${scene.names[scene.ends[e * 2]!]} → ${scene.names[scene.ends[e * 2 + 1]!]} · ${scene.relation(e)?.label ?? ""}`,
  });
  const sc = { scene, wheel, focus, legend: new Legend(root) };
  showcases.set(graph, sc);
  return sc;
}

function show(sc: Showcase, graph: Graph, name: ScenarioName, note: (s: string) => void): void {
  const s = SCENARIOS[name];
  const it = items(s);
  sc.focus.clear();
  graph.style.set({ nodeScale: s.nodeScale });
  sc.scene.load(s);
  sc.legend.set(it.kinds, it.relations);
  graph.camera.fit({ padding: 48 });
  note(`${s.title} · ${s.nodes.length} nodes · ${s.edges.length} edges`);
}

const meta: Meta<Args> = {
  title: "Showcase/Small graph",
  render: (args, ctx) =>
    stage(args, ctx, {
      options: () => ({
        input: { rotate: "auto", drag: "auto", selectShape: "lasso" },
        style: {
          edge: { width: 1.5, color: [0.6, 0.7, 0.9, 0.8] },
          label: { size: 11 },
          dimmed: { alpha: 0.12 },
          focused: { outline: { color: [0.3, 0.8, 1, 1] } },
        },
      }),
      setup: async (graph, a, hud, root) => {
        await graph.icons.define(SHOWCASE_ICON_LIST);
        show(create(graph, root), graph, a.scenario, (t) => hud.setNote(t));
      },
      update: (graph, a, prev, hud) => {
        const sc = showcases.get(graph);
        if (sc && a.scenario !== prev.scenario) show(sc, graph, a.scenario, (t) => hud.setNote(t));
      },
    }),
  argTypes: {
    scenario: {
      control: "select",
      options: Object.keys(SCENARIOS),
      labels: Object.fromEntries(Object.entries(SCENARIOS).map(([k, s]) => [k, s.title])),
    },
  },
  args: { scenario: "company" },
};

export default meta;

export const SmallGraph: StoryObj<Args> = { name: "Small graph" };
