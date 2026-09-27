import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const content = join(root, "content");
const name = process.argv[2] ?? "examples.gen";
const out = join(root, name);

const GLOBALS = `declare const graph: import("@vhult/graph").Graph;
declare const canvas: HTMLCanvasElement;
declare function simulate(positions: Float32Array): void;
declare function showFallback(message: string): void;
`;

const TSCONFIG = {
  extends: "../tsconfig.json",
  compilerOptions: { types: ["@webgpu/types", "vite/client"] },
  include: ["./**/*"],
};

const TS = new Set(["ts", "tsx"]);
const examples = [];

function read(file) {
  return parse(readFileSync(file, "utf8"));
}

function files(dir) {
  return readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
}

function add(name, source, lang = "ts") {
  if (TS.has(lang)) examples.push({ file: `${name.replace(/[^\w.-]+/g, "_")}.${lang}`, source });
}

function blocks(prefix, list) {
  list.forEach((b, i) => {
    if (typeof b.code === "string") add(`${prefix}-${i}`, b.code, b.lang ?? "ts");
  });
}

const site = read(join(content, "site.yaml"));
add("landing-code", site.landing.code);
blocks("landing", site.landing.blocks);

for (const f of files(join(content, "pages"))) blocks(`page-${basename(f, ".yaml")}`, read(join(content, "pages", f)).blocks);

for (const f of files(join(content, "api"))) {
  const group = basename(f, ".yaml");
  const docs = read(join(content, "api", f)).docs ?? {};
  for (const [name, text] of Object.entries(docs)) {
    if (text.example) add(`api-${group}-${name}`, text.example);
    for (const [member, m] of Object.entries(text.members ?? {})) {
      if (m.example) add(`api-${group}-${name}-${member}`, m.example);
    }
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "globals.d.ts"), GLOBALS);
writeFileSync(join(out, "tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
for (const e of examples) writeFileSync(join(out, e.file), `${e.source}\nexport {};\n`);
console.log(`${examples.length} examples written to ${name}`);
