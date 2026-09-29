#include "common/edge_segment.wgsl"

struct Curve {
  mid : vec2<f32>,
  dir : vec2<f32>,
  L : f32,
  k : f32,
  xEnd : f32,
  arrowLen : f32,
  tip : vec2<f32>,
  tan : vec2<f32>,
}

struct CurveVertex {
  pos : vec4<f32>,
  q : vec2<f32>,
  t : f32,
  part : u32,
  shape : vec4<f32>,
  geo : vec4<f32>,
  tip : vec4<f32>,
  arrow : vec4<f32>,
}

struct CurveOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) q : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) @interpolate(flat) shape : vec4<f32>,
  @location(3) @interpolate(flat) geo : vec4<f32>,
  @location(4) @interpolate(flat) tip : vec4<f32>,
  @location(5) @interpolate(flat) arrow : vec4<f32>,
  @location(6) @interpolate(flat) line : vec4<f32>,
  @location(7) @interpolate(flat) part : u32,
}

fn curveY(k : f32, L : f32, x : f32) -> f32 {
  return k * (L - x) * (L + x);
}

fn curveNormal(dir : vec2<f32>) -> vec2<f32> {
  return vec2<f32>(-dir.y, dir.x);
}

fn curveTangent(slope : f32) -> vec2<f32> {
  return vec2<f32>(1.0, slope) * inverseSqrt(1.0 + slope * slope);
}

fn curveArrowHalf(arrowLen : f32) -> f32 {
  return arrowLen * ARROW_HALF_MUL / ARROW_LEN_MUL;
}

fn curveOf(a : vec2<f32>, b : vec2<f32>, head : u32, w : f32, baseHalfWidth : f32, bend : f32, directed : bool, shapes : bool) -> Curve {
  let d = b - a;
  let len = length(d);
  let L = len * 0.5;
  let off = 2.0 * baseHalfWidth + 2.0;
  let c = min(bend * len, 0.95 * L * L / (sqrt(off * off + 2.0 * L * L) + off));
  var cv : Curve;
  cv.mid = (a + b) * 0.5;
  cv.dir = d / max(len, 1e-4);
  cv.L = L;
  cv.k = c / max(L * L, 1e-8);
  cv.xEnd = L;
  cv.arrowLen = 0.0;
  cv.tip = b;
  cv.tan = cv.dir;
  if (directed) {
    let n = curveNormal(cv.dir);
    let te = curveTangent(-2.0 * cv.k * L);
    var reach = nodeRadiusPx(head);
    if (shapes) {
      reach *= shapeReach(cv.dir * te.x + n * te.y, nodeShape(head));
    }
    reach = min(reach, L);
    var x = L - reach * te.x;
    let y = curveY(cv.k, L, x);
    let h = (x - L) * (x - L) + y * y - reach * reach;
    let dh = 2.0 * (x - L) - 4.0 * cv.k * x * y;
    x = clamp(select(x, x - h / dh, dh < -1e-6), 0.0, L);
    let tl = curveTangent(-2.0 * cv.k * x);
    cv.xEnd = x;
    cv.tip = cv.mid + cv.dir * x + n * curveY(cv.k, L, x);
    cv.tan = cv.dir * tl.x + n * tl.y;
    cv.arrowLen = arrowFitPx(arrowLenPx(w), length(cv.tip - a));
  }
  return cv;
}

fn curveBoxY(cv : Curve, halfWidth : f32) -> f32 {
  return max(halfWidth, curveArrowHalf(cv.arrowLen)) + EDGE_AA_PAD_PX;
}

fn curveCut(cv : Curve, halfWidth : f32) -> f32 {
  let trim = min(cv.arrowLen, (halfWidth + EDGE_AA_PAD_PX) * ARROW_SIDE_MUL) * 0.5;
  let tl = curveTangent(-2.0 * cv.k * cv.xEnd);
  let drift = 4.0 * cv.k * tl.x * tl.x * tl.x * trim * trim;
  return min(2.0 * trim + 2.0 * ARROW_SIDE_MUL * drift, cv.arrowLen);
}

