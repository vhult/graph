/** Vite `?raw` imports (tests only). */
declare module "*?raw" {
  const source: string;
  export default source;
}

interface ImportMeta {
  glob(pattern: string, options: { eager: true; query: "?raw"; import: "default" }): Record<string, string>;
}
