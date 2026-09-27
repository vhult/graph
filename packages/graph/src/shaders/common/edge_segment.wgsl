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
  if (EDGE_ARROWS && arrowLen > 0.0) {
    let trim = min(arrowLen, (halfWidth + EDGE_AA_PAD_PX) * ARROW_SIDE_MUL) * 0.5;
    let line = sdSegment(uv + vec2<f32>(trim, 0.0), halfLen - trim, halfWidth);
    return min(line, sdArrowhead(uv, halfLen, arrowLen, arrowLen * ARROW_HALF_MUL / ARROW_LEN_MUL));
  }
  return sdSegment(uv, halfLen, halfWidth);
}

const EDGE_DASH_UNIT_CSS_PX : f32 = 2.0;
const EDGE_DOUBLE_MIN_CSS_PX : f32 = 3.0;
const EDGE_TAPER_END : f32 = 0.25;

fn edgeLine(style : u32, halfLen : f32, halfWidth : f32, weight : f32) -> vec4<f32> {
  var pattern = (style >> EDGE_PATTERN_SHIFT) & EDGE_PATTERN_MASK;
  let thin = pattern == EDGE_PATTERN_DOUBLE && halfWidth * 2.0 < EDGE_DOUBLE_MIN_CSS_PX * frame.pixelRatio;
  if (pattern > EDGE_PATTERN_DOUBLE || thin || weight >= 2.0) {
    pattern = EDGE_PATTERN_SOLID;
  }
  let unit = max(halfWidth * 2.0, EDGE_DASH_UNIT_CSS_PX * frame.pixelRatio);
  let taper = select(0.0, halfWidth * (1.0 - EDGE_TAPER_END) / (2.0 * halfLen), (style & EDGE_FLAG_TAPERED) != 0u);
  return vec4<f32>(f32(pattern), unit, (weight - 1.0) * unit, taper);
}

fn edgeDashDist(s : f32, period : f32, dash : f32) -> f32 {
  let c = s - dash * 0.5;
  return abs(c - period * round(c / period)) - dash * 0.5;
}

fn edgeDotDist(s : f32, y : f32, period : f32, offset : f32, r : f32) -> f32 {
  let c = s - offset;
  return length(vec2<f32>(c - period * round(c / period), y)) - r;
}

fn edgePatternDist(s : f32, y : f32, halfWidth : f32, pattern : u32, u : f32) -> f32 {
  switch (pattern) {
    case EDGE_PATTERN_DASHED: {
      return edgeDashDist(s, 5.0 * u, 3.0 * u);
    }
    case EDGE_PATTERN_DOTTED: {
      return edgeDotDist(s, y, 2.0 * u, 0.0, halfWidth);
    }
    case EDGE_PATTERN_DASH_DOT: {
      return min(edgeDashDist(s, 6.0 * u, 3.0 * u), edgeDotDist(s, y, 6.0 * u, 4.5 * u, halfWidth));
    }
    default: {
      return abs(abs(y) - halfWidth * (2.0 / 3.0)) - halfWidth * (1.0 / 3.0);
    }
  }
}

fn edgeCoverage(uv : vec2<f32>, halfLen : f32, halfWidth : f32, arrowLen : f32, line : vec4<f32>) -> f32 {
  let hw = halfWidth - line.w * (clamp(uv.x, -halfLen, halfLen) + halfLen);
  var trim = 0.0;
  var arrow = 0.0;
  if (EDGE_ARROWS && arrowLen > 0.0) {
    trim = min(arrowLen, (halfWidth + EDGE_AA_PAD_PX) * ARROW_SIDE_MUL) * 0.5;
    arrow = clamp(0.5 - sdArrowhead(uv, halfLen, arrowLen, arrowLen * ARROW_HALF_MUL / ARROW_LEN_MUL), 0.0, 1.0);
  }
  var d = sdSegment(uv + vec2<f32>(trim, 0.0), halfLen - trim, hw);
  let pattern = u32(line.x);
  if (pattern != EDGE_PATTERN_SOLID) {
    d = max(d, edgePatternDist(uv.x + halfLen, uv.y, hw, pattern, line.y) - line.z);
  }
  return max(clamp(0.5 - d, 0.0, 1.0), arrow);
}

fn edgeEndState(ij : vec2<u32>) -> u32 {
  if (anyNodeHidden() || anyNodeDimmed()) {
    return nodeState[ij.x] | nodeState[ij.y];
  }
  return 0u;
}
