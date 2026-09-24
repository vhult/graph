import { describe, expect, it } from "vitest";
import { COL, CPU, DEBUG_HEADER, Probe, type ProbeLayout, type ProbeSink } from "../src/engine/Probe";
import type { ProfileSample } from "../src/gpu/Profiler";

function sink() {
  const out = { ring: null as Float64Array | null, recording: null as { data: Float64Array; rows: number; layout: ProbeLayout } | null };
  const s: ProbeSink = {
    ring: () => {},
    rows: (d) => (out.ring = d),
    totals: () => {},
    recording: (layout, data, rows) => (out.recording = { data, rows, layout }),
  };
  return { s, out };
}

function sample(frameIndex: number, slotMs: number[]): ProfileSample {
  const ms = new Float64Array(32).fill(NaN);
  slotMs.forEach((v, k) => (ms[k] = v));
  return { frameIndex, complete: true, gpuTotalMs: slotMs.reduce((a, b) => a + b, 0) + 0.5, slotMs: ms, bucketCounts: new Uint32Array([10, 1, 2, 3]), edgeCount: 7 };
}

describe("Probe", () => {
  it("names columns for fixed values, gpu slots and cpu stages", () => {
    const { s } = sink();
    const p = new Probe(["render", "cull.count"], ["render", "cull"], ["cull"], false, 0, s);
    const cols = p.layout.columns;
    expect(cols.slice(p.gpuBase, p.cpuBase)).toEqual(["gpu.render", "gpu.cull.count"]);
    expect(cols[p.cpuBase + CPU.FRAME]).toBe("cpu.frame");
    expect(cols[p.encodeBase]).toBe("cpu.encode.cull");
    expect(cols[cols.length - 1]).toBe("cpu.encode.render");
  });

  it("stays off until a level is set", () => {
    const { s } = sink();
    const p = new Probe(["render"], ["render"], [], false, 0, s);
    expect(p.on).toBe(false);
    p.setLevel(1);
    expect(p.on).toBe(true);
    expect(p.full).toBe(false);
    p.setLevel(2);
    expect(p.full).toBe(true);
    p.setLevel(0);
    expect(p.on).toBe(false);
    p.destroy();
  });

  it("writes late GPU samples into the frame's row with the idle gap", () => {
    const { s } = sink();
    const p = new Probe(["render", "cull.count"], ["render", "cull"], [], false, 0, s);
    p.setLevel(2);
    p.begin(100);
    p.mark(CPU.INPUT);
    p.end(0, 100, 1.5, 4, 0, 0, NaN);
    p.onSample(sample(0, [2, 1]));
    const ring = (p as unknown as { ring: Float64Array }).ring;
    const row = ring.subarray(DEBUG_HEADER, DEBUG_HEADER + p.width);
    expect(row[COL.FRAME]).toBe(0);
    expect(row[COL.SAMPLED]).toBe(1);
    expect(row[COL.GPU]).toBeCloseTo(3.5);
    expect(row[COL.GPU_GAP]).toBeCloseTo(0.5);
    expect(row[COL.NODES]).toBe(16);
    expect(row[COL.EDGES]).toBe(7);
    expect(row[p.cpuBase + CPU.FRAME]).toBe(1.5);
    expect(row[p.cpuBase + CPU.INPUT]).toBeGreaterThanOrEqual(0);
    p.destroy();
  });

  it("records frames and hands them over once every frame is sampled", () => {
    const { s, out } = sink();
    const p = new Probe(["render"], ["render"], [], false, 0, s);
    p.record(true);
    expect(p.full).toBe(true);
    for (let f = 0; f < 3; f++) {
      p.begin(f * 16);
      p.end(f, f * 16, 1, 0, 0, 0, NaN);
    }
    p.record(false);
    expect(out.recording).toBeNull();
    for (let f = 0; f < 3; f++) p.onSample(sample(f, [1]));
    expect(out.recording!.rows).toBe(3);
    const w = out.recording!.layout.columns.length;
    expect(out.recording!.data[2 * w + COL.FRAME]).toBe(2);
    expect(out.recording!.data[w + COL.INTERVAL]).toBe(16);
    expect(p.recording).toBe(false);
    p.destroy();
  });
});
