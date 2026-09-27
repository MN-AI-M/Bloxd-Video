// script-library.js
// ============================================================
// カメラスクリプトの画面まわり:
//   - 公式スクリプト(サンプル。中身を見て、コピーして自分用に直せる)
//   - 左の素材一覧の「🧩 スクリプト」(公式 / カスタム / 公開)
//   - 右パネル: 説明・設定項目・▶実行・結果のログ
//   - コードエディタ(全画面): 書く・保存・実行・APIの説明
// 実行そのものは script-runner.js(隔離した場所で動かす)。
// ============================================================

// ------------------------------------------------------------
// 公式スクリプト(サンプル)。
// ※ このファイルの中では文字列をテンプレート(`)で囲んでいるので、
//   スクリプトの中ではテンプレート文字列を使わずに書いてある。
// ------------------------------------------------------------

const SCRIPT_TEMPLATE = `// 新しいスクリプト
// 右の「APIの説明」に、使える機能がまとまっています。
// 実行すると、下の api.addCamera などで指定したカメラが作られます(Ctrl+Z で戻せます)。

api.info({
  name: '新しいスクリプト',
  description: '再生ヘッドの位置に、プレイヤーを斜め上から見るカメラを置きます。',
});

// 設定項目(右パネルにスライダーなどとして出ます)
const p = api.params({
  seconds: { type: 'number', label: '長さ', min: 1, max: 20, step: 0.5, default: 4, unit: '秒' },
  height:  { type: 'number', label: '高さ', min: 0, max: 20, step: 0.5, default: 4, unit: 'ブロック' },
});

const me = api.player();              // 右下で選んでいるプレイヤー
const now = me.at(api.playhead);      // 再生ヘッドの時刻のプレイヤー
const V = api.math.vec;

// プレイヤーの右後ろ・少し上から、ずっとプレイヤーを見る(0.5秒ごとにポイント)
const keys = [];
for (let t = 0; t <= p.seconds; t += 0.5) {
  const f = me.at(api.playhead + api.toTick(t));
  const eye = V.add(now.head, [4, p.height, -4]);
  keys.push({ time: t, pos: eye, lookAt: f.head });
}
api.addCamera({ start: api.playhead, seconds: p.seconds, name: 'スクリプトのカメラ', keys: keys });
api.log('カメラを置きました: ' + keys.length + 'ポイント');
`;

