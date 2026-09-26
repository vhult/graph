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

graph.nodes.set({
  count: n,
  positions,
  sizes: new Float32Array(n).fill(4), // diameters, world units
  colors: new Uint32Array(n).fill(packRgba(0.3, 0.6, 1)),
});
graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) }); // source, target pairs
graph.camera.fit();
```

Pan, zoom, node drag, selection, hover and picking are built in, with
one-finger pan and two-finger pinch zoom on touch screens. Each one is set with
`graph.input.set({ pan, zoom, drag, select })` to `"auto"` (the default),
`"manual"` (the engine only fires the events) or `false`. Rotate is built in but
off by default: `graph.input.set({ rotate: "auto" })` turns on the two-finger
twist. Call `graph.destroy()` to release the worker and the GPU device.

**Arrays are transferred, not copied**: after `nodes.set` / `edges.set` the
arrays you passed are detached. Pass `{ copy: true }` as the last argument to
keep them.

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
| `Graph.create(canvas, options?)` | Start the engine. Options: `pixelRatio`, `autoResize`, `style`, `input`. Rejects with `UnsupportedError` when WebGPU or `OffscreenCanvas` is missing |
| `nodes.set`, `edges.set` | Bulk-load typed arrays (set nodes first, then edges; `nodes.set` removes every edge) |
| `nodes.add`, `edges.add` | Add nodes or edges and get their indices back. Indices never move until you remove them |
| `nodes.remove`, `edges.remove` | Remove nodes or edges. Removing a node removes its edges, reported by the `edgesRemoved` event |
| `nodes.update(indices, data)`, `edges.update(indices, data)` | Change any channels for a list of indices, uploading only those |
| `nodes.updateAll(data)`, `edges.updateAll(data)` | Change any channels for every slot. Node channels: `positions`, `colors`, `sizes`, `shapes` (`NodeShape.circle`, `square` or `hexagon`), `zIndex` (0 bottom to 15 top), `icons`, `iconColors`, `labels`. Edge channels: `indices`, `styles` (`packEdgeStyle`), `colors`, `labels` |
| `nodes.flag`, `edges.flag` | Turn `Flag.hidden`, `Flag.selected`, `Flag.dimmed` or `Flag.focused` on or off for a list of indices or `"all"` |
| `nodes.clear`, `nodes.compact`, `nodes.count`, `nodes.slots` (and the same on `edges`) | Remove everything, pack live items into the first slots, count live items and slots |
| `nodes.stream({ positions, colors, zIndex })` | Write every position, colour and/or z-index each frame from your own loop, then `commit()`; they arrive in the same frame |
| `icons.define`, `icons.add`, `icons.replace`, `icons.remove` | The icon set: `{ path, viewBox?, fillRule? }` (SVG path data) or `{ svg }` (SVG markup). Nodes pick one with `icons` (its id, `NO_ICON` for none) and tint it with `iconColors`; `style.icon.scale` and `style.icon.minPx` set its size in the node and the size below which it is not drawn |
| `style.set(partial)` | The look at any time: `background`, `nodeScale`, `edge`, `label`, `icon`, `hover`, `selected`, `focused`, `dimmed`, `selection` |
| `input.set(partial)` | Interactions and picking: `pan`, `zoom`, `rotate`, `drag`, `select`, `selectShape`, `selectKey`, `pick`, `pickRadius`, `edgePickRadius` |
| `camera.get`, `camera.set`, `camera.fit`, `camera.rotate`, `camera.limits`, `camera.toWorld`, `camera.toScreen` | Camera control. Zoom is CSS px per world unit; `set`, `fit` and `rotate` animate when given a `duration` |
| `query.at(x, y)`, `query.inside(shape)` | What is at a canvas point, and the nodes inside a box or polygon |
| `canvas.resize`, `canvas.render`, `canvas.snapshot` | Manual resize (with `autoResize: false`), a forced frame, and an image of the current frame |
| `stats(out?)` | Frame stats: visible counts, CPU/GPU ms, GPU memory held. GPU ms are NaN while the debug overlay is closed |
| `debug.open`, `debug.close`, `debug.toggle`, `debug.isOpen` | Debug overlay drawn over the canvas. Measures nothing while closed |
| `debug.expand(bool)` | Switch the overlay between the small view and the full per-pass, per-stage view |
| `debug.record()`, `debug.stop()` | Record up to 10 s of per-frame data; resolves with the JSON recording |
| `debug.benchmark(options)` | Play a camera path and record per-frame CPU and GPU times |
| `on("hover", fn)`, `on("click", fn)`, `on("doubleClick", fn)`, `on("contextMenu", fn)` | What is under the pointer, as a `Hit`: `node`, `edge` (your indices, or `null`), world `x`, `y` and canvas `screenX`, `screenY` |
| `on("dragStart", fn)`, `on("drag", fn)`, `on("dragEnd", fn)` | A drag of one node or every selected node: `{ index, nodes, x, y }` at the start, then `{ index, dx, dy }` in world units |
| `on("select", fn)`, `on("pan", fn)`, `on("zoom", fn)`, `on("rotate", fn)`, `on("view", fn)` | Selection, gesture steps and camera moves |
| `on("edgesRemoved", fn)`, `on("error", fn)` | Edges removed with a node, and runtime errors, e.g. device loss |
| `destroy()` | Release everything |

## Three nodes, one edge

The smallest thing that draws something:

```ts
import { Graph, packRgba } from "@vhult/graph";

// The canvas needs a CSS size. The engine reads it and tracks resizes.
const graph = await Graph.create(document.querySelector("canvas")!);

graph.nodes.set({
  count: 3,
  // x, y interleaved, in world units — any scale you like
  positions: new Float32Array([0, 0, 100, 0, 50, 80]),
  // diameters, same world units as the positions
  sizes: new Float32Array([10, 10, 10]),
  // packRgba takes 0..1 channels and returns the packed uint the engine wants
  colors: new Uint32Array(3).fill(packRgba(1, 0.4, 0.2)),
});

// Pairs of node indices: this joins node 0 to 1, and 1 to 2.
graph.edges.set({ count: 2, indices: new Uint32Array([0, 1, 1, 2]) });

// Move the camera so the whole graph is on screen.
graph.camera.fit();
```

## License

MIT
