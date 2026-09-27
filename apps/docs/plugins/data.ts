import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { readApi } from "./api.ts";
import { loadContent } from "./content.ts";
import { llmsFiles } from "./llms.ts";

const CONTENT = "virtual:content";
const API = "virtual:api";

export interface DataPaths {
  content: string;
  api: string;
  pkg: string;
}

export function docsData(paths: DataPaths): Plugin {
  const contentDir = resolve(paths.content);
  const apiFile = resolve(paths.api);

  const load = () => {
    const api = readApi(apiFile);
    const version = (JSON.parse(readFileSync(paths.pkg, "utf8")) as { version: string }).version;
    return { api, ...loadContent(contentDir, api, version) };
  };

  const llms = () => {
    const { content, api } = load();
    return llmsFiles(content, api);
  };

  return {
    name: "docs-data",
    resolveId(id) {
      if (id === CONTENT || id === API) return `\0${id}`;
    },
    load(id) {
      if (id === `\0${API}`) {
        this.addWatchFile(apiFile);
        return `export default ${JSON.stringify(readApi(apiFile))};`;
      }
      if (id === `\0${CONTENT}`) {
        const { content, warnings, files } = load();
        for (const file of [apiFile, ...files]) this.addWatchFile(file);
        for (const w of warnings) this.warn(w);
        return `export default ${JSON.stringify(content)};`;
      }
    },
    generateBundle() {
      const { index, full } = llms();
      this.emitFile({ type: "asset", fileName: "llms.txt", source: index });
      this.emitFile({ type: "asset", fileName: "llms-full.txt", source: full });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        if (url !== "/llms.txt" && url !== "/llms-full.txt") return next();
        const { index, full } = llms();
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(url === "/llms.txt" ? index : full);
      });
      server.watcher.add([contentDir, apiFile]);
      const reload = (file: string) => {
        const path = resolve(file);
        if (path !== apiFile && !path.startsWith(contentDir)) return;
        const graph = server.environments.client.moduleGraph;
        for (const id of [`\0${CONTENT}`, `\0${API}`]) {
          const mod = graph.getModuleById(id);
          if (mod) graph.invalidateModule(mod);
        }
        server.hot.send({ type: "full-reload" });
      };
      server.watcher.on("add", reload);
      server.watcher.on("change", reload);
      server.watcher.on("unlink", reload);
    },
  };
}
