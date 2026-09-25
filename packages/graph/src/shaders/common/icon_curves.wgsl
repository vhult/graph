#include "common/layouts.wgsl"

const ICON_TILE_PAD : u32 = 2u;

struct IconRecord {
  bands : u32,
  nb : u32,
  evenOdd : bool,
  curves : u32,
  count : u32,
}

fn iconRecord(icon : u32) -> IconRecord {
  let r = ICON_HEADER_WORDS + icon * ICON_RECORD_WORDS;
  let w = iconData[r + 1u];
  return IconRecord(iconData[r], w & ICON_BANDS_MASK, (w & ICON_FLAG_EVEN_ODD) != 0u, iconData[r + 2u], iconData[r + 3u]);
}

fn fillCoverage(winding : f32, evenOdd : bool) -> f32 {
  let w = abs(winding);
  if (evenOdd) {
    return 1.0 - abs(1.0 - (w - 2.0 * floor(w * 0.5)));
  }
  return min(w, 1.0);
}

fn curveP12(w : u32) -> vec4<f32> {
  return bitcast<vec4<f32>>(vec4<u32>(iconData[w], iconData[w + 1u], iconData[w + 2u], iconData[w + 3u]));
}

fn curveP3(w : u32) -> vec2<f32> {
  return bitcast<vec2<f32>>(vec2<u32>(iconData[w + 4u], iconData[w + 5u]));
}

fn crossingCode(p12 : vec4<f32>, p3 : vec2<f32>) -> u32 {
  return (0x2E74u >> (select(0u, 2u, p12.y > 0.0) + select(0u, 4u, p12.w > 0.0) + select(0u, 8u, p3.y > 0.0))) & 3u;
}

fn crossingX(p12 : vec4<f32>, p3 : vec2<f32>) -> vec2<f32> {
  let ax = p12.x - p12.z * 2.0 + p3.x;
  let ay = p12.y - p12.w * 2.0 + p3.y;
  let bx = p12.x - p12.z;
  let by = p12.y - p12.w;
  var t1 : f32;
  var t2 : f32;
  if (abs(ay) < 1.0 / 65536.0) {
    t1 = p12.y * 0.5 / by;
    t2 = t1;
  } else {
    let ra = 1.0 / ay;
    let d = sqrt(max(by * by - ay * p12.y, 0.0));
    t1 = (by - d) * ra;
    t2 = (by + d) * ra;
  }
  return vec2<f32>((ax * t1 - bx * 2.0) * t1 + p12.x, (ax * t2 - bx * 2.0) * t2 + p12.x);
}

fn bandCoverage(band : vec2<u32>, p : vec2<f32>, ppe : f32, vertical : bool, minus : bool) -> f32 {
  var cov = 0.0;
  let base = select(band.x, band.x + band.y, minus);
  for (var k = 0u; k < band.y; k++) {
    let w = iconData[base + k];
    var p12 = curveP12(w) - vec4<f32>(p, p);
    var p3 = curveP3(w) - p;
    if (vertical) {
      p12 = p12.yxwz;
      p3 = p3.yx;
    }
    if (minus) {
      if (min(min(p12.x, p12.z), p3.x) * ppe > 0.5) {
        break;
      }
    } else if (max(max(p12.x, p12.z), p3.x) * ppe < -0.5) {
      break;
    }
    let code = crossingCode(p12, p3);
    if (code == 0u) {
      continue;
    }
    let x = clamp(crossingX(p12, p3) * ppe + 0.5, vec2<f32>(0.0), vec2<f32>(1.0));
    if (minus) {
      cov += select(0.0, x.x - 1.0, (code & 1u) != 0u) + select(0.0, 1.0 - x.y, code > 1u);
    } else {
      cov += select(0.0, x.x, (code & 1u) != 0u) - select(0.0, x.y, code > 1u);
    }
  }
  return cov;
}

fn iconBand(rec : IconRecord, k : u32) -> vec2<u32> {
  let w = rec.bands + 2u * k;
  return vec2<u32>(iconData[w], iconData[w + 1u]);
}

fn exactCoverage(icon : u32, p : vec2<f32>, ppe : f32) -> f32 {
  let rec = iconRecord(icon);
  let fb = f32(rec.nb);
  let by = min(u32(clamp(p.y, 0.0, 1.0) * fb), rec.nb - 1u);
  let bx = min(u32(clamp(p.x, 0.0, 1.0) * fb), rec.nb - 1u);
  let hc = bandCoverage(iconBand(rec, by), p, ppe, false, p.x < 0.5);
  let vc = bandCoverage(iconBand(rec, rec.nb + bx), p, ppe, true, p.y < 0.5);
  return (fillCoverage(hc, rec.evenOdd) + fillCoverage(vc, rec.evenOdd)) * 0.5;
}
