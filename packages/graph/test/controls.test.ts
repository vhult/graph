import { describe, expect, it } from "vitest";
import { INPUT, type InputRecord } from "../src/bridge/InputRing";
import { Camera2D } from "../src/camera/Camera2D";
import { Controls } from "../src/camera/Controls";

const p = { x: 0, y: 0 };

function make(): { camera: Camera2D; controls: Controls } {
  const camera = new Camera2D();
  camera.setViewport(800, 600);
  camera.setView({ x: 10, y: -5, zoom: 3, rotation: 0.7 });
  return { camera, controls: new Controls() };
}

function rec(type: number, x: number, y: number, dx = 0, dy = 0, buttons = 0): InputRecord {
  return { type, t: 0, x, y, dx, dy, buttons, mods: 0, button: 0 };
}

describe("Controls hold", () => {
  it("does not pan while held", () => {
    const { camera, controls } = make();
    controls.apply(rec(INPUT.POINTER_DOWN, 100, 100, 0, 0, 1), camera);
    controls.hold = true;
    const before = { x: camera.x, y: camera.y };
    expect(controls.apply(rec(INPUT.POINTER_MOVE, 140, 120, 0, 0, 1), camera)).toBe(false);
    expect(camera.x).toBe(before.x);
    expect(camera.y).toBe(before.y);
    expect(controls.pointerX).toBe(140);
  });

  it("release catches the pan up to the pointer", () => {
    const { camera, controls } = make();
    controls.apply(rec(INPUT.POINTER_DOWN, 100, 100, 0, 0, 1), camera);
    controls.hold = true;
    controls.apply(rec(INPUT.POINTER_MOVE, 140, 120, 0, 0, 1), camera);
    camera.worldToScreen(0, 0, p);
    const origin = { ...p };
    expect(controls.release(100, 100, camera)).toBe(true);
    expect(controls.hold).toBe(false);
    camera.worldToScreen(0, 0, p);
    expect(p.x - origin.x).toBeCloseTo(40, 9);
    expect(p.y - origin.y).toBeCloseTo(20, 9);
    expect(controls.apply(rec(INPUT.POINTER_MOVE, 150, 120, 0, 0, 1), camera)).toBe(true);
  });

  it("release does not pan after the button is up", () => {
    const { camera, controls } = make();
    controls.apply(rec(INPUT.POINTER_DOWN, 100, 100, 0, 0, 1), camera);
    controls.hold = true;
    controls.apply(rec(INPUT.POINTER_MOVE, 140, 120, 0, 0, 1), camera);
    controls.apply(rec(INPUT.POINTER_UP, 140, 120), camera);
    expect(controls.release(100, 100, camera)).toBe(false);
  });
});

describe("Controls menu record", () => {
  it("leaves the camera, the pointer and a drag in progress alone", () => {
    const { camera, controls } = make();
    controls.apply(rec(INPUT.POINTER_DOWN, 100, 100, 0, 0, 1), camera);
    const view = { x: camera.x, y: camera.y, zoom: camera.zoom };
    expect(controls.apply(rec(INPUT.MENU, 0, 0), camera)).toBe(false);
    expect({ x: camera.x, y: camera.y, zoom: camera.zoom }).toEqual(view);
    expect(controls.pointerX).toBe(100);
    expect(controls.pointerY).toBe(100);
    expect(controls.apply(rec(INPUT.POINTER_MOVE, 140, 120, 0, 0, 1), camera)).toBe(true);
  });
});

