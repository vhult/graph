/**
 * Story stage: owns ONE engine per story and keeps it alive across arg changes.
 *
 * Why: Storybook re-runs `render` on every control change. Recreating the
 * engine there would re-acquire a GPU device, re-upload every buffer and
 * measure Storybook instead of the engine. Instead:
 *   - `render` returns the SAME root element for the same story, which the
 *     HTML renderer treats as a no-op (no remount, canvas untouched);
 *   - arg changes are forwarded to `update(graph, args, prev)` as deltas;
 *   - the engine is destroyed only on story teardown (preview.ts beforeEach).
 */
import { Graph, type GraphOptions } from "@vhult/graph";
import { Hud } from "./hud";

export interface StageSpec<A> {
  /** Engine options derived from args. Changing these recreates the engine. */
  options?: (args: A) => GraphOptions;
  /** Called once when the engine is ready. `root` hosts extra overlays. */
  setup: (graph: Graph, args: A, hud: Hud, root: HTMLElement) => void | Promise<void>;
  /** Called on arg changes with the previous args. */
  update?: (graph: Graph, args: A, prev: A, hud: Hud) => void | Promise<void>;
  /** Called before the engine is destroyed (stop animation loops here). */
  dispose?: () => void;
}

export interface StoryContext {
  id: string;
  viewMode?: string;
  globals?: { hud?: string; drag?: string; hover?: string; edges?: string };
}

export interface Toggles {
  drag: boolean;
  hover: boolean;
  edges: boolean;
}

export function toggles(context: StoryContext): Toggles {
  const g = context.globals ?? {};
  return { drag: g.drag === "on", hover: g.hover !== "off", edges: g.edges !== "off" };
}

interface Current {
  storyId: string;
  root: HTMLElement;
  optionsKey: string;
  args: unknown;
  graph: Graph | null;
  ready: Promise<Graph | null>;
  hud: Hud;
  hudOn: boolean;
  drag: boolean;
  dispose?: () => void;
}

function setDebug(graph: Graph, on: boolean): void {
  if (on) graph.debug.open();
  else graph.debug.close();
}

let current: Current | null = null;

/** `context` is the Storybook story context; only its id and globals are used. */
export function stage<A>(args: A, context: StoryContext, spec: StageSpec<A>): HTMLElement {
  const own = spec.options?.(args) ?? {};
  const t = toggles(context);
  const drag = own.nodeDrag ?? t.drag;
  const options: GraphOptions = { ...own, nodeDrag: drag, hoverStyle: t.hover ? own.hoverStyle : false };
  const optionsKey = JSON.stringify({ ...options, nodeDrag: undefined });
  const embed = context.viewMode === "docs";
  const hudOn = !embed && context.globals?.hud !== "off";

  if (current && current.storyId === context.id && current.optionsKey === optionsKey) {
    const cur = current;
    const prev = cur.args as A;
    cur.args = args;
    cur.hudOn = hudOn;
    if (cur.graph) setDebug(cur.graph, hudOn);
    if (cur.graph && cur.drag !== drag) cur.graph.setNodeDrag(drag);
    cur.drag = drag;
    void cur.ready.then((g) => g && cur === current && spec.update?.(g, args, prev, cur.hud));
    return cur.root;
  }

  disposeStage();

  const root = document.createElement("div");
  root.className = embed ? "stage stage-embed" : "stage";
  const canvas = document.createElement("canvas");
  root.append(canvas);
  const hud = new Hud(root);

  const errors: string[] = [];
  const cur: Current = { storyId: context.id, root, optionsKey, args, graph: null, ready: Promise.resolve(null), hud, hudOn, drag, dispose: spec.dispose };
  current = cur;

  // Create after the element is in the DOM so the canvas has a real size.
  cur.ready = new Promise<void>((r) => requestAnimationFrame(() => r()))
    .then(() => Graph.create(canvas, options))
    .then(async (graph) => {
      if (cur !== current) {
        graph.destroy();
        return null;
      }
      cur.graph = graph;
      graph.on("error", (e) => {
        hud.error(e);
        errors.push(`${e.name}: ${e.message}`);
      });
      hud.attach(graph);
      setDebug(graph, cur.hudOn);
      await spec.setup(graph, args, hud, root);
      return graph;
    })
    .catch((e: unknown) => {
      showError(root, e);
      errors.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      return null;
    });

  // Automation hook: the headless GPU runner drives any story through this
  // (`node scripts/gpu.mjs eval <file> --story <id>`). Errors are collected
  // rather than only shown, so a failed run is detectable without a screenshot.
  (globalThis as { __graphStage?: unknown }).__graphStage = {
    ready: cur.ready,
    errors,
    get graph() {
      return cur.graph;
    },
  };

  return root;
}

/** Destroy the current engine, if any. Safe to call repeatedly. */
export function disposeStage(): void {
  const cur = current;
  if (!cur) return;
  current = null;
  cur.dispose?.();
  cur.hud.detach();
  cur.graph?.destroy();
}

function showError(root: HTMLElement, e: unknown): void {
  const el = document.createElement("div");
  el.className = "stage-error";
  el.textContent = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  root.append(el);
}
