// particles.js
// ============================================================
// ✨パーティクル(写真から作るカケラの演出)。
//
// 写真を細かく割って、1つ1つのカケラが「写真のその部分」を持ったまま飛ぶ。
//   動き  shatter: 写真の形のまま置かれていて、割れて飛び散る(ガラスが割れる感じ)
//         burst  : 1か所から、カケラがバーっと広がる
//   形    shard(ガラスの破片) / square / triangle / circle / diamond
//
// 3Dのワールドの中に置く(カメラと同じく、矢印とリングで位置・向きを直せる)。
// タイムラインには「✨ パーティクル」の行にブロックとして出る。
//
// 動きは時刻だけで決まる(乱数は seed から作る)ので、再生ヘッドを
// どこへ動かしても同じ絵になる。重い計算(カケラの切り方・当たり判定)は
// 設定が変わった時だけやり直して、毎フレームは位置の式を計算するだけ。
//
// 写真はブロックの中には入れず、別の置き場(particleImages)に置いて
// IDで参照する(Undoの履歴が写真のぶん重くならないように)。
// 自分で読み込んだ写真はブラウザ(localStorage)に保存する。
// ============================================================

let particleBlocks = [];
let nextParticleBlockId = 1;
let selectedParticleId = null;

const PARTICLE_SHAPES = [
  ['ガラスの破片', 'shard'], ['四角', 'square'], ['三角', 'triangle'], ['丸', 'circle'], ['ひし形', 'diamond'],
];
const PARTICLE_MODES = [['割れて飛び散る', 'shatter'], ['1点から広がる', 'burst']];
const PARTICLE_FADES = [['うすくなる', 'fade'], ['小さくなる', 'shrink'], ['そのまま', 'none']];

// 新しく置く時の標準の値
const PARTICLE_DEFAULTS = {
  mode: 'shatter', shape: 'shard',
  size: 3,          // 写真の横幅(ブロック)
  pieces: 80,       // カケラのだいたいの数
  holdSec: 0.5,     // 割れるまでの時間(秒)
  impactX: 0.5, impactY: 0.5, // 割れ始める点(写真の中の位置 0〜1)
  speed: 5,         // 飛ぶ速さ(ブロック/秒)
  spread: 40,       // 散らばり(度)。広がる動きでは、広がる角度(180で全方向)
  push: 0.5,        // 前へ飛ぶ勢い(-1=奥へ 1=手前へ)。割れる動きだけ
  gravity: 14,      // 重力(ブロック/秒²)
  drag: 0.4,        // 空気抵抗
  spin: 1,          // 回転の速さ
  life: 2.5,        // 割れて(出て)から消えるまで(秒)
  fade: 'fade',
  opacity: 100,
  collide: true,    // 地面や壁に当たったら止まる
};
const PARTICLE_PARAM_KEYS = Object.keys(PARTICLE_DEFAULTS);


// ============================================================
// 写真の置き場
// ============================================================

const LS_PARTICLE_IMAGES = 'bloxdEditor.particleImages.v1';
const PF_IMAGE_MAX = 512;   // 保存する写真の長い辺(px)
const PF_ALPHA_GRID = 64;   // 透明な所の判定に使う、縮小した透明度の表

// id -> { id, name, builtin, dataUrl, w, h, canvas, alpha(Uint8Array), translucent, ready, tex }
const particleImages = new Map();
let particleImageOrder = []; // 素材一覧に並べる順(自分で読み込んだ写真)

function _pfLsLoad() {
  try { const v = localStorage.getItem(LS_PARTICLE_IMAGES); return v ? JSON.parse(v) : []; } catch (e) { return []; }
}
function _pfLsSave() {
  const list = particleImageOrder.map(id => particleImages.get(id)).filter(Boolean)
    .map(im => ({ id: im.id, name: im.name, dataUrl: im.dataUrl }));
  try { localStorage.setItem(LS_PARTICLE_IMAGES, JSON.stringify(list)); return true; }
  catch (e) { return false; }
}

// キャンバスから、透明度の表と「半透明の所が多いか」を作る
function _pfAnalyzeCanvas(im) {
  const g = PF_ALPHA_GRID;
  const c = document.createElement('canvas');
  c.width = g; c.height = g;
  const ctx = c.getContext('2d');
  ctx.drawImage(im.canvas, 0, 0, g, g);
  let data;
  try { data = ctx.getImageData(0, 0, g, g).data; } catch (e) { data = null; }
  im.alpha = new Uint8Array(g * g);
  let soft = 0;
  for (let i = 0; i < g * g; i++) {
    const a = data ? data[i * 4 + 3] : 255;
    im.alpha[i] = a;
    if (a > 25 && a < 240) soft++;
  }
  im.translucent = soft > g * g * 0.05;
}

function _pfRegisterCanvas(id, name, canvas, builtin, dataUrl) {
  const im = { id, name, builtin: !!builtin, dataUrl: dataUrl || null, w: canvas.width, h: canvas.height,
               canvas, alpha: null, translucent: false, ready: true, tex: null };
  _pfAnalyzeCanvas(im);
  particleImages.set(id, im);
  return im;
}

// dataURL から読み込む(読み込みが終わるまでは ready=false で、描かない)
function _pfRegisterDataUrl(id, name, dataUrl) {
  const im = { id, name, builtin: false, dataUrl, w: 1, h: 1, canvas: null, alpha: null, translucent: false, ready: false, tex: null };
  particleImages.set(id, im);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    im.canvas = c; im.w = c.width; im.h = c.height;
    _pfAnalyzeCanvas(im);
    im.ready = true;
    if (typeof renderAssetList === 'function' && typeof activeAssetCategoryId !== 'undefined' && activeAssetCategoryId === 'particle') renderAssetList();
  };
  img.src = dataUrl;
  return im;
}

function pfImageName(id) { const im = particleImages.get(id); return im ? im.name : '(写真なし)'; }

// ---- 公式の写真(絵で作る) ----
function _pfMakeCanvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  return c;
}

function _pfBuiltinImages() {
  // ガラス: 水色で半透明。光の筋と縁
  _pfRegisterCanvas('builtin:glass', 'ガラス', _pfMakeCanvas(256, 256, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, 'rgba(200,238,255,0.55)');
    grad.addColorStop(0.5, 'rgba(150,215,245,0.42)');
    grad.addColorStop(1, 'rgba(185,230,255,0.55)');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    for (const [x, ww] of [[40, 28], [86, 10], [150, 22]]) {
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + ww, 0); g.lineTo(x + ww - 120, h); g.lineTo(x - 120, h); g.closePath(); g.fill();
    }
  }), true);
  // ブロック: 石レンガ
  _pfRegisterCanvas('builtin:bricks', '石レンガ', _pfMakeCanvas(256, 256, (g, w, h) => {
    g.fillStyle = '#5b5e63'; g.fillRect(0, 0, w, h);
    const bh = 32, bw = 64;
    for (let r = 0; r < h / bh; r++) {
      for (let c = -1; c < w / bw + 1; c++) {
        const x = c * bw + (r % 2 ? bw / 2 : 0), y = r * bh;
        const v = 110 + ((r * 7 + c * 13) % 5) * 9;
        g.fillStyle = `rgb(${v},${v + 2},${v + 6})`;
        g.fillRect(x + 2, y + 2, bw - 4, bh - 4);
        g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x + 2, y + 2, bw - 4, 4);
      }
    }
  }), true);
  // カラフル: 虹色
  _pfRegisterCanvas('builtin:colors', 'カラフル', _pfMakeCanvas(256, 256, (g, w, h) => {
    for (let x = 0; x < w; x += 4) {
      g.fillStyle = `hsl(${(x / w) * 360},90%,60%)`; g.fillRect(x, 0, 4, h);
    }
    const v = g.createLinearGradient(0, 0, 0, h);
    v.addColorStop(0, 'rgba(255,255,255,0.35)'); v.addColorStop(1, 'rgba(0,0,0,0.25)');
    g.fillStyle = v; g.fillRect(0, 0, w, h);
  }), true);
  // 金色のキラキラ
  _pfRegisterCanvas('builtin:gold', '金色', _pfMakeCanvas(128, 128, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#FFF3B0'); grad.addColorStop(0.45, '#F2C14E'); grad.addColorStop(1, '#C98A1B');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  }), true);
}

function particleImagesInit() {
  if (particleImages.size) return;
  _pfBuiltinImages();
  for (const e of _pfLsLoad()) {
    if (!e || !e.id || !e.dataUrl) continue;
    _pfRegisterDataUrl(e.id, e.name || '写真', e.dataUrl);
    particleImageOrder.push(e.id);
  }
}

// 写真ファイルを読み込んで置き場に足す。戻り値: 新しいID(失敗したら null)
function pfImportPhotoFile(file) {
  return new Promise((resolve) => {
    if (!file) { resolve(null); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, PF_IMAGE_MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const name = (file.name || '写真').replace(/\.[^.]+$/, '').slice(0, 16) || '写真';
      const probe = _pfRegisterCanvas(id, name, c, false, null);
      // 透明な所がある写真は png、無ければ jpeg(軽い)で保存する
      const hasAlpha = probe.alpha.some(a => a < 250);
      probe.dataUrl = hasAlpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9);
      particleImageOrder.push(id);
      if (!_pfLsSave()) showToast('ブラウザの保存容量が足りないので、この写真はページを開いている間だけ使えます');
      resolve(id);
    };
    img.onerror = () => { URL.revokeObjectURL(url); showToast('この画像は読み込めませんでした(png / jpeg / webp などを使ってください)'); resolve(null); };
    img.src = url;
  });
}

