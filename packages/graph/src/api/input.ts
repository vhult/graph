import { GraphError } from "./errors";
import type { GraphInput, Mode, SelectKey, SelectShape } from "./types";

export interface ResolvedInput {
  pan: Mode;
  zoom: Mode;
  rotate: Mode;
  drag: Mode;
  select: Mode;
  selectShape: SelectShape;
  selectKey: SelectKey | null;
  pick: { nodes: boolean; edges: boolean; groups: boolean };
  pickRadius: number;
  edgePickRadius: number;
}

export const DEFAULT_INPUT: ResolvedInput = {
  pan: "auto",
  zoom: "auto",
  rotate: false,
  drag: "auto",
  select: "auto",
  selectShape: "box",
  selectKey: "shift",
  pick: { nodes: true, edges: true, groups: false },
  pickRadius: 0,
  edgePickRadius: 4,
};

export function mergeInput(base: ResolvedInput, partial: GraphInput | undefined): ResolvedInput {
  const p = partial ?? {};
  const pick = p.pick ?? {};
  return {
    pan: p.pan ?? base.pan,
    zoom: p.zoom ?? base.zoom,
    rotate: p.rotate ?? base.rotate,
    drag: p.drag ?? base.drag,
    select: p.select ?? base.select,
    selectShape: p.selectShape ?? base.selectShape,
    selectKey: p.selectKey !== undefined ? p.selectKey : base.selectKey,
    pick: { nodes: pick.nodes ?? base.pick.nodes, edges: pick.edges ?? base.pick.edges, groups: pick.groups ?? base.pick.groups },
    pickRadius: p.pickRadius ?? base.pickRadius,
    edgePickRadius: p.edgePickRadius ?? base.edgePickRadius,
  };
}

function checkRadius(v: number | undefined, name: string): void {
  if (v !== undefined && !(Number.isFinite(v) && v >= 0)) throw new GraphError("invalid-argument", `${name} must be a finite number >= 0, got ${v}`);
}

function checkMode(v: Mode | undefined, name: string): void {
  if (v !== undefined && v !== "auto" && v !== "manual" && v !== false) throw new GraphError("invalid-argument", `${name} must be "auto", "manual" or false, got ${String(v)}`);
}

function checkFlag(v: boolean | undefined, name: string): void {
  if (v !== undefined && typeof v !== "boolean") throw new GraphError("invalid-argument", `${name} must be a boolean, got ${String(v)}`);
}

export function copyInput(partial: GraphInput, name: string): GraphInput {
  const out: GraphInput = {};
  for (const k of ["pan", "zoom", "rotate", "drag", "select"] as const) {
    checkMode(partial[k], `${name}: ${k}`);
    if (partial[k] !== undefined) out[k] = partial[k];
  }
  const shape = partial.selectShape;
  if (shape !== undefined && shape !== "box" && shape !== "lasso") throw new GraphError("invalid-argument", `${name}: selectShape must be "box" or "lasso", got ${String(shape)}`);
  if (shape !== undefined) out.selectShape = shape;
  const key = partial.selectKey;
  if (key !== undefined && key !== null && key !== "shift" && key !== "alt" && key !== "ctrl" && key !== "meta") {
    throw new GraphError("invalid-argument", `${name}: selectKey must be "shift", "alt", "ctrl", "meta" or null, got ${String(key)}`);
  }
  if (key !== undefined) out.selectKey = key;
  const pick = partial.pick;
  if (pick !== undefined) {
    checkFlag(pick.nodes, `${name}: pick.nodes`);
    checkFlag(pick.edges, `${name}: pick.edges`);
    checkFlag(pick.groups, `${name}: pick.groups`);
    out.pick = { ...pick };
  }
  checkRadius(partial.pickRadius, `${name}: pickRadius`);
  checkRadius(partial.edgePickRadius, `${name}: edgePickRadius`);
  if (partial.pickRadius !== undefined) out.pickRadius = partial.pickRadius;
  if (partial.edgePickRadius !== undefined) out.edgePickRadius = partial.edgePickRadius;
  return out;
}
