// asset-library.js
// ============================================================
// 左の素材一覧(動画編集サイトによくある「素材パネル」)。
//
//   上のタブ: 公式(最初から入っている素材)/ カスタム(自分で保存した素材)/ 公開(予定)
//   左の縦の列: カテゴリ(カメラ/テキスト/…)
//
//   - カードをクリック → 再生ヘッドの位置に追加
//   - カードをタイムラインへドラッグ → 落とした時刻に追加(3D画面へ落とすと再生ヘッドの位置)
//   - カードの ⚙ → 秒数・距離などの設定。設定は次に追加する時にも使われる。
//     「カスタムに保存」で、その設定の素材を名前を付けて残せる
//
// カスタム素材はブラウザ(localStorage)に保存し、.json に書き出し・読み込みできる
// (友達に渡したり、今後の「公開」につなげたりするため)。
//
// 素材の種類を増やす時は、OFFICIAL_ASSETS の表に1行足すだけで済むようにしてある。
// ============================================================

// ------------------------------------------------------------
// カメラの素材: 表示中のプレイヤーの位置・向きを基準に構図を作る
// ------------------------------------------------------------

const PLAYER_EYE_HEIGHT = 1.5;

// 指定tickでの表示中プレイヤーの頭の位置(ローカル座標)と向き
function _playerAt(tick) {
  if (!timeline || !timeline.frames || !timeline.frames.length) return null;
  const i = Math.max(0, Math.min(timeline.frames.length - 1, Math.round(tick)));
  const f = timeline.frames[i];
  if (!f || !f.position) return null;
  const yaw = (f.rotation && f.rotation.length > 1) ? f.rotation[1] : 0;
  return {
    head: [f.position[0] - worldOriginX, f.position[1] - worldOriginY + PLAYER_EYE_HEIGHT, f.position[2] - worldOriginZ],
    yaw,
  };
}

// eye から target を見る向き(freecam.js の fcGetCameraVectors と同じ向きの決め方)
function _lookAtPose(eye, target) {
  const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const limit = Math.PI / 2 - 0.05;
  return {
    pos: eye.slice(),
    yaw: Math.atan2(d[0], d[2]),
    pitch: Math.max(-limit, Math.min(limit, Math.atan2(d[1], Math.hypot(d[0], d[2])))),
  };
}

function _add3(a, b, s) { return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; }
function _fwd(yaw) { return [Math.sin(yaw), 0, Math.cos(yaw)]; }
function _right(yaw) { return [-Math.cos(yaw), 0, Math.sin(yaw)]; }
function _easeInOut(u) { return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }

function _needPlayer(tick) {
  const p = _playerAt(tick);
  if (!p) showToast('プレイヤーの情報がまだ読み込まれていません');
  return p;
}

// プレイヤーを基準にした固定カメラ。offsetFn(head, yaw) → 目の位置
function _playerShot(tick, label, seconds, offsetFn) {
  const p = _needPlayer(tick);
  if (!p) return null;
  const pose = _lookAtPose(offsetFn(p.head, p.yaw), p.head);
  return addCameraAt(tick, [{ time: 0, ...pose }], { seconds, name: label, toast: `📷 「${label}」のカメラを置きました(${seconds}秒)` });
}

// プレイヤーの動きに合わせて、一定の間隔でキーを打った動くカメラ。
// eyeFn(p=その時のプレイヤー, p0=最初のプレイヤー, u=0→1の進み具合) → 目の位置
// look: 'player'(毎回プレイヤーを見る)
function _playerMovingShot(tick, label, seconds, step, smooth, eyeFn) {
  const p0 = _needPlayer(tick);
  if (!p0) return null;
  const tps = scTps();
  const keys = [];
  const n = Math.max(1, Math.round(seconds / step));
  for (let i = 0; i <= n; i++) {
    const t = seconds * i / n;
    const p = _playerAt(tick + t * tps);
    const u = smooth ? _easeInOut(i / n) : i / n;
    keys.push({ time: t, ..._lookAtPose(eyeFn(p, p0, u), p.head) });
  }
  return addCameraAt(tick, keys, { seconds, name: label, toast: `🎬 「${label}」のカメラを置きました(${seconds}秒)` });
}

// ------------------------------------------------------------
// 設定項目の書き方(params):
//   { key, label, min, max, step, unit, def }            … スライダー
//   { key, label, choices:[[表示, 値], …], def }          … ボタンで選ぶ
// ------------------------------------------------------------

const P_SECONDS = (def) => ({ key: 'seconds', label: '長さ', min: 0.5, max: 20, step: 0.5, unit: '秒', def });
const P_DIST = (def, label) => ({ key: 'dist', label: label || '距離', min: 1, max: 30, step: 0.5, unit: 'ブロック', def });
const P_HEIGHT = (def) => ({ key: 'height', label: '高さ', min: -4, max: 30, step: 0.5, unit: 'ブロック', def });
const P_SMOOTH = { key: 'smooth', label: '動き方', choices: [['なめらか', 1], ['等速', 0]], def: 1 };

