import { describe, expect, it } from "vitest";
import { DEFAULT_INPUT, type ResolvedInput } from "../src/api/input";
import type { Hit } from "../src/api/types";
import { INPUT, MOD, type InputRecord } from "../src/bridge/InputRing";
import { Camera2D } from "../src/camera/Camera2D";
import { GraphStore } from "../src/data/GraphStore";
import { Dirty } from "../src/engine/Dirty";
import { Interaction } from "../src/engine/Interaction";

function make(input: Partial<ResolvedInput> = {}) {
  const calls: string[] = [];
  const clicks: Hit[] = [];
  const hits: { event: string; hit: Hit }[] = [];
  const replies: { id: number; hit: Hit }[] = [];
  const submits: { x: number; y: number; token: number }[] = [];
  const pick = { free: () => true, wakes: 0 };
  const store = new GraphStore();
  store.setNodes(10, {});
  const controls = { hold: false, pointerX: 0, pointerY: 0 };
  let token = 0;
  const ia = new Interaction(
    {
      store,
      camera: new Camera2D(),
      controls,
      events: {
        onHit: (event, hit) => {
          hits.push({ event, hit });
          if (event !== "click") return;
          calls.push(`click ${hit.node ?? -1} ${hit.edge ?? -1}`);
          clicks.push(hit);
        },
        onDragStart: (node) => calls.push(`start ${node}`),
        onDrag: (event) => calls.push(event === "drag" ? "drag" : "end"),
        onSelect: () => {},
        onReply: (id, value) => replies.push({ id, hit: value as Hit }),
        onError: () => {},
      },
      streamed: () => null,
      pickFree: () => pick.free(),
      submitPick: (x, y, _nodes, _edges, t) => {
        token = t;
        submits.push({ x, y, token: t });
        return true;
      },
      findInside: () => calls.push("shape find"),
      loadShape: () => {},
      drawShape: (points) => calls.push(`shape to ${points[4]} ${points[5]}`),
      hideShape: () => calls.push("shape hide"),
      showHover: () => {},
      flagNodes: (indices, flags, on) => store.flagNodes(indices, flags, on),
      markDirty: (flags) => {
        if (flags & Dirty.MOVED) calls.push("move");
      },
      startMove: () => {},
      endMove: () => {},
      stopHold: (pan) => {
        controls.hold = false;
        calls.push(pan ? "release pan" : "release");
      },
      wake: () => pick.wakes++,
    },
    { ...DEFAULT_INPUT, ...input },
  );
  ia.setHoverLook(false);
  ia.listen(["click", "dragStart", "drag", "dragEnd"]);
  const rec = (type: number, x: number, y: number, mods = 0): InputRecord => ({ type, t: 0, x, y, dx: 0, dy: 0, buttons: type === INPUT.POINTER_UP ? 0 : 1, mods, button: 0 });
  const down = (x: number, y: number, mods = 0) => {
    controls.pointerX = x;
    controls.pointerY = y;
    ia.input(rec(INPUT.POINTER_DOWN, x, y, mods), false);
  };
  const move = (x: number, y: number) => {
    controls.pointerX = x;
    controls.pointerY = y;
    ia.input(rec(INPUT.POINTER_MOVE, x, y), false);
  };
  const up = () => ia.input(rec(INPUT.POINTER_UP, controls.pointerX, controls.pointerY), false);
  const answer = (node: number, edge: number) => {
    ia.pumpPick(0, false);
    ia.onPick(node, edge, 1, token * 4 + 3);
  };
  const reply = (t: number, node: number, edge = -1) => ia.onPick(node, edge, 1, t * 4 + 3);
  return { ia, calls, clicks, hits, replies, submits, pick, controls, rec, down, move, up, answer, reply };
}

const noHold = { drag: false, select: false } as const;

