import type { ResolvedInput } from "../api/input";
import type { Hit, SelectEvent, SelectKey } from "../api/types";
import { INPUT, MOD, modKeys, type InputRecord } from "../bridge/InputRing";
import type { HitEventName, WorkerEventName } from "../bridge/protocol";
import type { Camera2D } from "../camera/Camera2D";
import type { Controls } from "../camera/Controls";
import type { GraphStore } from "../data/GraphStore";
import { CONSTANTS, PICK_CONSTANTS } from "../data/Layouts";
import { MAX_SHAPE_POINTS } from "../data/QueryShape";
import type { QueryDone, QueryFail } from "../passes/QueryPass";
import { Dirty } from "./Dirty";
import type { EngineInit } from "./Engine";

const PICKED_NODES = PICK_CONSTANTS.PICK_FLAG_NODES;
const PICKED_EDGES = PICK_CONSTANTS.PICK_FLAG_EDGES;
const PICK_BOTH = PICKED_NODES | PICKED_EDGES;
const SELECTED = CONSTANTS.STATE_SELECTED;
const CAMERA_SETTLE_MS = 50;
const CLICK_SLOP_CSS_PX = 3;
const SHAPE_STEP_CSS_PX = 4;
const DEFAULT_PICK_RATE = 60;
const SELECT_KEY_MOD: Record<SelectKey, number> = { shift: MOD.SHIFT, alt: MOD.ALT, ctrl: MOD.CTRL, meta: MOD.META };

const JOB = { PRESS: 1, SHOT: 2, AT: 3 } as const;

const PRESS = { IDLE: 0, PICKING: 1, ARMED_CLICK: 2, ARMED_DRAG: 3, ARMED_SHAPE: 4, DRAGGING: 5, SHAPING: 6 } as const;

interface PickJob {
  kind: number;
  x: number;
  y: number;
  id: number;
  event: HitEventName;
  button: number;
  mods: number;
  click: boolean;
  seq: number;
  done: boolean;
  node: number;
  edge: number;
  scale: number;
}

export interface InteractionHost {
  readonly store: GraphStore;
  readonly camera: Camera2D;
  readonly controls: Pick<Controls, "hold" | "pointerX" | "pointerY">;
  readonly events: Pick<EngineInit, "onHit" | "onDragStart" | "onDrag" | "onSelect" | "onReply" | "onError">;
  streamed(): Float32Array | null;
  pickFree(): boolean;
  submitPick(x: number, y: number, nodes: boolean, edges: boolean, token: number): boolean;
  findInside(points: Float32Array, done: QueryDone, fail: QueryFail): void;
  loadShape(): void;
  drawShape(points: Float32Array, count: number): void;
  hideShape(): void;
  showHover(node: number, edge: number, which: number, nodeScale: number): void;
  flagNodes(indices: Uint32Array, flags: number, on: boolean): void;
  markDirty(flags: number): void;
  startMove(auto: boolean): void;
  endMove(): void;
  stopHold(pan: boolean, x: number, y: number): void;
  wake(): void;
}

export function shapeAdds(mods: number, key: SelectKey | null): boolean {
  if (key === "shift") return (mods & (MOD.CTRL | MOD.META)) !== 0;
  return (mods & MOD.SHIFT) !== 0;
}

export function selectedNodes(store: GraphStore): Uint32Array {
  return store.looks.nodes[0].entries(store.channels.nodeState.data as Uint32Array);
}

export function selectClick(store: GraphStore, node: number, shift: boolean): boolean {
  if (node < 0) return !shift && clearSelection(store);
  const on = store.nodeFlagged(node, SELECTED);
  if (!shift && on && store.looks.nodes[0].live === 1) return false;
  if (!shift) clearSelection(store);
  store.flagNodes(Uint32Array.of(node), SELECTED, shift ? !on : true);
  return true;
}

export function selectShape(store: GraphStore, nodes: Uint32Array, add: boolean): boolean {
  const cleared = !add && clearSelection(store);
  if (nodes.length > 0) store.flagNodes(nodes, SELECTED, true);
  return cleared || nodes.length > 0;
}

