// NODE_GEOMETRY: one instanced quad per visible node, no vertex buffers.
// Reads the NodeInstance records compacted by TRANSFORM_CULL — one 16-byte load
// per vertex, no re-projection (pitfall #1). One pipeline per bucket (BUCKET override).
#include "common/nodes.wgsl"
#include "common/sdf.wgsl"
#include "common/icons.wgsl"

@group(2) @binding(0) var<storage, read> scratch : array<u32>;
@group(2) @binding(1) var<storage, read> instances : array<vec4<u32>>;

override BUCKET : u32 = 0u;
override NODE_SHAPES : bool = false;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  // [-1,1] at the node radius
  @location(0) uv : vec2<f32>,
  // straight alpha, already scaled by sub-pixel coverage
  @location(1) @interpolate(flat) color : vec4<f32>,
  // device px per uv unit, for analytic AA
  @location(2) @interpolate(flat) radiusPx : f32,
  @location(3) @interpolate(flat) shape : u32,
}

struct IconVOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) color : vec4<f32>,
  @location(2) @interpolate(flat) radiusPx : f32,
  @location(3) @interpolate(flat) shape : u32,
  @location(4) @interpolate(flat) icon : u32,
  @location(5) @interpolate(flat) tint : vec4<f32>,
  @location(6) @interpolate(flat) iconSize : vec2<f32>,
}

fn nodeVertex(vi : u32, n : NodeInstance) -> VOut {
  let rDraw = max(n.radiusPx, NODE_MIN_DRAW_RADIUS_PX);
  let coverage = min(1.0, (n.radiusPx * n.radiusPx) / (rDraw * rDraw));

  // Triangle strip corners: (-1,-1) (1,-1) (-1,1) (1,1)
  let corner = vec2<f32>(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
  let ext = rDraw + NODE_AA_PAD_PX;

  var c = unpack4x8unorm(n.color);
  c.a = c.a * coverage;

  var o : VOut;
  o.pos = vec4<f32>(screenToClip(n.screenPos + corner * ext), 0.0, 1.0);
  o.uv = corner * (ext / rDraw);
  o.color = c;
  o.radiusPx = rDraw;
  o.shape = select(0u, instanceShape(n.radiusPx), NODE_SHAPES);
  return o;
}

fn nodeAlpha(uv : vec2<f32>, alpha : f32, radiusPx : f32, shape : u32) -> f32 {
  var sd = sdCircle(uv);
  if (NODE_SHAPES) {
    sd = sdShape(uv, shape);
  }
  // Analytic 1 px coverage ramp across the silhouette.
  return alpha * clamp(0.5 - sd * radiusPx, 0.0, 1.0);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VOut {
  return nodeVertex(vi, unpackInstance(instances[scratch[SCRATCH_BUCKET_BASE + BUCKET] + ii]));
}

@fragment
fn fs(in : VOut) -> @location(0) vec4<f32> {
  let a = nodeAlpha(in.uv, in.color.a, in.radiusPx, in.shape);
  if (a < 0.002) {
    discard;
  }
  return vec4<f32>(in.color.rgb * a, a); // premultiplied
}

@vertex
fn vs_icons(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> IconVOut {
  let slot = scratch[SCRATCH_BUCKET_BASE + BUCKET] + ii;
  let n = unpackInstance(instances[slot]);
  let v = nodeVertex(vi, n);
  var o : IconVOut;
  o.pos = v.pos;
  o.uv = v.uv;
  o.color = v.color;
  o.radiusPx = v.radiusPx;
  o.shape = v.shape;
  var a = noIcon();
  if (hasIconRoom(n.radiusPx)) {
    a = iconAttrs(instances[scratch[SCRATCH_ICON_BASE] + (slot >> 2u)][slot & 3u], n.radiusPx);
  }
  o.icon = a.icon;
  o.tint = a.tint;
  o.iconSize = a.size;
  return o;
}

@fragment
fn fs_icons(in : IconVOut) -> @location(0) vec4<f32> {
  let a = nodeAlpha(in.uv, in.color.a, in.radiusPx, in.shape);
  if (a < 0.002) {
    discard;
  }
  let rgb = applyIcon(in.color.rgb, in.uv, in.icon, in.tint, in.iconSize);
  return vec4<f32>(rgb * a, a);
}
