# Decisions

One entry per decision, newest first. Keep entries to a few lines: what was
decided, and the measurement that decided it.

Numbers are from an Intel Xe-LPG iGPU (Arc Graphics, ~69.5 GB/s measured read
bandwidth), Edge 153, 1M nodes / 3M edges at fit unless stated.

---

## 0042 — Streamed positions upload straight from shared memory

`streamNodePositions()` hands the caller a triple-buffered shared slot; the
render worker takes the latest one at frame start and writes it to the scatter
staging buffer directly, skipping the store mirror, which is synced only when
`setNodes` comes without positions. Copying the slot into the mirror first was
slower than the old message path. Galaxy story, 1M nodes, every position every
frame, AMD Radeon 890M, Edge 145 headless, one run each after a warm-up:
render worker CPU mean / p95 — message 0.78 / 1.76 ms, stream via mirror
1.25 / 1.51 ms, direct 0.74 / 0.94 ms. All three held 60 fps; main thread
0.22–0.24 ms mean in each.

## 0041 — Node shapes are SDFs, and the shape rides in the instance radius

Square and hexagon (flat top and bottom) join the circle. Every shape fits the
circle's `[-1,1]²` box, so the quad, the cull margin, chunk bounds and LOD are
unchanged. Both SDFs are exact distances, so the analytic AA of 0005 still
holds. The shape travels in the low 4 mantissa bits of `NodeInstance.radiusPx`
(radius error ≤ 2⁻¹⁹), keeping the instance at 16 B. A `NODE_SHAPES` override
compiles the `nodeStyle` read and the shape `switch` out when no node has a
shape, so circle-only graphs run the same code as before. Arrowheads stop at
the target's real boundary. Not measured yet: frame and p95, circle-only
against 0040 and mixed shapes, still to be added.

## 0040 — Chunk draw positions come from a table, not a multiply

The NORMAL bucket scrambled chunks with `(chunk * stride) % chunks` in u32,
which wraps above 65,536 chunks (67.1M nodes). Two chunks then share a draw
position: at 90M, 15,580 chunks collided and 74,046,080 of 90,000,000 nodes were
drawn; cells no chunk wrote kept stale words, so reusing a buffer (90M then
102M) gave a 2.2B instance count and a GPU hang. The CPU now builds the same
positions once per chunk count (exact in f64) and writes them into the cull
state after the chunk bounds; `drawIndex` reads `table[chunk]`. Draw order below
67.1M is unchanged; the table is 4 bytes per chunk. Measured on an AMD Radeon
890M, Edge 145, Linux, runs alternated: 90M draws 90,000,000; 1M (5 runs each)
frame 5.32 → 5.41 ms, p95 10.78 → 10.67 ms; 10M standard (2 runs each) frame
12.62 → 12.72 ms, p95 20.32 → 19.98 ms. All inside run-to-run spread.

## 0039 — Pinch zoom is direct, paired on the main thread

Two fingers used to fight: each finger's down re-anchored the drag and the
alternating moves panned back and forth by the finger gap. Now `PointerInput`
keeps two touch slots and, while both are down, sends one `PINCH` record per
move carrying the absolute midpoint and finger distance in device px. The worker
pans by the midpoint delta and zooms by the distance ratio at the midpoint, so
applying every record or only the last of a batch gives the same camera, as
0006 does for pan. Pinch is direct, not glided like the wheel (0026): touch
moves arrive at screen rate, so there is no gap to fill, and a glide would trail
the fingers and keep rendering after they stop. The record layout, ring and
protocol are unchanged; a pointer id per record would have widened the record
for the same traffic. When one finger lifts, a `POINTER_DOWN` for the other
re-anchors the drag without a jump. `gpu.mjs input` gained a pinch phase driven
by CDP touch events; the headless probe has not yet run on this branch.

## 0038 — Edge sampling keys on density, not length

