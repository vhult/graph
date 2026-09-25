import { rng } from "./datasets";

export type BenchIcon = { svg: string } | { path: string | string[]; viewBox?: [number, number, number, number]; fillRule?: "nonzero" | "evenodd" };

const f = (v: number) => v.toFixed(3);

function circle(cx: number, cy: number, r: number, sweep = 0): string {
  return `M${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 ${sweep} ${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 ${sweep} ${f(cx - r)} ${f(cy)}Z`;
}

function gear(r: () => number): BenchIcon {
  const teeth = 6 + Math.floor(r() * 8);
  const outer = 10.5;
  const inner = 8 + r();
  let d = "";
  for (let k = 0; k < teeth; k++) {
    const a0 = (k / teeth) * Math.PI * 2;
    const a1 = a0 + (Math.PI * 2) / teeth / 2;
    const p = (a: number, rad: number) => `${f(12 + Math.cos(a) * rad)} ${f(12 + Math.sin(a) * rad)}`;
    d += `${k === 0 ? "M" : "L"}${p(a0, inner)}L${p(a0 + 0.08, outer)}A${outer} ${outer} 0 0 1 ${p(a1 - 0.08, outer)}L${p(a1, inner)}A${f(inner)} ${f(inner)} 0 0 1 ${p(a1 + (a1 - a0), inner)}`;
  }
  return { path: [d + "Z", circle(12, 12, 3 + r() * 1.5)], fillRule: "evenodd" };
}

function star(r: () => number): BenchIcon {
  const points = 5 + Math.floor(r() * 4);
  const outer = 10.5;
  const inner = 4 + r() * 2.5;
  let d = "";
  for (let k = 0; k < points * 2; k++) {
    const a = (k / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const rad = k % 2 === 0 ? outer : inner;
    const x = 12 + Math.cos(a) * rad;
    const y = 12 + Math.sin(a) * rad;
    if (k === 0) d += `M${f(x)} ${f(y)}`;
    else {
      const m = (k - 0.5) / (points * 2);
      const am = m * Math.PI * 2 - Math.PI / 2;
      const rm = (outer + inner) / 2 + 1.2;
      d += `Q${f(12 + Math.cos(am) * rm)} ${f(12 + Math.sin(am) * rm)} ${f(x)} ${f(y)}`;
    }
  }
  return { path: d + "Z" };
}

function blob(r: () => number): BenchIcon {
  const n = 7 + Math.floor(r() * 6);
  const pts: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const rad = 6 + r() * 4.5;
    pts.push([12 + Math.cos(a) * rad, 12 + Math.sin(a) * rad]);
  }
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let k = 0; k < n; k++) {
    const p0 = pts[(k - 1 + n) % n]!;
    const p1 = pts[k]!;
    const p2 = pts[(k + 1) % n]!;
    const p3 = pts[(k + 2) % n]!;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0]!)} ${f(c1[1]!)} ${f(c2[0]!)} ${f(c2[1]!)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return { path: [d + "Z", circle(12, 12, 2 + r() * 1.5)], fillRule: "evenodd" };
}

function rings(r: () => number): BenchIcon {
  const count = 2 + Math.floor(r() * 3);
  const paths: string[] = [];
  for (let k = 0; k < count * 2; k++) paths.push(circle(12, 12, 10.5 - k * (9 / (count * 2))));
  return { path: paths, fillRule: "evenodd" };
}

function badge(r: () => number): BenchIcon {
  const rx = 2 + r() * 3;
  const angle = Math.floor(r() * 4) * 15;
  const holes = 1 + Math.floor(r() * 3);
  let dots = "";
  for (let k = 0; k < holes; k++) dots += `<circle cx="${f(7 + k * 5)}" cy="22" r="1.2" fill="#000"/>`;
  return {
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
      `<g transform="rotate(${angle} 12 12)"><rect x="3" y="5" width="18" height="14" rx="${f(rx)}"/></g>` +
      `<g fill="none" stroke="#fff"><path d="M0 0L24 24"/></g>` +
      `<polygon points="12,2 15,7 9,7"/>${dots}</svg>`,
  };
}

function bars(r: () => number): BenchIcon {
  const n = 3 + Math.floor(r() * 3);
  let body = "";
  for (let k = 0; k < n; k++) {
    const h = 4 + r() * 14;
    body += `<rect x="${f(3 + k * (18 / n))}" y="${f(21 - h)}" width="${f(18 / n - 1.2)}" height="${f(h)}" rx="0.8"/>`;
  }
  return { svg: `<svg viewBox="0 0 24 24"><g transform="translate(0 -0.5)">${body}</g><path d="M2 22.5h20v1H2z"/></svg>` };
}

const KINDS = [gear, star, blob, rings, badge, bars];

export function benchIcons(count: number, seed = 7): BenchIcon[] {
  const r = rng(seed);
  const out: BenchIcon[] = [];
  for (let i = 0; i < count; i++) out.push(KINDS[i % KINDS.length]!(r));
  return out;
}