// 素材一覧から写真を消す(使っているブロックはそのまま映る。ページを閉じるまで)
function pfDeletePhoto(id) {
  particleImageOrder = particleImageOrder.filter(x => x !== id);
  _pfLsSave();
}

function pfRenamePhoto(id, name) {
  const im = particleImages.get(id);
  if (!im || !name.trim()) return;
  im.name = name.trim().slice(0, 24);
  _pfLsSave();
}

// ファイル選択の画面を開いて、写真を読み込む
function pfPickPhoto(onDone) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*'; input.style.display = 'none';
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    input.remove();
    const id = await pfImportPhotoFile(f);
    if (id && onDone) onDone(id);
  });
  document.body.appendChild(input);
  input.click();
}


// ============================================================
// ブロック(データ)
// ============================================================

function pfNormalize(b) {
  for (const k of PARTICLE_PARAM_KEYS) if (b[k] === undefined) b[k] = PARTICLE_DEFAULTS[k];
  if (b.offsetSec === undefined) b.offsetSec = 0;
  if (b.seed === undefined) b.seed = 1;
  return b;
}

// 設定から決まる「動きの長さ」(秒)
function pfAutoSeconds(b) {
  return (b.mode === 'shatter' ? b.holdSec + 0.1 : 0) + b.life + 0.15;
}

function pfSetLengthToAuto(b) {
  const maxTick = scMaxTick();
  let end = b.startTick + Math.max(1, Math.round(pfAutoSeconds(b) * scTps()));
  if (maxTick > 0) end = Math.min(end, maxTick);
  b.endTick = Math.max(b.startTick + 1, end);
}

function pfAddBlock(tick, props) {
  const maxTick = scMaxTick();
  let start = Math.max(0, Math.round(tick));
  if (maxTick > 0) start = Math.min(start, Math.max(0, maxTick - 1));
  const id = nextParticleBlockId++;
  const b = pfNormalize({
    id, kind: 'particle', name: 'パーティクル' + id,
    startTick: start, endTick: start + 1, offsetSec: 0,
    imageId: 'builtin:glass', pos: [0, 0, 0], yaw: 0, pitch: 0,
    seed: 1 + Math.floor(Math.random() * 99999), autoLen: true,
    ...PARTICLE_DEFAULTS, ...(props || {}),
  });
  pfSetLengthToAuto(b);
  particleBlocks.push(b);
  return b;
}

function pfGet(id) { return particleBlocks.find(b => b.id === id) || null; }
function pfGetSelected() { return selectedParticleId != null ? pfGet(selectedParticleId) : null; }

function pfDeleteBlock(id) { particleBlocks = particleBlocks.filter(b => b.id !== id); }

// 分割: 右側は、左側の続きの時刻から動きを続ける(途中から再生される)
function pfSplitBlock(b, tick) {
  if (tick <= b.startTick || tick >= b.endTick) return null;
  const right = JSON.parse(JSON.stringify(b));
  right.id = nextParticleBlockId++;
  right.name = 'パーティクル' + right.id;
  right.startTick = tick;
  right.offsetSec = b.offsetSec + (tick - b.startTick) / scTps();
  right.autoLen = false;
  b.endTick = tick;
  b.autoLen = false;
  particleBlocks.push(right);
  return right;
}

function pfDuplicateBlock(b) {
  const len = b.endTick - b.startTick;
  const maxTick = scMaxTick();
  let start = b.endTick;
  if (maxTick > 0 && start + len > maxTick) start = Math.max(0, maxTick - len);
  const dup = JSON.parse(JSON.stringify(b));
  dup.id = nextParticleBlockId++;
  dup.name = 'パーティクル' + dup.id;
  dup.startTick = start; dup.endTick = start + len;
  particleBlocks.push(dup);
  return dup;
}

function pfActiveAtTick(tick) {
  return particleBlocks.filter(b => tick >= b.startTick && tick < b.endTick);
}


// ============================================================
// 乱数(seed から毎回同じ並びを作る)
// ============================================================

function _pfRng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


// ============================================================
// カケラの切り方
//   座標は「写真の横幅=1」の平面(x: 0〜1 右向き、y: 0〜縦横比 下向き)。
//   戻り値: [{ poly:[[x,y],…], cx, cy, cell:[x0,y0,x1,y1]? }]
//   cell があるカケラ(丸・ひし形)は、四角の中を形で切り抜いて描く。
// ============================================================

function _pfPolyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; }
  return a / 2;
}
function _pfCentroid(p) {
  let x = 0, y = 0;
  for (const q of p) { x += q[0]; y += q[1]; }
  return [x / p.length, y / p.length];
}

// 凸な多角形を、長方形 [0,w]x[0,h] で切り取る(Sutherland–Hodgman)
function _pfClipRect(poly, w, h) {
  const edges = [
    (p) => p[0] >= 0, (p) => p[0] <= w, (p) => p[1] >= 0, (p) => p[1] <= h,
  ];
  const cut = [
    (a, b) => { const t = (0 - a[0]) / (b[0] - a[0]); return [0, a[1] + (b[1] - a[1]) * t]; },
    (a, b) => { const t = (w - a[0]) / (b[0] - a[0]); return [w, a[1] + (b[1] - a[1]) * t]; },
    (a, b) => { const t = (0 - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, 0]; },
    (a, b) => { const t = (h - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, h]; },
  ];
  let out = poly;
  for (let e = 0; e < 4 && out.length; e++) {
    const input = out; out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      const cIn = edges[e](cur), pIn = edges[e](prev);
      if (cIn) { if (!pIn) out.push(cut[e](prev, cur)); out.push(cur); }
      else if (pIn) out.push(cut[e](prev, cur));
    }
  }
  return out;
}