function clearSelection(store: GraphStore): boolean {
  if (store.looks.nodes[0].live === 0) return false;
  store.flagNodes(selectedNodes(store), SELECTED, false);
  return true;
}

export class Interaction {
  pixelRatio = 1;
  pickInterval = 1000 / DEFAULT_PICK_RATE;
  private inputState: ResolvedInput;
  private pickKinds = 0;
  private look = true;
  private hoverEvents = false;
  private clickEvents = false;
  private doubleClickEvents = false;
  private menuEvents = false;
  private dragEvents = false;
  private selectEvents = false;
  private mods = 0;
  private readonly world = { x: 0, y: 0 };

  private jobs: PickJob[] = [];
  private head = 0;
  private size = 0;
  private sent = 0;
  private seq = 0;
  private hoverSeq = 0;

  private hoverOpen = false;
  private hoverWanted = false;
  private hoverStale = false;
  private hoverNode = -1;
  private hoverEdge = -1;
  private hoverX = 0;
  private hoverY = 0;
  private hoverMods = 0;
  private pickDue = 0;
  private cameraMs = -Infinity;
  private pickTimer: ReturnType<typeof setTimeout> | undefined;

  private state: number = PRESS.IDLE;
  private pressJob: PickJob | null = null;
  private pressX = 0;
  private pressY = 0;
  private pressButton = 0;
  private pressMods = 0;
  private held = false;
  private shape = false;
  private moved = false;
  private released = false;
  private node = -1;
  private edge = -1;
  private nodeScale = 1;

  private auto = false;
  private dragList: Uint32Array = new Uint32Array(0);
  private dragFrom = new Float32Array(0);
  private dragXY = new Float32Array(0);
  private grabX = 0;
  private grabY = 0;
  private dragDx = 0;
  private dragDy = 0;

  private shapeLasso = false;
  private shapeCount = 0;
  private shapePts = new Float32Array(0);
  private readonly shapeBox = new Float32Array(8);

  constructor(
    private readonly host: InteractionHost,
    input: ResolvedInput,
  ) {
    this.inputState = input;
    this.setInput(input);
  }

  get dragging(): boolean {
    return this.state === PRESS.DRAGGING;
  }

  get shaping(): boolean {
    return this.state === PRESS.SHAPING;
  }

  setInput(s: ResolvedInput): void {
    const prev = this.inputState;
    this.inputState = s;
    if (prev.drag !== false && s.drag === false) this.cancel();
    else if (prev.select !== false && s.select === false && (this.state === PRESS.ARMED_SHAPE || this.state === PRESS.SHAPING)) this.cancel();
    const kinds = (s.pick.nodes ? PICKED_NODES : 0) | (s.pick.edges ? PICKED_EDGES : 0);
    const lost = PICK_BOTH & ~kinds;
    if (lost & PICKED_NODES) this.hoverNode = -1;
    if (lost & PICKED_EDGES) this.hoverEdge = -1;
    if (lost !== 0) this.host.showHover(-1, -1, lost, 0);
    this.pickKinds = kinds;
    this.hoverStale = true;
    this.syncGate();
    this.wantHover();
    this.host.wake();
  }

  setHoverLook(on: boolean): void {
    this.look = on;
    this.syncGate();
  }

  listen(events: readonly WorkerEventName[]): void {
    this.hoverEvents = events.includes("hover");
    this.clickEvents = events.includes("click");
    this.doubleClickEvents = events.includes("doubleClick");
    this.menuEvents = events.includes("contextMenu");
    this.dragEvents = events.includes("dragStart") || events.includes("drag") || events.includes("dragEnd");
    this.selectEvents = events.includes("select");
    this.syncGate();
  }

  wantHover(): void {
    if (this.hoverOpen) this.hoverWanted = true;
  }

  clearHover(): void {
    this.hoverStale = true;
    if (this.hoverNode !== -1 || this.hoverEdge !== -1) this.emitHover(-1, -1, PICK_BOTH, 1);
  }

