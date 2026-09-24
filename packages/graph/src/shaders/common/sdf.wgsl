// Built-in shape SDFs. Distances are in units where 1.0 = node radius;
// negative inside. The full shape table lands with the hook system (M7).

fn sdCircle(p : vec2<f32>) -> f32 {
  return length(p) - 1.0;
}

fn sdSquare(p : vec2<f32>) -> f32 {
  let d = abs(p) - vec2<f32>(1.0);
  return length(max(d, vec2<f32>(0.0))) + min(max(d.x, d.y), 0.0);
}

const HEX_K : vec3<f32> = vec3<f32>(-0.866025404, 0.5, 0.577350269);
const HEX_INRADIUS : f32 = 0.866025404;

fn sdHexagon(p : vec2<f32>) -> f32 {
  var q = abs(p);
  q -= 2.0 * min(dot(HEX_K.xy, q), 0.0) * HEX_K.xy;
  q -= vec2<f32>(clamp(q.x, -HEX_K.z * HEX_INRADIUS, HEX_K.z * HEX_INRADIUS), HEX_INRADIUS);
  return length(q) * sign(q.y);
}

fn sdShape(p : vec2<f32>, shape : u32) -> f32 {
  switch (shape) {
    case SHAPE_SQUARE: {
      return sdSquare(p);
    }
    case SHAPE_HEXAGON: {
      return sdHexagon(p);
    }
    default: {
      return sdCircle(p);
    }
  }
}

fn shapeReach(dir : vec2<f32>, shape : u32) -> f32 {
  let d = abs(dir);
  switch (shape) {
    case SHAPE_SQUARE: {
      return 1.0 / max(d.x, d.y);
    }
    case SHAPE_HEXAGON: {
      return HEX_INRADIUS / max(d.y, HEX_INRADIUS * d.x + 0.5 * d.y);
    }
    default: {
      return 1.0;
    }
  }
}

/** Distance to a capsule of half-length `halfLen` and radius `halfWidth`. */
fn sdSegment(p : vec2<f32>, halfLen : f32, halfWidth : f32) -> f32 {
  let q = vec2<f32>(max(abs(p.x) - halfLen, 0.0), p.y);
  return length(q) - halfWidth;
}

/**
 * Isosceles arrowhead with its tip at (tipX, 0), opening backwards along -x:
 * the intersection of its two slanted sides and its base. Exact outside the
 * dominant plane, slightly conservative at the corners, which a 1 px coverage
 * ramp hides, and much cheaper than an exact triangle.
 */
fn sdArrowhead(p : vec2<f32>, tipX : f32, len : f32, half : f32) -> f32 {
  let q = vec2<f32>(p.x - tipX, abs(p.y));
  let slant = dot(q, vec2<f32>(half, len)) * inverseSqrt(half * half + len * len);
  return max(slant, -(q.x + len));
}