function _pfGridFrags(aspect, n, rnd, mode) {
  const cols = Math.max(1, Math.round(Math.sqrt(n / aspect)));
  const rows = Math.max(1, Math.round(n / cols));
  const cw = 1 / cols, ch = aspect / rows;
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x0 = c * cw, y0 = r * ch, x1 = x0 + cw, y1 = y0 + ch;
    if (mode === 'triangle') {
      const tris = rnd() < 0.5
        ? [[[x0, y0], [x1, y0], [x1, y1]], [[x0, y0], [x1, y1], [x0, y1]]]
        : [[[x0, y0], [x1, y0], [x0, y1]], [[x1, y0], [x1, y1], [x0, y1]]];
      for (const t of tris) out.push({ poly: t });
    } else {
      const f = { poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
      if (mode === 'circle' || mode === 'diamond') f.cell = [x0, y0, x1, y1];
      out.push(f);
    }
  }
  return out;
}

// ガラスの破片: 割れ始める点から放射状のひび+同心円のひびで割る
function _pfShardFrags(aspect, n, rnd, ix, iy) {
  const cx = ix, cy = iy * aspect;
  const corners = [[0, 0], [1, 0], [1, aspect], [0, aspect]];
  const rmax = Math.max(...corners.map(p => Math.hypot(p[0] - cx, p[1] - cy))) * 1.02 + 1e-3;
  const spokes = Math.max(5, Math.round(Math.sqrt(n) * 1.25));
  const rings = Math.max(1, Math.ceil(n / (spokes * 2)));
  // ひびの角度(少しずつずらす)
  const base = rnd() * Math.PI * 2;
  const ang = [];
  for (let j = 0; j < spokes; j++) ang.push(base + (j + (rnd() - 0.5) * 0.7) / spokes * Math.PI * 2);
  // 同心円のひびの半径(中心ほど細かい)。点ごとに少しずらす
  const pts = []; // pts[k][j] (k=1..rings)
  for (let k = 0; k <= rings; k++) {
    const row = [];
    for (let j = 0; j < spokes; j++) {
      if (k === 0) { row.push([cx, cy]); continue; }
      let r = rmax * Math.pow(k / rings, 1.5);
      if (k < rings) r *= 0.85 + rnd() * 0.3;
      else r = rmax * 1.4; // 外側は長方形より外まで(あとで切り取る)
      const a = ang[j] + (rnd() - 0.5) * (0.5 / spokes);
      row.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    pts.push(row);
  }
  const out = [];
  const push = (poly) => {
    const clipped = _pfClipRect(poly, 1, aspect);
    if (clipped.length >= 3 && Math.abs(_pfPolyArea(clipped)) > 1e-5) out.push({ poly: clipped });
  };
  for (let k = 0; k < rings; k++) {
    for (let j = 0; j < spokes; j++) {
      const j2 = (j + 1) % spokes;
      const a = pts[k][j], b = pts[k][j2], c = pts[k + 1][j2], d = pts[k + 1][j];
      if (k === 0) { push([a, d, c]); continue; }
      // 四角を対角線で2つの三角に割る(とがった破片になる)
      if (rnd() < 0.5) { push([a, b, c]); push([a, c, d]); }
      else { push([a, b, d]); push([b, c, d]); }
    }
  }
  return out;
}

function _pfAlphaAt(im, x, y, aspect) {
  if (!im.alpha) return 255;
  const g = PF_ALPHA_GRID;
  const u = Math.max(0, Math.min(g - 1, Math.floor(x * g)));
  const v = Math.max(0, Math.min(g - 1, Math.floor((y / aspect) * g)));
  return im.alpha[v * g + u];
}

const _pfFragCache = new Map();
function pfFragments(b, im) {
  const aspect = im.h / im.w;
  const key = [im.id, b.shape, Math.round(b.pieces), b.seed, b.impactX.toFixed(3), b.impactY.toFixed(3), aspect.toFixed(4)].join('|');
  let frags = _pfFragCache.get(key);
  if (frags) return frags;
  const rnd = _pfRng(b.seed * 7 + 3);
  const n = Math.max(1, Math.round(b.pieces));
  if (b.shape === 'shard') frags = _pfShardFrags(aspect, n, rnd, b.impactX, b.impactY);
  else frags = _pfGridFrags(aspect, b.shape === 'triangle' ? Math.max(1, Math.round(n / 2)) : n, rnd, b.shape);
  // 写真の透明な所(切り抜いた形の外)のカケラは作らない
  frags = frags.filter(f => {
    const [mx, my] = _pfCentroid(f.poly);
    let best = _pfAlphaAt(im, mx, my, aspect);
    for (const p of f.poly) best = Math.max(best, _pfAlphaAt(im, mx + (p[0] - mx) * 0.6, my + (p[1] - my) * 0.6, aspect));
    return best > 20;
  });
  for (const f of frags) { const c = _pfCentroid(f.poly); f.cx = c[0]; f.cy = c[1]; }
  if (_pfFragCache.size > 40) _pfFragCache.clear();
  _pfFragCache.set(key, frags);
  return frags;
}


// ============================================================
// 当たり判定用: どこにブロックがあるか(地形の面のデータから作る)
// ============================================================

let _pfSolid = null, _pfSolidSrc = null, _pfSolidLen = -1;
function _pfSolidMap() {
  if (typeof fcMeshFaces === 'undefined') return new Map();
  if (_pfSolid && _pfSolidSrc === fcMeshFaces && _pfSolidLen === fcMeshFaces.length) return _pfSolid;
  const m = new Map();
  for (const f of fcMeshFaces) {
    const s = f[5] || 1, rt = f[6] || 0;
    for (let dx = 0; dx < s; dx++) for (let dz = 0; dz < s; dz++) {
      const k = (f[0] + dx) + ',' + f[1] + ',' + (f[2] + dz);
      const old = m.get(k);
      if (old === undefined || rt < old) m.set(k, rt);
    }
  }
  _pfSolid = m; _pfSolidSrc = fcMeshFaces; _pfSolidLen = fcMeshFaces.length;
  return m;
}

// ローカル座標の点が、指定した時刻(リプレイのtick値)にブロックの中か
function pfIsSolidLocal(p, tickVal) {
  const k = Math.floor(p[0] + worldOriginX) + ',' + Math.floor(p[1] + worldOriginY) + ',' + Math.floor(p[2] + worldOriginZ);
  const rt = _pfSolidMap().get(k);
  return rt !== undefined && rt <= tickVal;
}

function _pfTickVal(frameIndex) {
  if (timeline && timeline.frames && timeline.frames.length) {
    const f = timeline.frames[Math.max(0, Math.min(timeline.frames.length - 1, Math.round(frameIndex)))];
    if (f) return f.tick;
  }
  return Infinity;
}

// 画面の点から3Dへ線を伸ばして、最初に当たるブロックの手前の点(無ければ null)
function pfRaycastLocal(origin, dir, maxDist, tickVal) {
  let prev = origin.slice();
  for (let t = 0.3; t <= maxDist; t += 0.1) {
    const p = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
    if (pfIsSolidLocal(p, tickVal)) return { pos: prev, dist: t };
    prev = p;
  }
  return null;
}


// ============================================================
// 動き(カケラごとの飛び方を、設定が変わった時だけ計算しておく)
// ============================================================

// 平面の向き: N=表の向き(yaw/pitchの前方向)、R=見た人から見て右、U=上
function pfBasis(yaw, pitch) {
  const { forward, right, up } = fcGetCameraVectors(yaw, pitch);
  return { N: forward, R: [-right[0], -right[1], -right[2]], U: up };
}

function _pfRandUnit(rnd) {
  const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), z, r * Math.sin(a)];
}

// 空気抵抗 k がある時の移動量の係数 (1-e^{-kt})/k
function _pfDragF(k, t) { return k < 1e-3 ? t : (1 - Math.exp(-k * t)) / k; }

// 時刻 t(割れて/出てからの秒)での中心の位置(当たり判定なし)
function _pfMotion(s, k, g, t) {
  const f = _pfDragF(k, t);
  const gy = k < 1e-3 ? -0.5 * g * t * t : -g * (t - f) / k;
  return [s.c0[0] + s.v[0] * f, s.c0[1] + s.v[1] * f + gy, s.c0[2] + s.v[2] * f];
}

