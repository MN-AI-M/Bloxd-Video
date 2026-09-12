// renderer.js
// ============================================================
// 「表示の計算」だけを担当するファイル。座標変換・描画・パン/ズーム・
// プレイヤーマーカーの描画など。UI(ボタンやアップロード処理)は
// ui.js の方を見てください。
//
// v3: WebGL化。全タイルのジオメトリをデータ読み込み時に1回だけ構築して
//     GPUに送り、パン/ズーム/プレイヤー追従はuniform更新+再描画だけで
//     済むようにした。これにより「プレイヤー周辺だけ描画する」窓を
//     撤廃でき、常に全体を描画できる(=全体オーバービューがそのまま
//     使えるようになった)。
//
// 重なり順(奥/手前)はCanvas2Dの描画順ではなく、GPUのdepth bufferに
// 任せている。奥行きの目安は元のCanvas2D版と同じ「(x+z)が大きいほど
// 手前」というルールをそのままdepth値に変換しているだけなので、
// 見た目はほぼ変わらない。
// ============================================================

const TILE_SIZE = 16;
const ISO_W = TILE_SIZE, ISO_H = TILE_SIZE / 2;
const Y_SCALE = ISO_H * 0.6;

// 縦に離れた「浮いてる構造物」を描画する際の安全弁。
// 木の葉・花・柵などの装飾ノイズが大量の小さな「かたまり」として
// 誤検出され、頂点数が爆発してブラウザが落ちるのを防ぐための閾値。
const EXTRA_RUN_MIN_THICKNESS = 2;   // これ未満の厚みの浮いてるかたまりは描画しない(装飾ノイズとみなす)
const MAX_EXTRA_RUNS_PER_COLUMN = 6; // 1列あたりに描画する「浮いてる構造物」の最大数
const MAX_VERTS = 6000000;           // 頂点数の全体上限(超えたらクラッシュではなく打ち切って警告)

// --- 描画対象のデータ(ui.js から setRendererData() で渡される) ---
let tiles = [], tileIndex = null;
let minX, maxX, minZ, maxZ, minY, maxY;
let isoMinX, isoMaxX, isoMinZ, isoMaxZ, isoMinY, isoMaxY, isoOriginX;

// --- キャンバス / WebGL ---
let canvas, gl, program, vbo;
let playerCanvas, pctx;
let aPosLoc, aDepthLoc, aColorLoc, uPanLoc, uZoomLoc, uResLoc;
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

function muteColor(rgbStr) {
  // データ不足(uncertain)のタイル用: 彩度を落として紫がかった灰色に寄せる
  const [r, g, b] = parseColor(rgbStr);
  const gray = (r + g + b) / 3;
  const mix = v => Math.round(v * 0.25 + gray * 0.35 + 90 * 0.4);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}


// ============================================================
// 初期化(データ)
// ============================================================

function setRendererData(newTiles) {
  tiles = newTiles;

  const certainTiles = tiles.filter(t => !t.uncertain);
  const boundsSource = certainTiles.length > 0 ? certainTiles : tiles;

  minX = Infinity; maxX = -Infinity; minZ = Infinity; maxZ = -Infinity;
  minY = Infinity; maxY = -Infinity;
  for (const t of boundsSource) {
    if (t.x < minX) minX = t.x;
    if (t.x > maxX) maxX = t.x;
    if (t.z < minZ) minZ = t.z;
    if (t.z > maxZ) maxZ = t.z;
    if (t.y < minY) minY = t.y;
    if (t.y > maxY) maxY = t.y;
  }
  tiles = tiles.filter(t => t.x >= minX && t.x <= maxX && t.z >= minZ && t.z <= maxZ);

  tileIndex = new Map();
  for (const t of tiles) tileIndex.set((t.x - minX) + '_' + (t.z - minZ), t);

  // もう「プレイヤー周辺だけ」の窓は無いので、iso座標系の範囲は常に全体。
  isoMinX = minX; isoMaxX = maxX; isoMinZ = minZ; isoMaxZ = maxZ;
  isoMinY = minY; isoMaxY = maxY;
  const hTiles = isoMaxZ - isoMinZ + 1;
  isoOriginX = hTiles * ISO_W / 2 + 20;

  if (gl) buildGeometry();
}

function setRendererTimeline(newTimeline) {
  timeline = newTimeline;
  curTick = 0;
}


// ============================================================
// WebGLセットアップ
// ============================================================