const TEXT_ASSET_SECONDS = P_SECONDS(2);

const OFFICIAL_ASSETS = {
  camera: [
    { id: 'view', icon: '📷', label: '今の視点', desc: '今見えている構図をそのまま (F)',
      params: [P_SECONDS(3)],
      add: (tick, o) => addCameraAt(tick, [{ time: 0, ...currentViewPose() }], { seconds: o.seconds }) },
    { id: 'behind', icon: '🧍', label: '後ろから', desc: 'プレイヤーの背中越し',
      params: [P_SECONDS(3), P_DIST(6), P_HEIGHT(2)],
      add: (tick, o) => _playerShot(tick, '後ろから', o.seconds, (h, y) => _add3(_add3(h, _fwd(y), -o.dist), [0, 1, 0], o.height)) },
    { id: 'front', icon: '🙂', label: '正面から', desc: 'プレイヤーの顔を正面から',
      params: [P_SECONDS(3), P_DIST(5), P_HEIGHT(0.5)],
      add: (tick, o) => _playerShot(tick, '正面から', o.seconds, (h, y) => _add3(_add3(h, _fwd(y), o.dist), [0, 1, 0], o.height)) },
    { id: 'side', icon: '↔', label: '横から', desc: 'プレイヤーを真横から',
      params: [P_SECONDS(3), P_DIST(6), P_HEIGHT(1), { key: 'side', label: '向き', choices: [['右から', 1], ['左から', -1]], def: 1 }],
      add: (tick, o) => _playerShot(tick, '横から', o.seconds, (h, y) => _add3(_add3(h, _right(y), o.dist * o.side), [0, 1, 0], o.height)) },
    { id: 'top', icon: '⬇', label: '真上から', desc: '上から見下ろす(建築向き)',
      params: [P_SECONDS(3), P_HEIGHT(18)],
      add: (tick, o) => _playerShot(tick, '真上から', o.seconds, (h, y) => _add3(_add3(h, [0, 1, 0], Math.max(2, o.height)), _fwd(y), -0.5)) },
    { id: 'follow', icon: '🏃', label: '追いかける', desc: '後ろからついて行く(動く)',
      params: [P_SECONDS(4), P_DIST(6), P_HEIGHT(2.5), { key: 'step', label: 'ポイント間隔', min: 0.25, max: 2, step: 0.25, unit: '秒', def: 0.5 }],
      add: (tick, o) => _playerMovingShot(tick, '追いかけ', o.seconds, o.step, false, (p, p0) =>
        _add3(_add3(p.head, _fwd(p0.yaw), -o.dist), [0, 1, 0], o.height)) },
    { id: 'orbit', icon: '🔄', label: '周りを回る', desc: 'プレイヤーの周りを回る(動く)',
      params: [P_SECONDS(6), P_DIST(7, '半径'), P_HEIGHT(2.5),
        { key: 'angle', label: '回る角度', min: 45, max: 720, step: 15, unit: '°', def: 360 },
        { key: 'dir', label: '向き', choices: [['左回り', 1], ['右回り', -1]], def: 1 }, P_SMOOTH],
      add: (tick, o) => _playerMovingShot(tick, '周回', o.seconds, 0.5, !!o.smooth, (p, p0, u) => {
        const a = p0.yaw + Math.PI + o.dir * u * o.angle * Math.PI / 180;
        return [p.head[0] + Math.sin(a) * o.dist, p.head[1] + o.height, p.head[2] + Math.cos(a) * o.dist];
      }) },
    { id: 'dolly', icon: '🔍', label: 'ゆっくり寄る', desc: '遠くからプレイヤーに近づく(動く)',
      params: [P_SECONDS(4), { key: 'from', label: '始めの距離', min: 2, max: 40, step: 0.5, unit: 'ブロック', def: 14 },
        { key: 'to', label: '終わりの距離', min: 1, max: 40, step: 0.5, unit: 'ブロック', def: 4 }, P_HEIGHT(2), P_SMOOTH],
      add: (tick, o) => _playerMovingShot(tick, '寄り', o.seconds, 0.5, !!o.smooth, (p, p0, u) =>
        _add3(_add3(p.head, _fwd(p0.yaw), -(o.from + (o.to - o.from) * u)), [0, 1, 0], o.height)) },
    { id: 'rise', icon: '🛗', label: '上へ昇る', desc: 'プレイヤーを見ながら上昇(動く)',
      params: [P_SECONDS(5), P_DIST(8), { key: 'h0', label: '始めの高さ', min: -2, max: 30, step: 0.5, unit: 'ブロック', def: 0 },
        { key: 'h1', label: '終わりの高さ', min: 0, max: 60, step: 0.5, unit: 'ブロック', def: 16 }, P_SMOOTH],
      add: (tick, o) => _playerMovingShot(tick, '上昇', o.seconds, 0.5, !!o.smooth, (p, p0, u) =>
        _add3(_add3(p.head, _fwd(p0.yaw), -o.dist), [0, 1, 0], o.h0 + (o.h1 - o.h0) * u)) },
  ],
  text: [
    { id: 'title', icon: 'Aa', label: 'タイトル', desc: '中央に大きく・ポップ',
      sample: { fontSize: 22, weight: 900 }, params: [TEXT_ASSET_SECONDS],
      style: { content: 'タイトル', fontSize: 96, weight: 900, x: 0.5, y: 0.45, animIn: 'pop', animOut: 'fade', strokeWidth: 3, strokeColor: '#1a1a1a' } },
    { id: 'subtitle', icon: 'Aa', label: '字幕', desc: '画面の下・フェード',
      sample: { fontSize: 14, weight: 700 }, params: [P_SECONDS(3)],
      style: { content: '字幕テキスト', fontSize: 40, weight: 700, x: 0.5, y: 0.88, animIn: 'fade' } },
    { id: 'heading', icon: 'Aa', label: '見出し', desc: '画面の上・オレンジ',
      sample: { fontSize: 17, weight: 900, color: '#E8A33D' }, params: [TEXT_ASSET_SECONDS],
      style: { content: '見出し', fontSize: 60, weight: 900, color: '#E8A33D', x: 0.5, y: 0.14, animIn: 'slideDown', animOut: 'slideUp' } },
    { id: 'telop', icon: 'Aa', label: 'テロップ', desc: '黒い帯つき・左から',
      sample: { fontSize: 14, weight: 700, bg: 'rgba(0,0,0,0.75)' }, params: [P_SECONDS(3)],
      style: { content: 'テロップ', fontSize: 44, weight: 700, x: 0.5, y: 0.82, bgOpacity: 75, bgColor: '#000000', bgPadding: 14, bgRadius: 4, shadow: 'none', animIn: 'slideLeft', animOut: 'fade' } },
    { id: 'game', icon: 'Aa', label: 'ゲーム風', desc: '黄色+太い縁取り',
      sample: { fontSize: 19, weight: 900, color: '#FFD84A', stroke: '#1a1a1a' }, params: [TEXT_ASSET_SECONDS],
      style: { content: 'NICE!', font: 'rounded', fontSize: 88, weight: 900, color: '#FFD84A', strokeWidth: 5, strokeColor: '#1a1a1a', shadow: 'hard', x: 0.5, y: 0.4, rotation: -6, animIn: 'pop', animOut: 'zoom' } },
    { id: 'pixel', icon: 'Aa', label: 'ドット文字', desc: 'ブロックの世界に合う',
      sample: { fontSize: 17, font: 'pixel' }, params: [TEXT_ASSET_SECONDS],
      style: { content: 'ドット文字', font: 'pixel', fontSize: 64, weight: 400, strokeWidth: 3, strokeColor: '#000000', shadow: 'hard', x: 0.5, y: 0.5, animIn: 'typewriter', animInSec: 0.8 } },
    { id: 'neon', icon: 'Aa', label: 'ネオン', desc: '光る文字',
      sample: { fontSize: 18, weight: 700, color: '#9FF7FF', glow: '#29D9FF' }, params: [TEXT_ASSET_SECONDS],
      style: { content: 'NEON', font: 'display', fontSize: 80, weight: 700, color: '#E9FDFF', shadow: 'glow', shadowColor: '#29D9FF', x: 0.5, y: 0.5, animIn: 'fade', animInSec: 0.8 } },
    { id: 'plain', icon: 'Aa', label: 'テキスト', desc: 'ふつうの文字',
      sample: { fontSize: 15, weight: 700 }, params: [TEXT_ASSET_SECONDS], style: {} },
  ],
};

