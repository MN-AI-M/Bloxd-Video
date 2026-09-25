// asset-library.js
// ============================================================
// 左の素材一覧(動画編集サイトによくある「素材パネル」)。
//
// カテゴリ(カメラ/テキスト/…)ごとに、素材カードを並べる。
//   - カードをクリック → 再生ヘッドの位置に追加
//   - カードをタイムラインへドラッグ → 落とした時刻に追加
//   - カードを3D画面へドラッグ → 再生ヘッドの位置に追加
//
// 素材は ASSET_CATEGORIES の表にまとめてある。今後、音楽・ポーズ・
// エフェクト・コミュニティサイトの素材を足す時は、この表にカテゴリや
// 素材(add関数を持つオブジェクト)を1つ追加するだけで済む。
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

// プレイヤーを基準にした固定カメラ。offsetFn(head, yaw) → 目の位置
function _playerShot(tick, label, offsetFn) {
  const p = _playerAt(tick);
  if (!p) { showToast('プレイヤーの情報がまだ読み込まれていません'); return null; }
  const pose = _lookAtPose(offsetFn(p.head, p.yaw), p.head);
  return addCameraAt(tick, [{ time: 0, ...pose }], { name: label, toast: `📷 「${label}」のカメラを置きました` });
}

// プレイヤーの動きに合わせて、0.5秒ごとにキーを打った動くカメラ
function _playerMovingShot(tick, label, seconds, eyeFn) {
  const p0 = _playerAt(tick);
  if (!p0) { showToast('プレイヤーの情報がまだ読み込まれていません'); return null; }
  const tps = scTps();
  const keys = [];
  for (let t = 0; t <= seconds + 1e-6; t += 0.5) {
    const p = _playerAt(tick + t * tps);
    keys.push({ time: t, ..._lookAtPose(eyeFn(p, p0, t / seconds), p.head) });
  }
  return addCameraAt(tick, keys, { seconds, name: label, toast: `🎬 「${label}」のカメラを置きました(${seconds}秒)` });
}

// ------------------------------------------------------------
// 素材の一覧
// ------------------------------------------------------------

const ASSET_CATEGORIES = [
  {
    id: 'camera', icon: '🎥', label: 'カメラ',
    hint: 'クリックで再生ヘッドの位置に、タイムラインへドラッグすると落とした時刻に追加されます。「プレイヤー」は右下で選んでいるプレイヤーが基準です。',
    items: [
      { id: 'view', icon: '📷', label: '今の視点', desc: '今見えている構図をそのまま (F)',
        add: (tick) => addCameraAt(tick, [{ time: 0, ...currentViewPose() }], {}) },
      { id: 'behind', icon: '🧍', label: '後ろから', desc: 'プレイヤーの背中越し',
        add: (tick) => _playerShot(tick, '後ろから', (h, y) => _add3(_add3(h, _fwd(y), -6), [0, 1, 0], 2)) },
      { id: 'front', icon: '🙂', label: '正面から', desc: 'プレイヤーの顔を正面から',
        add: (tick) => _playerShot(tick, '正面から', (h, y) => _add3(_add3(h, _fwd(y), 5), [0, 1, 0], 0.5)) },
      { id: 'side', icon: '↔', label: '横から', desc: 'プレイヤーを真横から',
        add: (tick) => _playerShot(tick, '横から', (h, y) => _add3(_add3(h, _right(y), 6), [0, 1, 0], 1)) },
      { id: 'top', icon: '⬇', label: '真上から', desc: '上から見下ろす(建築向き)',
        add: (tick) => _playerShot(tick, '真上から', (h, y) => _add3(_add3(h, [0, 1, 0], 18), _fwd(y), -0.5)) },
      { id: 'follow', icon: '🏃', label: '追いかける', desc: '後ろから4秒ついて行く(動く)',
        add: (tick) => _playerMovingShot(tick, '追いかけ', 4, (p, p0) =>
          _add3(_add3(p.head, _fwd(p0.yaw), -6), [0, 1, 0], 2.5)) },
      { id: 'orbit', icon: '🔄', label: '周りを回る', desc: '6秒でプレイヤーを1周(動く)',
        add: (tick) => _playerMovingShot(tick, '周回', 6, (p, p0, u) => {
          const a = p0.yaw + Math.PI + u * Math.PI * 2;
          return [p.head[0] + Math.sin(a) * 7, p.head[1] + 2.5, p.head[2] + Math.cos(a) * 7];
        }) },
    ],
  },
  {
    id: 'text', icon: '📝', label: 'テキスト',
    hint: 'クリックで再生ヘッドの位置に、タイムラインへドラッグすると落とした時刻に追加されます。位置はプレビュー上でドラッグして決めます。',
    items: [
      { id: 'title', icon: 'Aa', label: 'タイトル', desc: '中央に大きく・ポップ',
        sample: { fontSize: 22, weight: 900 },
        add: (tick) => addTextAt(tick, { content: 'タイトル', fontSize: 96, weight: 900, x: 0.5, y: 0.45, anim: 'pop' }, 'タイトル') },
      { id: 'subtitle', icon: 'Aa', label: '字幕', desc: '画面の下・フェード',
        sample: { fontSize: 14, weight: 700 },
        add: (tick) => addTextAt(tick, { content: '字幕テキスト', fontSize: 40, weight: 700, x: 0.5, y: 0.88, anim: 'fade' }, '字幕') },
      { id: 'heading', icon: 'Aa', label: '見出し', desc: '画面の上・オレンジ',
        sample: { fontSize: 17, weight: 900, color: '#E8A33D' },
        add: (tick) => addTextAt(tick, { content: '見出し', fontSize: 60, weight: 900, color: '#E8A33D', x: 0.5, y: 0.14, anim: 'slideUp' }, '見出し') },
      { id: 'plain', icon: 'Aa', label: 'テキスト', desc: 'ふつうの文字',
        sample: { fontSize: 15, weight: 700 },
        add: (tick) => addTextAt(tick, {}, 'テキスト') },
    ],
  },
  { id: 'music', icon: '🎵', label: '音楽', soon: '音声ファイルを読み込んで、BGMや効果音として並べられるようにする予定です。' },
  { id: 'pose', icon: '🕺', label: 'ポーズ', soon: 'プレイヤーの姿勢を決めて、タイムラインに並べられるようにする予定です。' },
  { id: 'effect', icon: '✨', label: 'エフェクト', soon: 'スロー・早送りや画面の効果などを追加する予定です。' },
  { id: 'community', icon: '🌐', label: 'みんなの素材', soon: 'コミュニティサイトで公開されたテクスチャやポーズを、ここから読み込めるようにする予定です。' },
];

