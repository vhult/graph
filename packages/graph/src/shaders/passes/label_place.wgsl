#include "common/cull_state.wgsl"
#include "common/nodes.wgsl"
#include "common/edges.wgsl"
#include "common/labels.wgsl"

@group(2) @binding(2) var<storage, read> positions : array<vec2<f32>>;
@group(2) @binding(3) var<storage, read> sizes : array<u32>;
@group(2) @binding(4) var<storage, read> states : array<u32>;
@group(2) @binding(5) var<storage, read> order : array<u32>;
@group(2) @binding(6) var<storage, read> widths : array<u32>;
@group(2) @binding(7) var<storage, read> labelIndex : array<u32>;
@group(2) @binding(8) var<storage, read> treeBox : array<vec4<f32>>;
@group(2) @binding(9) var<storage, read_write> candidates : array<LabelCandidate>;
@group(2) @binding(10) var<storage, read_write> work : array<atomic<u32>>;
@group(2) @binding(11) var<storage, read_write> args : array<u32>;
@group(2) @binding(12) var<storage, read_write> cellCount : array<atomic<u32>>;
@group(2) @binding(13) var<storage, read_write> cellStart : array<u32>;
@group(2) @binding(14) var<storage, read_write> cellItems : array<u32>;
@group(2) @binding(15) var<storage, read_write> decision : array<atomic<u32>>;
@group(2) @binding(16) var<storage, read_write> lists : array<u32>;
@group(2) @binding(17) var<storage, read_write> neighbours : array<u32>;
@group(2) @binding(18) var<storage, read_write> shown : array<vec2<u32>>;
@group(2) @binding(19) var<uniform> phaseArg : vec4<u32>;
@group(2) @binding(20) var<storage, read> ends : array<vec2<u32>>;
@group(2) @binding(21) var<storage, read> edgeOrder : array<u32>;
@group(2) @binding(22) var<storage, read> edgeWidths : array<u32>;
@group(2) @binding(23) var<storage, read> edgeTops : array<u32>;
@group(2) @binding(24) var<storage, read> edgeTreeBox : array<vec4<f32>>;
@group(2) @binding(25) var<storage, read> edgeBits : array<u32>;
@group(2) @binding(26) var<storage, read> edgeTreeLen : array<f32>;

const UNDECIDED : u32 = 0u;
const SHOWN : u32 = 1u;
const HIDDEN : u32 = 2u;
const PER_GROUP : u32 = 64u / LABEL_LANES;
const NB_STRIDE : u32 = LABEL_NEIGHBOURS + 1u;

var<workgroup> wgFlag : array<atomic<u32>, PER_GROUP>;
var<workgroup> wgCount : array<atomic<u32>, PER_GROUP>;
var<workgroup> wgPart : array<u32, WORKGROUP_SIZE>;

fn writeArgs(slot : u32, groups : u32) {
  let a = slot * 4u;
  args[a] = min(groups, 65535u);
  args[a + 1u] = select(0u, (groups + 65534u) / 65535u, groups > 0u);
  args[a + 2u] = 1u;
}

fn laneGroups(n : u32) -> u32 {
  return (n + PER_GROUP - 1u) / PER_GROUP;
}

fn partSize(n : u32, parts : u32) -> u32 {
  return (n + parts - 1u) / parts;
}

fn partLength(n : u32, parts : u32, part : u32) -> u32 {
  let size = partSize(n, parts);
  return min(size, n - min(n, part * size));
}

fn candidateCount() -> u32 {
  return min(atomicLoad(&work[WORK_CANDIDATES]), label.capacity);
}

fn gridCol(x : f32) -> i32 {
  return i32(clamp(floor((x + label.maxHalfW) / label.cellW), 0.0, f32(label.gridW - 1u)));
}

fn gridRow(y : f32) -> i32 {
  return i32(clamp(floor((y + label.maxHalfH) / label.labelH), 0.0, f32(label.gridH - 1u)));
}

fn cellOf(p : vec2<f32>) -> u32 {
  return u32(gridRow(p.y)) * label.gridW + u32(gridCol(p.x));
}

fn overlaps(a : LabelCandidate, b : LabelCandidate) -> bool {
  return abs(a.center.x - b.center.x) < a.halfW + b.halfW && abs(a.center.y - b.center.y) < a.halfH + b.halfH;
}