// テキストの公式素材の add は style から作る
for (const item of OFFICIAL_ASSETS.text) {
  item.add = (tick, o) => addTextAt(tick, { ...item.style, seconds: o.seconds }, item.label);
}

const ASSET_CATEGORIES = [
  { id: 'camera', icon: '🎥', label: 'カメラ' },
  { id: 'text', icon: '📝', label: 'テキスト' },
  { id: 'music', icon: '🎵', label: '音楽', soon: '音声ファイルを読み込んで、BGMや効果音として並べられるようにする予定です。' },
  { id: 'pose', icon: '🕺', label: 'ポーズ', soon: 'プレイヤーの姿勢を決めて、タイムラインに並べられるようにする予定です。' },
  { id: 'effect', icon: '✨', label: 'エフェクト', soon: 'スロー・早送りや画面の効果などを追加する予定です。' },
];

const ASSET_SOURCES = [
  ['official', '公式'],
  ['custom', 'カスタム'],
  ['public', '公開'],
];

let activeAssetCategoryId = 'camera';
let activeAssetSource = 'official';
let assetListCollapsed = false;
let openAssetSettingsKey = null; // ⚙ を開いている素材
const ASSET_DRAG_TYPE = 'application/x-bloxd-asset';


// ------------------------------------------------------------
// 保存(ブラウザの中。使えない環境では、このページを開いている間だけ覚える)
// ------------------------------------------------------------

