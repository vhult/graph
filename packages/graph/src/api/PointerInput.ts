/**
 * Main-thread pointer/wheel capture. Converts DOM events to device-px records
 * and hands them to a sink (InputRing or postMessage fallback). Handlers do
 * no layout reads on the hot path: the canvas rect is cached and refreshed
 * only on enter/down/resize/scroll.
 */
import { INPUT, MOD } from "../bridge/InputRing";

export type InputSink = (type: number, t: number, x: number, y: number, dx: number, dy: number, buttons: number, mods: number, button: number) => void;

const LINE_PX = 16;
const HOLD_MS = 500;
const HOLD_SLOP_CSS_PX = 3;

function mods(e: MouseEvent): number {
  const touch = (e as PointerEvent).pointerType === "touch" ? MOD.TOUCH : 0;
  return (e.shiftKey ? MOD.SHIFT : 0) | (e.ctrlKey ? MOD.CTRL : 0) | (e.altKey ? MOD.ALT : 0) | (e.metaKey ? MOD.META : 0) | touch;
}

export class PointerInput {
  menu = false;
  zoom = true;
  private left = 0;
  private top = 0;
  private readonly controller = new AbortController();
  private readonly touchId = [-1, -1];
  private readonly touchX = [0, 0];
  private readonly touchY = [0, 0];
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private holdId = -1;
  private holdX = 0;
  private holdY = 0;
  private holdMods = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sink: InputSink,
    private readonly pixelRatio: () => number,
  ) {
    const opts = { signal: this.controller.signal };
    const passive = { signal: this.controller.signal, passive: true };
    canvas.style.touchAction = "none";
    canvas.style.setProperty("-webkit-touch-callout", "none");
    canvas.style.setProperty("-webkit-user-select", "none");
    canvas.style.userSelect = "none";
    canvas.addEventListener("pointerenter", this.refreshRect, passive);
    canvas.addEventListener("pointerdown", this.onDown, opts);
    canvas.addEventListener("pointermove", this.onMove, passive);
    canvas.addEventListener("pointerup", this.onUp, passive);
    canvas.addEventListener("pointercancel", this.onUp, passive);
    canvas.addEventListener("pointerleave", this.onLeave, passive);
    canvas.addEventListener("wheel", this.onWheel, { signal: this.controller.signal, passive: false });
    canvas.addEventListener("dblclick", this.onDoubleClick, passive);
    canvas.addEventListener("contextmenu", this.onMenu, opts);
    window.addEventListener("scroll", this.refreshRect, { signal: this.controller.signal, passive: true, capture: true });
    this.refreshRect();
  }

  readonly refreshRect = (): void => {
    const r = this.canvas.getBoundingClientRect();
    this.left = r.left;
    this.top = r.top;
  };

  dispose(): void {
    this.controller.abort();
    this.stopHold();
  }

  private emit(type: number, e: MouseEvent, x: number, y: number, dx: number, dy: number, buttons: number, button: number): void {
    const k = this.pixelRatio();
    this.sink(type, e.timeStamp, (x - this.left) * k, (y - this.top) * k, dx, dy, buttons, mods(e), button);
  }

  private push(type: number, e: MouseEvent, dx = 0, dy = 0): void {
    this.emit(type, e, e.clientX, e.clientY, dx, dy, e.buttons, e.button);
  }

  private pushPinch(e: PointerEvent): void {
    const k = this.pixelRatio();
    const ax = this.touchX[0]!;
    const ay = this.touchY[0]!;
    const bx = this.touchX[1]!;
    const by = this.touchY[1]!;
    const dx = bx - ax;
    const dy = by - ay;
    this.sink(INPUT.PINCH, e.timeStamp, ((ax + bx) * 0.5 - this.left) * k, ((ay + by) * 0.5 - this.top) * k, Math.sqrt(dx * dx + dy * dy) * k, Math.atan2(dy, dx), e.buttons, mods(e), e.button);
  }

  private slotOf(id: number): number {
    return this.touchId[0] === id ? 0 : this.touchId[1] === id ? 1 : -1;
  }

  private get pinching(): boolean {
    return this.touchId[0] !== -1 && this.touchId[1] !== -1;
  }

  private readonly onDown = (e: PointerEvent): void => {
    this.refreshRect();
    this.canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === "touch") {
      const slot = this.slotOf(-1);
      if (slot === -1) return;
      this.touchId[slot] = e.pointerId;
      this.touchX[slot] = e.clientX;
      this.touchY[slot] = e.clientY;
      if (this.pinching) {
        this.stopHold();
        this.pushPinch(e);
        return;
      }
    }
    if (this.menu && e.pointerType !== "mouse") this.startHold(e);
    this.push(INPUT.POINTER_DOWN, e);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId === this.holdId && this.holdTimer !== undefined) {
      const dx = e.clientX - this.holdX;
      const dy = e.clientY - this.holdY;
      if (dx * dx + dy * dy > HOLD_SLOP_CSS_PX * HOLD_SLOP_CSS_PX) this.stopHold();
    }
    if (e.pointerType === "touch") {
      const slot = this.slotOf(e.pointerId);
      if (slot === -1) return;
      this.touchX[slot] = e.clientX;
      this.touchY[slot] = e.clientY;
      if (this.pinching) {
        this.pushPinch(e);
        return;
      }
    }
    this.push(INPUT.POINTER_MOVE, e);
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.holdId) this.stopHold();
    if (e.pointerType === "touch") {
      const slot = this.slotOf(e.pointerId);
      if (slot === -1) return;
      const pinching = this.pinching;
      this.touchId[slot] = -1;
      if (pinching) {
        const other = slot ^ 1;
        this.emit(INPUT.POINTER_DOWN, e, this.touchX[other]!, this.touchY[other]!, 0, 0, 1, 0);
        return;
      }
    }
    this.push(INPUT.POINTER_UP, e);
  };

  private readonly onLeave = (e: PointerEvent): void => {
    if (e.pointerType === "touch" && (this.touchId[0] !== -1 || this.touchId[1] !== -1)) return;
    this.push(INPUT.POINTER_LEAVE, e);
  };

  private readonly onDoubleClick = (e: MouseEvent): void => {
    this.push(INPUT.DBLCLICK, e);
  };

  private readonly onMenu = (e: MouseEvent): void => {
    if (!this.menu) return;
    e.preventDefault();
    const type = (e as PointerEvent).pointerType;
    if (this.holdId !== -1 || type === "touch" || type === "pen") return;
    this.push(INPUT.MENU, e);
  };

  private startHold(e: PointerEvent): void {
    this.stopHold();
    this.holdId = e.pointerId;
    this.holdX = e.clientX;
    this.holdY = e.clientY;
    this.holdMods = mods(e);
    this.holdTimer = setTimeout(this.onHold, HOLD_MS);
  }

  private stopHold(): void {
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    this.holdId = -1;
  }

  private readonly onHold = (): void => {
    this.holdTimer = undefined;
    const k = this.pixelRatio();
    this.sink(INPUT.MENU, performance.now(), (this.holdX - this.left) * k, (this.holdY - this.top) * k, 0, 0, 1, this.holdMods, 0);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.zoom) return;
    e.preventDefault();
    const scale = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? this.canvas.clientHeight : 1;
    this.push(INPUT.WHEEL, e, e.deltaX * scale, e.deltaY * scale);
  };
}
