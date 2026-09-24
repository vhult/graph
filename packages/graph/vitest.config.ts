import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "node", environment: "node", exclude: [...configDefaults.exclude, "test/**/*.dom.test.ts"] },
      },
      {
        extends: true,
        test: { name: "dom", environment: "happy-dom", include: ["test/**/*.dom.test.ts"] },
      },
    ],
  },
});
