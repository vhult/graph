import type { Api } from "./api";

export interface SearchHit {
  href: string;
  crumbs: string[];
  text: string;
}

interface Item extends SearchHit {
  keys: string[];
  dotted: string[];
  member: boolean;
}

const LIMIT = 20;
const index = new WeakMap<Api, Item[]>();

function plain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstLine(text: string | undefined): string {
  const flat = plain(text ?? "");
  const end = flat.search(/\.(\s|$)/);
  return end < 0 ? flat : flat.slice(0, end + 1);
}

function build(api: Api): Item[] {
  const items: Item[] = [];
  for (const g of api.groups) {
    for (const name of [...(g.namespace ? [g.namespace] : []), ...g.types, ...g.values]) {
      const label = api.labelOf(name);
      const text = api.textOf(name);
      const entries = api.entriesOf(name);
      items.push({
        href: api.itemHref(name),
        crumbs: [g.title, label],
        text: firstLine(text.description ?? entries[0]?.doc.summary),
        keys: [...new Set([name, label])].map((k) => k.toLowerCase()),
        dotted: [],
        member: false,
      });
      const seen = new Set<string>();
      for (const m of entries.flatMap((e) => e.members)) {
        if (seen.has(m.name)) continue;
        seen.add(m.name);
        items.push({
          href: api.itemHref(name, m.name),
          crumbs: [g.title, label, m.name],
          text: firstLine(text.members?.[m.name]?.description ?? m.doc.summary),
          keys: [m.name.toLowerCase()],
          dotted: [...new Set([`${label}.${m.name}`, `${name}.${m.name}`])].map((k) => k.toLowerCase()),
          member: true,
        });
      }
    }
  }
  return items;
}

function rank(keys: string[], q: string): number {
  let best = 3;
  for (const k of keys) {
    const r = k === q ? 0 : k.startsWith(q) ? 1 : k.includes(q) ? 2 : 3;
    if (r < best) best = r;
  }
  return best;
}

export function search(api: Api, query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  let items = index.get(api);
  if (!items) {
    items = build(api);
    index.set(api, items);
  }
  const found: { item: Item; score: number; at: number }[] = [];
  items.forEach((item, at) => {
    const r = rank(q.includes(".") ? [...item.keys, ...item.dotted] : item.keys, q);
    if (r < 3) found.push({ item, score: r * 2 + (item.member ? 1 : 0), at });
  });
  found.sort((a, b) => a.score - b.score || a.at - b.at);
  return found.slice(0, LIMIT).map(({ item }) => ({ href: item.href, crumbs: item.crumbs, text: item.text }));
}

export function markRange(text: string, query: string): [number, number] | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const lower = text.toLowerCase();
  for (const part of [q, q.slice(q.lastIndexOf(".") + 1)]) {
    const at = part ? lower.indexOf(part) : -1;
    if (at >= 0) return [at, at + part.length];
  }
  return undefined;
}