const _pfSimCache = new Map();
function pfSimulation(b) {
  const im = particleImages.get(b.imageId);
  if (!im || !im.ready) return null;
  const solidVer = (typeof fcMeshFaces !== 'undefined') ? fcMeshFaces.length : 0;
  const sig = JSON.stringify([b.imageId, b.pos, b.yaw, b.pitch, b.startTick, b.offsetSec, solidVer,
    PARTICLE_PARAM_KEYS.map(k => b[k]), b.seed]);
  const hit = _pfSimCache.get(b.id);
  if (hit && hit.sig === sig) return hit;

  const frags = pfFragments(b, im);
  const aspect = im.h / im.w;
  const W = b.size;
  const { N, R, U } = pfBasis(b.yaw, b.pitch);
  const rnd = _pfRng(b.seed * 13 + 5);
  const ix = b.impactX, iy = b.impactY * aspect;
  const maxD = Math.max(...[[0, 0], [1, 0], [1, aspect], [0, aspect]].map(p => Math.hypot(p[0] - ix, p[1] - iy))) || 1;
  const toWorld = (x, y) => [0, 1, 2].map(i => R[i] * (x - 0.5) * W + U[i] * (aspect / 2 - y) * W);
  const k = Math.max(0, b.drag), g = b.gravity;
  const tickVal = _pfTickVal(b.startTick);
  const parts = [];

  for (const f of frags) {
    const off = toWorld(f.cx, f.cy);
    const c0 = b.mode === 'burst' ? b.pos.slice() : [b.pos[0] + off[0], b.pos[1] + off[1], b.pos[2] + off[2]];
    // カケラの角(中心から見た位置。平面の上の2次元)
    const corners = f.poly.map(p => [(p[0] - f.cx) * W, -(p[1] - f.cy) * W]);
    const uvs = f.poly.map(p => [p[0], p[1] / aspect]);
    let v, delay = 0;
    if (b.mode === 'burst') {
      const half = Math.max(1, Math.min(180, b.spread)) * Math.PI / 180;
      const cosT = 1 - rnd() * (1 - Math.cos(half));
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const ph = rnd() * Math.PI * 2;
      const d = [0, 1, 2].map(i => N[i] * cosT + (R[i] * Math.cos(ph) + U[i] * Math.sin(ph)) * sinT);
      const sp = b.speed * (0.4 + 0.6 * rnd());
      v = d.map(x => x * sp);
    } else {
      let dx = f.cx - ix, dy = f.cy - iy;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-4) { const a = rnd() * Math.PI * 2; dx = Math.cos(a); dy = Math.sin(a); } else { dx /= dist; dy /= dist; }
      const dn = Math.min(1, dist / maxD);
      delay = dn * 0.09; // ひびが広がる時間(中心から外へ、少しずつ割れる)
      const sIn = b.speed * (0.35 + 0.65 * rnd()) * (1.25 - 0.75 * dn) * 0.6;
      const sOut = b.push * b.speed * (0.6 + 0.6 * rnd()) * (1.2 - 0.7 * dn);
      const ru = _pfRandUnit(rnd), sr = b.speed * (b.spread / 180) * rnd();
      v = [0, 1, 2].map(i => (R[i] * dx - U[i] * dy) * sIn + N[i] * sOut + ru[i] * sr);
    }
    const axis = _pfRandUnit(rnd);
    const w = b.spin * (3 + 9 * rnd()) * (rnd() < 0.5 ? -1 : 1);
    const s = { c0, v, corners, uvs, cell: f.cell ? true : false, axis, w, delay, tHit: null };
    // 当たったら止まる: 飛んでいく道を細かく追って、最初にブロックに入る時刻を探す
    if (b.collide) {
      const startIn = pfIsSolidLocal(c0, tickVal);
      if (!startIn) {
        const dt = 1 / 40;
        for (let t = dt; t <= b.life + 1e-6; t += dt) {
          if (pfIsSolidLocal(_pfMotion(s, k, g, t), tickVal)) { s.tHit = t - dt; break; }
        }
      }
    }
    parts.push(s);
  }
  const sim = { sig, parts, aspect, translucent: im.translucent || b.opacity < 99.5 };
  _pfSimCache.set(b.id, sim);
  return sim;
}

// 回転(軸と角度)
function _pfRotate(v, axis, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const cx = axis[1] * v[2] - axis[2] * v[1], cy = axis[2] * v[0] - axis[0] * v[2], cz = axis[0] * v[1] - axis[1] * v[0];
  return [v[0] * c + cx * s + axis[0] * d * (1 - c), v[1] * c + cy * s + axis[1] * d * (1 - c), v[2] * c + cz * s + axis[2] * d * (1 - c)];
}

const PF_LIGHT = (() => { const l = [0.4, 0.9, 0.3], n = Math.hypot(...l); return l.map(x => x / n); })();

// ブロックの中の時刻 t(秒)のカケラを、頂点データとして out に積む
// 1頂点 = x,y,z, u,v, lx,ly, 明るさ, 不透明度
function _pfEmitVertices(b, sim, t, out) {
  const { N, R, U } = pfBasis(b.yaw, b.pitch);
  const k = Math.max(0, b.drag), g = b.gravity;
  const fadeSec = Math.min(0.6, b.life * 0.35);
  const baseA = Math.max(0, Math.min(1, b.opacity / 100));
  for (const s of sim.parts) {
    let tb = b.mode === 'burst' ? t : t - b.holdSec - s.delay;
    let pos, ang = 0, alpha = baseA, scale = 1;
    if (b.mode === 'burst' && tb < 0) continue;
    if (tb <= 0) {
      pos = s.c0;
    } else {
      if (tb > b.life) continue;
      const te = s.tHit != null ? Math.min(tb, s.tHit) : tb;
      pos = _pfMotion(s, k, g, te);
      ang = s.w * _pfDragF(k, te);
      const u = (b.life - tb) / fadeSec;
      if (u < 1) {
        if (b.fade === 'fade') alpha *= Math.max(0, u);
        else if (b.fade === 'shrink') scale = Math.max(0, u);
      }
      // 広がる動きは、出た瞬間に小さい所から大きくなる(1点から出てくる感じ)
      if (b.mode === 'burst') scale *= Math.min(1, 0.25 + tb * 6);
    }
    if (alpha <= 0.003 || scale <= 0.003) continue;
    const n = ang ? _pfRotate(N, s.axis, ang) : N;
    const bright = 0.72 + 0.4 * Math.abs(n[0] * PF_LIGHT[0] + n[1] * PF_LIGHT[1] + n[2] * PF_LIGHT[2]);
    const wv = s.corners.map(c => {
      let v = [R[0] * c[0] + U[0] * c[1], R[1] * c[0] + U[1] * c[1], R[2] * c[0] + U[2] * c[1]];
      if (ang) v = _pfRotate(v, s.axis, ang);
      return [pos[0] + v[0] * scale, pos[1] + v[1] * scale, pos[2] + v[2] * scale];
    });
    // 丸・ひし形は四角(4つの角)の中を切り抜くので、角ごとの -1〜1 の位置も渡す
    const loc = s.cell ? [[-1, 1], [1, 1], [1, -1], [-1, -1]] : null;
    for (let i = 1; i < wv.length - 1; i++) {
      for (const j of [0, i, i + 1]) {
        const p = wv[j], uv = s.uvs[j], l = loc ? loc[j] : [0, 0];
        out.push(p[0], p[1], p[2], uv[0], uv[1], l[0], l[1], bright, alpha);
      }
    }
  }
}


// ============================================================
// WebGLの描画
// ============================================================