fn curveArc(k : f32, x : f32) -> f32 {
  let ax = abs(x);
  let z = 2.0 * k * ax;
  let z2 = z * z;
  let q = select(asinh(z) / max(z, 1e-30), 1.0 - z2 / 6.0 + 0.075 * z2 * z2, z < 0.1);
  return sign(x) * ax * 0.5 * (sqrt(1.0 + z2) + q);
}

fn curveVertex(vi : u32, cv : Curve, halfWidth : f32, withLength : bool) -> CurveVertex {
  var v : CurveVertex;
  let r = halfWidth + EDGE_AA_PAD_PX;
  let n = curveNormal(cv.dir);
  let arrow = EDGE_ARROWS && cv.arrowLen > 0.0;
  let boxY = curveBoxY(cv, halfWidth);
  let g = select(r, boxY + cv.arrowLen + 4.0 * EDGE_AA_PAD_PX, arrow);
  let c0 = dot(frame.viewportPx * 0.5 - cv.mid, cv.dir);
  let ext = dot(frame.viewportPx * 0.5 + g, abs(cv.dir));
  let x0 = max(-cv.L, c0 - ext);
  let x1 = min(cv.L, c0 + ext);
  if (x0 > x1) {
    v.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    return v;
  }
  let hi = min(x1, cv.xEnd);
  let lo = min(x0, hi);
  let xv = 0.5 * (lo + hi);
  let s0 = -2.0 * cv.k * xv;
  let origin = cv.mid + cv.dir * xv + n * curveY(cv.k, cv.L, xv);
  let strip = 2u * (EDGE_CURVE_PIECES + 1u);
  var q : vec2<f32>;
  if (vi <= strip || !arrow) {
    let j = min(vi, strip - 1u);
    let i = j >> 1u;
    let side = select(-1.0, 1.0, (j & 1u) != 0u);
    let dx = (hi - lo) / f32(EDGE_CURVE_PIECES);
    let u = (f32(i) - 0.5 * f32(EDGE_CURVE_PIECES)) * dx;
    let tl = curveTangent(s0 - 2.0 * cv.k * u);
    let off = r + select(0.0, 0.25 * cv.k * dx * dx, side > 0.0);
    q = vec2<f32>(u, s0 * u - cv.k * u * u) + vec2<f32>(-tl.y, tl.x) * (off * side);
    if (i == 0u) {
      q -= tl * r;
    }
    if (i == EDGE_CURVE_PIECES) {
      q += tl * r;
    }
    v.t = clamp((xv + u) / max(cv.L, 1e-4) * 0.5 + 0.5, 0.0, 1.0);
    v.part = 0u;
  } else {
    let corner = max(vi, strip + 2u) - (strip + 2u);
    let bx = select(-(cv.arrowLen + 2.0 * EDGE_AA_PAD_PX), 2.0 * EDGE_AA_PAD_PX, corner >= 2u);
    let by = select(-1.0, 1.0, (corner & 1u) != 0u) * (boxY + EDGE_AA_PAD_PX);
    let rel = cv.tip + cv.tan * bx + curveNormal(cv.tan) * by - origin;
    q = vec2<f32>(dot(rel, cv.dir), dot(rel, n));
    v.t = 1.0;
    v.part = 1u;
  }
  v.pos = vec4<f32>(screenToClip(origin + cv.dir * q.x + n * q.y), 0.0, 1.0);
  v.q = q;
  var arcL = 0.0;
  var len = 0.0;
  if (withLength) {
    arcL = curveArc(cv.k, cv.L);
    len = curveArc(cv.k, cv.xEnd) + arcL;
  }
  v.shape = vec4<f32>(cv.k, s0, -cv.L - xv, cv.xEnd - xv);
  v.geo = vec4<f32>(halfWidth, xv, cv.L, len);
  v.tip = vec4<f32>(cv.tip, cv.tan);
  v.arrow = vec4<f32>(select(0.0, cv.arrowLen, arrow), boxY, curveCut(cv, halfWidth), arcL);
  return v;
}

