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
  let r = nodeRadiusPx(i) * hover.lodScale;
  let rDraw = max(r, NODE_MIN_DRAW_RADIUS_PX);
  let corner = stripCorner(vi);
  let outline = min(max(hover.nodeOutlineScale * rDraw, hover.nodeOutlineMinPx), hover.nodeOutlineMaxPx);
  let ext = rDraw + outline + NODE_AA_PAD_PX;
  var o : NodeOut;
  o.pos = vec4<f32>(screenToClip(worldToScreen(nodePos[i]) + corner * ext), 0.0, 1.0);
  o.uv = corner * (ext / rDraw);
  o.radiusPx = rDraw;
  o.shape = select(0u, nodeShape(i), (hover.flags & HOVER_FLAG_SHAPES) != 0u);
  var c = unpack4x8unorm(nodeColor[i]);
  c.a *= min(1.0, (r * r) / (rDraw * rDraw));
  o.color = c;
  o.outlinePx = outline;
  return o;
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
