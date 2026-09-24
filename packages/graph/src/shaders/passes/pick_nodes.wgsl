#include "passes/transform_cull.wgsl"
#include "common/sdf.wgsl"
#include "common/pick.wgsl"

var<workgroup> wgPickBest : array<vec2<u32>, WORKGROUP_SIZE>;

fn pickChunk(c : u32, chunks : u32) -> u32 {
  let cb = loadChunkBounds(c, chunks);
  let count = lodCount(cb);
  let maxR = max(cb.maxSize * frame.globalNodeScale * frame.zoom * 0.5 * lodScale(count), NODE_MIN_DRAW_RADIUS_PX);
  if (!pickPointerInBox(cb.lo, cb.hi, maxR + 0.5 + pick.radiusPx)) {
    return 0u;
  }
  return bitcast<u32>(count);
}

fn pickKey(b : u32, c : u32, t : u32, chunks : u32) -> u32 {
  if (b == BUCKET_NORMAL) {
    return drawIndex(t / DRAW_SEGMENT, c, chunks) * DRAW_SEGMENT + (t % DRAW_SEGMENT) + 1u;
  }
  return 0x80000000u | (c * CHUNK_SIZE + t + 1u);
}

fn pickNode(c : u32, t : u32, count : f32, chunks : u32) -> vec2<u32> {
  let i = c * CHUNK_SIZE + t;
  let labelled = isLabelled(i, chunks);
  if (t >= u32(ceil(count)) && !labelled) {
    return vec2<u32>(0u);
  }
  let scale = lodScale(count);
  let b = classify(i, scale);
  if (b == BUCKET_CULLED) {
    return vec2<u32>(0u);
  }
  let r = nodeRadiusPx(i) * scale;
  let rDraw = max(r, NODE_MIN_DRAW_RADIUS_PX);
  let color = select(lodFade(nodeColor[i], count, t), nodeColor[i], labelled);
  let base = unpack4x8unorm(color).a * min(1.0, (r * r) / (rDraw * rDraw));
  let d = pickPoint() - worldToScreen(nodePos[i]);
  var sd = length(d) - rDraw;
  if ((pick.flags & PICK_FLAG_SHAPES) != 0u) {
    sd = sdShape(d / rDraw, nodeShape(i)) * rDraw;
  }
  if (base * clamp(0.5 + pick.radiusPx - sd, 0.0, 1.0) < 0.002) {
    return vec2<u32>(0u);
  }
  return vec2<u32>(pickKey(b, c, t, chunks), i);
}

fn pickBetter(a : vec2<u32>, b : vec2<u32>) -> vec2<u32> {
  return select(a, b, b.x > a.x);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn pick_nodes_select(@builtin(local_invocation_index) lid : u32) {
  let chunks = numChunks();
  let listed = scratch[SCRATCH_LIST_COUNT];
  let cap = pickCapacity();
  if (lid == 0u) {
    atomicStore(&wgPickCount, 0u);
  }
  workgroupBarrier();
  for (var j = lid; j < listed; j += WORKGROUP_SIZE) {
    let c = scratch[listAt(chunks) + j];
    let flag = pickChunk(c, chunks);
    if (flag != 0u) {
      let k = atomicAdd(&wgPickCount, 1u);
      if (k < cap) {
        atomicStore(&pickOut[PICK_LIST + 2u * k], c);
        atomicStore(&pickOut[PICK_LIST + 2u * k + 1u], flag);
      }
    }
  }
  workgroupBarrier();
  if (lid == 0u) {
    let n = min(atomicLoad(&wgPickCount), cap);
    atomicStore(&pickOut[PICK_NODE_COUNT], n);
    pickWriteArgs(n);
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn pick_nodes_test(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let j = wid.x + wid.y * nwg.x;
  if (lid == 0u) {
    wgPickN = atomicLoad(&pickOut[PICK_NODE_COUNT]);
    atomicStore(&wgPickTop, 0u);
  }
  if (j >= workgroupUniformLoad(&wgPickN)) {
    return;
  }
  let chunks = numChunks();
  let c = atomicLoad(&pickOut[PICK_LIST + 2u * j]);
  let count = bitcast<f32>(atomicLoad(&pickOut[PICK_LIST + 2u * j + 1u]));
  var best = vec2<u32>(0u);
  for (var k = 0u; k < ITEMS_PER_THREAD; k++) {
    best = pickBetter(best, pickNode(c, k * WORKGROUP_SIZE + lid, count, chunks));
  }
  if (best.x != 0u) {
    atomicMax(&wgPickTop, best.x);
  }
  workgroupBarrier();
  let top = atomicLoad(&wgPickTop);
  if (top == 0u) {
    if (lid == 0u) {
      atomicStore(&pickOut[PICK_LIST + 2u * j], 0u);
    }
  } else if (best.x == top) {
    atomicStore(&pickOut[PICK_LIST + 2u * j], best.x);
    atomicStore(&pickOut[PICK_LIST + 2u * j + 1u], best.y);
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn pick_nodes_resolve(@builtin(local_invocation_index) lid : u32) {
  let n = atomicLoad(&pickOut[PICK_NODE_COUNT]);
  var best = vec2<u32>(0u);
  for (var j = lid; j < n; j += WORKGROUP_SIZE) {
    best = pickBetter(best, vec2<u32>(atomicLoad(&pickOut[PICK_LIST + 2u * j]), atomicLoad(&pickOut[PICK_LIST + 2u * j + 1u])));
  }
  wgPickBest[lid] = best;
  workgroupBarrier();
  for (var s = WORKGROUP_SIZE / 2u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      wgPickBest[lid] = pickBetter(wgPickBest[lid], wgPickBest[lid + s]);
    }
    workgroupBarrier();
  }
  if (lid == 0u) {
    let r = wgPickBest[0];
    atomicStore(&pickOut[PICK_NODE_RESULT], select(0u, pickOrder[r.y] + 1u, r.x != 0u));
    let chunks = numChunks();
    let c = min(r.y / CHUNK_SIZE, max(chunks, 1u) - 1u);
    atomicStore(&pickOut[PICK_NODE_SCALE], bitcast<u32>(lodScale(lodCount(loadChunkBounds(c, chunks)))));
  }
}
