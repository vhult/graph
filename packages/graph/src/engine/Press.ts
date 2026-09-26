import type { Mode } from "../api/types";

export interface PressHost {
  startDrag(node: number, nodeScale: number, auto: boolean): void;
  dragTo(): boolean;
  moveDragged(): void;
  endDrag(): void;
  stopHold(pan: boolean): void;
  startShape(): void;
  shapeTo(x: number, y: number): void;
  endShape(): void;
  cancelShape(): void;
  click(node: number, edge: number, x: number, y: number, button: number, mods: number): void;
}

export class Press {
  active = false;
  seq = 0;
  x = 0;
  y = 0;
  private button = 0;
  mods = 0;
  private held = false;
  private resolved = false;
  private moved = false;
  private released = false;
  private armed = false;
  private dragging = false;
  private shape = false;
  private shapeArmed = false;
  private shaping = false;
  private auto = false;
  private node = -1;
  private edge = -1;
  private nodeScale = 1;

  constructor(private readonly host: PressHost) {}

  get waiting(): boolean {
    return this.active && !this.resolved;
  }

  down(x: number, y: number, hold: boolean, button = 0, mods = 0, shape = false): void {
    this.cancel();
    this.active = true;
    this.seq = 0;
    this.x = x;
    this.y = y;
    this.button = button;
    this.mods = mods;
    this.held = hold;
    this.resolved = false;
    this.moved = false;
    this.released = false;
    this.armed = false;
    this.dragging = false;
    this.shape = shape;
    this.shapeArmed = false;
    this.shaping = false;
    this.node = -1;
    this.edge = -1;
  }

  move(x: number, y: number, slopPx: number): void {
    if (!this.active) return;
    if (this.shaping) {
      this.host.shapeTo(x, y);
      return;
    }
    if (this.moved) return;
    const dx = x - this.x;
    const dy = y - this.y;
    if (dx * dx + dy * dy <= slopPx * slopPx) return;
    this.moved = true;
    if (this.armed) this.startDrag();
    else if (this.shapeArmed) this.startShape();
  }

  up(): void {
    if (!this.active) return;
    this.released = true;
    if (this.dragging) {
      this.step();
      this.stopDrag();
      this.active = false;
    } else if (this.shaping) {
      this.shaping = false;
      this.active = false;
      this.host.endShape();
    } else if (this.resolved) this.finish();
  }

  step(): void {
    if (this.dragging && this.host.dragTo() && this.auto) this.host.moveDragged();
  }

  resolve(node: number, edge: number, nodeScale: number, drag: Mode): void {
    if (!this.waiting) return;
    this.resolved = true;
    this.node = node;
    this.edge = edge;
    this.nodeScale = nodeScale;
    if (this.held && drag !== false && node >= 0 && (this.moved || !this.released)) {
      this.auto = drag === "auto";
      if (!this.moved) {
        this.armed = true;
        return;
      }
      this.startDrag();
      if (this.released) {
        this.stopDrag();
        this.active = false;
      }
      return;
    }
    if (this.shape && (this.moved || !this.released)) {
      if (!this.moved) {
        this.shapeArmed = true;
        return;
      }
      this.startShape();
      if (this.released) {
        this.shaping = false;
        this.active = false;
        this.host.endShape();
      }
      return;
    }
    if (this.released) this.finish();
    else this.dropHold();
  }

  cancel(): void {
    if (!this.active) return;
    this.active = false;
    if (this.dragging) this.stopDrag();
    else if (this.shaping) {
      this.shaping = false;
      this.host.cancelShape();
    } else if (this.held) {
      this.held = false;
      this.host.stopHold(false);
    }
  }

  private startDrag(): void {
    this.armed = false;
    this.dragging = true;
    this.host.startDrag(this.node, this.nodeScale, this.auto);
    this.step();
  }

  private startShape(): void {
    this.shapeArmed = false;
    this.shaping = true;
    this.host.startShape();
  }

  private stopDrag(): void {
    this.dragging = false;
    this.host.endDrag();
  }

  private dropHold(): void {
    if (!this.held) return;
    this.held = false;
    this.host.stopHold(true);
  }

  private finish(): void {
    this.active = false;
    this.armed = false;
    this.shapeArmed = false;
    this.dropHold();
    if (!this.moved) this.host.click(this.node, this.edge, this.x, this.y, this.button, this.mods);
  }
}
