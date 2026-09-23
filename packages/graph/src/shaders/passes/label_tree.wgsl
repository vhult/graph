#include "common/cull_state.wgsl"
#include "common/edges.wgsl"
#include "common/labels.wgsl"

@group(2) @binding(2) var<storage, read> sizes : array<u32>;
@group(2) @binding(3) var<storage, read_write> labelIndex : array<u32>;
@group(2) @binding(4) var<storage, read_write> treeBox : array<vec4<f32>>;
@group(2) @binding(5) var<uniform> phaseArg : vec4<u32>;
@group(2) @binding(6) var<storage, read> edgeState : array<u32>;
@group(2) @binding(7) var<storage, read> positions : array<vec2<f32>>;
@group(2) @binding(8) var<storage, read> ends : array<vec2<u32>>;
@group(2) @binding(9) var<storage, read_write> edgeTops : array<u32>;
@group(2) @binding(10) var<storage, read_write> edgeTreeBox : array<vec4<f32>>;
@group(2) @binding(11) var<storage, read_write> edgeTreeLen : array<f32>;

var<workgroup> wgKey : array<u32, CHUNK_SIZE>;
var<workgroup> wgBox : array<vec4<f32>, WORKGROUP_SIZE>;
var<workgroup> wgLen : array<f32, WORKGROUP_SIZE>;

const EMPTY_BOX : vec4<f32> = vec4<f32>(3.0e38, 3.0e38, -3.0e38, -3.0e38);

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_order(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let c = wid.x + wid.y * nwg.x;
  if (c >= (1u << label.levels)) {
    return;
  }
  let base = c * CHUNK_SIZE;
  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let t = k * WORKGROUP_SIZE + lid;
    var key = LABEL_NONE;
    if (c < label.chunks && base + t < label.nodeCount) {
      key = ((0xFFFFu - sizeKey(sizes[base + t])) << 16u) | t;
    }
    wgKey[t] = key;
  }
  workgroupBarrier();
  for (var span = 2u; span <= CHUNK_SIZE; span = span << 1u) {
    for (var stride = span >> 1u; stride > 0u; stride = stride >> 1u) {
      for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
        let t = k * WORKGROUP_SIZE + lid;
        let partner = t ^ stride;
        if (partner > t) {
          let a = wgKey[t];
          let b = wgKey[partner];
          if ((a > b) == ((t & span) == 0u)) {
            wgKey[t] = b;
            wgKey[partner] = a;
          }
        }
      }
      workgroupBarrier();
    }
  }
  let top = treeTop(0u, c);
  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    let t = k * WORKGROUP_SIZE + lid;
    let key = wgKey[t];
    let i = select(base + (key & 0xFFFFu), LABEL_NONE, key == LABEL_NONE);
    if (c < label.chunks && base + t < label.nodeCount) {
      labelIndex[base + t] = i;
    }
    if (t < LABEL_TREE_TOP) {
      labelIndex[top + t] = i;
    }
  }
}

