#include "common/layouts.wgsl"

@group(2) @binding(1) var<uniform> label : LabelParams;

const LABEL_GROUP_SLOTS : f32 = 4.0;
const LABEL_SLACK : f32 = 1.5;
const LABEL_EDGE_SLACK : f32 = 0.5;
const LABEL_FOREGROUND_RANK : f32 = 3.0e38;
const LABEL_EDGE_FIT : f32 = 0.7;
const LABEL_RAW_JOB : u32 = 0x80000000u;

fn levelOffset(levels : u32, level : u32) -> u32 {
  return (1u << (levels + 1u)) - (1u << (levels + 1u - level));
}

fn treeOffset(level : u32) -> u32 {
  return levelOffset(label.levels, level);
}

fn treeTop(level : u32, group : u32) -> u32 {
  return label.nodeCount + (treeOffset(level) + group) * LABEL_TREE_TOP;
}

fn edgeTreeOffset(level : u32) -> u32 {
  return levelOffset(label.edgeLevels, level);
}

fn edgeTreeTop(level : u32, group : u32) -> u32 {
  return (edgeTreeOffset(level) + group) * LABEL_TREE_TOP;
}

fn sizeKey(size : u32) -> u32 {
  return size & 0xFFFFu;
}
