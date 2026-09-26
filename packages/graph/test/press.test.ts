import { describe, expect, it } from "vitest";
import { Press } from "../src/engine/Press";

function make() {
  const calls: string[] = [];
  const clicks: { node: number; edge: number; x: number; y: number; button: number; mods: number }[] = [];
  let delta = false;
  const press = new Press({
    startDrag: (node) => calls.push(`start ${node}`),
    dragTo: () => {
      if (!delta) return false;
      delta = false;
      calls.push("drag");
      return true;
    },
    moveDragged: () => calls.push("move"),
    endDrag: () => calls.push("end"),
    stopHold: (pan) => calls.push(pan ? "release pan" : "release"),
    startShape: () => calls.push("shape"),
    shapeTo: (x, y) => calls.push(`shape to ${x} ${y}`),
    endShape: () => calls.push("shape end"),
    cancelShape: () => calls.push("shape cancel"),
    click: (node, edge, x, y, button, mods) => {
      calls.push(`click ${node} ${edge}`);
      clicks.push({ node, edge, x, y, button, mods });
    },
  });
  const nudge = () => (delta = true);
  return { press, calls, clicks, nudge };
}

describe("Press", () => {
  it("drags the node hit while held", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.move(110, 100, 3);
    press.resolve(7, -1, 1, "auto");
    press.up();
    expect(calls).toEqual(["start 7", "end"]);
    expect(press.active).toBe(false);
  });

  it("waits for the pointer to move before a drag starts", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.resolve(7, -1, 1, "auto");
    press.move(102, 100, 3);
    expect(calls).toEqual([]);
    press.move(110, 100, 3);
    press.up();
    expect(calls).toEqual(["start 7", "end"]);
  });

  it("clicks the node when released before moving, after the pick answered", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.resolve(7, -1, 1, "auto");
    press.up();
    expect(calls).toEqual(["release pan", "click 7 -1"]);
  });

  it("drops the hold without a pan when cancelled while armed", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.resolve(7, -1, 1, "auto");
    press.cancel();
    expect(calls).toEqual(["release"]);
  });

  it("releases the hold with a pan when no node is hit", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.move(140, 100, 3);
    press.resolve(-1, -1, 1, "auto");
    press.up();
    expect(calls).toEqual(["release pan"]);
  });

  it("clicks the node and the edge on a release in place", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.move(101, 101, 3);
    press.up();
    press.resolve(4, 9, 1, "auto");
    expect(calls).toEqual(["release pan", "click 4 9"]);
  });

  it("clicks the edge when no node is hit", () => {
    const { press, calls } = make();
    press.down(100, 100, false);
    press.resolve(-1, 9, 1, false);
    press.up();
    expect(calls).toEqual(["click -1 9"]);
  });

  it("clicks empty space", () => {
    const { press, calls } = make();
    press.down(100, 100, false);
    press.up();
    press.resolve(-1, -1, 1, false);
    expect(calls).toEqual(["click -1 -1"]);
  });

  it("sends no click after the pointer moved", () => {
    const { press, calls } = make();
    press.down(100, 100, false);
    press.move(120, 100, 3);
    press.resolve(3, -1, 1, false);
    press.up();
    expect(calls).toEqual([]);
  });

  it("does not drag when drag is off", () => {
    const { press, calls } = make();
    press.down(100, 100, false);
    press.move(120, 100, 3);
    press.resolve(3, -1, 1, false);
    expect(calls).toEqual([]);
  });

  it("starts and ends a drag released before the pick answered", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.move(150, 100, 3);
    press.up();
    press.resolve(2, -1, 1, "auto");
    expect(calls).toEqual(["start 2", "end"]);
  });

  it("ends the drag on cancel, with no click", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.move(120, 100, 3);
    press.resolve(5, -1, 1, "auto");
    press.cancel();
    press.up();
    expect(calls).toEqual(["start 5", "end"]);
  });

  it("drops the hold without a pan when cancelled while waiting", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.cancel();
    press.resolve(5, -1, 1, "auto");
    expect(calls).toEqual(["release"]);
    expect(press.waiting).toBe(false);
  });

  it("a click carries the press position, button and modifiers", () => {
    const { press, clicks } = make();
    press.down(100, 120, false, 0, 5);
    press.move(101, 121, 3);
    press.resolve(4, -1, 1, false);
    press.up();
    expect(clicks).toEqual([{ node: 4, edge: -1, x: 100, y: 120, button: 0, mods: 5 }]);
  });

  it("with drag auto, reports each move and moves the nodes", () => {
    const { press, calls, nudge } = make();
    press.down(100, 100, true);
    press.move(110, 100, 3);
    press.resolve(7, -1, 1, "auto");
    nudge();
    press.step();
    press.step();
    press.up();
    expect(calls).toEqual(["start 7", "drag", "move", "end"]);
  });

  it("with drag manual, reports the drag but never moves the nodes", () => {
    const { press, calls, nudge } = make();
    press.down(100, 100, true);
    press.move(110, 100, 3);
    press.resolve(7, -1, 1, "manual");
    nudge();
    press.step();
    nudge();
    press.up();
    expect(calls).toEqual(["start 7", "drag", "drag", "end"]);
  });

  it("a new press cancels the last one", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.move(120, 100, 3);
    press.resolve(5, -1, 1, "auto");
    press.down(200, 200, true);
    expect(calls).toEqual(["start 5", "end"]);
    expect(press.waiting).toBe(true);
  });

  it("draws a shape instead of a pan when the select key is held on empty space", () => {
    const { press, calls } = make();
    press.down(100, 100, true, 0, 1, true);
    press.move(140, 100, 3);
    press.resolve(-1, -1, 1, "auto");
    press.move(160, 120, 3);
    press.up();
    expect(calls).toEqual(["shape", "shape to 160 120", "shape end"]);
  });

  it("waits for a move before the shape starts", () => {
    const { press, calls } = make();
    press.down(100, 100, true, 0, 1, true);
    press.resolve(-1, -1, 1, false);
    press.move(101, 100, 3);
    expect(calls).toEqual([]);
    press.move(120, 100, 3);
    press.move(130, 110, 3);
    press.up();
    expect(calls).toEqual(["shape", "shape to 130 110", "shape end"]);
  });

  it("drags a node pressed with the select key held", () => {
    const { press, calls } = make();
    press.down(100, 100, true, 0, 1, true);
    press.move(120, 100, 3);
    press.resolve(7, -1, 1, "auto");
    press.up();
    expect(calls).toEqual(["start 7", "end"]);
  });

  it("draws the shape over a node when drag is off", () => {
    const { press, calls } = make();
    press.down(100, 100, true, 0, 1, true);
    press.move(120, 100, 3);
    press.resolve(7, -1, 1, false);
    press.up();
    expect(calls).toEqual(["shape", "shape end"]);
  });

  it("clicks when a shape press does not move", () => {
    const { press, calls } = make();
    press.down(100, 100, true, 0, 1, true);
    press.resolve(-1, -1, 1, "auto");
    press.up();
    expect(calls).toEqual(["release pan", "click -1 -1"]);
  });

  it("drops the shape on cancel", () => {
    const { press, calls } = make();
    press.down(100, 100, true, 0, 1, true);
    press.move(120, 100, 3);
    press.resolve(-1, -1, 1, "auto");
    press.cancel();
    press.up();
    expect(calls).toEqual(["shape", "shape cancel"]);
  });
});
