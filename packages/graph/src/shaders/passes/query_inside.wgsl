#include "common/camera.wgsl"

struct QueryParams {
  lo : vec2<f32>,
  hi : vec2<f32>,
  points : u32,
  nodeCount : u32,
  gridX : u32,
  pad : u32,
}

@group(2) @binding(0) var<uniform> query : QueryParams;
@group(2) @binding(1) var<storage, read> queryPoints : array<vec2<f32>>;
@group(2) @binding(2) var<storage, read> queryOrder : array<u32>;
@group(2) @binding(3) var<storage, read_write> queryOut : array<atomic<u32>>;

var<workgroup> wgCount : atomic<u32>;
var<workgroup> wgBase : u32;

fn insideShape(p : vec2<f32>) -> bool {
  let n = query.points;
  var inside = false;
  var j = n - 1u;
  for (var i = 0u; i < n; i++) {
    let a = queryPoints[i];
    let b = queryPoints[j];
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

@compute @workgroup_size(WORKGROUP_SIZE)
fn query_inside(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) lid : u32) {
  let i = (wid.y * query.gridX + wid.x) * WORKGROUP_SIZE + lid;
  if (lid == 0u) {
    atomicStore(&wgCount, 0u);
  }
  workgroupBarrier();
  var hit = false;
  if (i < query.nodeCount && (nodeState[i] & STATE_HIDDEN) == 0u) {
    let p = worldToScreen(nodePos[i]);
    hit = all(p >= query.lo) && all(p <= query.hi) && insideShape(p);
  }
  var k = 0u;
  if (hit) {
    k = atomicAdd(&wgCount, 1u);
  }
  workgroupBarrier();
  if (lid == 0u) {
    let n = atomicLoad(&wgCount);
    if (n > 0u) {
      wgBase = atomicAdd(&queryOut[0], n);
    }
  }
  workgroupBarrier();
  if (hit) {
    atomicStore(&queryOut[1u + wgBase + k], queryOrder[i]);
  }
}
