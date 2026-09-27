// script-library.js
// ============================================================
// カメラの素材 = スクリプト。
//
//   左の素材一覧の「🎥 カメラ」は、全部が小さなスクリプトでできている。
//     公式   … 最初から入っているスクリプト(</> で中身を見て、コピーして直せる)
//     カスタム … 自分で書いた・保存した・人からもらったスクリプト(.js で書き出し/読み込み)
//     公開   … 予定
//   素材を置くと、その場でスクリプトが動いて(隔離した場所で)カメラとキーが作られる。
//
//   作ったカメラは「どのスクリプトの、どの設定で作ったか」を覚えている。
//   カメラをダブルクリックした右パネルで設定を変えると、その場で作り直される。
//
// 実行そのものは script-runner.js。
// ============================================================

const SCRIPT_P = {
  seconds: (d) => `seconds: { type: 'number', label: '長さ', min: 0.5, max: 30, step: 0.5, default: ${d}, unit: '秒' },`,
  avoid: (d) => `avoid:   { type: 'bool',   label: '壁でプレイヤーが隠れたらよける', default: ${d} },`,
  shake: `shake:   { type: 'number', label: '手ぶれ', min: 0, max: 1, step: 0.05, default: 0 },`,
  track: `track:   { type: 'bool',   label: '動くプレイヤーを目で追う', default: false },`,
  smooth: `smooth:  { type: 'choice', label: '動き方', options: [['なめらか', 1], ['等速', 0]], default: 1 },`,
};

// プレイヤーを基準に置く「固定」カメラのスクリプトを作る(中身は読みやすい普通のコードになる)
function _fixedShotScript(name, description, params, eyeCode) {
  return `api.info({
  name: '${name}',
  description: '${description}',
});
const p = api.params({
  ${SCRIPT_P.seconds(3)}
${params}
  ${SCRIPT_P.track}
  ${SCRIPT_P.avoid('true')}
  ${SCRIPT_P.shake}
});

const me = api.player();          // 右下で選んでいるプレイヤー
const V = api.math.vec, M = api.math;
const f = me.at(api.start);       // 置いた時刻のプレイヤー

// カメラの位置
${eyeCode}

// キー: 目で追う時は0.5秒ごとにプレイヤーの方へ向け直す
const keys = [];
const n = p.track ? Math.max(1, Math.round(p.seconds / 0.5)) : 0;
for (let i = 0; i <= n; i++) {
  const t = n ? p.seconds * i / n : 0;
  keys.push({ time: t, pos: eye, lookAt: me.at(api.start + api.toTick(t)).head });
}

api.addCamera({
  start: api.start, seconds: p.seconds, name: '${name}',
  keys: api.fx.finish(keys, { seconds: p.seconds, avoid: p.avoid, shake: p.shake }),
});
`;
}

