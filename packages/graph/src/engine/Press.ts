export interface PressHost {
  startDrag(node: number, nodeScale: number): void;
  endDrag(): void;
  stopHold(pan: boolean): void;
  click(node: number, edge: number): void;
}

export class Press {
  active = false;
  seq = 0;
  x = 0;
  y = 0;
  private held = false;
  private resolved = false;
  private moved = false;
  private released = false;
  private armed = false;
  private dragging = false;
  private node = -1;
  private edge = -1;
  private nodeScale = 1;

  constructor(private readonly host: PressHost) {}

  get waiting(): boolean {
    return this.active && !this.resolved;
  }

  down(x: number, y: number, hold: boolean): void {
    this.cancel();
    this.active = true;
    this.seq = 0;
    this.x = x;
    this.y = y;
    this.held = hold;
    this.resolved = false;
    this.moved = false;
    this.released = false;
    this.armed = false;
    this.dragging = false;
    this.node = -1;
    this.edge = -1;
  }

  move(x: number, y: number, slopPx: number): void {
    if (!this.active || this.moved) return;
    const dx = x - this.x;
    const dy = y - this.y;
    if (dx * dx + dy * dy <= slopPx * slopPx) return;
    this.moved = true;
    if (this.armed) this.startDrag();
  }

  up(): void {
    if (!this.active) return;
    this.released = true;
    if (this.dragging) {
      this.host.endDrag();
      this.active = false;
    } else if (this.resolved) this.finish();
  }

  resolve(node: number, edge: number, nodeScale: number, drag: boolean): void {
    if (!this.waiting) return;
    this.resolved = true;
    this.node = node;
    this.edge = edge;
    this.nodeScale = nodeScale;
    if (this.held && drag && node >= 0 && (this.moved || !this.released)) {
      if (!this.moved) {
        this.armed = true;
        return;
      }
      this.startDrag();
      if (this.released) {
        this.host.endDrag();
        this.active = false;
      }
      return;
    }
    if (this.released) this.finish();
    else this.dropHold();
  }

  cancel(): void {
    if (!this.active) return;
    this.active = false;
    if (this.dragging) this.host.endDrag();
    else if (this.held) {
      this.held = false;
      this.host.stopHold(false);
    }
  }

  private startDrag(): void {
    this.armed = false;
    this.dragging = true;
    this.host.startDrag(this.node, this.nodeScale);
  }

  private dropHold(): void {
    if (!this.held) return;
    this.held = false;
    this.host.stopHold(true);
  }

  private finish(): void {
    this.active = false;
    this.armed = false;
    this.dropHold();
    if (!this.moved) this.host.click(this.node, this.node >= 0 ? -1 : this.edge);
  }
}
