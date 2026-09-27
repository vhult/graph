import { cpSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

export interface StorybookPaths {
  static: string;
  devPort: number;
}

export function storybook(paths: StorybookPaths): Plugin {
  let outDir = "";
  return {
    name: "docs-storybook",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (url !== "/storybook" && !url.startsWith("/storybook/")) return next();
        const host = (req.headers.host ?? "localhost").replace(/:\d+$/, "");
        res.statusCode = 302;
        res.setHeader("Location", `http://${host}:${paths.devPort}/`);
        res.end();
      });
    },
    closeBundle() {
      const from = resolve(paths.static);
      if (!existsSync(join(from, "index.html"))) {
        throw new Error(`No Storybook build at ${from}. Run "npm run storybook:build" at the repo root.`);
      }
      const to = join(outDir, "storybook");
      rmSync(to, { recursive: true, force: true });
      cpSync(from, to, { recursive: true });
    },
  };
}