const OFFICIAL_CAMERA_SCRIPTS = [
  {
    id: 'view', icon: '📷', label: '今の視点', desc: '今見えている構図をそのまま (F)',
    code: `api.info({
  name: '今の視点',
  description: '今見えている構図のまま、カメラを置きます(F キーと同じ)。',
});
const p = api.params({
  ${SCRIPT_P.seconds(3)}
  ${SCRIPT_P.shake}
});
const v = api.view; // 置いた時の編集視点 { pos, yaw, pitch, fov }
api.addCamera({
  start: api.start, seconds: p.seconds, fov: v.fov, name: 'カメラ',
  keys: api.fx.finish([{ time: 0, pos: v.pos, yaw: v.yaw, pitch: v.pitch }], { seconds: p.seconds, shake: p.shake }),
});
`,
  },
  {
    id: 'behind', icon: '🧍', label: '後ろから', desc: 'プレイヤーの背中越し',
    code: _fixedShotScript('後ろから', 'プレイヤーの背中越しに映します。',
      `  dist:    { type: 'number', label: '距離', min: 1, max: 30, step: 0.5, default: 6, unit: 'ブロック' },
  height:  { type: 'number', label: '高さ', min: -4, max: 30, step: 0.5, default: 2, unit: 'ブロック' },`,
      `const eye = V.add(V.add(f.head, V.scale(M.forward(f.yaw), -p.dist)), [0, p.height, 0]);`),
  },
  {
    id: 'front', icon: '🙂', label: '正面から', desc: 'プレイヤーの顔を正面から',
    code: _fixedShotScript('正面から', 'プレイヤーの顔を正面から映します。',
      `  dist:    { type: 'number', label: '距離', min: 1, max: 30, step: 0.5, default: 5, unit: 'ブロック' },
  height:  { type: 'number', label: '高さ', min: -4, max: 30, step: 0.5, default: 0.5, unit: 'ブロック' },`,
      `const eye = V.add(V.add(f.head, V.scale(M.forward(f.yaw), p.dist)), [0, p.height, 0]);`),
  },
  {
    id: 'side', icon: '↔', label: '横から', desc: 'プレイヤーを真横から',
    code: _fixedShotScript('横から', 'プレイヤーを真横から映します。',
      `  dist:    { type: 'number', label: '距離', min: 1, max: 30, step: 0.5, default: 6, unit: 'ブロック' },
  height:  { type: 'number', label: '高さ', min: -4, max: 30, step: 0.5, default: 1, unit: 'ブロック' },
  side:    { type: 'choice', label: '向き', options: [['右から', 1], ['左から', -1]], default: 1 },`,
      `const eye = V.add(V.add(f.head, V.scale(M.right(f.yaw), p.dist * p.side)), [0, p.height, 0]);`),
  },
  {
    id: 'top', icon: '⬇', label: '真上から', desc: '上から見下ろす(建築向き)',
    code: _fixedShotScript('真上から', '上から見下ろします。建築の様子を見せるのに向いています。',
      `  height:  { type: 'number', label: '高さ', min: 2, max: 60, step: 0.5, default: 18, unit: 'ブロック' },`,
      `const eye = V.add(V.add(f.head, [0, p.height, 0]), V.scale(M.forward(f.yaw), -0.5));`),
  },
  {
    id: 'follow', icon: '🏃', label: '追いかける', desc: '後ろからついて行く(動く)',
    code: `api.info({
  name: '追いかける',
  description: 'プレイヤーの後ろから、同じ距離を保ってついて行きます。',
});
const p = api.params({
  ${SCRIPT_P.seconds(4)}
  dist:    { type: 'number', label: '距離', min: 1, max: 30, step: 0.5, default: 6, unit: 'ブロック' },
  height:  { type: 'number', label: '高さ', min: -4, max: 30, step: 0.5, default: 2.5, unit: 'ブロック' },
  step:    { type: 'number', label: 'ポイントの間隔', min: 0.25, max: 2, step: 0.25, default: 0.5, unit: '秒' },
  ${SCRIPT_P.avoid('true')}
  ${SCRIPT_P.shake}
});
const me = api.player(), V = api.math.vec, M = api.math;
const f0 = me.at(api.start);
const keys = [];
const n = Math.max(1, Math.round(p.seconds / p.step));
for (let i = 0; i <= n; i++) {
  const t = p.seconds * i / n;
  const f = me.at(api.start + api.toTick(t));
  // 向きは置いた時のまま(プレイヤーが振り向いてもカメラは振り回されない)
  const eye = V.add(V.add(f.head, V.scale(M.forward(f0.yaw), -p.dist)), [0, p.height, 0]);
  keys.push({ time: t, pos: eye, lookAt: f.head });
}
api.addCamera({
  start: api.start, seconds: p.seconds, name: '追いかけ',
  keys: api.fx.finish(keys, { seconds: p.seconds, avoid: p.avoid, shake: p.shake }),
});
`,
  },
  {
    id: 'orbit', icon: '🔄', label: '周りを回る', desc: 'プレイヤーの周りを回る(動く)',
    code: `api.info({
  name: '周りを回る',
  description: 'プレイヤーを見ながら、周りをぐるっと回ります。',
});
const p = api.params({
  ${SCRIPT_P.seconds(6)}
  dist:    { type: 'number', label: '半径', min: 1, max: 30, step: 0.5, default: 7, unit: 'ブロック' },
  height:  { type: 'number', label: '高さ', min: -4, max: 30, step: 0.5, default: 2.5, unit: 'ブロック' },
  angle:   { type: 'number', label: '回る角度', min: 45, max: 720, step: 15, default: 360, unit: '°' },
  dir:     { type: 'choice', label: '向き', options: [['左回り', 1], ['右回り', -1]], default: 1 },
  ${SCRIPT_P.smooth}
  ${SCRIPT_P.avoid('true')}
  ${SCRIPT_P.shake}
});
const me = api.player(), M = api.math;
const f0 = me.at(api.start);
const keys = [];
const n = Math.max(1, Math.round(p.seconds / 0.5));
for (let i = 0; i <= n; i++) {
  const t = p.seconds * i / n;
  const u = p.smooth ? M.easeInOut(i / n) : i / n;       // 0 → 1 の進み具合
  const a = (f0.yaw + 180 + p.dir * u * p.angle) * M.DEG; // 後ろから回り始める
  const h = me.at(api.start + api.toTick(t)).head;
  keys.push({ time: t, pos: [h[0] + Math.sin(a) * p.dist, h[1] + p.height, h[2] + Math.cos(a) * p.dist], lookAt: h });
}
api.addCamera({
  start: api.start, seconds: p.seconds, name: '周回',
  keys: api.fx.finish(keys, { seconds: p.seconds, avoid: p.avoid, shake: p.shake }),
});
`,
  },
  {
    id: 'dolly', icon: '🔍', label: 'ゆっくり寄る', desc: '遠くからプレイヤーに近づく(動く)',
    code: `api.info({
  name: 'ゆっくり寄る',
  description: '遠くから、プレイヤーにゆっくり近づいていきます。',
});
const p = api.params({
  ${SCRIPT_P.seconds(4)}
  from:    { type: 'number', label: '始めの距離', min: 2, max: 40, step: 0.5, default: 14, unit: 'ブロック' },
  to:      { type: 'number', label: '終わりの距離', min: 1, max: 40, step: 0.5, default: 4, unit: 'ブロック' },
  height:  { type: 'number', label: '高さ', min: -4, max: 30, step: 0.5, default: 2, unit: 'ブロック' },
  ${SCRIPT_P.smooth}
  ${SCRIPT_P.avoid('true')}
  ${SCRIPT_P.shake}
});
const me = api.player(), V = api.math.vec, M = api.math;
const f0 = me.at(api.start);
const keys = [];
const n = Math.max(1, Math.round(p.seconds / 0.5));
for (let i = 0; i <= n; i++) {
  const t = p.seconds * i / n;
  const u = p.smooth ? M.easeInOut(i / n) : i / n;
  const h = me.at(api.start + api.toTick(t)).head;
  const d = p.from + (p.to - p.from) * u;
  keys.push({ time: t, pos: V.add(V.add(h, V.scale(M.forward(f0.yaw), -d)), [0, p.height, 0]), lookAt: h });
}
api.addCamera({
  start: api.start, seconds: p.seconds, name: '寄り',
  keys: api.fx.finish(keys, { seconds: p.seconds, avoid: p.avoid, shake: p.shake }),
});
`,
  },
  {
    id: 'rise', icon: '🛗', label: '上へ昇る', desc: 'プレイヤーを見ながら上昇(動く)',
    code: `api.info({
  name: '上へ昇る',
  description: 'プレイヤーを見ながら、下から上へ昇っていきます。',
});
const p = api.params({
  ${SCRIPT_P.seconds(5)}
  dist:    { type: 'number', label: '距離', min: 1, max: 30, step: 0.5, default: 8, unit: 'ブロック' },
  h0:      { type: 'number', label: '始めの高さ', min: -2, max: 30, step: 0.5, default: 0, unit: 'ブロック' },
  h1:      { type: 'number', label: '終わりの高さ', min: 0, max: 60, step: 0.5, default: 16, unit: 'ブロック' },
  ${SCRIPT_P.smooth}
  ${SCRIPT_P.avoid('false')}
  ${SCRIPT_P.shake}
});
const me = api.player(), V = api.math.vec, M = api.math;
const f0 = me.at(api.start);
const keys = [];
const n = Math.max(1, Math.round(p.seconds / 0.5));
for (let i = 0; i <= n; i++) {
  const t = p.seconds * i / n;
  const u = p.smooth ? M.easeInOut(i / n) : i / n;
  const h = me.at(api.start + api.toTick(t)).head;
  keys.push({ time: t, pos: V.add(V.add(h, V.scale(M.forward(f0.yaw), -p.dist)), [0, p.h0 + (p.h1 - p.h0) * u, 0]), lookAt: h });
}
api.addCamera({
  start: api.start, seconds: p.seconds, name: '上昇',
  keys: api.fx.finish(keys, { seconds: p.seconds, avoid: p.avoid, shake: p.shake }),
});
`,
  },
  {
    id: 'autocut', icon: '🎞', label: '自動カット割り', desc: 'いろいろな角度のカメラを自動で並べる',
    code: `api.info({
  name: '自動カット割り',
  description: '置いた所から指定した長さを、いろいろな角度のカメラに自動で切り替えます。ジャンプ・しゃがみ・持ち物が変わった所で切り替わりやすく、プレイヤーが壁に隠れる角度は避けます。',
});
const p = api.params({
  length:  { type: 'number', label: '全体の長さ', min: 4, max: 120, step: 1, default: 12, unit: '秒' },
  shotMin: { type: 'number', label: '1カットの最短', min: 1, max: 8, step: 0.5, default: 2, unit: '秒' },
  shotMax: { type: 'number', label: '1カットの最長', min: 2, max: 15, step: 0.5, default: 4, unit: '秒' },
  dist:    { type: 'number', label: 'プレイヤーとの距離', min: 3, max: 20, step: 0.5, default: 7, unit: 'ブロック' },
  style:   { type: 'choice', label: '雰囲気', options: [['おまかせ', 'mix'], ['落ち着いた', 'calm'], ['派手', 'action']], default: 'mix' },
  avoid:   { type: 'bool',   label: 'プレイヤーが隠れる角度は使わない', default: true },
  replace: { type: 'bool',   label: 'この範囲にある他のカメラは消す', default: false },
  seed:    { type: 'number', label: '組み合わせ(変えると別の結果)', min: 1, max: 99, step: 1, default: 1 },
  ${SCRIPT_P.shake}
});

const me = api.player();
const V = api.math.vec, M = api.math;
const tps = api.tps;
const start = api.start;
const end = Math.min(api.totalTicks - 1, start + Math.round(p.length * tps));
if (end - start < tps) api.fail('残りの長さが短すぎます。もっと前に置いてください');
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
    keys.push({ time: len * i / n, pos: a.follow ? a.eye(head, p0.yaw) : fixedEye, lookAt: head, tick: tick, head: head });
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

// 今あるカメラと時間が重なる時は、そろって1つ上の層(手前)に並べる
let layer = 0;
for (const c of api.cameras()) {
  const inRange = c.start >= start && c.end <= end;
  if (p.replace && inRange) { api.removeCamera(c.id); continue; }
  if (c.start < end && c.end > start) layer = Math.max(layer, c.layer + 1);
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
  const len = (cut - t) / tps;
  api.addCamera({
    start: t, end: cut, name: 'カット' + count + ' ' + ANGLES[chosen].label, layer: layer,
    keys: api.fx.finish(keys.map(function (k) { return { time: k.time, pos: k.pos, lookAt: k.lookAt }; }), { seconds: len, shake: p.shake }),
  });
  last = chosen;
  t = cut;
  api.progress((t - start) / (end - start));
}
api.log(count + 'カットに分けました(切り替えの候補になった動き: ' + events.length + 'か所)');
if (hidden) api.log('注意: ' + hidden + 'カットは、どの角度でもプレイヤーが隠れてしまいました');
api.toast('🎞 ' + count + 'カットに自動で分けました');
`,
  },
];