fn curveOutOf(v : CurveVertex, color : vec4<f32>) -> CurveOut {
  var o : CurveOut;
  o.pos = v.pos;
  o.q = v.q;
  o.color = color;
  o.shape = v.shape;
  o.geo = v.geo;
  o.tip = v.tip;
  o.arrow = v.arrow;
  o.part = v.part;
  return o;
}

fn curveNearest(q : vec2<f32>, k : f32, s0 : f32, uLo : f32, uHi : f32) -> f32 {
  var u = clamp(q.x, uLo, uHi);
  if (k == 0.0) {
    return u;
  }
  for (var i = 0u; i < 3u; i++) {
    let slope = s0 - 2.0 * k * u;
    let e = s0 * u - k * u * u - q.y;
    let g = u - q.x + e * slope;
    let dg = max(1.0 + slope * slope - 2.0 * k * e, 1e-3);
    u = clamp(u - g / dg, uLo, uHi);
  }
  return u;
}

fn curveArrowFrame(p : vec2<f32>, tip : vec4<f32>) -> vec2<f32> {
  let d = p - tip.xy;
  return vec2<f32>(dot(d, tip.zw), dot(d, curveNormal(tip.zw)));
}

fn curveCoverage(pos : vec2<f32>, q : vec2<f32>, shape : vec4<f32>, geo : vec4<f32>, tip : vec4<f32>, arrow : vec4<f32>, line : vec4<f32>, part : u32, patterns : bool) -> f32 {
  let arrowOn = EDGE_ARROWS && arrow.x > 0.0;
  var pa = vec2<f32>(0.0);
  if (arrowOn) {
    pa = curveArrowFrame(pos, tip);
    let owned = pa.x >= -(arrow.x + EDGE_AA_PAD_PX) && pa.x <= EDGE_AA_PAD_PX && abs(pa.y) <= arrow.y;
    if (owned != (part == 1u)) {
      return 0.0;
    }
  }
  let k = shape.x;
  let s0 = shape.y;
  let u = curveNearest(q, k, s0, shape.z, shape.w);
  let dq = q - vec2<f32>(u, s0 * u - k * u * u);
  let dc = length(dq);
  var d = dc - geo.x;
  if (patterns && (u32(line.x) != EDGE_PATTERN_SOLID || line.w != 0.0)) {
    let s = curveArc(k, geo.y + u) + arrow.w + dot(dq, curveTangent(s0 - 2.0 * k * u));
    let hw = geo.x - line.w * clamp(s, 0.0, geo.w);
    d = dc - hw;
    let pattern = u32(line.x);
    if (pattern != EDGE_PATTERN_SOLID) {
      d = max(d, edgePatternDist(s, dc, hw, pattern, line.y) - line.z);
    }
  }
  var head = 0.0;
  if (arrowOn) {
    d = max(d, pa.x + arrow.z);
    head = clamp(0.5 - sdArrowhead(pa, 0.0, arrow.x, curveArrowHalf(arrow.x)), 0.0, 1.0);
  }
  return max(clamp(0.5 - d, 0.0, 1.0), head);
}

fn curvePick(p : vec2<f32>, cv : Curve, halfWidth : f32) -> vec2<f32> {
  let n = curveNormal(cv.dir);
  let rel = p - cv.mid;
  let px = dot(rel, cv.dir);
  let xv = clamp(px, -cv.L, cv.xEnd);
  let s0 = -2.0 * cv.k * xv;
  let q = vec2<f32>(px - xv, dot(rel, n) - curveY(cv.k, cv.L, xv));
  let u = curveNearest(q, cv.k, s0, -cv.L - xv, cv.xEnd - xv);
  var d = length(q - vec2<f32>(u, s0 * u - cv.k * u * u)) - halfWidth;
  if (EDGE_ARROWS && cv.arrowLen > 0.0) {
    let pa = curveArrowFrame(p, vec4<f32>(cv.tip, cv.tan));
    d = min(max(d, pa.x + curveCut(cv, halfWidth)), sdArrowhead(pa, 0.0, cv.arrowLen, curveArrowHalf(cv.arrowLen)));
  }
  return vec2<f32>(d, xv + u);
}