const OFFICIAL_SCRIPTS = [
  {
    id: 'avoid', icon: '🧱', label: '障害物をよける', desc: '壁でプレイヤーが隠れる所だけ、カメラを手前に寄せる',
    code: `api.info({
  name: '障害物をよける',
  description: '選んだカメラとプレイヤーの間に壁やブロックがあると、その時だけカメラをプレイヤー側へ寄せて、ちゃんと映るようにします。',
});
const p = api.params({
  margin:  { type: 'number', label: '壁からの距離', min: 0.2, max: 3, step: 0.1, default: 0.6, unit: 'ブロック' },
  minDist: { type: 'number', label: '一番近づいて', min: 0.5, max: 6, step: 0.5, default: 1.5, unit: 'ブロック' },
  step:    { type: 'number', label: '調べる間隔', min: 0.1, max: 1, step: 0.05, default: 0.25, unit: '秒' },
  aim:     { type: 'bool',   label: 'よけた所ではプレイヤーの方を向く', default: true },
});

const cam = api.selectedCamera();
if (!cam) api.fail('先に、直したいカメラを選んでください(タイムラインのカメラをクリック)');

const me = api.player();
const V = api.math.vec;
const len = (cam.end - cam.start) / api.tps;
const n = Math.max(1, Math.round(len / p.step));
const keys = [];
let moved = 0;

for (let i = 0; i <= n; i++) {
  const t = len * i / n;
  const tick = cam.start + api.toTick(t);
  const pose = cam.poseAt(tick);
  const head = me.at(tick).head;
  let pos = pose.pos, yaw = pose.yaw, pitch = pose.pitch;

  // プレイヤーの頭 → カメラ の間にブロックがあるか
  const hit = api.world.raycast(head, pose.pos, { tick: tick, ignoreStart: true });
  if (hit) {
    const dir = V.norm(V.sub(pose.pos, head));
    pos = V.add(head, V.scale(dir, Math.max(p.minDist, hit.dist - p.margin)));
    moved++;
    if (p.aim) { const a = api.math.lookAt(pos, head); yaw = a.yaw; pitch = a.pitch; }
  }
  keys.push({ time: t, pos: pos, yaw: yaw, pitch: pitch });
  api.progress(i / n);
}

if (!moved) {
  api.toast('障害物はありませんでした(変更なし)');
  return;
}
api.updateCamera(cam.id, { keys: keys });
api.log((n + 1) + 'か所を調べて、' + moved + 'か所で壁をよけました');
api.toast('🧱 ' + moved + 'か所で壁をよけました');
`,
  },
  {
    id: 'eyelevel', icon: '👁', label: '目線の高さに合わせる', desc: 'カメラをプレイヤーの目の高さにして、顔の方を向かせる',
    code: `api.info({
  name: '目線の高さに合わせる',
  description: 'カメラの高さをプレイヤーの目の高さにそろえ、プレイヤーの顔の方を向かせます。「ポイントを足す」を入れると、動くプレイヤーにもずっと合わせます。',
});
const p = api.params({
  target: { type: 'choice', label: '対象', options: [['選んだカメラ', 'selected'], ['すべてのカメラ', 'all']], default: 'selected' },
  offset: { type: 'number', label: '目からの高さ', min: -2, max: 4, step: 0.1, default: 0.2, unit: 'ブロック' },
  aim:    { type: 'bool',   label: 'プレイヤーの顔の方を向く', default: true },
  follow: { type: 'bool',   label: '動くプレイヤーに合わせてポイントを足す', default: false },
  step:   { type: 'number', label: '足す間隔', min: 0.25, max: 2, step: 0.25, default: 0.5, unit: '秒' },
});

const list = p.target === 'all' ? api.cameras() : [api.selectedCamera()].filter(Boolean);
if (!list.length) api.fail(p.target === 'all' ? 'カメラがありません' : '先に、直したいカメラを選んでください');

const me = api.player();
let buried = 0;
for (const cam of list) {
  const len = (cam.end - cam.start) / api.tps;
  let times = cam.keys.map(function (k) { return k.time; });
  if (p.follow) {
    times = [];
    const n = Math.max(1, Math.round(len / p.step));
    for (let i = 0; i <= n; i++) times.push(len * i / n);
  }
  const keys = times.map(function (t) {
    const tick = cam.start + api.toTick(t);
    const pose = cam.poseAt(tick);
    const head = me.at(tick).head;
    const pos = [pose.pos[0], head[1] + p.offset, pose.pos[2]];
    if (api.world.isSolid(pos[0], pos[1], pos[2], tick)) buried++;
    const k = { time: t, pos: pos, yaw: pose.yaw, pitch: pose.pitch };
    if (p.aim) { const a = api.math.lookAt(pos, head); k.yaw = a.yaw; k.pitch = a.pitch; }
    const src = cam.keys.find(function (o) { return Math.abs(o.time - t) < 1e-6; });
    if (src && src.curve) k.curve = src.curve;
    return k;
  });
  api.updateCamera(cam.id, { keys: keys });
}
if (buried) api.log('注意: ' + buried + 'か所でカメラがブロックの中に入っています。「障害物をよける」も使ってみてください');
api.toast('👁 ' + list.length + '台のカメラを目線の高さに合わせました');
`,
  },
  {
    id: 'autocut', icon: '🎞', label: '自動カット割り', desc: 'いろいろな角度のカメラを自動で並べる',
    code: `api.info({
  name: '自動カット割り',
  description: '再生ヘッドから指定した長さを、いろいろな角度のカメラに自動で切り替えます。ジャンプ・しゃがみ・持ち物が変わった所で切り替わりやすく、プレイヤーが壁に隠れる角度は避けます。',
});
const p = api.params({
  length:  { type: 'number', label: '全体の長さ', min: 4, max: 120, step: 1, default: 12, unit: '秒' },
  shotMin: { type: 'number', label: '1カットの最短', min: 1, max: 8, step: 0.5, default: 2, unit: '秒' },
  shotMax: { type: 'number', label: '1カットの最長', min: 2, max: 15, step: 0.5, default: 4, unit: '秒' },
  dist:    { type: 'number', label: 'プレイヤーとの距離', min: 3, max: 20, step: 0.5, default: 7, unit: 'ブロック' },
  style:   { type: 'choice', label: '雰囲気', options: [['おまかせ', 'mix'], ['落ち着いた', 'calm'], ['派手', 'action']], default: 'mix' },
  avoid:   { type: 'bool',   label: 'プレイヤーが隠れる角度は使わない', default: true },
  replace: { type: 'bool',   label: 'この範囲にある今のカメラは消す', default: false },
  seed:    { type: 'number', label: '組み合わせ(変えると別の結果)', min: 1, max: 99, step: 1, default: 1 },
});

const me = api.player();
const V = api.math.vec, M = api.math;
const tps = api.tps;
const start = api.playhead;
const end = Math.min(api.totalTicks - 1, start + Math.round(p.length * tps));
if (end - start < tps) api.fail('残りの長さが短すぎます。再生ヘッドを前に動かしてください');
const rnd = M.random(p.seed * 7919);

// 角度の種類。eye(頭の位置, プレイヤーの向き) → カメラの位置
const ANGLES = {
  behind: { label: '後ろから', follow: true, eye: function (h, y) { return V.add(V.add(h, V.scale(M.forward(y), -p.dist)), [0, p.dist * 0.3, 0]); } },
  front:  { label: '正面',      eye: function (h, y) { return V.add(V.add(h, V.scale(M.forward(y), p.dist * 0.8)), [0, 0.3, 0]); } },
  left:   { label: '左から',    eye: function (h, y) { return V.add(V.add(h, V.scale(M.right(y), -p.dist)), [0, 1, 0]); } },
  right:  { label: '右から',    eye: function (h, y) { return V.add(V.add(h, V.scale(M.right(y), p.dist)), [0, 1, 0]); } },
  high:   { label: '斜め上',    eye: function (h, y) { return V.add(V.add(h, V.scale(M.forward(y + 135), p.dist)), [0, p.dist * 0.9, 0]); } },
  low:    { label: 'ローアングル', eye: function (h, y) { return V.add(V.add(h, V.scale(M.forward(y - 40), p.dist * 0.7)), [0, -1.1, 0]); } },
  wide:   { label: '引き',      eye: function (h, y) { return V.add(V.add(h, V.scale(M.forward(y + 60), p.dist * 2.2)), [0, p.dist * 0.8, 0]); } },
};
const POOLS = {
  mix: ['behind', 'left', 'front', 'high', 'right', 'wide', 'low'],
  calm: ['behind', 'wide', 'high', 'left', 'right'],
  action: ['low', 'behind', 'front', 'right', 'left', 'high'],
};

// 動きが変わる瞬間(ここで切り替えると気持ちいい)
const events = [];
let prev = me.at(start);
for (let t = start + 1; t <= end; t++) {
  const f = me.at(t);
  if ((f.jumping && !prev.jumping) || f.crouching !== prev.crouching || f.held !== prev.held || f.pose !== prev.pose) events.push(t);
  prev = f;
}

// 1カット分のキー。追いかける角度は一緒に動き、それ以外は置いたまま首を振る
function buildShot(name, t0, t1) {
  const a = ANGLES[name];
  const p0 = me.at(t0);
  const fixedEye = a.eye(p0.head, p0.yaw);
  const len = (t1 - t0) / tps;
  const n = Math.max(1, Math.round(len / 0.5));
  const keys = [];
  for (let i = 0; i <= n; i++) {
    const tick = t0 + (t1 - t0) * i / n;
    const head = me.at(tick).head;
    const eye = a.follow ? a.eye(head, p0.yaw) : fixedEye;
    keys.push({ time: len * i / n, pos: eye, lookAt: head, tick: tick, head: head });
  }
  return keys;
}
function visible(keys) {
  return keys.every(function (k) { return !api.world.raycast(k.head, k.pos, { tick: k.tick, ignoreStart: true }); });
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp; }
  return arr;
}

if (p.replace) {
  for (const c of api.cameras()) if (c.start >= start && c.end <= end) api.removeCamera(c.id);
}
// 今あるカメラと時間が重なる時は、そろって1つ上の層(手前)に並べる
let layer = 0;
for (const c of api.cameras()) {
  const removed = p.replace && c.start >= start && c.end <= end;
  if (!removed && c.start < end && c.end > start) layer = Math.max(layer, c.layer + 1);
}

let t = start, count = 0, last = null, hidden = 0;
while (t < end) {
  const minT = t + Math.round(p.shotMin * tps);
  const maxT = t + Math.round(Math.max(p.shotMin, p.shotMax) * tps);
  let cut = events.find(function (e) { return e >= minT && e <= maxT; });
  if (cut == null) cut = Math.round(minT + rnd() * (maxT - minT));
  if (end - cut < p.shotMin * tps) cut = end; // 最後のカットが短くなりすぎないように
  cut = Math.min(cut, end);

  const order = shuffle(POOLS[p.style].filter(function (a) { return a !== last; }));
  let chosen = null, keys = null;
  for (const name of order) {
    const k = buildShot(name, t, cut);
    if (!p.avoid || visible(k)) { chosen = name; keys = k; break; }
  }
  if (!chosen) { chosen = order[0]; keys = buildShot(chosen, t, cut); hidden++; }
  count++;
  api.addCamera({
    start: t, end: cut, name: 'カット' + count + ' ' + ANGLES[chosen].label, layer: layer,
    keys: keys.map(function (k) { return { time: k.time, pos: k.pos, lookAt: k.lookAt }; }),
  });
  last = chosen;
  t = cut;
  api.progress((t - start) / (end - start));
}
api.seek(start);
api.log(count + 'カットに分けました(切り替えの候補になった動き: ' + events.length + 'か所)');
if (hidden) api.log('注意: ' + hidden + 'カットは、どの角度でもプレイヤーが隠れてしまいました');
api.toast('🎞 ' + count + 'カットに自動で分けました');
`,
  },
  {
    id: 'handheld', icon: '🤳', label: '手持ちカメラ風', desc: '手で持って撮ったような小さな揺れを足す',
    code: `api.info({
  name: '手持ちカメラ風',
  description: '選んだカメラに、手で持って撮ったような小さな揺れを加えます。強さ・速さを変えると、ゆったりした揺れから激しい揺れまで作れます。',
});
const p = api.params({
  amount: { type: 'number', label: '位置の揺れ', min: 0, max: 0.6, step: 0.02, default: 0.12, unit: 'ブロック' },
  turn:   { type: 'number', label: '向きの揺れ', min: 0, max: 5, step: 0.1, default: 0.8, unit: '°' },
  speed:  { type: 'number', label: '揺れの速さ', min: 0.2, max: 4, step: 0.1, default: 0.8, unit: '回/秒' },
  step:   { type: 'number', label: 'ポイントの間隔', min: 0.05, max: 0.5, step: 0.05, default: 0.1, unit: '秒' },
  seed:   { type: 'number', label: '揺れ方の種類', min: 1, max: 99, step: 1, default: 1 },
});

const cam = api.selectedCamera();
if (!cam) api.fail('先に、揺らしたいカメラを選んでください');

const M = api.math;
const len = (cam.end - cam.start) / api.tps;
const n = Math.max(1, Math.round(len / p.step));
const keys = [];
for (let i = 0; i <= n; i++) {
  const t = len * i / n;
  const pose = cam.poseAt(cam.start + api.toTick(t));
  const u = t * p.speed;
  keys.push({
    time: t,
    pos: [pose.pos[0] + M.noise(u, p.seed) * p.amount,
          pose.pos[1] + M.noise(u, p.seed + 11) * p.amount * 0.6,
          pose.pos[2] + M.noise(u, p.seed + 23) * p.amount],
    yaw: pose.yaw + M.noise(u * 1.3, p.seed + 37) * p.turn,
    pitch: pose.pitch + M.noise(u * 1.1, p.seed + 51) * p.turn * 0.7,
  });
}
api.updateCamera(cam.id, { keys: keys });
api.toast('🤳 ' + cam.name + 'に手ぶれを加えました(' + keys.length + 'ポイント)');
`,
  },
];


