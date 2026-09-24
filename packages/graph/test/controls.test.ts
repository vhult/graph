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
  return { type, t: 0, x, y, dx, dy, buttons, mods: 0 };
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

  it("ignores pinch when controls are disabled", () => {
    const { camera, controls } = make();
    controls.enabled = false;
    const zoom = camera.zoom;
    controls.apply(rec(INPUT.PINCH, 300, 300, 100), camera);
    expect(controls.apply(rec(INPUT.PINCH, 300, 300, 200), camera)).toBe(false);
    expect(camera.zoom).toBe(zoom);
  });
});
