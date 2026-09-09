// renderer.js
// ============================================================
// 「表示の計算」だけを担当するファイル。座標変換・描画・パン/ズーム・
// プレイヤーマーカーの描画など。UI(ボタンやアップロード処理)は
// ui.js の方を見てください。
//
// 2.5D(等角図)専用。2D(真上から見下ろす平面表示)は今回削除。
// ============================================================

const TILE_SIZE = 16;
const ISO_RADIUS = 200;   // プレイヤー中心にこの範囲(ブロック数)だけ描画する(通常モード)
const FOV_RADIUS = 260;   // プレイヤー視点モードでの最大距離
const FOV_HALF_ANGLE = 65 * Math.PI / 180; // プレイヤー視点モードでの視野角(片側)

// --- 描画対象のデータ(ui.js から setRendererData() で渡される) ---
let tiles = [], tileIndex = null;
let minX, maxX, minZ, maxZ, minY, maxY;

// --- キャンバス ---
let canvas, ctx, playerCanvas, pctx;

// --- 表示状態 ---
let zoom = 1, panX = 0, panY = 0;
let viewMode = 'radius'; // 'radius' (周囲全部) | 'fov' (プレイヤーの向いてる方向だけ、軽量)
let ISO_W, ISO_H, Y_SCALE, isoOriginX;
let isoMinX, isoMaxX, isoMinZ, isoMaxZ, isoMinY, isoMaxY;
let isoWindowCenter = null;
let isoWindowFacing = null;
let lastPlayerScreenPos = [0, 0];

// --- タイムライン(プレイヤー位置)への参照。ui.js から渡される ---
let timeline = null;
let curTick = 0;


// ============================================================
// 初期化
// ============================================================

export function setRendererData(newTiles) {
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
}

export function setRendererTimeline(newTimeline) {
  timeline = newTimeline;
  curTick = 0;
}

export function initCanvases() {
  canvas = document.getElementById('mapCanvas');
  ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  playerCanvas = document.getElementById('playerCanvas');
  pctx = playerCanvas.getContext('2d');
}


// ============================================================
// 色の計算
// ============================================================

function shadeColor(rgbStr, factor) {
  const m = rgbStr.match(/\d+/g);
  if (!m) return rgbStr;
  const [r, g, b] = m.map(Number);
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  return `rgb(${clamp(r*factor)},${clamp(g*factor)},${clamp(b*factor)})`;
}

function muteColor(rgbStr) {
  // データ不足(uncertain)のタイル用: 彩度を落として紫がかった灰色に寄せる
  const m = rgbStr.match(/\d+/g);
  if (!m) return '#665577';
  const [r, g, b] = m.map(Number);
  const gray = (r + g + b) / 3;
  const mix = v => Math.round(v * 0.25 + gray * 0.35 + 90 * 0.4);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}


// ============================================================
// 2.5D(等角図)描画
// ============================================================

function drawWallSegment(sx, sy, xOffset, yStart, h, isoH) {
  ctx.beginPath();
  ctx.moveTo(sx, sy + isoH / 2 + yStart);
  ctx.lineTo(sx + xOffset, sy + yStart);
  ctx.lineTo(sx + xOffset, sy + yStart + h);
  ctx.lineTo(sx, sy + isoH / 2 + yStart + h);
  ctx.closePath();
  ctx.fill();
}

function drawWallFace(sx, sy, xOffset, wallH, layers, brightnessFactor, isoH, yScale) {
  // 1段ずつ、実際に積まれてるブロックの色で塗って断面っぽく見せる。
  // layersのデータが尽きたら、そこから先は塗らずに素通しにする
  // (暗いグレーで強制的に埋めると、その下にある建築物が隠れてしまうため)。
  let covered = 0;
  if (layers && layers.length) {
    for (const l of layers) {
      if (covered >= wallH) break;
      const segH = Math.min(yScale, wallH - covered);
      ctx.fillStyle = shadeColor(l._color || '#444', brightnessFactor);
      drawWallSegment(sx, sy, xOffset, covered, segH, isoH);
      covered += segH;
    }
  }
}