describe("Controls pinch", () => {
  it("first pinch record only anchors", () => {
    const { camera, controls } = make();
    const before = { x: camera.x, y: camera.y, zoom: camera.zoom };
    expect(controls.apply(rec(INPUT.PINCH, 300, 300, 100), camera)).toBe(false);
    expect(camera.x).toBe(before.x);
    expect(camera.y).toBe(before.y);
    expect(camera.zoom).toBe(before.zoom);
  });

  it("zooms by the finger distance ratio", () => {
    const { camera, controls } = make();
    const before = camera.zoom;
    controls.apply(rec(INPUT.PINCH, 300, 300, 100), camera);
    expect(controls.apply(rec(INPUT.PINCH, 300, 300, 250), camera)).toBe(true);
    expect(camera.zoom).toBeCloseTo(before * 2.5, 9);
  });

  it("keeps the world point under the midpoint fixed", () => {
    const { camera, controls } = make();
    camera.screenToWorld(300, 300, p);
    const before = { ...p };
    controls.apply(rec(INPUT.PINCH, 300, 300, 100), camera);
    controls.apply(rec(INPUT.PINCH, 300, 300, 200), camera);
    camera.screenToWorld(300, 300, p);
    expect(p.x).toBeCloseTo(before.x, 9);
    expect(p.y).toBeCloseTo(before.y, 9);
  });

  it("moving the midpoint pans without zooming", () => {
    const { camera, controls } = make();
    camera.screenToWorld(300, 300, p);
    const before = { ...p };
    const zoom = camera.zoom;
    controls.apply(rec(INPUT.PINCH, 300, 300, 100), camera);
    expect(controls.apply(rec(INPUT.PINCH, 350, 320, 100), camera)).toBe(true);
    camera.screenToWorld(350, 320, p);
    expect(p.x).toBeCloseTo(before.x, 9);
    expect(p.y).toBeCloseTo(before.y, 9);
    expect(camera.zoom).toBe(zoom);
  });

  it("drops a pending wheel glide when a pinch starts", () => {
    const { camera, controls } = make();
    controls.apply(rec(INPUT.WHEEL, 400, 300, 0, -100), camera);
    controls.apply(rec(INPUT.PINCH, 300, 300, 100), camera);
    const zoom = camera.zoom;
    expect(controls.advance(0.016, camera)).toBe(false);
    expect(camera.zoom).toBe(zoom);
  });

  it("hands off to one finger without a jump", () => {
    const { camera, controls } = make();
    controls.apply(rec(INPUT.PINCH, 300, 300, 100), camera);
    controls.apply(rec(INPUT.PINCH, 310, 305, 120), camera);
    controls.apply(rec(INPUT.POINTER_DOWN, 250, 280, 0, 0, 1), camera);
    const before = { x: camera.x, y: camera.y };
    expect(controls.apply(rec(INPUT.POINTER_MOVE, 250, 280, 0, 0, 1), camera)).toBe(false);
    expect(camera.x).toBe(before.x);
    expect(camera.y).toBe(before.y);
    camera.worldToScreen(0, 0, p);
    const origin = { ...p };
    expect(controls.apply(rec(INPUT.POINTER_MOVE, 260, 280, 0, 0, 1), camera)).toBe(true);
    camera.worldToScreen(0, 0, p);
    expect(p.x - origin.x).toBeCloseTo(10, 9);
    expect(p.y - origin.y).toBeCloseTo(0, 9);
  });

  it("starts a new anchor after the fingers lift", () => {
    const { camera, controls } = make();
    controls.apply(rec(INPUT.PINCH, 300, 300, 100), camera);
    controls.apply(rec(INPUT.POINTER_UP, 300, 300), camera);
    const zoom = camera.zoom;
    expect(controls.apply(rec(INPUT.PINCH, 300, 300, 400), camera)).toBe(false);
    expect(camera.zoom).toBe(zoom);
  });

  it("keeps the zoom when the finger distance is zero", () => {
    const { camera, controls } = make();
    const zoom = camera.zoom;
    controls.apply(rec(INPUT.PINCH, 300, 300, 100), camera);
    controls.apply(rec(INPUT.PINCH, 300, 300, 0), camera);
    expect(camera.zoom).toBe(zoom);
    controls.apply(rec(INPUT.PINCH, 300, 300, 100), camera);
    expect(camera.zoom).toBe(zoom);
  });

  it("ignores pinch when pan and zoom are off", () => {
    const { camera, controls } = make();
    controls.panMode = false;
    controls.zoomMode = false;
    const zoom = camera.zoom;
    controls.apply(rec(INPUT.PINCH, 300, 300, 100), camera);
    expect(controls.apply(rec(INPUT.PINCH, 300, 300, 200), camera)).toBe(false);
    expect(camera.zoom).toBe(zoom);
  });
});

