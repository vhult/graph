// EDGE_GEOMETRY: one instanced quad per edge in the draw list EDGE_CULL
// wrote, oriented along the segment, with an analytic distance field for the
// anti-aliased line, round caps and the arrowhead.
//
// A thinned chunk draws a prefix of its (shuffled) edges; each one carries the
// opacity of the edges it stands for, and the last one fades in with the
// prefix, so thinning neither dims an area nor pops while zooming. Edges too
// short to see collapse to a point and rasterize nothing.
#include "common/edge_segment.wgsl"
#include "common/edge_curve.wgsl"

@group(2) @binding(0) var<storage, read> edgeScratch : array<u32>;
@group(2) @binding(1) var<storage, read> edgeList : array<u32>;

// Arrowheads need a wider quad, so every edge pays for them in fill: compiled
// out unless the graph is directed. When every edge shares a width or a colour,
// the per-edge reads are compiled out too and the default edge touches only
// its endpoints.
override EDGE_ARROWS : bool = false;
override EDGE_PER_EDGE_STYLE : bool = false;
override EDGE_PER_EDGE_COLOR : bool = false;
override EDGE_PATTERNS : bool = false;
override NODE_SHAPES : bool = false;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  /** Segment-local px: x along the centreline (0 at the midpoint), y across. */
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) halfLen : f32,
  @location(2) @interpolate(flat) halfWidth : f32,
  /** Straight alpha, already scaled by coverage, length fade and thinning. Interpolated = gradient. */
  @location(3) color : vec4<f32>,
  /** Arrowhead length in px; 0 when this edge has none. */
  @location(4) @interpolate(flat) arrowLen : f32,
  @location(5) @interpolate(flat) line : vec4<f32>,
}

/** All four corners on one point outside clip space: zero area, no fragments. */
fn culled() -> VOut {
  var o : VOut;
  o.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
  return o;
}

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VOut {
  let e = edgeList[ii];
  let raw = edgeIdx[e];
  let bits = raw.x >> EDGE_STATE_SHIFT;
  let flagged = select(0u, EDGE_STATE_SELECTED | EDGE_STATE_FOCUSED, (frame.flags & FRAME_FLAG_EDGE_LOOKS) != 0u);
  if ((bits & (EDGE_STATE_HIDDEN | flagged)) != 0u) {
    return culled();
  }
  let ij = edgeEnds(raw);
  let ends = edgeEndState(ij);
  if ((ends & STATE_HIDDEN) != 0u) {
    return culled();
  }
  let a = worldToScreen(nodePos[ij.x]);
  let b = worldToScreen(nodePos[ij.y]);
  let fade = edgeLengthFade(length(b - a));
  if (fade <= 0.0 && EDGE_DEBUG != 1u) {
    return culled();
  }

  var style = 0u;
  if (EDGE_PER_EDGE_STYLE) {
    style = edgeStyle[e];
  }
  let w = edgeWidthPx(style);
  let wDraw = max(w, EDGE_MIN_DRAW_WIDTH_PX);
  // Equal ink: a half-width edge keeps half the alpha rather than disappearing.
  let coverage = min(1.0, w / wDraw);
  let halfWidth = wDraw * 0.5;

  let s = edgeSegment(a, b, ij.y, w, EDGE_ARROWS && (style & EDGE_FLAG_DIRECTED) != 0u, NODE_SHAPES);
  let corner = edgeStripCorner(vi, s.halfLen, halfWidth, s.arrowLen);
  let sp = s.mid + s.dir * corner.x + vec2<f32>(-s.dir.y, s.dir.x) * corner.y;

  // Gradient: the corner's end selects the endpoint colour, the rasterizer
  // interpolates between them along the segment.
  var c = unpack4x8unorm(frame.globalEdgeColor);
  if (EDGE_PER_EDGE_COLOR) {
    let word = edgeColor[e * 2u + select(0u, 1u, corner.x > 0.0)];
    c = unpack4x8unorm(select(word, frame.globalEdgeColor, word == 0u));
  }
  if ((bits & EDGE_STATE_DIMMED) != 0u || (ends & STATE_DIMMED) != 0u) {
    c.a *= frame.dimmedAlpha;
  }

  // Thinning: the same keep count EDGE_CULL computed for this chunk.
  let chunk = e >> EDGE_CHUNK_SHIFT;
  let rec = edgeChunkAt(chunk, numEdgeChunks());
  let n = edgeChunkLen(chunk);
  let width = chunkWidthPx(bitcast<f32>(edgeScratch[rec + 5u]));
  let keep = edgeKeep(n, bitcast<f32>(edgeScratch[rec + 6u]), width);
  let fadeIn = clamp(keep - f32(e & (EDGE_CHUNK_SIZE - 1u)), 0.0, 1.0);

  var o : VOut;
  o.pos = vec4<f32>(screenToClip(sp), 0.0, 1.0);
  o.uv = corner;
  o.halfLen = s.halfLen;
  o.halfWidth = halfWidth;
  o.color = vec4<f32>(c.rgb, edgeStandInAlpha(c.a * coverage * fade, f32(n) / keep) * fadeIn);
  if (EDGE_DEBUG != 0u) {
    o.color = vec4<f32>(debugColor(fade, keep / f32(n), chunk), 0.9 * fadeIn);
  }
  o.arrowLen = s.arrowLen;
  if (EDGE_PATTERNS) {
    o.line = edgeLine(style, s.halfLen, halfWidth, f32(n) / keep);
  }
  return o;
}

