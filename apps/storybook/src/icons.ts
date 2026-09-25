import type { IconSource } from "@vhult/graph";

function gear(teeth: number, outer: number, inner: number, hole: number): string {
  const p = (a: number, r: number) => `${(12 + Math.cos(a) * r).toFixed(3)} ${(12 + Math.sin(a) * r).toFixed(3)}`;
  const step = (Math.PI * 2) / teeth;
  let d = "";
  for (let k = 0; k < teeth; k++) {
    const a = k * step;
    d += `${k === 0 ? "M" : "L"}${p(a, inner)}L${p(a + step * 0.12, outer)}L${p(a + step * 0.38, outer)}L${p(a + step * 0.5, inner)}A${inner} ${inner} 0 0 1 ${p(a + step, inner)}`;
  }
  return `${d}Z M${12 - hole} 12a${hole} ${hole} 0 1 0 ${hole * 2} 0a${hole} ${hole} 0 1 0 ${-hole * 2} 0Z`;
}

export const DEMO_ICONS = {
  building: {
    path: "M5 3h14v18h-5v-4h-4v4H5z M8 6h3v3H8z M13 6h3v3h-3z M8 11h3v3H8z M13 11h3v3h-3z",
    fillRule: "evenodd",
  },
  pen: {
    path: "M12 2l6 9.5-6 10.5-6-10.5z M12 8.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6z M11.4 13h1.2v7h-1.2z",
    fillRule: "evenodd",
  },
  flask: {
    path: "M9 2h6v2h-1v5.2l5.6 9.6A2.2 2.2 0 0 1 17.7 22H6.3a2.2 2.2 0 0 1-1.9-3.2L10 9.2V4H9z M8.2 15l-1.9 3.6h11.4L15.8 15z",
    fillRule: "evenodd",
  },
  gear: { path: gear(8, 10.5, 8, 3.2), fillRule: "evenodd" },
  chart: {
    svg: '<svg viewBox="0 0 24 24"><rect x="3" y="13" width="4.5" height="8" rx="1"/><rect x="9.75" y="8" width="4.5" height="13" rx="1"/><rect x="16.5" y="3" width="4.5" height="18" rx="1"/></svg>',
  },
  chat: {
    path: "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M7 8.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z M12 8.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z M17 8.5a1.5 1.5 0 1 0 0 3a1.5 1.5 0 1 0 0-3z",
    fillRule: "evenodd",
  },
  bolt: { path: "M13.5 2L4 13.5h6.5L9.5 22 20 9.5h-6.5z" },
  person: {
    svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="7.5" r="4.5"/><path d="M3 21.5a9 8 0 0 1 18 0z"/></svg>',
  },
  rings: {
    path: [
      "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0z",
      "M5 12a7 7 0 1 0 14 0a7 7 0 1 0-14 0z",
      "M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0z",
    ],
    fillRule: "evenodd",
  },
  star: { path: "M12 2l2.9 7h7.1l-5.8 4.4 2.3 7.6L12 16.4 5.5 21l2.3-7.6L2 9h7.1z" },
  pentagram: { path: "M12 2L17.9 20.1L2.5 8.9H21.5L6.1 20.1Z", fillRule: "evenodd" },
  pentagramFilled: { path: "M12 2L17.9 20.1L2.5 8.9H21.5L6.1 20.1Z" },
} as const satisfies Record<string, IconSource>;

export type DemoIcon = keyof typeof DEMO_ICONS;

export const DEMO_ICON_NAMES = Object.keys(DEMO_ICONS) as DemoIcon[];

export const DEMO_ICON_LIST: readonly IconSource[] = DEMO_ICON_NAMES.map((k) => DEMO_ICONS[k]);

export function iconId(name: DemoIcon): number {
  return DEMO_ICON_NAMES.indexOf(name);
}