const PF_VERTEX_SRC = `
  attribute vec3 aPos;
  attribute vec2 aUV;
  attribute vec2 aLocal;
  attribute vec2 aShade;
  uniform mat4 uView;
  uniform mat4 uProj;
  varying vec2 vUV;
  varying vec2 vLocal;
  varying vec2 vShade;
  void main() {
    gl_Position = uProj * uView * vec4(aPos, 1.0);
    vUV = aUV; vLocal = aLocal; vShade = aShade;
  }
`;
const PF_FRAGMENT_SRC = `
  precision mediump float;
  uniform sampler2D uTexture;
  uniform float uShape; // 0=そのまま 1=丸 2=ひし形
  varying vec2 vUV;
  varying vec2 vLocal;
  varying vec2 vShade;
  void main() {
    if (uShape > 0.5 && uShape < 1.5 && dot(vLocal, vLocal) > 1.0) discard;
    if (uShape > 1.5 && abs(vLocal.x) + abs(vLocal.y) > 1.0) discard;
    vec4 c = texture2D(uTexture, vUV);
    float a = c.a * vShade.y;
    if (a < 0.02) discard;
    gl_FragColor = vec4(c.rgb * vShade.x, a);
  }
`;

let pfProgram = null, pfVbo = null, pfLoc = null;
let pfVertexScratch = [];

function _pfInitGL(gl) {
  if (pfProgram) return true;
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('パーティクルのシェーダー: ' + gl.getShaderInfoLog(s));
    return s;
  };
  pfProgram = gl.createProgram();
  gl.attachShader(pfProgram, mk(gl.VERTEX_SHADER, PF_VERTEX_SRC));
  gl.attachShader(pfProgram, mk(gl.FRAGMENT_SHADER, PF_FRAGMENT_SRC));
  gl.linkProgram(pfProgram);
  if (!gl.getProgramParameter(pfProgram, gl.LINK_STATUS)) throw new Error('パーティクルのプログラム: ' + gl.getProgramInfoLog(pfProgram));
  pfLoc = {
    pos: gl.getAttribLocation(pfProgram, 'aPos'), uv: gl.getAttribLocation(pfProgram, 'aUV'),
    local: gl.getAttribLocation(pfProgram, 'aLocal'), shade: gl.getAttribLocation(pfProgram, 'aShade'),
    view: gl.getUniformLocation(pfProgram, 'uView'), proj: gl.getUniformLocation(pfProgram, 'uProj'),
    tex: gl.getUniformLocation(pfProgram, 'uTexture'), shape: gl.getUniformLocation(pfProgram, 'uShape'),
  };
  pfVbo = gl.createBuffer();
  return true;
}

function _pfTexture(gl, im) {
  if (im.tex) return im.tex;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im.canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  im.tex = tex;
  return tex;
}

// 指定した時刻(フレームの番号)に映っているパーティクルを描く。
// 編集視点・プレビュー・小窓のどこからでも同じ呼び方で使う。
function renderParticles(gl, viewMatrix, projMatrix, tick) {
  if (!particleBlocks.length) return;
  const active = pfActiveAtTick(tick);
  if (!active.length) return;
  try { _pfInitGL(gl); } catch (e) { console.error(e); return; }
  const tps = scTps();
  // 不透明な物を先に、半透明な物を後に描く
  const items = [];
  for (const b of active) {
    const sim = pfSimulation(b);
    if (!sim) continue;
    items.push({ b, sim });
  }
  items.sort((a, c) => (a.sim.translucent ? 1 : 0) - (c.sim.translucent ? 1 : 0));
  if (!items.length) return;

  gl.useProgram(pfProgram);
  gl.uniformMatrix4fv(pfLoc.view, false, viewMatrix);
  gl.uniformMatrix4fv(pfLoc.proj, false, projMatrix);
  gl.uniform1i(pfLoc.tex, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, pfVbo);
  const stride = 9 * 4;
  gl.enableVertexAttribArray(pfLoc.pos);
  gl.enableVertexAttribArray(pfLoc.uv);
  gl.enableVertexAttribArray(pfLoc.local);
  gl.enableVertexAttribArray(pfLoc.shade);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  for (const { b, sim } of items) {
    const t = b.offsetSec + (tick - b.startTick) / tps;
    pfVertexScratch.length = 0;
    _pfEmitVertices(b, sim, t, pfVertexScratch);
    if (!pfVertexScratch.length) continue;
    const im = particleImages.get(b.imageId);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pfVertexScratch), gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(pfLoc.pos, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(pfLoc.uv, 2, gl.FLOAT, false, stride, 12);
    gl.vertexAttribPointer(pfLoc.local, 2, gl.FLOAT, false, stride, 20);
    gl.vertexAttribPointer(pfLoc.shade, 2, gl.FLOAT, false, stride, 28);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, _pfTexture(gl, im));
    gl.uniform1f(pfLoc.shape, b.shape === 'circle' ? 1 : b.shape === 'diamond' ? 2 : 0);
    gl.depthMask(!sim.translucent);
    gl.drawArrays(gl.TRIANGLES, 0, pfVertexScratch.length / 9);
  }
  gl.depthMask(true);
  gl.disable(gl.BLEND);
  // 他の描画(地形・人物)は、自分で使う属性だけを毎回有効にしているので、
  // ここで有効にした属性は切っておく(使わない属性が有効のままだと描画に失敗する)
  gl.disableVertexAttribArray(pfLoc.local);
  gl.disableVertexAttribArray(pfLoc.shade);
}


// ============================================================
// 編集視点: 置き場所の目印・クリックで選ぶ・矢印とリング
// ============================================================

const PF_COLOR_SELECTED = [0.9, 0.62, 0.22];
const PF_COLOR_ON = [0.45, 0.85, 0.95];
const PF_COLOR_OFF = [0.45, 0.5, 0.55];

function _pfRestCorners(b) {
  const im = particleImages.get(b.imageId);
  const aspect = im ? im.h / im.w : 1;
  const { R, U } = pfBasis(b.yaw, b.pitch);
  const w = b.size / 2, h = b.size * aspect / 2;
  const P = (sx, sy) => [0, 1, 2].map(i => b.pos[i] + R[i] * w * sx + U[i] * h * sy);
  return [P(-1, 1), P(1, 1), P(1, -1), P(-1, -1)];
}

function _pfMarkerSegments(b) {
  if (b.mode === 'burst') {
    const s = 10 * worldUnitsPerPixelAt(b.pos);
    const { N, R, U } = pfBasis(b.yaw, b.pitch);
    const P = (dx, dy, dz) => [0, 1, 2].map(i => b.pos[i] + R[i] * dx * s + U[i] * dy * s + N[i] * dz * s);
    const t = P(0, 1, 0), r = P(1, 0, 0), bt = P(0, -1, 0), l = P(-1, 0, 0);
    const tip = P(0, 0, 3.2);
    return [t, r, r, bt, bt, l, l, t, P(0, 0, 0), tip, tip, P(0.5, 0, 2.4), tip, P(-0.5, 0, 2.4)];
  }
  const c = _pfRestCorners(b);
  const im = particleImages.get(b.imageId);
  const aspect = im ? im.h / im.w : 1;
  const { R, U } = pfBasis(b.yaw, b.pitch);
  // 割れ始める点の × 印
  const ip = [0, 1, 2].map(i => b.pos[i] + R[i] * (b.impactX - 0.5) * b.size + U[i] * (0.5 - b.impactY) * b.size * aspect);
  const m = 6 * worldUnitsPerPixelAt(ip);
  const X = (sx, sy) => [0, 1, 2].map(i => ip[i] + (R[i] * sx + U[i] * sy) * m);
  return [c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0], X(-1, -1), X(1, 1), X(-1, 1), X(1, -1)];
}

