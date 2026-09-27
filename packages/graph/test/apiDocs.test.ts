import { describe, expect, it } from "vitest";

interface ApiItem {
  kind: string;
  name?: string;
  docComment?: string;
  members?: ApiItem[];
}

const source = Object.values(
  import.meta.glob("../temp/graph.api.json", { eager: true, query: "?raw", import: "default" }),
)[0];

function undocumented(item: ApiItem, prefix: string, out: string[]): string[] {
  for (const member of item.members ?? []) {
    const own = member.name ?? member.kind;
    const name = member.kind === "EntryPoint" ? "" : prefix ? `${prefix}.${own}` : own;
    if (member.kind !== "EntryPoint" && !member.docComment?.trim()) out.push(`${member.kind} ${name}`);
    undocumented(member, name, out);
  }
  return out;
}

describe("api docs", () => {
  const title = source
    ? "gives every public member a doc line"
    : "gives every public member a doc line (skipped: temp/graph.api.json is missing, run npm run build)";
  it.skipIf(!source)(title, () => {
    const model = JSON.parse(source!) as ApiItem;
    expect(undocumented(model, "", [])).toEqual([]);
  });
});
