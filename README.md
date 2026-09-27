# @vhult/graph

Fast WebGPU graph rendering engine.

<img width="1526" height="1358" alt="image" src="https://github.com/user-attachments/assets/e02965dc-8bcd-43ff-864f-27fed270590f" />

## Links

- npm: https://www.npmjs.com/package/@vhult/graph
- Docs: https://graph.vhult.com
- Storybook: https://graph.vhult.com/storybook/

You can also look at the next planned released state here: https://dev.graph.vhult.com/storybook/

## Performance
The goal of this library is to make a new generation graph rendering using WebGPU with the highest possible level of performance.
It renders millions of nodes and edges easily.

## Workspace

```
packages/graph/          @vhult/graph — the library (zero runtime dependencies)
  src/api/               main-thread facade: Graph, public types, errors, pointer capture, debug overlay
  src/bridge/            main ↔ worker: protocol, InputRing (SAB), shared state, position stream, worker entry
  src/engine/            worker-side orchestrator: frame loop, dirty flags, idle sleep, interaction (press, drag, selection, pick queue), telemetry, benchmark
  src/gpu/               device/limits, caps, bind layouts, graph buffers, frame graph, radix sort, profiler
  src/data/              Layouts.ts (single source of truth), SoA store, dirty ranges, packing
  src/camera/            f64 camera with hi/lo upload, pan/zoom controls
  src/passes/            one file per frame-graph pass (upload, sort, cull, geometry, labels, pick, hover)
  src/labels/            glyph atlas and label placement
  src/icons/             icon parser (SVG path data and markup to curves) and icon atlas
  src/shaders/           WGSL (common/, passes/) + preprocessor
  test/                  unit tests (vitest)
  docs/decisions.md      ADR log
packages/bench/          @vhult/graph-bench — seeded datasets, camera paths, stats (private)
apps/storybook/          @vhult/graph-storybook — consumes the built package (private)
apps/docs/               @vhult/graph-docs — the public docs site, content in content/*.yaml (private)
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Build the library, then watch it + run Storybook on http://localhost:6006 and the docs on http://localhost:5173 |
| `npm run storybook:build` | Build the library, the Storybook and the docs into `apps/docs/dist`, the Storybook under `storybook/` |
| `npm run build` | Build `packages/graph/dist` (ESM + worker + `.d.ts`), then refresh the API report (`api/graph.api.md`, `temp/graph.api.json`) |
| `npm test` | Unit tests |
| `npm run typecheck` | Typecheck every workspace |
| `npm run gen -w @vhult/graph` | Regenerate `layouts.wgsl` from `Layouts.ts` |

Requires a WebGPU-capable browser (Chrome/Edge 113+, Firefox 141+ on Windows,
Safari 26+).
