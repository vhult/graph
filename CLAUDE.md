# CLAUDE.md

`@vhult/graph` is a WebGPU graph rendering engine. It only renders: it does no analysis and no layout policy. It runs in a worker on an OffscreenCanvas. The goal is to be the fastest graph renderer on the market, so every decision is judged on speed first.

## Repo map

- `packages/graph` is the published library.
  - `src/api` is the public `Graph` class, types, errors, pointer input and the debug overlay.
  - `src/bridge` connects the main thread and the worker: protocol, shared state and the input ring.
  - `src/camera` holds the 2D camera, controls and camera paths.
  - `src/data` is the graph store, packing, dirty ranges and layouts.
  - `src/engine` runs the frame loop, dirty tracking, telemetry, probe and benchmark.
  - `src/gpu` has the device, buffers, bind layouts, frame graph, radix sort and profiler.
  - `src/passes` holds one file per GPU pass (upload, cull, sort, geometry, labels).
  - `src/labels` is the glyph atlas and label layout.
  - `src/shaders` holds the WGSL sources, grouped by pass, plus the preprocessor.
  - `test` is the Vitest suite. `docs/decisions.md` is the decision log. `scripts` is the build.
- `packages/bench` has the shared benchmark fixtures (seeded datasets, camera paths, stats). Saved runs go in `results`.
- `apps/storybook` has the welcome page and the stories (showcase, nodes, edges, stress, developer with the sandbox and the bench), and the HUD.
- `scripts` has the dev server and the GPU, input and image diff tooling.

## Commands

- `npm run dev` starts the dev setup.
- `npm test` runs the library tests.
- `npm run typecheck` typechecks all workspaces.
- `npm run build` builds the library.

A change is done when typecheck, tests and build all pass.

## How to work here

**Measure before and after.** Any change that can affect speed gets a baseline, then the change, then a new measurement. Use the same dataset, camera path and machine for both. Use the fixtures in `packages/bench` so runs can be compared. Report frame time and p95, nothing more. No number, no speed claim.

**Rewrite over patch.** If a fix needs a special case, or a second fix lands in the same area, stop. Rethink the design and rewrite that part. A string of bugs in one place means the design is wrong. It does not need another patch.

**Simple and fast.** When two designs are equally fast, take the smaller one. Keep work on the GPU and off the main thread. Do not allocate in the frame loop. An abstraction has to pay for itself in measured cost.

**Start from the state of the art.** Before building a known hard piece (culling, sorting, label placement, picking, layout), check current research and tools. Pick the best approach and say why.

**Record decisions.** A design decision that changes how the engine works gets an entry at the top of `packages/graph/docs/decisions.md`. Say what was decided and which measurement decided it, in a few lines.

**Zero runtime dependencies.** The library ships with no runtime dependency and must stay that way.

## Commits

Format: `type(scope): summary`

- `type` is one of `feat`, `fix`, `perf`, `refactor`, `test`, `docs` or `chore`.
- `scope` is optional. It is a `src` folder name (`gpu`, `passes`, `labels`, ...) or one of `bench`, `storybook` or `build`.
- `summary` is lowercase and imperative, with no final period, and 72 characters or fewer.
- A breaking change adds `!` after the type or scope (`feat(api)!: ...`) and a `BREAKING CHANGE: <what breaks>` line in the body.
- A `perf` commit ends its body with the measurement:

```
Perf (<dataset>):
  frame  4.1 ms -> 3.2 ms
  p95    6.0 ms -> 4.4 ms
```

One logical change per commit.

## Branches

- Work happens on feature branches. Every PR targets `dev`, never `main`. Use the `open-pr` skill.
- A branch name is plain kebab-case, with no `/` and no type prefix: `overlay-destroy-order`, not `fix/overlay-destroy-order`.
- `dev` merges into `main` only through a release. Each release is tagged. Use the `release` skill.
