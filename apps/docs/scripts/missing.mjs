const { readApi } = await import("../plugins/api.ts");
const { loadContent } = await import("../plugins/content.ts");
const root = new URL("..", import.meta.url).pathname;
const r = loadContent(`${root}content`, readApi(`${root}../../packages/graph/temp/graph.api.json`), "0");
const group = process.argv[2];
const names = new Set(r.content.api.filter((g) => !group || g.id === group).flatMap((g) => [...(g.namespace ? [g.namespace] : []), ...g.types, ...g.values]));
const missing = r.missing.filter((m) => names.has(m.split(".")[0]));
console.log(missing.length ? missing.join("\n") : "nothing missing");