  cameraMoved(now: number): void {
    this.cameraMs = now;
    if (this.state !== PRESS.DRAGGING && (this.hoverNode !== -1 || this.hoverEdge !== -1)) {
      this.clearHover();
      this.wantHover();
    }
  }

  queryAt(id: number, x: number, y: number): void {
    this.push(JOB.AT, x * this.pixelRatio, y * this.pixelRatio).id = id;
    this.host.wake();
  }

  input(rec: InputRecord, handoff: boolean): void {
    this.mods = rec.mods;
    switch (rec.type) {
      case INPUT.POINTER_DOWN:
        this.down(rec, handoff);
        break;
      case INPUT.DBLCLICK:
        if (this.doubleClickEvents) this.shoot("doubleClick", rec);
        break;
      case INPUT.MENU:
        this.cancel();
        if (this.menuEvents) this.shoot("contextMenu", rec);
        break;
      case INPUT.POINTER_MOVE:
        this.move(rec.x, rec.y);
        break;
      case INPUT.POINTER_UP:
        this.up();
        break;
      case INPUT.PINCH:
        this.cancel();
        break;
    }
    if (rec.type === INPUT.POINTER_MOVE || rec.type === INPUT.POINTER_LEAVE || rec.type === INPUT.POINTER_DOWN) this.wantHover();
  }

  step(restreamed: boolean): void {
    if (this.state === PRESS.DRAGGING && (this.dragTo() || restreamed) && this.auto) this.moveDragged();
  }

  cancel(): void {
    const s = this.state;
    this.state = PRESS.IDLE;
    this.pressJob = null;
    if (s === PRESS.DRAGGING) this.endDrag();
    else if (s === PRESS.SHAPING) this.stopShape();
    else if (s === PRESS.ARMED_DRAG || s === PRESS.ARMED_SHAPE || (s === PRESS.PICKING && this.held)) this.host.stopHold(false, this.pressX, this.pressY);
  }

  pumpPick(now: number, bench: boolean): void {
    const host = this.host;
    while (this.sent < this.size) {
      const job = this.jobs[(this.head + this.sent) % this.jobs.length]!;
      const drag = job.kind === JOB.PRESS && (this.inputState.drag !== false || this.inputState.select !== false);
      const nodes = drag || (this.pickKinds & PICKED_NODES) !== 0;
      const edges = (this.pickKinds & PICKED_EDGES) !== 0;
      const live = job.kind !== JOB.PRESS || job === this.pressJob || job.click;
      if (live && (nodes || edges)) {
        if (!host.pickFree()) break;
        if (host.submitPick(job.x, job.y, nodes, edges, this.seq + 1)) {
          job.seq = ++this.seq;
          this.sent++;
          continue;
        }
      }
      this.settle(job, -1, -1, 1);
      this.sent++;
    }
    this.drain();
    if (this.hoverSeq !== 0 || !this.hoverWanted || !this.hoverOpen || bench || this.state === PRESS.PICKING || this.state === PRESS.DRAGGING || this.state === PRESS.SHAPING) return;
    const x = host.controls.pointerX;
    const y = host.controls.pointerY;
    if (x < 0 || y < 0) {
      this.hoverWanted = false;
      this.emitHover(-1, -1, PICK_BOTH, 1);
      return;
    }
    if (!host.pickFree()) return;
    const due = Math.max(this.pickDue, this.cameraMs + CAMERA_SETTLE_MS);
    if (now < due) {
      if (this.pickTimer === undefined) this.pickTimer = setTimeout(this.pickWake, due - now);
      return;
    }
    if (!host.submitPick(x, y, (this.pickKinds & PICKED_NODES) !== 0, (this.pickKinds & PICKED_EDGES) !== 0, this.seq + 1)) return;
    this.hoverSeq = ++this.seq;
    this.hoverStale = false;
    this.hoverX = x;
    this.hoverY = y;
    this.hoverMods = this.mods;
    this.hoverWanted = false;
    this.pickDue = now + this.pickInterval;
  }