Keeping an edge with probability `lim / screenLength` makes the threshold a
function of the camera: zoom in, screen length grows, and edges cross it and
vanish one at a time. 0034's claim that the same edges survive every frame is
wrong — the hash is stable, the threshold is not. Sampling must key on local
screen density read from the previous frame's accumulator, as a smooth ramp, so
keep-rate rises as you zoom in. `edgeSampleLenPx` defaults to 0 until that
lands. A precomputed world-space density field was rejected: 2048² under-
resolves past ~2x zoom, and ink peaks mid-zoom (342M splats at x8 against 142M
at fit), so the field is coarsest where cost is worst. Build the zoom-sweep
visual regression first — a fixed camera in every earlier measurement is why
this was missed.

## 0037 — Per-chunk density sampling does not work

Negative result. Sampling a chunk's neighbourhood down to a target overdraw
fires almost never: a chunk is spatially compact, so 1024 edges of ~2 px over a
35x35 px box gives local overdraw ~1.7, nowhere near a target of 8. The 58x
overdraw of 0029 is a global pile-up of thousands of chunks on the same pixels,
which a per-chunk metric cannot see. `edgeTargetOverdraw` is kept but defaults
to 0. The density estimate has to be over the screen. `Frame.edgeTargetOverdraw`
lands in existing tail padding, so the struct stays 112 bytes and
`BINDING_CONTRACT_VERSION` is 3. `target` is a reserved word in WGSL.

## 0036 — Split the rasterizer by edge length

Both rasterizers run over the same instance list and split it by length: edges
longer than `edgeTileSplitPx` are binned and tiled, shorter ones splatted
directly. No list splitting needed — the list is already length-ordered, so each
pass skips the half that is not its own. Edge work at fit 22.6 → 15.8–17.8 ms,
at zoom x8 18.3 → 6.9–8.6 ms. Output is pixel-identical to the density path.
Ordering keeps it safe: tiled writes first with plain stores, density adds on
top with atomics, and an untiled tile reads zero because the resolve clears as
it reads. The 32 px default is reasoned, not measured — this dataset's lengths
are bimodal, so every split from 16 to 128 selects the same edges.

## 0035 — Tiled rasterizer: 11x at zoom, loses at fit

`EdgeTiledPass` bins instances into 32x32 tiles and rasterizes each in 4 KB of
workgroup memory. Raster at zoom x8 16.18 → 1.47 ms, whole frame 22.70 → 9.56.
At fit it loses: binning costs ~17.5 ms because almost every edge is ~2 px and
still pays a full (edge, tile) entry and a contended atomic. Two WebGPU facts: a
writable storage buffer may not be bound twice in one bind group, even at
non-overlapping ranges; and working around that with atomics everywhere cost 3x
— splitting into counts-atomic and offsets/lists-plain took the raster 6.78 →
1.47 at zoom.

## 0034 — Weighted edge sampling: 12x at zoom, with a real artifact

Edges up to `edgeSampleLenPx` on screen draw whole; longer ones are kept with
probability `lim/len` and carry weight `len/lim`, so expected ink is unchanged
and cost per edge is capped. Zoom x8 goes 252.8 → 20.3 ms. Default 64, chosen
from images: at fit it is indistinguishable from unsampled, at 16 the halo
visibly coarsens. The artifact is not free — at zoom x8 the densest area reads
as a mesh of individual strokes where the reference saturates smoothly. Ink is
preserved, texture is not. `edgePick()` lives in `edge_state.wgsl` because
`edge_count` and `edge_scatter` must reach identical decisions. `Frame` gained
`edgeSampleLenPx` (104 → 112 bytes), so `BINDING_CONTRACT_VERSION` is 2.

## 0033 — Edges sort by length bucket first

The sort key becomes `bucket(chebyshevLen / graphExtent) << nodeBits |
min(src, dst)` with 8 octave buckets. Length is in world units, so the bucket
survives camera changes. One extra radix pass, on data change only. Cull as a
fraction of the rasterizer measured in the same run: fit unchanged, zoom x8
−21 %, zoom x64 −38 %. Deposited ink is identical to three significant figures.
The in-chunk shuffle was built and reverted: it pushed cull/raster at fit from
0.212 to 0.265, because the endpoint gather loses locality and fit is where all
3M endpoints are read.

## 0032 — Binning costs ~0.6 ms per million (segment, tile) entries

