/**
 * Pan / zoom controls, applied in the worker from InputRing records.
 * Pointer coordinates are absolute device px, so coalescing moves loses nothing.
 */
import type { Mode } from "../api/types";
import { INPUT, MOD, type InputRecord } from "../bridge/InputRing";
import { type Camera2D, wrapAngle } from "./Camera2D";

const WHEEL_ZOOM_SPEED = 0.0015;
/** Trackpad pinch arrives as ctrl+wheel with small deltas. */
const PINCH_ZOOM_SPEED = 0.01;

/**
 * Time constant of the zoom glide, seconds. A wheel notch sets a target and the
 * camera approaches it exponentially, so ONE event produces many frames.
 *
 * Measured before this existed: the engine rendered exactly one frame per input
 * event (90 drag events -> 90 frames), so smoothness was capped by however fast
 * the wheel happened to fire — 10 events/s rendered 7.8 fps at deep zoom while
 * the GPU used 3.3 ms of its 16.7 ms budget. Input latency was never the
 * problem; median input->frame was 0.9 ms.
 *
 * ~0.05 s reaches 90 % in about 7 frames at 60 Hz. Panning is deliberately NOT
 * smoothed: a drag is already 1:1 with the pointer, and easing it would only add
 * lag to a gesture that tracks correctly today.
 */
const ZOOM_TAU_S = 0.05;
/** Below this remaining log-zoom, finish in one step rather than creep. */
const ZOOM_EPSILON = 1e-4;
/** Longest dt honoured, seconds: after an idle sleep the gap is meaningless. */
const MAX_STEP_S = 0.1;
const WHEEL_END_MS = 150;
const TURN = Math.PI * 2;

export class Gesture {
  dirty = false;
  sent = false;
  ended = false;
  dx = 0;
  dy = 0;
  factor = 1;
  angle = 0;
  x = 0;
  y = 0;
  mods = 0;

  at(x: number, y: number, mods: number): void {
    this.dirty = true;
    this.x = x;
    this.y = y;
    this.mods = mods;
  }

  end(): void {
    if (this.dirty || this.sent) this.ended = true;
  }

  clear(): void {
    this.dirty = false;
    this.dx = 0;
    this.dy = 0;
    this.factor = 1;
    this.angle = 0;
  }
}

export class Controls {
  panMode: Mode = "auto";
  zoomMode: Mode = "auto";
  rotateMode: Mode = false;
  hold = false;
  pinching = false;
  readonly panGesture = new Gesture();
  readonly zoomGesture = new Gesture();
  readonly rotateGesture = new Gesture();
  /** Last pointer position, device px; -1 when outside the canvas. */
  pointerX = -1;
  pointerY = -1;
  private dragging = false;
  private mods = 0;
  /** Natural log of the zoom factor still to be applied. 0 when settled. */
  private pendingZoomLog = 0;
  private anchorX = 0;
  private anchorY = 0;
  private pinchX = 0;
  private pinchY = 0;
  private pinchDist = 0;
  private pinchAngle = 0;
  private wheeling = false;
  private wheelStep = false;
  private wheelMs = 0;