const LS_PARAMS = 'bloxdEditor.assetParams.v1';
const LS_CUSTOM = 'bloxdEditor.customAssets.v1';

function _lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function _lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できなくても動作は続ける */ }
}

let assetParamState = _lsGet(LS_PARAMS, {}); // { 'camera:orbit': { seconds: 8, … } }
let customAssets = _lsGet(LS_CUSTOM, []);      // [{ id, cat, name, type, … }]

function _saveCustomAssets() { _lsSet(LS_CUSTOM, customAssets); }


// ------------------------------------------------------------
// 設定値
// ------------------------------------------------------------

function _officialItem(catId, itemId) {
  return (OFFICIAL_ASSETS[catId] || []).find(i => i.id === itemId) || null;
}

function _defaultParams(item) {
  const o = {};
  for (const p of item.params || []) o[p.key] = p.def;
  return o;
}

// 素材の今の設定(初期値+自分で変えた所)
function assetParams(catId, itemId) {
  const item = _officialItem(catId, itemId);
  if (!item) return {};
  return { ..._defaultParams(item), ...(assetParamState[catId + ':' + itemId] || {}) };
}

function setAssetParam(catId, itemId, key, value) {
  const k = catId + ':' + itemId;
  assetParamState[k] = { ...(assetParamState[k] || {}), [key]: value };
  _lsSet(LS_PARAMS, assetParamState);
}

function resetAssetParams(catId, itemId) {
  delete assetParamState[catId + ':' + itemId];
  _lsSet(LS_PARAMS, assetParamState);
}

function _paramSummary(item, o) {
  const parts = [];
  for (const p of item.params || []) {
    if (p.choices) continue;
    if (p.key === 'seconds') parts.unshift(o.seconds + '秒');
  }
  return parts.join(' ');
}


// ------------------------------------------------------------
// 追加
// ------------------------------------------------------------

// key: 'camera:orbit'(公式) / 'custom:<id>'(カスタム)
function addAssetAt(key, tick) {
  if (typeof stopPlayback === 'function') stopPlayback();
  tick = Math.max(0, Math.round(tick));
  const [a, b] = String(key).split(':');
  if (a === 'custom') {
    const c = customAssets.find(x => x.id === b);
    if (c) _addCustomAsset(c, tick);
    return;
  }
  const item = _officialItem(a, b);
  if (item) item.add(tick, assetParams(a, b));
}

function _addCustomAsset(c, tick) {
  if (c.type === 'preset') {
    const item = _officialItem(c.cat, c.base);
    if (!item) { showToast('元になった素材が見つかりません'); return; }
    item.add(tick, { ..._defaultParams(item), ...c.params });
    return;
  }
  if (c.type === 'textStyle') {
    addTextAt(tick, { ...c.style }, c.name);
    return;
  }
  if (c.type === 'camMove') {
    let keys;
    if (c.relative) {
      const p = _needPlayer(tick);
      if (!p) return;
      keys = c.keys.map(k => _fromPlayerFrame(k, p));
    } else {
      keys = c.keys.map(k => ({ ...k, pos: k.pos.slice() }));
    }
    addCameraAt(tick, keys, { seconds: c.seconds, fov: c.fov, name: c.name, toast: `🎬 「${c.name}」のカメラを置きました(${c.seconds}秒)` });
  }
}

// プレイヤーから見た位置・向き ⇄ 世界の位置・向き(左右の向きだけ回す)
function _rotY(v, a) { const c = Math.cos(a), s = Math.sin(a); return [v[0] * c + v[2] * s, v[1], v[2] * c - v[0] * s]; }
function _toPlayerFrame(k, p) {
  const rel = _rotY([k.pos[0] - p.head[0], k.pos[1] - p.head[1], k.pos[2] - p.head[2]], -p.yaw);
  const out = { time: k.time, pos: rel, yaw: k.yaw - p.yaw, pitch: k.pitch };
  if (k.curve) out.curve = k.curve.slice();
  return out;
}
function _fromPlayerFrame(k, p) {
  const w = _rotY(k.pos, p.yaw);
  const out = { time: k.time, pos: [w[0] + p.head[0], w[1] + p.head[1], w[2] + p.head[2]], yaw: k.yaw + p.yaw, pitch: k.pitch };
  if (k.curve) out.curve = k.curve.slice();
  return out;
}