Measured per stage in its own loop, with the entry count read back rather than
estimated. Binning scales with entries, not segments, past a ~0.4 ms fixed
floor; entries per segment ≈ `1 + len/32 × 1.3` at a 32 px tile. This kills
along-edge subsampling as the long-edge answer — striding samples does not
reduce the tiles a segment crosses. The budget that follows: keep short edges
whole, drop long ones to ~10 % at weight 1/p, ≈ 3.7 ms total. Short-edge binning
(~1.5 ms) is a floor that cannot be sampled away.

## 0031 — Tiled rasterizer is 6–13x, and cost moves from ink to segment count

Honest pipeline (bin-count → scan → bin-scatter → shared-memory raster), with
deposits verified identical to the untiled kernel. 5.3–10.8 G splats/s,
independent of edge length, against 0.6–0.9 G/s for spread-out untiled, and
0.87x in the clustered cache-resident case. Two things make it work: no global
atomic anywhere, since tiles partition the screen so the flush is a plain store
(worth 3.07 → 1.97 ms); and ownership decided by an integer pixel test rather
than parametric ranges. Binning is per segment × tiles crossed, ~5–11 ms per
million segments, so the budget must cut segment count as well as ink. Three
bugs the deposit guard caught: an unsubmitted command buffer reporting 279–500 G
splats/s; `i32()` truncating toward zero so a sample was deposited twice
(`floor()` first); and rounding leaving clipped endpoints outside the viewport,
dropping whole segments, with loss scaling as length².

## 0030 — Splat throughput is bound by the accumulator's working set

0029 blamed uncoalesced atomics. Wrong. Standalone kernels: length does not
matter, workgroup count does not matter — identical ink concentrated into 25 %
of the screen runs 6.6x faster. The accumulator is 10.75 MB full-screen, so a
scattered splat pulls a 64 B line to update 4 B: 0.85 G splats/s × 64 B ≈
54 GB/s, this device's DRAM roofline. Tiling is therefore the main lever, for
locality rather than contention. Stratified subsampling costs ~30 % per splat
because sparser deposits coalesce even less, and it scatters exactly what tiling
wants to gather — the two must be measured together.

## 0029 — Edge cost is ink, and now it is measured

`EdgeRasterPass` counts deposited pixel steps behind `EDGE_COUNT_INK`, an
override constant selecting a second pipeline, so it costs nothing when off.
Validated against a CPU oracle: ratio 1.000 at fit, x8 and x64. Overdraw is
27–141x; 15 % of edges carry 96 % of the ink; splat throughput collapses 6x as
edges lengthen (5.9 → 0.95 G/s); the cull alone costs 4.7 ms at fit. Culling
cannot touch any of it — those edges are on screen.

## 0028 — Compute density rasterizer for edges

Blended quads replaced by coverage accumulated in compute, resolved once per
frame. A/B in one browser run: 2.1x at 100k/1M rising to 4.2x at 10M/10M, but it
reverses when zoomed in (0.93x at x8, 0.78x at x64), because a long edge
amortises vertex setup over hundreds of pixels while the compute path pays one
atomic per pixel. So neither mode is right on its own. Load balancing without a
work list: each workgroup clips 256 edges, prefix-sums their span counts in
workgroup memory, and all 256 lanes consume the batch cooperatively — pooling
spans, not pixels, since the pixel version paid an 8-step binary search per
splat. The resolve clears the accumulator as it reads (`atomicExchange`). Three
harness bugs each produced confident nonsense first: `requestRender()` measuring
the render pass alone, `camera.getView()` reading state the worker writes after
a frame so every zoomed row silently measured fit, and a 30-frame rolling mean
blending consecutive measurements.

## 0027 — Engine-index endpoints, sorted edge list, chunk cull