// ------------------------------------------------------------
// スクリプトの一覧(公式+カスタム)
// ------------------------------------------------------------

const LS_SCRIPT_PARAMS = 'bloxdEditor.scriptParams.v1';
let scriptParamState = (typeof _lsGet === 'function') ? _lsGet(LS_SCRIPT_PARAMS, {}) : {};

// key: 'script:<id>'(公式)/ 'custom:<id>'(カスタム)
function scriptEntry(key) {
  const [a, b] = String(key).split(':');
  if (a === 'script') {
    const s = OFFICIAL_SCRIPTS.find(x => x.id === b);
    return s ? { key, official: true, id: s.id, name: s.label, icon: s.icon, desc: s.desc, code: s.code } : null;
  }
  if (a === 'custom') {
    const c = customAssets.find(x => x.id === b && x.type === 'script');
    return c ? { key, official: false, id: c.id, name: c.name, icon: c.icon || '🧩', desc: c.desc || '', code: c.code || '' } : null;
  }
  return null;
}

function renderScriptAssets(list, source) {
  if (source === 'official') {
    const grid = _div('assetGrid');
    for (const s of OFFICIAL_SCRIPTS) {
      const card = _makeCard('script:' + s.id, 'script', s.icon, s.label, s.desc, null);
      _cardButton(card, '</>', 'コードを見る', () => openScriptEditor('script:' + s.id));
      grid.appendChild(card);
    }
    list.appendChild(grid);
    list.appendChild(_div('assetHint', 'クリックすると右に設定と ▶実行 が出ます。スクリプトは、カメラを自動で作ったり直したりする小さなプログラムです。</> で中身を見て、コピーして自分用に書きかえられます。'));
    return;
  }
  if (source === 'custom') {
    const mine = customAssets.filter(c => c.type === 'script');
    const top = _div('assetIo');
    const newBtn = document.createElement('button');
    newBtn.type = 'button'; newBtn.className = 'btn btn-primary btn-sm'; newBtn.innerText = '＋ 新しく書く';
    newBtn.addEventListener('click', () => createCustomScript(SCRIPT_TEMPLATE, '新しいスクリプト', true));
    const impBtn = document.createElement('button');
    impBtn.type = 'button'; impBtn.className = 'btn btn-ghost btn-sm'; impBtn.innerText = '⬆ .js を読み込む';
    const file = document.createElement('input');
    file.type = 'file'; file.accept = '.js,text/javascript,application/javascript'; file.style.display = 'none';
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      if (f.size > 512 * 1024) { showToast('ファイルが大きすぎます(512KBまで)'); return; }
      importScriptFile(await f.text(), f.name);
    });
    impBtn.addEventListener('click', () => file.click());
    top.appendChild(newBtn); top.appendChild(impBtn); top.appendChild(file);
    list.appendChild(top);

    if (!mine.length) {
      const empty = _div('assetSoon');
      empty.innerHTML = '<b>まだ自分のスクリプトはありません</b>';
      const p = document.createElement('p');
      p.innerText = '「＋ 新しく書く」で書き始めるか、公式スクリプトの </> から「コピーして編集」してください。他の人からもらった .js も読み込めます。';
      empty.appendChild(p);
      list.appendChild(empty);
    } else {
      const grid = _div('assetGrid');
      for (const c of mine) {
        const key = 'custom:' + c.id;
        const card = _makeCard(key, 'script', c.icon || '🧩', c.name, c.desc || '', null);
        card.classList.add('custom');
        _cardButton(card, '</>', 'コードを編集', () => openScriptEditor(key));
        _cardButton(card, '✕', 'このスクリプトを削除', () => {
          if (!confirm(`「${c.name}」を削除しますか?`)) return;
          deleteCustomAsset(c.id);
          if (editPanelOpenFor && editPanelOpenFor.kind === 'script' && editPanelOpenFor.id === key) closeEditPanel();
          showToast(`「${c.name}」を削除しました`);
        });
        grid.appendChild(card);
      }
      list.appendChild(grid);
    }
    list.appendChild(_div('assetHint', 'スクリプトは、このページから切り離された安全な場所で動きます。他の人のスクリプトでも、あなたのデータやパソコンには触れられず、結果は Ctrl+Z で戻せます。'));
    return;
  }
  const box = _div('assetSoon');
  box.innerHTML = '<b>近日公開</b>';
  const p = document.createElement('p');
  p.innerText = 'コミュニティサイトで公開されたスクリプトを、ここから探して使えるようにする予定です。それまでは「カスタム」の「⬆ .js を読み込む」で、他の人のスクリプトを使えます。';
  box.appendChild(p);
  list.appendChild(box);
}

