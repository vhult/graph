import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { docsData } from "./plugins/data.ts";
import { storybook } from "./plugins/storybook.ts";

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    docsData({
      content: path("./content"),
      api: path("../../packages/graph/temp/graph.api.json"),
      pkg: path("../../packages/graph/package.json"),
    }),
    storybook({ static: path("../storybook/storybook-static"), devPort: 6006 }),
  ],
  server: { port: 5173, strictPort: true },
  optimizeDeps: { exclude: ["@vhult/graph"] },
  worker: { format: "es" },
  build: { target: "es2022" },
});
