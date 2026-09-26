import { describe, expect, it } from "vitest";
import { Camera2D, nearestAngle, wrapAngle } from "../src/camera/Camera2D";

const p = { x: 0, y: 0 };

function make(): Camera2D {
  const c = new Camera2D();
  c.setViewport(800, 600);
  c.setView({ x: 10, y: -5, zoom: 3, rotation: 0.7 });
  return c;
}

describe("Camera2D", () => {
  it("worldToScreen and screenToWorld are inverses", () => {
    const c = make();
    c.worldToScreen(42, 17, p);
    c.screenToWorld(p.x, p.y, p);
    expect(p.x).toBeCloseTo(42, 9);
    expect(p.y).toBeCloseTo(17, 9);
  });

  it("zoomAt keeps the world point under the cursor fixed", () => {
    const c = make();
    c.screenToWorld(123, 456, p);
    const before = { ...p };
    c.zoomAt(2.5, 123, 456);
    c.screenToWorld(123, 456, p);
    expect(p.x).toBeCloseTo(before.x, 9);
    expect(p.y).toBeCloseTo(before.y, 9);
  });

  it("panByScreen moves content with the pointer", () => {
    const c = make();
    c.worldToScreen(0, 0, p);
    const before = { ...p };
    c.panByScreen(30, -20);
    c.worldToScreen(0, 0, p);
    expect(p.x - before.x).toBeCloseTo(30, 9);
    expect(p.y - before.y).toBeCloseTo(-20, 9);
  });

  it("fitRotated frames the bounds inside the padded viewport", () => {
    const c = make();
    c.rotation = 0;
    c.fitRotated({ minX: -100, minY: -50, maxX: 100, maxY: 50 }, 0);
    expect(c.zoom).toBeCloseTo(4, 9);
    c.worldToScreen(-100, 0, p);
    expect(p.x).toBeCloseTo(0, 9);
  });

  it("fitRotated keeps the rotation and fits the rotated box", () => {
    const c = make();
    c.rotation = Math.PI / 4;
    const b = { minX: 0, minY: 0, maxX: 10, maxY: 2 };
    c.fitRotated(b, 0);
    expect(c.rotation).toBe(Math.PI / 4);
    expect(c.zoom).toBeCloseTo((600 * Math.SQRT2) / 12, 9);
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of [[0, 0], [10, 0], [0, 2], [10, 2]] as const) {
      c.worldToScreen(x, y, p);
      expect(p.x).toBeGreaterThanOrEqual(-1e-9);
      expect(p.x).toBeLessThanOrEqual(800 + 1e-9);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    expect(minY).toBeCloseTo(0, 6);
    expect(maxY).toBeCloseTo(600, 6);
  });

  it("limits clamp zoom in setView, zoomAt and fitRotated", () => {
    const c = make();
    c.setLimits(0.5, 2, null);
    expect(c.zoom).toBe(2);
    c.setView({ zoom: 0.1 });
    expect(c.zoom).toBe(0.5);
    c.zoomAt(100, 10, 10);
    expect(c.zoom).toBe(2);
    c.fitRotated({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, 0);
    expect(c.zoom).toBe(2);
  });

  it("limit bounds keep the centre inside in setView and panByScreen", () => {
    const c = make();
    c.setLimits(0, Infinity, { minX: 0, minY: 0, maxX: 100, maxY: 50 });
    expect(c.x).toBe(10);
    expect(c.y).toBe(0);
    c.setView({ x: -20, y: 80 });
    expect(c.x).toBe(0);
    expect(c.y).toBe(50);
    c.setView({ x: 50, y: 25, rotation: 0 });
    c.panByScreen(-1e6, 1e6);
    expect(c.x).toBe(100);
    expect(c.y).toBe(0);
    c.setLimits(0, Infinity, null);
    c.setView({ x: -20 });
    expect(c.x).toBe(-20);
  });

  it("rotateAround keeps the world point under the pivot", () => {
    const c = make();
    c.screenToWorld(100, 400, p);
    const before = { ...p };
    c.rotateAround(0.9, 100, 400);
    expect(c.rotation).toBeCloseTo(1.6, 9);
    c.screenToWorld(100, 400, p);
    expect(p.x).toBeCloseTo(before.x, 9);
    expect(p.y).toBeCloseTo(before.y, 9);
  });

  it("wrapAngle maps into (-π, π] and nearestAngle takes the short arc", () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(4 * Math.PI)).toBeCloseTo(0, 12);
    expect(wrapAngle(7)).toBeCloseTo(7 - 2 * Math.PI, 12);
    expect(wrapAngle(-7)).toBeCloseTo(2 * Math.PI - 7, 12);
    expect(nearestAngle(4 * Math.PI, 0)).toBeCloseTo(4 * Math.PI, 12);
    expect(nearestAngle(3, -3)).toBeCloseTo(2 * Math.PI - 3, 12);
    expect(nearestAngle(-3, 3)).toBeCloseTo(3 - 2 * Math.PI, 12);
    expect(nearestAngle(0.2, 0.5)).toBeCloseTo(0.5, 12);
  });

  it("a rotation set after many turns lands normalized the short way", () => {
    const c = make();
    for (let i = 0; i < 8; i++) {
      c.rotateAround(Math.PI / 2, 400, 300);
      c.rotation = wrapAngle(c.rotation);
    }
    const from = c.rotation;
    expect(from).toBeCloseTo(0.7, 9);
    const target = nearestAngle(from, 0);
    expect(target).toBeCloseTo(0, 9);
    c.setView({ rotation: target });
    c.rotation = wrapAngle(c.rotation);
    expect(c.rotation).toBeCloseTo(0, 9);
    c.setView({ rotation: nearestAngle(c.rotation, 7) });
    c.rotation = wrapAngle(c.rotation);
    expect(c.rotation).toBeCloseTo(7 - 2 * Math.PI, 12);
  });

  it("the unlimited fit zoom ignores the camera limits", () => {
    const b = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const c = make();
    const free = c.fitZoom(b, 24);
    c.setLimits(1e-6, free / 4, null);
    expect(c.fitZoom(b, 24)).toBe(free / 4);
    expect(Camera2D.fitZoomIn(b, 24, c.viewportW, c.viewportH)).toBe(free);
  });

  it("a pixel-ratio change rescales zoom to keep zoom / pixelRatio constant", () => {
    const c = make();
    const oldPixelRatio = 1;
    const newPixelRatio = 2;
    const cssZoom = c.zoom / oldPixelRatio;
    c.zoom *= newPixelRatio / oldPixelRatio;
    expect(c.zoom / newPixelRatio).toBeCloseTo(cssZoom, 9);
  });
});