export function drawIso() {
  ISO_W = TILE_SIZE; ISO_H = TILE_SIZE / 2;
  Y_SCALE = ISO_H * 0.6;

  // マップ全体が十分小さければそのまま全部、大きい場合はプレイヤー周辺だけに絞る。
  const fullWTiles = maxX - minX + 1, fullHTiles = maxZ - minZ + 1;
  const fullTooBig = (fullWTiles + fullHTiles) * (TILE_SIZE / 2) > 6000;

  let baseTiles = tiles;
  if (fullTooBig) {
    const centerX = (timeline && timeline.frames.length) ? timeline.frames[curTick].position[0] : (minX + maxX) / 2;
    const centerZ = (timeline && timeline.frames.length) ? timeline.frames[curTick].position[2] : (minZ + maxZ) / 2;
    const facing = (timeline && timeline.frames.length) ? timeline.frames[curTick].rotation[1] : 0;

    if (viewMode === 'fov' && timeline && timeline.frames.length) {
      baseTiles = tiles.filter(t => {
        const dx = t.x - centerX, dz = t.z - centerZ;
        const dist = Math.sqrt(dx*dx + dz*dz);
        if (dist > FOV_RADIUS) return false;
        if (dist < 3) return true;
        const angleToTile = Math.atan2(dx, dz);
        let diff = angleToTile - facing;
        while (diff > Math.PI) diff -= Math.PI*2;
        while (diff < -Math.PI) diff += Math.PI*2;
        return Math.abs(diff) <= FOV_HALF_ANGLE;
      });
      isoMinX = Math.round(centerX - FOV_RADIUS); isoMaxX = Math.round(centerX + FOV_RADIUS);
      isoMinZ = Math.round(centerZ - FOV_RADIUS); isoMaxZ = Math.round(centerZ + FOV_RADIUS);
    } else {
      baseTiles = tiles.filter(t => Math.abs(t.x - centerX) <= ISO_RADIUS && Math.abs(t.z - centerZ) <= ISO_RADIUS);
      isoMinX = Math.round(centerX - ISO_RADIUS); isoMaxX = Math.round(centerX + ISO_RADIUS);
      isoMinZ = Math.round(centerZ - ISO_RADIUS); isoMaxZ = Math.round(centerZ + ISO_RADIUS);
    }
    isoWindowCenter = [centerX, centerZ];
    isoWindowFacing = (viewMode === 'fov') ? facing : null;
  } else {
    isoMinX = minX; isoMaxX = maxX; isoMinZ = minZ; isoMaxZ = maxZ;
    isoWindowCenter = null;
    isoWindowFacing = null;
  }
  isoMinY = minY; isoMaxY = maxY;
  const yRange = Math.max(1, isoMaxY - isoMinY);

  const isoTileIndex = new Map();
  for (const t of baseTiles) isoTileIndex.set((t.x - isoMinX) + '_' + (t.z - isoMinZ), t);

  const wTiles = (isoMaxX - isoMinX + 1), hTiles = (isoMaxZ - isoMinZ + 1);
  const w = (wTiles + hTiles) * ISO_W / 2 + 40;
  const h = (wTiles + hTiles) * ISO_H / 2 + (isoMaxY - isoMinY) * Y_SCALE + 40;

  const MAX_DIM = 16000;
  if (w > MAX_DIM || h > MAX_DIM) {
    setStatusText(`2.5D表示にするには範囲が広すぎます (${Math.round(w)}x${Math.round(h)}px)。`);
    return;
  }
  canvas.width = w; canvas.height = h;
  playerCanvas.width = w; playerCanvas.height = h;
  canvas.style.transformOrigin = '0 0';

  isoOriginX = hTiles * ISO_W / 2 + 20;
  const originX = isoOriginX;

  const sorted = [...baseTiles].sort((a, b) => ((a.x - isoMinX) + (a.z - isoMinZ)) - ((b.x - isoMinX) + (b.z - isoMinZ)));

  for (const t of sorted) {
    const lx = t.x - isoMinX, lz = t.z - isoMinZ;
    const sx = (lx - lz) * ISO_W / 2 + originX;
    const sy = (lx + lz) * ISO_H / 2 - (t.y - isoMinY) * Y_SCALE + 20;

    const brightness = 0.75 + 0.35 * ((t.y - isoMinY) / yRange);
    const topColor = shadeColor(t._color, brightness);

    ctx.fillStyle = topColor;
    ctx.beginPath();
    ctx.moveTo(sx, sy - ISO_H / 2);
    ctx.lineTo(sx + ISO_W / 2, sy);
    ctx.lineTo(sx, sy + ISO_H / 2);
    ctx.lineTo(sx - ISO_W / 2, sy);
    ctx.closePath();
    ctx.fill();

    const rightNeighbor = isoTileIndex.get((lx + 1) + '_' + lz);
    const leftNeighbor = isoTileIndex.get(lx + '_' + (lz + 1));

    if (rightNeighbor) {
      const rightDrop = t.y - rightNeighbor.y;
      if (rightDrop >= 1) drawWallFace(sx, sy, ISO_W / 2, rightDrop * Y_SCALE, t.layers, brightness * 0.55, ISO_H, Y_SCALE);
    }
    if (leftNeighbor) {
      const leftDrop = t.y - leftNeighbor.y;
      if (leftDrop >= 1) drawWallFace(sx, sy, -ISO_W / 2, leftDrop * Y_SCALE, t.layers, brightness * 0.75, ISO_H, Y_SCALE);
    }
  }

  applyTransform();
}


