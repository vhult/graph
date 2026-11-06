import type { IconSource } from "@vhult/graph";
import { DEMO_ICONS, type DemoIcon } from "../icons";

const EXTRA = {
  database: {
    svg:
      `<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5.5" rx="8" ry="3"/>` +
      `<path d="M4 8v4c0 1.7 3.6 3 8 3s8-1.3 8-3V8c0 1.7-3.6 3-8 3S4 9.7 4 8z"/>` +
      `<path d="M4 14v4.5c0 1.7 3.6 3 8 3s8-1.3 8-3V14c0 1.7-3.6 3-8 3s-8-1.3-8-3z"/></svg>`,
  },
  server: {
    svg: `<svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="M3 3h18v5H3zM6 5h2v1H6zM3 9.5h18v5H3zM6 11.5h2v1H6zM3 16h18v5H3zM6 18h2v1H6z"/></svg>`,
  },
  truck: {
    svg: `<svg viewBox="0 0 24 24"><path d="M1 5h13v11H1zM15 8.5h4l3 4v3.5h-7z"/><circle cx="6" cy="18.5" r="2.3"/><circle cx="18" cy="18.5" r="2.3"/></svg>`,
  },
  factory: {
    svg: `<svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="M2 21V10l6 3.5V10l6 3.5V3h4v10.5l4-2.5v10zM5 16h3v2H5zM10.5 16h3v2h-3zM16 16h3v2h-3z"/></svg>`,
  },
  store: {
    svg:
      `<svg viewBox="0 0 24 24"><path d="M3.5 3h17L22 8.5c0 1.4-1.1 2.5-2.5 2.5S17 9.9 17 8.5c0 1.4-1.1 2.5-2.5 2.5S12 9.9 12 8.5c0 1.4-1.1 2.5-2.5 2.5S7 9.9 7 8.5C7 9.9 5.9 11 4.5 11S2 9.9 2 8.5z"/>` +
      `<path fill-rule="evenodd" d="M4 12.5h16V21H4zM9.5 15h5v6h-5z"/></svg>`,
  },
} satisfies Record<string, IconSource>;

export type ShowcaseIcon = DemoIcon | keyof typeof EXTRA;

const ICONS: Record<ShowcaseIcon, IconSource> = { ...DEMO_ICONS, ...EXTRA };
const NAMES = Object.keys(ICONS) as ShowcaseIcon[];

export const SHOWCASE_ICON_LIST: readonly IconSource[] = NAMES.map((k) => ICONS[k]);

export function showcaseIconId(name: ShowcaseIcon): number {
  return NAMES.indexOf(name);
}

export function iconMarkup(name: ShowcaseIcon): string {
  const src = ICONS[name];
  if ("svg" in src) return src.svg.replace("<svg ", `<svg fill="currentColor" `);
  const box = (src.viewBox ?? [0, 0, 24, 24]).join(" ");
  const rule = src.fillRule ? ` fill-rule="${src.fillRule}"` : "";
  const paths = (typeof src.path === "string" ? [src.path] : src.path).map((d) => `<path d="${d}"${rule}/>`).join("");
  return `<svg viewBox="${box}" fill="currentColor">${paths}</svg>`;
}
