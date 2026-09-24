/**
 * Virtual file system of engine shaders, bundled as text by esbuild.
 * Paths are what `#include` directives reference.
 */
import camera from "./common/camera.wgsl";
import cullState from "./common/cull_state.wgsl";
import edges from "./common/edges.wgsl";
import labels from "./common/labels.wgsl";
import layouts from "./common/layouts.wgsl";
import morton from "./common/morton.wgsl";
import nodes from "./common/nodes.wgsl";
import pick from "./common/pick.wgsl";
import scan from "./common/scan.wgsl";
import sdf from "./common/sdf.wgsl";
import chunkBounds from "./passes/chunk_bounds.wgsl";
import edgeCull from "./passes/edge_cull.wgsl";
import edgeExpand from "./passes/edge_expand.wgsl";
import edgeGeometry from "./passes/edge_geometry.wgsl";
import edgeSort from "./passes/edge_sort.wgsl";
import gather from "./passes/gather.wgsl";
import hover from "./passes/hover.wgsl";
import labelDraw from "./passes/label_draw.wgsl";
import labelMark from "./passes/label_mark.wgsl";
import labelPlace from "./passes/label_place.wgsl";
import labelTree from "./passes/label_tree.wgsl";
import nodeGeometry from "./passes/node_geometry.wgsl";
import pickEdges from "./passes/pick_edges.wgsl";
import pickNodes from "./passes/pick_nodes.wgsl";
import scatterUpdate from "./passes/scatter_update.wgsl";
import shuffleChunks from "./passes/shuffle_chunks.wgsl";
import sort from "./passes/sort.wgsl";
import transformCull from "./passes/transform_cull.wgsl";
import type { ShaderFs } from "./preprocess/Preprocessor";

export const SHADERS: ShaderFs = {
  "common/layouts.wgsl": layouts,
  "common/camera.wgsl": camera,
  "common/sdf.wgsl": sdf,
  "common/nodes.wgsl": nodes,
  "common/edges.wgsl": edges,
  "common/labels.wgsl": labels,
  "common/morton.wgsl": morton,
  "common/scan.wgsl": scan,
  "common/cull_state.wgsl": cullState,
  "common/pick.wgsl": pick,
  "passes/chunk_bounds.wgsl": chunkBounds,
  "passes/edge_cull.wgsl": edgeCull,
  "passes/edge_expand.wgsl": edgeExpand,
  "passes/edge_geometry.wgsl": edgeGeometry,
  "passes/edge_sort.wgsl": edgeSort,
  "passes/gather.wgsl": gather,
  "passes/hover.wgsl": hover,
  "passes/label_draw.wgsl": labelDraw,
  "passes/label_mark.wgsl": labelMark,
  "passes/label_place.wgsl": labelPlace,
  "passes/label_tree.wgsl": labelTree,
  "passes/node_geometry.wgsl": nodeGeometry,
  "passes/pick_edges.wgsl": pickEdges,
  "passes/pick_nodes.wgsl": pickNodes,
  "passes/scatter_update.wgsl": scatterUpdate,
  "passes/shuffle_chunks.wgsl": shuffleChunks,
  "passes/sort.wgsl": sort,
  "passes/transform_cull.wgsl": transformCull,
};
