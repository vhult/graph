# Decisions

One entry per decision, newest first. Keep entries to a few lines: what was
decided, and the measurement that decided it.

Numbers are from an Intel Xe-LPG iGPU (Arc Graphics, ~69.5 GB/s measured read
bandwidth), Edge 153, 1M nodes / 3M edges at fit unless stated.

---

## 0073 — The node reserve is an init option, 100 by default; an add inside it marks STYLE | STATE

The reserve of 0055 is `GraphOptions.nodeReserve` (user decision): an integer
>= 0 set at `Graph.create` only, 100 by default. An add that fits is an index
scatter, the add that takes the last slot grows to `slots + reserve`, and an
add larger than the reserve grows to its new count + reserve in one rebuild.
With 0 every add that needs a new slot grows to exactly the slots it needs,
and an add that reuses freed slots does not grow. The node limit stays
`EDGE_END_MASK + 1` (2^28): the reserve is clamped so that slots + reserve
never pass it, so a large reserve never lowers the limit, and a store already
at the limit does not grow. `large` on an AMD Radeon 890M, 250 single
adds, one run per value (mean / p95 ms, summed wall): 0 grows on every add,
wall 25.33 / 50.49, GPU 20.38 / 29.43, CPU 8.01 / 11.35, summed wall 6,332;
100 grows at adds 100 and 200 (wall 65.24, GPU 29.64, CPU 19.51) and is wall
1.33 / 2.11, GPU 8.30 / 8.93 inside the reserve, summed wall 460; 100,000
never grows, wall 1.41 / 2.24, GPU 8.21 / 8.79, summed wall 353. The hidden
slots cost nothing per frame: `large` bench, 2 runs each, GPU mean
3.85 -> 3.69 ms (−0.16 ms, −4.0%) and p95 8.08 -> 7.70 ms (−0.38 ms, −4.6%)
from 100 to 100,000, worker CPU 0.681 ms for both; the drop is run noise (one
100 run kept 149 of 200 GPU samples).

An add inside the reserve marks `Dirty.STYLE | Dirty.STATE` instead of
`POSITIONS | STYLE | STATE`: `STATE` already runs node chunk bounds, the node
cull, the label solve and the pick, and new nodes have no
edges, so the whole-graph edge bounds refit is skipped. Frame of one add
inside the reserve, AMD Radeon 890M: GPU 7.58 -> 6.27 ms, `edge.bounds`
2.61 -> 0 ms, measured on the Package 8 tree (1/16 reserve, bench communities
story, 1M). On the final tree (`large`, flat reserve, mean / p95) an add
inside the default reserve is GPU 8.33 / 9.07 ms, worker CPU 0.524 / 0.875 ms and
1.34 / 2.14 ms to the next frame, against an idle frame 0 at the same view of
8.09 / 8.63 ms GPU and 0.481 / 0.570 ms CPU. A reserve of 1/16
of the slots was measured too (no per-frame cost, growth every 62,500 adds at
1M) and not kept: at 10M a growth costs about 350 ms (node sort 74 ms, edge
sort 90 ms), paid once every 100 adds with the default reserve.

## 0072 — Replies share one message; a bad icon never fails a define

The worker answers every request (`query.at`, `query.inside`, snapshots,
label snapshots, icons, benchmark) with one `reply` message
`{ id, value | code, message }`, and the facade keeps one map of pending
replies. `destroy` rejects them all with `destroyed`; a second benchmark gets
an `invalid-argument` reply. A label snapshot with nothing to place (no
nodes, no label text, no cull buffers, or a failed readback) is answered at
the end of the frame with an empty snapshot, and a placement in flight on a
graph that empties stops. `icons.define`, `icons.add` and `icons.replace`
never fail as a whole: each bad icon is drawn blank, keeps its id and is
reported as one `error` event (`invalid-argument`, naming the icon); the call
resolves. The rollback of the main-thread ids is gone. A define with bad
icons packs the icon buffer once. `icons.add([])` resolves without a
message. Checked on the sandbox story: define with one bad icon of three
resolves with one error, and nodes drawn with every id show no other error.
No speed effect: this runs on calls, not per frame.

## 0071 — Picking is one queue in an Interaction module

Press, drag, shape, selection, hover gating and pick routing moved from
`Engine`, `Press`, `HoverGate` and `Selection` into one `Interaction` module
that reaches the engine through a small host, so it runs in Node tests. The
press is one state field (idle, picking, armed click, armed drag, armed
shape, dragging, shaping). Presses, double clicks, context menus and
`query.at` are jobs in a ring of reused objects: each tick submits the jobs
not yet sent while a pick readback slot is free (three slots), and results
are matched by token and finished in queue order, a later result waiting in
its job. The hover is one merged pick in its own slot, so it never blocks a
job. Two double clicks now give two events, a quick second press keeps the
first click, and a failed readback finishes its job with an empty hit. Sandbox
story (100,000 nodes), AMD Radeon 890M, mean / p95 of 2 runs: three parallel
`query.at` 9.48 / 10.89 -> 6.08 / 7.29 ms; click with the pointer moving
15.51 / 16.51 -> 15.10 / 16.59 ms. Bench against the Package 5 tree (GPU
mean / p95, one run): large −3.4% / −1.8%, large-zoom −1.7% / −1.1%,
large-icons −0.1% / +0.9%.
A worker trace of that click (60 clicks) puts about 3 ms in the worker, from
`pointerdown` to the posted click (readback 2.65 ms of it), and about 12 ms in
the main thread holding the posted message: every click event arrived
within 0.8 ms after the next main-thread animation frame. That wait is the
main thread's frame cadence, not engine work, so the path is unchanged.

## 0070 — Look lists follow each flag; flagged edges have one draw path

The selected and focused lists (nodes and edges) are updated from the bits
each flag call changes: an index is appended when its bit goes on, stale
entries stay (the look shader checks the bit again), and the list is
filtered only when stale entries outnumber live ones. A flag call no longer
scans every node or edge, and the selection is read from the selected list
in first-selection order, with no sorted copy. 1,000 `nodes.flag` calls of one
index at 1M nodes: 0.2–2.8 ms in all, against 1.41–1.46 s for the removed
scans (the deleted loop reproduced in Node). Selected and focused edges are
drawn only by the look pass: the recolour in `edge_geometry` and its frame
fields are gone (Frame 136 -> 120 B). `FRAME_FLAG_EDGE_LOOKS` now means "the
look pass is loaded"; until then flagged edges stay in the main pass in
their normal look, so none disappears while the pass compiles. The edge
segment and distance code is shared by the draw, pick and hover shaders.
Bench (AMD Radeon 890M, GPU mean / p95, mean of 2 runs, before -> after
R4): large 3.82 / 8.05 -> 3.94 / 8.12 ms (one run +0.4%, one +6.0%, not
attributed), large-zoom 6.28 / 8.58 -> 6.28 / 8.61 ms, large-icons
3.81 / 7.90 -> 3.76 / 7.78 ms.