function renderParticleGizmos(gl, viewMatrix, projMatrix, W, H) {
  if (!particleBlocks.length) return;
  for (const b of particleBlocks) {
    if (isNearEye(b.pos)) continue;
    const sel = b.id === selectedParticleId;
    const on = curTick >= b.startTick && curTick < b.endTick;
    _drawLineSegments(gl, viewMatrix, projMatrix, _pfMarkerSegments(b), sel ? PF_COLOR_SELECTED : (on ? PF_COLOR_ON : PF_COLOR_OFF), W, H, sel ? 2.6 : 1.8);
  }
}

// ギズモ(矢印・リング)を出す姿勢
function pfGizmoPose() {
  const b = pfGetSelected();
  return b ? { pos: b.pos.slice(), yaw: b.yaw, pitch: b.pitch } : null;
}

function _pfPointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], c = pts[j];
    if (((a.y > y) !== (c.y > y)) && (x < (c.x - a.x) * (y - a.y) / (c.y - a.y) + a.x)) inside = !inside;
  }
  return inside;
}

// クリックした所のパーティクル(無ければ null)
function pfPick(mx, my, viewMatrix, projMatrix, W, H) {
  let best = null, bestD = 22;
  for (const b of particleBlocks) {
    if (isNearEye(b.pos)) continue;
    const sp = projectToScreen(b.pos, viewMatrix, projMatrix, W, H);
    if (sp) {
      const d = Math.hypot(sp.x - mx, sp.y - my);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best && b.mode === 'shatter') {
      const pts = _pfRestCorners(b).map(p => projectToScreen(p, viewMatrix, projMatrix, W, H));
      if (pts.every(Boolean) && _pfPointInPoly(mx, my, pts)) best = b;
    }
  }
  return best;
}


// ============================================================
// 置く(素材一覧から)
// ============================================================

// 素材一覧の3D画面へのドロップ位置(asset-library.js が一時的に入れる)
let pfDropClientPoint = null;

// 置く場所: ドロップした所(または画面の真ん中)の先にある地面・壁の手前
function _pfPlacement(props) {
  const im = particleImages.get(props.imageId);
  const aspect = im && im.ready ? im.h / im.w : 1;
  const size = props.size || PARTICLE_DEFAULTS.size;
  let mx = fcCanvas.width / 2, my = fcCanvas.height / 2;
  if (pfDropClientPoint) {
    const r = fcCanvas.getBoundingClientRect();
    mx = pfDropClientPoint.x - r.left; my = pfDropClientPoint.y - r.top;
  }
  const ray = scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg);
  const hit = pfRaycastLocal(ray.origin, ray.dir, 80, _pfTickVal(curTick));
  let pos;
  if (hit) {
    pos = hit.pos.slice();
    // 上から地面に置いた時は、写真の下の端が地面に付くくらいに持ち上げる
    if (ray.dir[1] < -0.3 && props.mode !== 'burst') pos[1] += size * aspect / 2;
    else if (props.mode === 'burst') pos[1] += 0.3;
  } else {
    const d = 3 + size * 1.4;
    pos = [0, 1, 2].map(i => ray.origin[i] + ray.dir[i] * d);
  }
  // 表を、今の視点の方へ向ける(縦に立てる)
  const yaw = Math.atan2(fcPos[0] - pos[0], fcPos[2] - pos[2]);
  return { pos, yaw, pitch: props.mode === 'burst' ? 0.9 : 0 };
}

function addParticleAt(tick, props, label) {
  if (typeof pilot !== 'undefined' && pilot) exitPilot(true);
  if (typeof previewIsMain !== 'undefined') previewIsMain = false; // 置いた場所が見えるように
  pushUndo();
  const place = _pfPlacement(props);
  const b = pfAddBlock(tick, { ...props, ...place });
  if (curTick < b.startTick || curTick >= b.endTick) seekTo(b.startTick);
  selectParticle(b.id);
  openEditPanel(b);
  showToast(`✨ ${label || 'パーティクル'}を置きました。スペースで再生すると動きが見えます`);
  return b;
}


// ============================================================
// タイムラインの行
// ============================================================

function _pfAssignRows() {
  const sorted = particleBlocks.slice().sort((a, b) => a.startTick - b.startTick);
  const rowEnds = [], rows = new Map();
  for (const b of sorted) {
    let r = rowEnds.findIndex(end => end <= b.startTick);
    if (r < 0) { r = rowEnds.length; rowEnds.push(0); }
    rowEnds[r] = b.endTick;
    rows.set(b.id, r);
  }
  return { rows, count: Math.max(1, rowEnds.length) };
}

function renderParticleTrackBlocks() {
  const lane = document.getElementById('timelineParticleLane');
  if (!lane) return;
  lane.innerHTML = '';
  lane.style.width = tlTotalWidth() + 'px';
  const { rows, count } = _pfAssignRows();
  const h = count * TL_ROW_H;
  lane.style.height = h + 'px';
  lane.parentElement.style.height = h + 'px';
  const ppt = tlPxPerTick();
  for (const b of particleBlocks) {
    const el = document.createElement('div');
    el.className = 'tlBlock particle' + (b.id === selectedParticleId ? ' selected' : '');
    el.style.left = (b.startTick * ppt) + 'px';
    el.style.width = Math.max(6, (b.endTick - b.startTick) * ppt) + 'px';
    el.style.top = ((rows.get(b.id) || 0) * TL_ROW_H + 3) + 'px';
    const im = particleImages.get(b.imageId);
    if (im && im.ready && im.dataUrl) {
      const th = document.createElement('div');
      th.className = 'tlBlockThumb';
      th.style.backgroundImage = `url(${im.dataUrl})`;
      el.appendChild(th);
    }
    const label = document.createElement('div');
    label.className = 'tlBlockLabel' + (im && im.dataUrl ? ' withThumb' : '');
    label.innerText = '✨ ' + b.name + ' · ' + (b.mode === 'burst' ? '広がる' : '割れる');
    el.appendChild(label);
    _addResizeHandles(el);
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.detail >= 2) {
        e.stopPropagation(); e.preventDefault();
        tlDrag = null;
        selectParticle(b.id);
        openEditPanel(b);
        return;
      }
      tlStartBlockDrag(e, 'particle', b);
    });
    lane.appendChild(el);
  }
  if (!particleBlocks.length) {
    const empty = document.createElement('div');
    empty.className = 'tlEmpty';
    empty.innerText = '左の素材一覧の「💥 パーティクル」から追加できます(写真を読み込んで使えます)';
    lane.appendChild(empty);
  }
}


// ============================================================
// 右の編集パネル
// ============================================================