fn above(a : LabelCandidate, b : LabelCandidate) -> bool {
  return a.rank > b.rank || (a.rank == b.rank && a.index < b.index);
}

fn screenBox(b : vec4<f32>) -> vec4<f32> {
  let p0 = worldToScreen(b.xy);
  let p1 = worldToScreen(vec2<f32>(b.z, b.y));
  let p2 = worldToScreen(vec2<f32>(b.x, b.w));
  let p3 = worldToScreen(b.zw);
  return vec4<f32>(min(min(p0, p1), min(p2, p3)), max(max(p0, p1), max(p2, p3)));
}

fn labelSlots(b : vec4<f32>) -> f32 {
  return (floor((b.z - b.x) / label.cellW) + 1.0) * (floor((b.w - b.y) / label.labelH) + 1.0);
}

struct Pick {
  level : u32,
  slots : f32,
  box : vec4<f32>,
  ok : bool,
}

fn pickGroup(c : u32, levels : u32, edges : bool) -> Pick {
  var p = Pick(0u, 0.0, vec4<f32>(0.0), false);
  for (var g = 0u; g <= levels; g++) {
    var b : vec4<f32>;
    if (edges) {
      b = edgeTreeBox[edgeTreeOffset(g) + (c >> g)];
    } else {
      b = treeBox[treeOffset(g) + (c >> g)];
    }
    if (b.x > b.z) {
      return p;
    }
    let s = screenBox(b);
    let n = labelSlots(s);
    if (g > 0u && n > LABEL_GROUP_SLOTS) {
      break;
    }
    p = Pick(g, n, s, true);
    if (n > LABEL_GROUP_SLOTS) {
      break;
    }
  }
  let m = label.maxHalfW + 2.0 * label.maxHalfH;
  let box = p.box;
  p.ok = p.ok && (c & ((1u << p.level) - 1u)) == 0u
    && !(box.z < -m || box.w < -m || box.x > frame.viewportPx.x + m || box.y > frame.viewportPx.y + m);
  return p;
}

fn pushJob(counter : u32, base : u32, start : u32, count : u32) {
  let j = atomicAdd(&work[counter], 1u);
  atomicStore(&work[base + 2u * j], start);
  atomicStore(&work[base + 2u * j + 1u], count);
}

fn wanted(slots : f32, slack : f32) -> u32 {
  return u32(max(1.0, floor(slots * slack)));
}

@compute @workgroup_size(64)
fn label_traverse(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nwg : vec3<u32>) {
  let c = gid.x + gid.y * nwg.x * 64u;
  if (c >= label.chunks) {
    return;
  }
  let p = pickGroup(c, label.levels, false);
  if (!p.ok) {
    return;
  }
  let k = wanted(p.slots, LABEL_SLACK);
  if (p.level == 0u && k > LABEL_TREE_TOP) {
    let start = c * CHUNK_SIZE;
    pushJob(WORK_JOBS, WORK_JOB_LIST, start, min(min(k, CHUNK_SIZE), label.nodeCount - start));
  } else {
    pushJob(WORK_JOBS, WORK_JOB_LIST, treeTop(p.level, c >> p.level), min(k, LABEL_TREE_TOP));
  }
}

@compute @workgroup_size(64)
fn label_traverse_edges(@builtin(global_invocation_id) gid : vec3<u32>, @builtin(num_workgroups) nwg : vec3<u32>) {
  let c = gid.x + gid.y * nwg.x * 64u;
  if (c >= label.edgeChunks) {
    return;
  }
  let p = pickGroup(c, label.edgeLevels, true);
  if (!p.ok || edgeTreeLen[edgeTreeOffset(p.level) + (c >> p.level)] * frame.zoom * LABEL_EDGE_FIT < label.minEdgeW) {
    return;
  }
  let k = wanted(p.slots, LABEL_EDGE_SLACK);
  let base = WORK_JOB_LIST + 2u * label.chunks;
  if (p.level == 0u && k > LABEL_TREE_TOP) {
    let start = c * EDGE_CHUNK_SIZE;
    pushJob(WORK_EDGE_JOBS, base, start | LABEL_RAW_JOB, min(min(k, EDGE_CHUNK_SIZE), label.edgeCount - start));
  } else {
    pushJob(WORK_EDGE_JOBS, base, edgeTreeTop(p.level, c >> p.level), min(k, LABEL_TREE_TOP));
  }
}

