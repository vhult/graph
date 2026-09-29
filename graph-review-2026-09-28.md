# @vhult/graph review: bugs, wrong paths and speed

Date: 2026-09-28. Branch `curve-edges-spike`, working tree as on disk (the uncommitted curved-edge work is included).

## 0. Status (updated 2026-09-29)

The curved-edge items were done on `curve-edges-spike`, one commit each, measured before and after on the AMD Radeon 890M (headless Edge, 2410×1028, DPR 1). Every other item is still open; they are kept for a performance branch.

| Item | Done | Result | Commit |
|---|---|---|---|
| Bench (section 13, item 4) | Mixed cases, 1 edge in 64 curved: `large-curve-mixed`, `large-zoom-curve-mixed`, `xlarge-zoom-curve-mixed`, `deep-zoom-curve-mixed`; then `xlarge-zoom-curve` (10M, all curved). | 1 in 64 curved cost +4.1 ms at 10M (11.10 → 15.17 ms) | `ba8e65a`, `af58f72` |
| LBL-19 | Curved edge labels are culled with the curve's reach: `EDGE_CURVE_MAX` × the group's longest edge × zoom, under a new `FRAME_FLAG_CURVES` | Label passes unchanged within noise (0.56 → 0.56–0.60 ms) | `e7b8413` |
| EDGE-5 | Each curved edge adds its bend parallelogram to the chunk box; the flat margin in the cull and the pick select is gone | `deep-zoom-curve-mixed` 7.11 / 15.95 → 6.81 / 15.62 ms (mean / p95), 21% fewer edges drawn, pixel-identical | `2f68116` |
| EDGE-7 | Arc length of the curve's first half computed once per edge; solid, untapered curves skip the arc math | Within noise (6.42 → 6.33 ms on `large-curve-dashed`), pixel-identical | `e0cad5b` |
| EDGE-1 | Straight and curved edges draw from their own part of the draw list, split in `edge.expand` with a per-chunk curved bitmask (decision 0078), not with a sort-key bit | `xlarge-zoom-curve-mixed` 15.34 / 18.99 → 11.69 / 14.95 ms; `edge.cull` at 10M 0.063 → 0.098 ms; byte-identical on 20 views | `9b95348` |
| EDGE-6 | 4 pieces for every curve, no per-chunk choice (decision 0079) | `xlarge-zoom-curve` 31.5 / 58.8 → 15.2 / 21.2 ms; at most 2/255 difference on nearly all pixels of 38 views | `e725c60` |

Corrections to the review found while doing them:
- LBL-19: the edge label tree box holds the edges' midpoints, not their endpoints, so the margin has to come from the group's longest edge. The label is not a problem: it sits at the peak, where the curve is parallel to the chord.
- EDGE-1: the sort-key design would give curved edges their own chunks and thinning density (a change of look) and a re-sort on every curve toggle. The split in `edge.expand` keeps the picture and the sort as they were. It does not fix INT-2.
- EDGE-6: the estimate (1.2–2.6 ms at 10M) was far too low. At 8 pieces each curved edge redid the full curve setup in all of its 18 vertices, and the curve draw was bound by vertex work.

Still open for curves: INT-2 (pick returns the hidden straight edge) and INT-9 (pick line band). A check of `dev` against the branch on `small` and `xlarge-zoom` (no curves) showed no change: 0.66 / 0.63 → 0.65 / 0.64 ms and 11.19 / 11.41 → 11.33 / 11.03 ms.

## 1. Summary

Seven reviewers read the library by area: engine, nodes, edges, labels and icons, interaction, data, plus the Storybook demo. Three checkers then tried to disprove every high and medium finding against the code, and the lead checked about 20 of the biggest claims by hand.

- **113 findings**: 39 bugs, 62 speed or wrong-path items, 12 quality items. About 8 of them are the same issue seen from two areas; they are merged below.
- **78 were checked by a checker**: 69 confirmed, 9 plausible, 0 disproved. The other 35 are low-severity items that only the first reviewer checked.
- The core design holds up. Picking against the culled chunk list, the hi/lo camera origin, the per-chunk random LOD prefix, the SAB input ring, idle sleep and zero messages per frame are all state of the art, and the reviewers found no reason to replace them.
- The biggest losses are around the core, not in it:
  1. **Selection switches off LOD and culling** where it lands. A large lasso at 10M costs +6 to +30 ms GPU on every later frame (INT-1 / NODE-2).
  2. **Small edits rebuild everything.** One `edges.add` at 10M re-uploads and re-sorts all 15M edges (~0.15–0.25 s) and blanks every label for about a second. One node add past the reserve re-sorts the whole graph (~350 ms) (DATA-1, DATA-2, LBL-2).
  3. **Frames that change almost nothing redraw everything**: label fades, label solves and hover. This costs about 20–64 ms of GPU per camera stop at 10M without edges, 48–158 ms with edges, and 2.7–6.8 ms per hover change (ENG-2, LBL-3, LBL-17, EDGE-12, INT-3).
  4. **Per-frame GPU at 10M zoom** can drop by about 15–50% with edges: the cull scatter barriers (NODE-1), the AA pad on nodes and edges (NODE-3, EDGE-2), the curve double draw (EDGE-1) and the edge overdraw budget (EDGE-3).
  5. **Labels have real bugs**: text updates never reach labels on screen (LBL-1), no `timestamp-query` means 250–320 ms label lag (LBL-4), the glyph atlas fills up for good (LBL-11), and resizing leaks label buffers (ENG-1).
  6. **Storybook** freezes its whole UI for up to 6.4 s on large stories, because datasets are built on the main thread (SB-1). Toggling edges on Scale costs 1.2 s of main thread in label rebuilds (SB-2).

**How far to trust the numbers.** Every GPU time is built from the code and the data, then scaled from saved measurements:

- The saved bench runs (`packages/bench/results`) date from 2026-09-19/20, older than the first commit (2026-09-22). They use the `clustered` dataset with no edges and no labels, on Intel Xe-LPG (2418×1112) and Intel Arc headless.
- Edge and label anchors come from decision-log entries (0044, 0045, 0053, 0054, 0073, 0077) and commit messages. Some of those name no GPU.
- CPU times were measured by the reviewers in Node 24 on this machine (Ryzen AI 9 365), by bundling repo sources into the scratchpad. Expect Chrome on the Xe-LPG laptop to be 1 to 1.5x slower.

Treat every GPU number as an estimate with a range. Section 11 lists the bench runs that would turn each estimate into a measurement.

## 2. How the gains were estimated

For each speed item the reviewers:

1. named the workload (dataset from `packages/bench`, camera path, visible share, viewport);
2. counted the work before and after (dispatches, barriers, bytes, instances, fragments, copies, allocations);
3. turned the count into time with a per-unit cost taken from a saved run or a decision entry.

Where that was not possible, the item says "not estimable" and names the run that would settle it.

Gains overlap. Section 3 gives totals per scenario with the overlaps removed. The per-finding gains in sections 5 to 10 are each measured against today's code alone, so do not add them up.

Dataset sizes used throughout (from `packages/bench/src`):
- `communities` has E ≈ 1.51 × N: 1,511,683 edges at 1M nodes and 15,119,988 at 10M.
- The Storybook suite loads node and edge labels on `communities`, which is 25M–28M label strings at 10M.

## 3. Gains by scenario

### 3.1 Camera moving, 10M nodes (zoomSweep), GPU per frame

Node-only anchor today: 10.1 ms mean / 16.5 ms p95 on Xe-LPG, 8.3 / 12.9 ms on Arc (saved runs, no edges). With edges, commit f10b056 reports 11.31 ms for the 10M zoomSweep frame (GPU not named).

| Item | Gain | Confidence |
|---|---|---|
| NODE-1 cull scatter: one scan per workgroup, or a popcount bitmask | 1.0–2.5 ms | medium-low |
| NODE-3 node AA pad 1 → 0.5 px | 0.3–0.6 ms (low end likelier) | low |
| NODE-4 scan phases (blocked `scan_down`, dead buckets) | 0.15–0.3 ms | medium |
| EDGE-2 edge AA pad 1 → 0.5 px | 0.2–0.7 ms | medium |
| EDGE-3 overdraw budget per screen area, not per length level | 0.5–2.2 ms (changes the look) | low |
| EDGE-9, EDGE-10 dead short edges, double chunk walk | 0.06–0.23 ms | low |
| EDGE-1 curved edges run both pipelines (only when ≥ 1 edge is curved) | +0.6–4.6 ms (upper half likelier) | medium on counts, low on ms |
| LBL-10 label solve on every pan frame (pan frames only) | 0.1–0.45 ms | low |
| NODE-5 z-layer order sized by N (only with z-index) | 0.5–0.9 ms | medium-low |

- **Nodes alone:** −1.45 to −3.4 ms, so 10.1 → ~6.7–8.7 ms on Xe-LPG (−14% to −34%).
- **Straight edges:** −1.75 to −5.9 ms against the ~11.3 ms frame, about −15% to −50%. EDGE-2 and EDGE-3 overlap, so this does not sum them in full.
- **A few curved edges:** add EDGE-1 on top.

### 3.2 Camera moving, 1M nodes (zoomSweep), GPU per frame

The node-only anchor is 4.4 ms mean on Xe-LPG and 2.6 ms on Arc. The edge pass at 1M (`large`) is 2.19 ms straight, from 0077.

| Item | Gain |
|---|---|
| NODE-1 | ≤ 0.25 ms (a), 0.2–0.4 ms (b) |
| NODE-3 | 0.1–0.3 ms |
| EDGE-2 | 0.1–0.35 ms |
| EDGE-3 | 0.1–0.5 ms |
| EDGE-1 (with curves) | +0.2–1.5 ms |

- **Straight edges:** about −0.5 to −1.5 ms.
- **At 10k:** nothing here is above ~0.05 ms. Fixed costs dominate, and the engine is already fast at that size.

### 3.3 After each camera stop (idle GPU and energy, not frame time)

The frames that follow a camera stop are label fades, label-solve steps and the re-culls from label results. Today each one redraws the whole scene.

Fix: one cached scene target, plus a compute-only dirty flag, plus the LBL-3 cull fix. Overlaps are removed below (ENG-2 part 1, LBL-17 and EDGE-12 are mostly the same frames).

| Case | 1M | 10M |
|---|---|---|
| Cached scene + compute-only flag, no edges | ~6–19 ms per stop | ~20–64 ms per stop |
| Same, with edges | ~22–72 ms per stop | ~48–158 ms per stop |
| LBL-3 (one cull per label result instead of two) | ~3–6 ms per stop | ~11–19 ms per stop |

None of this changes frame time or p95 while the camera moves.

### 3.4 Hover (INT-3, same cached scene target)

| | 1M | 10M |
|---|---|---|
| Per hover change, no edges / with edges | 0.79 / 3.09 ms | 2.74 / 6.83 ms |
| Continuous hover (~47 changes/s) | 37–145 ms/s | 129–321 ms/s |

