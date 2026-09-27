import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const from = process.argv[2];
if (!from) {
  console.error("usage: node apps/docs/scripts/freeze.mjs <checkout of the release to freeze>");
  process.exit(1);
}

const checkout = resolve(from);
const version = JSON.parse(readFileSync(join(checkout, "packages/graph/package.json"), "utf8")).version;
const apiFile = join(checkout, "packages/graph/temp/graph.api.json");
const groups = join(checkout, "apps/docs/content/api/latest");
const order = parse(readFileSync(join(checkout, "apps/docs/content/site.yaml"), "utf8")).api;

if (!existsSync(apiFile)) {
  console.error(`No API model at ${apiFile}. Run "npm run build" in ${checkout} first.`);
  process.exit(1);
}

const id = `v${version.split(".")[0]}`;
const out = join(fileURLToPath(new URL("..", import.meta.url)), "content/api", id);
if (existsSync(out)) {
  console.error(`${out} already exists. A frozen version never changes.`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
for (const f of readdirSync(groups).filter((f) => f.endsWith(".yaml"))) copyFileSync(join(groups, f), join(out, f));
copyFileSync(apiFile, join(out, "api.json"));
writeFileSync(join(out, "archive.json"), `${JSON.stringify({ version, api: order }, null, 2)}\n`);
console.log(`froze ${version} in content/api/${id}`);
