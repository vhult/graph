declare module "virtual:content" {
  const content: import("./content/types").Content;
  export default content;
}

declare module "virtual:api" {
  const api: import("./content/types").ApiModel;
  export default api;
}
