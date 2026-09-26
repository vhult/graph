import type { CameraEasing, CameraView } from "../api/types";

export class CameraAnimation {
  private readonly from: CameraView = { x: 0, y: 0, zoom: 1, rotation: 0 };
  private readonly to: CameraView = { x: 0, y: 0, zoom: 1, rotation: 0 };
  private logFrom = 0;
  private logTo = 0;
  private startMs = 0;
  private durationMs = 0;
  private ease = false;
  private running = false;

  get active(): boolean {
    return this.running;
  }

  start(from: CameraView, to: CameraView, durationMs: number, easing: CameraEasing, nowMs: number): void {
    copyView(from, this.from);
    copyView(to, this.to);
    this.logFrom = Math.log(from.zoom);
    this.logTo = Math.log(to.zoom);
    this.startMs = nowMs;
    this.durationMs = durationMs;
    this.ease = easing === "ease";
    this.running = true;
  }

  step(nowMs: number, out: CameraView): boolean {
    const t = this.durationMs > 0 ? (nowMs - this.startMs) / this.durationMs : 1;
    if (t >= 1) {
      copyView(this.to, out);
      this.running = false;
      return false;
    }
    const c = Math.max(0, t);
    const u = this.ease ? c * c * (3 - 2 * c) : c;
    const a = this.from;
    const b = this.to;
    out.x = a.x + (b.x - a.x) * u;
    out.y = a.y + (b.y - a.y) * u;
    out.zoom = Math.exp(this.logFrom + (this.logTo - this.logFrom) * u);
    out.rotation = a.rotation + (b.rotation - a.rotation) * u;
    return true;
  }

  cancel(): void {
    this.running = false;
  }
}

function copyView(src: CameraView, dst: CameraView): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.zoom = src.zoom;
  dst.rotation = src.rotation;
}