// ------------------------------------------------------------
// カスタム素材を作る
// ------------------------------------------------------------

function _newCustomId() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function _addCustom(entry, toastText) {
  customAssets.push({ id: _newCustomId(), ...entry });
  _saveCustomAssets();
  activeAssetCategoryId = entry.cat;
  activeAssetSource = 'custom';
  assetListCollapsed = false;
  renderAssetRail();
  renderAssetList();
  showToast(toastText || `⭐ 「${entry.name}」をカスタム素材に保存しました`);
}

// ⚙ の設定で保存
function saveParamsAsCustom(catId, itemId, name) {
  const item = _officialItem(catId, itemId);
  if (!item) return;
  const params = assetParams(catId, itemId);
  _addCustom({ cat: catId, type: 'preset', base: itemId, name: name || item.label, icon: item.icon, params,
               desc: `${item.label}をもとに · ${_paramSummary(item, params)}`, sample: item.sample || null });
}

// 右パネルから: 選んでいるカメラの動きを、プレイヤー基準で保存
function saveCameraAsCustomAsset(cam) {
  if (!cam) return;
  const seconds = +((cam.endTick - cam.startTick) / scTps()).toFixed(2);
  const p = _playerAt(cam.startTick);
  const keys = cam.keys.map(k => p ? _toPlayerFrame(k, p) : { ..._cloneKey(k) });
  const name = scCamName(cam).replace(/\s+\d+$/, '') || 'カメラ';
  _addCustom({ cat: 'camera', type: 'camMove', name, icon: scCamIsStatic(cam) ? '📷' : '🎬',
               relative: !!p, keys, seconds, fov: cam.fov,
               desc: `${seconds}秒 · ${scCamIsStatic(cam) ? '固定' : `動く(${cam.keys.length}点)`}${p ? ' · プレイヤー基準' : ''}` });
}

// 右パネルから: 選んでいるテキストの見た目を保存
function saveTextAsCustomAsset(block) {
  if (!block) return;
  const style = { ...ctTextStyleOf(block), content: block.content, x: block.x, y: block.y,
                  seconds: +((block.endTick - block.startTick) / scTps()).toFixed(2) };
  const name = (block.content || 'テキスト').replace(/\s+/g, ' ').slice(0, 12);
  _addCustom({ cat: 'text', type: 'textStyle', name, icon: 'Aa', style,
               desc: `${style.seconds}秒 · ${(TEXT_FONTS[style.font] || TEXT_FONTS.gothic).label}`,
               sample: { fontSize: 16, weight: style.weight, color: style.color, font: style.font } });
}

function deleteCustomAsset(id) {
  customAssets = customAssets.filter(c => c.id !== id);
  _saveCustomAssets();
  renderAssetList();
}

function renameCustomAsset(id, name) {
  const c = customAssets.find(x => x.id === id);
  if (!c || !name.trim()) return;
  c.name = name.trim();
  _saveCustomAssets();
}

