/**
 * 2D camera. State is f64 (JS numbers); the GPU receives the centre as a
 * hi/lo f32 pair so deep zooms far from the origin stay stable.
 *
 * Conventions: world y points down (same as screen). `zoom` is device px per
 * world unit. Screen coordinates are device px, origin top-left.
 *
 *   screen = R(rotation) * (world - centre) * zoom + viewport / 2
 */
import type { CameraView } from "../api/types";
import type { Bounds } from "../data/GraphStore";

export const MIN_ZOOM = 1e-6;
export const MAX_ZOOM = 1e6;
const TURN = Math.PI * 2;

export function wrapAngle(a: number): number {
  return a - TURN * Math.ceil((a - Math.PI) / TURN);
}

export function nearestAngle(from: number, to: number): number {
  return from + wrapAngle(to - from);
}

export class Camera2D {
  x = 0;
  y = 0;
  zoom = 1;
  rotation = 0;
  viewportW = 1;
  viewportH = 1;
  minZoom = MIN_ZOOM;
  maxZoom = MAX_ZOOM;
  bounds: Bounds | null = null;
  private readonly pivot = { x: 0, y: 0 };

  setViewport(w: number, h: number): void {
    this.viewportW = Math.max(1, w);
    this.viewportH = Math.max(1, h);
  }

  setLimits(minZoom: number, maxZoom: number, bounds: Bounds | null): void {
    this.minZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, minZoom));
    this.maxZoom = Math.max(this.minZoom, Math.min(MAX_ZOOM, maxZoom));
    this.bounds = bounds;
    this.zoom = this.clampZoom(this.zoom);
    this.clampCentre();
  }

  setView(v: Partial<CameraView>): void {
    if (v.x !== undefined) this.x = v.x;
    if (v.y !== undefined) this.y = v.y;
    if (v.zoom !== undefined) this.zoom = this.clampZoom(v.zoom);
    if (v.rotation !== undefined) this.rotation = v.rotation;
    this.clampCentre();
  }

  /** Pan by a screen-space delta (device px); content follows the pointer. */
  panByScreen(dx: number, dy: number): void {
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    // inverse rotation of the screen delta
    this.x -= (c * dx + s * dy) / this.zoom;
    this.y -= (-s * dx + c * dy) / this.zoom;
    this.clampCentre();
  }

  /** Multiply zoom by `factor`, keeping the world point under (sx, sy) fixed. */
  zoomAt(factor: number, sx: number, sy: number): void {
    const next = this.clampZoom(this.zoom * factor);
    if (next === this.zoom) return;
    // world point under cursor: centre + R^-1 * (s - vp/2) / zoom
    const ox = sx - this.viewportW * 0.5;
    const oy = sy - this.viewportH * 0.5;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    const rx = c * ox + s * oy;
    const ry = -s * ox + c * oy;
    const k = 1 / this.zoom - 1 / next;
    this.x += rx * k;
    this.y += ry * k;
    this.zoom = next;
    this.clampCentre();
  }

  fitRotated(b: Bounds, padding: number): void {
    this.x = (b.minX + b.maxX) * 0.5;
    this.y = (b.minY + b.maxY) * 0.5;
    this.zoom = this.fitZoom(b, padding, this.rotation);
    this.clampCentre();
  }

  /** Zoom at which `b` fits the viewport with `padding` device px per side. */
  fitZoom(b: Bounds, padding: number, rotation = 0): number {
    return this.clampZoom(Camera2D.fitZoomIn(b, padding, this.viewportW, this.viewportH, rotation));
  }

  static fitZoomIn(b: Bounds, padding: number, viewportW: number, viewportH: number, rotation = 0): number {
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;
    const c = Math.abs(Math.cos(rotation));
    const s = Math.abs(Math.sin(rotation));
    const w = Math.max(c * bw + s * bh, 1e-9);
    const h = Math.max(s * bw + c * bh, 1e-9);
    const availW = Math.max(1, viewportW - padding * 2);
    const availH = Math.max(1, viewportH - padding * 2);
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(availW / w, availH / h)));
  }

  rotateAround(angle: number, sx: number, sy: number): void {
    const p = this.pivot;
    this.screenToWorld(sx, sy, p);
    this.rotation += angle;
    this.pin(p.x, p.y, sx, sy);
  }

  pin(wx: number, wy: number, sx: number, sy: number): void {
    const ox = (sx - this.viewportW * 0.5) / this.zoom;
    const oy = (sy - this.viewportH * 0.5) / this.zoom;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    this.x = wx - (c * ox + s * oy);
    this.y = wy - (-s * ox + c * oy);
    this.clampCentre();
  }

  worldToScreen(wx: number, wy: number, out: { x: number; y: number }): void {
    const dx = (wx - this.x) * this.zoom;
    const dy = (wy - this.y) * this.zoom;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    out.x = c * dx - s * dy + this.viewportW * 0.5;
    out.y = s * dx + c * dy + this.viewportH * 0.5;
  }

  screenToWorld(sx: number, sy: number, out: { x: number; y: number }): void {
    const ox = (sx - this.viewportW * 0.5) / this.zoom;
    const oy = (sy - this.viewportH * 0.5) / this.zoom;
    const c = Math.cos(this.rotation);
    const s = Math.sin(this.rotation);
    out.x = this.x + c * ox + s * oy;
    out.y = this.y - s * ox + c * oy;
  }

  private clampZoom(z: number): number {
    return Math.min(this.maxZoom, Math.max(this.minZoom, z));
  }

  private clampCentre(): void {
    const b = this.bounds;
    if (!b) return;
    this.x = Math.min(b.maxX, Math.max(b.minX, this.x));
    this.y = Math.min(b.maxY, Math.max(b.minY, this.y));
  }
}