let activeAssetCategoryId = 'camera';
let assetListCollapsed = false;
const ASSET_DRAG_TYPE = 'application/x-bloxd-asset';

function _findAsset(key) {
  const [catId, itemId] = String(key).split(':');
  const cat = ASSET_CATEGORIES.find(c => c.id === catId);
  return cat && cat.items ? cat.items.find(i => i.id === itemId) || null : null;
}

function addAssetAt(key, tick) {
  const item = _findAsset(key);
  if (!item) return;
  if (typeof stopPlayback === 'function') stopPlayback();
  item.add(Math.max(0, Math.round(tick)));
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
      renderAssetRail();
      renderAssetList();
    });
    rail.appendChild(b);
  }
}

function renderAssetList() {
  const list = document.getElementById('assetList');
  list.classList.toggle('collapsed', assetListCollapsed);
  list.innerHTML = '';
  if (assetListCollapsed) return;
  const cat = ASSET_CATEGORIES.find(c => c.id === activeAssetCategoryId);
  if (!cat) return;

  const title = document.createElement('div');
  title.className = 'assetListTitle';
  title.innerText = cat.icon + ' ' + cat.label;
  list.appendChild(title);

  if (cat.soon) {
    const soon = document.createElement('div');
    soon.className = 'assetSoon';
    soon.innerHTML = '<b>近日公開</b>';
    const p = document.createElement('p');
    p.innerText = cat.soon;
    soon.appendChild(p);
    list.appendChild(soon);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'assetGrid';
  for (const item of cat.items) {
    const card = document.createElement('div');
    card.className = 'assetCard';
    card.draggable = true;
    card.title = item.desc + ' — クリックで再生ヘッドの位置に追加 / タイムラインへドラッグして追加';
    const thumb = document.createElement('div');
    thumb.className = 'assetThumb ' + cat.id;
    thumb.innerText = item.icon;
    if (item.sample) {
      thumb.style.fontSize = item.sample.fontSize + 'px';
      thumb.style.fontWeight = item.sample.weight;
      if (item.sample.color) thumb.style.color = item.sample.color;
    }
    const name = document.createElement('div');
    name.className = 'assetName';
    name.innerText = item.label;
    const desc = document.createElement('div');
    desc.className = 'assetDesc';
    desc.innerText = item.desc;
    card.appendChild(thumb); card.appendChild(name); card.appendChild(desc);

    const key = cat.id + ':' + item.id;
    card.addEventListener('click', () => addAssetAt(key, curTick));
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
    grid.appendChild(card);
  }
  list.appendChild(grid);

  const hint = document.createElement('div');
  hint.className = 'assetHint';
  hint.innerText = cat.hint;
  list.appendChild(hint);
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
