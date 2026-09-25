#include "common/nodes.wgsl"
#include "common/icon_curves.wgsl"

@group(2) @binding(8) var iconSdf : texture_2d_array<f32>;
@group(2) @binding(9) var iconPalette : texture_2d<f32>;
@group(2) @binding(10) var<storage, read> iconData : array<u32>;

const ICON_SPAN : f32 = f32(ICON_TILE - 2u * ICON_TILE_PAD);
const ICON_EXACT_PX : f32 = 96.0;
const ICON_FADE_RATIO : f32 = 5.0 / 3.0;

struct IconAttrs {
  icon : u32,
  tint : vec4<f32>,
  size : vec2<f32>,
}

fn noIcon() -> IconAttrs {
  return IconAttrs(NO_ICON, vec4<f32>(0.0), vec2<f32>(0.0));
}

fn iconAttrs(word : u32, radiusPx : f32) -> IconAttrs {
  let icon = word & ICON_WORD_ID_MASK;
  if (icon == NO_ICON || !hasIconRoom(radiusPx)) {
    return noIcon();
  }
  let side = iconSidePx(radiusPx);
  let k = word >> ICON_WORD_COLOR_SHIFT;
  var tint = textureLoad(iconPalette, vec2<u32>(k % ICON_PALETTE_WIDTH, k / ICON_PALETTE_WIDTH), 0);
  tint.a *= smoothstep(ICON_MIN_PX, max(ICON_MIN_PX * ICON_FADE_RATIO, ICON_MIN_PX + 1.0), side);
  return IconAttrs(icon, tint, vec2<f32>(side, max(0.0, log2(ICON_SPAN / side))));
}

fn iconCoverage(icon : u32, uv : vec2<f32>, side : f32, lod : f32) -> f32 {
  let em = (uv / ICON_SCALE + 1.0) * 0.5;
  let tc = (em * ICON_SPAN + f32(ICON_TILE_PAD)) / f32(ICON_TILE);
  if (any(tc < vec2<f32>(0.0)) || any(tc > vec2<f32>(1.0))) {
    return 0.0;
  }
  if (side < ICON_EXACT_PX) {
    let d = textureSampleLevel(iconSdf, samp_linear, tc, icon, lod).r;
    return clamp(0.5 - d * side, 0.0, 1.0);
  }
  let d = textureSampleLevel(iconSdf, samp_linear, tc, icon, 0.0).r * side;
  let margin = side / ICON_SPAN + 0.5;
  if (d > margin) {
    return 0.0;
  }
  if (d < -margin) {
    return 1.0;
  }
  return exactCoverage(icon, em, side);
}

fn applyIcon(rgb : vec3<f32>, uv : vec2<f32>, icon : u32, tint : vec4<f32>, size : vec2<f32>) -> vec3<f32> {
  if (icon == NO_ICON) {
    return rgb;
  }
  return mix(rgb, tint.rgb, iconCoverage(icon, uv, size.x, size.y) * tint.a);
}
