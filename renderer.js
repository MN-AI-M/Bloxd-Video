// renderer.js
// ============================================================
// 「表示の計算」だけを担当するファイル。座標変換・描画・パン/ズーム・
// プレイヤーマーカーの描画など。UI(ボタンやアップロード処理)は
// ui.js の方を見てください。
//
// v4: データモデルを「列ごとの高さマップ+断面色」から、
//     build_2d_map.build_voxel_mesh_from_decoded() が出す
//     「面カリング済みのボクセルメッシュ(faces)」に変更した。
//     一般的なボクセルレンダラー(Minecraft系)と同じ発想:
//     各面は「空気(または未記録)に接している面だけ」なので、
//     地中に埋まってるブロックは自動的に無視され、縦に離れた
//     複数の構造物も特別扱いなしで正しく表示される。
//     v3であった「かたまり(run)検出」や装飾ノイズ除去の閾値は
//     もう不要になったので削除した。
//
// 頂点の実座標変換(アイソメトリック投影)と奥行き(depth)の計算は
// 両方ともGPU側(頂点シェーダー)で行う。CPU側は「ブロックのローカル
// 座標+色」を渡すだけで、パン/ズームはuniform更新のみで反映される。
// ============================================================

const TILE_SIZE = 16;
const ISO_W = TILE_SIZE, ISO_H = TILE_SIZE / 2;
const Y_SCALE = ISO_H * 0.6;
const DEPTH_Y_FACTOR = ISO_H / Y_SCALE; // 奥行き計算で使う、Y方向の重み(下の解説参照)

const MAX_VERTS = 6000000; // 頂点数の全体上限(超えたらクラッシュではなく打ち切って警告)

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

// --- 描画対象のデータ(ui.js から setRendererMesh() で渡される) ---
let meshFaces = null;       // [[x,y,z,dirCode,paletteIdx], ...]
let meshPalette = null;     // [{root_name, texture, model, asset_type}, ...] (色はまだ解決されてない)
let paletteColorsRaw = null;// meshPaletteと同じ並びで、解決済みの色文字列("rgb(...)"等)
let isoMinX, isoMaxX, isoMinZ, isoMaxZ, isoMinY, isoMaxY, isoOriginX;
let depthNorm = 1;          // 奥行きの正規化係数(1/最大値)

// ホバー時のブロック名表示専用の簡易インデックス。
// (x,z)列ごとに、一番上の「上面(+y)」を持つブロックだけを覚えておく。
// 描画のジオメトリとは無関係で、ツールチップ表示のためだけに使う。
let hoverIndex = null;

// --- キャンバス / WebGL ---
let canvas, gl, program, vbo;
let playerCanvas, pctx;
let aPosLoc, aColorLoc, uPanLoc, uZoomLoc, uResLoc, uIsoOriginXLoc, uDepthNormLoc;
let vertexCount = 0;

// --- 表示状態 ---
let zoom = 1, panX = 0, panY = 0;
let lastPlayerScreenPos = [0, 0]; // iso-pixel空間(ズーム適用前)でのプレイヤー座標

// --- タイムライン(プレイヤー位置)への参照。ui.js から渡される ---
let timeline = null;
let curTick = 0;


// ============================================================
// 色の計算
// ============================================================

function parseColor(str) {
  if (!str) return [136, 136, 136];
  let m = str.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (m) return [+m[1], +m[2], +m[3]];
  m = str.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const h = m[1];
    return [parseInt(h[0]+h[0], 16), parseInt(h[1]+h[1], 16), parseInt(h[2]+h[2], 16)];
  }
  m = str.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const h = m[1];
    return [parseInt(h.slice(0,2), 16), parseInt(h.slice(2,4), 16), parseInt(h.slice(4,6), 16)];
  }
  return [136, 136, 136];
}

function shadeColorRGB(str, factor) {
  const [r, g, b] = parseColor(str);
  const clamp = v => Math.max(0, Math.min(255, v * factor)) / 255;
  return [clamp(r), clamp(g), clamp(b)];
}


// ============================================================
// 初期化(データ)
// ============================================================

// ui.js から、Pythonが返したメッシュ(まだ色は解決されてない)を渡す。
// この時点ではジオメトリはまだ作らない(パレットの色が決まってから)。
function setRendererMesh(mesh) {
  meshFaces = mesh.faces;
  meshPalette = mesh.palette;
  paletteColorsRaw = null;
  vertexCount = 0;

  const [bx0, bx1, by0, by1, bz0, bz1] = mesh.bbox;
  isoMinX = bx0; isoMaxX = bx1;
  isoMinY = by0; isoMaxY = by1;
  isoMinZ = bz0; isoMaxZ = bz1;

  const hSpan = isoMaxZ - isoMinZ + 1;
  isoOriginX = hSpan * ISO_W / 2 + 20;

  // 奥行きの正規化(下の「奥行きの計算方法」の解説を参照)。
  const maxRawDepth = Math.max(1, (isoMaxX - isoMinX) + (isoMaxZ - isoMinZ) + (isoMaxY - isoMinY) * DEPTH_Y_FACTOR);
  depthNorm = 1 / maxRawDepth;

  buildHoverIndex();
}