/** The `debug.tune` edgeMode: what the cull decided, as colour. */
fn debugColor(fade : f32, kept : f32, chunk : u32) -> vec3<f32> {
  switch (EDGE_DEBUG) {
    case 1u: {
      // Length: red = too short (hidden outside this view), orange = fading in, green = full.
      if (fade <= 0.0) {
        return vec3<f32>(1.0, 0.15, 0.15);
      }
      return select(vec3<f32>(0.2, 0.9, 0.3), vec3<f32>(1.0, 0.6, 0.1), fade < 1.0);
    }
    case 2u: {
      // Thinning, on a log scale: blue = all of the chunk drawn, red = 1 in 1024.
      let t = clamp(1.0 + log2(kept) / 10.0, 0.0, 1.0);
      return mix(vec3<f32>(1.0, 0.15, 0.15), vec3<f32>(0.3, 0.6, 1.0), t);
    }
    default: {
      // Chunk: a stable hue per chunk of 1024 edges.
      let h = f32((chunk * 2654435761u) >> 22u) / 1024.0;
      return 0.5 + 0.5 * cos(6.2831853 * (h + vec3<f32>(0.0, 0.33, 0.67)));
    }
  }
}

@fragment
fn fs(in : VOut) -> @location(0) vec4<f32> {
  var cover : f32;
  if (EDGE_PATTERNS) {
    cover = edgeCoverage(in.uv, in.halfLen, in.halfWidth, in.arrowLen, in.line);
  } else {
    // Analytic 1 px coverage ramp across the silhouette.
    cover = clamp(0.5 - edgeDist(in.uv, in.halfLen, in.halfWidth, in.arrowLen), 0.0, 1.0);
  }
  let a = in.color.a * cover;
  if (a < 0.002) {
    discard;
  }
  return vec4<f32>(in.color.rgb * a, a); // premultiplied
}

@vertex
fn vs_curve(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> CurveOut {
  var o : CurveOut;
  o.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
  let e = edgeList[edgeScratch[EDGE_SCRATCH_DRAW_ARGS + 1u] + ii];
  var style = 0u;
  if (EDGE_PER_EDGE_STYLE) {
    style = edgeStyle[e];
  }
  let raw = edgeIdx[e];
  let bits = raw.x >> EDGE_STATE_SHIFT;
  let flagged = select(0u, EDGE_STATE_SELECTED | EDGE_STATE_FOCUSED, (frame.flags & FRAME_FLAG_EDGE_LOOKS) != 0u);
  if ((bits & (EDGE_STATE_HIDDEN | flagged)) != 0u) {
    return o;
  }
  let ij = edgeEnds(raw);
  let ends = edgeEndState(ij);
  if ((ends & STATE_HIDDEN) != 0u) {
    return o;
  }
  let a = worldToScreen(nodePos[ij.x]);
  let b = worldToScreen(nodePos[ij.y]);
  let fade = edgeLengthFade(length(b - a));
  if (fade <= 0.0 && EDGE_DEBUG != 1u) {
    return o;
  }

  let w = edgeWidthPx(style);
  let wDraw = max(w, EDGE_MIN_DRAW_WIDTH_PX);
  let coverage = min(1.0, w / wDraw);
  let halfWidth = wDraw * 0.5;

  let cv = curveOf(a, b, ij.y, w, halfWidth, edgeCurveBend(style), EDGE_ARROWS && (style & EDGE_FLAG_DIRECTED) != 0u, NODE_SHAPES);
  let v = curveVertex(vi, cv, halfWidth, EDGE_PATTERNS);
  if (v.pos.z > 1.0) {
    return o;
  }

  var c = unpack4x8unorm(frame.globalEdgeColor);
  if (EDGE_PER_EDGE_COLOR) {
    let wa = edgeColor[e * 2u];
    let wb = edgeColor[e * 2u + 1u];
    c = mix(unpack4x8unorm(select(wa, frame.globalEdgeColor, wa == 0u)), unpack4x8unorm(select(wb, frame.globalEdgeColor, wb == 0u)), v.t);
  }
  if ((bits & EDGE_STATE_DIMMED) != 0u || (ends & STATE_DIMMED) != 0u) {
    c.a *= frame.dimmedAlpha;
  }

  let chunk = e >> EDGE_CHUNK_SHIFT;
  let rec = edgeChunkAt(chunk, numEdgeChunks());
  let n = edgeChunkLen(chunk);
  let width = chunkWidthPx(bitcast<f32>(edgeScratch[rec + 5u]));
  let keep = edgeKeep(n, bitcast<f32>(edgeScratch[rec + 6u]), width);
  let fadeIn = clamp(keep - f32(e & (EDGE_CHUNK_SIZE - 1u)), 0.0, 1.0);

  var color = vec4<f32>(c.rgb, edgeStandInAlpha(c.a * coverage * fade, f32(n) / keep) * fadeIn);
  if (EDGE_DEBUG != 0u) {
    color = vec4<f32>(debugColor(fade, keep / f32(n), chunk), 0.9 * fadeIn);
  }
  o = curveOutOf(v, color);
  if (EDGE_PATTERNS) {
    o.line = edgeLine(style, v.geo.w * 0.5, halfWidth, f32(n) / keep);
  }
  return o;
}

@fragment
fn fs_curve(in : CurveOut) -> @location(0) vec4<f32> {
  let a = in.color.a * curveCoverage(in.pos.xy, in.q, in.shape, in.geo, in.tip, in.arrow, in.line, in.part, EDGE_PATTERNS);
  if (a < 0.002) {
    discard;
  }
  return vec4<f32>(in.color.rgb * a, a);
}