  /** Apply one record. Returns true if the camera changed. */
  apply(rec: InputRecord, camera: Camera2D): boolean {
    this.mods = rec.mods;
    switch (rec.type) {
      case INPUT.POINTER_DOWN:
        this.endPinch();
        this.panGesture.end();
        this.pointerX = rec.x;
        this.pointerY = rec.y;
        this.dragging = this.panMode !== false && (rec.buttons & 1) !== 0;
        return false;

      case INPUT.POINTER_MOVE: {
        const dx = rec.x - this.pointerX;
        const dy = rec.y - this.pointerY;
        const wasInside = this.pointerX >= 0;
        this.pointerX = rec.x;
        this.pointerY = rec.y;
        if (this.hold || !this.dragging || !wasInside || (rec.buttons & 1) === 0 || this.panMode === false) {
          if ((rec.buttons & 1) === 0 && this.dragging) {
            this.dragging = false;
            this.panGesture.end();
          }
          return false;
        }
        if (dx === 0 && dy === 0) return false;
        return this.panBy(dx, dy, rec.x, rec.y, camera);
      }

      case INPUT.POINTER_UP:
        this.endPinch();
        this.dragging = false;
        this.panGesture.end();
        return false;

      case INPUT.POINTER_LEAVE:
        this.endPinch();
        if (!this.dragging) this.pointerX = this.pointerY = -1;
        return false;

      case INPUT.WHEEL: {
        if (this.zoomMode === false || rec.dy === 0) return false;
        const speed = (rec.mods & MOD.CTRL) !== 0 ? PINCH_ZOOM_SPEED : WHEEL_ZOOM_SPEED;
        const step = -rec.dy * speed;
        const g = this.zoomGesture;
        g.factor *= Math.exp(step);
        g.at(rec.x, rec.y, rec.mods);
        this.wheeling = true;
        this.wheelStep = true;
        if (this.zoomMode !== "auto") return false;
        // Accumulate into the target; `advance` applies it over several frames.
        // Notches that arrive mid-glide simply add, so fast scrolling stays
        // responsive instead of queueing.
        this.pendingZoomLog += step;
        this.anchorX = rec.x;
        this.anchorY = rec.y;
        return true;
      }

      case INPUT.PINCH: {
        const dx = rec.x - this.pinchX;
        const dy = rec.y - this.pinchY;
        const factor = this.pinchDist > 0 && rec.dx > 0 ? rec.dx / this.pinchDist : 1;
        let turn = rec.dy - this.pinchAngle;
        turn -= TURN * Math.round(turn / TURN);
        const anchor = !this.pinching;
        this.pinching = true;
        this.pinchX = rec.x;
        this.pinchY = rec.y;
        this.pinchDist = rec.dx;
        this.pinchAngle = rec.dy;
        if (anchor) {
          this.pendingZoomLog = 0;
          return false;
        }
        let moved = false;
        if ((dx !== 0 || dy !== 0) && this.panMode !== false) moved = this.panBy(dx, dy, rec.x, rec.y, camera);
        if (factor !== 1 && this.zoomMode !== false) {
          const g = this.zoomGesture;
          g.factor *= factor;
          g.at(rec.x, rec.y, rec.mods);
          if (this.zoomMode === "auto") {
            camera.zoomAt(factor, rec.x, rec.y);
            moved = true;
          }
        }
        if (turn !== 0 && this.rotateMode !== false) {
          const g = this.rotateGesture;
          g.angle += turn;
          g.at(rec.x, rec.y, rec.mods);
          if (this.rotateMode === "auto") {
            camera.rotateAround(turn, rec.x, rec.y);
            camera.rotation = wrapAngle(camera.rotation);
            moved = true;
          }
        }
        return moved;
      }
    }
    return false;
  }

  /**
   * Advance the zoom glide by `dt` seconds. Returns true if the camera moved,
   * which is what keeps the frame loop awake; once settled it returns false and
   * the engine goes idle exactly as before — no frames are spent on a still view.
   */
  advance(dt: number, camera: Camera2D): boolean {
    const pending = this.pendingZoomLog;
    if (pending === 0) return false;
    // Exponential approach, framerate-independent: the same wall-clock glide
    // whether frames arrive every 4 ms or every 40.
    const alpha = 1 - Math.exp(-Math.min(dt, MAX_STEP_S) / ZOOM_TAU_S);
    let step = pending * alpha;
    if (Math.abs(pending - step) < ZOOM_EPSILON) step = pending; // land exactly
    const before = camera.zoom;
    camera.zoomAt(Math.exp(step), this.anchorX, this.anchorY);
    if (camera.zoom === before) {
      this.pendingZoomLog = 0; // clamped at a zoom limit, or converged
      return false;
    }
    this.pendingZoomLog = pending - step;
    return true;
  }

  settleWheel(nowMs: number): number {
    if (!this.wheeling) return 0;
    if (this.wheelStep) {
      this.wheelStep = false;
      this.wheelMs = nowMs;
    }
    const left = this.wheelMs + WHEEL_END_MS - nowMs;
    if (left > 0) return left;
    this.wheeling = false;
    this.zoomGesture.end();
    return 0;
  }

  release(fromX: number, fromY: number, camera: Camera2D): boolean {
    this.hold = false;
    if (!this.dragging) return false;
    const dx = this.pointerX - fromX;
    const dy = this.pointerY - fromY;
    if (dx === 0 && dy === 0) return false;
    return this.panBy(dx, dy, this.pointerX, this.pointerY, camera);
  }

  /** Drop any in-flight glide; a programmatic view change wins outright. */
  cancelZoom(): void {
    this.pendingZoomLog = 0;
  }

  private panBy(dx: number, dy: number, x: number, y: number, camera: Camera2D): boolean {
    const g = this.panGesture;
    g.dx += dx;
    g.dy += dy;
    g.at(x, y, this.mods);
    if (this.panMode !== "auto") return false;
    camera.panByScreen(dx, dy);
    return true;
  }

  private endPinch(): void {
    if (!this.pinching) return;
    this.pinching = false;
    this.wheeling = false;
    this.panGesture.end();
    this.zoomGesture.end();
    this.rotateGesture.end();
  }
}