// ui.js から、テクスチャ読み込み後に解決した色(パレットと同じ並びの配列)を渡す。
// ここで初めて実際のジオメトリを構築する。
function setRendererPaletteColors(colors) {
  paletteColorsRaw = colors;
  if (gl && meshFaces) buildGeometry();
}

function setRendererTimeline(newTimeline) {
  timeline = newTimeline;
  curTick = 0;
}

function buildHoverIndex() {
  hoverIndex = new Map();
  if (!meshFaces) return;
  for (const f of meshFaces) {
    const [x, y, z, dirCode, pIdx] = f;
    if (dirCode !== 2) continue; // +y(上面)だけを「その列の地表」候補として使う
    const key = (x - isoMinX) + '_' + (z - isoMinZ);
    const existing = hoverIndex.get(key);
    if (!existing || y > existing.y) hoverIndex.set(key, { x, y, z, paletteIdx: pIdx });
  }
}


// ============================================================
// WebGLセットアップ
// ============================================================
//
// 奥行き(depth)の計算方法について:
// このアイソメトリック投影は、画面上で
//   sx = (x - z) * ISO_W/2 + 定数
//   sy = (x + z) * ISO_H/2 - y * Y_SCALE + 定数
// という式で(x,y,z)を平行投影している。同じ画面位置(sx,sy)に映る
// 別の(x,y,z)たちは、実はカメラの視線方向(1, ISO_H/Y_SCALE, 1)に
// 沿って並んでいる(数式的に導出できる)。なので
//   奥行き ∝ x + z + y * (ISO_H/Y_SCALE)
// という量が、画面上で重なり得る点同士を正しい前後関係に並べる
// (=depth bufferで正しく隠面消去できる)値になる。
// ============================================================

const VERTEX_SHADER_SRC = `
  attribute vec3 aPos;   // ブロックのローカル座標 (lx, ly, lz)
  attribute vec3 aColor;
  uniform vec2 uPan;
  uniform float uZoom;
  uniform vec2 uResolution;
  uniform float uIsoOriginX;
  uniform float uDepthNorm;
  varying vec3 vColor;

  const float ISO_W = ${ISO_W.toFixed(1)};
  const float ISO_H = ${ISO_H.toFixed(1)};
  const float Y_SCALE = ${Y_SCALE.toFixed(4)};
  const float DEPTH_Y_FACTOR = ${DEPTH_Y_FACTOR.toFixed(6)};

  void main() {
    float sx = (aPos.x - aPos.z) * (ISO_W * 0.5) + uIsoOriginX;
    float sy = (aPos.x + aPos.z) * (ISO_H * 0.5) - aPos.y * Y_SCALE + 20.0;

    vec2 screen = vec2(sx, sy) * uZoom + uPan;
    vec2 clip = (screen / uResolution) * 2.0 - 1.0;
    clip.y = -clip.y;

    float rawDepth = (aPos.x + aPos.z) + aPos.y * DEPTH_Y_FACTOR;
    float depth = 1.0 - 2.0 * (rawDepth * uDepthNorm);

    gl_Position = vec4(clip, depth, 1.0);
    vColor = aColor;
  }
`;