  readonly onPick = (node: number, edge: number, nodeScale: number, token: number): void => {
    const seq = Math.floor(token / 4);
    const picked = token % 4;
    if (seq === this.hoverSeq) {
      this.hoverSeq = 0;
      if (!this.hoverStale && this.hoverOpen) this.emitHover(node, edge, picked, nodeScale);
    } else {
      for (let k = 0; k < this.sent; k++) {
        const job = this.jobs[(this.head + k) % this.jobs.length]!;
        if (job.done || job.seq !== seq) continue;
        this.settle(job, (picked & PICKED_NODES) !== 0 ? node : -1, (picked & PICKED_EDGES) !== 0 ? edge : -1, nodeScale);
        this.drain();
        break;
      }
    }
    if (this.size > this.sent || this.hoverWanted) this.host.wake();
  };

  redrawShape(): void {
    if (this.state === PRESS.SHAPING) this.drawShape();
  }

  destroy(): void {
    clearTimeout(this.pickTimer);
  }

  private readonly pickWake = (): void => {
    this.pickTimer = undefined;
    this.host.wake();
  };

  private syncGate(): void {
    const open = this.pickKinds !== 0 && (this.look || this.hoverEvents);
    if (open === this.hoverOpen) return;
    this.hoverOpen = open;
    if (open) {
      this.hoverWanted = true;
      this.host.wake();
    } else {
      this.clearHover();
      this.hoverWanted = false;
    }
  }

  private push(kind: number, x: number, y: number): PickJob {
    const cap = this.jobs.length;
    if (this.size === cap) {
      const jobs: PickJob[] = [];
      for (let k = 0; k < this.size; k++) jobs.push(this.jobs[(this.head + k) % cap]!);
      for (let k = cap; k < Math.max(4, cap * 2); k++) jobs.push({ kind: 0, x: 0, y: 0, id: 0, event: "click", button: 0, mods: 0, click: false, seq: 0, done: false, node: -1, edge: -1, scale: 1 });
      this.jobs = jobs;
      this.head = 0;
    }
    const job = this.jobs[(this.head + this.size++) % this.jobs.length]!;
    job.kind = kind;
    job.x = x;
    job.y = y;
    job.click = false;
    job.done = false;
    return job;
  }

  private settle(job: PickJob, node: number, edge: number, scale: number): void {
    job.done = true;
    job.node = node;
    job.edge = edge;
    job.scale = scale;
  }

  private drain(): void {
    while (this.sent > 0 && this.jobs[this.head]!.done) {
      const job = this.jobs[this.head]!;
      this.head = (this.head + 1) % this.jobs.length;
      this.size--;
      this.sent--;
      this.finish(job);
    }
  }

  private finish(job: PickJob): void {
    if (job.kind === JOB.AT) this.host.events.onReply(job.id, this.hit(job.node, job.edge, job.x, job.y, -1, 0), null);
    else if (job.kind === JOB.SHOT) this.host.events.onHit(job.event, this.hit(job.node, job.edge, job.x, job.y, job.button, job.mods));
    else if (job === this.pressJob) {
      this.pressJob = null;
      this.resolve(job.node, job.edge, job.scale);
    } else if (job.click) this.emitClick(job.node, job.edge, job.x, job.y, job.button, job.mods);
  }

  private shoot(event: HitEventName, rec: InputRecord): void {
    const job = this.push(JOB.SHOT, rec.x, rec.y);
    job.event = event;
    job.button = rec.button;
    job.mods = rec.mods;
  }

  private down(rec: InputRecord, handoff: boolean): void {
    const job = this.pressJob;
    if (job && this.released && !this.moved) job.click = true;
    this.cancel();
    const drag = this.inputState.drag !== false;
    const select = this.inputState.select !== false;
    const shape = select && this.selectKeyHeld(rec.mods);
    if (handoff || (rec.buttons & 1) === 0 || !(drag || select || this.clickEvents)) return;
    const next = this.push(JOB.PRESS, rec.x, rec.y);
    next.button = rec.button;
    next.mods = rec.mods;
    this.pressJob = next;
    this.state = PRESS.PICKING;
    this.pressX = rec.x;
    this.pressY = rec.y;
    this.pressButton = rec.button;
    this.pressMods = rec.mods;
    this.held = drag || shape;
    this.shape = shape;
    this.moved = false;
    this.released = false;
    this.node = -1;
    this.edge = -1;
    this.host.controls.hold = this.held;
  }