## 0069 — Labels own the label text

`Labels` is the only owner of node and edge label text, the compact remap
included; the store copies and the engine's duplicate setters are gone, and
one `textAt` writes or blanks text by index. No speed effect (message
handlers only). LabelCorrectness at 1M with edge labels: 8 of 8 views, 0
overlaps; set, add, update, remove and compact keep the right widths.

## 0068 — Scattered writes keep a bitset and an index list

A channel's scattered writes keep 1 bit per slot plus a list of the indices
written (`IndexUploads`), instead of 4 B per slot per channel (about 120 MB
per edge channel at 30M edges). The values are read from the CPU mirror at
flush, so the latest write wins and there is no order rule between index and
range jobs; dirty ranges upload straight from the mirror. Edge state is a
channel like the others. A drag writes positions without allocating per
frame. A restyle during a drag, or of every edge, runs the full edge bounds
pass instead of the restyle list, and hidden edges no longer widen chunk
bounds. Bench (AMD Radeon 890M, GPU mean / p95, before -> after): large
3.62 / 7.61 -> 3.70 / 7.60 ms, large-zoom 5.92 / 8.16 -> 5.97 / 8.16 ms,
large-icons 3.70 / 7.60 -> 3.70 / 7.43 ms. Drag at 1M, GPU / worker CPU mean:
1 node 2.81 / 0.16 ms, 100 nodes 2.88 / 0.14 ms, 10,000 nodes 3.90 / 0.17 ms.

## 0067 — Edge colour word 0 means the style colour

A per-edge colour word of `0` draws with `style.edge.color`; the draw and the
edge pick select on the word they already load. This replaces the tint mask
and the rewrite of every tinted edge on a tint change: a tint change now
costs one uniform write. New colour slots and the edges without colours in
a first colour write get 0. Hosts hide edges with `Flag.hidden`, not with
transparent black. The store also keeps a live count of directed edges, so
the arrow variants turn off when the last directed edge goes. Bench (AMD
Radeon 890M, GPU mean / p95, before -> after): large 3.67 / 7.78 ->
3.62 / 7.61 ms, large-zoom 6.04 / 8.38 -> 5.92 / 8.16 ms, large-icons
3.66 / 7.55 -> 3.70 / 7.60 ms.

## 0066 — Icons are added, replaced and removed by id; only changed layers are built

`icons.add` takes ids from a main-thread `Slots` (freed ids first, capped at
`caps.maxIcons`), `icons.replace` swaps one shape, `icons.remove` frees ids.
`icons.define` still replaces the whole set. The atlas keeps each icon's
parsed curves; an add or replace parses and packs only the new icons, runs
the distance-field compute on that small set and copies its layers into the
texture array at their ids (the array doubles when an id passes its layer
count). The curve buffer the draw reads is repacked from the kept curves.
Remove rewrites the icon word of the nodes that use a removed id to
`NO_ICON` once, in the message handler (one pass over the node style words),
and fills the removed layers with a far distance, so nothing is added per
frame. Call to resolve, 1M nodes, 64 bench icons (one run, median of 7):
define 64 27.7 ms, define 65 26.0 ms, add 1 on top of 64 4.8 ms, replace 1
3.5 ms. Bench after (GPU mean / p95, before = Batch 8): large 3.93 / 7.99 ->
3.80 / 7.97 ms, large-zoom 6.17 / 8.41 -> 6.05 / 8.31 ms, large-icons
3.74 / 7.74 -> 3.72 / 7.59 ms.

## 0065 — Built-in selection: click, box and lasso in the worker

`input.select` takes `"auto"`, `"manual"` or `false` (default `"auto"`), with
flat `selectShape` (`"box"`, `"lasso"`) and `selectKey` (`"shift"`, `"alt"`,
`"ctrl"`, `"meta"`, or `null` to always draw on empty space). The worker
decides the gesture: a press on a node drags (when drag is on); a press on
empty space with the key held draws the shape; otherwise it pans; a press
that does not move is a click. While the key is held the pan waits for the
pick, like a node drag. Touch presses carry a `MOD.TOUCH` bit and never start
a shape. In `"auto"` click, shift-click, empty click and shape results set
or clear `STATE_SELECTED` through `flagNodes`, and the selection is read from
the selected look list (0070); `select` fires with the selection after the
change, in first-selection order. `"manual"` only reports the clicked node or
the nodes inside.
The key that starts a shape does not also mean "add" (`shapeAdds`): with
`selectKey: "shift"` a plain shape replaces and ctrl or meta adds; with any
other key or `null`, shift adds.

The shape is drawn by `SelectionShapePass`, hooked at the end of the label
draw: a bounding-box quad with an even-odd fill test and one quad per edge
for the stroke. It is created on the first shape and draws only while the
gesture runs, so it adds nothing per frame otherwise. On release the worker
runs `query.inside` (0064) on the polygon. Bench after (GPU mean / p95, before
= 0063): large 3.71 / 8.12 -> 3.80 / 8.07 ms, large-zoom 6.07 / 8.39 ->
6.09 / 8.39 ms, large-icons 3.71 / 7.77 -> 3.74 / 7.76 ms.

## 0064 — query.inside is one compute pass with an atomic append

`query.inside(rect | polygon)` (CSS px, at most 1,024 points) runs one compute
pass over every node slot in engine order: skip `STATE_HIDDEN` (removed nodes
and the reserve slots carry it), `worldToScreen`, bounding-box reject, then
even-odd point in polygon. Each workgroup counts its hits with a workgroup
atomic and reserves its range with one global `atomicAdd`, then writes the
user index (`order[i]`). The count is read back first, then only `count`
words, so a small selection in 10M nodes does not copy 40 MB. The pass runs
only on request, after the frame submit or on an idle tick, so it reads the
same positions and camera as the last drawn frame. `query.at` is a job in
the pick queue (0071). Timing, one run, 10 calls request to resolve
(mean / p95): 1M nodes box 5.78 / 7.34 ms (287k hits), lasso 5.56 / 5.96 ms;
10M nodes box 14.54 / 37.89 ms (the first call grows the buffer), lasso
12.94 / 31.28 ms. The GPU result is the reference for `query.inside`: the
drawn fill uses the same f32 test. Against an f64 CPU oracle it matches
exactly on 1M; on 10M the lasso misses 2 of 2.55M nodes, 1.15e-5 and
1.21e-5 px from an edge. A failed readback rejects with a `GraphError`.