The endpoint gather is the whole problem: at 30M edges, user indices through
`rank[]` cost 146 ms, engine indices 85.3, and engine indices with the list
sorted by lower endpoint 16.8. So endpoints are remapped to engine indices once
on data change, and the edge list is sorted by `min(src, dst)` in Morton order —
without it the chunk bounds never fire, since 1024 arbitrary edges span the whole
graph. `min`, not `src`, so direction survives for arrowheads. The `screenPos`
cache was refuted: 86.9 against 85.3, because the cost is the access pattern,
not the payload. The cull gives 3.3x at zoom x64 and slightly costs at fit,
where 100 % drawn is the correct answer. It also exposed that the rasterizer is
95 % of the frame. WGSL has no 64-bit atomics, so the point-cloud trick of
packing depth and colour into one `atomicMin` does not port; per-edge colour
costs 2.5x, hence a global tint by default. A dataset bug found by looking at
the picture: the first edge generator joined index-adjacent nodes, which in
`clustered` are spatially random.

## 0026 — Wheel zoom glides

Measured first: the engine rendered exactly one frame per input event, so
smoothness was capped by wheel rate — 10 events/s gave 7.8 fps at deep zoom on
10M while the GPU used 3.3 of its 16.7 ms. Latency was never the problem, with a
median input→frame of 0.9 ms. A notch now adds to a target and `Controls.advance`
approaches it exponentially, framerate-independent. 10 events/s now renders 231
fps headless. Panning is deliberately not smoothed — a drag already tracks 1:1.
Costs nothing when still: 0 frames in 2 s idle. Unexplained: a latency tail
under synthetic input and a ~20 fps ceiling that is not GPU-bound; the probe may
be inflating both.

## 0025 — LOD engages earlier

Three changes to `lodItems`. Chunk extent is `sqrt(dx*dy)` rather than
`max(dx, dy)`, because elongated boxes swung sample counts 4x and gave adjacent
chunks visibly different texture. The guard asks about size
(`2 * maxR >= LOD_TARGET_PX`) rather than separation, since sub-pixel nodes are
technically far apart and a separation test kept everything exactly where
sampling matters most. And a minimum 2x reduction, below which the inflated
survivors lose. Drawn instances at 10M: fit 3.01M → 202k, z2 9.93M → 730k;
xlarge-zoom p50 29.83 → 7.17. Still negative on the small cases — LOD costs
something where it cannot help. Two harness bugs had corrupted earlier
conclusions: `--no-build` skipped the Storybook build that embeds `dist/`, so
runs after a library change measured old code; and opening a page occasionally
landed on an error document with `crossOriginIsolated === false`.

## 0024 — LOD is a random prefix of real nodes, not a cluster pyramid

Replaces 0022; the pyramid is deleted. One representative per equal-count Morton
cell is a jittered lattice by construction, and showed as a woven texture at 7x
the reference's 2-D autocorrelation peak. Instead `shuffle_chunks.wgsl` permutes
engine order within each chunk by a hash of the user index, so any prefix is a
uniform random sample; LOD becomes a prefix length, with survivors scaled to
conserve ink. Every drawn dot is a real node. Lattice peak at fit 0.184 → 0.028
against a reference of 0.023; xlarge-zoom p50 29.83 → 7.90. Aggregate statistics
hid an artifact that was visible at a glance — look at the images.

## 0023 — LOD merges only the sub-pixel mass

`gpu.mjs imagediff` compares LOD off against on, using metrics picked for the
failure modes LOD has: ink, saturation, and worst local 32 px density error. The
first run showed LOD was most wrong zoomed in (−15 % ink at z8), because
`lodLevel` judged by spacing alone and merged nodes that were individually
resolvable. A node big enough to resolve is real information; only the sub-pixel
mass is a density field. A chunk whose largest node still reaches
`NODE_MIN_DRAW_RADIUS_PX` is never merged, which makes z8 exact. Still open: z2,
where nodes straddle the threshold.

## 0022 — LOD clusters, 4-ary pyramid over Morton order

Superseded by 0024. Level L is one 16 B `Cluster` per 4^L engine-order nodes;
build is bottom-up on data change, 7.3 ms at 10M. xlarge-zoom p50 29.83 → 5.79.
Three things measured rather than assumed: draw order still matters (deleting
the 0020 interleave made it worse than no LOD, render p50 7.41 → 18.74); cluster
radius must conserve ink, not extent (drawing at the group spread was slower
than no LOD); and pyramid offsets must never be derived in the shader (a chain
of divisions per thread cost deep-zoom p99 5.34 → 11.14).

