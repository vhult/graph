#include "common/camera.wgsl"

struct ShapeParams {
  lo : vec2<f32>,
  hi : vec2<f32>,
  fill : vec4<f32>,
  stroke : vec4<f32>,
  points : u32,
  strokePx : f32,
  pad0 : u32,
  pad1 : u32,
}

@group(2) @binding(0) var<uniform> shape : ShapeParams;
@group(2) @binding(1) var<storage, read> shapePoints : array<vec2<f32>>;

fn insideShape(p : vec2<f32>) -> bool {
  let n = shape.points;
  var inside = false;
  var j = n - 1u;
  for (var i = 0u; i < n; i++) {
    let a = shapePoints[i];
    let b = shapePoints[j];
    if ((a.y > p.y) != (b.y > p.y)) {
      let x = (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x;
      if (p.x < x) {
        inside = !inside;
      }
    }
    j = i;
  }
  return inside;
}

@vertex
fn vs_fill(@builtin(vertex_index) v : u32) -> @builtin(position) vec4<f32> {
  let c = vec2<f32>(f32(v & 1u), f32(v >> 1u));
  return vec4<f32>(screenToClip(mix(shape.lo, shape.hi, c)), 0.0, 1.0);
}

@fragment
fn fs_fill(@builtin(position) pos : vec4<f32>) -> @location(0) vec4<f32> {
  if (!insideShape(pos.xy)) {
    discard;
  }
  return shape.fill;
}

@vertex
fn vs_stroke(@builtin(vertex_index) v : u32, @builtin(instance_index) i : u32) -> @builtin(position) vec4<f32> {
  let a = shapePoints[i];
  let b = shapePoints[(i + 1u) % shape.points];
  let d = b - a;
  let len = length(d);
  let t = select(vec2<f32>(1.0, 0.0), d / len, len > 0.0);
  let h = shape.strokePx * 0.5;
  let along = select(-h, len + h, (v & 1u) == 1u);
  let side = select(-h, h, (v & 2u) == 2u);
  let p = a + t * along + vec2<f32>(-t.y, t.x) * side;
  return vec4<f32>(screenToClip(p), 0.0, 1.0);
}

@fragment
fn fs_stroke() -> @location(0) vec4<f32> {
  return shape.stroke;
}
