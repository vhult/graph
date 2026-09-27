#include "common/icon_curves.wgsl"

struct SdfParams {
  res : u32,
  layers : u32,
  rowWords : u32,
  gridX : u32,
}

@group(2) @binding(0) var<uniform> sdf : SdfParams;
@group(2) @binding(1) var<storage, read> iconData : array<u32>;
@group(2) @binding(2) var<storage, read_write> sdfOut : array<u32>;
@group(2) @binding(3) var<storage, read_write> boundary : array<u32>;

const SDF_WG : u32 = 64u;
const EDGE_SAMPLES : u32 = 32u;
const EDGE_PROBE : f32 = 1e-4;
const RANGE_TEXELS : f32 = 4.0;

fn curvePoint(p12 : vec4<f32>, p3 : vec2<f32>, t : f32) -> vec2<f32> {
  let u = 1.0 - t;
  return u * u * p12.xy + 2.0 * u * t * p12.zw + t * t * p3;
}

fn curveTangent(p12 : vec4<f32>, p3 : vec2<f32>, t : f32) -> vec2<f32> {
  return 2.0 * ((1.0 - t) * (p12.zw - p12.xy) + t * (p3 - p12.zw));
}

fn curveDistance2(p : vec2<f32>, p12 : vec4<f32>, p3 : vec2<f32>) -> f32 {
  let a = p12.xy;
  let b = p12.zw;
  let c = p3;
  var best = 1e30;
  var bt = 0.0;
  for (var k = 0u; k <= 8u; k++) {
    let t = f32(k) / 8.0;
    let q = curvePoint(p12, p3, t) - p;
    let d = dot(q, q);
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  var t = bt;
  for (var it = 0u; it < 4u; it++) {
    let u = 1.0 - t;
    let q = u * u * a + 2.0 * u * t * b + t * t * c - p;
    let d1 = 2.0 * (u * (b - a) + t * (c - b));
    let d2 = 2.0 * (a - 2.0 * b + c);
    let g = dot(q, d1);
    let h = dot(d1, d1) + dot(q, d2);
    if (abs(h) < 1e-12) {
      break;
    }
    t = clamp(t - g / h, 0.0, 1.0);
  }
  let q = curvePoint(p12, p3, t) - p;
  return min(best, dot(q, q));
}

fn segmentDistance2(p : vec2<f32>, a : vec2<f32>, b : vec2<f32>) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-20), 0.0, 1.0);
  let q = a + ab * t - p;
  return dot(q, q);
}

fn inside(rec : IconRecord, p : vec2<f32>) -> bool {
  let by = min(u32(clamp(p.y, 0.0, 1.0) * f32(rec.nb)), rec.nb - 1u);
  let band = iconBand(rec, by);
  var w = 0i;
  for (var k = 0u; k < band.y; k++) {
    let cw = iconData[band.x + k];
    let p12 = curveP12(cw) - vec4<f32>(p, p);
    let p3 = curveP3(cw) - p;
    if (max(max(p12.x, p12.z), p3.x) < 0.0) {
      break;
    }
    let code = crossingCode(p12, p3);
    if (code == 0u) {
      continue;
    }
    let x = crossingX(p12, p3);
    if ((code & 1u) != 0u && x.x > 0.0) {
      w += 1i;
    }
    if (code > 1u && x.y > 0.0) {
      w -= 1i;
    }
  }
  return select(w != 0i, (abs(w) & 1i) != 0i, rec.evenOdd);
}

fn curveSlot(w : u32) -> u32 {
  return (w - iconData[1]) / ICON_CURVE_WORDS;
}

@compute @workgroup_size(SDF_WG)
fn icon_boundary(@builtin(global_invocation_id) gid : vec3<u32>) {
  let icon = gid.y;
  if (icon >= iconData[0]) {
    return;
  }
  let rec = iconRecord(icon);
  if (gid.x >= rec.count) {
    return;
  }
  let w = rec.curves + gid.x * ICON_CURVE_WORDS;
  let p12 = curveP12(w);
  let p3 = curveP3(w);
  var mask = 0u;
  for (var j = 0u; j < EDGE_SAMPLES; j++) {
    let t = (f32(j) + 0.5) / f32(EDGE_SAMPLES);
    let q = curvePoint(p12, p3, t);
    let d = curveTangent(p12, p3, t);
    let n = vec2<f32>(-d.y, d.x) * (EDGE_PROBE / max(length(d), 1e-12));
    if (inside(rec, q + n) != inside(rec, q - n)) {
      mask |= 1u << j;
    }
  }
  boundary[curveSlot(w)] = mask;
}

fn signedDistance(icon : u32, tx : u32, ty : u32) -> f32 {
  let rec = iconRecord(icon);
  let scale = f32(ICON_TILE) / f32(sdf.res);
  let t = (vec2<f32>(f32(tx), f32(ty)) + 0.5) * scale;
  let span = f32(ICON_TILE - 2u * ICON_TILE_PAD);
  let p = (t - f32(ICON_TILE_PAD)) / span;
  let range = RANGE_TEXELS * scale / span;
  var best = range * range;
  for (var k = 0u; k < rec.count; k++) {
    let w = rec.curves + k * ICON_CURVE_WORDS;
    let mask = boundary[curveSlot(w)];
    if (mask == 0u) {
      continue;
    }
    let p12 = curveP12(w);
    let p3 = curveP3(w);
    let lo = min(min(p12.xy, p12.zw), p3);
    let hi = max(max(p12.xy, p12.zw), p3);
    let out = max(max(lo - p, p - hi), vec2<f32>(0.0));
    if (dot(out, out) >= best) {
      continue;
    }
    if (mask == 0xFFFFFFFFu) {
      best = min(best, curveDistance2(p, p12, p3));
      continue;
    }
    for (var j = 0u; j < EDGE_SAMPLES; j++) {
      if ((mask & (1u << j)) != 0u) {
        let a = curvePoint(p12, p3, f32(j) / f32(EDGE_SAMPLES));
        let b = curvePoint(p12, p3, f32(j + 1u) / f32(EDGE_SAMPLES));
        best = min(best, segmentDistance2(p, a, b));
      }
    }
  }
  let d = sqrt(best);
  return select(d, -d, rec.count > 0u && inside(rec, p));
}

@compute @workgroup_size(SDF_WG)
fn icon_sdf(@builtin(global_invocation_id) gid : vec3<u32>) {
  let pairs = sdf.res / 2u;
  let perLayer = pairs * sdf.res;
  let id = gid.x + gid.y * sdf.gridX * SDF_WG;
  if (id >= perLayer * sdf.layers) {
    return;
  }
  let layer = id / perLayer;
  let r = id % perLayer;
  let y = r / pairs;
  let x = (r % pairs) * 2u;
  let d0 = signedDistance(layer, x, y);
  let d1 = signedDistance(layer, x + 1u, y);
  sdfOut[(layer * sdf.res + y) * sdf.rowWords + x / 2u] = pack2x16float(vec2<f32>(d0, d1));
}
