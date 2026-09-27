# Changelog

## v0.3.0 - 2026-09-27

### Breaking
- the whole 0.2 public api is replaced by namespaces (nodes, edges, icons, camera, style, input, query, canvas, stats, debug); see the README for the 0.3 names, options and events (c64fb4e)
- api: outline the hovered node instead of growing it; HoverStyle.nodeColor and nodeScale are replaced by nodeOutlineColor, nodeOutlineScale, nodeOutlineMinWidth and nodeOutlineMaxWidth (98126fe)
- api: add node icons and a single partial updateNodes; updateNodePositions and updateNodeColor are removed, use updateNodes; binding contract 3 puts the icon colour index in the high half of nodeSize; the ENABLE_ICONS override is removed (3b65639)
- api: streamNodePositions() and the NodePositionStream type are removed; use streamNodes({ positions: true }), which returns a NodeStream (a4d86f2)

### Features
- clean up the 0.3 engine and add the nodeReserve option (0f3e9b5)
- api: stream z-index with the other node channels (32f7fd1)
- api: add a z-index to draw nodes in layers (2bf10f5)

### Fixes
- shaders: stop the edge line inside the arrowhead (9a471b4)
- engine: mark only what each node channel changes (6b73480)

## v0.2.0 - 2026-09-24

### Features
- GPU label placement for nodes and edges (5685de4)
- built-in debug overlay with per-frame recording (f84f627)
- api: add peak gpu bytes to graph stats (9c03354)
- passes: add square and hexagon node shapes (cd89e2d)
- api: add a transparent option for the canvas (079772c)
- api: add node and edge hover events (3da2920)
- api: draw the hovered node and edge in a hover style (89d0634)
- api: add node drag and node and edge click events (5b83b75)
- shaders: shrink arrowheads away on short edges (1217fef)

### Performance
- parallel bucket bases in cull scan_blocks, scan.blocks at 1M nodes 0.50 -> 0.03 ms (3ca17b8)
- bridge: stream node positions through shared memory, worker 0.78 -> 0.74 ms, p95 1.76 -> 0.94 ms (af03470)
- api: lower the default edge thinning to 1.5, fit frame 9.77 -> 7.02 ms, p95 10.14 -> 7.60 ms, zoomSweep frame 14.06 -> 11.31 ms, p95 17.60 -> 14.33 ms (f10b056)
- shaders: draw the arrowhead as its own small quad, fit frame 4.99 -> 4.05 ms, p95 5.50 -> 4.51 ms, zoomSweep frame 8.29 -> 6.85 ms, p95 11.29 -> 9.14 ms (380e4ca)
- passes: decide node lod per node, not per chunk, fit frame 10.48 -> 8.96 ms, p95 11.19 -> 9.49 ms, zoomSweep frame 6.33 -> 6.03 ms, p95 11.50 -> 10.81 ms (8e9fc22)

### Fixes
- api: destroy debug overlay before marking graph destroyed (6fc48a3)
- passes: replace chunk scramble multiply with a position table (f7b8410)
- camera: fit the drawn node footprint, not only centres (96c7665)
- labels: count label slots in a group instead of screen area (cf7e0a8)

### Other
- shaders: move segment and arrowhead sdfs to sdf.wgsl (bd8624c)
