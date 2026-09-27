import type { GraphStyle, HighlightLook, RGBA } from "./types";

export interface ResolvedLook {
  outline: { color: RGBA; scale: number; minWidth: number; maxWidth: number };
  edgeColor: RGBA;
  edgeWidth: number;
}

export interface ResolvedStyle {
  background: RGBA;
  nodeScale: number;
  edge: { color: RGBA; width: number };
  label: { size: number; font: string; color: RGBA; padding: number };
  icon: { scale: number; minPx: number };
  hover: ResolvedLook | false;
  selected: ResolvedLook;
  focused: ResolvedLook;
  dimmed: { alpha: number };
  selection: { fill: RGBA; stroke: RGBA };
}

const DEFAULT_LOOK: ResolvedLook = { outline: { color: [1, 1, 1, 1], scale: 0.08, minWidth: 3, maxWidth: 12 }, edgeColor: [1, 1, 1, 1], edgeWidth: 2 };

export const DEFAULT_STYLE: ResolvedStyle = {
  background: [0.04, 0.04, 0.06, 1],
  nodeScale: 1,
  edge: { color: [0.24, 0.27, 0.31, 0.4], width: 1 },
  label: { size: 12, font: "system-ui, -apple-system, 'Segoe UI', sans-serif", color: [0.914, 0.929, 0.953, 1], padding: 2 },
  icon: { scale: 0.6, minPx: 6 },
  hover: DEFAULT_LOOK,
  selected: DEFAULT_LOOK,
  focused: DEFAULT_LOOK,
  dimmed: { alpha: 0.25 },
  selection: { fill: [0.29, 0.63, 1, 0.12], stroke: [0.29, 0.63, 1, 0.9] },
};

const rgba = (c: RGBA): RGBA => [c[0], c[1], c[2], c[3]];

function mergeLook(base: ResolvedLook, l: HighlightLook | undefined): ResolvedLook {
  const o = l?.outline ?? {};
  const b = base.outline;
  return {
    outline: {
      color: rgba(o.color ?? b.color),
      scale: Math.max(0, o.scale ?? b.scale),
      minWidth: Math.max(0, o.minWidth ?? b.minWidth),
      maxWidth: Math.max(0, o.maxWidth ?? b.maxWidth),
    },
    edgeColor: rgba(l?.edgeColor ?? base.edgeColor),
    edgeWidth: Math.max(0, l?.edgeWidth ?? base.edgeWidth),
  };
}

export function mergeStyle(base: ResolvedStyle, s: GraphStyle): ResolvedStyle {
  const e = s.edge ?? {};
  const l = s.label ?? {};
  const i = s.icon ?? {};
  return {
    background: rgba(s.background ?? base.background),
    nodeScale: Math.max(0, s.nodeScale ?? base.nodeScale),
    edge: { color: rgba(e.color ?? base.edge.color), width: Math.max(0, e.width ?? base.edge.width) },
    label: {
      size: Math.max(1, l.size ?? base.label.size),
      font: l.font ?? base.label.font,
      color: rgba(l.color ?? base.label.color),
      padding: Math.max(0, l.padding ?? base.label.padding),
    },
    icon: { scale: Math.min(1, Math.max(0.01, i.scale ?? base.icon.scale)), minPx: Math.max(0, i.minPx ?? base.icon.minPx) },
    hover: s.hover === false || (s.hover === undefined && base.hover === false) ? false : mergeLook(base.hover === false ? DEFAULT_LOOK : base.hover, s.hover),
    selected: mergeLook(base.selected, s.selected),
    focused: mergeLook(base.focused, s.focused),
    dimmed: { alpha: Math.min(1, Math.max(0, s.dimmed?.alpha ?? base.dimmed.alpha)) },
    selection: { fill: rgba(s.selection?.fill ?? base.selection.fill), stroke: rgba(s.selection?.stroke ?? base.selection.stroke) },
  };
}

export function resolveStyle(s: GraphStyle | undefined): ResolvedStyle {
  return mergeStyle(DEFAULT_STYLE, s ?? {});
}