const SCRIPT_TEMPLATE = `// 新しいカメラのスクリプト
// 素材一覧でクリック(またはタイムラインへドラッグ)すると、ここに書いたカメラが作られます。
// 右の「APIの説明」に、使える機能がまとまっています。

api.info({
  name: '新しいカメラ',
  description: 'プレイヤーを斜め上から見るカメラ。',
});

// 設定項目(素材の ⚙ や、カメラの右パネルにスライダーなどとして出ます)
const p = api.params({
  seconds: { type: 'number', label: '長さ', min: 1, max: 20, step: 0.5, default: 4, unit: '秒' },
  height:  { type: 'number', label: '高さ', min: 0, max: 20, step: 0.5, default: 4, unit: 'ブロック' },
});

const me = api.player();              // 右下で選んでいるプレイヤー
const f0 = me.at(api.start);          // 置いた時刻のプレイヤー
const V = api.math.vec;

// プレイヤーの右後ろ・少し上から、ずっとプレイヤーを見る(0.5秒ごとにポイント)
const keys = [];
for (let t = 0; t <= p.seconds; t += 0.5) {
  const f = me.at(api.start + api.toTick(t));
  keys.push({ time: t, pos: V.add(f0.head, [4, p.height, -4]), lookAt: f.head });
}
api.addCamera({ start: api.start, seconds: p.seconds, name: '新しいカメラ', keys: keys });
`;


// ------------------------------------------------------------
// 素材(スクリプト)の一覧
// ------------------------------------------------------------

const LS_SCRIPT_PARAMS = 'bloxdEditor.scriptParams.v1';
let scriptParamState = (typeof _lsGet === 'function') ? _lsGet(LS_SCRIPT_PARAMS, {}) : {};

// key: 'camera:<id>'(公式)/ 'custom:<id>'(カスタム)/ 'gen:<カメラID>'(置いたカメラが覚えているコード)
function scriptEntry(key) {
  const [a, b] = String(key).split(':');
  if (a === 'camera') {
    const s = OFFICIAL_CAMERA_SCRIPTS.find(x => x.id === b);
    return s ? { key, official: true, id: s.id, name: s.label, icon: s.icon, desc: s.desc, code: s.code, params: {} } : null;
  }
  if (a === 'custom') {
    const c = customAssets.find(x => x.id === b && x.type === 'script');
    return c ? { key, official: false, id: c.id, name: c.name, icon: c.icon || '🎬', desc: c.desc || '', code: c.code || '', params: c.params || {} } : null;
  }
  if (a === 'gen') {
    const cam = scGetCamera(+b);
    return cam && cam.gen ? { key, official: true, readonlyGen: true, id: b, name: cam.gen.name || 'スクリプト', icon: '🎬', desc: '', code: cam.gen.code, params: cam.gen.params } : null;
  }
  return null;
}

function isCameraScriptKey(key) {
  const [a, b] = String(key).split(':');
  if (a === 'camera') return OFFICIAL_CAMERA_SCRIPTS.some(x => x.id === b);
  if (a === 'custom') return customAssets.some(x => x.id === b && x.type === 'script');
  return false;
}

// 素材の今の設定値(保存された上書き分。書いていない所はスクリプトの default が使われる)
function scriptParamValues(key) {
  const e = scriptEntry(key);
  return { ...((e && e.params) || {}), ...(scriptParamState[key] || {}) };
}
function setScriptParamValue(key, k, v) {
  scriptParamState[key] = { ...(scriptParamState[key] || {}), [k]: v };
  _lsSet(LS_SCRIPT_PARAMS, scriptParamState);
}
function resetScriptParams(key) {
  delete scriptParamState[key];
  _lsSet(LS_SCRIPT_PARAMS, scriptParamState);
}

