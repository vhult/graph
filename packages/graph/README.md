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

## Demo

Storybook is available here: https://graph.vhult.com

## Performance

The goal of this library is to make a new generation graph rendering using
WebGPU with the highest possible level of performance. It is currently able to
render a 25 million nodes and 66 million edges graph smoothly on a laptop iGPU.

<img width="677" height="814" alt="image" src="https://github.com/user-attachments/assets/aa8b26e4-05c4-4dee-b9d0-eba157ce742a" />

## Quick start

```ts
import { Graph, packRgba, UnsupportedError } from "@vhult/graph";

const canvas = document.querySelector("canvas")!; // give it a CSS size; it tracks resizes

let graph: Graph;
try {
  graph = await Graph.create(canvas);
} catch (e) {
  if (e instanceof UnsupportedError) console.warn("No WebGPU here:", e.code);
  throw e;
}

const n = 100_000;
const positions = new Float32Array(2 * n); // x, y interleaved, world units
for (let i = 0; i < 2 * n; i++) positions[i] = Math.random() * 1000;

graph.setNodes({
  count: n,
  positions,
  sizes: new Float32Array(n).fill(4), // diameters, world units
  colors: new Uint32Array(n).fill(packRgba(0.3, 0.6, 1)),
});
graph.setEdges({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) }); // source, target pairs
graph.camera.fit();
```

Pan and zoom are built in, with one-finger pan and two-finger pinch zoom on
touch screens (`controls: false` turns them off). Call `graph.destroy()` to
release the worker and the GPU device.

**Arrays are transferred, not copied**: after `setNodes` / `setEdges` the arrays
you passed are detached. Pass `{ copy: true }` as the second argument to keep
them.

## Serve with cross-origin isolation

For the fastest input path, serve your page with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Pointer input and stats then go through a `SharedArrayBuffer`. Without these
headers the engine still runs, but falls back to `postMessage`.
`graph.caps.sharedMemory` tells you which one you got.

## Bundlers

The render worker is loaded with
`new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`, so
`dist/worker.js` must stay next to `dist/index.js`. With Vite, keep the package
out of dependency pre-bundling so that URL survives:

```ts
// vite.config.ts
export default defineConfig({
  optimizeDeps: { exclude: ["@vhult/graph"] },
  worker: { format: "es" },
});
```

## API

Everything is typed; the `.d.ts` files document each option and method.

| | |
|---|---|
| `Graph.create(canvas, options?)` | Start the engine. Rejects with `UnsupportedError` when WebGPU or `OffscreenCanvas` is missing |
| `setNodes`, `setEdges` | Bulk-load typed arrays (set nodes first, then edges) |
| `updateNodePositions`, `updateNodeColor` | Partial updates |
| `setNodeLabels`, `setEdgeLabels` | Label text, placed without overlap |
| `camera.fit`, `camera.setView`, `camera.getView` | Camera control |
| `readStats(out?)` | Frame stats: visible counts, CPU/GPU ms, GPU memory held |
| `on("error", fn)` | Runtime errors, e.g. device loss |
| `destroy()` | Release everything |

## Three nodes, one edge

The smallest thing that draws something:

```ts
import { Graph, packRgba } from "@vhult/graph";

// The canvas needs a CSS size. The engine reads it and tracks resizes.
const graph = await Graph.create(document.querySelector("canvas")!);

graph.setNodes({
  count: 3,
  // x, y interleaved, in world units — any scale you like
  positions: new Float32Array([0, 0, 100, 0, 50, 80]),
  // diameters, same world units as the positions
  sizes: new Float32Array([10, 10, 10]),
  // packRgba takes 0..1 channels and returns the packed uint the engine wants
  colors: new Uint32Array(3).fill(packRgba(1, 0.4, 0.2)),
});

// Pairs of node indices: this joins node 0 to 1, and 1 to 2.
graph.setEdges({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) });

// Move the camera so the whole graph is on screen.
graph.camera.fit();
```

## License

MIT