## 0063 — Drag moves every selected node by one delta

`input.drag` takes `"auto"`, `"manual"` or `false`, default `"auto"`. A press
on a node flagged selected drags every selected node (taken from the look list
the worker keeps for the outlines); a press on any other node drags only it.
`dragStart` carries the dragged set once, then `drag` and `dragEnd` carry one
world delta since the start, so a large selection costs the same message as
one node. In `"auto"` the worker writes `start + delta` for every dragged node
through the index scatter upload (`writePositionsAt`, no allocation per frame).
`"manual"` only reports, for a host that runs its own simulation. With a
position stream the engine writes the dragged nodes again after each stream
commit.

The dragged nodes carry `STATE_DRAGGING`. The CPU has no engine order, so the
move lists are built on the GPU from that mark, once per drag: `chunk_touch`
lists the node chunks holding a dragged node (the cull move list grew from one
chunk to one word per chunk, and `chunk_bounds_list` now runs on
`MOVE_GROUPS` workgroups), and `edge_touch` lists the edge chunks with a dragged
endpoint. `edge_touch` sets the per-chunk mark that `edge_restyle` uses, so a
chunk is listed once when a drag start and a restyle land on the same frame.
The mark also puts the dragged nodes in the foreground bucket. Both passes drop
their move state after the frame that carries the last move of the drag, so a
later restyle starts a fresh list.

Drag on the Benchmark story (1M nodes at 20x fit zoom), 2 s of CDP mouse moves,
the selection scattered over the graph, GPU / worker CPU mean / p95 per frame:
1 node 2.84 / 3.04 ms, 0.11 / 0.33 ms; 100 nodes 2.90 / 3.15 ms, 0.09 / 0.22 ms;
10,000 nodes 4.06 / 4.29 ms, 0.12 / 0.21 ms (3.35 ms GPU with the same
selection and the camera moving, no drag). `"manual"` leaves the nodes in
place and renders no frame for the move. Bench after the change, GPU mean / p95
(before in brackets): large 3.71 / 8.12 ms (3.90 / 7.99), large-zoom 6.07 /
8.39 ms (6.09 / 8.50), large-icons 3.71 / 7.77 ms (3.71 / 7.88).
`packages/bench/results/api-rework-batch7-after.json`.

## 0062 — Pan, zoom and rotate take auto, manual or off

`input.pan`, `input.zoom` and `input.rotate` each take `"auto"`, `"manual"` or
`false`. Defaults: pan and zoom `"auto"`, rotate `false`. `Controls` works out
the pan, wheel, pinch and twist deltas as before and adds them to one
accumulator per gesture. It moves the camera only in `"auto"`. The tick flushes
the accumulators right after the input drain: at most one `start` or `move` per
gesture per frame, then an `end`. It posts only while the main thread says a
listener exists, and a flush with nothing to send allocates nothing. A wheel
zoom ends 150 ms after the last notch, on a timer armed only while a `zoom`
listener exists. The twist angle rides in the free `dy` of the `PINCH` record,
so the ring layout is unchanged. With `zoom: false` the main thread does not
prevent the wheel and pushes no record, so the page scrolls and the worker
does not wake. Only user input in `"auto"` cancels a camera animation.

Checked with CDP input on the Benchmark story (1M nodes): with pan `"manual"` a
30-step drag sends start … end with dx summing to 150 px and leaves the camera
unchanged. With zoom `"manual"`, five notches send a factor of 2.117 and the zoom
does not change. With rotate `"auto"`, a 0.5 rad twist turns the camera 0.505
rad. With rotate `false`, a twist does not turn it.

Bench after the change, GPU mean / p95 (before in brackets): large 3.90 / 7.99 ms
(3.87 / 7.98), large-zoom 6.09 / 8.50 ms (6.38 / 8.77), large-icons 3.71 /
7.88 ms (3.82 / 7.94). Worker CPU on large-zoom 0.66 ms (0.73 before).
`packages/bench/results/api-rework-batch6-after.json`.

## 0061 — Picking follows input.pick and style.hover, not listeners