// 書き出し(.json)・読み込み
function exportCustomAssets() {
  const data = JSON.stringify({ format: 'bloxd-editor-assets', version: 1, assets: customAssets }, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = 'bloxd-custom-assets.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importCustomAssetsFromText(text) {
  let n = 0;
  try {
    const d = JSON.parse(text);
    const list = Array.isArray(d) ? d : d.assets;
    for (const c of list || []) {
      if (!c || !c.cat || !c.type || !c.name) continue;
      customAssets.push({ ...c, id: _newCustomId() });
      n++;
    }
  } catch (e) { showToast('読み込めませんでした(素材のファイルではないようです)'); return 0; }
  _saveCustomAssets();
  renderAssetList();
  showToast(n ? `⭐ カスタム素材を${n}個読み込みました` : '読み込める素材がありませんでした');
  return n;
}


// ------------------------------------------------------------
// 表示
// ------------------------------------------------------------

function assetLibraryInit() {
  renderAssetRail();
  renderAssetList();
  setupAssetDropTargets();
}

function renderAssetRail() {
  const rail = document.getElementById('assetRail');
  rail.innerHTML = '';
  for (const cat of ASSET_CATEGORIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'assetRailBtn' + (cat.id === activeAssetCategoryId && !assetListCollapsed ? ' active' : '') + (cat.soon ? ' soon' : '');
    b.title = cat.label + (cat.soon ? '(近日公開)' : '');
    b.innerHTML = `<span class="ico">${cat.icon}</span><span class="lbl">${cat.label}</span>`;
    b.addEventListener('click', () => {
      // 開いているカテゴリをもう一度押すと、一覧を畳んで3D画面を広くする
      if (cat.id === activeAssetCategoryId && !assetListCollapsed) assetListCollapsed = true;
      else { activeAssetCategoryId = cat.id; assetListCollapsed = false; }
      openAssetSettingsKey = null;
      renderAssetRail();
      renderAssetList();
    });
    rail.appendChild(b);
  }
}

function _div(cls, text) {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  if (text != null) d.innerText = text;
  return d;
}

function renderAssetList() {
  const list = document.getElementById('assetList');
  list.classList.toggle('collapsed', assetListCollapsed);
  const keepScroll = list.scrollTop;
  list.innerHTML = '';
  if (assetListCollapsed) return;
  const cat = ASSET_CATEGORIES.find(c => c.id === activeAssetCategoryId);
  if (!cat) return;

  list.appendChild(_div('assetListTitle', cat.icon + ' ' + cat.label));

  // 公式 / カスタム / 公開
  const tabs = _div('assetTabs');
  for (const [id, label] of ASSET_SOURCES) {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'assetTab' + (id === activeAssetSource ? ' active' : '');
    const count = id === 'custom' ? customAssets.filter(c => c.cat === cat.id).length : 0;
    t.innerText = label + (count ? ` ${count}` : '');
    t.addEventListener('click', () => { activeAssetSource = id; openAssetSettingsKey = null; renderAssetList(); });
    tabs.appendChild(t);
  }
  list.appendChild(tabs);

  if (cat.soon) {
    const soon = _div('assetSoon');
    soon.innerHTML = '<b>近日公開</b>';
    const p = document.createElement('p');
    p.innerText = cat.soon;
    soon.appendChild(p);
    list.appendChild(soon);
    return;
  }

  if (activeAssetSource === 'official') _renderOfficial(list, cat);
  else if (activeAssetSource === 'custom') _renderCustom(list, cat);
  else _renderPublic(list, cat);
  list.scrollTop = keepScroll;
}

function _makeCard(key, catId, icon, name, desc, sample) {
  const card = _div('assetCard');
  card.draggable = true;
  card.dataset.key = key;
  card.title = desc + ' — クリックで再生ヘッドの位置に追加 / タイムラインへドラッグして追加';
  const thumb = _div('assetThumb ' + catId, icon);
  if (sample) {
    if (sample.fontSize) thumb.style.fontSize = sample.fontSize + 'px';
    if (sample.weight) thumb.style.fontWeight = sample.weight;
    if (sample.color) thumb.style.color = sample.color;
    if (sample.font && typeof TEXT_FONTS !== 'undefined' && TEXT_FONTS[sample.font]) thumb.style.fontFamily = TEXT_FONTS[sample.font].css;
    if (sample.stroke) { thumb.style.webkitTextStroke = `1.5px ${sample.stroke}`; thumb.style.paintOrder = 'stroke fill'; }
    if (sample.glow) thumb.style.textShadow = `0 0 6px ${sample.glow}, 0 0 12px ${sample.glow}`;
    if (sample.bg) thumb.innerHTML = `<span style="background:${sample.bg};padding:1px 6px;border-radius:2px">${icon}</span>`;
  }
  card.appendChild(thumb);
  card.appendChild(_div('assetName', name));
  card.appendChild(_div('assetDesc', desc));

  card.addEventListener('click', (e) => {
    if (e.target.closest('.assetCardBtn, .assetSettings, input, button')) return;
    addAssetAt(key, curTick);
  });
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData(ASSET_DRAG_TYPE, key);
    e.dataTransfer.setData('text/plain', key);
    e.dataTransfer.effectAllowed = 'copy';
    document.body.classList.add('assetDragging');
  });
  card.addEventListener('dragend', () => {
    document.body.classList.remove('assetDragging');
    if (typeof tlShowSnapLine === 'function') tlShowSnapLine(null);
  });
  return card;
}

function _cardButton(card, text, title, onClick) {
  let bar = card.querySelector('.assetCardBtns');
  if (!bar) { bar = _div('assetCardBtns'); card.appendChild(bar); }
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'assetCardBtn';
  b.innerText = text;
  b.title = title;
  b.draggable = false;
  b.addEventListener('mousedown', (e) => e.stopPropagation());
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  bar.appendChild(b);
  return b;
}

