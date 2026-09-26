/**
 * Main ↔ worker messages. Bulk data travels as transferred ArrayBuffers; the
 * hot paths (pointer input, stats, camera readback) go through shared memory
 * and never produce a message in steady state.
 */
import type { GraphErrorCode } from "../api/errors";
import type { ResolvedInput } from "../api/input";
import type { ResolvedStyle } from "../api/style";
import type { BenchmarkOptions, BenchmarkResult, CameraEasing, CameraView, DebugTune, GraphCaps, GraphInput, GraphStyle, Hit, IconSource, LabelSnapshot, PanEvent, RotateEvent, SelectEvent, WorldBounds, ZoomEvent } from "../api/types";
import type { NodeArrays } from "../data/GraphStore";

export type DebugLevel = 0 | 1 | 2;

export type DragEventName = "dragStart" | "drag" | "dragEnd";

export type HitEventName = "hover" | "click" | "doubleClick" | "contextMenu";

export type GestureEventName = "pan" | "zoom" | "rotate";

export type WorkerEventName = HitEventName | DragEventName | GestureEventName | "select" | "view";

export const WORKER_EVENTS: readonly WorkerEventName[] = ["hover", "click", "doubleClick", "contextMenu", "dragStart", "drag", "dragEnd", "select", "pan", "zoom", "rotate", "view"];

export type GestureMessage = { t: "pan"; event: PanEvent } | { t: "zoom"; event: ZoomEvent } | { t: "rotate"; event: RotateEvent };

export type MessageTotals = Record<string, [count: number, totalMs: number, maxMs: number]>;

export interface InitOptions {
  style: ResolvedStyle;
  input: ResolvedInput;
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
  | { t: "inputRecord"; r: [type: number, time: number, x: number, y: number, dx: number, dy: number, buttons: number, mods: number, button: number] }
  | { t: "input"; input: GraphInput }
  | ({ t: "nodes"; count: number; labels?: string[] } & NodeArrays)
  | ({ t: "updateNodes"; start: number; labels?: string[] | null } & NodeArrays)
  | ({ t: "updateNodesAt"; indices: Uint32Array; labels?: string[] } & NodeArrays)
  | ({ t: "addNodes"; indices: Uint32Array; slots: number; labels?: string[] } & NodeArrays)
  | { t: "removeNodes"; id: number; indices: Uint32Array }
  | { t: "compactNodes"; remap: Uint32Array }
  | { t: "flagNodes"; indices: Uint32Array | null; flags: number; on: boolean }
  | { t: "defineIcons"; id: number; icons: IconSource[] }
  | { t: "setIcons"; id: number; ids: Uint16Array; icons: IconSource[] }
  | { t: "removeIcons"; ids: Uint16Array }
  | { t: "edges"; count: number; indices?: Uint32Array; styles?: Uint32Array; colors?: Uint32Array; labels?: string[] }
  | { t: "addEdges"; indices: Uint32Array; count: number; ends: Uint32Array; styles?: Uint32Array; colors?: Uint32Array; labels?: string[] }
  | { t: "removeEdges"; indices: Uint32Array }
  | { t: "updateEdgesAt"; indices: Uint32Array; ends?: Uint32Array; styles?: Uint32Array; colors?: Uint32Array; labels?: string[] }
  | { t: "updateEdges"; ends?: Uint32Array; styles?: Uint32Array; colors?: Uint32Array; labels?: string[] | null }
  | { t: "flagEdges"; indices: Uint32Array | null; flags: number; on: boolean }
  | { t: "compactEdges"; remap: Uint32Array }
  | { t: "nodeStream"; buffer: SharedArrayBuffer; count: number; positions: boolean; colors: boolean; zIndex: boolean }
  | { t: "view"; view: Partial<CameraView>; duration?: number; easing?: CameraEasing }
  | { t: "fit"; padding: number; nodes?: Uint32Array; bounds?: WorldBounds; duration: number }
  | { t: "rotate"; angle: number; x?: number; y?: number; duration: number }
  | { t: "limits"; minZoom: number; maxZoom: number; bounds: WorldBounds | null }
  | { t: "listen"; events: WorkerEventName[] }
  | { t: "style"; style: GraphStyle }
  | { t: "render" }
  | { t: "benchmark"; id: number; options: BenchmarkOptions }
  | { t: "labelSnapshot"; id: number }
  | { t: "snapshot"; id: number; type: string }
  | { t: "queryAt"; id: number; x: number; y: number }
  | { t: "queryInside"; id: number; points: Float32Array }
  | { t: "tune"; tune: DebugTune }
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
  | { t: "snapshot"; id: number; blob?: Blob; code?: GraphErrorCode; message?: string }
  | { t: "icons"; id: number; code?: GraphErrorCode; message?: string }
  | { t: "edgesRemoved"; id: number; edges: Uint32Array }
  | { t: "queryAt"; id: number; hit: Hit }
  | { t: "queryInside"; id: number; nodes?: Uint32Array; code?: GraphErrorCode; message?: string }
  | { t: HitEventName; hit: Hit }
  | GestureMessage
  | { t: "dragStart"; index: number; nodes: Uint32Array; x: number; y: number }
  | { t: "drag" | "dragEnd"; index: number; dx: number; dy: number }
  | ({ t: "select" } & SelectEvent)
  | { t: "view"; x: number; y: number; zoom: number; rotation: number }
  | { t: "debugRing"; columns: string[]; gpuGroups: string[]; frames: number; buffer: SharedArrayBuffer | null }
  | { t: "debugRows"; data: Float64Array }
  | { t: "debugTotals"; messages: MessageTotals }
  | { t: "debugRecording"; columns: string[]; gpuGroups: string[]; data: Float64Array; rows: number; durationMs: number; messages: MessageTotals }
  | { t: "destroyed" };