@compute @workgroup_size(1)
fn label_job_args() {
  writeArgs(ARGS_JOBS, atomicLoad(&work[WORK_JOBS]));
  let edgeJobs = atomicLoad(&work[WORK_EDGE_JOBS]);
  for (var p = 0u; p < LABEL_EDGE_PARTS; p++) {
    writeArgs(ARGS_EDGE_JOBS + p, partLength(edgeJobs, LABEL_EDGE_PARTS, p));
  }
}

fn pushCandidate(c : LabelCandidate) {
  if (c.center.x + c.halfW < 0.0 || c.center.x - c.halfW > frame.viewportPx.x || c.center.y + c.halfH < 0.0 || c.center.y - c.halfH > frame.viewportPx.y) {
    return;
  }
  let slot = atomicAdd(&work[WORK_CANDIDATES], 1u);
  if (slot < label.capacity) {
    candidates[slot] = c;
    atomicMax(&work[WORK_MAX_HALF_W], bitcast<u32>(c.halfW));
    atomicMax(&work[WORK_MAX_HALF_H], bitcast<u32>(c.halfH));
  }
}

fn emitNode(i : u32) {
  if (i == LABEL_NONE || (states[i] & STATE_HIDDEN) != 0u) {
    return;
  }
  let user = order[i];
  let w = f32((widths[user >> 1u] >> ((user & 1u) * 16u)) & 0xFFFFu);
  if (w == 0.0) {
    return;
  }
  let sp = worldToScreen(positions[i]);
  let size = unpack2x16float(sizes[i]).x;
  let r = max(sizeRadiusPx(size), NODE_MIN_DRAW_RADIUS_PX);
  let center = vec2<f32>(sp.x, sp.y + r + label.gap + label.textH * 0.5);
  var rank = size * select(1.0, label.bonus, isLabelled(i, label.chunks));
  if ((states[i] & STATE_FOREGROUND_MASK) != 0u) {
    rank = LABEL_FOREGROUND_RANK;
  }
  pushCandidate(LabelCandidate(center, (w + label.padding) * 0.5, label.labelH * 0.5, rank, i, size));
}

fn emitEdge(e : u32) {
  if (e == LABEL_NONE) {
    return;
  }
  let ij = ends[e];
  let a = worldToScreen(positions[ij.x]);
  let b = worldToScreen(positions[ij.y]);
  let len = distance(a, b);
  if (len * LABEL_EDGE_FIT < label.minEdgeW) {
    return;
  }
  let user = edgeOrder[e];
  let w = f32((edgeWidths[user >> 1u] >> ((user & 1u) * 16u)) & 0xFFFFu);
  if (w == 0.0 || w > len * LABEL_EDGE_FIT) {
    return;
  }
  let d = abs(b - a) / len;
  let labelled = ((edgeBits[e >> 5u] >> (e & 31u)) & 1u) != 0u;
  let rank = -1.0 / (len * select(1.0, label.bonus, labelled));
  let hw = (w * d.x + label.textH * d.y + label.padding) * 0.5;
  let hh = (w * d.y + label.textH * d.x + label.padding) * 0.5;
  pushCandidate(LabelCandidate((a + b) * 0.5, hw, hh, rank, e | LABEL_EDGE_BIT, len));
}

@compute @workgroup_size(64)
fn label_emit(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let j = wid.x + wid.y * nwg.x;
  if (j >= atomicLoad(&work[WORK_JOBS])) {
    return;
  }
  let start = atomicLoad(&work[WORK_JOB_LIST + 2u * j]);
  let count = atomicLoad(&work[WORK_JOB_LIST + 2u * j + 1u]);
  for (var t = lid; t < count; t += 64u) {
    emitNode(labelIndex[start + t]);
  }
}