// 前のバージョンのカスタム素材(設定の保存・カメラの動きの保存・スクリプト)を、
// 全部「カメラのスクリプト」にそろえる
function migrateCustomCameraAssets() {
  let changed = false;
  for (const c of customAssets) {
    if (c.type === 'script' && c.cat !== 'camera') { c.cat = 'camera'; changed = true; }
    else if (c.cat === 'camera' && c.type === 'preset') {
      const base = OFFICIAL_CAMERA_SCRIPTS.find(x => x.id === c.base);
      c.type = 'script'; c.code = base ? base.code : SCRIPT_TEMPLATE; c.icon = c.icon || (base && base.icon) || '🎬';
      delete c.base; changed = true;
    } else if (c.cat === 'camera' && c.type === 'camMove') {
      c.code = cameraMoveScript(c.name, c.keys, c.seconds, c.fov, c.relative);
      c.type = 'script'; delete c.keys; delete c.relative; delete c.seconds; delete c.fov;
      changed = true;
    }
  }
  if (changed) _saveCustomAssets();
}

// カメラの動き(キー)を、そのまま再現するスクリプトにする。
// relative=true: キーはプレイヤーから見た位置・向き(置いた時のプレイヤーに合わせて回す)
function cameraMoveScript(name, keys, seconds, fov, relative) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const r = (v) => Math.round(v * 1000) / 1000;
  const lines = keys.map(k => {
    const o = { time: r(k.time), pos: k.pos.map(r), yaw: r(k.yaw * 180 / Math.PI), pitch: r(k.pitch * 180 / Math.PI) };
    if (k.curve) o.curve = k.curve.map(r);
    return '  ' + JSON.stringify(o) + ',';
  }).join('\n');
  return `api.info({
  name: '${esc(name)}',
  description: '保存したカメラの動きです(${relative ? 'プレイヤー基準。どこに置いても、その時のプレイヤーから見て同じ動きになります' : '決まった場所'})。',
});
const p = api.params({
  seconds: { type: 'number', label: '長さ', min: 0.5, max: 60, step: 0.5, default: ${r(seconds)}, unit: '秒' },
  ${SCRIPT_P.avoid('false')}
  ${SCRIPT_P.shake}
});

// 保存した時のキー(位置は${relative ? 'プレイヤーの目から見た' : 'ワールドの'}座標、向きは度)
const KEYS = [
${lines}
];
const SAVED_SECONDS = ${r(seconds)};

const me = api.player(), M = api.math;
const f = me.at(api.start);
const speed = SAVED_SECONDS / p.seconds; // 長さを変えると、同じ動きを速く/ゆっくり
const keys = KEYS.map(function (k) {
${relative ? `  // プレイヤーの向きに合わせて回してから、プレイヤーの目の位置へ動かす
  const a = f.yaw * M.DEG, c = Math.cos(a), s = Math.sin(a);
  const w = [k.pos[0] * c + k.pos[2] * s, k.pos[1], k.pos[2] * c - k.pos[0] * s];
  return { time: k.time / speed, pos: M.vec.add(f.head, w), yaw: k.yaw + f.yaw, pitch: k.pitch, curve: k.curve };` :
`  return { time: k.time / speed, pos: k.pos, yaw: k.yaw, pitch: k.pitch, curve: k.curve };`}
});
api.addCamera({
  start: api.start, seconds: p.seconds, fov: ${r(fov)}, name: '${esc(name)}',
  keys: api.fx.finish(keys, { seconds: p.seconds, avoid: p.avoid, shake: p.shake }),
});
`;
}


// ------------------------------------------------------------
// 置く(スクリプトを動かしてカメラを作る)
// ------------------------------------------------------------

let _addingScript = 0;

async function addCameraScriptAt(key, tick, opts) {
  opts = opts || {};
  const entry = scriptEntry(key);
  if (!entry) return null;
  if (typeof pilot !== 'undefined' && pilot) exitPilot(false);
  const params = opts.params || scriptParamValues(key);
  const view = currentScriptView();
  const focusId = currentFocusId();
  _addingScript++;
  const slow = setTimeout(() => showToast(`⏳ 「${entry.name}」を準備しています…`), 450);
  const r = await runScriptSandboxed(entry.code, 'run', params, null, { start: tick, view, focusId });
  clearTimeout(slow);
  _addingScript--;
  if (r.type !== 'done') { _reportScriptProblem(entry, r); return null; }
  const a = applyScriptOps(r.ops, { gen: { src: key, name: entry.name, code: entry.code, params, anchor: tick, view, focusId }, selectFirst: true });
  if (a.error) { showToast('⚠ ' + entry.name + ': ' + a.error); return null; }
  if (r.logs.length) console.info(`[${entry.name}]`, r.logs.join('\n'));
  if (a.created.length) {
    showToast(a.toasts && a.toasts.length ? a.toasts[a.toasts.length - 1]
      : (a.created.length > 1 ? `🎬 「${entry.name}」でカメラを${a.created.length}台置きました` : `📷 「${entry.name}」のカメラを置きました`));
  } else {
    showToast(a.toasts && a.toasts.length ? a.toasts[a.toasts.length - 1] : `「${entry.name}」はカメラを作りませんでした`);
  }
  return a;
}

function _reportScriptProblem(entry, r) {
  if (r.type === 'fail') { showToast('⚠ ' + r.message); return; }
  const where = r.line ? `(${r.line}行目)` : '';
  showToast(`⚠ 「${entry.name}」のエラー${where}: ${r.message}`);
  console.warn(`[${entry.name}] ${r.type}${where}: ${r.message}`);
}


// ------------------------------------------------------------
// 素材一覧(🎥 カメラ)
// ------------------------------------------------------------

// 公式スクリプトの設定項目を先に読んでおく(カードに秒数を出すため)
function warmCameraScriptDescribe() {
  let pending = 0;
  for (const s of OFFICIAL_CAMERA_SCRIPTS) {
    if (describeScriptCached(s.code)) continue;
    pending++;
    describeScript(s.code).then(() => { if (--pending === 0 && activeAssetCategoryId === 'camera') renderAssetList(); });
  }
}

function _secondsLabel(key, entry) {
  const d = describeScriptCached(entry.code);
  const v = scriptParamValues(key);
  const def = d && d.defs && (d.defs.seconds || d.defs.length);
  if (!def) return '';
  const k = d.defs.seconds ? 'seconds' : 'length';
  const val = v[k] !== undefined ? v[k] : def.default;
  return ` · ${val}秒`;
}