  private move(x: number, y: number): void {
    const s = this.state;
    if (s === PRESS.SHAPING) {
      this.shapeTo(x, y);
      return;
    }
    if (s === PRESS.IDLE || s === PRESS.DRAGGING || this.moved) return;
    const dx = x - this.pressX;
    const dy = y - this.pressY;
    const slop = CLICK_SLOP_CSS_PX * this.pixelRatio;
    if (dx * dx + dy * dy <= slop * slop) return;
    this.moved = true;
    if (s === PRESS.ARMED_DRAG) this.startDrag();
    else if (s === PRESS.ARMED_SHAPE) this.startShape();
  }

  private up(): void {
    switch (this.state) {
      case PRESS.PICKING:
        this.released = true;
        break;
      case PRESS.DRAGGING:
        this.step(false);
        this.state = PRESS.IDLE;
        this.endDrag();
        break;
      case PRESS.SHAPING:
        this.state = PRESS.IDLE;
        this.endShape();
        break;
      case PRESS.ARMED_DRAG:
      case PRESS.ARMED_SHAPE:
        this.finishPress(true);
        break;
      case PRESS.ARMED_CLICK:
        this.finishPress(false);
        break;
    }
  }

  private resolve(node: number, edge: number, nodeScale: number): void {
    this.node = node;
    this.edge = edge;
    this.nodeScale = nodeScale;
    const drag = this.inputState.drag;
    const live = this.moved || !this.released;
    if (this.held && drag !== false && node >= 0 && live) {
      this.auto = drag === "auto";
      this.state = PRESS.ARMED_DRAG;
      if (!this.moved) return;
      this.startDrag();
      if (this.released) {
        this.state = PRESS.IDLE;
        this.endDrag();
      }
    } else if (this.shape && live && this.inputState.select !== false) {
      this.state = PRESS.ARMED_SHAPE;
      if (!this.moved) return;
      this.startShape();
      if (this.released) {
        this.state = PRESS.IDLE;
        this.endShape();
      }
    } else if (this.released) this.finishPress(this.held);
    else {
      this.state = PRESS.ARMED_CLICK;
      if (this.held) this.host.stopHold(true, this.pressX, this.pressY);
    }
  }

  private finishPress(held: boolean): void {
    this.state = PRESS.IDLE;
    if (held) this.host.stopHold(true, this.pressX, this.pressY);
    if (!this.moved) this.emitClick(this.node, this.edge, this.pressX, this.pressY, this.pressButton, this.pressMods);
  }

  private selectKeyHeld(mods: number): boolean {
    if (this.inputState.select === false || (mods & MOD.TOUCH) !== 0) return false;
    const key = this.inputState.selectKey;
    return key === null || (mods & SELECT_KEY_MOD[key]) !== 0;
  }

  private hit(node: number, edge: number, x: number, y: number, button: number, mods: number): Hit {
    this.host.camera.screenToWorld(x, y, this.world);
    const r = this.pixelRatio;
    return modKeys(mods, { node: node >= 0 ? node : null, edge: edge >= 0 ? edge : null, group: null, x: this.world.x, y: this.world.y, screenX: x / r, screenY: y / r, button });
  }

  private emitHover(node: number, edge: number, picked: number, nodeScale: number): void {
    const which = picked & this.pickKinds;
    let moved = false;
    if ((which & PICKED_NODES) !== 0 && node !== this.hoverNode) {
      this.hoverNode = node;
      moved = true;
    }
    if ((which & PICKED_EDGES) !== 0 && edge !== this.hoverEdge) {
      this.hoverEdge = edge;
      moved = true;
    }
    if (moved && this.hoverEvents) this.host.events.onHit("hover", this.hit(this.hoverNode, this.hoverEdge, this.hoverX, this.hoverY, -1, this.hoverMods));
    if (which !== 0) this.host.showHover(node, edge, which, nodeScale);
  }