In 0.2 the hover pick and highlight ran only while a `nodeHover` or `edgeHover`
listener existed. Now they follow `input.pick` (default nodes and edges on,
groups off) and `style.hover`, so the highlight draws with no listener at all.
The worker posts `hover`, `click`, `doubleClick` and `contextMenu` only while
the main thread says a listener exists. One `listen` message carries every
worker event with a listener and replaces the old `pick` message. A press is
tracked, and picked, only when a `click` listener exists, node drag is on or
selection is on. A
double click (the DOM `dblclick`, sent as input record 7) and a context menu
(the DOM `contextmenu`, sent as input record 8) are picked only while their
listener exists. A context menu record cancels the press in progress, with no
click and no drag. The hover pick runs only while picking is on and
`style.hover` is not false or a `hover` listener exists; when that changes at
runtime, closing clears the hover and opening picks again at the pointer. Each builds a `Hit` with both the node and the edge picked, the world point,
the canvas point in CSS px, the button that changed (now in the high half of the
record's `buttons` word) and the modifiers. `group` is always `null` in 0.3. The
hover pick still waits for the camera to settle, so picking costs nothing while
the camera moves. From the spec: 3.96–4.37 ms GPU per hover redraw with a still
camera, and edge picking keeps 4 B per edge. The Benchmark and Scale stories
turn edge picking off.

Checked with CDP mouse events on the Benchmark story (1M nodes at fit, still
camera, 120 moves at 60/s): with no listener, 94 frames drawn for hover
changes. With a `hover` listener, 87 hover events and 87 frames. Click, double
click and right press on a hovered node each report that node, with the right
button and modifiers. The context menu is prevented while a `contextMenu`
listener exists.

Bench after the change: see 0062 (one run for both).

## 0060 — Camera moves animate in the worker; limits clamp inside Camera2D

`camera.set`, `fit` and `rotate` share one path in the engine. The engine
applies the move at once, so limits clamp the target. With a duration it saves
that target, restores the old view and starts a `CameraAnimation`. The tick
steps the animation next to the zoom glide, on `performance.now()`, since `dt`
after an idle sleep means nothing. Zoom moves in log space. User input that
moves the camera cancels the animation. `rotate` pins the pivot's world point
to its screen point on every step, so the pivot stays still during the turn.
`set` turns to a new rotation the short way; `rotate` turns by exactly the
angle given. The rotation is wrapped into (−π, π] once a move lands and after a
gesture turn. `fit` keeps the rotation and fits the rotated bounding box. `limits` clamp zoom
and keep the centre inside `bounds` in `setView`, `panByScreen`, `zoomAt` and
fit. The engine keeps them in CSS px and converts again when the pixel ratio
changes. The benchmark computes its fit zoom without the user limits, so runs
stay comparable. The `view` event is posted after `publishState` on frames with
`CAMERA | RESIZE`, only while the main thread says a listener exists, so no
listener means no extra work. `toWorld` and `toScreen` run on the main thread
from the published view, with no message.

End bench (AMD Radeon 890M, 3 rounds, GPU mean / p95): large-zoom base `0d03e4e` -> final 6.25 / 8.52 -> 6.24 / 8.57 ms (−0.2% /
+0.6%), rework `c64fb4e` -> final 6.33 / 8.83 -> 6.24 / 8.57 ms (−1.5% /
−2.9%); the other four cases move at most 0.09 ms GPU mean in both.

## 0059 — Arrowheads compile when an edge is directed; engine tuning moves to debug.tune

The `directedEdges` option is gone. The store keeps a live count of the
directed edges that are not removed: `edges.set`, `updateAll` with styles and
`compact` recount it, and `add`, `update` and removal adjust it per edge
(0067). While it is above 0 the engine builds the `EDGE_ARROWS=1` variants of edge cull, edge geometry,
edge pick and edge hover, keeps drawing without arrows until all of them are
ready, and switches them in one go, so the vertex count the cull writes always
matches the geometry pipeline. Undirected graphs never build them.
`lodTargetPx`, `edgeMaxOverdraw`, `edgeMinLengthPx`, the edge debug mode and
`pickRate` leave `Graph.create` for `debug.tune`. They stay pipeline override
constants: a tune builds the variants for the new values (transform cull, edge
cull, edge geometry, pick, hover), cached by value, and swaps them together
the same way, so the frame loop does no extra work. `packEdgeStyle` packs the
style word.

Bench (AMD Radeon 890M, GPU mean / p95, before -> after, two after runs):
large 3.83 / 7.82 -> 3.47 / 7.43 and 3.90 / 7.97 ms, large-zoom 6.07 / 8.53 ->
6.06 / 8.34 and 6.00 / 8.30 ms, large-icons 3.74 / 7.72 -> 3.69 / 7.59 and
3.70 / 7.61 ms. Within noise.

## 0058 — Selected and focused outlines are instanced over the flagged list; dimmed is an alpha factor

`style.hover`, `style.selected`, `style.focused` and `style.dimmed` are runtime
looks. The hover pass still draws the one hovered node and edge; it now also
draws selected and focused nodes as instanced outline rings, one draw per look,
over a GPU list of user indices mapped through `rank`. The worker keeps the
list up to date from the bits each flag call changes (0070); the vertex
shader skips entries whose bit is gone, so remove and add need no rebuild. The
ring pipeline has no icon bindings, so it stays within the 10 storage buffers
per stage. Selected and focused edges get the same treatment: an instanced
draw per look over a worker-kept list of user edge indices, mapped through
`edgeRank` (graph 8 + edgeRank + list = 10 storage buffers), run only while
the list is non-empty. It ignores thinning, the minimum length and the chunk
bound, so a flagged edge shows at any zoom. Once the look pass is loaded,
`FRAME_FLAG_EDGE_LOOKS` makes `edge_geometry` skip flagged edges, so they are
drawn only by the look pass (0070). The edge list follows the same flag
updates as the node list. Dimmed nodes get the alpha factor in the cull scatter (the
instance has no node index, and once per node beats once per vertex), gated
by `FRAME_FLAG_DIMMED`, set only while the exact dimmed count is non-zero;
edges with a dimmed end use the same flag. `style.hover: false` stops the
highlight, not picking.

Bench (AMD Radeon 890M, GPU mean / p95, before -> after, Tasks 7 and 8 together):
large 3.81 / 8.28 -> 3.83 / 7.82 ms, large-zoom 6.32 / 8.72 -> 6.07 / 8.53 ms,
large-icons 3.76 / 7.76 -> 3.74 / 7.72 ms. Flag call on `large` (zoomed in),
main-thread call / call to next rendered frame: 10,000 selected 2.3 / 17.9 ms,
100,000 dimmed 2.0 / 19.2 ms (one run each). After the edge look draw (nothing
flagged): large 3.66 / 7.46 ms, large-zoom 6.01 / 8.10 ms, large-icons
3.72 / 7.54 ms.

## 0057 — Style changes at runtime; edge width and icon threshold are CSS px

`graph.style.set(partial)` changes background, node scale, edge colour and
width, label size, font, colour and padding, and icon scale and threshold
without recreating the engine. The worker merges the partial into the
resolved style. A background alpha below 1 reconfigures the canvas to
premultiplied alpha (every blend is already premultiplied); label size, font
and padding reuse the pixel-ratio path (atlas rebuild, widths remeasured);
label colour is a `LabelParams` field read by the label fragment shader. Edge
width is stored in CSS px and multiplied by `frame.pixelRatio` where it is
read, so the chunk width bound written by edge bounds stays valid across
resizes. Icon scale and threshold moved from pipeline constants to the frame
uniform: one uniform read, no pipeline rebuild, no cost when unused.

Bench (AMD Radeon 890M, GPU mean / p95, before -> after, Tasks 7 and 8 together):
large 3.81 / 8.28 -> 3.83 / 7.82 ms, large-zoom 6.32 / 8.72 -> 6.07 / 8.53 ms,
large-icons 3.76 / 7.76 -> 3.74 / 7.72 ms. All within 5%.

## 0056 — Zoom is CSS px per world unit at the API

`CameraView.zoom` is now CSS px per world unit, matching every other public
size (labels, padding, pick radii). The engine keeps `Camera2D.zoom` in device
px: `Engine.setView` multiplies an incoming CSS zoom by `pixelRatio`, the
API's `camera.get()` divides the published device-px zoom back down, and
`Engine.resize` rescales `camera.zoom` on a pixel-ratio change so the CSS
zoom a caller already set stays put. No speed impact: the conversion is one
multiply or divide per `camera.set`/`camera.get` call, not per frame or per
node. End bench (AMD Radeon 890M, 3 rounds, the runner at pixel ratio 1 where
the conversion is a no-op), GPU mean, base `0d03e4e` -> final: large 4.07 ->
3.98 ms (−2.1%), large-zoom 6.25 -> 6.24 ms (−0.2%), large-icons 3.76 -> 3.84
ms (+2.1%), mesh 2.43 -> 2.37 ms (−2.6%), hierarchy 3.01 -> 3.01 ms (+0.0%).

## 0055 — Nodes and edges live in stable slots; removal scans the edge list

Nodes live in stable slots like edges (0054): `nodes.remove` frees slots,
`nodes.add` reuses them, `nodes.compact` returns the old → new table. A removed
node is `STATE_HIDDEN` plus a CPU-only removed bit (bit 7), so `flag("all")`
and the public hidden count skip it; its edges are hidden through the edge state
word, not through the hidden-end check. The worker finds them with one scan of
the user-order `edgeIdx` mirror against a reused node mark and answers
`edgesRemoved`; the main thread does not reuse edge slots while a removal is in
flight, and maps late answers through any `edges.compact` (dropped after an
`edges.set` or `nodes.set`). Scan cost from the spec: about 40 ms per call at
30M edges. An adjacency table was rejected: 280 MB and a 1.26 s build at 30M
edges, paid by every graph to speed up a call most graphs never make.

The engine keeps a reserve of hidden empty node slots past `nodes.slots`
(`GraphOptions.nodeReserve`, 100 by default, see 0073). An add that fits in
them is an index scatter (no rebuild); the add that takes the last one grows
the buffers to `slots + reserve` (one rebuild: identity order, node sort,
edge reload and re-sort). `nodes.set` and `nodes.compact` also leave the
reserve. The reserve is internal: `nodes.slots`, `stats().nodeCount`,
streams, `updateAll` and labels never include it, and CPU bounds skip hidden
nodes. With the default, the add that takes the last of the 100 slots grows
(the 100th and 200th adds of a run).
Growth timing (`add-nodes.js` on `large`, 1M nodes and 1,511,683 edges, 250
single adds, AMD Radeon 890M, mean; before = base `0d03e4e` `setNodes` with
`count + 1` on every add, edges kept; after = `nodes.add`): an add inside the
reserve GPU 19.22 -> 8.33 ms (−10.89 ms, −56.7%), worker CPU 7.764 -> 0.524 ms
(−7.240 ms, −93.3%), wall to the next frame 19.39 -> 1.34 ms (−18.06 ms,
−93.1%); a growth add wall 19.39 -> 61.77 ms (+42.38 ms, +218.5%), GPU
19.22 -> 30.07 ms (+10.85 ms, +56.5%), CPU 7.764 -> 16.72 ms (+8.96 ms,
+115.4%; node sort 8.42 ms, edge sort 13.46 ms). Summed wall over the 250
adds: 4,848 -> 455 ms (−4,394 ms, −90.6%). The GPU lines also compare two
engines: an idle frame 0 at this view is about 3.4 ms on base, 8.09 ms on final.

## 0054 — Edges get slots and a state word; the partial path is b

Edges live in stable slots (`Slots` on the main thread: freed slots are reused,
`compact` returns an old → new table). The state of an edge (hidden, selected,
dimmed, focused) is 4 bits in the top of the sorted GPU `edgeIdx.x`
(`EDGE_STATE_SHIFT` 28, `EDGE_END_MASK`), so nodes are capped at 2^28, the cap
the 2 GiB `nodePos` binding already sets; `nodes.set` checks it.
`BINDING_CONTRACT_VERSION` is 4: every reader of the sorted ends masks them. A
separate `edgeState` binding does not fit: this GPU has 10 storage buffers per
stage and edge geometry (8 graph + 2 pass) and the edge pick test (7 + 2 + 1)
already use all 10. The CPU keeps a user-order state mirror (bit 4 = removed),
OR-ed into the ends on upload and carried by `edge_keys` through the sort. A
removed edge is hidden and not counted in `edges.count` or `stats().edgeCount`.

Add, set, compact and updates with ends re-sort. A full re-sort (four passes,
three runs) is 8.7 / 9.1 / 9.2 ms on `large` (1.5M edges, frame 13.7 to 14.2 ms)
and 87.5 / 89.7 / 89.7 ms on `xlarge` (15.1M edges, frame 109 to 117 ms), so
re-sorting on every flag, remove or style change (a) misses the frame by about 7×
on `xlarge`. Instead (b): `edgeRank[user] = sorted` (4 B per edge) is built on
the first partial write, from the kept edge order (one `invert` dispatch) or by
one re-sort when no order is kept, and rebuilt after each later re-sort. Styles
and colours scatter through it with the node scatter kernel; state bits go
through `scatter_edge_state` (read-modify-write of `edgeIdx.x`). A graph never
edited partially allocates nothing new. Style and colour scatters by index mark
`Dirty.STYLE`, not `Dirty.EDGES`: rebuilding every edge chunk bound and the edge
label tree costs 17 + 7 ms on `xlarge`. Instead `edge_restyle` lists the chunks
of the restyled edges (`edgeRank[user] >> EDGE_CHUNK_SHIFT`, deduped by a mark
word in the chunk record) into the drag move list, and `edge_bounds_list`
recomputes only those (during a drag, or when every edge is restyled, the full
bounds pass runs instead, 0068), so the width bound follows both widening and narrowing
(on `large`, 1,000 edges widened 1 -> 8 px: visible edges 183,614 -> 128,811,
equal to a full rebuild, and back to 183,614 when narrowed). `updateAll` with
styles marks `Dirty.EDGES` and rebuilds every bound.

Frame GPU time of the frame that applies one call, three runs (steady frame
3.5 ms on `large`, 7.4 ms on `xlarge`; worker CPU ≤ 1.2 ms in every case):

| edges | flag large | style large | remove large | flag xlarge | style xlarge | remove xlarge |
|---|---|---|---|---|---|---|
| 1 | 3.9–4.2 | 3.5–3.9 | 3.7–3.8 | 8.6–10.3 | 6.5–8.3 | 8.9–11.4 |
| 1,000 | 3.5–4.1 | 3.6–4.2 | 3.6–4.2 | 9.6–10.3 | 8.2–8.6 | 9.3–9.5 |
| 100,000 | 3.8–4.2 | 3.3–3.8 | 3.7–4.2 | 9.7–10.0 | 7.6–8.0 | 10.0 |

One-time costs: the first partial write with the edge order kept builds
`edgeRank` in 0.9 ms (`large`) / 6.8 ms (`xlarge`) of upload, frame 5.0 / 15.0 ms;
without a kept order it re-sorts once (frame 16.2 / 131 ms); the first per-edge
style on uniform edges allocates the channel and re-sorts (16.2 / 150 ms).
The hidden-bit test in the three edge shaders costs nothing measurable with no
edge flagged (A/B on this machine, GPU mean, pre-task shaders vs these: large
3.71 / 3.88 vs 3.92 / 3.95 / 3.96 / 3.95 ms, large-zoom 6.51 / 6.56 vs 6.54 /
6.50 / 6.54 / 6.48 ms, large-icons 3.77 / 3.93 vs 3.90 / 3.93 / 3.90 / 3.76 ms),
so it is not gated.

## 0053 — Node flags write the state word; edges with a hidden end are dropped per edge

`nodes.flag(target, flags, on)` sets or clears `Flag` bits (the engine
`STATE_*` bits, plus the new `STATE_FOCUSED`, which is foreground like hover)
in the `nodeState` word. An index list goes through the node index upload of
0052; `"all"` marks the whole channel as one range. It marks `Dirty.STATE`, so
cull, edge cull, labels and pick run again. `edge_geometry`, `pick_edges` and
the edge label emit drop an edge when either engine end is hidden, like a
zero-length edge. The edge pick select step keeps a group 1 layout without
`nodeState`, so it stays at 10 storage buffers (0008).

The end reads are gated on `FRAME_FLAG_HIDDEN` in the frame uniform. The store
counts the nodes hidden through `nodes.flag` exactly (old bit against new bit
on every indexed state write, recounted from the mirror on `"all"` and on
compact, removed nodes never counted), and the flag is on only while that
count is above 0. Ungated, the two reads per edge
cost +4% to +5% GPU mean with nothing flagged (large 3.89 / 3.83 -> 4.29 /
3.83 / 4.10 ms, large-zoom 6.13 / 6.12 -> 6.50 / 6.33 / 6.33 ms, large-icons
3.75 / 3.72 -> 3.92 / 3.90 / 3.92 ms), in `render` and `label.edges`.

Checked on `large` (1M nodes): 1,000 nodes moved into an empty area, then
hidden: visible nodes 1,000 -> 0, shown labels 438 -> 0, node pick at a node
959513 -> none, edge pick hits 10/10 -> 0/10, and all back after unhiding; all
nodes hidden: shown edge labels 42 -> 0 at 128x fit zoom.

Gated, nothing flagged. AMD Radeon 890M, Edge headless, GPU mean / p95, two
runs before (the second with only the shader reads taken out) and three after:

| Case | before | after |
|---|---|---|
| large | 3.89 / 8.11, 3.83 / 8.01 ms | 3.79 / 7.92, 4.12 / 8.29, 3.71 / 7.95 ms |
| large-zoom | 6.13 / 8.37, 6.12 / 8.31 ms | 6.15 / 8.41, 5.88 / 8.18, 5.96 / 8.24 ms |
| large-icons | 3.75 / 7.57, 3.72 / 7.82 ms | 3.74 / 7.92, 3.72 / 7.76, 3.71 / 7.48 ms |

Within noise. The 4.12 ms `large` run drew 118,583 visible nodes on average
against about 95,000 in the others.

## 0052 — Scattered node updates take an index list

`nodes.update(indices, data)` replaces `updateNodes(start, data)`. Scattered
writes no longer go through `DirtyRanges`, which folds into one covering range
past 64 ranges and uploads most of the buffer. Each node channel keeps an index
list for the frame, deduped by a bitset (0068), and uploads one (index, slot)
pair and the packed value per node, through the existing `scatter_update`
kernel. Index and range jobs both read the mirror at flush time, so the latest
write wins in any order.

Measured on AMD Radeon 890M, Edge headless, 1M nodes, positions of n scattered
nodes written every frame (worker CPU mean / p95). Upload before is the mean
over all sampled frames; upload after is the bytes of a frame that carries the
update, 16 B per node (8 B of positions and 8 B of pair):

| n | worker CPU before | worker CPU after | upload before | upload after |
|---|---|---|---|---|
| 100 | 0.21 / 0.53 ms | 0.15 / 0.38 ms | 192 KB | 1.6 KB |
| 1,000 | 1.15 / 2.11 ms | 0.13 / 0.28 ms | 5,696 KB | 16 KB |
| 10,000 | 1.41 / 1.41 ms | 0.19 / 0.44 ms | 7,751 KB | 160 KB |

Bench `large`, `large-zoom` and `large-icons` stay within noise.

---

## 0051 — The hovered node keeps its size and colour and gets an outline

The hover used to redraw the node 1.25× larger in white, which hid its colour
and its icon and made it jump. It now redraws the node at its drawn size, with
its own colour and icon, still on top of its neighbours. It adds a ring outside
its shape, anti-aliased like the node edge.

`HoverStyle.nodeColor` and `nodeScale` are replaced by:
- `nodeOutlineColor`, default white;
- `nodeOutlineScale`, the ring width as a fraction of the drawn radius, default
  0.08;
- `nodeOutlineMinWidth` and `nodeOutlineMaxWidth`, which bound it, CSS px,
  defaults 3 and 12.

The ring grows with the node without taking over deep zooms. The hover is
still one quad for one node.

---

## 0050 — Node icons: an SDF when small, exact curves when large

**Input.** `defineIcons` takes `{ path, viewBox?, fillRule? }` (SVG path data)
or `{ svg }` (markup: paths, circles, ellipses, rects, polygons, transforms). It
resolves once the icons are ready. The worker turns each icon into quadratic
curves in a 0–1 box, sorted into Slug bands (Lengyel 2017).

**Fill rules.** An icon is even-odd when all its paths are. The shader then
folds the winding number mod 2. A mixed icon flips its even-odd paths' contours
and fills everything as nonzero.

**Distance field.** A compute pass builds a 64 px r16float field per icon, with
4 mip levels, from the same curves.
- It first marks which parts of each curve are real edges, so shapes that
  overlap leave no seams.
- Distances are exact within 4 texels.

**Per node.**
- `icons`: 16 bits in the style word, reserved for it.
- `iconColors`: a palette index in the high half of `nodeSize`, which held an
  unused ring width. That is binding contract 3.
- The palette itself is engine-internal (group 2), so a contract consumer can
  read the index but not resolve it.
- `iconScale` (0.6 of the radius) and `iconMinPx` (6 device px) are options.
- The unused `ENABLE_ICONS` override is gone.

**Drawing.** The icon is drawn inside the node's own fragment, so draw order and
z-index stay right.
- Below `iconMinPx`, the cull writes nothing and the vertex shader reads nothing.
- Up to 96 px, the fragment does one distance-field fetch.
- Above 96 px, it fetches the field and evaluates the curves only within one
  texel of an edge.

**Instance tail.** The icon word sits in a tail of the instance buffer, 4 B per
slot, only while icons are on. It is written as plain u32 so no two
invocations share a vector. No storage binding is added.
- If the tail would pass the GPU's binding limit, nodes are drawn without icons
  and an error is reported once.
- Every icon pipeline is built on first use.

**Standalone test first.** 243 real icons, AMD Radeon 890M.
- Below 96 px, Slug cost 3–4× the distance field: 30k icons at 16 px were +3.4
  ms against +1.1 ms.
- Slug was exact where the 64 px field showed flat facets at 1000 px.

**Engine.** Communities 1M with edges and labels, Edge headless, GPU mean / p95,
3 alternated runs.
- Icons off, previous build against this one:
  - large: 3.75–3.80 / 7.58–8.06 → 3.77–3.87 / 7.81–8.04 ms;
  - large-zoom: 6.17–6.39 / 8.65–8.87 → 6.21–6.35 / 8.60–8.72 ms;
  - `cull.scatter`, with the scalar stores: 0.084–0.088 → 0.086–0.089 ms.
- Icons on every node:
  - large-icons: 3.76–3.81 / 7.89–7.95 ms;
  - large-zoom-icons: 6.40–6.43 / 8.73–8.78 ms;
  - icon-zoom (to 2500×): 1.12–1.13 / 2.74–2.83 ms.

---

## 0049 — Streamed z-index is merged into the style words on the GPU

`streamNodes({ zIndex })` carries one byte per node in the shared slot. The
worker uploads the bytes as they are (1 MB at 1M nodes) and one kernel writes
each layer into the style word of its node in engine order; the store copy is
brought up to date only when a later `setNodes` needs it. Packing the bytes
into the style words in the worker first cost 1.8–2.1 ms of worker CPU a frame
at 1M. 1M communities, a new z-index every frame, AMD Radeon 890M, Edge 145
headless, three runs: worker CPU 0.21–0.24 ms streamed against 0.41–0.43 ms
through `setNodeZIndex` (whose packing also runs in the message handler,
outside the frame, and allocates 1 MB on the main thread each frame); GPU
5.55–5.68 ms against 4.97–5.08 ms, the merge's scattered reads. The galaxy's
position stream is unchanged: GPU 4.69–4.75 → 4.65–4.74 ms.

---

## 0048 — Z-index is a counting sort of the visible nodes by layer

Nodes take a z-index from 0 to 15 in the 4 layer bits the style word already
reserved. The cull packs the layer into bits 4–7 of the instance radius, next to
the shape. When any node has a layer, NODE_ORDER sorts the NORMAL bucket with a
16-bin counting sort sized by the visible count the cull left on the GPU: count
per block, one scan, then each instance is written straight into a second
buffer that the NORMAL draw reads. Blocks past the visible count exit at once.
It is stable, so equal layers keep the draw order of 0020. Picking puts the
layer above the draw position in its key. With no layer set nothing runs and
nothing is allocated. AMD Radeon 890M, Edge 145 headless, 1M communities, a
random layer on every node, median of 3. Fit (280k visible): order 0.24 ms,
GPU 2.95 → 4.19 ms. Zoomed (499 visible): order 0.05 ms, GPU 0.60 → 0.65 ms.
The draw itself costs ~1 ms more at fit in every variant tried: it comes from
the layer order, not the extra buffer. Rejected, same runs: the shared radix
sort over all nodes with a key pass and a gather (order 1.04 ms fit, 0.54 ms
zoomed, GPU 5.12 / 1.16 ms); the layer as a cull cell, which made the count
step write 16 × 64 far-apart cells per chunk even for hidden chunks (cull
0.38 → 1.88 ms fit, 0.08 → 1.07 ms zoomed); a depth buffer, as soft edges and
see-through nodes would cut holes in what is behind them. Bench large /
large-zoom without z-index, GPU mean 3.90 → 3.75 ms and 6.08 → 6.19 ms.

---

## 0047 — One node stream, and each node channel marks only what it changes

`setNodes` builds its dirty flags from a table, one row per channel: a new
count, positions, sizes or shapes rebuild the nodes; colours only mark the
style. Only a rebuild counts as new data, so colour updates no longer clear the
hover or throw away the pick in flight: sending colours every frame had stopped
hover entirely. `streamNodes({ positions, colors })` replaces
`streamNodePositions`: one triple-buffered shared slot (0042) holds the channels
asked for, so they arrive in the same frame, each through the same scatter
upload as before. A stream is taken only when none of its channels has a
pending partial update, so the two never share a staging buffer in one frame.
AMD Radeon 890M, Edge 145 headless, 8 s runs. Hover events with the pointer
moving over Ripples 100k, one run each: 0 before, 130 after. Galaxy 1M
positions, median of 3, worker CPU mean / p95 0.65 / 0.87 → 0.67 / 0.94 ms, GPU
5.11 → 5.11 ms. Ripples 1M colours, median of 3, frame mean / p95 22.02 / 30.23
ms (`setNodeColors` every frame) → 20.84 / 26.93 ms; that frame is bound by the
story's own simulation on the main thread.

---

## 0046 — Arrowheads shrink away on short edges

An arrowhead used to shrink to half the visible edge, so at fit every short
edge drew as a wedge. Now `arrowFitPx` scales the arrow from full size at 3x
its length down to nothing at 2x, in screen px, per edge. It grows smoothly
with zoom, and a hidden arrow gives back the narrow quad. Long edges keep
their arrows at any zoom. The same rule runs in the draw, the pick and the
hover. Communities 1M / 1.5M edges, directed, AMD Radeon 890M, Edge headless
on Linux, GPU mean / p95, 2 runs each: fit 6.92 / 7.88 → 6.02 / 6.61 ms,
zoomSweep 8.98 / 11.90 → 8.71 / 11.89 ms, standard 4.55 / 10.54 → 4.26 /
10.16 ms. Undirected is unchanged (fit 3.59 → 3.55 ms).

## 0045 — Node drag moves one node in the worker and rebuilds only the chunks it touches

`nodeDrag` (option and `setNodeDrag`) lets a left press drag a node.
`nodeClick` / `edgeClick` report a press released within 3 CSS px, and
`nodeDragStart` / `nodeDrag` / `nodeDragEnd` report the move as `{ index, x, y }`.

**Press.** A left press runs a pick at once, skipping the 50 ms settle and
`pickRate`. With drag on, the pan waits for it; a miss catches the pan up to
the pointer in one step. A hit starts the drag once the pointer passes the
3 px slop. The worker writes the node's position once per tick, keeping the
grab offset, so the node moves in the same frame as the pointer. A host that
pushes its own positions handles the dragged node itself.

**Bounds.** A drag frame marks `Dirty.MOVED`, not `POSITIONS`. `cull.bounds`
then rebuilds only the node's chunk (the pick now also returns the engine
index). `edge.bounds` rebuilds only the edge chunks holding the node's edges,
which `edge_touch` lists once when the drag starts, in a section at the end of
the edge state buffer (a separate buffer would pass the 10 storage buffers per
dispatch).