describe("Controls modes", () => {
  it("with pan manual, a left drag leaves the camera and reports the pan delta", () => {
    const { camera, controls } = make();
    controls.panMode = "manual";
    const before = { x: camera.x, y: camera.y };
    controls.apply(rec(INPUT.POINTER_DOWN, 100, 100, 0, 0, 1), camera);
    expect(controls.apply(rec(INPUT.POINTER_MOVE, 140, 120, 0, 0, 1), camera)).toBe(false);
    controls.apply(rec(INPUT.POINTER_MOVE, 150, 125, 0, 0, 1), camera);
    expect(camera.x).toBe(before.x);
    expect(camera.y).toBe(before.y);
    expect(controls.panGesture).toMatchObject({ dirty: true, dx: 50, dy: 25, x: 150, y: 125 });
    controls.apply(rec(INPUT.POINTER_UP, 150, 125), camera);
    expect(controls.panGesture.ended).toBe(true);
  });

  it("with pan auto, a drag moves the camera and reports the same delta", () => {
    const { camera, controls } = make();
    controls.apply(rec(INPUT.POINTER_DOWN, 100, 100, 0, 0, 1), camera);
    camera.worldToScreen(0, 0, p);
    const origin = { ...p };
    expect(controls.apply(rec(INPUT.POINTER_MOVE, 130, 110, 0, 0, 1), camera)).toBe(true);
    camera.worldToScreen(0, 0, p);
    expect(p.x - origin.x).toBeCloseTo(30, 9);
    expect(controls.panGesture).toMatchObject({ dirty: true, dx: 30, dy: 10 });
  });

  it("with pan off, a drag neither moves nor reports", () => {
    const { camera, controls } = make();
    controls.panMode = false;
    const before = { x: camera.x, y: camera.y };
    controls.apply(rec(INPUT.POINTER_DOWN, 100, 100, 0, 0, 1), camera);
    expect(controls.apply(rec(INPUT.POINTER_MOVE, 140, 120, 0, 0, 1), camera)).toBe(false);
    expect(camera.x).toBe(before.x);
    expect(camera.y).toBe(before.y);
    expect(controls.panGesture.dirty).toBe(false);
  });

  it("with rotate auto, a twist rotates the camera by the angle change around the midpoint", () => {
    const { camera, controls } = make();
    controls.rotateMode = "auto";
    const rotation = camera.rotation;
    camera.screenToWorld(300, 300, p);
    const before = { ...p };
    controls.apply(rec(INPUT.PINCH, 300, 300, 100, 0), camera);
    expect(controls.apply(rec(INPUT.PINCH, 300, 300, 100, 0.5), camera)).toBe(true);
    expect(camera.rotation).toBeCloseTo(rotation + 0.5, 9);
    camera.screenToWorld(300, 300, p);
    expect(p.x).toBeCloseTo(before.x, 9);
    expect(p.y).toBeCloseTo(before.y, 9);
    expect(controls.rotateGesture).toMatchObject({ dirty: true, x: 300, y: 300 });
    expect(controls.rotateGesture.angle).toBeCloseTo(0.5, 9);
  });

  it("with rotate off, a twist does not rotate", () => {
    const { camera, controls } = make();
    const rotation = camera.rotation;
    controls.apply(rec(INPUT.PINCH, 300, 300, 100, 0), camera);
    expect(controls.apply(rec(INPUT.PINCH, 300, 300, 100, 0.5), camera)).toBe(false);
    expect(camera.rotation).toBe(rotation);
    expect(controls.rotateGesture.dirty).toBe(false);
  });

  it("takes the short way across the half turn", () => {
    const { camera, controls } = make();
    controls.rotateMode = "auto";
    const rotation = camera.rotation;
    controls.apply(rec(INPUT.PINCH, 300, 300, 100, 3.1), camera);
    controls.apply(rec(INPUT.PINCH, 300, 300, 100, -3.1), camera);
    expect(camera.rotation).toBeCloseTo(rotation + 2 * Math.PI - 6.2, 9);
  });

  it("with zoom manual, the wheel reports a factor and starts no glide", () => {
    const { camera, controls } = make();
    controls.zoomMode = "manual";
    const zoom = camera.zoom;
    expect(controls.apply(rec(INPUT.WHEEL, 400, 300, 0, -100), camera)).toBe(false);
    expect(controls.advance(0.016, camera)).toBe(false);
    expect(camera.zoom).toBe(zoom);
    expect(controls.zoomGesture.dirty).toBe(true);
    expect(controls.zoomGesture.factor).toBeGreaterThan(1);
    expect(controls.zoomGesture).toMatchObject({ x: 400, y: 300 });
  });

  it("with zoom off, the wheel is ignored", () => {
    const { camera, controls } = make();
    controls.zoomMode = false;
    expect(controls.apply(rec(INPUT.WHEEL, 400, 300, 0, -100), camera)).toBe(false);
    expect(controls.zoomGesture.dirty).toBe(false);
  });

  it("ends a wheel zoom once the wheel has been quiet", () => {
    const { camera, controls } = make();
    controls.apply(rec(INPUT.WHEEL, 400, 300, 0, -100), camera);
    const due = controls.settleWheel(1000);
    expect(due).toBeGreaterThan(0);
    expect(controls.settleWheel(1000 + due - 1)).toBeGreaterThan(0);
    expect(controls.zoomGesture.ended).toBe(false);
    expect(controls.settleWheel(1000 + due)).toBe(0);
    expect(controls.zoomGesture.ended).toBe(true);
  });

  it("a pinch reports pan and zoom and ends them when the fingers lift", () => {
    const { camera, controls } = make();
    controls.apply(rec(INPUT.PINCH, 300, 300, 100), camera);
    controls.apply(rec(INPUT.PINCH, 320, 310, 200), camera);
    expect(controls.panGesture).toMatchObject({ dirty: true, dx: 20, dy: 10 });
    expect(controls.zoomGesture.factor).toBeCloseTo(2, 9);
    controls.apply(rec(INPUT.POINTER_UP, 320, 310), camera);
    expect(controls.panGesture.ended).toBe(true);
    expect(controls.zoomGesture.ended).toBe(true);
  });
});
