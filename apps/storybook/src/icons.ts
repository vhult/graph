import type { IconSource } from "@vhult/graph";
import { benchIcon, ICON_KINDS, type IconKind } from "@vhult/graph-bench";

const PENTAGRAM = "M12 2L17.9 20.1L2.5 8.9H21.5L6.1 20.1Z";

export type DemoIcon = IconKind | "pentagram" | "pentagramFilled";

export const DEMO_ICONS: Record<DemoIcon, IconSource> = {
  ...(Object.fromEntries(ICON_KINDS.map((k) => [k, benchIcon(k)])) as Record<IconKind, IconSource>),
  pentagram: { path: PENTAGRAM, fillRule: "evenodd" },
  pentagramFilled: { path: PENTAGRAM },
};

export const DEMO_ICON_NAMES = Object.keys(DEMO_ICONS) as DemoIcon[];

export const DEMO_ICON_LIST: readonly IconSource[] = DEMO_ICON_NAMES.map((k) => DEMO_ICONS[k]);

export function iconId(name: DemoIcon): number {
  return DEMO_ICON_NAMES.indexOf(name);
}
