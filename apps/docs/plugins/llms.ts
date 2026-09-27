import type { ApiDoc, ApiEntry, ApiGroup, ApiMember, ApiMemberText, ApiVersion, Block, Content, Token } from "../src/content/types.ts";

function inline(text: string): string {
  return text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label: string, href: string) => (href.startsWith("/") ? label : all));
}

function fence(code: string, lang = "ts"): string {
  return `\`\`\`${lang}\n${code.replace(/\n+$/, "")}\n\`\`\``;
}

function sig(tokens: Token[]): string {
  return tokens.map((t) => t.text).join("");
}

function block(b: Block): string {
  if ("heading" in b) return `### ${inline(b.heading)}`;
  if ("subheading" in b) return `#### ${inline(b.subheading)}`;
  if ("code" in b) return fence(b.code, b.lang ?? "ts");
  if ("list" in b) return b.list.map((i) => `- ${inline(i)}`).join("\n");
  if ("note" in b) return `> **${b.kind === "warning" ? "Warning" : "Note"}:** ${inline(b.note)}`;
  if ("table" in b) {
    const row = (cells: string[]) => `| ${cells.map((c) => inline(c).replace(/\|/g, "\\|")).join(" | ")} |`;
    return [row(b.table.columns), row(b.table.columns.map(() => "---")), ...b.table.rows.map(row)].join("\n");
  }
  if ("cards" in b) return b.cards.map((c) => `- **${c.title}**: ${inline(c.text)}`).join("\n");
  if ("points" in b) return b.points.map((p, i) => `${i + 1}. **${p.title}**: ${inline(p.text)}`).join("\n");
  if ("api" in b) return b.api.map((name) => `- \`${name}\``).join("\n");
  return inline(b.text);
}

function doc(d: ApiDoc, text: ApiMemberText): string[] {
  const out: string[] = [];
  const description = text.description ?? d.summary;
  if (description) out.push(inline(description));
  for (const t of d.tags) out.push(`@${t.tag} ${inline(t.text)}`);
  if (text.example) out.push(`Example:\n\n${fence(text.example)}`);
  return out;
}

function member(m: ApiMember, text: ApiMemberText): string[] {
  const flags = [m.static && "static", m.readonly && "readonly", m.optional && "optional"].filter(Boolean).join(", ");
  return [`#### \`${m.name}\`${flags ? ` (${flags})` : ""}`, fence(sig(m.signature)), ...doc(m.doc, text)];
}

function entry(e: ApiEntry, group: ApiGroup, first: boolean): string[] {
  const text = first ? (group.docs[e.name] ?? {}) : {};
  const label = group.docs[e.name]?.label ?? e.label;
  const title = label && label !== e.name ? `\`${label}\` (${e.kind} \`${e.name}\`)` : `\`${e.name}\` (${e.kind})`;
  const out = [`### ${title}`, ...doc(e.doc, text).slice(0, 1), fence(sig(e.signature)), ...doc(e.doc, text).slice(1)];
  for (const m of e.members) out.push(...member(m, group.docs[e.name]?.members?.[m.name] ?? {}));
  return out;
}

function groupNames(g: ApiGroup): string[] {
  return [...(g.namespace ? [g.namespace] : []), ...g.types, ...g.values];
}

export interface LlmsFiles {
  index: string;
  full: string;
}

export function llmsFiles(content: Content, api: ApiVersion): LlmsFiles {
  const { site, version, pages } = content;
  const pageOrder = site.docs.flatMap((s) => s.pages.map((id) => pages[id]));
  const summary = `> ${site.description}. ${site.landing.lead}`;
  const links = `Install: \`${site.landing.install}\`. Source: https://github.com/${site.github}. Package: https://www.npmjs.com/package/${site.npm}.`;

  const index = [
    `# ${site.name}`,
    summary,
    `Version ${version}. ${links}`,
    "The whole documentation, guides and API reference, is in one Markdown file. Fetch it for any question about the library.",
    "## Docs",
    `- [Full documentation](/llms-full.txt): every guide and the whole API reference, with signatures and examples`,
    "## Contents of the full documentation",
    [
      ...pageOrder.map((p) => `- Guide, ${p.title}${p.description ? `: ${inline(p.description)}` : ""}`),
      ...api.groups.map((g) => `- API, ${g.title}: ${groupNames(g).join(", ")}`),
    ].join("\n"),
  ].join("\n\n");

  const full: string[] = [`# ${site.name} ${version}`, summary, links, "## Quick start", fence(site.landing.code), "# Guides"];
  for (const p of pageOrder) {
    full.push(`## ${p.title}`);
    if (p.description) full.push(inline(p.description));
    for (const b of p.blocks) full.push(block(b));
  }
  full.push("# API reference");
  for (const g of api.groups) {
    full.push(`## ${g.title}`);
    if (g.intro) full.push(inline(g.intro));
    for (const name of groupNames(g)) {
      api.entries.filter((e) => e.name === name).forEach((e, i) => full.push(...entry(e, g, i === 0)));
    }
  }

  return { index: `${index}\n`, full: `${full.join("\n\n")}\n` };
}
