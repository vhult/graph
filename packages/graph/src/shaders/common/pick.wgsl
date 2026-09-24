#include "common/camera.wgsl"

@group(3) @binding(0) var<uniform> pick : PickParams;
@group(3) @binding(1) var<storage, read_write> pickOut : array<atomic<u32>>;
@group(3) @binding(2) var<storage, read> pickOrder : array<u32>;
@group(3) @binding(3) var<storage, read_write> pickArgs : array<u32>;

var<workgroup> wgPickCount : atomic<u32>;
var<workgroup> wgPickN : u32;
var<workgroup> wgPickTop : atomic<u32>;

fn pickPoint() -> vec2<f32> {
  return floor(pick.pointer) + 0.5;
}

fn pickCapacity() -> u32 {
  return (arrayLength(&pickOut) - PICK_LIST) / 2u;
}

fn pickWriteArgs(n : u32) {
  pickArgs[0] = min(n, 65535u);
  pickArgs[1] = max(1u, (n + 65534u) / 65535u);
  pickArgs[2] = 1u;
}

fn pickPointerInBox(lo : vec2<f32>, hi : vec2<f32>, m : f32) -> bool {
  let p0 = worldToScreen(lo);
  let p1 = worldToScreen(vec2<f32>(hi.x, lo.y));
  let p2 = worldToScreen(vec2<f32>(lo.x, hi.y));
  let p3 = worldToScreen(hi);
  let a = min(min(p0, p1), min(p2, p3)) - m;
  let b = max(max(p0, p1), max(p2, p3)) + m;
  let p = pickPoint();
  return p.x >= a.x && p.y >= a.y && p.x <= b.x && p.y <= b.y;
}