function createCustomScript(code, name, openEditor) {
  const entry = { id: _newCustomId(), cat: 'script', type: 'script', name: name || '新しいスクリプト', icon: '🧩', desc: '', code };
  customAssets.push(entry);
  _saveCustomAssets();
  activeAssetCategoryId = 'script'; activeAssetSource = 'custom'; assetListCollapsed = false;
  renderAssetRail(); renderAssetList();
  if (openEditor) openScriptEditor('custom:' + entry.id);
  return entry;
}

async function importScriptFile(code, fileName) {
  const base = String(fileName || 'スクリプト').replace(/\.js$/i, '');
  const entry = createCustomScript(code, base, false);
  // 名前・説明をスクリプト自身の api.info から取る(隔離した場所で、設定の所まで動かすだけ)
  const r = await runScriptSandboxed(code, 'describe', {});
  if (r.info) {
    if (r.info.name) entry.name = r.info.name.slice(0, 40);
    if (r.info.description) entry.desc = r.info.description.slice(0, 80);
    _saveCustomAssets();
    renderAssetList();
  }
  showToast(`🧩 「${entry.name}」を読み込みました`);
  openScriptPanel('custom:' + entry.id);
}

function _updateCustomScript(id, patch) {
  const c = customAssets.find(x => x.id === id);
  if (!c) return null;
  Object.assign(c, patch);
  _saveCustomAssets();
  return c;
}


// ------------------------------------------------------------
// 右パネル: 説明・設定・実行
// ------------------------------------------------------------

let scriptPanel = null; // { key, defs, values, body, targetEl, runBtn, resultEl, progressEl, running }

