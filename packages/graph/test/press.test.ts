import { describe, expect, it } from "vitest";
import { Press } from "../src/engine/Press";

function make() {
  const calls: string[] = [];
  const press = new Press({
    startDrag: (node) => calls.push(`start ${node}`),
    endDrag: () => calls.push("end"),
    stopHold: (pan) => calls.push(pan ? "release pan" : "release"),
    click: (node, edge) => calls.push(`click ${node} ${edge}`),
  });
  return { press, calls };
}

describe("Press", () => {
  it("drags the node hit while held", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.move(110, 100, 3);
    press.resolve(7, -1, 1, true);
    press.up();
    expect(calls).toEqual(["start 7", "end"]);
    expect(press.active).toBe(false);
  });

  it("waits for the pointer to move before a drag starts", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.resolve(7, -1, 1, true);
    press.move(102, 100, 3);
    expect(calls).toEqual([]);
    press.move(110, 100, 3);
    press.up();
    expect(calls).toEqual(["start 7", "end"]);
  });

  it("clicks the node when released before moving, after the pick answered", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.resolve(7, -1, 1, true);
    press.up();
    expect(calls).toEqual(["release pan", "click 7 -1"]);
  });

  it("drops the hold without a pan when cancelled while armed", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.resolve(7, -1, 1, true);
    press.cancel();
    expect(calls).toEqual(["release"]);
  });

  it("releases the hold with a pan when no node is hit", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.move(140, 100, 3);
    press.resolve(-1, -1, 1, true);
    press.up();
    expect(calls).toEqual(["release pan"]);
  });

  it("clicks the node on a release in place", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.move(101, 101, 3);
    press.up();
    press.resolve(4, 9, 1, true);
    expect(calls).toEqual(["release pan", "click 4 -1"]);
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
    press.resolve(2, -1, 1, true);
    expect(calls).toEqual(["start 2", "end"]);
  });

  it("ends the drag on cancel, with no click", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.move(120, 100, 3);
    press.resolve(5, -1, 1, true);
    press.cancel();
    press.up();
    expect(calls).toEqual(["start 5", "end"]);
  });

  it("drops the hold without a pan when cancelled while waiting", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.cancel();
    press.resolve(5, -1, 1, true);
    expect(calls).toEqual(["release"]);
    expect(press.waiting).toBe(false);
  });

  it("a new press cancels the last one", () => {
    const { press, calls } = make();
    press.down(100, 100, true);
    press.move(120, 100, 3);
    press.resolve(5, -1, 1, true);
    press.down(200, 200, true);
    expect(calls).toEqual(["start 5", "end"]);
    expect(press.waiting).toBe(true);
  });
});
