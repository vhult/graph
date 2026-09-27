# @vhult/graph

Super fast WebGPU graph rendering engine.

<img width="448" height="397" alt="image" src="https://github.com/user-attachments/assets/67372405-85ef-4394-9f5d-4096b1bd4dfe" />

Rendering only: no layout, no simulation. You give it node positions and edges
as typed arrays; it draws them from a Web Worker on an `OffscreenCanvas`, so the
main thread never touches the GPU.

```sh
npm install @vhult/graph
```

Requires a WebGPU-capable browser (Chrome/Edge 113+, Firefox 141+ on Windows,
Safari 26+). Zero runtime dependencies.

## Links

- npm: https://www.npmjs.com/package/@vhult/graph
- Storybook, latest release: https://graph.vhult.com
- Storybook, dev branch: https://dev.graph.vhult.com

## Performance

The goal of this library is to make a new generation graph rendering using
WebGPU with the highest possible level of performance. It renders millions of
nodes and edges easily.

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
