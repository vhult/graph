import { rng } from "./datasets";

export type BenchIcon = { svg: string } | { path: string | string[]; viewBox?: [number, number, number, number]; fillRule?: "nonzero" | "evenodd" };

type Point = [number, number];

const f = (v: number) => Number(v.toFixed(3)).toString();
const pt = (p: Point) => `${f(p[0])} ${f(p[1])}`;

function circle(cx: number, cy: number, r: number): string {
  return `M${f(cx - r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)}A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)}Z`;
}

function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const a = `A${f(r)} ${f(r)} 0 0 1`;
  return (
    `M${f(x + r)} ${f(y)}H${f(x + w - r)}${a} ${f(x + w)} ${f(y + r)}V${f(y + h - r)}${a} ${f(x + w - r)} ${f(y + h)}` +
    `H${f(x + r)}${a} ${f(x)} ${f(y + h - r)}V${f(y + r)}${a} ${f(x + r)} ${f(y)}Z`
  );
}

function polygon(points: Point[]): string {
  return points.map((p, k) => `${k === 0 ? "M" : "L"}${pt(p)}`).join("") + "Z";
}

function sweepVia(c: Point, from: Point, via: Point, to: Point): number {
  const turn = (p: Point) => {
    const a = Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(from[1] - c[1], from[0] - c[0]);
    return a < 0 ? a + Math.PI * 2 : a;
  };
  return turn(via) < turn(to) ? 1 : 0;
}

function gear(r: () => number): BenchIcon {
  const teeth = 8 + Math.floor(r() * 3);
  const outer = 10.5;
  const inner = 8 - r() * 0.8;
  const step = (Math.PI * 2) / teeth;
  const p = (a: number, rad: number) => `${f(12 + Math.cos(a) * rad)} ${f(12 + Math.sin(a) * rad)}`;
  let d = "";
  for (let k = 0; k < teeth; k++) {
    const a = k * step;
    d += `${k === 0 ? "M" : "L"}${p(a, inner)}L${p(a + step * 0.12, outer)}L${p(a + step * 0.38, outer)}L${p(a + step * 0.5, inner)}`;
    d += `A${f(inner)} ${f(inner)} 0 0 1 ${p(a + step, inner)}`;
  }
  return { path: [d + "Z", circle(12, 12, 3.2 + r() * 0.8)], fillRule: "evenodd" };
}

