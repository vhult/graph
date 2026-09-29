#include "passes/edge_cull.wgsl"
#include "common/edge_segment.wgsl"
#include "common/edge_curve.wgsl"
#include "common/pick.wgsl"

fn pickRel(center : vec2<f32>) -> vec2<f32> {
  let rd = (pickPoint() - frame.viewportPx * 0.5) / frame.zoom;
  let r = frame.rotation;
  let d = vec2<f32>(rd.x * r.x + rd.y * r.y, -rd.x * r.y + rd.y * r.x);
  return ((frame.originHi - center) + frame.originLo) + d;
}

fn pickEdge(e : u32, keep : f32, n : u32) -> bool {
  let raw = edgeIdx[e];
  let ij = edgeEnds(raw);
  if (edgeHidden(raw) || (edgeEndState(ij) & STATE_HIDDEN) != 0u) {
    return false;
  }
  let a = worldToScreen(nodePos[ij.x]);
  let b = worldToScreen(nodePos[ij.y]);
  let fade = edgeLengthFade(length(b - a));
  if (fade <= 0.0 && EDGE_DEBUG != 1u) {
    return false;
  }
  let style = select(0u, edgeStyle[e], e < arrayLength(&edgeStyle));
  let w = edgeWidthPx(style);
  let wDraw = max(w, EDGE_MIN_DRAW_WIDTH_PX);
  let halfWidth = wDraw * 0.5;
  let directed = EDGE_ARROWS && (style & EDGE_FLAG_DIRECTED) != 0u;
  let shapes = (pick.flags & PICK_FLAG_SHAPES) != 0u;
  var dist : f32;
  var t : f32;
  let bend = edgeCurveBend(style);
  if (EDGE_CURVE && bend > 0.0) {
    let cv = curveOf(a, b, ij.y, w, halfWidth, bend, directed, shapes);
    let hit = curvePick(pickPoint(), cv, halfWidth);
    dist = hit.x;
    t = clamp(hit.y / max(cv.L, 1e-4) * 0.5 + 0.5, 0.0, 1.0);
  } else {
    let s = edgeSegment(a, b, ij.y, w, directed, shapes);
    let extX = s.halfLen + max(halfWidth, s.arrowLen) + EDGE_AA_PAD_PX;
    let rel = pickPoint() - s.mid;
    let uv = vec2<f32>(dot(rel, s.dir), dot(rel, vec2<f32>(-s.dir.y, s.dir.x)));
    dist = edgeDist(uv, s.halfLen, halfWidth, s.arrowLen);
    t = clamp(uv.x / extX * 0.5 + 0.5, 0.0, 1.0);
  }
  let tint = frame.globalEdgeColor;
  var ca = unpack4x8unorm(tint).a;
  if ((pick.flags & PICK_FLAG_EDGE_COLORS) != 0u) {
    let c0 = edgeColor[e * 2u];
    let c1 = edgeColor[e * 2u + 1u];
    ca = mix(unpack4x8unorm(select(c0, tint, c0 == 0u)).a, unpack4x8unorm(select(c1, tint, c1 == 0u)).a, t);
  }
  let fadeIn = clamp(keep - f32(e & (EDGE_CHUNK_SIZE - 1u)), 0.0, 1.0);
  var alpha = edgeStandInAlpha(ca * min(1.0, w / wDraw) * fade, f32(n) / keep) * fadeIn;
  if (EDGE_DEBUG != 0u) {
    alpha = 0.9 * fadeIn;
  }
  return alpha * clamp(0.5 + pick.edgeRadiusPx - dist, 0.0, 1.0) >= 0.002;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn pick_edges_select(@builtin(local_invocation_index) lid : u32) {
  let chunks = numEdgeChunks();
  let covered = (pick.flags & PICK_FLAG_NODES) != 0u && atomicLoad(&pickOut[PICK_NODE_RESULT]) != 0u;
  let listed = select(edgeScratch[EDGE_SCRATCH_LIST_COUNT], 0u, covered);
  let cap = pickCapacity();
  if (lid == 0u) {
    atomicStore(&wgPickCount, 0u);
  }
  workgroupBarrier();
  for (var j = lid; j < listed; j += WORKGROUP_SIZE) {
    let c = edgeScratch[EDGE_SCRATCH_LIST + j];
    let n = edgeScratch[edgeOffsetsAt(chunks) + j + 1u] - edgeScratch[edgeOffsetsAt(chunks) + j];
    let r = loadEdgeChunk(c, chunks);
    let m = edgeReachPx(chunkWidthPx(r.maxWidthPx), EDGE_ARROWS) + pick.edgeRadiusPx + select(0.0, EDGE_CURVE_MAX * r.maxLen * frame.zoom, EDGE_CURVE);
    if (pickPointerInBox(r.lo, r.hi, m)) {
      let k = atomicAdd(&wgPickCount, 1u);
      if (k < cap) {
        atomicStore(&pickOut[PICK_LIST + 2u * k], c);
        atomicStore(&pickOut[PICK_LIST + 2u * k + 1u], n);
      }
    }
  }
  workgroupBarrier();
  if (lid == 0u) {
    let n = min(atomicLoad(&wgPickCount), cap);
    atomicStore(&pickOut[PICK_EDGE_COUNT], n);
    pickWriteArgs(n);
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn pick_edges_test(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let j = wid.x + wid.y * nwg.x;
  if (lid == 0u) {
    wgPickN = atomicLoad(&pickOut[PICK_EDGE_COUNT]);
    atomicStore(&wgPickTop, 0u);
  }
  if (j >= workgroupUniformLoad(&wgPickN)) {
    return;
  }
  let chunks = numEdgeChunks();
  let c = atomicLoad(&pickOut[PICK_LIST + 2u * j]);
  let n = atomicLoad(&pickOut[PICK_LIST + 2u * j + 1u]);
  let r = loadEdgeChunk(c, chunks);
  let width = chunkWidthPx(r.maxWidthPx);
  let keep = edgeKeep(edgeChunkLen(c), r.density, width);
  let rel = pickRel((r.midLo + r.midHi) * 0.5);
  let margin = (edgeReachPx(width, EDGE_ARROWS) + pick.edgeRadiusPx + 1.0) / frame.zoom * 1.0001 + r.maxLen * 3e-5 + length(rel) * 2e-6 + select(0.0, EDGE_CURVE_MAX * r.maxLen, EDGE_CURVE);
  let first = c * EDGE_CHUNK_SIZE;
  let len = edgeChunkLen(c);
  var best = 0u;
  for (var t = lid; t < n; t += WORKGROUP_SIZE) {
    let e = first + t;
    let line = edgeLines[e];
    let rho = bitcast<f32>(line.y);
    if (abs(dot(unpack2x16snorm(line.x), rel) - rho) <= margin + abs(rho) * 2e-6 && pickEdge(e, keep, len)) {
      best = e + 1u;
    }
  }
  if (best != 0u) {
    atomicMax(&wgPickTop, best);
  }
  workgroupBarrier();
  if (lid == 0u) {
    let top = atomicLoad(&wgPickTop);
    if (top != 0u) {
      atomicMax(&pickOut[PICK_EDGE_BEST], top);
    }
  }
}

@compute @workgroup_size(1)
fn pick_edges_resolve() {
  let best = atomicLoad(&pickOut[PICK_EDGE_BEST]);
  atomicStore(&pickOut[PICK_EDGE_RESULT], select(0u, pickOrder[max(best, 1u) - 1u] + 1u, best != 0u));
  atomicStore(&pickOut[PICK_EDGE_BEST], 0u);
}