At 10k the blit costs more than the redraw, so enable the cache only above ~1 ms of render.

### 3.5 Selection at 10M

| Item | Today | After |
|---|---|---|
| INT-1 / NODE-2, lasso of 2.55M nodes, every later frame | fit ~28–38 ms, deep zoom ~9–15 ms | fit ~7.3 ms, deep zoom ~3.6 ms |
| INT-1 / NODE-2, 1,000 scattered selected nodes | +2.6–3.8 ms per frame | ~0 |
| INT-1 / NODE-2, 10,000 scattered selected nodes | +15–21 ms per frame | ~0 |
| NODE-7, selection click or box frame | +2–4 ms (full chunk bounds) | ~0.02 ms |
| INT-4, lasso gesture frame | 0.5–1.5 ms (6–12 ms worst case) | 0.03–0.4 ms |
| INT-4, `query.inside` | 3–5 ms | ~0.2 ms |
| INT-12, `query.inside` small box | ~1.7 ms (reads all slots) | ~0.1 ms |
| INT-10, `query.inside` latency under 16k results | 2 readback round trips | 1 (−2.5–3.5 ms) |
| DATA-8, `flag("all")` | 52–100 ms worker CPU | 9–17 ms |

### 3.6 Load, 10M nodes and 15.1M edges with labels

| Thread | Item | Gain |
|---|---|---|
| Main | Drop the `Array.from` label copy (DATA-3 = ENG-3 = LBL-13) | −0.3 s per 10M-label array, ~−0.6 s for node plus edge labels |
| Main + worker | Packed labels (UTF-16 or Latin-1 + offsets, transferred) | also removes the clone (~0.57 s per 10M) and the worker deserialize (0.6–1 s per array); packing costs ~0.13 s |
| Worker | DATA-4 loop instead of `reduce`, DATA-5 no reserve copy, DATA-6 no identity fill | ~−105 to −125 ms |
| GPU | NODE-8 node sort, NODE-9 permute, EDGE-8 narrower edge key | ~−25 to −45 ms (low confidence) |
| GPU memory | DATA-13 (split the sorts, drop `engineIdx` and the identity 8N) | −0.4 to −0.5 GB peak (1.4 → ~0.9 GB) |
| Latency | LBL-4 seed the label step cost | first labels ~0.25 s sooner |
| Latency | ENG-1 skip the first same-size RESIZE frame | −4.3 to −7.3 ms GPU |
| Latency | ENG-9 compile pipelines in one wave, labels lazy | not estimable |

### 3.7 Edits at 10M

| Edit | Today | After |
|---|---|---|
| `edges.add` (one call), DATA-1 + LBL-2 | ~90 ms GPU + 31–110 ms CPU + 121–302 MB upload; every label width re-measured (250–380 ms over 63–95 frames with labels missing) + 0.2–0.3 s text copy | ~1–3 ms, both fixes needed |
| Node add past the reserve, DATA-2 + LBL-2 | ~350 ms, labels blank | ~10–15 ms |
| `nodes.update({sizes})`, EDGE-4 | +14.9 ms GPU per frame (full edge bounds); 1M: +1.5–2.6 ms | 0 |
| `updateAll({sizes})` CPU, DATA-4 | 99–109 ms | ~41–51 ms |
| k `nodes.remove` calls in one frame, DATA-12 | k × 35 ms | ~35 ms |

### 3.8 Storybook

| Item | Today | After |
|---|---|---|
| SB-1 dataset build on main thread | UI frozen 0.2–6.4 s | under 10 ms (plus the `copy:true` slice) |
| SB-2 Edges toggle on Scale 10M | 1.2 s main + ~0.6 s worker | ~0 |
| SB-10 Sandbox labelled upload 10M | +1.86 s rebuild | ~0 |
| SB-5 edge styles on LargeGraph 10M | +0.43 s per cached re-upload, +0.2 s first load | ~0 |
| SB-16 bench icon colours 10M | 0.28–0.37 s | 16–17 ms |
| SB-8 Sandbox pick radius slider tick | full engine rebuild | < 0.1 ms |
| SB-6 edge alpha tick in "nodes" mode | full `edges.set` + re-sort, −25 ms main | colour update only |
| SB-3 GPU experiments per frame | 0.4–1.8 ms main | quick fix −0.33–0.49 ms; library hook removes it all |
| SB-4 Ripples hover drop at 1M | 0.96 ms per change | < 0.01 ms |

## 4. Priorities

### 4.1 Ranked by expected impact

| # | Items | What | Gain | Status |
|---|---|---|---|---|
| 1 | INT-1 = NODE-2 | Selection and focus switch off LOD and culling for whole chunks | +2.6 to +30 ms per frame at 10M removed | confirmed |
| 2 | DATA-1, DATA-2, LBL-2, LBL-18 | Small edits rebuild all edges, all nodes, all label widths | 0.15–0.35 s → ms per edit at 10M | confirmed |
| 3 | ENG-2, LBL-3, LBL-17, EDGE-12, INT-3 | Near-idle frames redraw and re-cull everything | 20–158 ms GPU per stop, 2.7–6.8 ms per hover at 10M | confirmed |
| 4 | NODE-1 (+ NODE-4, NODE-12) | Cull scatter bound by barriers | 1.0–2.5 ms per frame at 10M zoom | plausible |
| 5 | EDGE-1 | One curved edge makes every edge run both pipelines | 0.6–4.6 ms per frame at 10M | done (`9b95348`), −3.7 ms measured |
| 6 | LBL-1, LBL-4, LBL-11, LBL-5, LBL-6 | Label correctness: stale text, lag without timestamps, atlas full, churn, wrong candidates | correctness and 250–320 ms latency | confirmed |
| 7 | ENG-1 | Label buffers leak on every resize | 3–30 MB per resize event | confirmed |
| 8 | DATA-3 = ENG-3 = LBL-13 | Label text copied and cloned on the main thread | −0.3 s per 10M array | confirmed |
| 9 | EDGE-4, NODE-7 | Dirty flags too wide: size → edge bounds, state → all chunk bounds | 14.9 ms and 2–4 ms per such frame at 10M | confirmed |
| 10 | NODE-3, EDGE-2 | AA pad twice what the coverage ramp needs | 0.5–1.3 ms per frame at 10M zoom | confirmed |
| 11 | INT-2, INT-5, INT-7 | Pick returns the wrong edge (curves, pad), or picks invisible dimmed nodes | correctness | confirmed |
| 12 | DATA-7, DATA-9, DATA-10, NODE-11, NODE-13 | Data correctness: stale bounds, unchecked endpoints, palette overflow, LOD resample, stale labelled bits | correctness | confirmed / plausible |

Storybook, in order: SB-1, SB-2 with SB-10, SB-7, SB-8, SB-9, SB-3.

### 4.2 Small changes, confirmed, clear gain

| Item | Change |
|---|---|
| ENG-1 | `destroyView()` in `setViewport` and `active()`; return early on an unchanged size |
| LBL-4 | Seed `costMean` with ~0.02 ms, not 0.5 |
| LBL-3 | Drop `LABELLED` from `onShown`, `settle` and `TEXT_DIRTY`; skip `marksDirty` on an unchanged result |
| NODE-3, EDGE-2 | AA pad 0.5 px for node quads, edge quads and curve strips. Keep 1 px for the arrow box, and split the constant, because the arrow trim uses it too |
| EDGE-4 | New `Dirty.SIZES`, kept out of the edge `BOUNDS_DIRTY` |
| DATA-4 | Plain loop instead of `reduce(Math.max)`, skipping NaN |
| DATA-3 | Post the caller's label array as is and map nullish in the worker |
| INT-2 | Put a "curved" bit into the edge pick key |
| INT-7 | Apply `dimmedAlpha` in both pick shaders |
| LBL-20 | Update the stale flags before the `placeable` early return |
| SB-8 | `graph.input.set(...)` for input args; keep only init-only fields in `optionsKey` |
| SB-13 | `dispose` calls `wheel.detach()` |
| SB-16 | Precompute the 16 colour words |

## 5. Library: engine, bridge, camera (ENG)

The worker ticks once per rAF, and only while a dirty flag is set. At idle it sleeps behind the ring's SLEEPING flag.

A camera frame records 7–12 compute passes, 1 render pass, 1 submit and 1 `mapAsync`. `Engine.tick`, FrameGraph, FrameUniform, Camera, Controls and InputRing allocate nothing per frame. With SAB the main thread sends zero messages per frame.

**ENG-1 · bug · high · Resize and label switches leak the label view buffers**
- Where: `passes/LabelPass.ts:296-300` (`setViewport`), `315-320` (`active`), `719-720`, `750-753`; `engine/Engine.ts:372-388` (`resize`).
- Now:
  - `setViewport` sets `this.view = null` without destroying anything, so the later `destroyView()` finds nothing and the old candidate, grid, decision, list and neighbour buffers are dropped without `destroy()`. The labels on/off switch in `active()` does the same.
  - `Engine.resize` has no same-size guard. The ResizeObserver's first callback always costs one full RESIZE frame and one leak.
  - Label-less graphs also allocate the view.
- Fix: `destroyView()` in both places, reserve the view behind `placeable()`, and return early when w, h and the pixel ratio are unchanged.
- Gain:
  - Memory: 3–30 MB per resize event (≈ 244 B × capacity; 9.9 MB on the bench viewport at DPR 1), about 150–600 MB per second of drag-resize until GC. `stats().gpuBytes` grows forever.
  - One startup frame: 4.3–7.3 ms GPU at 10M.
- Status: confirmed (lead, checker).

**ENG-2 · perf · medium · Label-solve-only frames redraw everything; the cull runs twice per label update**
- Where: `engine/Engine.ts:1258` (busy keeps `Dirty.LABELS`), `1220` (texture always taken), `1216-1240`, `306-311`; `passes/TransformCullPass.ts:56`; `passes/LabelPass.ts:380-386`; `gpu/FrameGraph.ts:146-177`.
- Now:
  - While a solve spans frames, every frame gets and redraws the swap chain texture, although no pixel changes until the result lands.
  - The transform cull (stage 4) runs before `label.mark` (stage 12) in the same frame, so the next frame culls again with the new bits.
- Fix: a compute-only dirty flag that skips `getCurrentTexture()` and the render pass. Stage `label.mark` before the cull, or let `marked` alone drive `LABELLED` (see LBL-3).
- Gain: after removing the frames already counted in LBL-17, the render part is 0–3 frames per stop, so 0–9 ms at 10M and 0–3 ms at 1M. The cull part is LBL-3. Idle GPU only.
- Status: confirmed (checker).

**ENG-3** is the same code as DATA-3 (label copy with `Array.from`, 26 ms per 1M labels against 2.3 ms for a loop). See DATA-3.