function renderParticleEditFields(title, body, b) {
  pfNormalize(b);
  title.innerText = '✨ ' + b.name;
  const sec = (label) => body.appendChild(_el('div', 'panelSectionLabel', label));
  const row = (label) => { const r = _el('div', 'fieldRow'); r.appendChild(_el('label', null, label)); body.appendChild(r); return r; };
  // 設定を変えた後: 長さを動きに合わせる(自分で長さを変えていなければ)+タイムラインを描き直す
  const afterChange = () => {
    if (b.autoLen) pfSetLengthToAuto(b);
    renderParticleTrackBlocks();
    updateTimelineToolbar();
  };

  const slider = (label, key, min, max, step, fmt) => {
    const r = row(label);
    const input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = b[key];
    const v = _el('span', 'fieldValue', fmt ? fmt(b[key]) : String(b[key]));
    bindEditUndo(input);
    input.addEventListener('input', () => {
      b[key] = parseFloat(input.value);
      v.innerText = fmt ? fmt(b[key]) : String(b[key]);
      if (b.autoLen) pfSetLengthToAuto(b);
    });
    input.addEventListener('change', afterChange);
    r.appendChild(input); r.appendChild(v);
    return r;
  };
  const pills = (label, options, key, small) => {
    const r = small ? _el('div', 'fieldRow column') : row(label);
    if (small) { r.appendChild(_el('label', null, label)); body.appendChild(r); }
    const group = _el('div', 'settingsRadioGroup');
    for (const [text, val] of options) {
      const pill = _el('button', 'settingsRadioPill' + (small ? ' small' : '') + (b[key] === val ? ' active' : ''), text);
      pill.type = 'button';
      pill.addEventListener('click', () => {
        if (b[key] === val) return;
        pushUndo();
        b[key] = val;
        afterChange();
        openEditPanel(b);
      });
      group.appendChild(pill);
    }
    r.appendChild(group);
    return r;
  };

  // ---- 名前 ----
  const nameRow = row('名前');
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'panelInput'; nameInput.value = b.name;
  bindEditUndo(nameInput);
  nameInput.addEventListener('input', () => { b.name = nameInput.value; renderParticleTrackBlocks(); });
  nameRow.appendChild(nameInput);

  // ---- 写真 ----
  sec('写真');
  const grid = _el('div', 'pfImageGrid');
  const ids = ['builtin:glass', 'builtin:bricks', 'builtin:colors', 'builtin:gold', ...particleImageOrder];
  if (!ids.includes(b.imageId)) ids.push(b.imageId); // 一覧から消した写真でも、使っている間は出す
  for (const id of ids) {
    const im = particleImages.get(id);
    if (!im) continue;
    const tile = _el('button', 'pfImageTile' + (id === b.imageId ? ' active' : ''));
    tile.type = 'button';
    tile.title = im.name;
    const src = im.dataUrl || (im.canvas ? im.canvas.toDataURL() : '');
    if (!im.dataUrl && im.canvas) im.dataUrl = src; // 公式の絵も、次からは使い回す
    tile.style.backgroundImage = `url(${src})`;
    tile.addEventListener('click', () => {
      if (b.imageId === id) return;
      pushUndo(); b.imageId = id; afterChange(); openEditPanel(b);
    });
    grid.appendChild(tile);
  }
  const up = _el('button', 'pfImageTile add', '📷');
  up.type = 'button';
  up.title = '写真を読み込む';
  up.addEventListener('click', () => pfPickPhoto((id) => {
    pushUndo(); b.imageId = id; afterChange(); openEditPanel(b);
    if (typeof renderAssetList === 'function') renderAssetList();
    showToast('📷 写真を読み込みました(素材一覧の「カスタム」にも入りました)');
  }));
  grid.appendChild(up);
  body.appendChild(grid);

  // ---- 動きと形 ----
  sec('動きと形');
  pills('動き', PARTICLE_MODES, 'mode', true);
  pills('カケラの形', PARTICLE_SHAPES, 'shape', true);
  slider('カケラの数', 'pieces', 4, 400, 1, (v) => '約' + Math.round(v));
  slider('大きさ', 'size', 0.5, 20, 0.5, (v) => v + 'ブロック');
  const reseedRow = _el('div', 'panelActions');
  const reseed = _el('button', 'btn btn-ghost btn-sm', '🎲 割れ方・飛び方を変える');
  reseed.addEventListener('click', () => { pushUndo(); b.seed = 1 + Math.floor(Math.random() * 99999); });
  reseedRow.appendChild(reseed);
  body.appendChild(reseedRow);

  if (b.mode === 'shatter') {
    sec('割れ方');
    slider('割れるまで', 'holdSec', 0, 5, 0.05, (v) => v.toFixed(2) + '秒');
    slider('割れ始める点(横)', 'impactX', 0, 1, 0.01, (v) => Math.round(v * 100) + '%');
    slider('割れ始める点(縦)', 'impactY', 0, 1, 0.01, (v) => Math.round(v * 100) + '%');
    slider('前へ飛ぶ勢い', 'push', -1, 1, 0.05, (v) => v > 0.02 ? '手前へ ' + Math.round(v * 100) + '%' : v < -0.02 ? '奥へ ' + Math.round(-v * 100) + '%' : 'なし');
  }

  // ---- 飛び方 ----
  sec('飛び方');
  slider('速さ', 'speed', 0, 40, 0.5, (v) => v + '');
  slider(b.mode === 'burst' ? '広がる角度' : '散らばり', 'spread', b.mode === 'burst' ? 5 : 0, 180, 1, (v) => v + '°');
  slider('重力', 'gravity', -10, 40, 0.5, (v) => v + '');
  slider('空気抵抗', 'drag', 0, 6, 0.1, (v) => v.toFixed(1));
  slider('回転', 'spin', 0, 4, 0.05, (v) => v.toFixed(2));
  const colRow = _el('label', 'scriptCheck');
  const col = document.createElement('input');
  col.type = 'checkbox'; col.checked = !!b.collide;
  col.addEventListener('change', () => { pushUndo(); b.collide = col.checked; });
  colRow.appendChild(col);
  colRow.appendChild(document.createTextNode('地面や壁に当たったら止まる'));
  body.appendChild(colRow);

  // ---- 消え方 ----
  sec('消え方');
  slider(b.mode === 'burst' ? '出てから消えるまで' : '割れてから消えるまで', 'life', 0.2, 10, 0.1, (v) => v.toFixed(1) + '秒');
  pills('消える時', PARTICLE_FADES, 'fade', true);
  slider('不透明度', 'opacity', 5, 100, 1, (v) => v + '%');

  // ---- 位置と向き ----
  sec('位置と向き');
  const numRow = (label, get, set, step) => {
    const r = row(label);
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = String(step); inp.className = 'panelInput small';
    inp.value = get();
    bindEditUndo(inp);
    inp.addEventListener('input', () => { const v = parseFloat(inp.value); if (!isNaN(v)) set(v); });
    r.appendChild(inp);
    return inp;
  };
  const o = [worldOriginX, worldOriginY, worldOriginZ];
  const posInputs = ['X', 'Y(高さ)', 'Z'].map((label, i) =>
    numRow(label, () => (b.pos[i] + o[i]).toFixed(1), (v) => { b.pos[i] = v - o[i]; }, 0.5));
  const yawIn = numRow('左右の向き', () => Math.round(_normDeg(_rad2deg(b.yaw))), (v) => { b.yaw = _deg2rad(v); }, 1);
  const pitchIn = numRow('上下の向き', () => Math.round(_rad2deg(b.pitch)), (v) => { b.pitch = _deg2rad(Math.max(-88, Math.min(88, v))); }, 1);
  pfPanel = { id: b.id, posInputs, yawIn, pitchIn };
  const faceBtnRow = _el('div', 'panelActions');
  const faceBtn = _el('button', 'btn btn-ghost btn-sm', '👁 今の視点の方へ向ける');
  faceBtn.addEventListener('click', () => {
    pushUndo();
    b.yaw = Math.atan2(fcPos[0] - b.pos[0], fcPos[2] - b.pos[2]);
    if (b.mode === 'shatter') b.pitch = 0;
  });
  faceBtnRow.appendChild(faceBtn);
  body.appendChild(faceBtnRow);

  // ---- 表示時間 ----
  sec('表示時間');
  const durRow = row('長さ');
  const durInput = document.createElement('input');
  durInput.type = 'number'; durInput.step = '0.1'; durInput.min = '0.1'; durInput.className = 'panelInput small';
  durInput.value = ((b.endTick - b.startTick) / scTps()).toFixed(1);
  bindEditUndo(durInput);
  durInput.addEventListener('change', () => {
    const v = parseFloat(durInput.value);
    if (!(v > 0)) return;
    const maxTick = scMaxTick();
    b.endTick = Math.max(b.startTick + 1, Math.round(b.startTick + v * scTps()));
    if (maxTick > 0) b.endTick = Math.min(b.endTick, maxTick);
    b.autoLen = false;
    editorChanged();
  });
  durRow.appendChild(durInput);
  durRow.appendChild(_el('span', 'fieldUnit', '秒'));
  if (!b.autoLen) {
    const fit = _el('button', 'btn btn-ghost btn-sm', '動きの長さに合わせる');
    fit.addEventListener('click', () => { pushUndo(); b.autoLen = true; pfSetLengthToAuto(b); editorChanged(); });
    durRow.appendChild(fit);
  }

  body.appendChild(_el('div', 'panelHint', '3D画面の矢印で位置、リングで向きを変えられます。' +
    (b.mode === 'shatter' ? '写真の表(おもて)が見える向きに置かれます。× 印が割れ始める点です。' : '矢印の先の方へ広がります(広がる角度が180°なら全方向)。') +
    '透明な所がある写真(png)は、写っている所だけがカケラになります。'));

  const del = _el('button', 'btn btn-ghost btn-sm dangerBtn', '🗑 このパーティクルを削除');
  del.addEventListener('click', () => { selectParticle(b.id); deleteSelection(); });
  body.appendChild(del);
}

