import { existsSync, readFileSync } from "node:fs";
import type { ApiDoc, ApiEntry, ApiMember, ApiModel, Token } from "../src/content/types.ts";

interface RawToken {
  kind: string;
  text: string;
  canonicalReference?: string;
}

interface RawItem {
  kind: string;
  name: string;
  docComment?: string;
  excerptTokens?: RawToken[];
  isOptional?: boolean;
  isReadonly?: boolean;
  isStatic?: boolean;
  members?: RawItem[];
}

const PACKAGE = "@vhult/graph!";

const ENTRY_KINDS: Record<string, ApiEntry["kind"]> = {
  Class: "class",
  Interface: "interface",
  TypeAlias: "type",
  Function: "function",
  Variable: "const",
};

const MEMBER_KINDS: Record<string, ApiMember["kind"]> = {
  Property: "property",
  PropertySignature: "property",
  Method: "method",
  MethodSignature: "method",
  Constructor: "constructor",
};

function refName(ref: string | undefined, names: Set<string>): string | undefined {
  if (!ref?.startsWith(PACKAGE)) return undefined;
  const name = ref.slice(PACKAGE.length).split(/[:#.]/)[0];
  return names.has(name) ? name : undefined;
}

function signature(tokens: RawToken[] = [], names: Set<string>): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    const ref = t.kind === "Reference" ? refName(t.canonicalReference, names) : undefined;
    const last = out[out.length - 1];
    if (!ref && last && !last.ref) last.text += t.text;
    else out.push(ref ? { text: t.text, ref } : { text: t.text });
  }
  const last = out[out.length - 1];
  if (last && !last.ref) last.text = last.text.trimEnd();
  const indents = out.flatMap((t) => [...t.text.matchAll(/\n( *)(?=\S)/g)].map((m) => m[1].length));
  const cut = indents.length > 0 ? Math.min(...indents) : 0;
  if (cut > 0) for (const t of out) t.text = t.text.replace(new RegExp(`\\n {${cut}}`, "g"), "\n");
  return out.filter((t) => t.text.length > 0);
}

function links(text: string): string {
  return text.replace(/\{@link\s+([^}|\s]+)\s*(?:\|\s*([^}]+))?\}/g, (_, target: string, label?: string) => {
    const name = target.split(/[.#]/)[0];
    const hash = target.slice(name.length + 1);
    return `[\`${(label ?? target).trim()}\`](/api/${name}${hash ? `#${hash}` : ""})`;
  });
}

export function parseDoc(raw = ""): ApiDoc {
  const body = raw
    .replace(/^\s*\/\*\*/, "")
    .replace(/\*\/\s*$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
  const [summary, ...rest] = body.split(/^(?=@\w+)/m);
  const tags = rest.map((part) => {
    const match = /^@(\w+)\s*([\s\S]*)$/.exec(part.trim());
    return { tag: match?.[1] ?? "", text: links(match?.[2].trim() ?? "") };
  });
  return { summary: links(summary.trim()), tags };
}

export function readApi(file: string): ApiModel {
  if (!existsSync(file)) throw new Error(`No API model at ${file}. Run "npm run build" at the repo root first.`);
  const model = JSON.parse(readFileSync(file, "utf8")) as { members: RawItem[] };
  const items = model.members[0].members ?? [];
  const names = new Set(items.map((i) => i.name));
  const entries: ApiEntry[] = [];
  for (const item of items) {
    const kind = ENTRY_KINDS[item.kind];
    if (!kind) continue;
    const members: ApiMember[] = [];
    for (const m of item.members ?? []) {
      const memberKind = MEMBER_KINDS[m.kind];
      if (!memberKind) continue;
      members.push({
        name: memberKind === "constructor" ? "constructor" : m.name,
        kind: memberKind,
        signature: signature(m.excerptTokens, names),
        doc: parseDoc(m.docComment),
        optional: m.isOptional === true,
        readonly: m.isReadonly === true,
        static: m.isStatic === true,
      });
    }
    entries.push({ name: item.name, kind, signature: signature(item.excerptTokens, names), doc: parseDoc(item.docComment), members });
  }
  const graph = entries.find((e) => e.name === "Graph");
  for (const m of graph?.members ?? []) {
    const refs = m.signature.filter((t) => t.ref);
    if (m.kind !== "property" || refs.length !== 1) continue;
    const entry = entries.find((e) => e.name === refs[0].ref);
    if (entry && !entry.label) entry.label = `graph.${m.name}`;
  }
  return { entries };
}
