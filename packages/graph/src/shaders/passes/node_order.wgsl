#include "common/nodes.wgsl"
#include "common/scan.wgsl"

struct OrderParams {
  blocks : u32,
  pad0 : u32,
  pad1 : u32,
  pad2 : u32,
}

@group(2) @binding(0) var<uniform> order : OrderParams;
@group(2) @binding(1) var<storage, read> scratch : array<u32>;
@group(2) @binding(2) var<storage, read> instances : array<vec4<u32>>;
@group(2) @binding(3) var<storage, read_write> hist : array<u32>;
@group(2) @binding(4) var<storage, read_write> layered : array<u32>;

override NODE_ICONS : bool = false;

var<workgroup> wgCount : u32;
var<workgroup> wgHist : array<atomic<u32>, Z_LAYERS>;
var<workgroup> wgRun : array<u32, Z_LAYERS>;

fn blockOf(wid : vec3<u32>, nwg : vec3<u32>) -> u32 {
  return wid.x + wid.y * nwg.x;
}

fn normalBase() -> u32 {
  return scratch[SCRATCH_BUCKET_BASE + BUCKET_NORMAL];
}

fn normalCount() -> u32 {
  return scratch[SCRATCH_DRAW_ARGS + BUCKET_NORMAL * 4u + 1u];
}

fn layerAt(k : u32) -> u32 {
  return (instances[normalBase() + k].z & INSTANCE_LAYER_BITS) >> INSTANCE_LAYER_SHIFT;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn order_count(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let blk = blockOf(wid, nwg);
  if (lid == 0u) {
    wgCount = normalCount();
  }
  let n = workgroupUniformLoad(&wgCount);
  if (blk >= order.blocks) {
    return;
  }
  if (blk * CHUNK_SIZE < n) {
    for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
      let i = blk * CHUNK_SIZE + k * WORKGROUP_SIZE + lid;
      if (i < n) {
        atomicAdd(&wgHist[layerAt(i)], 1u);
      }
    }
  }
  workgroupBarrier();
  if (lid < Z_LAYERS) {
    hist[lid * order.blocks + blk] = atomicLoad(&wgHist[lid]);
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn order_scan(@builtin(local_invocation_index) lid : u32) {
  let n = Z_LAYERS * order.blocks;
  let per = (n + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
  let start = min(lid * per, n);
  let end = min(start + per, n);
  var sum = 0u;
  for (var j = start; j < end; j++) {
    sum += hist[j];
  }
  var run = wgScanU32(sum, lid).exclusive;
  for (var j = start; j < end; j++) {
    let c = hist[j];
    hist[j] = run;
    run += c;
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn order_scatter(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let blk = blockOf(wid, nwg);
  if (lid == 0u) {
    wgCount = normalCount();
  }
  let n = workgroupUniformLoad(&wgCount);
  if (blk >= order.blocks || blk * CHUNK_SIZE >= n) {
    return;
  }
  if (lid < Z_LAYERS) {
    wgRun[lid] = hist[lid * order.blocks + blk];
  }
  workgroupBarrier();
  let base = normalBase();
  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let i = blk * CHUNK_SIZE + k * WORKGROUP_SIZE + lid;
    let valid = i < n;
    let d = select(0u, layerAt(min(i, n - 1u)), valid);
    let one = select(vec4<u32>(0u), oneHot8(d), valid);
    let s = wgScanVec4(one, lid);
    if (valid) {
      let src = base + i;
      let dst = base + wgRun[d] + field8(s.exclusive, d);
      let w = instances[src];
      let at = dst * 4u;
      layered[at] = w.x;
      layered[at + 1u] = w.y;
      layered[at + 2u] = w.z;
      layered[at + 3u] = w.w;
      if (NODE_ICONS && hasIconRoom(bitcast<f32>(w.z))) {
        let tail = scratch[SCRATCH_ICON_BASE];
        layered[tail * 4u + dst] = instances[tail + (src >> 2u)][src & 3u];
      }
    }
    workgroupBarrier();
    if (lid < Z_LAYERS) {
      wgRun[lid] += field8(s.lastExclusive, lid) + field8(s.lastOne, lid);
    }
    workgroupBarrier();
  }
}
