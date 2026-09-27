#include "common/layouts.wgsl"

struct MergeParams {
  n : u32,
  gridX : u32,
  pad0 : u32,
  pad1 : u32,
}

@group(2) @binding(0) var<uniform> merge : MergeParams;
@group(2) @binding(1) var<storage, read> order : array<u32>;
@group(2) @binding(2) var<storage, read> layers : array<u32>;
@group(2) @binding(3) var<storage, read_write> style : array<u32>;

const WG : u32 = 256u;

@compute @workgroup_size(WG)
fn merge_layers(@builtin(global_invocation_id) gid : vec3<u32>) {
  let e = gid.x + gid.y * merge.gridX * WG;
  if (e >= merge.n) {
    return;
  }
  let u = order[e];
  let layer = min((layers[u >> 2u] >> ((u & 3u) * 8u)) & 0xffu, STYLE_ZLAYER_MASK);
  style[e] = (style[e] & ~(STYLE_ZLAYER_MASK << STYLE_ZLAYER_SHIFT)) | (layer << STYLE_ZLAYER_SHIFT);
}
