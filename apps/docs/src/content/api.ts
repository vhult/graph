import api from "virtual:api";
import content from "virtual:content";
import type { ApiEntry, ApiGroup, ApiText } from "./types";

const TEXT = new Map<string, ApiText>();
const GROUP = new Map<string, ApiGroup>();
for (const g of content.api) {
  for (const name of [...(g.namespace ? [g.namespace] : []), ...g.types, ...g.values]) {
    GROUP.set(name, g);
    const text = g.docs[name];
    if (text) TEXT.set(name, text);
  }
}

export function entriesOf(name: string): ApiEntry[] {
  return api.entries.filter((e) => e.name === name);
}

export function textOf(name: string): ApiText {
  return TEXT.get(name) ?? {};
}

export function groupOf(name: string): ApiGroup | undefined {
  return GROUP.get(name);
}

export function labelOf(name: string): string {
  return TEXT.get(name)?.label ?? api.entries.find((e) => e.name === name && e.label)?.label ?? name;
}

export function summaryOf(name: string): string {
  return entriesOf(name)[0]?.doc.summary ?? "";
}