function openScriptPanel(key) {
  const entry = scriptEntry(key);
  if (!entry) return;
  const panel = document.getElementById('editPanel');
  const title = document.getElementById('editPanelTitle');
  const body = document.getElementById('editPanelBody');
  const wasExpanded = typeof tlExpandedCamId === 'function' ? tlExpandedCamId() : null;
  camPanel = null;
  panel.classList.add('open');
  document.getElementById('editor').classList.add('panelOpen');
  editPanelOpenFor = { kind: 'script', id: key };
  if (wasExpanded != null) timelineRenderBlocks();
  title.innerText = `${entry.icon} ${entry.name}`;
  body.innerHTML = '';

  const sp = scriptPanel = { key, defs: null, values: { ...(scriptParamState[key] || {}) }, body, running: false };

  const desc = _el('div', 'panelHint scriptDesc', entry.desc || '');
  body.appendChild(desc);
  sp.descEl = desc;

  sp.targetEl = _el('div', 'poseStatus scriptTarget');
  body.appendChild(sp.targetEl);
  refreshScriptPanelTarget();

  body.appendChild(_el('div', 'panelSectionLabel', '設定'));
  sp.paramsEl = _el('div', 'scriptParams');
  sp.paramsEl.appendChild(_el('div', 'panelHint', '設定を読み込み中…'));
  body.appendChild(sp.paramsEl);

  const actions = _el('div', 'panelActions');
  sp.runBtn = _el('button', 'btn btn-primary btn-sm', '▶ 実行');
  sp.runBtn.addEventListener('click', () => runScriptFromPanel());
  actions.appendChild(sp.runBtn);
  sp.progressEl = _el('div', 'scriptProgress');
  sp.progressEl.appendChild(_el('div', 'scriptProgressBar'));
  actions.appendChild(sp.progressEl);
  body.appendChild(actions);

  sp.resultEl = _el('div', 'scriptResult');
  body.appendChild(sp.resultEl);

  body.appendChild(_el('div', 'panelSectionLabel', 'コード'));
  const codeActions = _el('div', 'panelActions');
  const editBtn = _el('button', 'btn btn-ghost btn-sm', entry.official ? '</> コードを見る(コピーして編集できます)' : '</> コードを編集');
  editBtn.addEventListener('click', () => openScriptEditor(key));
  codeActions.appendChild(editBtn);
  const expBtn = _el('button', 'btn btn-ghost btn-sm', '⬇ .js で書き出す(人に渡す)');
  expBtn.addEventListener('click', () => downloadScript(entry));
  codeActions.appendChild(expBtn);
  body.appendChild(codeActions);
  body.appendChild(_el('div', 'panelHint', 'スクリプトはこのページから切り離された場所で動き、結果(カメラの追加・変更)だけを受け取ります。実行結果は Ctrl+Z 1回で元に戻せます。'));

  loadScriptParams(key);
}

// 設定項目を知るため、api.params の所まで(隔離した場所で)動かす
async function loadScriptParams(key) {
  const entry = scriptEntry(key);
  if (!entry || !scriptPanel || scriptPanel.key !== key) return;
  const r = await runScriptSandboxed(entry.code, 'describe', {});
  if (!scriptPanel || scriptPanel.key !== key) return;
  const box = scriptPanel.paramsEl;
  box.innerHTML = '';
  if (r.type === 'error' || r.type === 'timeout') {
    box.appendChild(_scriptMessage('error', 'スクリプトにエラーがあります' + (r.line ? `(${r.line}行目)` : '') + ': ' + r.message));
    return;
  }
  if (r.info && r.info.description && !entry.official && scriptPanel.descEl && !entry.desc) scriptPanel.descEl.innerText = r.info.description;
  scriptPanel.defs = r.defs || {};
  const keys = Object.keys(scriptPanel.defs);
  if (!keys.length) { box.appendChild(_el('div', 'panelHint', '設定項目はありません')); return; }
  for (const k of keys) box.appendChild(_buildScriptParam(k, scriptPanel.defs[k]));
  const reset = _el('button', 'assetLinkBtn', '初期値に戻す');
  reset.addEventListener('click', () => {
    delete scriptParamState[key]; _lsSet(LS_SCRIPT_PARAMS, scriptParamState);
    scriptPanel.values = {};
    loadScriptParams(key);
  });
  box.appendChild(reset);
}

function _scriptParamValue(k, def) {
  const v = scriptPanel.values[k];
  return v === undefined ? def.default : v;
}
function _setScriptParam(k, v) {
  scriptPanel.values[k] = v;
  scriptParamState[scriptPanel.key] = { ...scriptPanel.values };
  _lsSet(LS_SCRIPT_PARAMS, scriptParamState);
}

function _buildScriptParam(k, def) {
  def = def && typeof def === 'object' ? def : {};
  const label = String(def.label || k);
  const type = def.type || (typeof def.default === 'boolean' ? 'bool' : typeof def.default === 'string' ? 'text' : 'number');
  const v = _scriptParamValue(k, def);
  if (type === 'bool') {
    const row = _el('label', 'scriptCheck');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!v;
    cb.addEventListener('change', () => _setScriptParam(k, cb.checked));
    row.appendChild(cb); row.appendChild(document.createTextNode(label));
    return row;
  }
  if (type === 'choice') {
    const row = _el('div', 'fieldRow column');
    row.appendChild(_el('label', null, label));
    const group = _el('div', 'settingsRadioGroup');
    for (const opt of Array.isArray(def.options) ? def.options : []) {
      const [text, val] = Array.isArray(opt) ? opt : [String(opt), opt];
      const b = _el('button', 'settingsRadioPill small' + (val === v ? ' active' : ''), String(text));
      b.type = 'button';
      b.addEventListener('click', () => {
        _setScriptParam(k, val);
        group.querySelectorAll('.settingsRadioPill').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      });
      group.appendChild(b);
    }
    row.appendChild(group);
    return row;
  }
  if (type === 'text') {
    const row = _el('div', 'fieldRow column');
    row.appendChild(_el('label', null, label));
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'panelInput'; inp.value = v == null ? '' : String(v);
    inp.addEventListener('input', () => _setScriptParam(k, inp.value));
    row.appendChild(inp);
    return row;
  }
  // number
  const row = _el('div', 'assetParam');
  const head = _el('div', 'assetParamHead');
  head.appendChild(_el('div', 'assetParamLabel', label));
  const unit = def.unit ? String(def.unit) : '';
  const val = _el('div', 'assetParamValue', `${v}${unit}`);
  head.appendChild(val);
  row.appendChild(head);
  const r = document.createElement('input');
  r.type = 'range';
  r.min = def.min != null ? def.min : 0; r.max = def.max != null ? def.max : 100; r.step = def.step != null ? def.step : 'any';
  r.value = v;
  r.dataset.param = k;
  r.addEventListener('input', () => { const n = parseFloat(r.value); _setScriptParam(k, n); val.innerText = `${n}${unit}`; });
  row.appendChild(r);
  return row;
}

