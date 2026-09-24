/**
 * Main ↔ worker messages. Bulk data travels as transferred ArrayBuffers; the
 * hot paths (pointer input, stats, camera readback) go through shared memory
 * and never produce a message in steady state.
 */
import type { GraphErrorCode } from "../api/errors";
import type { BenchmarkOptions, BenchmarkResult, CameraView, EdgeDebugMode, GraphCaps, HoverStyle, LabelSnapshot, RGBA } from "../api/types";

export type DebugLevel = 0 | 1 | 2;

export type DragEventName = "nodeDragStart" | "nodeDrag" | "nodeDragEnd";

export type MessageTotals = Record<string, [count: number, totalMs: number, maxMs: number]>;

export interface InitOptions {
  background: RGBA;
  transparent: boolean;
  controls: boolean;
  nodeScale: number;
  /** Device-px spacing below which nodes merge into LOD clusters; 0 disables. */
  lodTargetPx: number;
  /** Width of an edge with no per-edge width, device px. */
  edgeWidth: number;
  /** Tint for edges with no per-edge colour, straight alpha. */
  edgeColor: RGBA;
  /** Compile the arrowhead into the edge pipeline (wider quad, more fill). */
  directedEdges: boolean;
  /** How much crowded areas of edges are thinned: lower draws fewer edges; 0 = never. */
  edgeMaxOverdraw: number;
  /** Edges this short on screen or shorter are not drawn, CSS px. */
  edgeMinLengthPx: number;
  edgeDebug: EdgeDebugMode;
  /** Node label size, CSS px; edge labels are a little smaller. */
  labelSize: number;
  labelPadding: number;
  labelFont: string;
  pickRate: number;
  pickRadius: number;
  edgePickRadius: number;
  hoverStyle: Required<HoverStyle> | null;
  nodeDrag: boolean;
  timeOrigin: number;
}

export type ToWorker =
  | {
      t: "init";
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      pixelRatio: number;
      /** SharedArrayBuffer for InputRing, or null when not cross-origin isolated. */
      ring: SharedArrayBuffer | null;
      /** Shared state block (see SharedState.ts), or null. */
      state: SharedArrayBuffer | null;
      options: InitOptions;
    }
  | { t: "resize"; width: number; height: number; pixelRatio: number }
  | { t: "wake" }
  /** Fallback input path (no SharedArrayBuffer): numbers only, same fields as a ring record. */
  | { t: "input"; r: [type: number, time: number, x: number, y: number, dx: number, dy: number, buttons: number, mods: number] }
  | { t: "nodes"; count: number; positions?: Float32Array; colors?: Uint32Array; sizes?: Float32Array; shapes?: Uint8Array; zIndex?: Uint8Array }
  | { t: "edges"; count: number; indices?: Uint32Array; styles?: Uint32Array; colors?: Uint32Array }
  | { t: "nodeLabels"; labels: string[] }
  | { t: "edgeLabels"; labels: string[] }
  | { t: "updatePositions"; start: number; data: Float32Array }
  | { t: "nodeStream"; buffer: SharedArrayBuffer; count: number; positions: boolean; colors: boolean }
  | { t: "updateColor"; index: number; rgba: number }
  | { t: "view"; view: Partial<CameraView> }
  | { t: "fit"; padding: number }
  | { t: "background"; rgba: RGBA }
  | { t: "nodeScale"; value: number }
  | { t: "render" }
  | { t: "benchmark"; id: number; options: BenchmarkOptions }
  | { t: "labelSnapshot"; id: number }
  | { t: "pick"; hover: number; click: number; drag: boolean }
  | { t: "nodeDrag"; on: boolean }
  | { t: "debug"; level: DebugLevel }
  | { t: "debugRecord"; on: boolean }
  | { t: "destroy" };

export type FromWorker =
  | { t: "ready"; caps: GraphCaps }
  | { t: "error"; code: GraphErrorCode; message: string; fatal: boolean }
  /** Fallback state snapshot when the state block is not shared. */
  | { t: "state"; data: Float64Array }
  | { t: "benchmark"; id: number; result: BenchmarkResult }
  | { t: "labelSnapshot"; id: number; snapshot: LabelSnapshot }
  | { t: "hover"; node?: number; edge?: number }
  | { t: "click"; node?: number; edge?: number }
  | { t: "drag"; event: DragEventName; index: number; x: number; y: number }
  | { t: "debugRing"; columns: string[]; gpuGroups: string[]; frames: number; buffer: SharedArrayBuffer | null }
  | { t: "debugRows"; data: Float64Array }
  | { t: "debugTotals"; messages: MessageTotals }
  | { t: "debugRecording"; columns: string[]; gpuGroups: string[]; data: Float64Array; rows: number; durationMs: number; messages: MessageTotals }
  | { t: "destroyed" };