@compute @workgroup_size(64)
fn label_emit_edges(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let jobs = atomicLoad(&work[WORK_EDGE_JOBS]);
  let j = wid.x + wid.y * nwg.x + phaseArg.x * partSize(jobs, LABEL_EDGE_PARTS);
  if (j >= jobs) {
    return;
  }
  let base = WORK_JOB_LIST + 2u * label.chunks;
  let start = atomicLoad(&work[base + 2u * j]);
  let count = atomicLoad(&work[base + 2u * j + 1u]);
  for (var t = lid; t < count; t += 64u) {
    if ((start & LABEL_RAW_JOB) != 0u) {
      emitEdge((start & ~LABEL_RAW_JOB) + t);
    } else {
      emitEdge(edgeTops[start + t]);
    }
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_count(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x < candidateCount()) {
    atomicAdd(&cellCount[cellOf(candidates[gid.x].center)], 1u);
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_scan(@builtin(local_invocation_index) lid : u32) {
  let cells = label.gridW * label.gridH;
  let per = (cells + WORKGROUP_SIZE - 1u) / WORKGROUP_SIZE;
  let c0 = min(lid * per, cells);
  let c1 = min(c0 + per, cells);
  var sum = 0u;
  for (var c = c0; c < c1; c++) {
    sum += atomicLoad(&cellCount[c]);
  }
  wgPart[lid] = sum;
  workgroupBarrier();
  for (var o = 1u; o < WORKGROUP_SIZE; o = o << 1u) {
    var v = 0u;
    if (lid >= o) {
      v = wgPart[lid - o];
    }
    workgroupBarrier();
    wgPart[lid] += v;
    workgroupBarrier();
  }
  var run = wgPart[lid] - sum;
  for (var c = c0; c < c1; c++) {
    let v = atomicLoad(&cellCount[c]);
    cellStart[c] = run;
    atomicStore(&cellCount[c], 0u);
    run += v;
  }
  if (lid == WORKGROUP_SIZE - 1u) {
    cellStart[cells] = wgPart[lid];
  }
  if (lid == 0u) {
    let n = candidateCount();
    for (var p = 0u; p < LABEL_LIST_PARTS; p++) {
      writeArgs(ARGS_LISTS + p, laneGroups(partLength(n, LABEL_LIST_PARTS, p)));
    }
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_scatter(@builtin(global_invocation_id) gid : vec3<u32>) {
  let k = gid.x;
  if (k >= candidateCount()) {
    return;
  }
  let c = cellOf(candidates[k].center);
  cellItems[cellStart[c] + atomicAdd(&cellCount[c], 1u)] = k;
  atomicStore(&decision[k], UNDECIDED);
}

struct Span {
  x0 : i32,
  y0 : i32,
  nx : i32,
  total : u32,
}

fn searchSpan(b : LabelCandidate) -> Span {
  let mw = bitcast<f32>(atomicLoad(&work[WORK_MAX_HALF_W]));
  let mh = bitcast<f32>(atomicLoad(&work[WORK_MAX_HALF_H]));
  let x0 = gridCol(b.center.x - b.halfW - mw);
  let x1 = gridCol(b.center.x + b.halfW + mw);
  let y0 = gridRow(b.center.y - b.halfH - mh);
  let y1 = gridRow(b.center.y + b.halfH + mh);
  let nx = x1 - x0 + 1;
  return Span(x0, y0, nx, u32(nx * (y1 - y0 + 1)));
}

fn spanCell(s : Span, c : u32) -> u32 {
  return u32(s.y0 + i32(c) / s.nx) * label.gridW + u32(s.x0 + i32(c) % s.nx);
}

@compute @workgroup_size(64)
fn label_build(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let slot = lid / LABEL_LANES;
  let lane = lid % LABEL_LANES;
  let n = candidateCount();
  let q = (wid.x + wid.y * nwg.x) * PER_GROUP + slot;
  let k = q + phaseArg.x * partSize(n, LABEL_LIST_PARTS);
  let live = q < partLength(n, LABEL_LIST_PARTS, phaseArg.x);
  if (lid < PER_GROUP) {
    atomicStore(&wgCount[lid], 0u);
  }
  workgroupBarrier();
  if (live) {
    let b = candidates[k];
    let s = searchSpan(b);
    for (var c = 0u; c < s.total; c++) {
      let cc = spanCell(s, c);
      let e = cellStart[cc + 1u];
      for (var p = cellStart[cc] + lane; p < e; p += LABEL_LANES) {
        let j = cellItems[p];
        let o = candidates[j];
        if (overlaps(o, b) && above(o, b)) {
          let at = atomicAdd(&wgCount[slot], 1u);
          if (at < LABEL_NEIGHBOURS) {
            neighbours[k * NB_STRIDE + 1u + at] = j;
          }
        }
      }
    }
  }
  workgroupBarrier();
  if (live && lane == 0u) {
    let count = atomicLoad(&wgCount[slot]);
    neighbours[k * NB_STRIDE] = count;
    if (count == 0u) {
      atomicStore(&decision[k], SHOWN);
    } else {
      lists[atomicAdd(&work[WORK_ROUND], 1u)] = k;
    }
  }
}

@compute @workgroup_size(1)
fn label_first_args() {
  writeArgs(ARGS_ROUND, laneGroups(atomicLoad(&work[WORK_ROUND])));
}

@compute @workgroup_size(64)
fn label_round(
  @builtin(workgroup_id) wid : vec3<u32>,
  @builtin(num_workgroups) nwg : vec3<u32>,
  @builtin(local_invocation_index) lid : u32,
) {
  let r = phaseArg.x;
  let slot = lid / LABEL_LANES;
  let lane = lid % LABEL_LANES;
  let q = (wid.x + wid.y * nwg.x) * PER_GROUP + slot;
  let inBase = (r % 2u) * label.capacity;
  let outBase = ((r + 1u) % 2u) * label.capacity;
  if (lid < PER_GROUP) {
    atomicStore(&wgFlag[lid], 0u);
  }
  workgroupBarrier();
  let live = q < atomicLoad(&work[WORK_ROUND + r]);
  var k = 0u;
  if (live) {
    k = lists[inBase + q];
    let count = neighbours[k * NB_STRIDE];
    if (count <= LABEL_NEIGHBOURS) {
      for (var p = lane; p < count; p += LABEL_LANES) {
        let t = atomicLoad(&decision[neighbours[k * NB_STRIDE + 1u + p]]);
        if (t == SHOWN) {
          atomicOr(&wgFlag[slot], 2u);
          break;
        }
        if (t == UNDECIDED) {
          atomicOr(&wgFlag[slot], 1u);
        }
      }
    } else {
      let b = candidates[k];
      let s = searchSpan(b);
      var done = false;
      for (var c = 0u; c < s.total && !done; c++) {
        let cc = spanCell(s, c);
        let e = cellStart[cc + 1u];
        for (var p = cellStart[cc] + lane; p < e; p += LABEL_LANES) {
          let j = cellItems[p];
          let o = candidates[j];
          if (overlaps(o, b) && above(o, b)) {
            let t = atomicLoad(&decision[j]);
            if (t == SHOWN) {
              atomicOr(&wgFlag[slot], 2u);
              done = true;
              break;
            }
            if (t == UNDECIDED) {
              atomicOr(&wgFlag[slot], 1u);
            }
          }
        }
        if ((atomicLoad(&wgFlag[slot]) & 2u) != 0u) {
          done = true;
        }
      }
    }
  }
  workgroupBarrier();
  if (live && lane == 0u) {
    let f = atomicLoad(&wgFlag[slot]);
    if ((f & 2u) != 0u) {
      atomicStore(&decision[k], HIDDEN);
    } else if (f == 0u) {
      atomicStore(&decision[k], SHOWN);
    } else {
      lists[outBase + atomicAdd(&work[WORK_ROUND + r + 1u], 1u)] = k;
    }
  }
}

@compute @workgroup_size(1)
fn label_next_args() {
  let r = phaseArg.x;
  writeArgs(ARGS_ROUND + r + 1u, laneGroups(atomicLoad(&work[WORK_ROUND + r + 1u])));
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn label_collect(@builtin(global_invocation_id) gid : vec3<u32>) {
  let k = gid.x;
  if (k >= candidateCount() || atomicLoad(&decision[k]) != SHOWN) {
    return;
  }
  let s = atomicAdd(&work[WORK_SHOWN], 1u);
  if (s < LABEL_SHOWN_MAX) {
    let i = candidates[k].index;
    if ((i & LABEL_EDGE_BIT) != 0u) {
      shown[s] = vec2<u32>(i, edgeOrder[i & ~LABEL_EDGE_BIT]);
    } else {
      shown[s] = vec2<u32>(i, order[i]);
    }
  }
}
