import type { DebugTune, EdgeDebugMode } from "../api/types";

export const EDGE_DEBUG_MODES: readonly EdgeDebugMode[] = ["off", "length", "thinning", "chunk"];

export interface Tune {
  lodTargetPx: number;
  maxOverdraw: number;
  minLengthPx: number;
  debug: number;
  arrows: boolean;
  curved: boolean;
}

export interface Tunable {
  loadTune(t: Tune): Promise<unknown>;
  hasTune(t: Tune): boolean;
  useTune(t: Tune): void;
}

export const DEFAULT_TUNE: Readonly<Tune> = { lodTargetPx: 2.5, maxOverdraw: 1.5, minLengthPx: 6, debug: 0, arrows: false, curved: false };

export function applyTune(t: Tune, d: DebugTune): void {
  if (d.lodTargetPx !== undefined) t.lodTargetPx = d.lodTargetPx;
  if (d.edgeMaxOverdraw !== undefined) t.maxOverdraw = d.edgeMaxOverdraw;
  if (d.edgeMinLengthPx !== undefined) t.minLengthPx = d.edgeMinLengthPx;
  if (d.edgeMode !== undefined) t.debug = EDGE_DEBUG_MODES.indexOf(d.edgeMode);
}

export function sameTune(a: Tune, b: Tune): boolean {
  return a.lodTargetPx === b.lodTargetPx && a.maxOverdraw === b.maxOverdraw && a.minLengthPx === b.minLengthPx && a.debug === b.debug && a.arrows === b.arrows && a.curved === b.curved;
}

export function lodKey(t: Tune): string {
  return String(t.lodTargetPx);
}

export function edgeKey(t: Tune): string {
  return `${t.arrows ? 1 : 0}|${t.curved ? 1 : 0}|${t.maxOverdraw}|${t.minLengthPx}|${t.debug}`;
}

export function edgeConstants(t: Tune): Record<string, number> {
  return { EDGE_ARROWS: t.arrows ? 1 : 0, EDGE_MAX_OVERDRAW: t.maxOverdraw, EDGE_MIN_LEN_PX: t.minLengthPx, EDGE_DEBUG: t.debug, EDGE_CURVE: t.curved ? 1 : 0 };
}