const FRAGMENT_SHADER_SRC = `
  precision mediump float;
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('シェーダーのコンパイルに失敗しました: ' + info);
  }
  return s;
}

function initGL() {
  const vs = compileShader(gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
  const fs = compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
  program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error('シェーダープログラムのリンクに失敗しました: ' + gl.getProgramInfoLog(program));
  }
  aPosLoc = gl.getAttribLocation(program, 'aPos');
  aColorLoc = gl.getAttribLocation(program, 'aColor');
  uPanLoc = gl.getUniformLocation(program, 'uPan');
  uZoomLoc = gl.getUniformLocation(program, 'uZoom');
  uResLoc = gl.getUniformLocation(program, 'uResolution');
  uIsoOriginXLoc = gl.getUniformLocation(program, 'uIsoOriginX');
  uDepthNormLoc = gl.getUniformLocation(program, 'uDepthNorm');

  vbo = gl.createBuffer();
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
}

function initCanvases() {
  canvas = document.getElementById('mapCanvas');
  playerCanvas = document.getElementById('playerCanvas');
  pctx = playerCanvas.getContext('2d');

  if (!gl) {
    gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) {
      setStatusText('⚠️ このブラウザ/端末ではWebGLが使えないため描画できません。別のブラウザ(Chrome/Firefox等)でお試しください。');
      return;
    }
    initGL();
    window.addEventListener('resize', () => { resizeCanvases(); applyTransform(); });
  }
  resizeCanvases();

  // 既にメッシュ+色データが揃っていれば(WebGL準備が後追いになった場合)ここで構築
  if (meshFaces && meshFaces.length && paletteColorsRaw && vertexCount === 0) buildGeometry();
}

function resizeCanvases() {
  const viewport = document.getElementById('viewport');
  const vw = Math.max(1, viewport.clientWidth), vh = Math.max(1, viewport.clientHeight);
  canvas.width = vw; canvas.height = vh;
  playerCanvas.width = vw; playerCanvas.height = vh;
}


// ============================================================
// ジオメトリ構築(データ読み込み時に1回だけ)
// ============================================================

function buildGeometry() {
  if (!meshFaces || !paletteColorsRaw) return;
  const yRange = Math.max(1, isoMaxY - isoMinY);
  const verts = [];
  let truncated = false;

  for (const f of meshFaces) {
    if (verts.length / 6 >= MAX_VERTS) { truncated = true; break; }

    const wx = f[0], wy = f[1], wz = f[2], dirCode = f[3], pIdx = f[4];
    const bx = wx - isoMinX, by = wy - isoMinY, bz = wz - isoMinZ;

    const brightness = (0.75 + 0.35 * (by / yRange)) * DIR_FACTOR[dirCode];
    const rgb = shadeColorRGB(paletteColorsRaw[pIdx] || '#888', brightness);
    const [r, g, b] = rgb;

    const offsets = FACE_OFFSETS[dirCode];
    // (0,1,2) と (0,2,3) の2つの三角形で四角形の面を作る
    const order = [0, 1, 2, 0, 2, 3];
    for (const oi of order) {
      const [ox, oy, oz] = offsets[oi];
      verts.push(bx + ox, by + oy, bz + oz, r, g, b);
    }
  }

  vertexCount = verts.length / 6;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

  if (truncated) {
    setStatusText(`⚠️ データ量が多すぎたため、一部の面は描画を省略しました(頂点数上限 ${MAX_VERTS.toLocaleString()} に到達)`);
  }
}


// ============================================================
// 描画
// ============================================================

function render() {
  if (!gl) return;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.051, 0.051, 0.063, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  if (vertexCount === 0) return;

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  const stride = 6 * 4;
  gl.enableVertexAttribArray(aPosLoc);
  gl.vertexAttribPointer(aPosLoc, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(aColorLoc);
  gl.vertexAttribPointer(aColorLoc, 3, gl.FLOAT, false, stride, 12);

  gl.uniform2f(uPanLoc, panX, panY);
  gl.uniform1f(uZoomLoc, zoom);
  gl.uniform2f(uResLoc, canvas.width, canvas.height);
  gl.uniform1f(uIsoOriginXLoc, isoOriginX);
  gl.uniform1f(uDepthNormLoc, depthNorm);

  gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
}

// mapCanvas(WebGL)とplayerCanvas(2Dオーバーレイ)は別キャンバスなので、
// パン/ズームが変わった時は両方まとめて再描画する。
function applyTransform() {
  render();
  renderPlayerMarker();
}

// ui.js からの呼び出し互換用。ジオメトリは setRendererPaletteColors() 時に
// 構築済みなので、ここでは再描画だけ行う。
function drawIso() {
  render();
}


// ============================================================
// パン・ズーム・視点移動
// ============================================================

function fitToView() {
  const viewport = document.getElementById('viewport');
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  if (!gl || vertexCount === 0) return;
  const totalWTiles = (isoMaxX - isoMinX) + (isoMaxZ - isoMinZ) + 2;
  const totalW = totalWTiles * ISO_W / 2 + 40;
  const totalH = totalWTiles * ISO_H / 2 + (isoMaxY - isoMinY) * Y_SCALE + 40;
  const fitZoom = Math.min(vw / totalW, vh / totalH) * 0.95;
  zoom = Math.max(0.02, Math.min(4, fitZoom));
  panX = (vw - totalW * zoom) / 2;
  panY = (vh - totalH * zoom) / 2;
  applyTransform();
}

function goToPlayer() {
  const viewport = document.getElementById('viewport');
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  const [sx, sy] = lastPlayerScreenPos;
  if (zoom < 1.5) zoom = 1.5;
  panX = vw / 2 - sx * zoom;
  panY = vh / 2 - sy * zoom;
  applyTransform();
}

function setupPanZoom() {
  const viewport = document.getElementById('viewport');
  let dragging = false, lastX = 0, lastY = 0;
  viewport.onmousedown = e => { dragging = true; lastX = e.clientX; lastY = e.clientY; viewport.classList.add('dragging'); };
  window.onmouseup = () => { dragging = false; viewport.classList.remove('dragging'); };
  window.onmousemove = e => {
    if (!dragging) return;
    panX += e.clientX - lastX; panY += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    applyTransform();
  };
  viewport.onwheel = e => {
    e.preventDefault();
    // マウスカーソルの位置を中心にズームする
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const isoX = (mx - panX) / zoom, isoY = (my - panY) / zoom;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoom = Math.max(0.05, Math.min(20, zoom * factor));
    panX = mx - isoX * zoom;
    panY = my - isoY * zoom;
    applyTransform();
  };
}


// ============================================================
// マウスホバーでのブロック名表示
// ============================================================
//
// 描画そのものはもう「列」という概念を持たないボクセルメッシュだが、
// ツールチップ用に軽量な「列ごとの一番上の面」インデックス(hoverIndex)を
// 別途持っていて、それを使って近似的にブロックを特定する。
// ============================================================

function setupHover() {
  const tooltip = document.getElementById('tooltip');
  canvas.onmousemove = e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const isoX = (mx - panX) / zoom, isoY = (my - panY) / zoom;

    const a = (isoX - isoOriginX) / (ISO_W / 2);
    const b = (isoY - 20) / (ISO_H / 2);
    const approxLx = Math.round((a + b) / 2);
    const approxLz = Math.round((b - a) / 2);
    let best = null, bestDist = Infinity;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const cand = hoverIndex.get((approxLx+dx) + '_' + (approxLz+dz));
        if (!cand) continue;
        const lx = cand.x - isoMinX, lz = cand.z - isoMinZ;
        const sx = (lx - lz) * ISO_W / 2 + isoOriginX;
        const sy = (lx + lz) * ISO_H / 2 - (cand.y - isoMinY) * Y_SCALE + 20;
        const dist = (sx - isoX) * (sx - isoX) + (sy - isoY) * (sy - isoY);
        if (dist < bestDist) { bestDist = dist; best = cand; }
      }
    }
    const t = (bestDist < (ISO_W * ISO_W)) ? best : null;

    if (t) {
      const p = meshPalette[t.paletteIdx] || {};
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX + 14) + 'px';
      tooltip.style.top = (e.clientY + 14) + 'px';
      tooltip.innerText = `${p.root_name || '?'} (${t.x}, ${t.y}, ${t.z})`;
    } else {
      tooltip.style.display = 'none';
    }
  };
  canvas.onmouseleave = () => { tooltip.style.display = 'none'; };
}


// ============================================================
// プレイヤーマーカー(タイムラインの現在位置)
// ============================================================

function isoScreenOf(wx, wy, wz) {
  const lx = wx - isoMinX, lz = wz - isoMinZ;
  const sx = (lx - lz) * ISO_W / 2 + isoOriginX;
  const sy = (lx + lz) * ISO_H / 2 - (wy - isoMinY) * Y_SCALE + 20;
  return [sx, sy];
}

function worldToScreen(wx, wy, wz) {
  const [isx, isy] = isoScreenOf(wx, wy, wz);
  return [isx * zoom + panX, isy * zoom + panY];
}

function renderPlayerMarker() {
  if (!playerCanvas || !pctx) return;
  if (!timeline || !timeline.frames.length) { pctx.clearRect(0, 0, playerCanvas.width, playerCanvas.height); return; }

  pctx.clearRect(0, 0, playerCanvas.width, playerCanvas.height);
  const f = timeline.frames[curTick];
  lastPlayerScreenPos = isoScreenOf(f.position[0], f.position[1], f.position[2]);
  const [sx, sy] = worldToScreen(f.position[0], f.position[1], f.position[2]);

  pctx.strokeStyle = 'rgba(255,204,0,0.6)';
  pctx.lineWidth = 1.5;
  pctx.beginPath(); pctx.moveTo(sx, 0); pctx.lineTo(sx, playerCanvas.height); pctx.stroke();

  const angle = f.rotation[1];
  const lineLen = 22;
  pctx.strokeStyle = '#ff5555'; pctx.lineWidth = 3;
  pctx.beginPath();
  pctx.moveTo(sx, sy);
  pctx.lineTo(sx + Math.sin(angle) * lineLen, sy - Math.cos(angle) * lineLen * 0.5);
  pctx.stroke();

  pctx.save();
  pctx.shadowColor = '#ffcc00'; pctx.shadowBlur = 16;
  pctx.fillStyle = '#ffcc00';
  pctx.beginPath(); pctx.arc(sx, sy, 10, 0, Math.PI * 2); pctx.fill();
  pctx.restore();
  pctx.strokeStyle = '#000'; pctx.lineWidth = 2; pctx.stroke();

  updateFrameInfo(f);
}