function _renderOfficial(list, cat) {
  const grid = _div('assetGrid');
  for (const item of OFFICIAL_ASSETS[cat.id] || []) {
    const key = cat.id + ':' + item.id;
    const o = assetParams(cat.id, item.id);
    const card = _makeCard(key, cat.id, item.icon, item.label, `${item.desc} · ${_paramSummary(item, o)}`, item.sample);
    if (item.params && item.params.length) {
      const btn = _cardButton(card, '⚙', '秒数などの設定', () => {
        openAssetSettingsKey = openAssetSettingsKey === key ? null : key;
        renderAssetList();
      });
      if (openAssetSettingsKey === key) {
        btn.classList.add('active');
        card.classList.add('open');
        card.draggable = false; // スライダーを動かせるように
        card.appendChild(_buildSettings(cat.id, item));
      }
    }
    grid.appendChild(card);
  }
  list.appendChild(grid);
  list.appendChild(_div('assetHint', cat.id === 'camera'
    ? 'クリックで再生ヘッドの位置に、タイムラインへドラッグすると落とした時刻に追加されます。⚙ で秒数・距離などを変えられます。「プレイヤー」は右下で選んでいるプレイヤーが基準です。'
    : 'クリックで再生ヘッドの位置に、タイムラインへドラッグすると落とした時刻に追加されます。追加した後、ダブルクリックでフォント・縁取り・背景・動きなどを細かく設定できます。'));
}

// ⚙ の中身: 設定項目+「追加」「カスタムに保存」「初期値に戻す」
function _buildSettings(catId, item) {
  const box = _div('assetSettings');
  box.addEventListener('mousedown', (e) => e.stopPropagation());
  box.addEventListener('click', (e) => e.stopPropagation());
  const o = assetParams(catId, item.id);
  for (const p of item.params) {
    const row = _div('assetParam');
    const head = _div('assetParamHead');
    head.appendChild(_div('assetParamLabel', p.label));
    if (p.choices) {
      row.appendChild(head);
      const group = _div('settingsRadioGroup');
      for (const [text, val] of p.choices) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'settingsRadioPill small' + (o[p.key] === val ? ' active' : '');
        b.innerText = text;
        b.addEventListener('click', () => { setAssetParam(catId, item.id, p.key, val); renderAssetList(); });
        group.appendChild(b);
      }
      row.appendChild(group);
    } else {
      const val = _div('assetParamValue', `${o[p.key]}${p.unit || ''}`);
      head.appendChild(val);
      row.appendChild(head);
      const r = document.createElement('input');
      r.type = 'range'; r.min = p.min; r.max = p.max; r.step = p.step; r.value = o[p.key];
      r.dataset.param = p.key;
      r.addEventListener('input', () => {
        setAssetParam(catId, item.id, p.key, parseFloat(r.value));
        val.innerText = `${parseFloat(r.value)}${p.unit || ''}`;
      });
      r.addEventListener('change', () => {
        // カードの説明(秒数)を更新する
        const d = box.parentElement && box.parentElement.querySelector('.assetDesc');
        if (d) d.innerText = `${item.desc} · ${_paramSummary(item, assetParams(catId, item.id))}`;
      });
      row.appendChild(r);
    }
    box.appendChild(row);
  }
  const actions = _div('assetSettingsActions');
  const addBtn = document.createElement('button');
  addBtn.type = 'button'; addBtn.className = 'btn btn-primary btn-sm'; addBtn.innerText = '＋ この設定で追加';
  addBtn.addEventListener('click', () => addAssetAt(catId + ':' + item.id, curTick));
  actions.appendChild(addBtn);

  const saveRow = _div('assetSaveRow');
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'panelInput'; nameInput.placeholder = '名前(例: 8秒でゆっくり1周)';
  nameInput.value = '';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button'; saveBtn.className = 'btn btn-ghost btn-sm'; saveBtn.innerText = '⭐ 保存';
  saveBtn.title = 'この設定をカスタム素材として保存';
  const doSave = () => saveParamsAsCustom(catId, item.id, nameInput.value.trim() || `${item.label}(${_paramSummary(item, assetParams(catId, item.id))})`);
  saveBtn.addEventListener('click', doSave);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
  saveRow.appendChild(nameInput); saveRow.appendChild(saveBtn);
  actions.appendChild(saveRow);

  const reset = document.createElement('button');
  reset.type = 'button'; reset.className = 'assetLinkBtn'; reset.innerText = '初期値に戻す';
  reset.addEventListener('click', () => { resetAssetParams(catId, item.id); renderAssetList(); });
  actions.appendChild(reset);
  box.appendChild(actions);
  return box;
}

