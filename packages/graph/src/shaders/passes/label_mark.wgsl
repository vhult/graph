#include "common/labels.wgsl"

@group(2) @binding(0) var<storage, read_write> nodeBits : array<atomic<u32>>;
@group(2) @binding(2) var<storage, read> live : array<LiveLabel>;
@group(2) @binding(3) var<storage, read_write> edgeBits : array<atomic<u32>>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_clear_bits(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nwg : vec3<u32>) {
  let w = gid.x + gid.y * nwg.x * WORKGROUP_SIZE;
  if (w < (label.nodeCount + 31u) / 32u) {
    atomicStore(&nodeBits[label.bitsOffset + w], 0u);
  }
  if (w < (label.edgeCount + 31u) / 32u) {
    atomicStore(&edgeBits[w], 0u);
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_mark_bits(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= label.liveCount) {
    return;
  }
  let i = live[gid.x].index;
  if ((i & LABEL_EDGE_BIT) != 0u) {
    let e = i & ~LABEL_EDGE_BIT;
    atomicOr(&edgeBits[e >> 5u], 1u << (e & 31u));
  } else {
    atomicOr(&nodeBits[label.bitsOffset + (i >> 5u)], 1u << (i & 31u));
  }
}
