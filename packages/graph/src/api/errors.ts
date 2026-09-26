/** What went wrong in a `GraphError`. */
export type GraphErrorCode =
  | "webgpu-unavailable"
  | "offscreen-canvas-unavailable"
  | "no-adapter"
  | "compat-mode"
  | "insufficient-limits"
  | "limits-exceeded"
  | "device-failed"
  | "device-lost"
  | "detached-array"
  | "invalid-argument"
  | "destroyed"
  | "internal";

/** An engine error with a code. */
export class GraphError extends Error {
  /** Error class name. */
  override readonly name: string = "GraphError";
  /** Makes an error with a code and a message. */
  constructor(
    /** What went wrong. */
    readonly code: GraphErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** This browser or GPU cannot run the engine. */
export class UnsupportedError extends GraphError {
  /** Error class name. */
  override readonly name = "UnsupportedError";
}

const UNSUPPORTED: ReadonlySet<GraphErrorCode> = new Set([
  "webgpu-unavailable",
  "offscreen-canvas-unavailable",
  "no-adapter",
  "compat-mode",
  "insufficient-limits",
]);

/** Rebuild a typed error from its serialized form (worker → main). */
export function errorFromCode(code: GraphErrorCode, message: string): GraphError {
  return UNSUPPORTED.has(code) ? new UnsupportedError(code, message) : new GraphError(code, message);
}