  private emitClick(node: number, edge: number, x: number, y: number, button: number, mods: number): void {
    this.applyClick(node, mods);
    if (!this.clickEvents) return;
    const n = (this.pickKinds & PICKED_NODES) !== 0 ? node : -1;
    const e = (this.pickKinds & PICKED_EDGES) !== 0 ? edge : -1;
    this.host.events.onHit("click", this.hit(n, e, x, y, button, mods));
  }

  private startDrag(): void {
    const host = this.host;
    const store = host.store;
    const node = this.node;
    const list = store.nodeFlagged(node, SELECTED) ? selectedNodes(store) : Uint32Array.of(node);
    const n = list.length;
    const mirror = store.channels.nodePos.data as Float32Array;
    const streamed = host.streamed();
    const from = new Float32Array(n * 2);
    for (let j = 0; j < n; j++) {
      const i = list[j]!;
      const pos = streamed && i * 2 + 1 < streamed.length ? streamed : mirror;
      from[j * 2] = pos[i * 2]!;
      from[j * 2 + 1] = pos[i * 2 + 1]!;
    }
    const at = list.indexOf(node);
    this.state = PRESS.DRAGGING;
    this.dragList = list;
    this.dragFrom = from;
    this.dragXY = new Float32Array(n * 2);
    this.dragDx = 0;
    this.dragDy = 0;
    host.camera.screenToWorld(this.pressX, this.pressY, this.world);
    this.grabX = this.world.x;
    this.grabY = this.world.y;
    host.flagNodes(list, CONSTANTS.STATE_DRAGGING, true);
    host.startMove(this.auto);
    if (this.dragEvents) host.events.onDragStart(node, list.slice(), from[at * 2]!, from[at * 2 + 1]!);
    this.hoverX = this.pressX;
    this.hoverY = this.pressY;
    this.hoverMods = this.mods;
    this.emitHover(node, -1, PICK_BOTH, this.nodeScale);
    this.step(false);
    host.wake();
  }

  private dragTo(): boolean {
    const px = this.host.controls.pointerX;
    const py = this.host.controls.pointerY;
    if (px < 0 || py < 0) return false;
    this.host.camera.screenToWorld(px, py, this.world);
    const dx = this.world.x - this.grabX;
    const dy = this.world.y - this.grabY;
    if (dx === this.dragDx && dy === this.dragDy) return false;
    this.dragDx = dx;
    this.dragDy = dy;
    if (this.dragEvents) this.host.events.onDrag("drag", this.node, dx, dy);
    return true;
  }

  private moveDragged(): void {
    const store = this.host.store;
    const from = this.dragFrom;
    const xy = this.dragXY;
    const dx = this.dragDx;
    const dy = this.dragDy;
    for (let k = 0; k < xy.length; k += 2) {
      xy[k] = from[k]! + dx;
      xy[k + 1] = from[k + 1]! + dy;
      store.growBounds(xy[k]!, xy[k + 1]!);
    }
    store.writePositionsAt(this.dragList, xy);
    this.host.markDirty(Dirty.MOVED);
  }

  private endDrag(): void {
    const host = this.host;
    host.flagNodes(this.dragList, CONSTANTS.STATE_DRAGGING, false);
    if (this.auto) host.endMove();
    host.controls.hold = false;
    if (this.dragEvents) host.events.onDrag("dragEnd", this.node, this.dragDx, this.dragDy);
    this.wantHover();
  }

  private startShape(): void {
    if (this.shapePts.length === 0) this.shapePts = new Float32Array(MAX_SHAPE_POINTS * 2);
    this.state = PRESS.SHAPING;
    this.host.loadShape();
    this.shapeLasso = this.inputState.selectShape === "lasso";
    this.shapePts[0] = this.pressX;
    this.shapePts[1] = this.pressY;
    this.shapeCount = 1;
    this.shapeTo(this.host.controls.pointerX, this.host.controls.pointerY);
  }