// ============================================================
// パン・ズーム・視点移動
// ============================================================

function applyTransform() {
  const t = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  canvas.style.transform = t;
  playerCanvas.style.transform = t;
}

export function fitToView() {
  const viewport = document.getElementById('viewport');
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  if (!canvas || canvas.width === 0 || canvas.height === 0) return;
  const fitZoom = Math.min(vw / canvas.width, vh / canvas.height) * 0.95;
  zoom = Math.max(0.02, Math.min(1, fitZoom));
  panX = (vw - canvas.width * zoom) / 2;
  panY = (vh - canvas.height * zoom) / 2;
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
    const factor = e.deltaY < 0 ? 1.15 : 1/1.15;
    zoom = Math.max(0.05, Math.min(20, zoom * factor));
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
    const mx = (e.clientX - rect.left) / zoom;
    const my = (e.clientY - rect.top) / zoom;

    const hTiles = (isoMaxZ - isoMinZ + 1);
    const originX = hTiles * ISO_W / 2 + 20;
    const a = (mx - originX) / (ISO_W / 2);
    const b = (my - 20) / (ISO_H / 2);
    const approxLx = Math.round((a + b) / 2);
    const approxLz = Math.round((b - a) / 2);
    let best = null, bestDist = Infinity;
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const cand = tileIndex.get((isoMinX - minX + approxLx+dx) + '_' + (isoMinZ - minZ + approxLz+dz));
        if (!cand) continue;
        const lx = cand.x - isoMinX, lz = cand.z - isoMinZ;
        const sx = (lx - lz) * ISO_W / 2 + originX;
        const sy = (lx + lz) * ISO_H / 2 - (cand.y - isoMinY) * (ISO_H*0.6) + 20;
        const dist = (sx-mx)*(sx-mx) + (sy-my)*(sy-my);
        if (dist < bestDist) { bestDist = dist; best = cand; }
      }
    }
    const t = (bestDist < (ISO_W*ISO_W)) ? best : null;

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

function worldToScreen(wx, wy, wz) {
  const lx = wx - isoMinX, lz = wz - isoMinZ;
  const sx = (lx - lz) * ISO_W / 2 + isoOriginX;
  const sy = (lx + lz) * ISO_H / 2 - (wy - isoMinY) * Y_SCALE + 20;
  return [sx, sy];
}

function renderPlayerMarker() {
  if (!playerCanvas) return;
  if (!timeline || !timeline.frames.length) { pctx && pctx.clearRect(0,0,playerCanvas.width,playerCanvas.height); return; }

  // プレイヤーが今描画してる範囲の外側に出そうになったら、その位置を中心に
  // 地形(iso)を描き直す
  if (isoWindowCenter) {
    const f0 = timeline.frames[curTick];
    const dx = Math.abs(f0.position[0] - isoWindowCenter[0]);
    const dz = Math.abs(f0.position[2] - isoWindowCenter[1]);
    const threshold = (viewMode === 'fov' ? FOV_RADIUS : ISO_RADIUS) * 0.6;
    let angleChanged = false;
    if (viewMode === 'fov' && isoWindowFacing !== null) {
      let diff = f0.rotation[1] - isoWindowFacing;
      while (diff > Math.PI) diff -= Math.PI*2;
      while (diff < -Math.PI) diff += Math.PI*2;
      angleChanged = Math.abs(diff) > (10 * Math.PI / 180);
    }
    if (dx > threshold || dz > threshold || angleChanged) drawIso();
  }

  pctx.clearRect(0, 0, playerCanvas.width, playerCanvas.height);
  const f = timeline.frames[curTick];
  const [sx, sy] = worldToScreen(f.position[0], f.position[1], f.position[2]);
  lastPlayerScreenPos = [sx, sy];

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