describe("Interaction press", () => {
  it("drags the node hit while held", () => {
    const { ia, calls, down, move, up, answer } = make();
    down(100, 100);
    move(110, 100);
    answer(7, -1);
    up();
    expect(calls).toEqual(["start 7", "drag", "move", "end"]);
    expect(ia.dragging).toBe(false);
  });

  it("waits for the pointer to move before a drag starts", () => {
    const { calls, down, move, up, answer } = make();
    down(100, 100);
    answer(7, -1);
    move(102, 100);
    expect(calls).toEqual([]);
    move(110, 100);
    up();
    expect(calls).toEqual(["start 7", "drag", "move", "end"]);
  });

  it("clicks the node when released before moving, after the pick answered", () => {
    const { calls, down, up, answer } = make();
    down(100, 100);
    answer(7, -1);
    up();
    expect(calls).toEqual(["release pan", "click 7 -1"]);
  });

  it("drops the hold without a pan when cancelled while armed", () => {
    const { ia, calls, down, answer } = make();
    down(100, 100);
    answer(7, -1);
    ia.cancel();
    expect(calls).toEqual(["release"]);
  });

  it("releases the hold with a pan when no node is hit", () => {
    const { calls, down, move, up, answer } = make();
    down(100, 100);
    move(140, 100);
    answer(-1, -1);
    up();
    expect(calls).toEqual(["release pan"]);
  });

  it("clicks the node and the edge on a release in place", () => {
    const { calls, down, move, up, answer } = make();
    down(100, 100);
    move(101, 101);
    up();
    answer(4, 9);
    expect(calls).toEqual(["release pan", "click 4 9"]);
  });

  it("clicks the edge when no node is hit", () => {
    const { calls, down, up, answer } = make(noHold);
    down(100, 100);
    answer(-1, 9);
    up();
    expect(calls).toEqual(["click -1 9"]);
  });

  it("clicks empty space", () => {
    const { calls, down, up, answer } = make(noHold);
    down(100, 100);
    up();
    answer(-1, -1);
    expect(calls).toEqual(["click -1 -1"]);
  });

  it("sends no click after the pointer moved", () => {
    const { calls, down, move, up, answer } = make(noHold);
    down(100, 100);
    move(120, 100);
    answer(3, -1);
    up();
    expect(calls).toEqual([]);
  });

  it("does not drag when drag is off", () => {
    const { calls, down, move, answer } = make(noHold);
    down(100, 100);
    move(120, 100);
    answer(3, -1);
    expect(calls).toEqual([]);
  });

  it("starts and ends a drag released before the pick answered", () => {
    const { calls, down, move, up, answer } = make();
    down(100, 100);
    move(150, 100);
    up();
    answer(2, -1);
    expect(calls).toEqual(["start 2", "drag", "move", "end"]);
  });

  it("ends the drag on cancel, with no click", () => {
    const { ia, calls, down, move, up, answer } = make();
    down(100, 100);
    move(120, 100);
    answer(5, -1);
    ia.cancel();
    up();
    expect(calls).toEqual(["start 5", "drag", "move", "end"]);
  });

  it("drops the hold without a pan when cancelled while waiting", () => {
    const { ia, calls, submits, down, move, up, answer } = make();
    down(100, 100);
    ia.cancel();
    answer(5, -1);
    move(150, 100);
    up();
    expect(calls).toEqual(["release"]);
    expect(ia.dragging).toBe(false);
    expect(submits).toEqual([]);
  });

  it("a click carries the press position, button and modifiers", () => {
    const { clicks, down, move, up, answer } = make(noHold);
    down(100, 120, MOD.SHIFT | MOD.ALT);
    move(101, 121);
    answer(4, -1);
    up();
    expect(clicks.map((h) => [h.node, h.edge, h.screenX, h.screenY, h.button, h.shift, h.ctrl, h.alt, h.meta])).toEqual([[4, null, 100, 120, 0, true, false, true, false]]);
  });

  it("with drag auto, reports each move and moves the nodes", () => {
    const { ia, calls, down, move, up, answer } = make();
    down(100, 100);
    move(110, 100);
    answer(7, -1);
    move(120, 100);
    ia.step(false);
    ia.step(false);
    up();
    expect(calls).toEqual(["start 7", "drag", "move", "drag", "move", "end"]);
  });

  it("with drag manual, reports the drag but never moves the nodes", () => {
    const { ia, calls, down, move, up, answer } = make({ drag: "manual" });
    down(100, 100);
    move(110, 100);
    answer(7, -1);
    move(120, 100);
    ia.step(false);
    move(130, 100);
    up();
    expect(calls).toEqual(["start 7", "drag", "drag", "drag", "end"]);
  });

  it("a new press cancels the last one", () => {
    const { calls, controls, down, move, answer } = make();
    down(100, 100);
    move(120, 100);
    answer(5, -1);
    down(200, 200);
    expect(calls).toEqual(["start 5", "drag", "move", "end"]);
    expect(controls.hold).toBe(true);
    answer(8, -1);
    move(220, 200);
    expect(calls.slice(4)).toEqual(["start 8", "drag", "move"]);
  });

  it("draws a shape instead of a pan when the select key is held on empty space", () => {
    const { calls, down, move, up, answer } = make();
    down(100, 100, MOD.SHIFT);
    move(140, 100);
    answer(-1, -1);
    move(160, 120);
    up();
    expect(calls).toEqual(["shape to 140 100", "shape to 160 120", "shape hide", "shape find"]);
  });

  it("waits for a move before the shape starts", () => {
    const { calls, down, move, up, answer } = make();
    down(100, 100, MOD.SHIFT);
    answer(-1, -1);
    move(101, 100);
    expect(calls).toEqual([]);
    move(120, 100);
    move(130, 110);
    up();
    expect(calls).toEqual(["shape to 120 100", "shape to 130 110", "shape hide", "shape find"]);
  });

  it("drags a node pressed with the select key held", () => {
    const { calls, down, move, up, answer } = make();
    down(100, 100, MOD.SHIFT);
    move(120, 100);
    answer(7, -1);
    up();
    expect(calls).toEqual(["start 7", "drag", "move", "end"]);
  });

  it("draws the shape over a node when drag is off", () => {
    const { calls, down, move, up, answer } = make({ drag: false });
    down(100, 100, MOD.SHIFT);
    move(120, 100);
    answer(7, -1);
    up();
    expect(calls).toEqual(["shape to 120 100", "shape hide", "shape find"]);
  });

  it("clicks when a shape press does not move", () => {
    const { calls, down, up, answer } = make();
    down(100, 100, MOD.SHIFT);
    answer(-1, -1);
    up();
    expect(calls).toEqual(["release pan", "click -1 -1"]);
  });

  it("drops the shape on cancel", () => {
    const { ia, calls, down, move, up, answer } = make();
    down(100, 100, MOD.SHIFT);
    move(120, 100);
    answer(-1, -1);
    ia.cancel();
    up();
    expect(calls).toEqual(["shape to 120 100", "shape hide"]);
  });
});