function star(r: () => number): BenchIcon {
  const points = 5 + Math.floor(r() * 3);
  const outer = 10.5;
  const inner = outer * (0.42 + r() * 0.08);
  const pts: Point[] = [];
  for (let k = 0; k < points * 2; k++) {
    const a = (k / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const rad = k % 2 === 0 ? outer : inner;
    pts.push([12 + Math.cos(a) * rad, 12.6 + Math.sin(a) * rad]);
  }
  return { path: polygon(pts) };
}

function heart(r: () => number): BenchIcon {
  const w = 9 + r() * 0.8;
  const dip = 7 + r() * 0.6;
  const L = 12 - w;
  const R = 12 + w;
  return {
    path:
      `M12 20.5C8 17.6 ${f(L)} 14.2 ${f(L)} 9C${f(L)} 6 ${f(L + 2)} 4 ${f(L + 4.5)} 4C${f(L + 6.4)} 4 11 5.2 12 ${f(dip)}` +
      `C13 5.2 ${f(R - 6.4)} 4 ${f(R - 4.5)} 4C${f(R - 2)} 4 ${f(R)} 6 ${f(R)} 9C${f(R)} 14.2 16 17.6 12 20.5Z`,
  };
}

function target(r: () => number): BenchIcon {
  const rings = 2 - Math.floor(r() * 2);
  const outer = 10.5;
  const band = outer / (rings * 2 + 1);
  const paths: string[] = [];
  for (let k = 0; k < rings * 2; k++) paths.push(circle(12, 12, outer - k * band));
  paths.push(circle(12, 12, band));
  return { path: paths, fillRule: "evenodd" };
}

function chat(r: () => number): BenchIcon {
  const rx = 3 + r() * 1.5;
  const dot = 1.4 + r() * 0.3;
  let body = roundRect(2.5, 3.5, 19, 13.5, rx);
  for (let k = -1; k <= 1; k++) body += circle(12 + k * 4.5, 10.25, dot);
  return {
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
      `<path fill-rule="evenodd" d="${body}"/>` +
      `<polygon points="6.5,15.5 6.5,21.5 12.5,15.5"/></svg>`,
  };
}

function chart(r: () => number): BenchIcon {
  const n = 3 + Math.floor(r() * 3);
  const gap = 1.4;
  const w = (18 - gap * (n - 1)) / n;
  let body = "";
  for (let k = 0; k < n; k++) {
    const h = 5 + ((k + 1) / n) * 11 * (0.75 + r() * 0.25);
    body += `<rect x="${f(3 + k * (w + gap))}" y="${f(21 - h)}" width="${f(w)}" height="${f(h)}" rx="0.8"/>`;
  }
  return { svg: `<svg viewBox="0 0 24 24"><g transform="translate(0 -1.5)">${body}</g><path d="M2 21h20v1.5H2z"/></svg>` };
}

function cloud(r: () => number): BenchIcon {
  const left = 4.2 + r() * 0.6;
  const mid = 5.6 + r() * 0.6;
  const right = 3.8 + r() * 0.6;
  const base = 18.5;
  return {
    svg:
      `<svg viewBox="0 0 24 24">` +
      `<circle cx="${f(2.5 + left)}" cy="${f(base - left)}" r="${f(left)}"/>` +
      `<circle cx="12.5" cy="${f(base - 1.5 - mid)}" r="${f(mid)}"/>` +
      `<circle cx="${f(21.5 - right)}" cy="${f(base - right)}" r="${f(right)}"/>` +
      `<rect x="${f(2.5 + left)}" y="${f(base - 4)}" width="${f(19 - left - right)}" height="4"/></svg>`,
  };
}

function pin(r: () => number): BenchIcon {
  const rad = 7.5;
  const cy = 2 + rad;
  return {
    path: [
      `M12 22C9 18.5 ${f(12 - rad)} 14 ${f(12 - rad)} ${f(cy)}A${f(rad)} ${f(rad)} 0 0 1 ${f(12 + rad)} ${f(cy)}C${f(12 + rad)} 14 15 18.5 12 22Z`,
      circle(12, cy, 2.8 + r() * 0.6),
    ],
    fillRule: "evenodd",
  };
}

function house(r: () => number): BenchIcon {
  const door = 3.5 + r() * 1.5;
  const top = 14 + r() * 1.5;
  const chimney = r() > 0.5;
  const roof = (x: number) => 2.5 + ((x - 12) * 8.5) / 10;
  const peak = chimney ? `L16 ${f(roof(16))}V4H18.5V${f(roof(18.5))}` : "";
  return {
    path: `M12 2.5${peak}L22 11H19.5V21H${f(12 + door / 2)}V${f(top)}H${f(12 - door / 2)}V21H4.5V11H2Z`,
  };
}

function lock(r: () => number): BenchIcon {
  const s = 4.4 + r() * 0.8;
  const t = 2;
  const bodyTop = 10.5;
  const keyhole = 1.7;
  const slot = 0.7;
  const dy = Math.sqrt(keyhole * keyhole - slot * slot);
  const ky = 15;
  return {
    svg:
      `<svg viewBox="0 0 24 24">` +
      `<path d="M${f(12 - s)} 11V8.5A${f(s)} ${f(s)} 0 0 1 ${f(12 + s)} 8.5V11H${f(12 + s - t)}V8.5A${f(s - t)} ${f(s - t)} 0 0 0 ${f(12 - s + t)} 8.5V11Z"/>` +
      `<path fill-rule="evenodd" d="${roundRect(4.5, bodyTop, 15, 11, 2)}M${f(12 - slot)} ${f(ky + dy)}A${keyhole} ${keyhole} 0 1 1 ${f(12 + slot)} ${f(ky + dy)}L12.9 18.5H11.1Z"/></svg>`,
  };
}

function leaf(r: () => number): BenchIcon {
  const a = 7.5 + r() * 1.5;
  const b = 6.5 + r() * 1.5;
  const body = `M20 4C${f(a)} 4 5 ${f(b)} 5.5 18.5C${f(24 - b)} 19 20 ${f(24 - a)} 20 4Z`;
  const along = (s: number, off: number): Point => [5.5 + s + off, 18.5 - s + off];
  const vein = polygon([along(3, -0.35), along(12.5, -0.35), along(12.5, 0.35), along(3, 0.35)]);
  const stem = polygon([along(-3.6, -0.55), along(1.8, -0.55), along(1.8, 0.55), along(-3.6, 0.55)]);
  return { svg: `<svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="${body}${vein}"/><path d="${stem}"/></svg>` };
}

function moon(r: () => number): BenchIcon {
  const c1: Point = [12, 12];
  const R = 9.5;
  const c2: Point = [16.5 + r() * 1.5, 7.5 - r() * 1];
  const R2 = 7.5;
  const dx = c2[0] - c1[0];
  const dy = c2[1] - c1[1];
  const d = Math.hypot(dx, dy);
  const u: Point = [dx / d, dy / d];
  const a = (R * R - R2 * R2 + d * d) / (2 * d);
  const h = Math.sqrt(R * R - a * a);
  const m: Point = [c1[0] + u[0] * a, c1[1] + u[1] * a];
  const p1: Point = [m[0] - u[1] * h, m[1] + u[0] * h];
  const p2: Point = [m[0] + u[1] * h, m[1] - u[0] * h];
  const far: Point = [c1[0] - u[0] * R, c1[1] - u[1] * R];
  const near: Point = [c2[0] - u[0] * R2, c2[1] - u[1] * R2];
  const bigInner = d - a < 0 ? 1 : 0;
  return {
    path:
      `M${pt(p1)}A${f(R)} ${f(R)} 0 1 ${sweepVia(c1, p1, far, p2)} ${pt(p2)}` +
      `A${f(R2)} ${f(R2)} 0 ${bigInner} ${sweepVia(c2, p2, near, p1)} ${pt(p1)}Z`,
  };
}

function shield(r: () => number): BenchIcon {
  const top = 2 + r() * 0.5;
  const side = 11 + r() * 1;
  return {
    path: [
      `M12 ${f(top)}L20 5V${f(side)}C20 16 16.6 20.2 12 22C7.4 20.2 4 16 4 ${f(side)}V5Z`,
      "M7.6 12.4L10.6 15.4L16.4 9.6L17.8 11L10.6 18.2L6.2 13.8Z",
    ],
    fillRule: "evenodd",
  };
}

function bell(r: () => number): BenchIcon {
  const w = 6 + r() * 0.6;
  return {
    path: [
      `M12 3C${f(12 - w + 2.4)} 3 ${f(12 - w)} 5.8 ${f(12 - w)} 9.8V14.8L4 17.3V18.5H20V17.3L${f(12 + w)} 14.8V9.8C${f(12 + w)} 5.8 ${f(12 + w - 2.4)} 3 12 3Z`,
      circle(12, 20.7, 1.8),
    ],
    fillRule: "evenodd",
  };
}

function drop(r: () => number): BenchIcon {
  const w = 7 + r() * 0.6;
  const cy = 22 - w;
  return {
    path: `M12 2.5C10 5.5 ${f(12 - w)} ${f(cy - 4.5)} ${f(12 - w)} ${f(cy)}A${f(w)} ${f(w)} 0 0 0 ${f(12 + w)} ${f(cy)}C${f(12 + w)} ${f(cy - 4.5)} 14 5.5 12 2.5Z`,
  };
}

function key(r: () => number): BenchIcon {
  const teeth = 1 + Math.floor(r() * 2);
  let shaft = "M11.5 11H21.5V15.5H19.5V13";
  if (teeth > 1) shaft += "H18V15H16.5V13";
  shaft += "H11.5Z";
  return {
    svg:
      `<svg viewBox="0 0 24 24">` +
      `<path fill-rule="evenodd" d="${circle(7.5, 12, 5)}${circle(7.5, 12, 2.2)}"/>` +
      `<path d="${shaft}"/></svg>`,
  };
}

function eye(r: () => number): BenchIcon {
  const iris = 4.2 + r() * 0.4;
  return {
    path: [
      "M2 12C4.8 7.2 8.2 5 12 5C15.8 5 19.2 7.2 22 12C19.2 16.8 15.8 19 12 19C8.2 19 4.8 16.8 2 12Z",
      circle(12, 12, iris),
      circle(12, 12, iris * 0.5),
    ],
    fillRule: "evenodd",
  };
}

function building(r: () => number): BenchIcon {
  const floors = 2 + Math.floor(r() * 2);
  let d = "M5 3h14v18h-5v-4h-4v4H5z";
  for (let k = 0; k < floors; k++) {
    const y = 6 + k * 4;
    d += `M8 ${y}h3v2.5H8z M13 ${y}h3v2.5h-3z`;
  }
  return { path: d, fillRule: "evenodd" };
}

function flask(r: () => number): BenchIcon {
  const level = 15 + r() * 1.5;
  const t = (level - 9.2) / (19.1 - 9.2);
  const lx = 10 - t * 5.5;
  const rx = 14 + t * 5.5;
  return {
    path: [
      "M9 2h6v2h-1v5.2l5.6 9.6A2.2 2.2 0 0 1 17.7 22H6.3a2.2 2.2 0 0 1-1.9-3.2L10 9.2V4H9z",
      `M${f(lx + 0.9)} ${f(level)}L6.4 19.8H17.6L${f(rx - 0.9)} ${f(level)}Z`,
    ],
    fillRule: "evenodd",
  };
}

function person(r: () => number): BenchIcon {
  const head = 4.5 + r() * 0.5;
  return { svg: `<svg viewBox="0 0 24 24"><circle cx="12" cy="7.5" r="${f(head)}"/><path d="M3 21.5a9 8 0 0 1 18 0z"/></svg>` };
}

function bolt(r: () => number): BenchIcon {
  const k = r() * 1;
  return { path: polygon([[13.5, 2], [4, 13.5 - k], [10.5, 13.5 - k], [9.5, 22], [20, 9.5 + k], [13.5, 9.5 + k]]) };
}

function pen(r: () => number): BenchIcon {
  const hole = 1.6 + r() * 0.4;
  const slot = 0.6;
  const dy = Math.sqrt(hole * hole - slot * slot);
  return {
    path: [
      "M12 2L18.5 9.5C18.5 13.5 16 16 15 18H9C8 16 5.5 13.5 5.5 9.5Z",
      `M${f(12 - slot)} ${f(10 + dy)}A${f(hole)} ${f(hole)} 0 1 1 ${f(12 + slot)} ${f(10 + dy)}V16.5H${f(12 - slot)}Z`,
      "M8.5 19H15.5V22H8.5Z",
    ],
    fillRule: "evenodd",
  };
}

const KINDS = {
  gear,
  star,
  heart,
  chat,
  chart,
  cloud,
  pin,
  house,
  lock,
  leaf,
  moon,
  shield,
  bell,
  drop,
  key,
  eye,
  target,
  building,
  flask,
  person,
  bolt,
  pen,
} satisfies Record<string, (r: () => number) => BenchIcon>;

export type IconKind = keyof typeof KINDS;

export const ICON_KINDS = Object.keys(KINDS) as IconKind[];

export function benchIcon(kind: IconKind, r: () => number = () => 0): BenchIcon {
  return KINDS[kind](r);
}

export function benchIcons(count: number, seed = 7): BenchIcon[] {
  const r = rng(seed);
  const out: BenchIcon[] = [];
  for (let i = 0; i < count; i++) out.push(KINDS[ICON_KINDS[i % ICON_KINDS.length]!](i < ICON_KINDS.length ? () => 0 : r));
  return out;
}
