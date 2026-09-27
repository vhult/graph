import { describe, expect, it } from "vitest";
import { CameraAnimation } from "../src/camera/CameraAnimation";

describe("CameraAnimation", () => {
  it("interpolates linearly and ends on the target", () => {
    const a = new CameraAnimation();
    const out = { x: 0, y: 0, zoom: 0, rotation: 0 };
    a.start({ x: 0, y: 0, zoom: 1, rotation: 0 }, { x: 10, y: 0, zoom: 4, rotation: 1 }, 100, "linear", 0);
    expect(a.step(50, out)).toBe(true);
    expect(out.x).toBeCloseTo(5);
    expect(out.zoom).toBeCloseTo(2);
    expect(a.step(100, out)).toBe(false);
    expect(out).toEqual({ x: 10, y: 0, zoom: 4, rotation: 1 });
  });

  it("eases in and out and meets linear at the middle", () => {
    const a = new CameraAnimation();
    const out = { x: 0, y: 0, zoom: 0, rotation: 0 };
    a.start({ x: 0, y: 0, zoom: 1, rotation: 0 }, { x: 10, y: 0, zoom: 1, rotation: 0 }, 100, "ease", 0);
    a.step(25, out);
    expect(out.x).toBeLessThan(2.5);
    a.step(50, out);
    expect(out.x).toBeCloseTo(5);
    a.step(75, out);
    expect(out.x).toBeGreaterThan(7.5);
  });

  it("is active until the end or a cancel", () => {
    const a = new CameraAnimation();
    const out = { x: 0, y: 0, zoom: 0, rotation: 0 };
    expect(a.active).toBe(false);
    a.start({ x: 0, y: 0, zoom: 1, rotation: 0 }, { x: 1, y: 1, zoom: 1, rotation: 0 }, 100, "linear", 1000);
    expect(a.active).toBe(true);
    a.step(1010, out);
    expect(a.active).toBe(true);
    a.cancel();
    expect(a.active).toBe(false);
    a.start({ x: 0, y: 0, zoom: 1, rotation: 0 }, { x: 1, y: 1, zoom: 1, rotation: 0 }, 100, "linear", 1000);
    expect(a.step(1200, out)).toBe(false);
    expect(a.active).toBe(false);
  });

  it("keeps its own copy of the views it was given", () => {
    const a = new CameraAnimation();
    const out = { x: 0, y: 0, zoom: 0, rotation: 0 };
    const to = { x: 10, y: 0, zoom: 1, rotation: 0 };
    a.start({ x: 0, y: 0, zoom: 1, rotation: 0 }, to, 100, "linear", 0);
    to.x = 99;
    a.step(100, out);
    expect(out.x).toBe(10);
  });
});
