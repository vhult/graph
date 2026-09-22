/**
 * Main-thread pointer/wheel capture. Converts DOM events to device-px records
 * and hands them to a sink (InputRing or postMessage fallback). Handlers do
 * no layout reads on the hot path: the canvas rect is cached and refreshed
 * only on enter/down/resize/scroll.
 */
import { INPUT, MOD } from "../bridge/InputRing";

export type InputSink = (type: number, t: number, x: number, y: number, dx: number, dy: number, buttons: number, mods: number) => void;

const LINE_PX = 16;

function mods(e: MouseEvent): number {
  return (e.shiftKey ? MOD.SHIFT : 0) | (e.ctrlKey ? MOD.CTRL : 0) | (e.altKey ? MOD.ALT : 0) | (e.metaKey ? MOD.META : 0);
}

export class PointerInput {
  private left = 0;
  private top = 0;
  private readonly controller = new AbortController();
  private readonly touchId = [-1, -1];
  private readonly touchX = [0, 0];
  private readonly touchY = [0, 0];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sink: InputSink,
    private readonly pixelRatio: () => number,
  ) {
    const opts = { signal: this.controller.signal };
    const passive = { signal: this.controller.signal, passive: true };
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerenter", this.refreshRect, passive);
    canvas.addEventListener("pointerdown", this.onDown, opts);
    canvas.addEventListener("pointermove", this.onMove, passive);
    canvas.addEventListener("pointerup", this.onUp, passive);
    canvas.addEventListener("pointercancel", this.onUp, passive);
    canvas.addEventListener("pointerleave", this.onLeave, passive);
    canvas.addEventListener("wheel", this.onWheel, { signal: this.controller.signal, passive: false });
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
  }

  private emit(type: number, e: MouseEvent, x: number, y: number, dx: number, dy: number, buttons: number): void {
    const k = this.pixelRatio();
    this.sink(type, e.timeStamp, (x - this.left) * k, (y - this.top) * k, dx, dy, buttons, mods(e));
  }

  private push(type: number, e: MouseEvent, dx = 0, dy = 0): void {
    this.emit(type, e, e.clientX, e.clientY, dx, dy, e.buttons);
  }

  private pushPinch(e: PointerEvent): void {
    const k = this.pixelRatio();
    const ax = this.touchX[0]!;
    const ay = this.touchY[0]!;
    const bx = this.touchX[1]!;
    const by = this.touchY[1]!;
    const dx = bx - ax;
    const dy = by - ay;
    this.sink(INPUT.PINCH, e.timeStamp, ((ax + bx) * 0.5 - this.left) * k, ((ay + by) * 0.5 - this.top) * k, Math.sqrt(dx * dx + dy * dy) * k, 0, e.buttons, mods(e));
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
        this.pushPinch(e);
        return;
      }
    }
    this.push(INPUT.POINTER_DOWN, e);
  };

  private readonly onMove = (e: PointerEvent): void => {
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
    if (e.pointerType === "touch") {
      const slot = this.slotOf(e.pointerId);
      if (slot === -1) return;
      const pinching = this.pinching;
      this.touchId[slot] = -1;
      if (pinching) {
        const other = slot ^ 1;
        this.emit(INPUT.POINTER_DOWN, e, this.touchX[other]!, this.touchY[other]!, 0, 0, 1);
        return;
      }
    }
    this.push(INPUT.POINTER_UP, e);
  };

  private readonly onLeave = (e: PointerEvent): void => {
    if (e.pointerType === "touch" && (this.touchId[0] !== -1 || this.touchId[1] !== -1)) return;
    this.push(INPUT.POINTER_LEAVE, e);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? this.canvas.clientHeight : 1;
    this.push(INPUT.WHEEL, e, e.deltaX * scale, e.deltaY * scale);
  };
}