## 0021 — The cull is at the memory roofline; 10M visible needs LOD

Opened to fix a suspected profiler bias; both halves of the suspicion were
wrong. Sample drops are biased toward fast frames, not slow ones, so the ring
makes p50 slightly pessimistic and leaves p99 intact, and the reported
frame-interval gap was vsync quantization. No profiler rework done. What the
measurement did show: at 10M fully visible, count plus scatter at perfect
roofline cost 4.54 + 12.06 = 16.6 ms, already over budget before a pixel is
drawn. No kernel tuning reaches the target while every node is touched every
frame; the traffic itself must shrink. Two microbenchmark traps hit: zero-filled
buffers make `classify()` early-out so the whole path under test vanishes, and a
counter the compiler can bound gets dead-code eliminated.

## 0020 — Draw order decoupled from engine order

Shuffling Morton order in batches trades culling against blending, and no batch
size wins both — spatial order is what culling wants and exactly what blending
hates. So engine order stays pure Morton and only the output slots of
BUCKET_NORMAL are interleaved: segment of DRAW_SEGMENT nodes, scrambled chunk,
engine index, with chunks scrambled by a golden-ratio stride. Each node's place
depends only on its own index, so it is stable frame to frame and overlapping
nodes never swap. Segment 16 with a device-wide 3-phase scan matches random
order for drawing and keeps the culling win; a single-workgroup scan was 2.8 ms
for 1.25M cells and was rejected.

## 0019 — Workgroup-scan last-lane read moved after the scan

A stable radix sort passed cold and on synthetic keys, then produced 216k
duplicate indices on every warm run at 1M. The scatter's `wgScanVec4` wrote the
last lane's value into a workgroup variable before the Hillis–Steele loop and
read it after. Valid WGSL, intermittently stale on this Intel/D3D12 stack.
Writing it after the loop behind its own barrier fixes it. Rule: GPU kernels are
verified warm, repeatedly, on real data, against a CPU reference — never on
first run or synthetic data alone.

## 0018 — Engine order: physically Morton-sorted node buffers

Random gathers are ~10x more expensive on this GPU: at 10M fit, physically
sorted buffers cost 8.2 ms against 99.5 for a permutation index. So every node
channel in `@group(1)` is stored in engine order. `order[engine] = user` and
`rank[user] = engine` live on the GPU; bulk loads arrive in user order and the
sort permutes them, only on data change; partial updates go through `rank`. The
CPU never needs the permutation.

## 0017 — Chunk bounds and a coarsened, list-driven cull

Chunk = 1024 nodes (256 threads × 4), one 24 B bounds record rejecting it with a
workgroup-uniform early-out; scan builds a deterministic list of non-empty
chunks; scatter is an indirect dispatch over that list. Deep zoom 4.88 → 0.31 ms
at 10M. Bounds only pay after sorting — with random order, 99 % of chunks hold a
visible node at deep zoom. Fit stays bandwidth-bound at ~8.2 ms, which is an LOD
problem, not a cull one.

## 0016 — Portable scans, no subgroups for now

Subgroup scans against Hillis–Steele in the tuned cull: 0.335 against 0.294 ms
deep zoom, 1.12 against 1.05 at 10 %, 8.16 against 8.36 at fit. No consistent
gain, and a second code path. Revisit for the radix sort with measurements.

## 0015 — Indirect args live in their own buffer

WebGPU forbids a buffer being both the indirect-args source and a writable
storage binding in the same dispatch. Each cull phase has its own pipeline
layout; the dispatch args buffer is bound only in `cull.scan`.

## 0014 — Stable LSD radix sort, 4-bit digits, adaptive key width

Reduce-then-scan per digit (count → scan → scatter), no global atomics, no
decoupled look-back, which needs forward-progress guarantees WebGPU does not
give. Key width targets ~4 nodes per Morton cell. 3.3 ms at 1M, 31 ms at 10M,
~57 % of the bandwidth roofline. Runs on data change only. Next lever: 8-bit
digits.

