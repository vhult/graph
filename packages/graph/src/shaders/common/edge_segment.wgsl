#include "common/nodes.wgsl"
#include "common/edges.wgsl"
#include "common/sdf.wgsl"

struct EdgeSeg {
  mid : vec2<f32>,
  dir : vec2<f32>,
  halfLen : f32,
  arrowLen : f32,
}

fn edgeSegment(a : vec2<f32>, b : vec2<f32>, head : u32, w : f32, directed : bool, shapes : bool) -> EdgeSeg {
  var tip = b;
  var arrowLen = 0.0;
  if (directed) {
    arrowLen = arrowLenPx(w);
    let full = b - a;
    let fullLen = max(length(full), 1e-4);
    let dirAB = full / fullLen;
    var reach = nodeRadiusPx(head);
    if (shapes) {
      reach *= shapeReach(dirAB, nodeShape(head));
    }
    tip = b - dirAB * min(reach, fullLen * 0.5);
  }
  let d = tip - a;
  let len = max(length(d), 1e-4);
  return EdgeSeg((a + tip) * 0.5, d / len, len * 0.5, arrowFitPx(arrowLen, len));
}

fn edgeDist(uv : vec2<f32>, halfLen : f32, halfWidth : f32, arrowLen : f32) -> f32 {
  let d = sdSegment(uv, halfLen, halfWidth);
  if (EDGE_ARROWS && arrowLen > 0.0) {
    return min(d, sdArrowhead(uv, halfLen, arrowLen, arrowLen * ARROW_HALF_MUL / ARROW_LEN_MUL));
  }
  return d;
}

fn edgeEndState(ij : vec2<u32>) -> u32 {
  if (anyNodeHidden() || anyNodeDimmed()) {
    return nodeState[ij.x] | nodeState[ij.y];
  }
  return 0u;
}
