import { archives, latest } from "virtual:api";
import { createContext, useContext, useEffect, useState } from "react";
import type { ApiEntry, ApiGroup, ApiText, ApiVersion } from "./types";

export class Api {
  readonly id: string;
  readonly version: string;
  readonly base: string;
  readonly groups: ApiGroup[];
  readonly entries: ApiEntry[];
  readonly latest: boolean;
  private readonly text = new Map<string, ApiText>();
  private readonly group = new Map<string, ApiGroup>();
  private readonly names: Set<string>;

  constructor(v: ApiVersion, latest: boolean) {
    this.id = v.id;
    this.version = v.version;
    this.base = v.base;
    this.groups = v.groups;
    this.entries = v.entries;
    this.latest = latest;
    this.names = new Set(v.entries.map((e) => e.name));
    for (const g of v.groups) {
      for (const name of [...(g.namespace ? [g.namespace] : []), ...g.types, ...g.values]) {
        this.group.set(name, g);
        const text = g.docs[name];
        if (text) this.text.set(name, text);
      }
    }
  }

  has(name: string): boolean {
    return this.names.has(name);
  }

  entriesOf(name: string): ApiEntry[] {
    return this.entries.filter((e) => e.name === name);
  }

  textOf(name: string): ApiText {
    return this.text.get(name) ?? {};
  }

  groupOf(name: string): ApiGroup | undefined {
    return this.group.get(name);
  }

  labelOf(name: string): string {
    return this.text.get(name)?.label ?? this.entries.find((e) => e.name === name && e.label)?.label ?? name;
  }

  summaryOf(name: string): string {
    return this.entriesOf(name)[0]?.doc.summary ?? "";
  }

  itemHref(name: string, hash?: string): string {
    return `${this.base}/${name}${hash ? `#${hash}` : ""}`;
  }

  href(path: string): string {
    return path === "/api" || path.startsWith("/api/") || path.startsWith("/api#") ? `${this.base}${path.slice(4)}` : path;
  }
}

export const LATEST_API = new Api(latest, true);

export const VERSIONS = [
  { id: latest.id, version: latest.version, latest: true },
  ...archives.map((a) => ({ id: a.id, version: a.version, latest: false })),
];

const loaded = new Map<string, Api>();
const loading = new Map<string, Promise<Api>>();

export function apiOf(id: string): Promise<Api> | undefined {
  if (id === LATEST_API.id) return Promise.resolve(LATEST_API);
  const archive = archives.find((a) => a.id === id);
  if (!archive) return undefined;
  let p = loading.get(id);
  if (!p) {
    p = archive.load().then((m) => {
      const api = new Api(m.default, false);
      loaded.set(id, api);
      return api;
    });
    loading.set(id, p);
  }
  return p;
}

export function useApiVersion(id: string | undefined): Api | null | undefined {
  const [, setCount] = useState(0);
  const known = !id || archives.some((a) => a.id === id);
  const api = id ? loaded.get(id) : LATEST_API;
  useEffect(() => {
    if (!id || api || !known) return;
    let live = true;
    apiOf(id)?.then(() => {
      if (live) setCount((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [id, api, known]);
  return known ? api : null;
}

export const ApiContext = createContext(LATEST_API);

export function useApi(): Api {
  return useContext(ApiContext);
}