  private shapeTo(x: number, y: number): void {
    const pts = this.shapePts;
    if (!this.shapeLasso) {
      pts[2] = x;
      pts[3] = y;
      this.shapeCount = 2;
    } else {
      const n = this.shapeCount;
      const dx = x - pts[n * 2 - 2]!;
      const dy = y - pts[n * 2 - 1]!;
      const step = SHAPE_STEP_CSS_PX * this.pixelRatio;
      if (dx * dx + dy * dy < step * step) return;
      const k = n < MAX_SHAPE_POINTS ? n : n - 1;
      pts[k * 2] = x;
      pts[k * 2 + 1] = y;
      this.shapeCount = k + 1;
    }
    this.drawShape();
  }

  private boxPoints(): Float32Array {
    const p = this.shapePts;
    const b = this.shapeBox;
    b[0] = p[0]!;
    b[1] = p[1]!;
    b[2] = p[2]!;
    b[3] = p[1]!;
    b[4] = p[2]!;
    b[5] = p[3]!;
    b[6] = p[0]!;
    b[7] = p[3]!;
    return b;
  }

  private drawShape(): void {
    if (this.shapeLasso) this.host.drawShape(this.shapePts, this.shapeCount);
    else if (this.shapeCount === 2) this.host.drawShape(this.boxPoints(), 4);
  }

  private stopShape(): void {
    this.host.controls.hold = false;
    this.host.hideShape();
    this.wantHover();
  }

  private endShape(): void {
    this.stopShape();
    const mode = this.inputState.select;
    if (mode === false || (mode === "manual" && !this.selectEvents)) return;
    const lasso = this.shapeLasso;
    const kind = lasso ? "lasso" : "box";
    const mods = this.pressMods;
    const n = this.shapeCount;
    if (lasso ? n < 3 : n < 2) {
      this.applyShape(new Uint32Array(0), kind, mods);
      return;
    }
    const poly = lasso ? this.shapePts.slice(0, n * 2) : this.boxPoints().slice();
    this.host.findInside(
      poly,
      (nodes) => this.applyShape(nodes, kind, mods),
      (e) => this.host.events.onError(e, false),
    );
  }

  private liveNodes(nodes: Uint32Array): Uint32Array {
    const store = this.host.store;
    const hidden = CONSTANTS.STATE_HIDDEN;
    const slots = store.nodeSlots;
    let n = 0;
    for (let j = 0; j < nodes.length; j++) {
      const i = nodes[j]!;
      if (i < slots && !store.nodeFlagged(i, hidden)) nodes[n++] = i;
    }
    return n === nodes.length ? nodes : nodes.subarray(0, n);
  }

  private applyShape(nodes: Uint32Array, shape: "box" | "lasso", mods: number): void {
    const mode = this.inputState.select;
    if (mode === false) return;
    const live = this.liveNodes(nodes);
    if (mode === "manual") {
      this.emitSelect(live.slice(), shape, mods);
      return;
    }
    if (selectShape(this.host.store, live, shapeAdds(mods, this.inputState.selectKey))) this.host.markDirty(Dirty.STATE);
    this.emitSelect(null, shape, mods);
  }

  private applyClick(node: number, mods: number): void {
    const mode = this.inputState.select;
    if (mode === false) return;
    const store = this.host.store;
    const n = node >= 0 && node < store.nodeSlots && !store.nodeFlagged(node, CONSTANTS.STATE_HIDDEN) ? node : -1;
    if (mode === "manual") {
      this.emitSelect(n >= 0 ? Uint32Array.of(n) : new Uint32Array(0), "click", mods);
      return;
    }
    if (selectClick(store, n, (mods & MOD.SHIFT) !== 0)) this.host.markDirty(Dirty.STATE);
    this.emitSelect(null, "click", mods);
  }

  private emitSelect(nodes: Uint32Array | null, shape: SelectEvent["shape"], mods: number): void {
    if (!this.selectEvents) return;
    this.host.events.onSelect(modKeys(mods, { nodes: nodes ?? selectedNodes(this.host.store), shape }));
  }
}