**Drag end.** No extra step. The list stays set after the drag, so a last move
that arrives with the release still rebuilds its chunks; only a drag marks
`MOVED`, and the next drag replaces the list. Before this, a node dropped in the
same frame as the release sat outside its chunk box and was culled once that box
left the screen (from zoom 3.4 at 100k). A re-sort at drag end was measured and
rejected: GPU 16 ms at 1M and 136 ms at 10M (node and edge sort), and when the
drag grows the bounds every Morton key changes, so the zoomed-out sample changes
everywhere. Skipping it leaves one stretched chunk until the next bulk position
load: at 1M, fit, a far drag draws 801 more nodes (+0.3%) with no visible
difference.

**Measurements.** AMD Radeon 890M, Edge 145, Linux, headless, a 3 s drag at
60 Hz, per frame:
- communities 10M, rebuilding everything: GPU 26.38 ms, interval p50 30.1 ms.
  `cull.bounds` 2.03 ms, `edge.bounds` 14.88 ms.
- communities 10M, chunks touched only: GPU 9.30 ms, interval p50 16.2 ms,
  against 9.20 ms for a pan. `cull.bounds` 0.023 ms, `edge.bounds` 0.030 ms;
  `edge_touch` costs 1.7 ms once at drag start.
- communities 1M: drag 3.64 ms, pan 3.59 ms.
- Drag off, bench `large`, alternated with `dev`, 2 runs each: frame 5.80 /
  5.87 → 5.87 / 6.13 ms, p95 12.03 / 11.46 → 11.08 / 11.89 ms. Within
  run-to-run spread.