fn before(a : u32, b : u32) -> bool {
  if (b == LABEL_NONE) {
    return a != LABEL_NONE;
  }
  if (a == LABEL_NONE) {
    return false;
  }
  let sa = sizeKey(sizes[a]);
  let sb = sizeKey(sizes[b]);
  return sa > sb || (sa == sb && a < b);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_merge(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nwg : vec3<u32>) {
  let level = phaseArg.x;
  let j = gid.x + gid.y * nwg.x * WORKGROUP_SIZE;
  if (j >= ((1u << label.levels) >> level)) {
    return;
  }
  let left = treeTop(level - 1u, 2u * j);
  let right = left + LABEL_TREE_TOP;
  let dst = treeTop(level, j);
  var ia = 0u;
  var ib = 0u;
  for (var t = 0u; t < LABEL_TREE_TOP; t++) {
    let a = select(LABEL_NONE, labelIndex[left + ia], ia < LABEL_TREE_TOP);
    let b = select(LABEL_NONE, labelIndex[right + ib], ib < LABEL_TREE_TOP);
    if (before(a, b)) {
      labelIndex[dst + t] = a;
      ia++;
    } else {
      labelIndex[dst + t] = b;
      ib++;
    }
  }
}

fn boxLevel(lid : u32, s : u32) -> vec4<f32> {
  let span = WORKGROUP_SIZE >> s;
  var m = EMPTY_BOX;
  if (lid < span) {
    let a = wgBox[2u * lid];
    let c = wgBox[2u * lid + 1u];
    m = vec4<f32>(min(a.xy, c.xy), max(a.zw, c.zw));
  }
  workgroupBarrier();
  if (lid < span) {
    wgBox[lid] = m;
  }
  workgroupBarrier();
  return m;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_boxes(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) lid : u32) {
  let first = phaseArg.x;
  let levels = phaseArg.y;
  let j = wid.x * WORKGROUP_SIZE + lid;
  let n = (1u << label.levels) >> first;
  var b = EMPTY_BOX;
  if (first == 0u) {
    if (j < label.chunks) {
      let cb = loadChunkBounds(j, label.chunks);
      if (cb.maxSize > 0.0) {
        b = vec4<f32>(cb.lo, cb.hi);
      }
    }
    if (j < n) {
      treeBox[j] = b;
    }
  } else if (j < n) {
    b = treeBox[treeOffset(first) + j];
  }
  wgBox[lid] = b;
  workgroupBarrier();
  for (var s = 1u; s <= levels; s++) {
    let m = boxLevel(lid, s);
    let jj = wid.x * (WORKGROUP_SIZE >> s) + lid;
    if (lid < (WORKGROUP_SIZE >> s) && jj < (n >> s)) {
      treeBox[treeOffset(first + s) + jj] = m;
    }
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_edge_boxes(@builtin(workgroup_id) wid : vec3<u32>, @builtin(local_invocation_index) lid : u32) {
  let first = phaseArg.x;
  let levels = phaseArg.y;
  let j = wid.x * WORKGROUP_SIZE + lid;
  let n = (1u << label.edgeLevels) >> first;
  var b = EMPTY_BOX;
  var len = 0.0;
  if (first == 0u) {
    if (j < label.edgeChunks) {
      let o = edgeChunkAt(j, label.edgeChunks);
      b = vec4<f32>(bitcast<f32>(edgeState[o + 8u]), bitcast<f32>(edgeState[o + 9u]), bitcast<f32>(edgeState[o + 10u]), bitcast<f32>(edgeState[o + 11u]));
      len = bitcast<f32>(edgeState[o + 4u]);
    }
    if (j < n) {
      edgeTreeBox[j] = b;
      edgeTreeLen[j] = len;
    }
  } else if (j < n) {
    b = edgeTreeBox[edgeTreeOffset(first) + j];
    len = edgeTreeLen[edgeTreeOffset(first) + j];
  }
  wgBox[lid] = b;
  wgLen[lid] = len;
  workgroupBarrier();
  for (var s = 1u; s <= levels; s++) {
    let span = WORKGROUP_SIZE >> s;
    var l = 0.0;
    if (lid < span) {
      l = max(wgLen[2u * lid], wgLen[2u * lid + 1u]);
    }
    let m = boxLevel(lid, s);
    if (lid < span) {
      wgLen[lid] = l;
    }
    workgroupBarrier();
    let jj = wid.x * span + lid;
    if (lid < span && jj < (n >> s)) {
      edgeTreeBox[edgeTreeOffset(first + s) + jj] = m;
      edgeTreeLen[edgeTreeOffset(first + s) + jj] = l;
    }
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_edge_tops(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nwg : vec3<u32>) {
  let j = gid.x + gid.y * nwg.x * WORKGROUP_SIZE;
  if (j >= (1u << label.edgeLevels)) {
    return;
  }
  for (var t = 0u; t < LABEL_TREE_TOP; t++) {
    let e = j * EDGE_CHUNK_SIZE + t;
    edgeTops[edgeTreeTop(0u, j) + t] = select(LABEL_NONE, e, j < label.edgeChunks && e < label.edgeCount);
  }
}

fn edgeLength(e : u32) -> f32 {
  let ij = ends[e];
  return distance(positions[ij.x], positions[ij.y]);
}

fn longer(a : u32, b : u32) -> bool {
  if (b == LABEL_NONE) {
    return a != LABEL_NONE;
  }
  if (a == LABEL_NONE) {
    return false;
  }
  let la = edgeLength(a);
  let lb = edgeLength(b);
  return la > lb || (la == lb && a < b);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_edge_merge(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nwg : vec3<u32>) {
  let level = phaseArg.x;
  let j = gid.x + gid.y * nwg.x * WORKGROUP_SIZE;
  if (j >= ((1u << label.edgeLevels) >> level)) {
    return;
  }
  let left = edgeTreeTop(level - 1u, 2u * j);
  let right = left + LABEL_TREE_TOP;
  let dst = edgeTreeTop(level, j);
  var ia = 0u;
  var ib = 0u;
  for (var t = 0u; t < LABEL_TREE_TOP; t++) {
    let a = select(LABEL_NONE, edgeTops[left + ia], ia < LABEL_TREE_TOP);
    let b = select(LABEL_NONE, edgeTops[right + ib], ib < LABEL_TREE_TOP);
    if (longer(a, b)) {
      edgeTops[dst + t] = a;
      ia++;
    } else {
      edgeTops[dst + t] = b;
      ib++;
    }
  }
}