## 0013 — No competitor in the harness

Head-to-head against another library was removed at the owner's request.
Performance is judged against the budgets and against our own previous runs
(`Download JSON` → `packages/bench/results/`).

## 0012 — Benchmark runs inside the render worker

`graph.benchmark({ path, frames })` steps a frame-indexed camera path once per
rendered frame and records CPU, frame interval, GPU total, GPU per pass and
visible counts in the worker, returning them in one message. Frame N is the same
view on every machine and the main thread is idle, so the numbers measure the
engine, not Storybook.

## 0011 — Profiler granularity: per compute pass, one slot for render

Timestamps come from pass `timestampWrites`, since core WebGPU has no mid-pass
timestamps. Each compute stage runs in its own pass and is timed individually.
All render stages share one render pass, because `beginRenderPass` is expensive
on tiled GPUs, and are timed as a single `render` slot. If per-stage attribution
is needed later, add an opt-in split-render-passes profiling mode.

## 0010 — Deterministic compaction instead of atomic append

Atomic append order changes every frame, so overlapping nodes blend over each
other differently and dense regions flicker. Reduce-then-scan in three dispatches
(`cull_count` → `scan_groups` → `cull_scatter`) outputs in node-index order.
Global atomics are gone entirely; workgroup-local counters only. The cost is a
second read of pos, size and colour, for visible nodes only.

## 0009 — Compacted NodeInstance records instead of index lists

The cull writes one 16 B `NodeInstance { screenPos, radiusPx, color }` per
visible node in draw order, so the vertex shader does one coalesced 16 B load
with no index indirection and no random gathers. Colour changes therefore re-run
the cull; background-only changes do not.

## 0008 — Engine needs 10 storage buffers per stage

The public contract puts 8 storage buffers in `@group(1)`; the cull and draw
passes add 2 in `@group(2)`. Adapters below 10 are refused with
`UnsupportedError("insufficient-limits")`. If real hardware reports 8, pack the
edge bindings into fewer buffers rather than chunking passes.

## 0007 — Pass skipping by dirty flags

Compute passes declare `runsOn` flags, so a frame whose only change is the clear
colour re-renders without re-running the cull.

## 0006 — Pointer input sends absolute positions, not coalesced events

Records carry absolute device-px positions and pan is computed from consecutive
positions in the worker, so coalesced sub-events add no information for pan and
zoom and would only multiply ring traffic. Revisit for lasso selection, where
the intermediate path matters.

## 0005 — Analytic AA in the node fragment shader

For the built-in circle the quad is screen-aligned and uniformly scaled, so the
AA width is exactly `1 / radiusPx`, passed flat from the vertex stage. Same
result as `fwidth(sd)`, with no derivative instructions. Custom shape hooks may
produce non-uniform fields, so that path will use `fwidth`.

## 0004 — Sub-pixel nodes on the hardware path fade by area

Temporary. Until the compute rasterizer takes the TINY bucket, nodes below
0.5 px radius are drawn at 0.5 px with alpha scaled by `(r / 0.5)²`, which
conserves energy — no shimmer, no disappearance on zoom-out.

## 0003 — Mapped staging ring deferred

Bulk loads already use `mappedAtCreation`. Partial updates go through coalesced
`writeBuffer` ranges only. The ring will be implemented when the harness can
measure the streaming case, and kept only if it measurably beats `writeBuffer`.

## 0002 — Bench fixtures live in their own workspace package

`packages/bench` (`@vhult/graph-bench`, private): seeded datasets, camera paths
and statistics, shared by Storybook and any future CLI harness, without the
engine depending on either. The engine itself has no runtime deps.

## 0001 — Naming, workspace layout, Storybook as consumer

Package `@vhult/graph`; internal name `graph` (class `Graph`, WGSL prefix
`graph_`). npm workspaces: `packages/graph`, `packages/bench`, `apps/storybook`.
Storybook consumes the built `dist/` exactly as an external app would, so it
tests what ships. Storybook deps are dev-only in the Storybook app. HTML
renderer, so no framework runtime in the preview iframe.
