import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { ApiGroup, ApiModel, Block, Content, Page, Site } from "../src/content/types.ts";

type Check = (v: unknown, at: string) => void;

const optional = new WeakSet<Check>();

function fail(at: string, message: string): never {
  throw new Error(`${at}: ${message}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function opt(check: Check): Check {
  const wrapped: Check = (v, at) => check(v, at);
  optional.add(wrapped);
  return wrapped;
}

const str: Check = (v, at) => {
  if (typeof v !== "string" || !v.trim()) fail(at, "expected text");
};

const bool: Check = (v, at) => {
  if (typeof v !== "boolean") fail(at, "expected true or false");
};

function list(each: Check): Check {
  return (v, at) => {
    if (!Array.isArray(v)) fail(at, "expected a list");
    v.forEach((x, i) => each(x, `${at}[${i}]`));
  };
}

function record(each: Check): Check {
  return (v, at) => {
    if (!isObject(v)) fail(at, "expected an object");
    for (const [key, x] of Object.entries(v)) each(x, `${at}.${key}`);
  };
}

function oneOf(...values: string[]): Check {
  return (v, at) => {
    if (typeof v !== "string" || !values.includes(v)) fail(at, `expected one of ${values.join(", ")}`);
  };
}

function shape(fields: Record<string, Check>): Check {
  return (v, at) => {
    if (!isObject(v)) fail(at, "expected an object");
    for (const key of Object.keys(v)) {
      if (!(key in fields)) fail(at, `unknown key "${key}", expected one of ${Object.keys(fields).join(", ")}`);
    }
    for (const [key, check] of Object.entries(fields)) {
      if (v[key] === undefined) {
        if (!optional.has(check)) fail(at, `missing "${key}"`);
      } else check(v[key], `${at}.${key}`);
    }
  };
}

const strs = list(str);

const BLOCKS: Record<string, Record<string, Check>> = {
  text: { text: str },
  heading: { heading: str },
  subheading: { subheading: str },
  code: { code: str, lang: opt(str), title: opt(str) },
  list: { list: strs },
  note: { note: str, kind: opt(oneOf("info", "warning")) },
  table: { table: shape({ columns: strs, rows: list(strs) }) },
  cards: { cards: list(shape({ title: str, text: str, href: opt(str) })) },
  points: { points: list(shape({ title: str, text: str })) },
  api: { api: strs },
};

const block: Check = (v, at) => {
  if (!isObject(v)) fail(at, "expected a block");
  const types = Object.keys(v).filter((k) => k in BLOCKS);
  if (types.length !== 1) fail(at, `a block needs exactly one of ${Object.keys(BLOCKS).join(", ")}`);
  shape(BLOCKS[types[0]])(v, `${at} (${types[0]})`);
};

const blocks = list(block);

const link = shape({ label: str, href: str });

const site = shape({
  name: str,
  description: str,
  github: str,
  npm: str,
  badges: list(oneOf("version", "downloads", "license", "size")),
  nav: list(link),
  landing: shape({
    tagline: str,
    lead: str,
    install: str,
    actions: list(shape({ label: str, href: str, primary: opt(bool) })),
    code: str,
    codeTitle: str,
    blocks,
  }),
  docs: list(shape({ section: str, pages: strs })),
  api: strs,
  footer: str,
});

const page = shape({ title: str, description: opt(str), blocks });

const memberText = shape({ description: opt(str), example: opt(str) });

const apiGroup = shape({
  title: str,
  intro: opt(str),
  namespace: opt(str),
  types: opt(strs),
  values: opt(strs),
  docs: opt(record(shape({ label: opt(str), description: opt(str), example: opt(str), members: opt(record(memberText)) }))),
});

function readYaml(file: string, at: string): unknown {
  try {
    return parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(at, e instanceof Error ? e.message : String(e));
  }
}

function hrefs(v: unknown, out: string[]): void {
  if (typeof v === "string") {
    for (const m of v.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1]);
  } else if (Array.isArray(v)) {
    for (const x of v) hrefs(x, out);
  } else if (isObject(v)) {
    for (const [key, x] of Object.entries(v)) {
      if (key === "href" && typeof x === "string") out.push(x);
      else hrefs(x, out);
    }
  }
}

export function yamlFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".yaml"))
        .sort()
        .map((f) => join(dir, f))
    : [];
}

export interface Loaded {
  content: Content;
  warnings: string[];
  missing: string[];
  files: string[];
}

export function loadContent(dir: string, api: ApiModel, version: string): Loaded {
  const siteFile = join(dir, "site.yaml");
  const pageFiles = yamlFiles(join(dir, "pages"));
  const apiFiles = yamlFiles(join(dir, "api"));

  const siteData = readYaml(siteFile, "site.yaml");
  site(siteData, "site.yaml");
  const siteValue = siteData as Site;

  const pages: Record<string, Page> = {};
  for (const file of pageFiles) {
    const id = basename(file, ".yaml");
    const data = readYaml(file, `pages/${id}.yaml`);
    page(data, `pages/${id}.yaml`);
    pages[id] = { id, ...(data as Omit<Page, "id">) };
  }

  const listed = new Set<string>();
  for (const section of siteValue.docs) {
    for (const id of section.pages) {
      if (!pages[id]) fail("site.yaml docs", `page "${id}" has no file pages/${id}.yaml`);
      if (listed.has(id)) fail("site.yaml docs", `page "${id}" is listed twice`);
      listed.add(id);
    }
  }
  for (const id of Object.keys(pages)) {
    if (!listed.has(id)) fail(`pages/${id}.yaml`, "the page is not listed in site.yaml docs");
  }

  const entries = new Map(api.entries.map((e) => [e.name, e]));
  const groupsById = new Map<string, ApiGroup>();
  for (const file of apiFiles) {
    const id = basename(file, ".yaml");
    const at = `api/${id}.yaml`;
    const data = readYaml(file, at);
    apiGroup(data, at);
    const g = data as Partial<ApiGroup> & { title: string };
    groupsById.set(id, { id, title: g.title, intro: g.intro, namespace: g.namespace, types: g.types ?? [], values: g.values ?? [], docs: g.docs ?? {} });
  }

  const groups: ApiGroup[] = [];
  for (const id of siteValue.api) {
    const g = groupsById.get(id);
    if (!g) fail("site.yaml api", `group "${id}" has no file api/${id}.yaml`);
    groups.push(g);
  }
  for (const id of groupsById.keys()) {
    if (!siteValue.api.includes(id)) fail(`api/${id}.yaml`, "the group is not listed in site.yaml api");
  }

  const grouped = new Map<string, string>();
  const missing: string[] = [];
  for (const g of groups) {
    const at = `api/${g.id}.yaml`;
    const items = [...(g.namespace ? [g.namespace] : []), ...g.types, ...g.values];
    for (const name of items) {
      if (!entries.has(name)) fail(at, `"${name}" is not exported by @vhult/graph`);
      if (grouped.has(name)) fail(at, `"${name}" is also in api/${grouped.get(name)}.yaml`);
      grouped.set(name, g.id);
    }
    for (const [name, text] of Object.entries(g.docs)) {
      if (!items.includes(name)) fail(at, `docs for "${name}", which is not in this group`);
      const members = new Set(entries.get(name)!.members.map((m) => m.name));
      for (const member of Object.keys(text.members ?? {})) {
        if (!members.has(member)) fail(at, `docs for "${name}.${member}", which does not exist`);
      }
    }
    for (const name of items) {
      const text = g.docs[name];
      if (!text?.description) missing.push(name);
      for (const m of entries.get(name)!.members) {
        if (!text?.members?.[m.name]?.description) missing.push(`${name}.${m.name}`);
      }
    }
  }

  const warnings: string[] = [];
  const other = [...entries.keys()].filter((n) => !grouped.has(n));
  if (other.length > 0) {
    warnings.push(`API items in no group, shown under "Other": ${other.join(", ")}`);
    groups.push({ id: "other", title: "Other", types: other, values: [], docs: {} });
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 12).join(", ");
    warnings.push(`${missing.length} API items have no description and show their doc comment: ${shown}${missing.length > 12 ? ", ..." : ""}`);
  }

  const sources: [string, unknown][] = [
    ["site.yaml", siteValue],
    ...Object.values(pages).map((p): [string, unknown] => [`pages/${p.id}.yaml`, p]),
    ...groups.map((g): [string, unknown] => [`api/${g.id}.yaml`, g]),
  ];
  for (const [at, v] of sources) {
    const out: string[] = [];
    hrefs(v, out);
    for (const href of out) {
      if (/^(https?:|mailto:|#)/.test(href)) continue;
      const path = href.split("#")[0];
      const ok =
        path === "/" ||
        path === "/api" ||
        path === "/storybook/" ||
        (path.startsWith("/docs/") && pages[path.slice(6)] !== undefined) ||
        (path.startsWith("/api/") && entries.has(path.slice(5)));
      if (!ok) fail(at, `broken link "${href}"`);
    }
  }

  const lists: [string, Block[]][] = [
    ["site.yaml landing", siteValue.landing.blocks],
    ...Object.values(pages).map((p): [string, Block[]] => [`pages/${p.id}.yaml`, p.blocks]),
  ];
  for (const [at, list] of lists) {
    for (const b of list) {
      if ("api" in b) for (const name of b.api) if (!entries.has(name)) fail(at, `api block: "${name}" is not exported by @vhult/graph`);
    }
  }

  return { content: { version, site: siteValue, pages, api: groups }, warnings, missing, files: [siteFile, ...pageFiles, ...apiFiles] };
}
