// shared.js
// ============================================================
// freecam.js と ui.js の両方が使う、共有の定数・状態。
//
// 以前はアイソメトリック表示(renderer.js)と自由カメラの両方があったが、
// 両方とも「常にフル解像度」で中身が同じになったので、アイソメ表示を
// 廃止して自由カメラ一本にした。renderer.jsのうち、まだ両方から
// 参照されてた「面の形」「タイムラインの状態」だけをここに残してある。
// ============================================================

// 6方向それぞれの、ブロック単位立方体(0,0,0)〜(1,1,1)における面の4隅。
// Python側(build_2d_map.VOXEL_MESH_DIRS)と同じ順序:
// +x, -x, +y(上面), -y(底面), +z, -z
const FACE_OFFSETS = [
  [[1,0,0],[1,1,0],[1,1,1],[1,0,1]], // +x
  [[0,0,0],[0,0,1],[0,1,1],[0,1,0]], // -x
  [[0,1,0],[0,1,1],[1,1,1],[1,1,0]], // +y (上面)
  [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], // -y (底面)
  [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], // +z
  [[0,0,0],[0,1,0],[1,1,0],[1,0,0]], // -z
];
// 面の向きごとの簡易的な明暗係数(疑似的なライティング)。
// +y(上面)は一番明るく、-y(底面、ほぼ見えない)は一番暗い。
const DIR_FACTOR = [0.65, 0.55, 1.0, 0.35, 0.8, 0.7];

// ワールド座標の原点。ストリーミングで最初に届いた面から1回だけ決めて、
// それ以降は絶対に変えない(既にGPUへアップロード済みの頂点は、この原点を
// 基準にした相対座標で焼き込まれてるので、後から動かすと全部ズレる)。
let worldOriginX = 0, worldOriginY = 0, worldOriginZ = 0;
let worldOriginSet = false;

function setWorldOrigin(x, y, z) {
  if (worldOriginSet) return;
  worldOriginX = x; worldOriginY = y; worldOriginZ = z;
  worldOriginSet = true;
}

function resetWorldOrigin() {
  worldOriginX = worldOriginY = worldOriginZ = 0;
  worldOriginSet = false;
}

// --- タイムライン(プレイヤー位置)への参照。ui.js から渡される ---
let timeline = null;
let curTick = 0;

function setRendererTimeline(newTimeline) {
  timeline = newTimeline;
  curTick = 0;
}