// パネルの位置・向きの数値を、ギズモで動かした時などに追従させる(毎フレーム)
let pfPanel = null;
function syncParticlePanel() {
  if (!pfPanel || !editPanelOpenFor || editPanelOpenFor.kind !== 'particle' || editPanelOpenFor.id !== pfPanel.id) return;
  const b = pfGet(pfPanel.id);
  if (!b) return;
  const active = document.activeElement;
  const o = [worldOriginX, worldOriginY, worldOriginZ];
  pfPanel.posInputs.forEach((inp, i) => {
    const v = (b.pos[i] + o[i]).toFixed(1);
    if (inp !== active && inp.value !== v) inp.value = v;
  });
  const y = String(Math.round(_normDeg(_rad2deg(b.yaw)))), p = String(Math.round(_rad2deg(b.pitch)));
  if (pfPanel.yawIn !== active && pfPanel.yawIn.value !== y) pfPanel.yawIn.value = y;
  if (pfPanel.pitchIn !== active && pfPanel.pitchIn.value !== p) pfPanel.pitchIn.value = p;
}


// ============================================================
// 左の素材一覧(💥 パーティクル)
// ============================================================

const OFFICIAL_PARTICLES = [
  { id: 'glass', icon: '🪟', label: 'ガラスが割れる', desc: '破片がとがって飛び散る', imageId: 'builtin:glass',
    props: { mode: 'shatter', shape: 'shard', pieces: 90, size: 3, holdSec: 0.4, speed: 5, spread: 30, push: 0.6, gravity: 14, drag: 0.4, spin: 1.2, life: 2.5, opacity: 85, fade: 'fade' } },
  { id: 'crumble', icon: '🧱', label: 'ブロックが崩れる', desc: '四角く割れて落ちる', imageId: 'builtin:bricks',
    props: { mode: 'shatter', shape: 'square', pieces: 64, size: 3, holdSec: 0.3, speed: 1.5, spread: 25, push: 0.15, gravity: 18, drag: 0.2, spin: 0.6, life: 3, opacity: 100, fade: 'fade' } },
  { id: 'burst', icon: '🎉', label: 'バーっと広がる', desc: '1点から全方向へ', imageId: 'builtin:colors',
    props: { mode: 'burst', shape: 'triangle', pieces: 140, size: 2, speed: 12, spread: 180, gravity: 3, drag: 2.5, spin: 1.5, life: 1.6, opacity: 100, fade: 'shrink' } },
  { id: 'sparkle', icon: '✨', label: 'キラキラ', desc: '丸い粒が上へ吹き出す', imageId: 'builtin:gold',
    props: { mode: 'burst', shape: 'diamond', pieces: 120, size: 2, speed: 8, spread: 35, gravity: 6, drag: 1.5, spin: 2, life: 1.8, opacity: 100, fade: 'shrink' } },
];

// 自分の写真を置く時の設定(ガラスの割れ方と同じで、写真は透けない)
const PHOTO_PARTICLE_PROPS = { ...OFFICIAL_PARTICLES[0].props, opacity: 100 };

function isParticleAssetKey(key) { return /^(particle|pimg):/.test(String(key)); }

function addParticleAsset(key, tick) {
  const [kind, id] = String(key).split(':');
  if (kind === 'particle') {
    const item = OFFICIAL_PARTICLES.find(p => p.id === id);
    if (item) addParticleAt(tick, { imageId: item.imageId, ...item.props }, item.label);
    return;
  }
  const imgId = String(key).slice(5);
  const im = particleImages.get(imgId);
  if (!im) return;
  addParticleAt(tick, { imageId: imgId, ...PHOTO_PARTICLE_PROPS }, im.name);
}

function _pfThumbSrc(im) {
  if (!im) return '';
  if (!im.dataUrl && im.canvas) im.dataUrl = im.canvas.toDataURL();
  return im.dataUrl || '';
}

function _pfUploadButton(list) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn btn-primary btn-sm pfUploadBtn'; b.innerText = '📷 写真を読み込む';
  b.addEventListener('click', () => pfPickPhoto((id) => {
    activeAssetSource = 'custom';
    renderAssetList();
    showToast('📷 写真を読み込みました。カードをクリックするか、3D画面へドラッグして置けます');
  }));
  list.appendChild(b);
}

function renderParticleAssets(list, source) {
  if (source === 'public') { _renderPublic(list, ASSET_CATEGORIES.find(c => c.id === 'particle')); return; }
  _pfUploadButton(list);
  const grid = _div('assetGrid');
  if (source === 'official') {
    for (const item of OFFICIAL_PARTICLES) {
      const card = _makeCard('particle:' + item.id, 'particle', item.icon, item.label, item.desc, null);
      const th = card.querySelector('.assetThumb');
      th.style.backgroundImage = `url(${_pfThumbSrc(particleImages.get(item.imageId))})`;
      grid.appendChild(card);
    }
    list.appendChild(grid);
    list.appendChild(_div('assetHint', 'クリックで今見ている所に、3D画面へドラッグすると落とした所に置かれます。置いた後、ダブルクリックで写真・カケラの形・飛び方などを変えられます。自分の写真は「📷 写真を読み込む」から。'));
    return;
  }
  // カスタム = 自分で読み込んだ写真
  const mine = particleImageOrder.map(id => particleImages.get(id)).filter(Boolean);
  if (!mine.length) {
    const empty = _div('assetSoon');
    empty.innerHTML = '<b>まだ写真はありません</b>';
    const p = document.createElement('p');
    p.innerText = '「📷 写真を読み込む」で写真を入れると、ここに並びます。写真はカケラに割れて飛び散ります(透明な所がある png なら、写っている形のまま割れます)。';
    empty.appendChild(p);
    list.appendChild(empty);
    return;
  }
  for (const im of mine) {
    const card = _makeCard('pimg:' + im.id, 'particle', '', im.name, im.ready ? `${im.w}×${im.h}` : '読み込み中…', null);
    card.classList.add('custom');
    card.querySelector('.assetThumb').style.backgroundImage = `url(${_pfThumbSrc(im)})`;
    _cardButton(card, '✎', '名前を変える', () => {
      const nameEl = card.querySelector('.assetName');
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'panelInput assetRename'; inp.value = im.name;
      const done = () => { pfRenamePhoto(im.id, inp.value); renderAssetList(); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') renderAssetList(); e.stopPropagation(); });
      inp.addEventListener('blur', done);
      inp.addEventListener('mousedown', (e) => e.stopPropagation());
      inp.addEventListener('click', (e) => e.stopPropagation());
      nameEl.replaceWith(inp);
      card.draggable = false;
      inp.focus(); inp.select();
    });
    _cardButton(card, '✕', 'この写真を一覧から消す', () => {
      pfDeletePhoto(im.id);
      renderAssetList();
      showToast(`「${im.name}」を一覧から消しました`);
    });
    grid.appendChild(card);
  }
  list.appendChild(grid);
  list.appendChild(_div('assetHint', '写真はこのブラウザに保存されます(長い辺512pxに縮めています)。置いた後、ダブルクリックでカケラの形・飛び方を変えられます。'));
}
