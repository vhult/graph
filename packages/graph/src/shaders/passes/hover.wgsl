#include "common/nodes.wgsl"
#include "common/edges.wgsl"
#include "common/sdf.wgsl"
#include "common/icons.wgsl"

@group(2) @binding(0) var<uniform> hover : HoverParams;
@group(2) @binding(1) var<storage, read> hoverRank : array<u32>;

override EDGE_ARROWS : bool = false;

struct NodeOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) radiusPx : f32,
  @location(2) @interpolate(flat) shape : u32,
}

struct IconNodeOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) radiusPx : f32,
  @location(2) @interpolate(flat) shape : u32,
  @location(3) @interpolate(flat) icon : u32,
  @location(4) @interpolate(flat) tint : vec4<f32>,
  @location(5) @interpolate(flat) iconSize : vec2<f32>,
}

struct EdgeOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) halfLen : f32,
  @location(2) @interpolate(flat) halfWidth : f32,
  @location(3) @interpolate(flat) arrowLen : f32,
}

fn stripCorner(vi : u32) -> vec2<f32> {
  return vec2<f32>(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
}

fn premultiplied(color : u32, a : f32) -> vec4<f32> {
  let c = unpack4x8unorm(color);
  let alpha = c.a * a;
  return vec4<f32>(c.rgb * alpha, alpha);
}

fn hoverNode(vi : u32, i : u32) -> NodeOut {
  let rDraw = max(nodeRadiusPx(i) * hover.lodScale, NODE_MIN_DRAW_RADIUS_PX) * hover.nodeGrow;
  let corner = stripCorner(vi);
  let ext = rDraw + NODE_AA_PAD_PX;
  var o : NodeOut;
  o.pos = vec4<f32>(screenToClip(worldToScreen(nodePos[i]) + corner * ext), 0.0, 1.0);
  o.uv = corner * (ext / rDraw);
  o.radiusPx = rDraw;
  o.shape = select(0u, nodeShape(i), (hover.flags & HOVER_FLAG_SHAPES) != 0u);
  return o;
}

@vertex
fn node_vs(@builtin(vertex_index) vi : u32) -> NodeOut {
  return hoverNode(vi, hoverRank[hover.node]);
}

@fragment
fn node_fs(in : NodeOut) -> @location(0) vec4<f32> {
  let a = clamp(0.5 - sdShape(in.uv, in.shape) * in.radiusPx, 0.0, 1.0);
  if (a < 0.002) {
    discard;
  }
  return premultiplied(hover.nodeColor, a);
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
  let a = iconAttrs(nodeIconWord(i, iconData[0]), v.radiusPx);
  o.icon = a.icon;
  o.tint = a.tint;
  o.iconSize = a.size;
  return o;
}

@fragment
fn node_fs_icons(in : IconNodeOut) -> @location(0) vec4<f32> {
  let a = clamp(0.5 - sdShape(in.uv, in.shape) * in.radiusPx, 0.0, 1.0);
  if (a < 0.002) {
    discard;
  }
  let c = unpack4x8unorm(hover.nodeColor);
  let rgb = applyIcon(c.rgb, in.uv, in.icon, in.tint, in.iconSize);
  let alpha = c.a * a;
  return vec4<f32>(rgb * alpha, alpha);
}

@vertex
fn edge_vs(@builtin(vertex_index) vi : u32) -> EdgeOut {
  let ia = hoverRank[hover.edgeA];
  let ib = hoverRank[hover.edgeB];
  let a = worldToScreen(nodePos[ia]);
  var b = worldToScreen(nodePos[ib]);
  let full = b - a;
  let fullLen = max(length(full), 1e-4);
  let w = edgeWidthPx(hover.edgeStyle);
  let halfWidth = max(w * hover.edgeWidth, EDGE_MIN_DRAW_WIDTH_PX) * 0.5;
  var arrowLen = 0.0;
  if (EDGE_ARROWS && (hover.edgeStyle & EDGE_FLAG_DIRECTED) != 0u) {
    arrowLen = arrowLenPx(w * hover.edgeWidth);
    let dirAB = full / fullLen;
    var reach = nodeRadiusPx(ib);
    if ((hover.flags & HOVER_FLAG_SHAPES) != 0u) {
      reach *= shapeReach(dirAB, nodeShape(ib));
    }
    b = b - dirAB * min(reach, fullLen * 0.5);
  }
  let d = b - a;
  let len = max(length(d), 1e-4);
  arrowLen = arrowFitPx(arrowLen, len);
  let dir = d / len;
  let nor = vec2<f32>(-dir.y, dir.x);
  let halfLen = len * 0.5;
  let corner = edgeStripCorner(vi, halfLen, halfWidth, arrowLen);
  var o : EdgeOut;
  o.pos = vec4<f32>(screenToClip((a + b) * 0.5 + dir * corner.x + nor * corner.y), 0.0, 1.0);
  o.uv = corner;
  o.halfLen = halfLen;
  o.halfWidth = halfWidth;
  o.arrowLen = arrowLen;
  return o;
}

@fragment
fn edge_fs(in : EdgeOut) -> @location(0) vec4<f32> {
  var d = sdSegment(in.uv, in.halfLen, in.halfWidth);
  if (EDGE_ARROWS && in.arrowLen > 0.0) {
    d = min(d, sdArrowhead(in.uv, in.halfLen, in.arrowLen, in.arrowLen * ARROW_HALF_MUL / ARROW_LEN_MUL));
  }
  let a = clamp(0.5 - d, 0.0, 1.0);
  if (a < 0.002) {
    discard;
  }
  return premultiplied(hover.edgeColor, a);
}
