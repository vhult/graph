#include "common/nodes.wgsl"
#include "common/labels.wgsl"

@group(2) @binding(0) var<storage, read> positions : array<vec2<f32>>;
@group(2) @binding(2) var<storage, read> sizes : array<u32>;
@group(2) @binding(3) var<storage, read> live : array<LiveLabel>;
@group(2) @binding(4) var<storage, read> text : array<u32>;
@group(2) @binding(5) var atlas : texture_2d<f32>;
@group(2) @binding(6) var<storage, read> ends : array<vec2<u32>>;

override HALO : bool = true;

const FILL : vec3<f32> = vec3<f32>(0.914, 0.929, 0.953);
const EDGE_FILL : vec3<f32> = vec3<f32>(0.725, 0.765, 0.816);
const HALO_COLOR : vec4<f32> = vec4<f32>(0.031, 0.039, 0.055, 0.85);

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) alpha : f32,
  @location(2) @interpolate(flat) edge : u32,
}

@vertex
fn vs(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VOut {
  var o : VOut;
  let e = live[ii / LABEL_GLYPHS];
  let g = ii % LABEL_GLYPHS;
  if (g >= (e.run & 0xFFu)) {
    o.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    o.uv = vec2<f32>(0.0);
    o.alpha = 0.0;
    o.edge = 0u;
    return o;
  }
  let width = f32(e.run >> 8u);
  let word = text[e.slot * LABEL_GLYPHS + g];
  let at = label.glyphTable + (word & 0xFFFFu) * 2u;
  let rect = vec2<u32>(text[at], text[at + 1u]);
  let pos = vec2<f32>(f32(rect.x & 0xFFFFu), f32(rect.x >> 16u));
  let size = vec2<f32>(f32(rect.y & 0xFFFFu), f32(rect.y >> 16u));
  let corner = vec2<f32>(f32(vi & 1u), f32(vi >> 1u));
  let local = vec2<f32>(f32(word >> 16u), 0.0) + corner * size;
  var sp : vec2<f32>;
  if ((e.index & LABEL_EDGE_BIT) != 0u) {
    let ij = ends[e.index & ~LABEL_EDGE_BIT];
    let a = worldToScreen(positions[ij.x]);
    let b = worldToScreen(positions[ij.y]);
    var dir = normalize(b - a + vec2<f32>(1e-6, 0.0));
    dir = select(dir, -dir, dir.x < 0.0);
    let q = local - vec2<f32>(width, label.textH) * 0.5;
    sp = (a + b) * 0.5 + dir * q.x + vec2<f32>(-dir.y, dir.x) * q.y;
    o.edge = 1u;
  } else {
    let p = worldToScreen(positions[e.index]);
    let r = max(sizeRadiusPx(unpack2x16float(sizes[e.index]).x), NODE_MIN_DRAW_RADIUS_PX);
    sp = floor(vec2<f32>(p.x - width * 0.5, p.y + r + label.gap) + 0.5) + local;
    o.edge = 0u;
  }
  o.pos = vec4<f32>(screenToClip(sp), 0.0, 1.0);
  o.uv = (pos + corner * size) / vec2<f32>(textureDimensions(atlas));
  let a = clamp((frame.time - e.start) / label.fadeS, 0.0, 1.0);
  o.alpha = select(a, 1.0 - a, e.fadeOut != 0u);
  return o;
}

@fragment
fn fs(in : VOut) -> @location(0) vec4<f32> {
  let t = textureSampleLevel(atlas, samp_linear, in.uv, 0.0);
  if (HALO) {
    let a = HALO_COLOR.a * t.g * in.alpha;
    return vec4<f32>(HALO_COLOR.rgb * a, a);
  }
  let a = t.r * in.alpha;
  return vec4<f32>(select(FILL, EDGE_FILL, in.edge != 0u) * a, a);
}