// 対象の表示(選んでいるカメラ・再生ヘッド)。選択が変わるたびに呼ばれる
function refreshScriptPanelTarget() {
  if (!scriptPanel || !scriptPanel.targetEl) return;
  const cam = scGetSelected();
  const sec = (curTick / scTps()).toFixed(1);
  const text = `選んでいるカメラ: ${cam ? scCamName(cam) : 'なし'} / 再生ヘッド: ${sec}秒`;
  if (scriptPanel.targetEl.innerText !== text) scriptPanel.targetEl.innerText = text;
}

function _scriptMessage(kind, text) {
  const d = _el('div', 'scriptMsg ' + kind, text);
  return d;
}

async function runScriptFromPanel() {
  const sp = scriptPanel;
  if (!sp || sp.running) return;
  const entry = scriptEntry(sp.key);
  if (!entry) return;
  if (typeof stopPlayback === 'function') stopPlayback();
  sp.running = true;
  sp.runBtn.disabled = true;
  sp.runBtn.innerText = '実行中…';
  sp.resultEl.innerHTML = '';
  sp.progressEl.classList.add('show');
  const bar = sp.progressEl.firstChild;
  bar.style.width = '0%';
  const values = {};
  for (const k of Object.keys(sp.defs || {})) values[k] = _scriptParamValue(k, sp.defs[k]);
  const r = await runScriptSandboxed(entry.code, 'run', values, (v) => { bar.style.width = Math.round(v * 100) + '%'; });
  sp.running = false;
  sp.runBtn.disabled = false;
  sp.runBtn.innerText = '▶ 実行';
  sp.progressEl.classList.remove('show');
  if (scriptPanel !== sp) { // 実行中にパネルが切り替わった時も、結果は反映する
    if (r.type === 'done') { const a = applyScriptOps(r.ops); showToast(a.error ? 'スクリプトの結果を反映できませんでした' : a.summary); }
    return;
  }
  showScriptResult(sp, r);
}

function showScriptResult(sp, r) {
  const box = sp.resultEl;
  box.innerHTML = '';
  if (r.type === 'done') {
    const a = applyScriptOps(r.ops);
    if (a.error) {
      box.appendChild(_scriptMessage('error', '結果を反映できませんでした: ' + a.error));
    } else {
      box.appendChild(_scriptMessage('ok', '✓ ' + a.summary));
      showToast(a.toasts && a.toasts.length ? a.toasts[a.toasts.length - 1] : a.summary);
    }
  } else if (r.type === 'fail') {
    box.appendChild(_scriptMessage('warn', r.message));
  } else {
    box.appendChild(_scriptMessage('error', (r.type === 'timeout' ? '' : 'エラー' + (r.line ? `(${r.line}行目)` : '') + ': ') + r.message));
    if (r.line) {
      const b = _el('button', 'assetLinkBtn', 'その行をエディタで見る');
      b.addEventListener('click', () => openScriptEditor(sp.key, r.line));
      box.appendChild(b);
    }
  }
  if (r.logs && r.logs.length) {
    const pre = _el('pre', 'scriptLog');
    pre.textContent = r.logs.join('\n');
    box.appendChild(pre);
  }
  refreshScriptPanelTarget();
}