describe("Interaction pick queue", () => {
  it("queues two shots and emits both, in order", () => {
    const { ia, hits, submits, rec, reply } = make();
    ia.listen(["doubleClick"]);
    ia.input(rec(INPUT.DBLCLICK, 10, 10), false);
    ia.input(rec(INPUT.DBLCLICK, 30, 10), false);
    ia.pumpPick(0, false);
    expect(submits.map((s) => s.x)).toEqual([10, 30]);
    reply(submits[0]!.token, 4);
    reply(submits[1]!.token, 6);
    expect(hits.map((h) => [h.event, h.hit.node, h.hit.screenX])).toEqual([
      ["doubleClick", 4, 10],
      ["doubleClick", 6, 30],
    ]);
  });

  it("keeps the click of a press released in place when a second press comes before its pick", () => {
    const { ia, calls, clicks, submits, down, up, reply } = make(noHold);
    down(100, 100);
    up();
    down(200, 200);
    up();
    ia.pumpPick(0, false);
    expect(submits).toHaveLength(2);
    reply(submits[0]!.token, 4);
    reply(submits[1]!.token, 6);
    expect(calls).toEqual(["click 4 -1", "click 6 -1"]);
    expect(clicks.map((h) => h.screenX)).toEqual([100, 200]);
  });

  it("answers query.at through the queue, in device px out and CSS px back", () => {
    const { ia, replies, submits, reply } = make();
    ia.pixelRatio = 2;
    ia.queryAt(9, 10, 20);
    ia.pumpPick(0, false);
    expect(submits.map((s) => [s.x, s.y])).toEqual([[20, 40]]);
    reply(submits[0]!.token, 3, 5);
    expect(replies.map((r) => [r.id, r.hit.node, r.hit.edge, r.hit.screenX, r.hit.screenY, r.hit.button])).toEqual([[9, 3, 5, 10, 20, -1]]);
  });

  it("sends a press while a hover pick is in flight", () => {
    const { ia, calls, submits, down, move, reply } = make();
    ia.setHoverLook(true);
    move(50, 50);
    ia.pumpPick(0, false);
    expect(submits).toHaveLength(1);
    down(100, 100);
    ia.pumpPick(0, false);
    expect(submits).toHaveLength(2);
    reply(submits[1]!.token, 7);
    move(120, 100);
    expect(calls).toEqual(["start 7", "drag", "move"]);
    reply(submits[0]!.token, 2);
    expect(ia.dragging).toBe(true);
  });

  it("runs several picks at once, up to the free readback slots", () => {
    const { ia, replies, submits, pick, reply } = make();
    let answered = 0;
    pick.free = () => submits.length - answered < 3;
    for (let id = 1; id <= 4; id++) ia.queryAt(id, id, 0);
    ia.pumpPick(0, false);
    expect(submits).toHaveLength(3);
    expect(replies).toEqual([]);
    const wakes = pick.wakes;
    reply(submits[0]!.token, 10);
    answered++;
    expect(pick.wakes).toBeGreaterThan(wakes);
    ia.pumpPick(0, false);
    expect(submits).toHaveLength(4);
    for (let k = 1; k < 4; k++) {
      reply(submits[k]!.token, 10 + k);
      answered++;
    }
    expect(replies.map((r) => [r.id, r.hit.node])).toEqual([
      [1, 10],
      [2, 11],
      [3, 12],
      [4, 13],
    ]);
  });

  it("holds a result that arrives early until the jobs before it finish", () => {
    const { ia, replies, submits, reply } = make();
    ia.queryAt(1, 0, 0);
    ia.queryAt(2, 5, 0);
    ia.pumpPick(0, false);
    reply(submits[1]!.token, 8);
    expect(replies).toEqual([]);
    reply(submits[0]!.token, 7);
    expect(replies.map((r) => [r.id, r.hit.node])).toEqual([
      [1, 7],
      [2, 8],
    ]);
  });

  it("finishes a job whose readback failed with an empty hit, and the queue goes on", () => {
    const { ia, replies, submits, reply } = make();
    ia.queryAt(1, 0, 0);
    ia.queryAt(2, 5, 0);
    ia.pumpPick(0, false);
    ia.onPick(-1, -1, 1, submits[0]!.token * 4 + 3);
    reply(submits[1]!.token, 5);
    expect(replies.map((r) => [r.id, r.hit.node, r.hit.edge])).toEqual([
      [1, null, null],
      [2, 5, null],
    ]);
  });

  it("drops a press cancelled before its pick is sent, with no GPU work", () => {
    const { ia, calls, submits, down, up } = make(noHold);
    down(100, 100);
    ia.cancel();
    ia.pumpPick(0, false);
    up();
    expect(submits).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("drops the answer of a press cancelled while its pick is in flight", () => {
    const { ia, calls, submits, down, move, up, reply } = make();
    down(100, 100);
    ia.pumpPick(0, false);
    ia.cancel();
    reply(submits[0]!.token, 7);
    move(130, 100);
    up();
    expect(calls).toEqual(["release"]);
    expect(ia.dragging).toBe(false);
  });

  it("waits while no readback slot is free", () => {
    const { ia, replies, submits, pick, reply } = make();
    pick.free = () => false;
    ia.queryAt(1, 0, 0);
    ia.pumpPick(0, false);
    expect(submits).toEqual([]);
    pick.free = () => true;
    ia.pumpPick(0, false);
    reply(submits[0]!.token, 2);
    expect(replies.map((r) => r.hit.node)).toEqual([2]);
  });
});