function renderCameraAssets(list, source) {
  if (source === 'official') {
    const grid = _div('assetGrid');
    for (const s of OFFICIAL_CAMERA_SCRIPTS) {
      const key = 'camera:' + s.id;
      const entry = scriptEntry(key);
      grid.appendChild(_cameraScriptCard(key, entry, false));
    }
    list.appendChild(grid);
    list.appendChild(_div('assetHint', 'クリックで再生ヘッドの位置に、タイムラインへドラッグすると落とした時刻に置かれます。⚙ で秒数・距離・壁よけ・手ぶれなど。置いた後も、カメラをダブルクリックすると設定を変えて作り直せます。どの素材も小さなスクリプトなので、</> で中身を見てコピーして自分用に直せます。'));
    return;
  }
  if (source === 'custom') {
    const top = _div('assetIo');
    const newBtn = document.createElement('button');
    newBtn.type = 'button'; newBtn.className = 'btn btn-primary btn-sm'; newBtn.innerText = '＋ 新しく書く';
    newBtn.addEventListener('click', () => createCustomScript(SCRIPT_TEMPLATE, '新しいカメラ', true));
    const impBtn = document.createElement('button');
    impBtn.type = 'button'; impBtn.className = 'btn btn-ghost btn-sm'; impBtn.innerText = '⬆ 読み込む';
    impBtn.title = '.js ファイル(カメラのスクリプト)を読み込む';
    const file = document.createElement('input');
    file.type = 'file'; file.accept = '.js,text/javascript,application/javascript'; file.multiple = true; file.style.display = 'none';
    file.addEventListener('change', async () => {
      const files = Array.from(file.files || []);
      file.value = '';
      for (const f of files) {
        if (f.size > 512 * 1024) { showToast(`${f.name} は大きすぎます(512KBまで)`); continue; }
        await importScriptFile(await f.text(), f.name);
      }
    });
    impBtn.addEventListener('click', () => file.click());
    top.appendChild(newBtn); top.appendChild(impBtn); top.appendChild(file);
    list.appendChild(top);

    const mine = customAssets.filter(c => c.type === 'script');
    if (!mine.length) {
      const empty = _div('assetSoon');
      empty.innerHTML = '<b>まだカスタムのカメラはありません</b>';
      const p = document.createElement('p');
      p.innerText = '作り方: 「＋ 新しく書く」/ 公式の素材の </> から「コピーして編集」/ ⚙ で設定を変えて「⭐ 保存」/ カメラの右パネルの「このカメラをカスタムに保存」/ 人からもらった .js を「⬆ 読み込む」。';
      empty.appendChild(p);
      list.appendChild(empty);
    } else {
      const grid = _div('assetGrid');
      for (const c of mine) grid.appendChild(_cameraScriptCard('custom:' + c.id, scriptEntry('custom:' + c.id), true));
      list.appendChild(grid);
      if (mine.length > 1) {
        const all = document.createElement('button');
        all.type = 'button'; all.className = 'assetLinkBtn'; all.innerText = 'すべてまとめて書き出す(.js)';
        all.addEventListener('click', () => mine.forEach((c, i) => setTimeout(() => downloadScript(scriptEntry('custom:' + c.id)), i * 250)));
        list.appendChild(all);
      }
    }
    list.appendChild(_div('assetHint', 'カスタムのカメラは .js ファイル(スクリプト)です。⬇ で書き出したファイルを渡せば、他の人も「⬆ 読み込む」で使えます。スクリプトはこのページから切り離された安全な場所で動くので、人からもらった物でもあなたのデータには触れません。'));
    return;
  }
  const box = _div('assetSoon');
  box.innerHTML = '<b>近日公開</b>';
  const p = document.createElement('p');
  p.innerText = 'コミュニティサイトで公開されたカメラ(スクリプト)を、ここから探して使えるようにする予定です。それまでは「カスタム」の「⬆ 読み込む」で、他の人の .js を使えます。';
  box.appendChild(p);
  list.appendChild(box);
}

function _cameraScriptCard(key, entry, isCustom) {
  const card = _makeCard(key, 'camera', entry.icon, entry.name, (entry.desc || '') + _secondsLabel(key, entry), null);
  if (isCustom) card.classList.add('custom');
  const btn = _cardButton(card, '⚙', '秒数などの設定', () => {
    openAssetSettingsKey = openAssetSettingsKey === key ? null : key;
    renderAssetList();
  });
  _cardButton(card, '</>', isCustom ? 'コードを編集' : 'コードを見る', () => openScriptEditor(key));
  if (isCustom) {
    _cardButton(card, '⬇', '.js で書き出す', () => downloadScript(entry));
    _cardButton(card, '✕', '削除', () => {
      if (!confirm(`「${entry.name}」を削除しますか?(置いたカメラはそのまま残ります)`)) return;
      deleteCustomAsset(entry.id);
      showToast(`「${entry.name}」を削除しました`);
    });
  }
  if (openAssetSettingsKey === key) {
    btn.classList.add('active');
    card.classList.add('open');
    card.draggable = false; // スライダーを動かせるように
    card.appendChild(_buildScriptSettings(key, entry));
  }
  return card;
}

// ⚙ の中身: スクリプトの設定項目+「追加」「カスタムに保存」「初期値に戻す」
function _buildScriptSettings(key, entry) {
  const box = _div('assetSettings');
  box.addEventListener('mousedown', (e) => e.stopPropagation());
  box.addEventListener('click', (e) => e.stopPropagation());
  const paramsBox = _div('scriptParams');
  box.appendChild(paramsBox);
  const fill = (d) => {
    paramsBox.innerHTML = '';
    if (!d.ok) { paramsBox.appendChild(_scriptMessage('error', 'スクリプトにエラーがあります' + (d.line ? `(${d.line}行目)` : '') + ': ' + d.message)); return; }
    const v = scriptParamValues(key);
    const keys = Object.keys(d.defs);
    if (!keys.length) paramsBox.appendChild(_div('panelHint', '設定項目はありません'));
    for (const k of keys) {
      paramsBox.appendChild(buildParamControl(k, d.defs[k], v[k] !== undefined ? v[k] : d.defs[k].default, {
        change: (val) => setScriptParamValue(key, k, val),
        commit: () => {
          const desc = box.parentElement && box.parentElement.querySelector('.assetDesc');
          if (desc) desc.innerText = (entry.desc || '') + _secondsLabel(key, entry);
        },
      }));
    }
  };
  const cached = describeScriptCached(entry.code);
  if (cached) fill(cached);
  else {
    paramsBox.appendChild(_div('panelHint', '設定を読み込み中…'));
    describeScript(entry.code).then(fill);
  }

  const actions = _div('assetSettingsActions');
  const addBtn = document.createElement('button');
  addBtn.type = 'button'; addBtn.className = 'btn btn-primary btn-sm'; addBtn.innerText = '＋ この設定で置く';
  addBtn.addEventListener('click', () => addAssetAt(key, curTick));
  actions.appendChild(addBtn);

  const saveRow = _div('assetSaveRow');
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'panelInput'; nameInput.placeholder = '名前(例: 8秒でゆっくり1周)';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button'; saveBtn.className = 'btn btn-ghost btn-sm'; saveBtn.innerText = '⭐ 保存';
  saveBtn.title = 'この設定をカスタムのカメラとして保存';
  const doSave = () => {
    const name = nameInput.value.trim() || `${entry.name}(${_secondsLabel(key, entry).replace(' · ', '') || '設定'})`;
    const c = createCustomScript(entry.code, name, false, { params: scriptParamValues(key), desc: entry.desc, icon: entry.icon });
    showToast(`⭐ 「${c.name}」をカスタムに保存しました`);
  };
  saveBtn.addEventListener('click', doSave);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
  saveRow.appendChild(nameInput); saveRow.appendChild(saveBtn);
  actions.appendChild(saveRow);

  const reset = document.createElement('button');
  reset.type = 'button'; reset.className = 'assetLinkBtn'; reset.innerText = '初期値に戻す';
  reset.addEventListener('click', () => { resetScriptParams(key); renderAssetList(); });
  actions.appendChild(reset);
  box.appendChild(actions);
  return box;
}