function downloadScript(entry) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([entry.code], { type: 'text/javascript' }));
  a.download = (entry.name || 'script').replace(/[\\/:*?"<>|]/g, '_') + '.js';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}


// ------------------------------------------------------------
// コードエディタ(全画面)
// ------------------------------------------------------------

let scriptEditorState = null; // { key, official, dirty }

function _ensureScriptEditorDom() {
  if (document.getElementById('scriptEditor')) return;
  const wrap = document.createElement('div');
  wrap.id = 'scriptEditor';
  wrap.innerHTML = `
    <div id="scriptEditorBox">
      <div id="scriptEditorHead">
        <span class="seIcon">🧩</span>
        <input id="scriptEditorName" class="panelInput" type="text" maxlength="40" placeholder="スクリプトの名前">
        <span id="scriptEditorBadge"></span>
        <div class="tbSpacer"></div>
        <button id="scriptEditorCopy" class="btn btn-primary btn-sm" type="button">⧉ コピーして編集</button>
        <button id="scriptEditorSave" class="btn btn-ghost btn-sm" type="button" title="Ctrl+S">💾 保存</button>
        <button id="scriptEditorRun" class="btn btn-primary btn-sm" type="button" title="Ctrl+Enter">▶ 保存して実行</button>
        <button id="scriptEditorDocsToggle" class="btn btn-ghost btn-sm" type="button">📖 APIの説明</button>
        <button id="scriptEditorClose" type="button" title="閉じる">✕</button>
      </div>
      <div id="scriptEditorMain">
        <div id="scriptEditorCodeWrap">
          <pre id="scriptEditorGutter" aria-hidden="true"></pre>
          <textarea id="scriptEditorCode" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea>
        </div>
        <div id="scriptEditorDocs"></div>
      </div>
      <div id="scriptEditorStatus"></div>
    </div>`;
  document.body.appendChild(wrap);
  document.getElementById('scriptEditorDocs').innerHTML = SCRIPT_API_DOCS_HTML;

  const ta = document.getElementById('scriptEditorCode');
  const gutter = document.getElementById('scriptEditorGutter');
  const syncGutter = () => {
    const n = ta.value.split('\n').length;
    if (gutter.dataset.n !== String(n)) {
      gutter.dataset.n = String(n);
      gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    }
    gutter.scrollTop = ta.scrollTop;
  };
  ta.addEventListener('input', () => { syncGutter(); if (scriptEditorState && !scriptEditorState.official) scriptEditorState.dirty = true; });
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  ta.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveScriptEditor(); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); saveScriptEditor(true); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeScriptEditor(); return; }
    if (ta.readOnly) return;
    if (e.key === 'Tab') {
      // Tab で字下げ(2文字)
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      ta.setRangeText('  ', s, en, 'end');
      ta.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter' && !mod) {
      // 改行した時、前の行の字下げを引き継ぐ
      e.preventDefault();
      const s = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
      const indent = /^[ \t]*/.exec(ta.value.slice(lineStart, s))[0];
      const extra = /[{([]\s*$/.test(ta.value.slice(lineStart, s)) ? '  ' : '';
      ta.setRangeText('\n' + indent + extra, s, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });
  ta._syncGutter = syncGutter;
  document.getElementById('scriptEditorName').addEventListener('input', () => { if (scriptEditorState) scriptEditorState.dirty = true; });
  document.getElementById('scriptEditorSave').addEventListener('click', () => saveScriptEditor());
  document.getElementById('scriptEditorRun').addEventListener('click', () => saveScriptEditor(true));
  document.getElementById('scriptEditorClose').addEventListener('click', () => closeScriptEditor());
  document.getElementById('scriptEditorCopy').addEventListener('click', () => {
    const entry = scriptEntry(scriptEditorState.key);
    if (!entry) return;
    const c = createCustomScript(entry.code, entry.name + '(コピー)', false);
    c.desc = entry.desc; _saveCustomAssets(); renderAssetList();
    showToast('⧉ コピーしました。自由に書きかえられます');
    openScriptEditor('custom:' + c.id);
  });
  document.getElementById('scriptEditorDocsToggle').addEventListener('click', () => {
    document.getElementById('scriptEditor').classList.toggle('docsHidden');
  });
}

function openScriptEditor(key, gotoLine) {
  const entry = scriptEntry(key);
  if (!entry) return;
  _ensureScriptEditorDom();
  if (typeof stopPlayback === 'function') stopPlayback();
  scriptEditorState = { key, official: entry.official, dirty: false };
  const ed = document.getElementById('scriptEditor');
  ed.classList.add('open');
  ed.classList.toggle('readonly', entry.official);
  const ta = document.getElementById('scriptEditorCode');
  ta.value = entry.code;
  ta.readOnly = entry.official;
  ta._syncGutter();
  ta.scrollTop = 0;
  const name = document.getElementById('scriptEditorName');
  name.value = entry.name;
  name.readOnly = entry.official;
  document.getElementById('scriptEditorBadge').innerText = entry.official ? '公式(読み取り専用)' : '';
  document.getElementById('scriptEditorStatus').innerText = entry.official
    ? '公式スクリプトは書きかえられません。「⧉ コピーして編集」で自分用のコピーを作れます。'
    : 'Ctrl+S: 保存 / Ctrl+Enter: 保存して実行 / Esc: 閉じる';
  document.getElementById('scriptEditorStatus').className = '';
  ta.focus();
  if (gotoLine) _scriptEditorGotoLine(gotoLine);
  else ta.setSelectionRange(0, 0);
}

function _scriptEditorGotoLine(line) {
  const ta = document.getElementById('scriptEditorCode');
  const lines = ta.value.split('\n');
  let pos = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
  ta.focus();
  ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  ta.scrollTop = Math.max(0, (line - 4) * lh);
}

async function saveScriptEditor(andRun) {
  const st = scriptEditorState;
  if (!st) return;
  const status = document.getElementById('scriptEditorStatus');
  if (!st.official) {
    const [, id] = st.key.split(':');
    const code = document.getElementById('scriptEditorCode').value;
    const name = document.getElementById('scriptEditorName').value.trim() || '名前のないスクリプト';
    _updateCustomScript(id, { code, name });
    st.dirty = false;
    // 説明は api.info から取る(書いてあれば)
    const r = await runScriptSandboxed(code, 'describe', {});
    if (r.info && r.info.description) _updateCustomScript(id, { desc: r.info.description.slice(0, 80) });
    renderAssetList();
    if (r.type === 'error' || r.type === 'timeout') {
      status.className = 'error';
      status.innerText = '保存しました。ただしエラーがあります' + (r.line ? `(${r.line}行目)` : '') + ': ' + r.message;
      if (r.line) _scriptEditorGotoLine(r.line);
      if (andRun) return;
    } else {
      status.className = 'ok';
      status.innerText = '✓ 保存しました';
    }
  }
  if (andRun) {
    openScriptPanel(st.key);
    closeScriptEditor(true);
    // 設定項目を読み込んでから実行する
    await loadScriptParams(st.key);
    runScriptFromPanel();
  } else if (scriptPanel && scriptPanel.key === st.key) {
    openScriptPanel(st.key); // パネルの設定項目を新しいコードに合わせる
  }
}

function closeScriptEditor(force) {
  const st = scriptEditorState;
  if (st && st.dirty && !force && !confirm('保存していない変更があります。閉じますか?')) return;
  document.getElementById('scriptEditor').classList.remove('open');
  scriptEditorState = null;
}

function isScriptEditorOpen() {
  const ed = document.getElementById('scriptEditor');
  return !!ed && ed.classList.contains('open');
}


// ------------------------------------------------------------
// エディタの横に出す、APIの説明(短い版。詳しくは SCRIPT_API.md)
// ------------------------------------------------------------

const SCRIPT_API_DOCS_HTML = `
<h3>カメラスクリプトの基本</h3>
<p>スクリプトは実行すると、<b>カメラやテキストを作る・直す命令</b>を出します。命令はまとめて反映され、<kbd>Ctrl</kbd>+<kbd>Z</kbd> 1回で全部元に戻せます。</p>
<p>座標は Bloxd のワールド座標(画面左上と同じ)、角度は<b>度</b>、<code>tick</code> はリプレイのコマ番号(<code>api.tps</code> コマ = 1秒)、キーの <code>time</code> はカメラの先頭からの<b>秒</b>です。</p>

<h4>情報・設定</h4>
<table>
<tr><td><code>api.info({ name, description })</code></td><td>名前と説明</td></tr>
<tr><td><code>api.params({ key: {…} })</code></td><td>設定項目を出し、今の値を返す。<br>type: <code>'number'</code>(min, max, step, unit)/ <code>'bool'</code> / <code>'choice'</code>(options: [[表示, 値], …])/ <code>'text'</code>。どれも default を書く</td></tr>
<tr><td><code>api.tps</code> / <code>api.totalTicks</code></td><td>1秒のコマ数 / 全体のコマ数</td></tr>
<tr><td><code>api.playhead</code></td><td>再生ヘッドの tick</td></tr>
<tr><td><code>api.toTick(秒)</code> / <code>api.toSec(tick)</code></td><td>秒 ⇄ tick</td></tr>
<tr><td><code>api.view</code></td><td>今の編集視点 { pos, yaw, pitch, fov }</td></tr>
</table>

<h4>プレイヤー</h4>
<table>
<tr><td><code>api.player(id?)</code></td><td>プレイヤー(省略すると右下で選んでいる人)</td></tr>
<tr><td><code>player.at(tick)</code></td><td>{ pos(足元), head(目), yaw, pitch, pose, held, jumping, crouching }</td></tr>
<tr><td><code>api.players()</code></td><td>全員の { id, name, isMe }</td></tr>
</table>

<h4>地形</h4>
<table>
<tr><td><code>api.world.raycast(from, to, { tick, ignoreStart })</code></td><td>線分で最初にぶつかるブロック。{ pos, block, normal, dist } か null。ignoreStart: true で出発点のブロックは見ない(プレイヤーの頭が草や水の中にある時など)</td></tr>
<tr><td><code>api.world.isSolid(x, y, z, tick?)</code></td><td>そこにブロックがあるか</td></tr>
<tr><td><code>api.world.groundY(x, z, fromY?, tick?)</code></td><td>その列の地面の高さ</td></tr>
</table>
<p class="note">tick を渡すと、その時点で建っているブロックだけを見ます(建築の途中を正しく扱えます)。</p>

<h4>カメラを読む</h4>
<table>
<tr><td><code>api.cameras()</code></td><td>全カメラ { id, name, start, end, layer, fov, display, keys }</td></tr>
<tr><td><code>api.selectedCamera()</code></td><td>選んでいるカメラ(無ければ null)</td></tr>
<tr><td><code>cam.poseAt(tick)</code></td><td>その時刻の { pos, yaw, pitch }(補間込み)</td></tr>
</table>

<h4>作る・直す</h4>
<table>
<tr><td><code>api.addCamera({ start, end | seconds, name, fov, layer, display, keys })</code></td><td>カメラを追加(戻り値は後で使えるID)</td></tr>
<tr><td><code>api.updateCamera(id, { keys, start, end, name, fov, display, layer })</code></td><td>書いた所だけ変える(keys は全部入れ替え)</td></tr>
<tr><td><code>api.removeCamera(id)</code></td><td>削除</td></tr>
<tr><td><code>api.addText({ start, seconds, content, x, y, …見た目 })</code></td><td>テキストを追加</td></tr>
<tr><td><code>api.select(id)</code> / <code>api.seek(tick)</code></td><td>選択 / 再生ヘッドの移動</td></tr>
</table>
<p>キーは <code>{ time, pos, yaw, pitch }</code>。yaw・pitch の代わりに <code>lookAt: [x, y, z]</code> でその点を向きます。<code>curve</code> に 'smooth' / 'easeIn' / 'easeOut' / 'linear' か [x1, y1, x2, y2] で、次のキーまでの速さのカーブ。</p>

<h4>べんりな道具</h4>
<table>
<tr><td><code>api.math.vec</code></td><td>add, sub, scale, dot, cross, len, dist, norm, lerp</td></tr>
<tr><td><code>api.math.lookAt(from, to)</code></td><td>{ yaw, pitch }</td></tr>
<tr><td><code>api.math.forward(yaw, pitch)</code> / <code>right(yaw)</code></td><td>向き → ベクトル</td></tr>
<tr><td><code>api.math.noise(t, seed)</code></td><td>なめらかな揺れ(-1〜1)</td></tr>
<tr><td><code>api.math.random(seed)</code></td><td>毎回同じ順で出る乱数を作る</td></tr>
<tr><td>clamp, lerp, smoothstep, easeInOut, angleDiff</td><td></td></tr>
</table>

<h4>その他</h4>
<table>
<tr><td><code>api.log(…)</code></td><td>結果の欄に表示</td></tr>
<tr><td><code>api.toast(文)</code></td><td>画面上に通知</td></tr>
<tr><td><code>api.fail(文)</code></td><td>理由を出して止める(何も変えない)</td></tr>
<tr><td><code>api.progress(0〜1)</code></td><td>進み具合のバー</td></tr>
</table>
<p class="note">スクリプトは隔離された場所で動くので、ネットワークやページの中身には触れません。${SCRIPT_TIMEOUT_MS / 1000}秒で打ち切られます。<code>await</code> も使えます。</p>
`;