## 0044 — The hover highlight is one extra draw, fed by the host's index

While a hover handler is set, the engine draws the hovered item again, in
`hoverStyle`:
- The hovered node goes on top of all nodes, at its drawn size ×
  `nodeScale` (default 1.25).
- The hovered edge goes after all edges and under the nodes, at ×
  `edgeWidth` (default 2), arrowhead included.
- Default colour is white. `hoverStyle: false` turns it off.

**Inputs.** The draw takes the host's index and maps it through `rank[]`, and
edge endpoints come from the CPU mirror. It follows moving nodes and survives a
re-sort. The pick returns the node's LOD scale, so the highlight matches the
node as drawn.
- Setting `STATE_HOVERED` was rejected: it flags the whole chunk as foreground,
  which draws all 1024 nodes unsampled and shows as a patch at fit.
- A hover change is one render-only frame, with no compute.
- Hover clears when the camera moves (nothing is picked then) and is picked
  again after it settles.

**Measurements.** GPU per render-only frame, mean, camera still.
- communities 1M: none 3.40 ms, node hovered 3.38, edge hovered 3.34; node
  draw 1.453 → 1.461 ms.
- communities 10M: 7.14 / 6.64 / 6.65; node draw 1.058 → 1.070.
- 30 hover changes gave exactly 30 frames.