const VERTEX_SHADER_SRC = `
  attribute vec2 aPos;    // iso-pixel空間(ズーム適用前)の座標
  attribute float aDepth; // -1(奥) 〜 1(手前)
  attribute vec3 aColor;
  uniform vec2 uPan;
  uniform float uZoom;
  uniform vec2 uResolution;
  varying vec3 vColor;
  void main() {
    vec2 screen = aPos * uZoom + uPan;
    vec2 clip = (screen / uResolution) * 2.0 - 1.0;
    clip.y = -clip.y;
    gl_Position = vec4(clip, aDepth, 1.0);
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
  aDepthLoc = gl.getAttribLocation(program, 'aDepth');
  aColorLoc = gl.getAttribLocation(program, 'aColor');
  uPanLoc = gl.getUniformLocation(program, 'uPan');
  uZoomLoc = gl.getUniformLocation(program, 'uZoom');
  uResLoc = gl.getUniformLocation(program, 'uResolution');

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

  // 既にタイルデータが来ていれば(WebGL準備が後追いになった場合)ここでジオメトリを構築
  if (tiles.length > 0 && vertexCount === 0) buildGeometry();
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

function pushQuad(verts, p0, p1, p2, p3, depth, rgb) {
  const [r, g, b] = rgb;
  verts.push(p0[0], p0[1], depth, r, g, b);
  verts.push(p1[0], p1[1], depth, r, g, b);
  verts.push(p2[0], p2[1], depth, r, g, b);
  verts.push(p0[0], p0[1], depth, r, g, b);
  verts.push(p2[0], p2[1], depth, r, g, b);
  verts.push(p3[0], p3[1], depth, r, g, b);
}

function pushWallFace(verts, sx, sy, xOffset, wallH, layers, brightnessFactor, depth) {
  // 1段ずつ、実際に積まれてるブロックの色で塗って断面っぽく見せる。
  // layersのデータが尽きたら、そこから先は塗らない
  // (下にある建築物が隠れてしまわないよう、無理に埋めない)。
  // ※ 呼び出し側で「連続したブロックのかたまり(run)」だけを渡すこと。
  //   途中に空気の隙間がある構造物のlayersをそのまま渡すと、隙間の下にある
  //   無関係な構造物の色がここに圧縮されて描かれてしまう(「建築が潰れる」原因)。
  let covered = 0;
  if (!layers || !layers.length) return;
  for (const l of layers) {
    if (covered >= wallH) break;
    const segH = Math.min(Y_SCALE, wallH - covered);
    const rgb = shadeColorRGB(l._color || '#444', brightnessFactor);
    const yStart = covered;
    pushQuad(verts,
      [sx, sy + ISO_H/2 + yStart],
      [sx + xOffset, sy + yStart],
      [sx + xOffset, sy + yStart + segH],
      [sx, sy + ISO_H/2 + yStart + segH],
      depth, rgb);
    covered += segH;
  }
}

// layers([{y, _color}, ...]、上から下に並んでる前提)を、
// Yが連続している「かたまり(run)」ごとに分割する。
// 縦に離れた複数の構造物(例: 地上の建物+はるか上空の建物)が同じ列にある場合、
// これで別々のかたまりとして扱えるようになる。
function splitLayersIntoRuns(layers) {
  if (!layers || !layers.length) return [];
  const runs = [];
  let current = [layers[0]];
  for (let i = 1; i < layers.length; i++) {
    if (layers[i-1].y - layers[i].y === 1) {
      current.push(layers[i]);
    } else {
      runs.push(current);
      current = [layers[i]];
    }
  }
  runs.push(current);
  return runs;
}

function buildGeometry() {
  const maxSum = Math.max(1, (isoMaxX - isoMinX) + (isoMaxZ - isoMinZ));
  const yRange = Math.max(1, isoMaxY - isoMinY);
  const verts = [];
  let truncated = false;

  for (const t of tiles) {
    if (verts.length / 6 >= MAX_VERTS) { truncated = true; break; }

    const lx = t.x - isoMinX, lz = t.z - isoMinZ;
    const sx = (lx - lz) * ISO_W / 2 + isoOriginX;
    const sy = (lx + lz) * ISO_H / 2 - (t.y - isoMinY) * Y_SCALE + 20;

    // 奥行き: 元のCanvas2D版の描画順(x+zが大きいほど後=手前)をそのままdepthに変換
    const depth = 1.0 - 2.0 * ((lx + lz) / maxSum);

    const brightness = 0.75 + 0.35 * ((t.y - isoMinY) / yRange);
    const topRGB = shadeColorRGB(t._color, brightness);

    pushQuad(verts,
      [sx, sy - ISO_H/2], [sx + ISO_W/2, sy], [sx, sy + ISO_H/2], [sx - ISO_W/2, sy],
      depth, topRGB);

    // layersを実際に連続してるかたまりごとに分ける。
    // runs[0] = 一番上のかたまり(=このタイルの「地表」そのもの)。
    // runs[1]以降 = 縦に離れた別の構造物(地下・浮いてる床など)。
    const runs = splitLayersIntoRuns(t.layers);
    const run0 = runs.length ? runs[0] : [{ y: t.y, _color: t._color }];

    const rightNeighbor = tileIndex.get((lx + 1) + '_' + lz);
    const leftNeighbor = tileIndex.get(lx + '_' + (lz + 1));

    // 崖の壁(隣の列が低い場合)。一番上のかたまり分の色データだけを使い、
    // それより下(=別の構造物)の色を巻き込まないようにする。
    if (rightNeighbor) {
      const rightDrop = t.y - rightNeighbor.y;
      if (rightDrop >= 1) pushWallFace(verts, sx, sy, ISO_W/2, rightDrop * Y_SCALE, run0, brightness * 0.55, depth);
    }
    if (leftNeighbor) {
      const leftDrop = t.y - leftNeighbor.y;
      if (leftDrop >= 1) pushWallFace(verts, sx, sy, -ISO_W/2, leftDrop * Y_SCALE, run0, brightness * 0.75, depth);
    }

    // 2つ目以降のかたまり = 縦に離れた別の構造物。今までは完全に無視されて
    // 「潰れて」いた部分。それぞれ独立した「浮いてる床」として、自分の
    // 本当の高さに天面を、自分の実際の厚みぶんだけ側面を描く。
    // (隣の列との高さ比較はしない: 下まで壁を伸ばすと、本来空洞のはずの
    //  空間を柱のように塗り潰してしまう誤りになるため)
    //
    // ただし、木の葉・花・柵などの装飾で1〜2列あたり大量の小さな
    // かたまりが生まれると頂点数が爆発してしまうため、
    // ・薄すぎる(EXTRA_RUN_MIN_THICKNESS未満)かたまりは装飾ノイズとみなして描画しない
    // ・1列あたりの描画数にも上限(MAX_EXTRA_RUNS_PER_COLUMN)を設ける
    // という安全弁を入れてある。
    let extraDrawn = 0;
    for (let ri = 1; ri < runs.length && extraDrawn < MAX_EXTRA_RUNS_PER_COLUMN; ri++) {
      const run = runs[ri];
      if (run.length < EXTRA_RUN_MIN_THICKNESS) continue;
      extraDrawn++;

      const runTopY = run[0].y;
      const runBottomY = run[run.length - 1].y;
      const rsy = (lx + lz) * ISO_H / 2 - (runTopY - isoMinY) * Y_SCALE + 20;
      const runBrightness = 0.75 + 0.35 * ((runTopY - isoMinY) / yRange);
      const runTopRGB = shadeColorRGB(run[0]._color || t._color, runBrightness);

      pushQuad(verts,
        [sx, rsy - ISO_H/2], [sx + ISO_W/2, rsy], [sx, rsy + ISO_H/2], [sx - ISO_W/2, rsy],
        depth, runTopRGB);

      const runDepth = (runTopY - runBottomY + 1) * Y_SCALE;
      pushWallFace(verts, sx, rsy, ISO_W/2, runDepth, run, runBrightness * 0.55, depth);
      pushWallFace(verts, sx, rsy, -ISO_W/2, runDepth, run, runBrightness * 0.75, depth);
    }
  }

  vertexCount = verts.length / 6;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

  if (truncated) {
    setStatusText(`⚠️ データ量が多すぎたため、一部のタイルは描画を省略しました(頂点数上限 ${MAX_VERTS.toLocaleString()} に到達)`);
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
  gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(aDepthLoc);
  gl.vertexAttribPointer(aDepthLoc, 1, gl.FLOAT, false, stride, 8);
  gl.enableVertexAttribArray(aColorLoc);
  gl.vertexAttribPointer(aColorLoc, 3, gl.FLOAT, false, stride, 12);

  gl.uniform2f(uPanLoc, panX, panY);
  gl.uniform1f(uZoomLoc, zoom);
  gl.uniform2f(uResLoc, canvas.width, canvas.height);

  gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
}

// mapCanvas(WebGL)とplayerCanvas(2Dオーバーレイ)は別キャンバスなので、
// パン/ズームが変わった時は両方まとめて再描画する。
function applyTransform() {
  render();
  renderPlayerMarker();
}

// ui.js からの呼び出し互換用。ジオメトリは setRendererData() 時に
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
    // マウスカーソルの位置を中心にズームする(以前は常に左上基準だった)
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
        const cand = tileIndex.get((approxLx+dx) + '_' + (approxLz+dz));
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
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX + 14) + 'px';
      tooltip.style.top = (e.clientY + 14) + 'px';
      tooltip.innerText = `${t.root_name || '?'} (${t.x}, ${t.y}, ${t.z})`;
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