// 設定項目1つぶんの入力欄。handlers: { change(val), commit(), begin() }
function buildParamControl(k, def, v, handlers) {
  def = def && typeof def === 'object' ? def : {};
  handlers = handlers || {};
  const label = String(def.label || k);
  const type = def.type || (typeof def.default === 'boolean' ? 'bool' : typeof def.default === 'string' ? 'text' : 'number');
  const begin = () => { if (handlers.begin) handlers.begin(); };
  const commit = () => { if (handlers.commit) handlers.commit(); };
  if (type === 'bool') {
    const row = _el('label', 'scriptCheck');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!v; cb.dataset.param = k;
    cb.addEventListener('change', () => { begin(); handlers.change(cb.checked); commit(); });
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
        if (b.classList.contains('active')) return;
        group.querySelectorAll('.settingsRadioPill').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        begin(); handlers.change(val); commit();
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
    inp.type = 'text'; inp.className = 'panelInput'; inp.value = v == null ? '' : String(v); inp.dataset.param = k;
    inp.addEventListener('focus', begin);
    inp.addEventListener('change', () => { handlers.change(inp.value); commit(); });
    row.appendChild(inp);
    return row;
  }
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
  r.addEventListener('pointerdown', begin);
  r.addEventListener('keydown', begin);
  r.addEventListener('input', () => { const n = parseFloat(r.value); val.innerText = `${n}${unit}`; handlers.change(n); });
  r.addEventListener('change', commit);
  row.appendChild(r);
  return row;
}

function _scriptMessage(kind, text) { return _el('div', 'scriptMsg ' + kind, text); }

function createCustomScript(code, name, openEditor, extra) {
  extra = extra || {};
  const entry = { id: _newCustomId(), cat: 'camera', type: 'script', name: name || '新しいカメラ', icon: extra.icon || '🎬',
                  desc: extra.desc || '', code, params: extra.params || {} };
  customAssets.push(entry);
  _saveCustomAssets();
  activeAssetCategoryId = 'camera'; activeAssetSource = 'custom'; assetListCollapsed = false;
  openAssetSettingsKey = null;
  renderAssetRail(); renderAssetList();
  if (openEditor) openScriptEditor('custom:' + entry.id);
  return entry;
}

async function importScriptFile(code, fileName) {
  const base = String(fileName || 'カメラ').replace(/\.js$/i, '');
  const entry = createCustomScript(code, base, false);
  // 名前・説明をスクリプト自身の api.info から取る(隔離した場所で、設定の所まで動かすだけ)
  const d = await describeScript(code);
  if (d.info) {
    if (d.info.name) entry.name = d.info.name.slice(0, 40);
    if (d.info.description) entry.desc = d.info.description.slice(0, 80);
    _saveCustomAssets();
  }
  renderAssetList();
  showToast(d.ok ? `🎬 「${entry.name}」を読み込みました(クリックで置けます)` : `「${entry.name}」を読み込みましたが、エラーがあります: ${d.message}`);
  return entry;
}

function _updateCustomScript(id, patch) {
  const c = customAssets.find(x => x.id === id);
  if (!c) return null;
  Object.assign(c, patch);
  _saveCustomAssets();
  return c;
}

