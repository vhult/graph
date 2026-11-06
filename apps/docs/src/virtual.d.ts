declare module "virtual:content" {
  const content: import("./content/types").Content;
  export default content;
}

declare module "virtual:api" {
  export const latest: import("./content/types").ApiVersion;
  export const archives: { id: string; version: string; load: () => Promise<{ default: import("./content/types").ApiVersion }> }[];
}