function _renderCustom(list, cat) {
  const mine = customAssets.filter(c => c.cat === cat.id);
  if (!mine.length) {
    const empty = _div('assetSoon');
    empty.innerHTML = '<b>まだカスタム素材はありません</b>';
    const p = document.createElement('p');
    p.innerText = cat.id === 'camera'
      ? '「公式」の素材の ⚙ で設定を変えて「⭐ 保存」、またはカメラブロックをダブルクリックして「⭐ このカメラの動きをカスタム素材に保存」で作れます。'
      : '「公式」の素材の ⚙ から、またはテキストをダブルクリックして「⭐ この見た目をカスタム素材に保存」で作れます。';
    empty.appendChild(p);
    list.appendChild(empty);
  } else {
    const grid = _div('assetGrid');
    for (const c of mine) {
      const key = 'custom:' + c.id;
      const card = _makeCard(key, cat.id, c.icon || '⭐', c.name, c.desc || '', c.sample);
      card.classList.add('custom');
      _cardButton(card, '✎', '名前を変える', () => {
        const nameEl = card.querySelector('.assetName');
        const inp = document.createElement('input');
        inp.type = 'text'; inp.className = 'panelInput assetRename'; inp.value = c.name;
        const done = () => { renameCustomAsset(c.id, inp.value); renderAssetList(); };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') renderAssetList(); e.stopPropagation(); });
        inp.addEventListener('blur', done);
        inp.addEventListener('mousedown', (e) => e.stopPropagation());
        inp.addEventListener('click', (e) => e.stopPropagation());
        nameEl.replaceWith(inp);
        card.draggable = false;
        inp.focus(); inp.select();
      });
      _cardButton(card, '✕', 'この素材を削除', () => {
        deleteCustomAsset(c.id);
        showToast(`「${c.name}」を削除しました`);
      });
      grid.appendChild(card);
    }
    list.appendChild(grid);
  }
  // 書き出し・読み込み(友達に渡す・別のパソコンに移す)
  const io = _div('assetIo');
  const exp = document.createElement('button');
  exp.type = 'button'; exp.className = 'btn btn-ghost btn-sm'; exp.innerText = '⬇ 書き出す';
  exp.disabled = !customAssets.length;
  exp.title = 'すべてのカスタム素材を .json ファイルに保存';
  exp.addEventListener('click', exportCustomAssets);
  const imp = document.createElement('button');
  imp.type = 'button'; imp.className = 'btn btn-ghost btn-sm'; imp.innerText = '⬆ 読み込む';
  imp.title = '書き出した .json ファイルから素材を追加';
  const file = document.createElement('input');
  file.type = 'file'; file.accept = '.json,application/json'; file.style.display = 'none';
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (f) importCustomAssetsFromText(await f.text());
    file.value = '';
  });
  imp.addEventListener('click', () => file.click());
  io.appendChild(exp); io.appendChild(imp); io.appendChild(file);
  list.appendChild(io);
  list.appendChild(_div('assetHint', 'カスタム素材はこのブラウザに保存されます。書き出したファイルを渡せば、他の人も「読み込む」で使えます。カメラの動きはプレイヤー基準で保存されるので、別の場面・別のリプレイでも同じ動きになります。'));
}

function _renderPublic(list, cat) {
  const box = _div('assetSoon');
  box.innerHTML = '<b>近日公開</b>';
  const p = document.createElement('p');
  p.innerText = `コミュニティサイトで公開された${cat.label}の素材を、ここから探して使えるようにする予定です。それまでは、「カスタム」タブの「⬆ 読み込む」で、他の人が書き出した素材ファイルを使えます。`;
  box.appendChild(p);
  list.appendChild(box);
}


// ------------------------------------------------------------
// ドラッグ&ドロップで追加
// ------------------------------------------------------------

function _isAssetDrag(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(ASSET_DRAG_TYPE);
}

// タイムライン上でドロップされる時刻(ブロックの端・再生ヘッドに吸着。Altで解除)
function _dropTick(e) {
  const raw = Math.max(0, tlTickFromClientX(e.clientX));
  const sn = tlSnap(raw, tlSnapCandidates(null, true), e);
  return { tick: Math.min(scMaxTick(), Math.max(0, sn.tick)), snapped: sn.snapped };
}

function setupAssetDropTargets() {
  const tl = document.getElementById('timelineScroll');
  tl.addEventListener('dragover', (e) => {
    if (!_isAssetDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    tlShowSnapLine(_dropTick(e).tick); // 落とす位置を線で見せる
  });
  tl.addEventListener('dragleave', (e) => {
    if (!tl.contains(e.relatedTarget)) tlShowSnapLine(null);
  });
  tl.addEventListener('drop', (e) => {
    if (!_isAssetDrag(e)) return;
    e.preventDefault();
    tlShowSnapLine(null);
    addAssetAt(e.dataTransfer.getData(ASSET_DRAG_TYPE), _dropTick(e).tick);
  });

  const area = document.getElementById('freecamArea');
  area.addEventListener('dragover', (e) => {
    if (!_isAssetDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  area.addEventListener('drop', (e) => {
    if (!_isAssetDrag(e)) return;
    e.preventDefault();
    addAssetAt(e.dataTransfer.getData(ASSET_DRAG_TYPE), curTick);
  });
}
