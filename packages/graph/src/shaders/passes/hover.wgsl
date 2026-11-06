#include "common/edge_segment.wgsl"
#include "common/edge_curve.wgsl"
#include "common/icons.wgsl"

@group(2) @binding(0) var<uniform> hover : HoverParams;
@group(2) @binding(1) var<storage, read> hoverRank : array<u32>;
@group(2) @binding(2) var<uniform> look : LookParams;
@group(2) @binding(3) var<storage, read> lookList : array<u32>;
@group(2) @binding(4) var<storage, read> lookEdgeRank : array<u32>;
@group(2) @binding(5) var<storage, read> lookEdges : array<u32>;

override EDGE_ARROWS : bool = false;

struct NodeOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) radiusPx : f32,
  @location(2) @interpolate(flat) shape : u32,
  @location(3) @interpolate(flat) color : vec4<f32>,
  @location(4) @interpolate(flat) outlinePx : f32,
}

struct IconNodeOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) radiusPx : f32,
  @location(2) @interpolate(flat) shape : u32,
  @location(3) @interpolate(flat) color : vec4<f32>,
  @location(4) @interpolate(flat) outlinePx : f32,
  @location(5) @interpolate(flat) icon : u32,
  @location(6) @interpolate(flat) tint : vec4<f32>,
  @location(7) @interpolate(flat) iconSize : vec2<f32>,
}

struct LookOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) radiusPx : f32,
  @location(2) @interpolate(flat) shape : u32,
  @location(3) @interpolate(flat) outlinePx : f32,
}

struct EdgeOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) halfLen : f32,
  @location(2) @interpolate(flat) halfWidth : f32,
  @location(3) @interpolate(flat) arrowLen : f32,
}

struct EdgeLookOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) halfLen : f32,
  @location(2) @interpolate(flat) halfWidth : f32,
  @location(3) @interpolate(flat) arrowLen : f32,
  @location(4) @interpolate(flat) color : vec4<f32>,
}