**ENG-4 · bug · medium · The wheel glide jumps 86.5% in the first frame after idle**
- Where: `engine/Engine.ts:1131-1133`; `camera/Controls.ts:31` (`MAX_STEP_S = 0.1`), `199-215`.
- Now: dt after sleep is clamped to 0.1 s, so alpha = 1 − e⁻² = 0.865 for an isolated notch. At one frame of dt it would be 0.283. Decision 0026's "90% in ~7 frames" holds only mid-scroll.
- Fix: on the first tick after a sleep, use a nominal dt (1/60 s or a recent average).
- Gain: n/a (zoom smoothness). Status: confirmed (lead, checker).

**ENG-5 · bug · medium · Camera animation pans linearly while zooming in log space**
- Where: `camera/CameraAnimation.ts:26-43`.
- Now: on `camera.fit({nodes:[i]})` 1000 units from the centre at 1M (zoom ×1000), the target leaves the screen at u ≈ 0.27 and comes back at u ≈ 0.996. It is visible only in the last ~18 ms.
- Fix: van Wijk & Nuij 2003, the path used by `d3.interpolateZoom` (ρ = √2), or interpolate about the similarity's fixed point.
- Gain: n/a. Status: confirmed (checker).

**ENG-6 · bug · medium · A worker crash leaves replies pending forever; device loss is not recovered**
- Where: `api/Graph.ts:242`, `638-645`, `774`, `815-817`; `engine/Engine.ts:323-329`.
- Now:
  - On `worker.onerror`, pending `query.at`, `snapshot`, `benchmark` and `icons.define` promises never settle. Only `destroy` rejects them.
  - Device loss is reported but not recovered. That is the documented contract (apps show a fallback), so it is a feature gap, not a bug.
- Fix: reject every pending reply on `onerror` and on a fatal error after `ready`. Optionally rebuild the device from the CPU store, which already holds everything `flush()` needs.
- Gain: n/a. Status: plausible (checker: the hung replies are real; recovery is a feature gap).

**ENG-7 · bug · medium · Without SharedArrayBuffer, `camera.get` / `toWorld` / `toScreen` are up to 200 ms stale**
- Where: `bridge/worker.ts:28`, `76`, `87-94` (5 Hz state post); `api/Graph.ts:128-138`, `707-718`; `api/types.ts:693` (documented "at most one frame old").
- Now: on pages that are not cross-origin isolated, camera reads lag by up to 12 frames, and the timer wakes the worker 5 times a second forever.
- Fix: a per-frame `view` message already exists (`worker.ts:62`, `Graph.ts:873`) but is not written into `state`. Post it on every rendered camera frame and drop the interval. With SAB, write `FRAME_INDEX` last and have readers retry when it changes.
- Gain: latency goes from up to 200 ms to 1 frame. Status: confirmed (checker).

**Lower-severity ENG items**

| ID | Kind | What | Fix | Gain | Status |
|---|---|---|---|---|---|
| ENG-8 | bug | `pixelRatio` frozen at create (`Graph.ts:83`, `237`, `888-896`); DPR changes ignored | follow `devicePixelRatio` in `onResize` when not user-set | up to 4x fewer fragments after a 2x → 1x move | confirmed |
| ENG-9 | perf | pipelines compile in ~4 serial waves; each module waits on `getCompilationInfo()`; 21 label pipelines built eagerly (`Engine.ts:332-369`, `ShaderModules.ts:6-15`) | one `Promise.all`; compile info only on failure; lazy LabelPass | time to first frame, not estimable | reviewer only |
| ENG-10 | quality | profiler at exactly 32/32 slots (`Profiler.ts:13`, `105-106`): the next compute phase makes `Graph.create` throw everywhere | size the slot area and masks from the slot list | n/a | reviewer only |
| ENG-11 | bug | `stats().gpuMs` and most `passMs` are NaN while the overlay is closed (`Engine.ts:1168`, `Profiler.ts:124-133`) | always time the frame span (2 queries), or fix the doc | n/a | confirmed |
| ENG-12 | quality | pointer rect cache stale when the canvas moves without resizing (`PointerInput.ts:46-99`); documented design | refresh once per frame on the first pointer event | n/a | plausible |
| ENG-13 | perf | DebugOverlay poll interleaves layout reads and writes and sorts ~65 × 600 values every 250 ms (`DebugOverlay.ts:324-350`) | read first, write on change; selection instead of sort | ~7 ms/s main thread while the overlay is expanded | reviewer only |
| ENG-14 | perf | `flag(target)` clones the whole backing buffer of a subarray (`Graph.ts:414`) | `slice()` + transfer | proportional to the backing buffer | reviewer only |
| ENG-15 | bug | f32 `frame.time` makes label fades step after a week of uptime (`FrameUniform.ts:302`, `label_draw.wgsl:65`) | rebase the time epoch when no fade is running | n/a | confirmed ((a) only: the checker found the ring counter does not wrap) |
| ENG-16 | bug | very long edges wobble near `MAX_ZOOM` (endpoints projected to f32 px; `camera.wgsl:6-11`, `edge_geometry.wgsl:62-63`, `81-82`) | clip in camera-relative world space before scaling | n/a (no bench path reaches it) | plausible |
| ENG-17 | quality | per-frame allocations left in Profiler and LabelPass (closures, arrays, template-string bind-group keys, `new Float32Array` per frame) | reuse; precompute keys | < 10 µs per frame; rule compliance | reviewer only |

## 6. Library: node pipeline (NODE)

Node channels are SoA buffers in Morton order, and nodes are shuffled inside each 1024-node chunk so that any prefix is a random LOD sample.

A camera frame runs `cull_count` (one workgroup per chunk), `scan_reduce`, `scan_blocks`, `scan_down` and an indirect `cull_scatter`. The draw is an instanced 4-vertex strip with `drawIndirect` per bucket and an analytic SDF.

The fixed ~0.13–0.3 ms `scan.blocks` cost in the saved runs was already fixed in 3ca17b8 (0.50 → 0.03 ms at 1M).

**NODE-1 · perf · high · `cull_scatter` is bound by barriers and latency**
- Where: `shaders/passes/transform_cull.wgsl:346-428`; `shaders/common/scan.wgsl:49-64`.
- Now:
  - Each chunk runs 4 Hillis–Steele scans, about 80 barriers per workgroup. All 4 rows are scanned even when the LOD prefix fits in the first (~21 drawn nodes per chunk at 10M fit). Load latency is paid 4 times.
  - At 10M zoomSweep, scatter minus count leaves 1.6–2.9 ms that the extra bytes do not explain.
  - Part of that leftover is the dependent `drawTable` → `offsets` loads and short segment writes, which neither fix removes.
- Fix: (a) blocked layout, each lane owning 4 items and running one scan (~20 barriers), looping only over the rows that can hold drawn nodes. (b) `cull_count` writes a per-node drawn bitmask (1.25 MB at 10M) and `cull_scatter` ranks with `countOneBits`. That needs no scan, no barrier and no second classify, and it removes the "classify must match in both kernels" invariant. 0016 (no gain from subgroup scans) was measured before LOD, when the cull was bandwidth-bound.
- Gain:
  - 10M zoomSweep: (a) 1.0–2.0 ms, (b) up to ~1.5–2.5 ms.
  - 1M: ≤ 0.25 ms (a), 0.2–0.4 ms (b).
  - 10k: ≤ 0.04 ms.
  - Confidence medium-low. Re-measure scatter against count on xlarge-zoom.
- Status: plausible (checker; the mechanism is confirmed, the size is uncertain).

**NODE-2 · perf · high · A foreground node turns LOD off for its chunk, and foreground is never culled.** This is the same issue as INT-1; the full entry is in section 9.
- Node-side gains: 1,000 scattered selected nodes at 10M fit cost −2.3–3.2 ms render and −0.3–0.6 ms cull; 10,000 cost −15–21 ms.
- 1M selected in a 10M graph flags every chunk, so LOD is off everywhere (~10M instances, tens of ms).
- The comment's reason ("halos may reach on screen") no longer holds: outlines are separate quads since 0058.
- Status: confirmed (lead, checker).

**NODE-3 · perf · medium · The node quad is 0.5 px larger than any non-zero coverage**
- Where: `shaders/common/nodes.wgsl:7` (`NODE_AA_PAD_PX = 1.0`); `shaders/passes/node_geometry.wgsl:42`, `62`; cull margin `transform_cull.wgsl:62`, `168`.
- Now: alpha is `clamp(0.5 − (d − r))`, which is 0 beyond r + 0.5, yet the quad reaches r + 1. Output would be identical with a 0.5 px pad.
- Fix: a 0.5 px pad in the node draw and cull. Hover (`hover.wgsl:72`) has the same slack.
- Gain: 2×2 fragment quads drop by 44% at r = 0.5 and 31% at r = 1.5. That is 0.3–0.6 ms at 10M zoomSweep (the per-instance anchor suggests primitive-bound, so expect the low end) and 0.1–0.3 ms at 1M.
- Status: confirmed (lead, checker).

**NODE-4 · perf · medium · Scan phases do more than needed**
- Where: `transform_cull.wgsl:226-344`; `cull_state.wgsl:17`.
- Now:
  - `scan_down` runs 4 scans per block (72 barriers, 0.16–0.30 ms at 10M).
  - `scan_reduce` runs a full scan to get a sum.
  - The TINY and CLUSTER buckets are never produced but are still written and scanned.
