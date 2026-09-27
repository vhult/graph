# @vhult/graph

Fast WebGPU graph rendering engine.

<img width="1526" height="1358" alt="image" src="https://github.com/user-attachments/assets/e02965dc-8bcd-43ff-864f-27fed270590f" />

```sh
npm install @vhult/graph
```

Requires a WebGPU-capable browser (Chrome/Edge 113+, Firefox 141+ on Windows,
Safari 26+). Zero runtime dependencies.

## Links

- npm: https://www.npmjs.com/package/@vhult/graph
- Docs: https://graph.vhult.com
- Storybook: https://graph.vhult.com/storybook/

You can also look at the next planned released state here: https://dev.graph.vhult.com/storybook/

## Quick start

```ts
import { Graph, packRgba } from "@vhult/graph";

const graph = await Graph.create(document.querySelector("canvas")!);

graph.nodes.set({
  count: 3,
  positions: new Float32Array([0, 0, 100, 0, 50, 80]),
  sizes: new Float32Array([10, 10, 10]),
  colors: new Uint32Array(3).fill(packRgba(1, 0.4, 0.2)),
});
graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) });
graph.camera.fit();

graph.on("click", (hit) => console.log(hit.node));
```

## License

MIT