fn stripCorner(vi : u32) -> vec2<f32> {
  return vec2<f32>(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
}

fn premultiplied(color : u32, a : f32) -> vec4<f32> {
  let c = unpack4x8unorm(color);
  let alpha = c.a * a;
  return vec4<f32>(c.rgb * alpha, alpha);
}

fn nodeQuad(vi : u32, i : u32, rDraw : f32, outline : f32) -> LookOut {
  let corner = stripCorner(vi);
  let ext = rDraw + outline + NODE_AA_PAD_PX;
  var o : LookOut;
  o.pos = vec4<f32>(screenToClip(worldToScreen(nodePos[i]) + corner * ext), 0.0, 1.0);
  o.uv = corner * (ext / rDraw);
  o.radiusPx = rDraw;
  o.outlinePx = outline;
  return o;
}

fn hoverNode(vi : u32, i : u32) -> NodeOut {
  let r = nodeRadiusPx(i) * hover.lodScale;
  let rDraw = max(r, NODE_MIN_DRAW_RADIUS_PX);
  let q = nodeQuad(vi, i, rDraw, min(max(hover.nodeOutlineScale * rDraw, hover.nodeOutlineMinPx), hover.nodeOutlineMaxPx));
  var c = unpack4x8unorm(nodeColor[i]);
  c.a *= min(1.0, (r * r) / (rDraw * rDraw));
  return NodeOut(q.pos, q.uv, rDraw, select(0u, nodeShape(i), (hover.flags & HOVER_FLAG_SHAPES) != 0u), c, q.outlinePx);
}

fn outlined(uv : vec2<f32>, radiusPx : f32, shape : u32, outlinePx : f32, rgb : vec3<f32>, alpha : f32) -> vec4<f32> {
  let d = sdShape(uv, shape) * radiusPx;
  let cover = clamp(0.5 - d, 0.0, 1.0);
  let outline = unpack4x8unorm(hover.nodeOutlineColor);
  let ring = clamp(0.5 - (d - outlinePx), 0.0, 1.0) * (1.0 - cover) * outline.a;
  let fill = cover * alpha;
  return vec4<f32>(rgb * fill + outline.rgb * ring, fill + ring);
}

@vertex
fn node_vs(@builtin(vertex_index) vi : u32) -> NodeOut {
  return hoverNode(vi, hoverRank[hover.node]);
}

@fragment
fn node_fs(in : NodeOut) -> @location(0) vec4<f32> {
  let c = outlined(in.uv, in.radiusPx, in.shape, in.outlinePx, in.color.rgb, in.color.a);
  if (c.a < 0.002) {
    discard;
  }
  return c;
}

@vertex
fn node_vs_icons(@builtin(vertex_index) vi : u32) -> IconNodeOut {
  let i = hoverRank[hover.node];
  let v = hoverNode(vi, i);
  var o : IconNodeOut;
  o.pos = v.pos;
  o.uv = v.uv;
  o.radiusPx = v.radiusPx;
  o.shape = v.shape;
  o.color = v.color;
  o.outlinePx = v.outlinePx;
  let a = iconAttrs(nodeIconWord(i, iconData[0]), v.radiusPx);
  o.icon = a.icon;
  o.tint = a.tint;
  o.iconSize = a.size;
  return o;
}

@fragment
fn node_fs_icons(in : IconNodeOut) -> @location(0) vec4<f32> {
  let rgb = applyIcon(in.color.rgb, in.uv, in.icon, in.tint, in.iconSize);
  let c = outlined(in.uv, in.radiusPx, in.shape, in.outlinePx, rgb, in.color.a);
  if (c.a < 0.002) {
    discard;
  }
  return c;
}

@vertex
fn look_vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> LookOut {
  var o : LookOut;
  let i = hoverRank[lookList[ii]];
  let state = nodeState[i];
  if ((state & look.bit) == 0u || (state & STATE_HIDDEN) != 0u) {
    o.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    return o;
  }
  let rDraw = max(nodeRadiusPx(i), NODE_MIN_DRAW_RADIUS_PX);
  o = nodeQuad(vi, i, rDraw, min(max(look.outlineScale * rDraw, look.outlineMinPx), look.outlineMaxPx));
  o.shape = select(0u, nodeShape(i), (look.flags & HOVER_FLAG_SHAPES) != 0u);
  return o;
}

@fragment
fn look_fs(in : LookOut) -> @location(0) vec4<f32> {
  let d = sdShape(in.uv, in.shape) * in.radiusPx;
  let outline = unpack4x8unorm(look.outlineColor);
  let ring = clamp(0.5 - (d - in.outlinePx), 0.0, 1.0) * clamp(0.5 + d, 0.0, 1.0) * outline.a;
  if (ring < 0.002) {
    discard;
  }
  return vec4<f32>(outline.rgb * ring, ring);
}

@vertex
fn edge_vs(@builtin(vertex_index) vi : u32) -> EdgeOut {
  let ib = hoverRank[hover.edgeB];
  let a = worldToScreen(nodePos[hoverRank[hover.edgeA]]);
  let w = edgeWidthPx(hover.edgeStyle) * hover.edgeWidth;
  let halfWidth = max(w, EDGE_MIN_DRAW_WIDTH_PX) * 0.5;
  let s = edgeSegment(a, worldToScreen(nodePos[ib]), ib, w, EDGE_ARROWS && (hover.edgeStyle & EDGE_FLAG_DIRECTED) != 0u, (hover.flags & HOVER_FLAG_SHAPES) != 0u);
  let corner = edgeStripCorner(vi, s.halfLen, halfWidth, s.arrowLen);
  return EdgeOut(vec4<f32>(screenToClip(s.mid + s.dir * corner.x + vec2<f32>(-s.dir.y, s.dir.x) * corner.y), 0.0, 1.0), corner, s.halfLen, halfWidth, s.arrowLen);
}

@fragment
fn edge_fs(in : EdgeOut) -> @location(0) vec4<f32> {
  let a = clamp(0.5 - edgeDist(in.uv, in.halfLen, in.halfWidth, in.arrowLen), 0.0, 1.0);
  if (a < 0.002) {
    discard;
  }
  return premultiplied(hover.edgeColor, a);
}

@vertex
fn edge_look_vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> EdgeLookOut {
  var o : EdgeLookOut;
  o.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
  let u = lookEdges[ii];
  if (u >= frame.edgeCount) {
    return o;
  }
  let e = lookEdgeRank[u];
  let raw = edgeIdx[e];
  let bits = raw.x >> EDGE_STATE_SHIFT;
  if ((bits & look.edgeMask) != look.edgeBit) {
    return o;
  }
  let ij = edgeEnds(raw);
  let ends = edgeEndState(ij);
  if ((ends & STATE_HIDDEN) != 0u) {
    return o;
  }
  var style = 0u;
  if ((look.flags & HOVER_FLAG_EDGE_STYLES) != 0u) {
    style = edgeStyle[e];
  }
  let w = edgeWidthPx(style) * look.edgeWidth;
  let wDraw = max(w, EDGE_MIN_DRAW_WIDTH_PX);
  let halfWidth = wDraw * 0.5;
  let s = edgeSegment(worldToScreen(nodePos[ij.x]), worldToScreen(nodePos[ij.y]), ij.y, w, EDGE_ARROWS && (style & EDGE_FLAG_DIRECTED) != 0u, (look.flags & HOVER_FLAG_SHAPES) != 0u);
  let corner = edgeStripCorner(vi, s.halfLen, halfWidth, s.arrowLen);
  var c = unpack4x8unorm(look.edgeColor);
  c.a *= min(1.0, w / wDraw);
  if ((bits & EDGE_STATE_DIMMED) != 0u || (ends & STATE_DIMMED) != 0u) {
    c.a *= frame.dimmedAlpha;
  }
  return EdgeLookOut(vec4<f32>(screenToClip(s.mid + s.dir * corner.x + vec2<f32>(-s.dir.y, s.dir.x) * corner.y), 0.0, 1.0), corner, s.halfLen, halfWidth, s.arrowLen, c);
}

@fragment
fn edge_look_fs(in : EdgeLookOut) -> @location(0) vec4<f32> {
  let a = in.color.a * clamp(0.5 - edgeDist(in.uv, in.halfLen, in.halfWidth, in.arrowLen), 0.0, 1.0);
  if (a < 0.002) {
    discard;
  }
  return vec4<f32>(in.color.rgb * a, a);
}

@vertex
fn edge_curve_vs(@builtin(vertex_index) vi : u32) -> CurveOut {
  let ib = hoverRank[hover.edgeB];
  let a = worldToScreen(nodePos[hoverRank[hover.edgeA]]);
  let base = edgeWidthPx(hover.edgeStyle);
  let w = base * hover.edgeWidth;
  let halfWidth = max(w, EDGE_MIN_DRAW_WIDTH_PX) * 0.5;
  let cv = curveOf(a, worldToScreen(nodePos[ib]), ib, w, max(base, EDGE_MIN_DRAW_WIDTH_PX) * 0.5, edgeCurveBend(hover.edgeStyle), EDGE_ARROWS && (hover.edgeStyle & EDGE_FLAG_DIRECTED) != 0u, (hover.flags & HOVER_FLAG_SHAPES) != 0u);
  return curveOutOf(curveVertex(vi, cv, halfWidth, false), vec4<f32>(0.0));
}

@fragment
fn edge_curve_fs(in : CurveOut) -> @location(0) vec4<f32> {
  let a = curveCoverage(in.pos.xy, in.q, in.shape, in.geo, in.tip, in.arrow, in.line, in.part, false);
  if (a < 0.002) {
    discard;
  }
  return premultiplied(hover.edgeColor, a);
}

@vertex
fn edge_look_curve_vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> CurveOut {
  var o : CurveOut;
  o.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
  let u = lookEdges[ii];
  if (u >= frame.edgeCount) {
    return o;
  }
  let e = lookEdgeRank[u];
  let raw = edgeIdx[e];
  let bits = raw.x >> EDGE_STATE_SHIFT;
  if ((bits & look.edgeMask) != look.edgeBit) {
    return o;
  }
  let ij = edgeEnds(raw);
  let ends = edgeEndState(ij);
  if ((ends & STATE_HIDDEN) != 0u) {
    return o;
  }
  var style = 0u;
  if ((look.flags & HOVER_FLAG_EDGE_STYLES) != 0u) {
    style = edgeStyle[e];
  }
  let base = edgeWidthPx(style);
  let w = base * look.edgeWidth;
  let wDraw = max(w, EDGE_MIN_DRAW_WIDTH_PX);
  let cv = curveOf(worldToScreen(nodePos[ij.x]), worldToScreen(nodePos[ij.y]), ij.y, w, max(base, EDGE_MIN_DRAW_WIDTH_PX) * 0.5, edgeCurveBend(style), EDGE_ARROWS && (style & EDGE_FLAG_DIRECTED) != 0u, (look.flags & HOVER_FLAG_SHAPES) != 0u);
  var c = unpack4x8unorm(look.edgeColor);
  c.a *= min(1.0, w / wDraw);
  if ((bits & EDGE_STATE_DIMMED) != 0u || (ends & STATE_DIMMED) != 0u) {
    c.a *= frame.dimmedAlpha;
  }
  return curveOutOf(curveVertex(vi, cv, wDraw * 0.5, false), c);
}

@fragment
fn edge_look_curve_fs(in : CurveOut) -> @location(0) vec4<f32> {
  let a = in.color.a * curveCoverage(in.pos.xy, in.q, in.shape, in.geo, in.tip, in.arrow, in.line, in.part, false);
  if (a < 0.002) {
    discard;
  }
  return vec4<f32>(in.color.rgb * a, a);
}