- Fix: a blocked `scan_down`, a tree reduction, and dropping the dead buckets until M4. Optionally a single-pass chained scan with Decoupled Fallback (SPAA'25), which is portable without forward-progress guarantees and answers 0014.
- Gain: −0.15 to −0.3 ms at 10M. Status: confirmed (checker).

**NODE-5 · perf · medium · The z-layer order pass is sized by node count, not visible count (z-index only)**
- Where: `passes/NodeOrderPass.ts:75-100`; `shaders/passes/node_order.wgsl:40-130`.
- Now: 16 × ceil(N/1024) histogram cells. The scan runs in one workgroup every camera frame, and most workgroups exit empty. The 200 MB `layered` buffer is reallocated on every count change.
- Fix: indirect dispatch sized from the visible count.
- Gain: 0.5–0.9 ms per frame at 10M, 0.05–0.1 ms at 1M. Status: confirmed (checker).

**NODE-7 · perf · medium · A state change (selection) rebuilds the bounds of every chunk**
- Where: `passes/TransformCullPass.ts:43`, `281-290`; `engine/Interaction.ts:712`, `725`.
- Now: a click or box selection reads 16 B per node in `chunk_bounds` (160 MB at 10M). The touched-chunk path already exists for drags (0045).
- Fix: the state scatter appends `rank >> 10` to the moved-chunk list, with a full rebuild past N chunks.
- Gain: 2–4 ms → ~0.02 ms per selection frame at 10M, 0.2–0.4 ms at 1M. Status: confirmed (checker).

**NODE-8 · perf · medium · The node sort (load and growth)**
- Where: `passes/SortPass.ts:177-221`; `shaders/passes/sort.wgsl:37-127`; `gpu/RadixSort.ts`.
- Now:
  - 6 passes of 4 bits (18 dispatches) with a single-workgroup histogram scan and the same 4-scan scatter as NODE-1.
  - The last pass writes `keysOut` for nothing.
  - SortPass builds its own radix pipelines instead of reusing `RadixSort`.
- Fix: skip the last keys write, fuse the Morton keys into pass 0, use a multi-workgroup scan and 8-bit digits, and reuse RadixSort. The state of the art is Onesweep; Decoupled Fallback is the portable way to run it on WebGPU.
- Gain: the radix part goes from ~31 → 12–18 ms at 10M (0014 anchor, from before git; 0073 reports 74 ms for the whole node sort on the 890M). Low confidence.
- Status: confirmed (checker).

**NODE-9 · perf · medium-low · Permute gathers each channel separately (load)**
- Where: `gpu/GraphBuffers.ts:207-225`; `gpu/PermuteKernels.ts:122-139`; `shaders/passes/gather.wgsl:29-49`.
- Now: 5 gathers plus compose, each a random 4–8 B read per 64 B line.
- Fix: pack the channels into one 32 B AoS temp, do one gather, then unpack to SoA (~9 bindings, under the limit of 10). This costs +320 MB of transient memory at 10M.
- Gain: roughly halves the permute. The "33 ms" baseline is modelled, not measured, and leaves out compose's random `rank` write. Low confidence.
- Status: plausible (checker).

**NODE-10** is the same as DATA-6 (identity order/rank filled by JS loops). Note from the checker: `mergeLayers` (`GraphBuffers.ts:198`) reads `order` at upload, before the sort, so the fix must handle that path.

**NODE-11 · bug · low-medium · The LOD shuffle hashes the pre-sort index, not the user index**
- Where: `shaders/passes/shuffle_chunks.wgsl:15-23`, `60-68`; `shaders/passes/sort.wgsl:46`; `passes/SortPass.ts:169`.
- Now: `morton_keys` sets `valsOut[i] = i`, and the shuffle hashes that. It equals the user index only on the first sort, so every same-count `setNodes({positions})` re-samples every chunk and the zoomed-out view pops.
- Fix: hash `order[perm[i]]`. Status: confirmed (checker).

**NODE-13 · bug · medium (raised by the checker) · The labelled bits can be stale or garbage in the cull**
- Where: `shaders/common/cull_state.wgsl:86-92`; `passes/LabelPass.ts:328-333`, `684`; `passes/TransformCullPass.ts:197`.
- Now:
  - The labelled-bits window moves with the chunk count. The scratch buffer is kept while the count fits its 1.25× headroom, and `marksDirty` is set only when the buffer object changes.
  - After a chunk-count change within capacity, the cull reads old draw-table or chunk-bounds words as labelled bits, so those nodes skip LOD and draw at full alpha until the next re-mark.
- Fix: clear or re-mark the bits on any chunk-count change and after a sort.
- Gain: n/a. Status: plausible (checker; how fast the re-solve re-marks was not traced).

**Lower-severity NODE items**

| ID | Kind | What | Fix | Gain | Status |
|---|---|---|---|---|---|
| NODE-6 | bug | LOD scale assumes 1024 real nodes in the last, partial chunk (`transform_cull.wgsl:90-108`, `135-137`; `pick_nodes.wgsl:10`), so radii are ×1.14–2.67 too big in one corner | compute the scale with `live = min(1024, nodeCount − c·1024)`, mirrored in pick | n/a | confirmed |
| NODE-12 | perf | `wgTotal` takes up to 1024 same-address SLM atomics per chunk only to learn "non-empty" (`transform_cull.wgsl:207-212`) | count only 0 → 1 cell transitions; NODE-1(b) removes it | ≤ 0.1–0.2 ms at 10M | reviewer only |

Checked and found correct:
- u32 ranges at the 2^28 node cap;
- f32 precision at bench scales (~0.007 px at 70× fit on 10M);
- barriers and uniform control flow;
- out-of-bounds reads;
- indirect args;
- shuffle determinism (the hash is a bijection, and the padding key's preimage is above 2^28);
- no cull seams at chunk borders;
- icon tail addressing.

## 7. Library: edge pipeline (EDGE)

- **Sort:** EDGE_SORT orders edges by (length octave, Morton of the midpoint) and shuffles each 1024-edge chunk.
- **Bounds:** `edge.bounds` builds a 48 B record per chunk, only on data changes, restyles and drags.
- **Every camera frame:** `edge.cull` (one workgroup) writes the args and the chunk list, then `edge.expand` writes the draw list.
- **Draw:** one instanced strip draw with vertex pulling: 4 vertices straight, 10 with arrows, 18–24 per curve.

Culling is conservative and correct, including edges whose two endpoints are off screen. There is no readback and no per-frame allocation.

The saved bench runs have no edge phase. Anchors come from 0045, 0053, 0054, 0077 and f10b056. Counts come from a JS port of the cull run on `communities` over the bench camera paths (`scratchpad/sim.mjs`).

**EDGE-1 · perf · high · Any curved edge makes every drawn edge run both pipelines**
- Where: `passes/EdgeGeometryPass.ts:97-106`; `shaders/passes/edge_cull.wgsl:326-330`; `shaders/passes/edge_geometry.wgsl:46-50`, `158-168`.
- Now:
  - The curve draw gets `instanceCount = sd.total`, the same list as the straight draw.
  - Each straight edge runs 18 extra vertex invocations (24 with arrows) that emit zero-area triangles; each curved edge runs 4 (10) extra in the straight pass.
  - 0077 documents this but never measured it, and the suite has no mixed case.
- Fix (a rewrite of the split, not a patch):
  - a "curved" bit on top of the edge sort key so curved edges get their own chunks;
  - a per-chunk curved count in the bounds;
  - two ranges in the draw list with two args;
  - `vs_curve` reads from a curve base offset.
  - Add a mixed bench case (for example 1 edge in 64 curved).
- Gain: 18 × drawn instances wasted, i.e. 8.3M invocations per frame at 10M zoomSweep. That is 0.6–4.6 ms at 10M zoomSweep (the upper half is likelier, since primitive setup for 16 degenerate triangles is not counted) and 0.13–1.0 ms at 1M standard (6–45% of the 2.19 ms edge pass).
- Status: confirmed (lead, checker).
- **Done** (`9b95348`, decision 0078): split in `edge.expand` instead of a sort-key bit. `xlarge-zoom-curve-mixed` 15.34 → 11.69 ms, p95 18.99 → 14.95 ms. See section 0.

**EDGE-2 · perf · medium-high · The edge AA pad is twice what the coverage ramp needs**
- Where: `shaders/common/edges.wgsl:7` (`EDGE_AA_PAD_PX = 1.0`), `85-99`; `shaders/common/edge_curve.wgsl:111`; `shaders/passes/edge_geometry.wgsl:147-153`.
- Now: coverage is `clamp(0.5 − d)` in solid, pattern, taper, double, dotted, round-cap and curve paths. The quad reaches hw + 1.0 where hw + 0.5 is enough, so 29% of rasterized edge fragments never have coverage.
- Fix: a 0.5 px pad for line quads and curve strips; keep 1.0 for the arrow box, whose ramp reaches ~1.12 px past the tip. Split the constant: the arrow trim (`edge_segment.wgsl:33`, `87`; `edge_curve.wgsl:95`) uses it too, and lowering it globally would change pixels under arrowheads.
- Gain: fragments −29% at DPR 1.5 (−35% at DPR 1). That is 0.2–0.7 ms at 10M zoomSweep, 0.13–0.45 ms at 10M standard and 0.1–0.35 ms at 1M zoomSweep. It overlaps EDGE-3; do not sum the two.
- Status: confirmed (checker).

**EDGE-3 · perf · medium · The thinning budget is per length level, so total overdraw is 4–9x at 10M**
- Where: `shaders/common/edges.wgsl:121-142` (`edgeKeep`); `shaders/passes/edge_cull.wgsl:245-256`.
- Now: `EDGE_MAX_OVERDRAW = 1.5` applies per chunk, and up to 16 octave levels stack on the same pixels. Total ink is 4.1x / 6.2x / 9.3x the viewport (fit / standard / zoomSweep) at 10M, and it grows with graph size. This is the open item from 0037/0038.
- Fix: budget ink per screen tile across all levels, in `edge_cull` workgroup memory. Caution: the keep count would then change while panning, which breaks the "only grows on zoom-in" rule. Validate with the image diff tooling.
- Gain: 0.5–2.2 ms at 10M zoom-out, 0.1–0.5 ms at 1M. This is a policy and look tradeoff. Low confidence.
- Status: confirmed (mechanism).

**EDGE-4 · wrong-path · medium · A node size update rebuilds every edge chunk bound**
- Where: `engine/Engine.ts:101-104` (`["sizes", Dirty.POSITIONS]`); `passes/EdgeCullPass.ts:25`, `208`, `223`.
- Now: `BOUNDS_DIRTY` includes POSITIONS, but no edge record depends on node size.
- Fix: a `Dirty.SIZES` flag for the passes that need radii (node cull, labels, pick).
- Gain: 14.9 ms GPU per size-update frame at 10M (0045), 1.5–2.6 ms at 1M (0073).
- Related: streamed positions pay the same full `edge.bounds` every frame, which caps a live layout at 10M.
- Status: confirmed (lead, checker).

**EDGE-5 · perf · low-medium · The curve margin inflates every chunk by 0.25 × its longest edge**
- Where: `shaders/passes/edge_cull.wgsl:276`; `pick_edges.wgsl:76`, `114` (same margin; see INT-9).
- Fix: add `a + n·c` and `b + n·c` to the box of curved edges in `edgeBoundsOf` (the parallelogram contains the arc), or store the chunk's max bend.
- Gain: 0.08–0.2 ms at 10M deep zoom (134k → 108k instances), 0.02–0.06 ms at 1M. Status: confirmed (checker).
- **Done** (`2f68116`): the parallelogram fix. `deep-zoom-curve-mixed` 7.11 → 6.81 ms, p95 15.95 → 15.62 ms, 21% fewer edges drawn.

**EDGE-6 · perf · low-medium · Curve tessellation is fixed at 8 pieces**
- Where: `shaders/common/layouts.wgsl:145`; `shaders/common/edge_curve.wgsl:129-147`.
- Now: 40–64% of drawn edges are under 20 px at 10M.
- Fix: after EDGE-1, draw chunks under ~64 px with a 4-piece strip.
- Gain: all-curved 10M fit 1.2–2.6 ms, 1M zoomSweep 0.35–0.8 ms; take the lower half, because a 4-piece strip has a larger hull. Status: confirmed (checker).
- **Done** (`e725c60`, decision 0079): 4 pieces for every curve, no per-chunk choice. `xlarge-zoom-curve` 31.5 → 15.2 ms, p95 58.8 → 21.2 ms.

**Lower-severity EDGE items**

| ID | Kind | What | Fix | Gain | Status |
|---|---|---|---|---|---|
| EDGE-7 | perf | curved fragments recompute a per-edge constant arc length and do arc math for solid curves (`edge_curve.wgsl:159-166`, `219-226`) | pass `arc(L)` as a varying; skip the block for solid untapered curves | < 0.1 ms at 1M (not estimable) | done (`e0cad5b`), within noise |
| EDGE-8 | perf | edge sort key ~4 bits wider than chunks need (`EdgeSortPass.ts:108-109`) | Morton bits sized for ~64 edges per cell (26 → 22 bits at 15M) | −6–8 ms per re-sort at 15M, −0.7–0.9 ms at 1.5M | reviewer only |
| EDGE-9 | perf | 13–14% of drawn instances are below the minimum length and die in the vertex shader (`edge_cull.wgsl:266`) | half-octave levels, or store the chunk's shortest edge | 0.05–0.18 ms at 10M zoomSweep | reviewer only |
| EDGE-10 | perf | `edge_cull` walks every chunk twice in one workgroup (`edge_cull.wgsl:291-317`) | keep the per-chunk count from loop 1 | 0.01–0.05 ms | reviewer only |
| EDGE-11 | quality | self-loops and zero-length edges are never drawn, even with `edgeMinLengthPx: 0` (8,400 in bench `hierarchy`); edge ends are not trimmed at nodes (`edge_geometry.wgsl:64-67`, `182-185`) | document it; optionally teardrop self-loops | n/a | confirmed |
| EDGE-12 | perf | label-fade and hover-only frames redraw every edge | cached scene target (see 3.3) | ~1.6 ms per such frame at 1M, ~22 ms per stop | reviewer only; counted in 3.3 |

Checked and found correct:
- arrows exact for circles, squares and hexagons; the curved tip is within 0.85% of the node radius;
- curve math avoids cancellation;
- dashes use exact arc length and stay continuous across the clipped strip;
- no out-of-bounds reads and no stale indirect args.

## 8. Library: labels and icons (LBL)

**Layout.** Text layout runs on the CPU in the worker, per code point with cached advances. Glyphs are rasterised one at a time into a fixed 2048² `rg8unorm` atlas, with no SDF (the right choice at constant screen size).

**Placement** is an exact GPU greedy on a screen grid:
- the candidates come from a size-ranked tree over Morton chunks;
- 8 rounds of parallel MIS;
- a 32 KB readback.

A solve is 14 steps (16 with edge labels), spread over frames by a 0.45 ms budget. That beats deck.gl's one-pass filter and matches MapLibre's grid greedy.

**Icons** are sound: the SDF is built once per define, and there is no per-frame work.

**LBL-1 · bug · high · A label on screen keeps its old text after `nodes.update` / `edges.update`**
- Where: `labels/Labels.ts:145-173` (`textAt`), `282-292`; `labels/LiveLabels.ts:38-60`.
- Now: `LiveLabels.update` only builds runs for indices it does not know yet. A shown label keeps its old glyphs and width while placement uses the new width, so the old text can overlap its neighbours. A slot reused within 0.2 s shows the removed node's text.
- Fix: keep a per-set text version, and rebuild a changed live entry in place (same slot).
- Gain: n/a. Status: confirmed (lead, checker). No test covers it.

**LBL-2 · bug · high · Every `edges.add`, node growth or compact re-measures every label width and drops every live label**
- Where: `engine/Engine.ts:417-423`, `529`, `572-576`; `labels/Labels.ts:185-197`, `252-258` (`restart`), `145-155`.
- Now:
  - `setEdgeCount` and `setNodeCount` zero every width, so labels vanish and come back in user-index order over many frames.
  - `textAt` copies the whole text array in one task.
  - Widths are user-indexed, so none of this is needed.
- Fix: grow the widths buffer by copy and measure only the new indices. Keep `texts` growable. Key live labels by user index, or fade them instead of clearing.
- Gain: today 25 ms at 1M, 250 ms at 10M and 380 ms at 15.1M edges (7–95 ticks with labels missing), plus 0.2–0.3 s for the copy. After the fix, O(added). Count the copy once with DATA-1.
- Status: confirmed (lead, checker).

**LBL-3 · perf · medium · Each solve result triggers two full node culls**
- Where: `engine/Engine.ts:111`, `306-311`; `labels/Labels.ts:217-221`, `313`; `passes/LabelPass.ts:333`, `380-386`; `passes/TransformCullPass.ts:56`.
- Now:
  - `onShown` marks `LABELLED`, so the cull runs with the old bits, and then again the next frame with the new ones.
  - `upload()` sets `marksDirty` even for an identical result.
  - The hover pick is requested twice as well.
- Fix: let `marked` alone drive `LABELLED`, and skip the upload for an unchanged result.
- Gain: 3.84 ms per cull at 10M, 1.11 ms at 1M (Xe-LPG). That is ~11–19 ms per camera stop at 10M, ~3–6 ms at 1M, and 0.12–0.24 s over the width phase at load. Idle GPU only.
- Status: confirmed (checker).

**LBL-4 · bug · high · Without `timestamp-query`, every solve runs one step per frame**
- Where: `passes/LabelPass.ts:13-14`, `220`, `461-463`, `497-512`.
- Now: step costs start at 0.5 ms, and the budget is 0.45 ms. Without finite timestamps the estimate never learns, so each solve takes 14–16 frames plus the readback (~250–320 ms of label lag). The first solve is slow everywhere.
- Fix: seed each step's cost at ~0.02 ms. Without timestamps, run the whole solve in one frame.
- Gain: 15–19 → 2–4 frames per solve, and first labels ~0.25 s sooner. Status: confirmed (lead, checker).

**LBL-5 · wrong-path · medium · Labels already shown are not candidates unless the tree sample picks them again**
- Where: `shaders/passes/label_place.wgsl:106-162`, `205-223`.
- Now: the 1.5× bonus applies only to emitted candidates, and a zoom level switch changes which top-k is emitted. Shown labels drop out with no conflict, which is churn.
- Fix: a small `label_emit_live` dispatch over the live list (≤ 8192) that always emits every shown label.
- Gain: stability, for ~5–12 µs per solve. Status: confirmed (checker). Measure the churn cut with `LabelFlicker`.

**LBL-6 · bug · medium · The candidate top-k is chosen by size alone**
- Where: `shaders/passes/label_tree.wgsl:33-40`, `73-83`; `label_place.wgsl:206-213`; `passes/LabelPass.ts:322-338`.
- Now:
  - Nodes without text and hidden nodes use up candidate slots, so labelled smaller nodes never show when zoomed out.
  - The order is not rebuilt after `nodes.update({sizes})`.
- Fix: key no-text and hidden nodes as the smallest. Mark the order stale on size updates, on `textAt`, and on hidden-count changes.
- Gain: n/a. Status: confirmed (checker).

**LBL-7 · perf · medium · The edge label tree is rebuilt on every solve during a drag or stream**
- Where: `passes/LabelPass.ts:24` (`EDGE_TREE_DIRTY` includes `POSITIONS | MOVED`), `506`; `shaders/passes/label_tree.wgsl:201-253`.
- Now: the merge re-reads positions on every comparison, over unsorted leaf lists, and the planner cannot split this step.
- Fix: rebuild once at drag end, throttle rebuilds under streaming, and merge on cached length keys.
- Gain: ~7 ms per solve frame on xlarge (0054; the GPU is not stated). Status: confirmed (checker).

**LBL-8 · bug · medium · Labels still undecided after 8 rounds are dropped, and ties follow the Morton index**
- Where: `data/Layouts.ts:337`; `shaders/passes/label_place.wgsl:83-85`, `424-491`, `504-519`.
- Now: equal sizes (the default) build long dependency chains. The undecided set depends on scheduling, so labels can flicker between solves of the same view.
- Fix: break ties with a hash of the index (O(log n) dependence length) and truncate `shown` by rank.
- Gain: correctness. The one-workgroup round loop is unproven for speed. Status: confirmed (checker).

**LBL-9 · bug · medium · A split solve mixes camera transforms**
- Where: `passes/LabelPass.ts:122-128`, `497-512`; `shaders/passes/label_place.wgsl:194`, `214`, `234-235`.
- Now: edge and node candidates can be computed in different frames, so their boxes come from different cameras during motion.
- Fix: store the view at `startSolve` and use it in every label kernel (one 32 B write).
- Gain: n/a. Status: confirmed (checker).

**LBL-10 · perf · medium · A full solve runs on every camera frame, including pure pans**
- Where: `passes/LabelPass.ts:23`, `335`, `339`.
- Now: ~30–50 dispatches, a 32 KB readback and a CPU apply on every moving frame.
- Fix: re-solve on zoom or rotation, after a pan of ~10% of the viewport, or every 100 ms, plus once at rest. MapLibre throttles to 300 ms.
- Gain: up to 0.1–0.45 ms per pan frame (dispatch overhead only; low confidence). Status: confirmed (checker).

**LBL-11 · bug · medium · When the glyph atlas is full, new characters stay blank for the rest of the session**
- Where: `labels/GlyphAtlas.ts:68-91`.
- Now: capacity is ~2.4k CJK glyphs at DPR 2 and ~1.2k at DPR 3. Chinese or Japanese names pass that quickly, and nothing reports it.
- Fix: flush and refill from the live labels, or grow a 2D-array texture like `IconAtlas.grow`.
- Gain: n/a. Status: confirmed (checker).

**LBL-12 · perf · medium · Glyphs are rasterised one at a time, synchronously, inside `applyShown`**
- Where: `labels/GlyphAtlas.ts:101-126`; `labels/Labels.ts:282-292`, `309-312`.
- Now: each new glyph costs 5 canvas calls, 3 allocations and one `writeTexture`, and the whole 64 KB glyph table is re-uploaded.
- Fix: rasterise into a strip canvas (halo in G, then fill in R with "lighter"), do one `copyExternalImageToTexture` per batch, cap raster time per frame, and write only the dirty range of the table.
- Gain: not estimable. The bench labels are digits only, so this path is never measured. Status: confirmed (checker).

**LBL-13** is the same code as DATA-3.

**Lower-severity LBL items**

| ID | Kind | What | Fix | Gain | Status |
|---|---|---|---|---|---|
| LBL-14 | quality | per-code-point layout: no shaping, kerning or bidi; combining marks clipped; lone high surrogate skips the next character (`layoutLabel.ts:25-40`) | `normalize("NFC")`; `k++` only above 0xffff; document the limits | n/a | reviewer only |
| LBL-15 | perf | 32 instance slots per label drawn twice (78% degenerate); glyph quads padded to the full cell (`LabelDrawPass.ts:86-89`) | compact per-glyph instance list; ink-tight quads | vertices 112k → 25k, fragments −71% (ms not estimable) | reviewer only |
| LBL-16 | perf | one `writeBuffer` per new label; ~20 allocations per active frame (`Labels.ts:282-308`, `LabelPass.ts:308-466`) | CPU mirror + one ranged write; reuse arrays | not estimable | reviewer only |
| LBL-17 | perf | every label fade frame redraws the whole scene | cached scene target | counted in 3.3 | reviewer only |
| LBL-18 | perf | an edge count change reallocates the node label tree (42 MB at 10M) and re-sorts it (`LabelPass.ts:322-326`, `690-717`) | reserve node and edge trees separately; u16 local indices | one realloc + sort per `edges.add`; −20 MB at 10M | reviewer only |
| LBL-19 | bug | curved edge labels: the traversal box ignores the bend (a long curve can be culled with its peak on screen); the label is straight | widen the margin by `EDGE_CURVE_MAX · len · zoom` | n/a | done (`e7b8413`); the straight label is not a bug |
| LBL-20 | bug | stale flags skipped while no text is set (`LabelPass.ts:334-336`) | update the flags before the early return | n/a | confirmed |
| LBL-21 | quality | stroke-only icon sets (Lucide, Feather, Tabler) are rejected; `orient` is quadratic in contours (`IconGeometry.ts:214-620`) | expand strokes or say so in the error; bbox test first | a few ms per complex icon | reviewer only |

## 9. Library: interaction (INT)

Picking is already state of the art. It is a compute pass over the cull's visible chunk list that matches the draw exactly: 10–60 µs per pick at 10M (0043), a 20 B readback, coalesced to at most one in flight and 60 per second. An ID buffer (measured worse in 0043) or a GPU grid (an O(N) rebuild per streamed frame) would not pay. The costs sit around the pick.

**INT-1 · perf · high · A large selection switches off LOD and culling where it lands (= NODE-2)**
- Where: `data/Layouts.ts:157` (`STATE_FOREGROUND_MASK` includes `STATE_SELECTED`); `shaders/passes/transform_cull.wgsl:53-56`, `93`, `154-156`; `shaders/passes/chunk_bounds.wgsl:95-97`; `passes/HoverPass.ts:225`, `253-279`; `shaders/passes/hover.wgsl:141-154`.
- Now: every selected (or focused, hovered, dragged) node:
  - is drawn every frame, on screen or not;
  - makes its chunk draw all 1024 nodes unsampled and skip the bounds test;
  - gets an outline quad with no viewport test and no LOD.
  0044 rejected exactly this for hover ("shows as a patch at fit"). A single click-select at fit should show that patch too.
- Fix:
  - Cull selected and focused nodes by viewport with an outline margin, and keep "never culled" only for hovered and dragged nodes.
  - Use a per-node "always drawn" bit (like `isLabelled`), not a chunk flag. Above ~64k selected nodes, let them follow LOD (a policy call).
  - Draw outlines only for nodes the cull drew.
- Gain: at 10M with a 2.55M lasso, fit goes 28–38 → ~7.3 ms and deep zoom 9–15 → ~3.6 ms, on every frame after the selection. At 1M with 250k selected it is 0.6–3.5 ms. For scattered selections see NODE-2.
- Status: confirmed (lead, checker).

**INT-2 · bug · medium · Where a straight and a curved edge overlap, the pick returns the hidden straight one**
- Where: `shaders/passes/pick_edges.wgsl:118-125`, `133`; `passes/EdgeGeometryPass.ts:102-105`.
- Now: the pick keeps the highest engine index, but curved edges are drawn in a second draw after all straight ones.
- Fix: key `(curved ? 1 << 30 : 0) | (e + 1)` when curves are on. No run-time cost.
- Status: confirmed (lead, checker).

**INT-3 · perf · medium · A hover change redraws the whole scene.** This is decision 0044, never measured against an alternative.
- Fix: the cached scene target from 3.3. Gains are in 3.4.
- Correction: 0044 names no GPU, so by the log's rule its numbers are Xe-LPG, not Radeon.
- Tradeoff: the hover highlight would draw above labels.
- Status: confirmed (checker).

**INT-4 · perf · medium · The lasso fill and `query.inside` test every polygon edge for every pixel and every node**
- Where: `shaders/passes/selection_shape.wgsl:17-47`; `shaders/passes/query_inside.wgsl:20-48`; `engine/Interaction.ts:20`, `627-645`.
- Fix: bin the polygon edges into 64 horizontal bands on the CPU on each move (the Slug-style banding that 0050 uses for icons). The result is bit-identical, so the fill and the query still agree.
- Gain: fill 0.5–1.5 ms → 0.03–0.4 ms per gesture frame (6–12 ms worst case); query at 10M 3–5 ms → ~0.2 ms. Status: confirmed (checker).

**INT-5 · quality · medium · Inside the pick radius, the top-most padded edge beats the edge under the pointer**
- Where: `pick_edges.wgsl:59`, `122-123`; `api/input.ts:27`.
- Fix: add a tier bit so exact hits (`dist ≤ 0.5`) win over padded ones. Consider a larger press radius for touch.
- Status: confirmed (checker).

**INT-6 · bug · medium · If the pick pass fails to load, presses hold the pan and `query.at` never settles**
- Where: `engine/Interaction.ts:268-285`, `405-429`, `447-451`; `engine/Engine.ts:666-675`.
- Now: the job stays queued. `Lazy` retries on the next `syncPick`, and the failure is rare. The same stall happens while pipelines compile.
- Fix: a failed state in which jobs settle as misses and presses do not hold the pan.
- Status: confirmed (checker).

**Lower-severity INT items**

| ID | Kind | What | Fix | Gain | Status |
|---|---|---|---|---|---|
| INT-7 | bug | pick ignores dimming: an invisible dimmed node wins and blocks the edge pick (`pick_nodes.wgsl:46-47`, `pick_edges.wgsl:55`) | apply `frame.dimmedAlpha` under `FRAME_FLAG_DIMMED` | n/a | confirmed |
| INT-8 | bug | the hovered edge keeps a stale style after a restyle (`HoverPass.ts:212-222`) | compare the style too, or read it on the GPU | n/a | confirmed |
| INT-9 | perf | the curve margin widens the pick's line reject for every edge (`pick_edges.wgsl:76`, `114`) | per-chunk max bend, one-sided band (with EDGE-5) | 0.03–0.17 ms per pick at 10M | reviewer only |
| INT-10 | perf | `query.inside` does 2 readback round trips, a `createBuffer` per query and an extra copy (`QueryPass.ts:145-177`, `Interaction.ts:709`) | persistent 64 KB staging buffer | −2.5–3.5 ms latency under 16k results | reviewer only |
| INT-11 | bug | results in flight are not tied to a data version, so a lasso resolving just after a compaction can select the wrong nodes (`Interaction.ts:310-326`, `692-702`) | stamp jobs with a store version | correctness; 3–8 ms CPU at 2.55M hits | plausible |
| INT-12 | perf | `query.inside` reads every slot (120 MB at 10M) even for a small box (`query_inside.wgsl:40-48`) | one workgroup per chunk with an early bounds exit | ~1.6 ms per query at 10M | reviewer only |
| INT-13 | quality | a lasso past 1024 points becomes a straight chord (`Interaction.ts:639-642`) | drop every other point and double the step | n/a | reviewer only |
| INT-14 | quality | the pick's engine index is written and read back but never used (`pick_nodes.wgsl:145`, `PickPass.ts:57`, `91-95`) | remove it | negligible | reviewer only |

## 10. Library: data path (DATA)

**How it works.** The main thread transfers typed arrays; labels go as a structured-cloned `string[]` and streams use a SAB triple buffer. The worker's `GraphStore` keeps one typed array per channel in user order. `flush` uploads through `mappedAtCreation`, and SORT / EDGE_SORT permute into Morton order on the GPU. Partial writes go through dirty ranges or index lists and a `scatter_update`.

**Checked and correct.** No per-node objects. Packing matches the WGSL side (generated and pinned by a test). Layouts.ts is sound.

**Load at 10M / 15.1M edges:**

| Step | Cost |
|---|---|
| Worker `setNodes` | 154 ms |
| Identity fill | 43 ms |
| Mapped memcpy | ~60 ms |
| GPU sorts | 74 + 90 ms |
| GPU memory | 1.4 GB peak, 0.5 GB steady |

**DATA-1 · perf · high · Each `edges.add` or endpoint update copies, uploads and re-sorts all edges**
- Where: `data/GraphStore.ts:514-559`, `859-861`, `900-905`; `gpu/GraphBuffers.ts:137-160`; `passes/EdgeSortPass.ts:102-135`; `engine/Engine.ts:526-535`.
- Now:
  - The mirrors are resized to the exact size on every add, and `reloadEdges()` marks every edge channel for re-creation.
  - The next frame re-uploads 121–302 MB and re-sorts all 15.1M edges (~90 ms GPU).
  - Plus 31–110 ms worker CPU per call at xlarge; 10 single-edge adds took 510 ms.
  - 0054 accepted the re-sort but measured no alternative.
- Fix:
  - (a) Give the mirrors spare capacity.
  - (b) Writes into existing slots scatter the new endpoints through `edgeRank` and refit only the touched chunks.
  - (c) An add past the end appends unsorted tail chunks, with a lazy re-sort when the tail passes a few % of E.
- Gain: ~0.15–0.25 s → ~1–3 ms per call at 10M, and −9 ms GPU and −4–5 ms CPU at 1M. The ms target also needs LBL-2 fixed when edge labels are on. The tail-chunk design needs the edge cull owner to confirm that thinning tolerates unsorted chunks.
- Status: confirmed (lead, checker).

**DATA-2 · perf · high · Node growth throws away a valid engine order**
- Where: `data/GraphStore.ts:213-222`; `gpu/GraphBuffers.ts:122-134`; `engine/Engine.ts:413-427`.
- Now: an add past the reserve re-uploads every node channel in user order and runs a full node sort plus a full edge sort (~350 ms at 10M, 62 ms at 1M). Positions did not change, so the old order is still valid.
- Fix: `copyBufferToBuffer` the engine-order channels and order/rank into bigger buffers, write the tail directly, and leave the edges untouched.
- Gain: ~350 → 10–15 ms at 10M, 62 → 2–5 ms at 1M. Status: confirmed (lead, checker).

**DATA-3 (= ENG-3 = LBL-13) · perf · medium, high at 10M · Labels are copied with `Array.from` on the main thread, then cloned**
- Where: `api/Graph.ts:1018-1021`; callers `294`, `311`, `391`, `445`, `459`, `482`, `1026`.
- Now: `Array.from(labels, s => s ?? "")` costs 26 ms per 1M, against 2.3 ms for a plain loop, then `postMessage` serializes again. At 10M that is ~0.43 s of main-thread block per node-label array, and about 75% of it is the redundant copy.
- Fix: check the length, post the caller's array as is, and map nullish in the worker. The larger step is packed text (UTF-16 or Latin-1 plus offsets, transferred), which also removes the clone and the worker's 25M+ JS strings (~0.8 GB of heap at 10M).
- Gain:
  - Main thread: −25 ms per 1M labels, ~−0.3 s per 10M array.
  - Packed text: at 10M the main thread goes ~0.77 s → ~0.13 s, and the 0.6–1 s worker deserialize disappears.
  - On the Scale edge toggle this is part of SB-2: count it once.
- Status: confirmed (lead, checkers).

**DATA-4 · perf + bug · medium · `sizes.reduce(Math.max)` is 6.8x slower than a loop, and one NaN poisons `maxNodeSize`**
- Where: `data/GraphStore.ts:176`, `430`, `420-424`, `456-460`.
- Now: 68 ms at 10M against 10 ms for a loop (44% of `setNodes`). One NaN size makes `camera.fit()` produce a NaN camera.
- Fix: a plain loop that skips non-finite values, and fold the `.some` checks into the packing loops.
- Gain: −58 ms per load or `updateAll({sizes})` at 10M, −4 ms at 1M. Status: confirmed.

**DATA-5 · perf · medium · The node reserve defeats the zero-copy mirrors**
- Where: `data/GraphStore.ts:4-5`, `157-206`, `885-898`.
- Now: with the default 100-node reserve, the length never matches, so every channel is copied (sizes twice). That is +26 ms and +160 MB transient at 10M. The header comment still says "zero copy".
- Fix: keep the mirrors at `count` length, write the reserve defaults straight into the mapped GPU range, and grow with spare capacity only when an add lands in the reserve.
- Gain: −26 ms at 10M and −5 ms at 1M. With DATA-4, `setNodes` goes 154 → ~70 ms at 10M. Status: confirmed.

**DATA-6 (= NODE-10) · perf · medium · The identity order/rank are built on the CPU, uploaded, then replaced in the same frame**
- Where: `gpu/GraphBuffers.ts:122-131`, `207-225`, `417-424`.
- Now: two N-word JS loops and 80 MB of upload at 10M, only for `compose()` to retire them.
- Fix: when the order is identity, take `order = perm` and `rank = invert(perm)` (the kernel exists), and handle `mergeLayers`, which reads `order` before the sort.
- Gain: −17 to −43 ms worker CPU and −80 MB upload at 10M, on every load and compact. On growth it is inside DATA-2. Status: confirmed.

**DATA-7 · bug · medium · `store.bounds` goes stale after position updates; one Infinity collapses the Morton sort**
- Where: `data/GraphStore.ts:761-767`, `383-385`, `815-841`; consumers `engine/Engine.ts:829-836`, `passes/SortPass.ts:187-190`, `passes/EdgeSortPass.ts:112-118`.
- Now:
  - `updateAll({positions})`, `nodes.update`, drags and streams never update the bounds.
  - `camera.fit()` then fits the old layout, and the next sort clamps moved nodes into border cells.
  - An infinite position zeroes every key, so the Morton order degrades to user order (which 0018 showed hurts culling).
- Fix: grow the bounds on scattered writes, recompute them on whole-range writes while skipping non-finite values, or reduce them on the GPU from the chunk bounds.
- Gain: n/a. Status: confirmed (lead, checker).

**DATA-8 · perf · medium · `flag("all")` costs 52–100 ms of CPU at 10M**
- Where: `data/GraphStore.ts:355-365`, `396-412`, `589-604`; `data/LookList.ts:19-44`.
- Fix: one fused loop, rebuild only the look lists whose bits changed, or apply the mask on the GPU.
- Gain: −43 to −83 ms per call at 10M, and −40 MB upload (−60 MB for edges). Status: confirmed.

**DATA-9 · bug · medium · `edges.set` does not validate endpoints**
- Where: `api/Graph.ts:439-450`, `511-517`; `shaders/passes/edge_sort.wgsl:48-49`.
- Now:
  - An out-of-range endpoint is clamped to the last node.
  - An endpoint ≥ 2^28 leaks into the edge state bits.
  - An endpoint on a freed slot draws to a removed node.
- Fix: a `max(ends) < slots` check (21–30 ms at 15M), with the per-endpoint check only when freed slots exist.
- Gain: correctness. The fix also saves −78 to −122 ms of main thread on the checks `edges.add` does today. Status: confirmed (lead, checker).

**DATA-10 · bug · medium · The icon palette only grows**
- Where: `data/GraphStore.ts:158`, `310`, `323`, `439-449`; `data/Pack.ts:81-113`.
- Now: updates merge into the palette. After 65,536 distinct colours over time, any update that adds a new colour throws and is dropped. Each call also rebuilds a palette-sized hash table.
- Fix: reset the palette on a full `updateAll`, and compact it on overflow.
- Status: confirmed with that correction.

**DATA-11 · bug · low · `nodes.set` keeps the previous graph's channels across a count change**
- Where: `data/GraphStore.ts:153-190`; `data/Pack.ts:33-45`.
- Now: the API says "starts over". Missing channels and the icon-colour index carry over for the first min(old, new) nodes.
- Fix: keep values only when the count is unchanged, and reset the icon-colour index on add. Status: confirmed.

**Lower-severity DATA items**

| ID | Kind | What | Fix | Gain | Status |
|---|---|---|---|---|---|
| DATA-12 | perf | each `nodes.remove` scans all edges; k calls in one frame cost k × 35 ms at 15M edges (`GraphStore.ts:247-278`) | tag nodes with the call id and scan once per frame | (k − 1) × 35 ms | reviewer only |
| DATA-13 | perf | load-time GPU peak ~2.8x steady (~1.4 GB at 10M/15M) | split the sorts across submits, drop `engineIdx`, drop the identity 8N | −0.4 to −0.5 GB peak, +1 frame of latency | reviewer only |
| DATA-14 | perf | scattered uploads carry an 8 B pair per element and binary-search per thread; staging only grows (`GraphBuffers.ts:351-396`, `scatter_update.wgsl:26-39`) | plain index list; full range when n > count/2; shrink staging | −25 to −33% upload bytes | reviewer only |
| DATA-15 | quality | NodeStream needs every value rewritten on each commit, which is undocumented (`StreamSlots.ts:51-57`) | document it, or copy forward | n/a | reviewer only |
| DATA-16 | bug | SAB-backed inputs become aliased mirrors the worker writes into (`Graph.ts:1064-1065`) | copy SAB-backed arrays in `take()` | n/a | reviewer only |
| DATA-17 | quality | `clearIcons` uploads the whole `nodeStyle` for a few nodes; style flags never turn off; unused locals; stale "device-lost recovery" comment; unused 64-range merge in `DirtyRanges`; `nodeScale: NaN` blanks the graph | index list; recount flags; validate style values | small | reviewer only |

Also noted: the real node cap is the adapter's storage binding size (8 B × 2^28 = 2 GiB exceeds some adapters' 2^31 − 4 limit), not 2^28.

## 11. Storybook demo (SB)

Every story goes through `src/stage.ts`, which keeps one `Graph` per story and destroys it at teardown. rAF loops, listeners, resize handlers and the ResizeObserver are released correctly, with the exceptions below. The library comes from `dist` (minified, worker via `new URL`), the same as a real app. Dev COOP/COEP is on, so SAB streams work.

**SB-1 · perf · high · Large datasets are generated synchronously on the main thread**
- Where: `apps/storybook/src/data.ts:21-34`; `src/graphStory.ts:165`; `src/stage.ts:105-119`; `stories/stress/Scale.stories.ts:44`; `stories/showcase/LargeGraph.stories.ts:42`.
- Now: the manager and the preview share one main thread, so the sidebar, controls and canvas input freeze:
  - communities 10M: 4.5 s;
  - cosmicWeb 10M: 6.4 s;
  - 1M datasets: 0.2–0.7 s.
  Generation starts only after the device is ready.
- Fix: generate in a module Worker, transfer the arrays back, show progress in the HUD, and start in parallel with `Graph.create`.
- Gain: the freeze goes 0.2–6.4 s → under 10 ms (plus the `copy:true` slice), and ~0.1–0.3 s of wall time is saved by the overlap. Status: confirmed.

**SB-2 · wrong-path · high · Numbered labels are rebuilt on every upload and re-sent on edge-only uploads**
- Where: `src/graphStory.ts:155` (edge-only path calls `upload`), `164-176` (`171` always calls `setLabels`), `194-203` (`200` builds `#i` with `Array.from`); `stories/stress/Scale.stories.ts:60-61` (`labels: true`, not in the controls).
- Now: on Scale at 10M, each Edges toggle costs 1.2 s of main thread (build 739 ms + library copy 348 ms + serialize 102 ms), plus ~0.6 s of worker deserialize and ~400 MB of transient strings. Sandbox caches node labels (`numbered()`); its edge-label cost is SB-10.
- Fix: cache the numbered arrays per count, send only edge data on the edge-only path, and expose `labels` in Scale's controls or default it to off.
- Gain: an Edges toggle at 10M goes 1.2 s → ~0. This includes DATA-3's share. Status: confirmed (lead, checker).

**SB-3 · wrong-path · medium · The GPU experiments send positions GPU → CPU → GPU every frame through a second device**
- Where: `src/gpuMotion.ts:94-135` (own device), `159-188` (MAP_READ, `mapAsync`, `stream.positions.set`, `zIndex.set(new Uint32Array(...))`, commit).
- Now: 8–40 MB of readback per frame and 0.4–1.8 ms of main thread per frame. Two devices time-slice one GPU, and the picture lags 1–3 frames.
- Fix:
  - (a) A library option, for the owner to decide: user WGSL for node position and colour, run on the engine device.
  - (b) Now: pack the z layers on the GPU and copy into the slot's `zWords` view.
- Gain: (a) −0.4 to −1.8 ms main thread and ~−0.1 to −0.3 ms worker per frame; (b) −0.33 to −0.49 ms per frame. Status: confirmed (path), plausible (bandwidth).

**SB-4 · perf · medium · Ripples: each hover drop scans every node**
- Where: `src/ripples.ts:158-175` (`166`).
- Now: 0.96 ms per hover change at 1M, although a drop touches at most 169 nodes (13²).
- Fix: compute the drop cells from the grid.
- Gain: 0.96 → < 0.01 ms. The main-thread simulation itself (22 ms per frame at 1M) is the story's stated point (0047), so moving it to the GPU is an option, not a fix. Status: confirmed.

**SB-5 · wrong-path · medium · Per-edge styles are recomputed on every upload and sent in a second message**
- Where: `stories/showcase/LargeGraph.stories.ts:19-36` (`33` `MIX.find` per edge), `44-47`; `stories/stress/Scale.stories.ts:26-31`, `49`; `src/graphStory.ts:175`.
- Fix: cache the styles with the dataset, use a plain threshold loop, and send them in the same `edges.set`.
- Gain: −0.2 s on first load and −0.43 s per cached re-upload at 10M. Status: confirmed (the transfer claim is withdrawn).

**SB-6 · wrong-path · medium · Edge colour and alpha changes do a full `edges.set`**
- Where: `src/graphStory.ts:155`, `164-192`; compare `Engine.ts:515-524` with `559-570`.
- Fix: `edges.updateAll({colors})` for colour-only changes, using zero words for "tint".
- Gain: 50–60% less transfer, −25 ms of main thread and no re-sort per alpha tick. The first tint → nodes switch still reloads. Status: confirmed.

**SB-7 · bug · medium · The developer check stories ignore their controls**
- Where: `stories/developer/GpuCorrectness.stories.ts:99-117` (`104`), `LabelCorrectness.stories.ts:121-134` (`122`), `LabelFlicker.stories.ts:113-126` (`114`); `src/stage.ts:75-89`.
- Now: changing count, dataset or edge labels does nothing, and the old results stay in `__graphCorrectness`, `__labelCorrectness` and `__labelFlicker`.
- Fix: a `rebuildOn(args)` key in the stage spec, or an `update` that reruns.
- Status: confirmed.

**SB-8 · wrong-path · medium · The Sandbox pick radius sliders rebuild the whole engine on every tick**
- Where: `stories/developer/Sandbox.stories.ts:97-99`; `src/stage.ts:70`, `75`, `92`; `api/types.ts:762-765` (`input.set` exists).
- Fix: diff `input` and call `graph.input.set(changed)`. Keep only the init-only fields in `optionsKey`.
- Gain: a full rebuild (seconds at 10M) becomes one message (< 0.1 ms). Status: confirmed (lead, checker).

**SB-9 · bug · medium · GpuMotion start races teardown and leaks its device**
- Where: `src/gpuMotion.ts:94-135` (`131`), `173-187`; `api/Graph.ts:577`, `807-810`; `Galaxy.stories.ts:39`, `Lorenz.stories.ts:44`, `BlackHole.stories.ts:43`, `BlackHole3d.stories.ts:53`, `Doom.stories.ts:28`.
- Now:
  - When cross-origin isolated, a teardown during the awaits makes `stream()` throw and the rejection goes unhandled. The device stays alive until GC (~200–220 MB on Black hole 5M and 3D 3M).
  - There is no `device.lost` handling, and 3 rejected maps stop the animation silently.
- Fix: a cancel token after each await, `device.destroy()` on failure, a `device.lost` handler, and `.catch(hud.error)`.
- Status: confirmed.

**SB-10 · perf · medium · The dataset cache has 2 entries, counts entries not bytes, and text entries evict graphs**
- Where: `src/data.ts:11`, `21-34`, `97-112`; `stories/developer/Sandbox.stories.ts:84-89`, `108`; `src/bench.ts:31-33`, `63`.
- Now: with node and edge labels on, Sandbox rebuilds both text arrays on every upload (−1.86 s at 10M). The suite regenerates communities 1M for `large-icons` because of the 2-entry cap.
- Fix: a byte-budgeted LRU, store text inside its dataset entry, and clear the cache on leaving the stress stories.
- Gain: −1.86 s per labelled Sandbox upload at 10M, and −0.3 to −1 GB peak in Scale. Status: confirmed.

**SB-11 · quality · medium · The benchmark method does not match the saved baselines**
- Where: `src/bench.ts:23-40`, `62-70`, `96-99`; `packages/bench/src/stats.ts:34-38`.
- Now:
  - All 6 saved result files are `clustered`, node-only, with no labels, while the suite is `communities` with node and edge labels, so no baseline exists for it.
  - Each case is one 200-frame run, where p99 is the 3rd-highest sample.
  - There is no settle wait after a 10M upload.
- Fix: save a baseline for the current suite, run each case ≥ 3 times and report the median, and wait for the label solves to settle.
- Status: confirmed.

**SB-12 · bug (unverified) · medium if real · Production cross-origin isolation may miss the `/storybook/` page**
- Where: `apps/docs/public/_headers:1-3`; `.storybook/main.ts:17-21`.
- Now: there is only a `/storybook/*` rule. Without isolation, streams copy every frame and input goes through postMessage (worker p95 1.76 vs 0.94 ms at 1M, 0042).
- Fix: check `crossOriginIsolated` in the deployed iframe, and add explicit rules if needed.
- Status: plausible, not checkable read-only.

**Lower-severity SB items**

| ID | Kind | What | Fix | Gain | Status |
|---|---|---|---|---|---|
| SB-13 | bug | the wheel is never detached: each SmallGraph mount leaves a keydown listener holding the destroyed Graph; the link redraw forces layout while picking (`SmallGraph.stories.ts:72-75`, `98-117`; `wheel.ts:135-148`, `284-286`, `292`) | `dispose` → `wheel.detach()`; cache the rect; one persistent `<path>` | leak; ~0.05–0.2 ms per frame while picking | confirmed (no `detach` call exists) |
| SB-14 | wrong-path | a graph is still created after a fast unmount; old and new devices overlap during a switch (`stage.ts:105-111`, `Graph.ts:769-781`) | check `cur !== current` before `Graph.create`; `destroy()` returning a promise | one worker and device fewer per skipped story | reviewer only |
| SB-15 | perf | Black hole 3D glow is three CSS drop-shadows (4, 24, 80 px) over the canvas (`BlackHole3d.stories.ts:18`, `48`, `64`, `80`) | glow off by default, or draw it in the engine | not estimable | reviewer only |
| SB-16 | perf | `setBenchIcons` calls `hslToWord` per node for 16 colours (`bench.ts:42-55`) | precompute 16 words | −0.26 to −0.35 s at 10M | reviewer only |
| SB-17 | perf | the HUD is on by default, so every story runs the profiler and probe (`preview.ts:7`, `stage.ts:57-60`, `118`) | HUD off for Showcase and Experiments, or measure the overhead once | not estimable (`timing:"off"` vs `"passes"`) | reviewer only |
| SB-18 | perf | Black hole 3D runs `image()` twice per node per frame (`blackhole3d.ts:95`, `118`) | compute once | ~0.05–0.2 ms GPU per frame | reviewer only |
| SB-19 | quality | the HUD's "upload→frame" stops at the first submit; the danger panel leaves out label memory (~2 GB at 25M) (`hud.ts:34-43`, `danger.ts:122`, `148`) | relabel; add label bytes | n/a | reviewer only |

## 12. Decisions to revisit

These findings touch an accepted decision. Each needs a measurement before the decision changes.

| Decision | Finding | What is new |
|---|---|---|
| 0014 (no decoupled look-back) | NODE-4, NODE-8 | Decoupled Fallback (SPAA'25) is portable without forward-progress guarantees |
| 0016 (subgroup scans gave no gain) | NODE-1 | measured before LOD, when the cull was bandwidth-bound; scatter is now barrier-bound |
| 0026 (glide) | ENG-4 | the first notch after idle jumps 86.5% |
| 0037 / 0038 (screen density) | EDGE-3 | the overdraw budget is still per length level |
| 0043 (pick padding) | INT-5 | the tie rule inside the radius was never discussed |
| 0044 (hover redraws the scene) | INT-3, ENG-2, LBL-17, EDGE-12 | the cached-scene alternative was never measured |
| 0054 (edges.add re-sorts) | DATA-1, LBL-2 | only the re-sort was measured, no alternative |
| 0055 (one edge scan per remove) | DATA-12 | many removes in one frame multiply it |
| 0058 (selection latency) | INT-1 / NODE-2 | only call latency at 10k selected was measured, not frame cost |
| 0073 (node reserve) | DATA-2, DATA-5 | reserve size kept; the growth path and load copies are the issue |
| 0077 (curves draw over straight) | EDGE-1, INT-2 | cost never measured; the pick order does not follow the draw order. EDGE-1 done in 0078, EDGE-6 in 0079; INT-2 open |

## 13. Measurements that would settle the estimates

Use the `packages/bench` fixtures, the same machine and the same camera path before and after. Report frame time and p95.

1. **Baseline:** re-baseline the current suite (`communities` with labels) on the Xe-LPG. No saved run covers the current code, edges or labels (SB-11).
2. **NODE-1:** `xlarge-zoom`, cull.count against cull.scatter.
3. **NODE-3, EDGE-2:** `xlarge-zoom` and `large-zoom`, pad 1.0 against 0.5.
4. **EDGE-1:** a new mixed case with 1 edge in 64 curved, at `large` and `xlarge`. Done: the `*-curve-mixed` cases (`ba8e65a`).
5. **INT-1, NODE-2:** `large` and `xlarge` after a scripted 25% lasso, and after 1,000 scattered selections.
6. **ENG-2, LBL-3, LBL-17:** probe frame rows for 2 s after a pan stops on `xlarge`. Count the full renders and culls per stop.
7. **INT-3:** a scripted hover sweep on `large` and `xlarge`, GPU time per hover frame.
8. **DATA-1, DATA-2, LBL-2:** time `edges.add(1)` and a reserve-crossing `nodes.add` at `xlarge`, plus the frames with labels missing.
9. **EDGE-4:** `nodes.updateAll({sizes})` every frame at `xlarge`, `edge.bounds` slot.
10. **SB-17:** `debug.benchmark({timing:"off"})` against `"passes"` on `large` and `xlarge-zoom` (profiler overhead).
11. **ENG-9:** `performance.now()` marks around each compile wave in `Engine.create`.
12. **LBL-4:** a run with `timestamp-query` disabled, frames per label solve.

## 14. Method and sources

- **Reviewers.** Seven parallel reviewers, one per area: ENG, NODE, EDGE, LBL, INT, DATA and SB. Each read its area in full and traced the frame path. The CPU paths were timed in Node 24 from bundled repo sources, and the edge counts were modelled with a JS port of the cull (`sim.mjs`).
- **Checkers.** Three adversarial checkers re-read every high and medium finding against the code and re-checked the arithmetic. The lead checked about 20 key claims by hand.
- **Repo.** The repo was not modified. Scratch files are in the session scratchpad.
- **External references:**
  - Decoupled Fallback: Smith, Levien, Owens, SPAA'25, https://doi.org/10.1145/3694906.3743326
  - GPUPrefixSums: https://github.com/b0nes164/GPUPrefixSums
  - van Wijk & Nuij 2003, "Smooth and efficient zooming and panning"
  - Blelloch, Fineman, Shun 2012 and Fischer, Noever 2018 on greedy MIS with random priorities
  - MapLibre placement throttling
  - Been et al. on active ranges for labels