function downloadScript(entry) {
  if (!entry) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([entry.code], { type: 'text/javascript' }));
  a.download = (entry.name || 'camera').replace(/[\\/:*?"<>|]/g, '_') + '.js';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// 右パネルから: 選んでいるカメラを、カスタムのカメラ(スクリプト)として保存
function saveCameraAsCustomAsset(cam) {
  if (!cam) return;
  const name = scCamName(cam).replace(/\s+\d+$/, '') || 'カメラ';
  // スクリプトで作ったまま(手で直していない)なら、そのスクリプトと設定を保存する
  if (cam.gen && !scGenEdited(cam) && sceneCameras.filter(c => c.gen && c.gen.group === cam.gen.group).length === 1) {
    createCustomScript(cam.gen.code, name, false, { params: cam.gen.params, desc: '' });
    showToast(`⭐ 「${name}」をカスタムに保存しました(スクリプトと設定)`);
    return;
  }
  // それ以外は、今のキーをそのまま再現するスクリプトを作る(プレイヤー基準)
  const seconds = +((cam.endTick - cam.startTick) / scTps()).toFixed(2);
  const p = _playerAt(cam.startTick);
  const keys = cam.keys.map(k => {
    if (p) return { ..._toPlayerFrame(k, p) };
    return { ..._cloneKey(k), pos: [k.pos[0] + worldOriginX, k.pos[1] + worldOriginY, k.pos[2] + worldOriginZ] };
  });
  const code = cameraMoveScript(name, keys, seconds, cam.fov, !!p);
  createCustomScript(code, name, false, { desc: `${seconds}秒 · ${scCamIsStatic(cam) ? '固定' : `動く(${cam.keys.length}点)`}${p ? ' · プレイヤー基準' : ''}` });
  showToast(`⭐ 「${name}」をカスタムに保存しました`);
}


// ------------------------------------------------------------
// 右パネル(カメラ): スクリプトで作ったカメラの設定 → その場で作り直す
// ------------------------------------------------------------

const _regen = { running: false, next: null, commitWhenIdle: false, lastMessage: null };

function renderCameraGenSection(body, cam) {
  const gen = cam.gen;
  const members = sceneCameras.filter(c => c.gen && c.gen.group === gen.group);
  body.appendChild(_el('div', 'panelSectionLabel', `🎬 スクリプト「${gen.name || 'スクリプト'}」の設定` + (members.length > 1 ? `(${members.length}台まとめて)` : '')));
  const box = _el('div', 'scriptParams genParams');
  body.appendChild(box);
  const d = describeScriptCached(gen.code);
  if (!d) {
    box.appendChild(_el('div', 'panelHint', '設定を読み込み中…'));
    describeScript(gen.code).then(() => {
      if (editPanelOpenFor && editPanelOpenFor.kind === 'camera' && editPanelOpenFor.id === cam.id) openEditPanel(scGetCamera(cam.id) || cam);
    });
  } else if (!d.ok) {
    box.appendChild(_scriptMessage('error', 'スクリプトにエラーがあります: ' + d.message));
  } else {
    const params = gen.params || {};
    const keys = Object.keys(d.defs);
    if (!keys.length) box.appendChild(_el('div', 'panelHint', '設定項目はありません'));
    for (const k of keys) {
      box.appendChild(buildParamControl(k, d.defs[k], params[k] !== undefined ? params[k] : d.defs[k].default, {
        begin: () => { if (!_regen.gesture) { _regen.gesture = true; beginEdit(); } },
        change: (val) => {
          const g = scGetCamera(cam.id);
          if (!g || !g.gen) return;
          queueRegenerate(g.gen.group, { ...(g.gen.params || {}), [k]: val });
        },
        commit: () => endRegenerateGesture(),
      }));
    }
  }
  if (_regen.lastMessage && _regen.lastMessage.group === gen.group) box.appendChild(_scriptMessage(_regen.lastMessage.kind, _regen.lastMessage.text));

  const actions = _el('div', 'genActions');
  const mk = (text, title, fn) => { const b = _el('button', 'btn btn-ghost btn-sm', text); b.title = title; b.addEventListener('click', fn); actions.appendChild(b); return b; };
  mk('↻ 作り直す', '今の設定で、もう一度スクリプトを動かす', () => { beginEdit(); queueRegenerate(gen.group, gen.params || {}, true); endRegenerateGesture(); });
  mk('</> コード', 'このカメラを作ったスクリプトを見る', () => openScriptEditor('gen:' + cam.id));
  mk('✂ 切り離す', 'スクリプトとのつながりを切って、ふつうのカメラにする', () => {
    pushUndo();
    for (const c of sceneCameras) if (c.gen && c.gen.group === gen.group) delete c.gen;
    showToast('スクリプトから切り離しました(ふつうのカメラになりました)');
    editorChanged();
  });
  body.appendChild(actions);
  body.appendChild(_el('div', 'panelHint', scGenEdited(cam)
    ? '⚠ ポイントを手で直しています。設定を変えたり作り直したりすると、手で直した所は元に戻ります。'
    : '設定を変えると、その場でカメラが作り直されます。'));
}

// 設定の変更 → 作り直し(動いている間に来た変更は、最後の1つだけ後で反映する)
function queueRegenerate(group, params, force) {
  const first = sceneCameras.find(c => c.gen && c.gen.group === group);
  if (!first) return;
  if (!force && !_regen.confirmed && sceneCameras.some(c => c.gen && c.gen.group === group && scGenEdited(c))) {
    if (!confirm('このカメラはポイントを手で直しています。作り直すと、手で直した所は元に戻ります。続けますか?')) {
      _regen.next = null;
      openEditPanel(first);
      return;
    }
  }
  _regen.confirmed = true; // 1回の操作(スライダーのドラッグ)の間は聞き直さない
  _regen.next = { group, params };
  if (!_regen.running) _drainRegenerate();
}

function endRegenerateGesture() {
  _regen.gesture = false;
  _regen.confirmed = false;
  if (_regen.running || _regen.next) _regen.commitWhenIdle = true;
  else commitEdit();
}

async function _drainRegenerate() {
  _regen.running = true;
  while (_regen.next) {
    const job = _regen.next;
    _regen.next = null;
    await _regenerateGroup(job.group, job.params);
  }
  _regen.running = false;
  if (_regen.commitWhenIdle) { _regen.commitWhenIdle = false; commitEdit(); }
}

async function _regenerateGroup(group, params) {
  const members = sceneCameras.filter(c => c.gen && c.gen.group === group).sort((a, b) => a.startTick - b.startTick);
  if (!members.length) return;
  const gen = members[0].gen;
  const r = await runScriptSandboxed(gen.code, 'run', params, null,
    { start: gen.anchor, view: gen.view || undefined, focusId: gen.focusId != null ? gen.focusId : undefined, excludeGroup: group });
  if (r.type !== 'done') {
    _regen.lastMessage = { group, kind: r.type === 'fail' ? 'warn' : 'error', text: (r.type === 'fail' ? '' : 'エラー' + (r.line ? `(${r.line}行目)` : '') + ': ') + r.message };
    editorChanged();
    return;
  }
  const a = applyScriptOps(r.ops, { history: false, replaceGroup: group,
    gen: { src: gen.src, name: gen.name, code: gen.code, params, anchor: gen.anchor, view: gen.view, focusId: gen.focusId, group } });
  _regen.lastMessage = a.error ? { group, kind: 'error', text: a.error } : null;
  if (a.error) editorChanged();
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
        <span class="seIcon">🎬</span>
        <input id="scriptEditorName" class="panelInput" type="text" maxlength="40" placeholder="カメラの名前">
        <span id="scriptEditorBadge"></span>
        <div class="tbSpacer"></div>
        <button id="scriptEditorCopy" class="btn btn-primary btn-sm" type="button">⧉ コピーして編集</button>
        <button id="scriptEditorSave" class="btn btn-ghost btn-sm" type="button" title="Ctrl+S">💾 保存</button>
        <button id="scriptEditorRun" class="btn btn-primary btn-sm" type="button" title="Ctrl+Enter">▶ 保存して置いてみる</button>
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
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
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
    const c = createCustomScript(entry.code, entry.name + '(コピー)', false, { params: entry.params, desc: entry.desc, icon: entry.icon });
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
  document.getElementById('scriptEditorBadge').innerText = entry.readonlyGen ? '置いたカメラのスクリプト(読み取り専用)' : (entry.official ? '公式(読み取り専用)' : '');
  const status = document.getElementById('scriptEditorStatus');
  status.innerText = entry.official
    ? 'このスクリプトは書きかえられません。「⧉ コピーして編集」で自分用のコピー(カスタム)を作れます。'
    : 'Ctrl+S: 保存 / Ctrl+Enter: 保存して再生ヘッドの位置に置いてみる / Esc: 閉じる';
  status.className = '';
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
  if (!st || st.official) return;
  const status = document.getElementById('scriptEditorStatus');
  const [, id] = st.key.split(':');
  const code = document.getElementById('scriptEditorCode').value;
  const name = document.getElementById('scriptEditorName').value.trim() || '名前のないカメラ';
  _updateCustomScript(id, { code, name });
  st.dirty = false;
  const d = await describeScript(code);
  if (d.info && d.info.description) _updateCustomScript(id, { desc: d.info.description.slice(0, 80) });
  renderAssetList();
  if (!d.ok) {
    status.className = 'error';
    status.innerText = '保存しました。ただしエラーがあります' + (d.line ? `(${d.line}行目)` : '') + ': ' + d.message;
    if (d.line) _scriptEditorGotoLine(d.line);
    return;
  }
  status.className = 'ok';
  status.innerText = '✓ 保存しました';
  if (andRun) {
    const r = await addCameraScriptAt(st.key, curTick);
    if (r && r.created && r.created.length) {
      closeScriptEditor(true);
      openEditPanel(r.created[0]);
    } else {
      status.className = 'error';
      status.innerText = '置けませんでした(画面上の通知を見てください)';
    }
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

// 起動時: 前のバージョンのカスタム素材をそろえ、公式スクリプトの設定を先読みする
function cameraScriptsInit() {
  migrateCustomCameraAssets();
  warmCameraScriptDescribe();
}


// ------------------------------------------------------------
// エディタの横に出す、APIの説明(短い版。詳しくは SCRIPT_API.md)
// ------------------------------------------------------------

const SCRIPT_API_DOCS_HTML = `
<h3>カメラ = スクリプト</h3>
<p>素材一覧のカメラは、どれも小さなスクリプトです。置くとスクリプトが動いて、<b>カメラとキーが作られます</b>。作ったカメラは設定を覚えていて、右パネルで設定を変えるとその場で作り直されます。</p>
<p>座標は Bloxd のワールド座標(画面左上と同じ)、角度は<b>度</b>、<code>tick</code> はリプレイのコマ番号(<code>api.tps</code> コマ = 1秒)、キーの <code>time</code> はカメラの先頭からの<b>秒</b>です。</p>

<h4>情報・設定</h4>
<table>
<tr><td><code>api.info({ name, description })</code></td><td>名前と説明</td></tr>
<tr><td><code>api.params({ key: {…} })</code></td><td>設定項目を出し、今の値を返す。<br>type: <code>'number'</code>(min, max, step, unit)/ <code>'bool'</code> / <code>'choice'</code>(options: [[表示, 値], …])/ <code>'text'</code>。どれも default を書く</td></tr>
<tr><td><code>api.start</code></td><td><b>カメラを置く時刻</b>(tick)。作り直す時も同じ</td></tr>
<tr><td><code>api.tps</code> / <code>api.totalTicks</code></td><td>1秒のコマ数 / 全体のコマ数</td></tr>
<tr><td><code>api.toTick(秒)</code> / <code>api.toSec(tick)</code></td><td>秒 ⇄ tick</td></tr>
<tr><td><code>api.view</code></td><td>置いた時の編集視点 { pos, yaw, pitch, fov }</td></tr>
</table>

<h4>プレイヤー</h4>
<table>
<tr><td><code>api.player(id?)</code></td><td>プレイヤー(省略すると右下で選んでいる人)</td></tr>
<tr><td><code>player.at(tick)</code></td><td>{ pos(足元), head(目), yaw, pitch, pose, held, jumping, crouching }</td></tr>
<tr><td><code>api.players()</code></td><td>全員の { id, name, isMe }</td></tr>
</table>

<h4>地形</h4>
<table>
<tr><td><code>api.world.raycast(from, to, { tick, ignoreStart })</code></td><td>線分で最初にぶつかるブロック。{ pos, block, normal, dist } か null。ignoreStart: true で出発点のブロックは見ない</td></tr>
<tr><td><code>api.world.isSolid(x, y, z, tick?)</code></td><td>そこにブロックがあるか</td></tr>
<tr><td><code>api.world.groundY(x, z, fromY?, tick?)</code></td><td>その列の地面の高さ</td></tr>
</table>

<h4>カメラを作る</h4>
<table>
<tr><td><code>api.addCamera({ start, end | seconds, name, fov, layer, display, keys })</code></td><td>カメラを作る(何台でも)</td></tr>
<tr><td><code>api.cameras()</code> / <code>api.camera(id)</code></td><td>今あるカメラを読む。<code>cam.poseAt(tick)</code> で補間した姿勢</td></tr>
<tr><td><code>api.updateCamera(id, {…})</code> / <code>api.removeCamera(id)</code></td><td>他のカメラを直す / 消す</td></tr>
<tr><td><code>api.addText({ start, seconds, content, … })</code></td><td>テキストも置ける</td></tr>
</table>
<p>キーは <code>{ time, pos, yaw, pitch }</code>。yaw・pitch の代わりに <code>lookAt: [x, y, z]</code> でその点を向きます。<code>curve</code>: 'smooth' / 'easeIn' / 'easeOut' / 'linear' か [x1, y1, x2, y2]。</p>

<h4>仕上げの道具(api.fx)</h4>
<table>
<tr><td><code>api.fx.finish(keys, { seconds, avoid, shake })</code></td><td>壁よけ・手ぶれをまとめて</td></tr>
<tr><td><code>api.fx.avoidWalls(keys, { seconds, margin, minDist, target })</code></td><td>プレイヤーが壁に隠れる所だけカメラを寄せる</td></tr>
<tr><td><code>api.fx.handheld(keys, { seconds, amount, turn, speed, seed })</code></td><td>手持ちカメラの揺れ</td></tr>
</table>

<h4>べんりな道具</h4>
<table>
<tr><td><code>api.math.vec</code></td><td>add, sub, scale, dot, cross, len, dist, norm, lerp</td></tr>
<tr><td><code>api.math.lookAt(from, to)</code></td><td>{ yaw, pitch }</td></tr>
<tr><td><code>api.math.forward(yaw, pitch)</code> / <code>right(yaw)</code></td><td>向き → ベクトル</td></tr>
<tr><td><code>api.math.noise(t, seed)</code> / <code>random(seed)</code></td><td>なめらかな揺れ / 毎回同じ乱数</td></tr>
<tr><td>clamp, lerp, smoothstep, easeInOut, angleDiff, DEG</td><td></td></tr>
<tr><td><code>api.log(…)</code> / <code>api.toast(文)</code> / <code>api.fail(文)</code></td><td>記録 / 通知 / 理由を出して止める</td></tr>
</table>
<p class="note">スクリプトは隔離された場所で動くので、ネットワークやページの中身には触れません。${SCRIPT_TIMEOUT_MS / 1000}秒で打ち切られます。<code>await</code> も使えます。</p>
`;