**Bench, no handler set,** alternated with the previous commit, 2 runs each:
- GPU mean: large 4.28 / 4.06 against 4.16 / 4.26 ms; xlarge 11.20 / 11.35
  against 11.22 / 11.12 ms.
- The xlarge frame interval is 0.13–0.42 ms higher in both pairs, unexplained
  by GPU or CPU time.

## 0043 — Picking is a compute pass over the cull's chunks, not an ID buffer

`on("nodeHover")` and `on("edgeHover")` report the item under the pointer as the
host's own index, mapped through `order[]` / `edgeOrder[]` on the GPU. Each kind
runs only while it has a handler.

**Nodes.** One workgroup walks the cull's list of visible chunks and keeps those
whose box contains the pointer. An indirect dispatch then tests the candidates
with the cull's own `classify`, LOD prefix and labelled rule, the draw's alpha
and SDF, and the draw-order key.

**Edges.** The same shape over the edge cull's list and keep counts. Before any
endpoint gather, an 8 B line record per edge (packed normal + offset from the
chunk centre) rejects the edge. The record is written by `edge_bounds`, and only
while an edge handler is set.

**Scheduling.**
- Picks run in their own submission, before the frame.
- Only once the camera has not changed for 50 ms.
- At most `pickRate` per second (default 60), again whenever the data changes.
- An edge is hit within its drawn half-width plus `edgePickRadius` (default
  4 CSS px, as sigma v4's `edgePickingPadding`); a 1 px edge was impractical to
  hover. Nodes use `pickRadius` (default 0).

**Measurements.** Radeon 890M, Edge 145, 9 pointers at fit / x10 / x70.
- GPU per pick at communities 1M: nodes 8–16 µs, edges 6.5–21 µs.
- At 10M: nodes 11–34 µs, edges 8.6–28 µs.
- An ID-buffer render into a 1×1 target costs 60 µs – 3.2 ms per pick.
  - It must redo the vertex work of every drawn item.
- Scanning the drawn instances needs node ids from the cull: +1–19% on
  `cull.scatter` every frame.
- Without the line test, edges cost up to 193 µs at 10M x70: long-edge chunk
  boxes all contain the pointer.
- The 8 B record is as fast as 16 B (25 vs 33 µs, fuzzball 201 vs 318) at half
  the memory, with no miss in 1,800 checks against a full scan and the ID buffer.
- Latency from pointer event to handler: 4.3 ms p50, 6.2 ms p95. The readback
  floor is 2.5–3.5 ms; `mapSync` does not lower it.
  - Submitting behind a frame instead of before it adds 4–8 ms.
- With no handler set, bench `large` frame 5.10 / 5.14 → 5.04 / 4.77 ms, p95
  10.08 / 10.50 → 9.83 / 11.44. `xlarge` 12.32 / 12.39 → 12.78 / 12.57, p95
  19.41 / 19.56 → 20.27 / 19.53. Within run-to-run spread.

**Two bugs the many-pointer runs caught.**
1. The hit test must use the draw's alpha. Faint sub-pixel nodes were hit but
   put no pixel there.
2. The candidate list must be sized to the chunk count. Fuzzball puts 6,000
   chunks under the pointer.

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
the target's real boundary. Circle-only, communities 1M, AMD Radeon 890M,
Edge 145 headless: frame 5.16 -> 5.04 ms, p95 10.19 -> 9.88 ms; cull.count
0.054 -> 0.054 ms, cull.scatter 0.080 -> 0.086 ms. Mixed shapes not measured.

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
