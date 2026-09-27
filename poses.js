// poses.js
// ============================================================
// 🕺ポーズ(エンティティの関節ごとのアニメーション)。
//
// タイムラインは「グローバル」(カメラ・テキスト・パーティクル)と「ポーズ」の
// 2つのタブに分かれる。ポーズのタブでは、エンティティ(プレイヤー・人形)を
// 1体選んで、その1体だけのブロックと、関節ごとのキーの行を編集する。
//
// エンティティの作り(関節)は「型」(RIG_TYPES)として登録してある。
//   humanoid(人型): 関節10個 = 体・頭・右腕・右ひじ・左腕・左ひじ・右脚・右ひざ・左脚・左ひざ
//   item(アイテム): 関節0個(全体の位置と向きだけ)
//   動物などを足す時は、RIG_TYPES に型を1つ足して、entityRigType() で使い分ける。
// どの型にも「全体(root)」があり、関節の数には数えない。
//
// 関節ごとに、回転 r=[x,y,z](度)と位置のずれ p=[x,y,z](ブロック。親の向きが基準)を持つ。
//   x = 前へ(腕・脚は前へ振る、頭・体は前へ倒す、ひじ・ひざは曲げる 0〜160)
//   y = ひねり(左を向く方が +) / z = 横へ(腕・脚は外へ開く、頭・体は左へ傾く方が +)
//
// ポーズのブロック:
//   { id, kind:'pose', name, target:'player:<eid>'|'puppet:<id>', startTick, endTick,
//     offsetSec, loopLen(0=くり返さない), tracks:{ 関節: [{ time, r, p, curve? }] } }
//   キーは関節ごとに別々。キーの間はカメラと同じ速さのカーブ(curve)でつなぐ。
//   loopLen>0 の時は 0〜loopLen 秒をくり返す。
//   プレイヤーに付けた時は、ブロックの端0.2秒で元の姿勢(全部0)と混ぜる。
// 人形(puppets): { id, name, type, base:{pos,yaw} }。自分のブロックがある間だけ出る。
// ============================================================

let poseBlocks = [];
let nextPoseBlockId = 1;
let selectedPoseId = null;
let puppets = [];
let nextPuppetId = 1;

let timelineTab = 'global';     // 'global' | 'pose'
let poseEntity = null;          // ポーズのタブで選んでいるエンティティ('player:1' など)
let poseSelJoint = 'root';      // 3Dで動かす関節
let poseSelKey = null;          // 選んでいるキー { joint, index } / { joint:'*', time }(ブロックの行の◆)
let poseSelKeyExplicit = false;
let poseExpandedId = null;      // 関節の行を開いているブロック

const POSE_KEY_SNAP = 0.1;
const POSE_BLEND_SEC = 0.2;
const POSE_DEFAULT_SECONDS = 3;
const POSE_JOINT_ROW_H = 24, POSE_JOINT_ROW_EXPANDED_H = 96;


// ============================================================
// 型(関節の作り)
// ============================================================

// bones: { joint, label, parent, at(親から見た関節の位置), sign(回し方の符号 [x,y,z]), bend(曲げるだけ) }
// parts: 描く箱 { joint, box(関節から見た中心), size }
const RIG_TYPES = {
  humanoid: {
    label: '人型', rootPivot: 0.9, rootSign: [1, 1, -1],
    bones: [
      { joint: 'body',   label: '体',     parent: 'root', at: [0, 0.65, 0],      sign: [1, 1, -1] },
      { joint: 'head',   label: '頭',     parent: 'body', at: [0, 0.65, 0],      sign: [1, 1, -1] },
      { joint: 'armR',   label: '右腕',   parent: 'body', at: [-0.375, 0.65, 0], sign: [-1, -1, -1] },
      { joint: 'elbowR', label: '右ひじ', parent: 'armR', at: [0, -0.3, 0],      sign: [-1, 0, 0], bend: true },
      { joint: 'armL',   label: '左腕',   parent: 'body', at: [0.375, 0.65, 0],  sign: [-1, 1, 1] },
      { joint: 'elbowL', label: '左ひじ', parent: 'armL', at: [0, -0.3, 0],      sign: [-1, 0, 0], bend: true },
      { joint: 'legR',   label: '右脚',   parent: 'root', at: [-0.14, 0.65, 0],  sign: [-1, -1, -1] },
      { joint: 'kneeR',  label: '右ひざ', parent: 'legR', at: [0, -0.325, 0],    sign: [1, 0, 0], bend: true },
      { joint: 'legL',   label: '左脚',   parent: 'root', at: [0.14, 0.65, 0],   sign: [-1, 1, 1] },
      { joint: 'kneeL',  label: '左ひざ', parent: 'legL', at: [0, -0.325, 0],    sign: [1, 0, 0], bend: true },
    ],
    parts: [
      { joint: 'body',   box: [0, 0.35, 0],    size: [0.5, 0.75, 0.28] },
      { joint: 'head',   box: [0, 0.25, 0],    size: [0.5, 0.5, 0.5] },
      { joint: 'armR',   box: [0, -0.1125, 0], size: [0.25, 0.375, 0.25] },
      { joint: 'elbowR', box: [0, -0.1875, 0], size: [0.25, 0.375, 0.25] },
      { joint: 'armL',   box: [0, -0.1125, 0], size: [0.25, 0.375, 0.25] },
      { joint: 'elbowL', box: [0, -0.1875, 0], size: [0.25, 0.375, 0.25] },
      { joint: 'legR',   box: [0, -0.1625, 0], size: [0.25, 0.325, 0.25] },
      { joint: 'kneeR',  box: [0, -0.1625, 0], size: [0.25, 0.325, 0.25] },
      { joint: 'legL',   box: [0, -0.1625, 0], size: [0.25, 0.325, 0.25] },
      { joint: 'kneeL',  box: [0, -0.1625, 0], size: [0.25, 0.325, 0.25] },
    ],
  },
  item: {
    label: 'アイテム', rootPivot: 0.25, rootSign: [1, 1, -1],
    bones: [],
    parts: [{ joint: 'root', box: [0, 0.25, 0], size: [0.5, 0.5, 0.5] }],
  },
};

function rigJoints(type) { return ['root', ...RIG_TYPES[type].bones.map(b => b.joint)]; }
function rigJointCount(type) { return RIG_TYPES[type].bones.length; } // 全体(root)は数えない
function rigBone(type, joint) { return RIG_TYPES[type].bones.find(b => b.joint === joint) || null; }
function rigJointLabel(type, joint) {
  if (joint === 'root') return '全体';
  const b = rigBone(type, joint);
  return b ? b.label : joint;
}
function _rigSign(type, joint) { return joint === 'root' ? RIG_TYPES[type].rootSign : rigBone(type, joint).sign; }
function _rigBend(type, joint) { const b = joint === 'root' ? null : rigBone(type, joint); return !!(b && b.bend); }


// ============================================================
// エンティティ(リプレイのプレイヤー・人形)
// ============================================================

// エンティティの型。今はプレイヤーも人形も人型。
// (アイテム・動物などのエンティティが来たら、ここで見分ける)
function entityRigType(key) {
  if (!key) return 'humanoid';
  if (key.startsWith('puppet:')) { const p = puppetGet(+key.slice(7)); return p ? p.type : 'humanoid'; }
  return 'humanoid';
}

function puppetGet(id) { return puppets.find(p => p.id === id) || null; }

function poseEntityName(key) {
  if (!key) return '';
  if (key.startsWith('puppet:')) { const p = puppetGet(+key.slice(7)); return p ? p.name : '人形'; }
  const eid = key.slice(7);
  const e = allTimelines && allTimelines.entities[eid];
  return e ? (e.name || eid) : eid;
}

function poseEntityList() {
  const out = [];
  if (allTimelines && allTimelines.entities) {
    for (const [eid, info] of Object.entries(allTimelines.entities)) out.push({ key: 'player:' + eid, name: info.name || eid, icon: '🧍' });
  }
  for (const p of puppets) out.push({ key: 'puppet:' + p.id, name: p.name, icon: '🧸' });
  for (const e of out) { e.type = entityRigType(e.key); e.joints = rigJointCount(e.type); }
  return out;
}

// 人形が出ている範囲(自分のブロックの最初〜最後)
function _puppetSpan(id) {
  let s = Infinity, e = -Infinity;
  for (const b of poseBlocks) if (b.target === 'puppet:' + id) { s = Math.min(s, b.startTick); e = Math.max(e, b.endTick); }
  return s < e ? [s, e] : null;
}

function _poseTickVal(frameIndex) {
  if (timeline && timeline.frames && timeline.frames.length) {
    const f = timeline.frames[Math.max(0, Math.min(timeline.frames.length - 1, Math.round(frameIndex)))];
    if (f) return f.tick;
  }
  return frameIndex;
}

// エンティティの足元の位置(ローカル座標)と向き。今見えていなければ null
function poseEntityBase(key, tick) {
  if (!key) return null;
  if (key.startsWith('puppet:')) {
    const p = puppetGet(+key.slice(7));
    const span = p && _puppetSpan(p.id);
    if (!p || !span || tick < span[0] || tick >= span[1]) return null;
    return { pos: p.base.pos, yaw: p.base.yaw };
  }
  const ent = allTimelines && allTimelines.entities[key.slice(7)];
  if (!ent) return null;
  const f = nearestFrameAtOrBefore(ent.frames, _poseTickVal(tick));
  if (!f || !f.position) return null;
  return {
    pos: [f.position[0] - worldOriginX, f.position[1] - worldOriginY, f.position[2] - worldOriginZ],
    yaw: (f.rotation && f.rotation.length > 1) ? f.rotation[1] : 0,
  };
}


// ============================================================
// ポーズ(関節ごとの値)と、キーの計算
// ============================================================

function poseZero(type) {
  const o = {};
  for (const j of rigJoints(type)) o[j] = { r: [0, 0, 0], p: [0, 0, 0] };
  return o;
}
function _jClone(v) { return { r: v.r.slice(), p: v.p.slice() }; }
function _jLerp(a, b, t) {
  return { r: [0, 1, 2].map(i => a.r[i] + (b.r[i] - a.r[i]) * t), p: [0, 1, 2].map(i => a.p[i] + (b.p[i] - a.p[i]) * t) };
}

const _POSE_ZERO_J = { r: [0, 0, 0], p: [0, 0, 0] };

// 関節1つぶんのキーの列から、s秒の値
function _trackEval(track, s) {
  if (!track || !track.length) return _jClone(_POSE_ZERO_J);
  if (track.length === 1 || s <= track[0].time) return _jClone(track[0]);
  const last = track[track.length - 1];
  if (s >= last.time) return _jClone(last);
  let i = 0;
  while (i < track.length - 2 && s > track[i + 1].time) i++;
  const a = track[i], c = track[i + 1];
  const x = Math.max(0, Math.min(1, (s - a.time) / ((c.time - a.time) || 1)));
  return _jLerp(a, c, scEase(a.curve || null, x));
}

function poseGet(id) { return poseBlocks.find(b => b.id === id) || null; }
function poseGetSelected() { return selectedPoseId != null ? poseGet(selectedPoseId) : null; }

// ブロックの中の時刻(秒)。くり返す時は 0〜loopLen に折り返す
function poseLocalSec(b, tick) {
  let s = b.offsetSec + (tick - b.startTick) / scTps();
  if (b.loopLen > 0.01) s = ((s % b.loopLen) + b.loopLen) % b.loopLen;
  return s;
}

function poseBlockPose(b, tick) {
  const type = entityRigType(b.target);
  const s = poseLocalSec(b, tick);
  const out = {};
  for (const j of rigJoints(type)) out[j] = _trackEval(b.tracks[j], s);
  return out;
}

function poseBlockWeight(b, tick) {
  if (!b.target.startsWith('player:')) return 1;
  const tps = scTps();
  return Math.max(0, Math.min(1, ((tick - b.startTick) / tps) / POSE_BLEND_SEC, ((b.endTick - tick) / tps) / POSE_BLEND_SEC));
}

// エンティティの、指定したフレームのブロック(重なっていたら後から置いた方)
function poseBlockAtTick(key, tick) {
  let hit = null;
  for (const b of poseBlocks) if (b.target === key && tick >= b.startTick && tick < b.endTick) hit = b;
  return hit;
}

// エンティティの、指定したフレームのポーズ(混ぜる強さも入れた値)
function poseEntityPose(key, tick) {
  const type = entityRigType(key);
  const b = poseBlockAtTick(key, tick);
  if (!b) return poseZero(type);
  const pose = poseBlockPose(b, tick);
  const w = poseBlockWeight(b, tick);
  if (w >= 1) return pose;
  const z = poseZero(type), out = {};
  for (const j in pose) out[j] = _jLerp(z[j], pose[j], w);
  return out;
}


// ============================================================
// ブロックの作成・分割・複製
// ============================================================

function poseAddBlock(tick, target, props) {
  props = props || {};
  const maxTick = scMaxTick();
  let start = Math.max(0, Math.round(tick));
  if (maxTick > 0) start = Math.min(start, Math.max(0, maxTick - 1));
  let end = start + Math.round((props.seconds || POSE_DEFAULT_SECONDS) * scTps());
  if (maxTick > 0) end = Math.min(end, maxTick);
  const id = nextPoseBlockId++;
  const b = {
    id, kind: 'pose', name: props.name || ('ポーズ' + id), target,
    startTick: start, endTick: Math.max(start + 1, end), offsetSec: 0,
    loopLen: props.loopLen || 0,
    tracks: JSON.parse(JSON.stringify(props.tracks || {})),
  };
  poseBlocks.push(b);
  return b;
}

function poseDeleteBlock(id) { poseBlocks = poseBlocks.filter(b => b.id !== id); if (poseExpandedId === id) poseExpandedId = null; }

function poseSplitBlock(b, tick) {
  if (tick <= b.startTick || tick >= b.endTick) return null;
  const right = JSON.parse(JSON.stringify(b));
  right.id = nextPoseBlockId++;
  right.startTick = tick;
  right.offsetSec = b.offsetSec + (tick - b.startTick) / scTps();
  b.endTick = tick;
  poseBlocks.push(right);
  return right;
}

function poseDuplicateBlock(b) {
  const len = b.endTick - b.startTick;
  const maxTick = scMaxTick();
  let start = b.endTick;
  if (maxTick > 0 && start + len > maxTick) start = Math.max(0, maxTick - len);
  const dup = JSON.parse(JSON.stringify(b));
  dup.id = nextPoseBlockId++;
  dup.startTick = start; dup.endTick = start + len;
  poseBlocks.push(dup);
  return dup;
}

// 関節のキーを、再生ヘッドの時刻に用意する(無ければ今の値で作る)。戻り値: { key, index, created }
function poseEditJointKey(b, joint, tick) {
  const s = poseLocalSec(b, tick);
  if (!b.tracks[joint]) b.tracks[joint] = [];
  const tr = b.tracks[joint];
  let i = tr.findIndex(k => Math.abs(k.time - s) <= POSE_KEY_SNAP);
  if (i >= 0) return { key: tr[i], index: i, created: false, seconds: s };
  const v = _trackEval(tr, s);
  const key = { time: s, r: v.r, p: v.p, curve: CURVE_PRESETS.smooth.c.slice() };
  let prev = null;
  for (const k of tr) if (k.time < s) prev = k;
  if (prev && prev.curve) key.curve = prev.curve.slice();
  tr.push(key);
  tr.sort((a, c) => a.time - c.time);
  return { key, index: tr.indexOf(key), created: true, seconds: s };
}

// 3Dで動かし始めた時: 再生ヘッドにブロックが無ければ作る
function poseEnsureBlockAt(key, tick) {
  let b = poseBlockAtTick(key, tick);
  if (b) return { b, created: false };
  b = poseAddBlock(tick, key, { name: 'ポーズ' + nextPoseBlockId });
  return { b, created: true };
}

// ブロックのキーの時刻(全部の関節をまとめた、重ならない一覧)
function poseKeyTimes(b) {
  const set = new Map();
  for (const j in b.tracks) for (const k of b.tracks[j]) set.set(Math.round(k.time * 100) / 100, k.time);
  return [...set.values()].sort((a, c) => a - c);
}


// ============================================================
// 組み立て(関節ごとの行列)
// ============================================================

function _m4Rz(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
function _m4S(x, y, z) { return new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]); }
function _m4Mul(...ms) { let r = ms[0]; for (let i = 1; i < ms.length; i++) r = mat4Multiply(r, ms[i]); return r; }
function _m4Point(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}
function _m4Dir(m, d) {
  const v = [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function _m4Inverse(m) {
  const inv = new Float32Array(16);
  inv[0] = m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
  inv[4] = -m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
  inv[8] = m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
  inv[1] = -m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
  inv[5] = m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
  inv[9] = -m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
  inv[13] = m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
  inv[2] = m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
  inv[6] = -m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
  inv[10] = m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
  inv[3] = -m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
  inv[7] = m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
  inv[15] = m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (Math.abs(det) < 1e-12) return null;
  det = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}

const _D2R = Math.PI / 180;
// 関節の回転 = Ry * Rz * Rx
function _jointRot(sign, r) {
  return _m4Mul(mat4RotateY(sign[1] * r[1] * _D2R), _m4Rz(sign[2] * r[2] * _D2R), mat4RotateX(sign[0] * r[0] * _D2R));
}

// 戻り値: { pre:{関節:回転の手前の行列}, frame:{関節:行列}, parent:{関節:親の行列}, parts:[{joint, model}] }
function poseBuildRig(type, base, pose) {
  const T = RIG_TYPES[type];
  const pre = {}, frame = {}, parent = {};
  const world = modelMatrixYaw(base.pos[0], base.pos[1], base.pos[2], base.yaw);
  const rp = pose.root.p;
  parent.root = world;
  pre.root = _m4Mul(world, mat4Translate(rp[0], rp[1] + T.rootPivot, rp[2]));
  frame.root = _m4Mul(pre.root, _jointRot(T.rootSign, pose.root.r), mat4Translate(0, -T.rootPivot, 0));
  for (const bn of T.bones) {
    const v = pose[bn.joint], par = frame[bn.parent];
    parent[bn.joint] = par;
    pre[bn.joint] = _m4Mul(par, mat4Translate(bn.at[0] + v.p[0], bn.at[1] + v.p[1], bn.at[2] + v.p[2]));
    frame[bn.joint] = _m4Mul(pre[bn.joint], _jointRot(bn.sign, v.r));
  }
  const parts = T.parts.map(pt => ({
    joint: pt.joint,
    model: _m4Mul(frame[pt.joint], mat4Translate(pt.box[0], pt.box[1], pt.box[2]), _m4S(pt.size[0], pt.size[1], pt.size[2])),
  }));
  return { pre, frame, parent, parts };
}


// ============================================================
// 描画(entities3d.js の renderHumanoids から呼ばれる)
// ============================================================

let _poseCubeData = null;
function _poseCube() {
  if (_poseCubeData) return _poseCubeData;
  const v = [];
  const order = [0, 1, 2, 0, 2, 3];
  for (let d = 0; d < 6; d++) {
    for (const oi of order) {
      const o = FACE_OFFSETS[d][oi];
      const uv = ENT3D_CORNER_UV[oi];
      v.push(o[0] - 0.5, o[1] - 0.5, o[2] - 0.5, DIR_FACTOR[d], uv[0], uv[1]);
    }
  }
  _poseCubeData = new Float32Array(v);
  return _poseCubeData;
}

const POSE_TINT_PLAYER = [0.6, 0.6, 0.62], POSE_TINT_LOCAL = [0.85, 0.85, 0.9];
const POSE_TINT_PUPPET = [0.62, 0.74, 0.9];
const POSE_TINT_SEL = [0.95, 0.72, 0.35];
let _poseDrawingPreview = false;

// ポーズを編集している画面か(ポーズのタブ・編集視点)
function _poseEditingOn() {
  return timelineTab === 'pose' && !!poseEntity &&
    (typeof previewIsMain === 'undefined' || !previewIsMain) && (typeof pilot === 'undefined' || !pilot) && !_poseDrawingPreview;
}

function renderPosedHumanoids(gl, viewMatrix, projMatrix, tickVal) {
  const frameIdx = curTick;
  gl.useProgram(ent3dProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, ent3dVbo);
  gl.bufferData(gl.ARRAY_BUFFER, _poseCube(), gl.STATIC_DRAW);
  const stride = 24;
  gl.enableVertexAttribArray(ent3dAPosLoc);
  gl.vertexAttribPointer(ent3dAPosLoc, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(ent3dABrightnessLoc);
  gl.vertexAttribPointer(ent3dABrightnessLoc, 1, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(ent3dAUVLoc);
  gl.vertexAttribPointer(ent3dAUVLoc, 2, gl.FLOAT, false, stride, 16);
  gl.uniformMatrix4fv(ent3dUViewLoc, false, viewMatrix);
  gl.uniformMatrix4fv(ent3dUProjLoc, false, projMatrix);
  if (humanoidTextureGL) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, humanoidTextureGL);
    gl.uniform1i(ent3dUTextureLoc, 0);
    gl.uniform1f(ent3dUUseTextureLoc, 1.0);
  } else {
    gl.uniform1f(ent3dUUseTextureLoc, 0.0);
  }
  const editing = _poseEditingOn();
  const draw = (key, base, tint) => {
    const type = entityRigType(key);
    const rig = poseBuildRig(type, base, poseEntityPose(key, frameIdx));
    const isSel = editing && key === poseEntity;
    for (const p of rig.parts) {
      gl.uniformMatrix4fv(ent3dUModelLoc, false, p.model);
      let c = humanoidTextureGL ? [1, 1, 1] : tint;
      if (isSel && (p.joint === poseSelJoint || poseSelJoint === 'root')) c = POSE_TINT_SEL;
      gl.uniform3f(ent3dUTintLoc, c[0], c[1], c[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 36);
    }
  };
  if (allTimelines && allTimelines.entities) {
    for (const eid in allTimelines.entities) {
      const key = 'player:' + eid;
      const base = poseEntityBase(key, frameIdx);
      if (base) draw(key, base, eid === allTimelines.localPlayerEntityId ? POSE_TINT_LOCAL : POSE_TINT_PLAYER);
    }
  }
  for (const p of puppets) {
    const key = 'puppet:' + p.id;
    const base = poseEntityBase(key, frameIdx);
    if (base) draw(key, base, POSE_TINT_PUPPET);
  }
}


// ============================================================
// 3Dの操作: クリックでエンティティと関節を選び、矢印・リングで動かす
// ============================================================

let poseDrag = null;
let poseHover = null;

function _poseRay(mx, my) { return scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg); }

// 選んでいるエンティティの、今の組み立て(見えていなければ null)
function _poseCurrentRig() {
  if (!poseEntity) return null;
  const base = poseEntityBase(poseEntity, curTick);
  if (!base) return null;
  const type = entityRigType(poseEntity);
  const pose = poseEntityPose(poseEntity, curTick);
  return { key: poseEntity, type, base, pose, rig: poseBuildRig(type, base, pose) };
}

// リングの軸(ワールドの向き)。回転の順番 Ry*Rz*Rx に合わせる
function _poseAxes(r, joint) {
  const pre = r.rig.pre[joint];
  const v = r.pose[joint].r, s = _rigSign(r.type, joint);
  const ry = mat4RotateY(s[1] * v[1] * _D2R);
  const out = { x: _m4Dir(_m4Mul(pre, ry, _m4Rz(s[2] * v[2] * _D2R)), [1, 0, 0]) };
  if (!_rigBend(r.type, joint)) {
    out.y = _m4Dir(pre, [0, 1, 0]);
    out.z = _m4Dir(_m4Mul(pre, ry), [0, 0, 1]);
  }
  return out;
}

function _poseRingPoints(c, axis, r) {
  const u = Math.abs(axis[1]) < 0.9 ? fcVecNormalize(fcVecCross(axis, [0, 1, 0])) : fcVecNormalize(fcVecCross(axis, [1, 0, 0]));
  const v = fcVecCross(axis, u);
  const pts = []; let prev = null;
  for (let i = 0; i <= 40; i++) {
    const t = i / 40 * Math.PI * 2;
    const p = [0, 1, 2].map(k => c[k] + (u[k] * Math.cos(t) + v[k] * Math.sin(t)) * r);
    if (prev) pts.push(prev, p);
    prev = p;
  }
  return { pts, u, v };
}

const POSE_RING_COLOR = { x: [0.92, 0.3, 0.3], y: [0.35, 0.85, 0.42], z: [0.35, 0.58, 0.95] };

// 選んでいる関節のギズモ: リング(回す)+矢印(動かす)
function _poseGizmoParts(r) {
  const j = poseSelJoint;
  if (!r.rig.pre[j]) return [];
  const c = _m4Point(r.rig.pre[j], [0, 0, 0]);
  const axes = _poseAxes(r, j);
  const rad = 42 * worldUnitsPerPixelAt(c);
  const parts = [];
  for (const k of ['x', 'y', 'z']) {
    if (!axes[k]) continue;
    const ring = _poseRingPoints(c, axes[k], rad * (k === 'y' ? 1.15 : k === 'z' ? 1.0 : 0.85));
    parts.push({ kind: 'ring', comp: k, axis: axes[k], center: c, pts: ring.pts, u: ring.u, v: ring.v, color: POSE_RING_COLOR[k] });
  }
  const s = gizmoScaleAt(c) * (j === 'root' ? 0.8 : 0.5);
  for (const ax of ['x', 'y', 'z']) parts.push({ kind: 'axis', axis: ax, center: c, pts: gizmoAxisPoints(c, ax, s), color: GIZMO_AXIS_COLOR[ax] });
  return parts;
}

function renderPoseGizmos(gl, viewMatrix, projMatrix, W, H) {
  if (!_poseEditingOn()) return;
  const r = _poseCurrentRig();
  if (!r) return;
  for (const j of rigJoints(r.type)) {
    const p = _m4Point(r.rig.pre[j], [0, 0, 0]);
    const hot = j === poseSelJoint;
    _drawLineSegments(gl, viewMatrix, projMatrix, _keyDiamondSegments(p, hot ? 6 : 4), hot ? [1, 0.86, 0.3] : [0.97, 0.95, 0.9], W, H, hot ? 2.6 : 1.8);
  }
  for (const part of _poseGizmoParts(r)) {
    const same = (x) => x && x.kind === part.kind && x.comp === part.comp && x.axis === part.axis;
    const active = poseDrag ? same(poseDrag.part) : same(poseHover);
    const col = active ? part.color.map(v => v + (1 - v) * 0.6) : part.color;
    _drawLineSegments(gl, viewMatrix, projMatrix, part.pts, col, W, H, active ? 5 : 3);
  }
}

function _posePickGizmo(r, mx, my, view, proj) {
  let best = null, bestD = 11;
  for (const part of _poseGizmoParts(r)) {
    const d = _polylineScreenDist(part.pts, mx, my, view, proj, fcCanvas.width, fcCanvas.height) + (part.kind === 'ring' ? 2 : 0);
    if (d < bestD) { bestD = d; best = part; }
  }
  if (best) best.d = bestD;
  return best;
}

function _posePickMarker(r, mx, my, view, proj) {
  let best = null, bestD = 8;
  for (const j of rigJoints(r.type)) {
    const sp = projectToScreen(_m4Point(r.rig.pre[j], [0, 0, 0]), view, proj, fcCanvas.width, fcCanvas.height);
    if (!sp) continue;
    const d = Math.hypot(sp.x - mx, sp.y - my);
    if (d < bestD) { bestD = d; best = { joint: j, d }; }
  }
  return best;
}

// 線が、どの部品(箱)に当たるか
function _posePickPart(rig, ray) {
  let best = null, bestT = Infinity;
  for (const p of rig.parts) {
    const inv = _m4Inverse(p.model);
    if (!inv) continue;
    const o = _m4Point(inv, ray.origin);
    const d = [inv[0] * ray.dir[0] + inv[4] * ray.dir[1] + inv[8] * ray.dir[2],
               inv[1] * ray.dir[0] + inv[5] * ray.dir[1] + inv[9] * ray.dir[2],
               inv[2] * ray.dir[0] + inv[6] * ray.dir[1] + inv[10] * ray.dir[2]];
    let t0 = -Infinity, t1 = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-9) { if (o[i] < -0.5 || o[i] > 0.5) { t0 = Infinity; break; } continue; }
      let a = (-0.5 - o[i]) / d[i], c = (0.5 - o[i]) / d[i];
      if (a > c) [a, c] = [c, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    }
    if (t0 <= t1 && t1 > 0 && t0 < bestT) { bestT = Math.max(0, t0); best = p.joint; }
  }
  return best == null ? null : { joint: best, t: bestT };
}

// 画面の点の先にいるエンティティ(一番手前)
function _posePickEntity(ray) {
  let best = null;
  for (const e of poseEntityList()) {
    const base = poseEntityBase(e.key, curTick);
    if (!base) continue;
    const hit = _posePickPart(poseBuildRig(e.type, base, poseEntityPose(e.key, curTick)), ray);
    if (hit && (!best || hit.t < best.t)) best = { key: e.key, joint: hit.joint, t: hit.t };
  }
  return best;
}

// タブの切り替え(ポーズのタブでは、選んだエンティティだけの行を出す)
function setTimelineTab(tab) {
  if (timelineTab === tab) return;
  timelineTab = tab;
  const panel = document.getElementById('timelinePanel');
  if (panel) panel.classList.toggle('tabPose', tab === 'pose');
  renderTimelineTabs();
  renderPoseTrackBlocks();
}

// エンティティを選ぶ(ポーズのタブにして、再生ヘッドの所のブロックも選ぶ)
function poseSelectEntity(key, joint) {
  poseEntity = key;
  if (joint) poseSelJoint = joint;
  if (!rigJoints(entityRigType(key)).includes(poseSelJoint)) poseSelJoint = 'root';
  const b = poseBlockAtTick(key, curTick);
  if (b) {
    if (selectedPoseId !== b.id) selectPose(b.id);
    poseExpandedId = b.id;
  } else if (typeof clearSelection === 'function') {
    clearSelection();
  }
  setTimelineTab('pose');
  renderTimelineTabs();
  editorChanged();
}

// freecam.js の mousedown から呼ぶ。処理したら true。
// 3Dでは1回のクリックで、エンティティ(と関節)を選んで編集できる状態になる。
function poseMouseDown(e, mx, my) {
  if ((typeof previewIsMain !== 'undefined' && previewIsMain) || (typeof pilot !== 'undefined' && pilot)) return false;
  const { view, proj } = _fcEditViewProj();
  if (_poseEditingOn()) {
    const r = _poseCurrentRig();
    if (r) {
      // 近い方を選ぶ(リングの上に別の関節の◇印が重なっている時もあるため)
      const mark = _posePickMarker(r, mx, my, view, proj);
      const part = _posePickGizmo(r, mx, my, view, proj);
      if (mark && mark.joint !== poseSelJoint && (!part || mark.d <= part.d)) { poseSelJoint = mark.joint; editorChanged(); return true; }
      if (part) { _poseBeginDrag(r, part, mx, my, e.shiftKey); return true; }
    }
  }
  const hit = _posePickEntity(_poseRay(mx, my));
  if (hit) { poseSelectEntity(hit.key, hit.joint); return true; }
  return false;
}

function _poseAngleOnRing(part, hit) {
  const h = [hit[0] - part.center[0], hit[1] - part.center[1], hit[2] - part.center[2]];
  return Math.atan2(fcVecDot(h, part.v), fcVecDot(h, part.u));
}

function _poseBeginDrag(r, part, mx, my, shift) {
  beginEdit();
  const ray = _poseRay(mx, my);
  const d = { part, joint: poseSelJoint, key: r.key, type: r.type, pending: true, startMouse: [mx, my],
    shift: !!shift && r.key.startsWith('puppet:') && poseSelJoint === 'root' };
  if (part.kind === 'ring') {
    const hit = scRayPlaneIntersect(ray, part.center, part.axis);
    d.angle0 = hit ? _poseAngleOnRing(part, hit) : 0;
  } else {
    d.axisDir = _axisVec(part.axis);
    d.t0 = scClosestTOnLine(ray, part.center, d.axisDir);
    // 位置のずれは親の向きが基準。親の軸(ワールド)を覚えておく
    const par = r.rig.parent[poseSelJoint];
    d.parentAxes = [_m4Dir(par, [1, 0, 0]), _m4Dir(par, [0, 1, 0]), _m4Dir(par, [0, 0, 1])];
  }
  poseDrag = d;
}

function poseDragMove(mx, my) {
  const d = poseDrag;
  if (!d) return;
  if (d.pending && Math.hypot(mx - d.startMouse[0], my - d.startMouse[1]) < 2) return;
  if (d.pending) {
    d.pending = false;
    if (d.shift) {
      const pp = puppetGet(+d.key.slice(7));
      d.puppet = pp;
      d.startBase = { pos: pp.base.pos.slice(), yaw: pp.base.yaw };
    } else {
      const eb = poseEnsureBlockAt(d.key, curTick);
      const k = poseEditJointKey(eb.b, d.joint, curTick);
      d.startVal = { r: k.key.r.slice(), p: k.key.p.slice() };
      d.keyRef = k.key;
      poseExpandedId = eb.b.id;
      selectedPoseId = eb.b.id;
      poseSelKey = { joint: d.joint, index: k.index }; poseSelKeyExplicit = false;
      if (eb.created) showToast('🕺 ポーズのブロックを自動で作りました');
      else if (k.created) showToast(`◆ ${rigJointLabel(d.type, d.joint)}の${k.seconds.toFixed(1)}秒にキーを自動で作りました`);
      renderPoseTrackBlocks();
    }
  }
  const ray = _poseRay(mx, my);
  const part = d.part;
  if (part.kind === 'ring') {
    const hit = scRayPlaneIntersect(ray, part.center, part.axis);
    if (!hit) return;
    let delta = _poseAngleOnRing(part, hit) - d.angle0;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)) / _D2R;
    if (d.shift) { if (part.comp === 'y') d.puppet.base.yaw = d.startBase.yaw + delta * _D2R; return; }
    const ci = { x: 0, y: 1, z: 2 }[part.comp];
    let v = d.startVal.r[ci] + delta * _rigSign(d.type, d.joint)[ci];
    if (_rigBend(d.type, d.joint)) v = Math.max(0, Math.min(160, v));
    else v = ((v + 180) % 360 + 360) % 360 - 180;
    d.keyRef.r[ci] = Math.round(v * 10) / 10;
  } else {
    const t = scClosestTOnLine(ray, part.center, d.axisDir) - d.t0;
    const w = d.axisDir.map(x => x * t);
    if (d.shift) { d.puppet.base.pos = [0, 1, 2].map(i => d.startBase.pos[i] + w[i]); return; }
    d.keyRef.p = [0, 1, 2].map(i => Math.round((d.startVal.p[i] + fcVecDot(w, d.parentAxes[i])) * 1000) / 1000);
  }
}

function poseDragEnd() {
  if (!poseDrag) return;
  poseDrag = null;
  commitEdit();
  editorChanged();
}

// マウスカーソルの形(乗っている物)。何も無ければ false
function poseHoverAt(mx, my) {
  poseHover = null;
  if ((typeof previewIsMain !== 'undefined' && previewIsMain) || (typeof pilot !== 'undefined' && pilot)) return false;
  const { view, proj } = _fcEditViewProj();
  if (_poseEditingOn()) {
    const r = _poseCurrentRig();
    if (r) {
      const mark = _posePickMarker(r, mx, my, view, proj);
      poseHover = _posePickGizmo(r, mx, my, view, proj);
      if (mark && mark.joint !== poseSelJoint && (!poseHover || mark.d <= poseHover.d)) { poseHover = null; return 'pointer'; }
      if (poseHover) return 'grab';
    }
  }
  return _posePickEntity(_poseRay(mx, my)) ? 'pointer' : false;
}

function poseContextHint() {
  if (!_poseEditingOn()) return null;
  const type = entityRigType(poseEntity);
  const name = poseEntityName(poseEntity);
  if (!poseEntityBase(poseEntity, curTick)) return `${name}は今の時刻には出ていません(人形は、ブロックのある時刻だけ出ます)`;
  const jl = rigJointLabel(type, poseSelJoint);
  const extra = poseEntity.startsWith('puppet:') && poseSelJoint === 'root' ? ' / Shift+ドラッグ: 人形の置き場所ごと動かす' : '';
  return `${name}の${jl}: リングで回す・矢印で動かす(再生ヘッドの時刻にキーができる) / 手足や◇印をクリックで関節を選ぶ${extra}`;
}


// ============================================================
// 置く(素材一覧から)
// ============================================================

function _posePlayerAtScreen(mx, my) {
  const hit = _posePickEntity(_poseRay(mx, my));
  return hit && hit.key.startsWith('player:') ? hit.key : null;
}

function _poseDropPoint() {
  let mx = fcCanvas.width / 2, my = fcCanvas.height / 2;
  const p = (typeof pfDropClientPoint !== 'undefined') ? pfDropClientPoint : null;
  if (p) { const r = fcCanvas.getBoundingClientRect(); mx = p.x - r.left; my = p.y - r.top; }
  return { mx, my, dropped: !!p };
}

// 人形の置き場所: 画面の点の先の、真下の地面の上。顔は今の視点の方へ
function _posePuppetPlace(mx, my) {
  const ray = _poseRay(mx, my);
  const hit = (typeof pfRaycastLocal === 'function') ? pfRaycastLocal(ray.origin, ray.dir, 80, _poseTickVal(curTick)) : null;
  const pos = hit ? hit.pos.slice() : [0, 1, 2].map(i => ray.origin[i] + ray.dir[i] * 6);
  const top = Math.floor(pos[1] + worldOriginY);
  for (let y = top; y > top - 40; y--) {
    if (pfIsSolidLocal([pos[0], y - worldOriginY - 0.5, pos[2]], _poseTickVal(curTick))) { pos[1] = y - worldOriginY; break; }
  }
  return { pos, yaw: Math.atan2(fcPos[0] - pos[0], fcPos[2] - pos[2]) };
}

function poseAddPuppet(base, type) {
  const id = nextPuppetId++;
  const p = { id, name: '人形' + id, type: type || 'humanoid', base: { pos: base.pos.slice(), yaw: base.yaw } };
  puppets.push(p);
  return p;
}

function _poseShownPlayerKey() {
  const sel = document.getElementById('entitySelect');
  const v = (sel && sel.value) || (allTimelines && allTimelines.localPlayerEntityId);
  return v ? 'player:' + v : null;
}

// preset: { label, tracks, loopLen, seconds, puppet? }
function addPoseAt(tick, preset) {
  if (typeof pilot !== 'undefined' && pilot) exitPilot(true);
  if (typeof previewIsMain !== 'undefined') previewIsMain = false;
  const { mx, my, dropped } = _poseDropPoint();
  let target = null;
  if (!preset.puppet) {
    if (dropped) target = _posePlayerAtScreen(mx, my);
    else target = (timelineTab === 'pose' && poseEntity) ? poseEntity : _poseShownPlayerKey();
  }
  pushUndo();
  if (!target) target = 'puppet:' + poseAddPuppet(_posePuppetPlace(mx, my)).id;
  const b = poseAddBlock(tick, target, { name: preset.label, tracks: preset.tracks, loopLen: preset.loopLen, seconds: preset.seconds });
  if (curTick < b.startTick || curTick >= b.endTick) seekTo(b.startTick);
  selectPose(b.id);
  poseExpandedId = b.id;
  poseSelJoint = 'root';
  openEditPanel(b);
  showToast(`🕺 ${preset.label}を${poseEntityName(target)}に付けました。3Dで手足をクリックして動かせます`);
  return b;
}


// ============================================================
// タイムライン: タブ・エンティティの行・関節の行
// ============================================================

function renderTimelineTabs() {
  const bar = document.getElementById('timelineTabs');
  if (!bar) return;
  bar.innerHTML = '';
  const tab = (id, text) => {
    const b = _el('button', 'tlTab' + (timelineTab === id ? ' active' : ''), text);
    b.type = 'button';
    b.addEventListener('click', () => {
      setTimelineTab(id);
      if (id === 'pose' && !poseEntity) { const l = poseEntityList(); if (l.length) poseSelectEntity(_poseShownPlayerKey() || l[0].key); }
    });
    bar.appendChild(b);
  };
  tab('global', '🌐 グローバル(カメラ・テキスト・パーティクル)');
  tab('pose', '🕺 ポーズ');
  if (timelineTab !== 'pose') return;
  bar.appendChild(_el('span', 'tlTabSep'));
  const sel = document.createElement('select');
  sel.className = 'tlEntitySelect';
  for (const e of poseEntityList()) {
    const o = document.createElement('option');
    o.value = e.key;
    o.innerText = `${e.icon} ${e.name}(${RIG_TYPES[e.type].label}・関節${e.joints})`;
    sel.appendChild(o);
  }
  if (poseEntity) sel.value = poseEntity;
  sel.addEventListener('change', () => { poseSelectEntity(sel.value); sel.blur(); });
  bar.appendChild(sel);
  if (poseEntity) {
    const n = rigJointCount(entityRigType(poseEntity));
    bar.appendChild(_el('span', 'tlTabNote', n ? `関節 ${n}個+全体 · 3Dで体をクリックすると編集` : '関節なし(全体の位置と向きだけ)'));
  }
}

function _poseAbsTick(b, t) { return b.startTick + (t - b.offsetSec) * scTps(); }

function renderPoseTrackBlocks() {
  const lane = document.getElementById('timelinePoseLane');
  const jointRows = document.getElementById('timelineJointRows');
  if (!lane || !jointRows) return;
  lane.innerHTML = ''; jointRows.innerHTML = '';
  const width = tlTotalWidth();
  lane.style.width = width + 'px';
  const head = document.querySelector('#timelinePoseRow .tlHeader span');
  if (head) head.innerText = poseEntity ? '🕺 ' + poseEntityName(poseEntity) : '🕺 ポーズ';
  const mine = poseEntity ? poseBlocks.filter(b => b.target === poseEntity) : [];
  // 重なるブロックは段を分ける
  const sorted = mine.slice().sort((a, c) => a.startTick - c.startTick);
  const rowEnds = [], rows = new Map();
  for (const b of sorted) {
    let r = rowEnds.findIndex(end => end <= b.startTick);
    if (r < 0) { r = rowEnds.length; rowEnds.push(0); }
    rowEnds[r] = b.endTick; rows.set(b.id, r);
  }
  const h = Math.max(1, rowEnds.length) * TL_ROW_H;
  lane.style.height = h + 'px';
  lane.parentElement.style.height = h + 'px';
  const ppt = tlPxPerTick();
  for (const b of mine) {
    const el = document.createElement('div');
    const isSel = b.id === selectedPoseId;
    el.className = 'tlBlock pose' + (isSel ? ' selected' : '') + (b.id === poseExpandedId ? ' open' : '');
    el.style.left = (b.startTick * ppt) + 'px';
    el.style.width = Math.max(6, (b.endTick - b.startTick) * ppt) + 'px';
    el.style.top = ((rows.get(b.id) || 0) * TL_ROW_H + 3) + 'px';
    const label = document.createElement('div');
    label.className = 'tlBlockLabel';
    label.innerText = `🕺 ${b.name}` + (b.loopLen > 0 ? ` · くり返し${b.loopLen.toFixed(1)}秒` : '');
    el.appendChild(label);
    // ◆ = どれかの関節にキーがある時刻(ドラッグすると、その時刻の全部の関節のキーが動く)
    for (const t of poseKeyTimes(b)) {
      const at = _poseAbsTick(b, t);
      if (at < b.startTick - 1e-6 || at > b.endTick + 1e-6) continue;
      const d = document.createElement('div');
      const act = isSel && poseSelKey && poseSelKey.joint === '*' && Math.abs(poseSelKey.time - t) < 0.006;
      d.className = 'tlKey pose' + (act ? ' active' : '');
      d.style.left = ((at - b.startTick) * ppt) + 'px';
      d.title = `${t.toFixed(2)}秒のキー(全部の関節) — ドラッグでまとめて動かす / クリックで選んでその時刻へ`;
      d.addEventListener('mousedown', (e) => _poseKeyMouseDown(e, b, '*', t));
      el.appendChild(d);
    }
    _addResizeHandles(el);
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.detail >= 2) {
        e.stopPropagation(); e.preventDefault();
        tlDrag = null;
        if (curTick < b.startTick || curTick >= b.endTick) {
          if (typeof stopPlayback === 'function') stopPlayback();
          seekTo(Math.max(b.startTick, Math.min(b.endTick - 1, tlTickFromClientX(e.clientX))));
        }
        selectPose(b.id);
        poseExpandedId = b.id;
        openEditPanel(b);
        renderPoseTrackBlocks();
        return;
      }
      tlStartBlockDrag(e, 'pose', b);
    });
    lane.appendChild(el);
  }
  if (!poseEntity) {
    lane.appendChild(_el('div', 'tlEmpty', '上でエンティティを選ぶか、3D画面でプレイヤー・人形をクリックしてください'));
  } else if (!mine.length) {
    lane.appendChild(_el('div', 'tlEmpty', '左の素材一覧の「🕺 ポーズ」から追加するか、3D画面で体をクリックしてリング・矢印で動かすと、ブロックが自動でできます'));
  }

  // 関節の行(ブロックをダブルクリックすると全部出る)
  const b = poseExpandedId != null ? poseGet(poseExpandedId) : null;
  if (!b || b.target !== poseEntity) return;
  const type = entityRigType(b.target);
  for (const j of rigJoints(type)) {
    const expanded = j === poseSelJoint;
    const row = _el('div', 'tlRow tlJointRow' + (expanded ? ' expanded' : ''));
    row.dataset.joint = j;
    row.style.height = (expanded ? POSE_JOINT_ROW_EXPANDED_H : POSE_JOINT_ROW_H) + 'px';
    const header = _el('div', 'tlHeader');
    const tr = b.tracks[j] || [];
    header.appendChild(_el('span', null, (j === 'root' ? '◎ ' : '└ ') + rigJointLabel(type, j)));
    header.appendChild(_el('span', 'tlHeaderSub', tr.length ? `◆${tr.length}` : ''));
    header.style.cursor = 'pointer';
    header.addEventListener('mousedown', (e) => { e.stopPropagation(); poseSelJoint = j; editorChanged(); });
    const jl = _el('div', 'tlLane');
    jl.style.width = width + 'px';
    const zone = _el('div', 'tlJointZone');
    zone.style.left = (b.startTick * ppt) + 'px';
    const zw = Math.max(6, (b.endTick - b.startTick) * ppt);
    zone.style.width = zw + 'px';
    if (expanded) zone.appendChild(_poseCurveGraph(b, j, zw, POSE_JOINT_ROW_EXPANDED_H));
    tr.forEach((k, i) => {
      const at = _poseAbsTick(b, k.time);
      if (at < b.startTick - 1e-6 || at > b.endTick + 1e-6) return;
      const d = document.createElement('div');
      const act = b.id === selectedPoseId && poseSelKey && poseSelKey.joint === j && poseSelKey.index === i;
      d.className = 'tlKey pose joint' + (act ? ' active' : '');
      d.style.left = ((at - b.startTick) * ppt) + 'px';
      d.title = `${rigJointLabel(type, j)} ${k.time.toFixed(2)}秒 — ドラッグで時刻を変える / クリックで選ぶ(Deleteで削除)`;
      d.addEventListener('mousedown', (e) => _poseKeyMouseDown(e, b, j, i));
      zone.appendChild(d);
    });
    jl.appendChild(zone);
    row.appendChild(header); row.appendChild(jl);
    jointRows.appendChild(row);
  }
}

// ◆のドラッグ。joint='*' はブロックの行の◆(その時刻の全部の関節のキー)
function _poseKeyMouseDown(e, b, joint, which) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  beginEdit();
  const tps = scTps();
  const startX = e.clientX;
  const keys = joint === '*'
    ? Object.values(b.tracks).flat().filter(k => Math.abs(k.time - which) < 0.006)
    : [b.tracks[joint][which]];
  const t0 = keys[0].time;
  // 同じ関節の隣のキー(一緒に動かさない物)を追い越さない範囲
  let lo = -Infinity, hi = Infinity;
  for (const tr of Object.values(b.tracks)) {
    for (let i = 0; i < tr.length; i++) {
      if (!keys.includes(tr[i])) continue;
      if (tr[i - 1] && !keys.includes(tr[i - 1])) lo = Math.max(lo, tr[i - 1].time + 0.05);
      if (tr[i + 1] && !keys.includes(tr[i + 1])) hi = Math.min(hi, tr[i + 1].time - 0.05);
    }
  }
  let moved = false;
  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    let t = t0 + dx / tlPxPerTick() / tps;
    const sn = tlSnap(_poseAbsTick(b, t), tlSnapCandidates({ kind: 'pose', id: b.id }, false), ev);
    t = Math.max(lo, Math.min(hi, b.offsetSec + (sn.tick - b.startTick) / tps));
    for (const k of keys) k.time = t;
    seekTo(_poseAbsTick(b, t));
    renderPoseTrackBlocks();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!moved) {
      if (typeof stopPlayback === 'function') stopPlayback();
      seekTo(_poseAbsTick(b, t0));
    }
    selectPose(b.id);
    poseExpandedId = b.id;
    if (joint === '*') poseSelKey = { joint: '*', time: keys[0].time };
    else { poseSelJoint = joint; poseSelKey = { joint, index: b.tracks[joint].indexOf(keys[0]) }; }
    poseSelKeyExplicit = true;
    commitEdit();
    editorChanged();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// 関節の速さのカーブのグラフ(カメラと同じ見た目・操作)
function _poseCurveGraph(b, joint, widthPx, rowH) {
  const wrap = _el('div', 'tlCurveGraph');
  wrap.style.top = '4px';
  const H = rowH - 22;
  wrap.style.height = H + 'px';
  const tr = b.tracks[joint] || [];
  if (tr.length < 2) {
    wrap.appendChild(_el('div', 'tlCurveEmpty', 'この関節のキーが2つ以上になると、ここで動きの速さを調整できます'));
    return wrap;
  }
  const svg = _svg('svg', { width: widthPx, height: H });
  wrap.appendChild(svg);
  _poseDrawCurve(svg, b, joint);
  return wrap;
}

function _poseSegGeom(b, tr, i, H) {
  const ppt = tlPxPerTick();
  const x0 = (_poseAbsTick(b, tr[i].time) - b.startTick) * ppt, x1 = (_poseAbsTick(b, tr[i + 1].time) - b.startTick) * ppt;
  return { x0, x1, w: x1 - x0, yb: H - 4, H: H - 8 };
}

function _poseDrawCurve(svg, b, joint) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const H = parseFloat(svg.getAttribute('height'));
  const tr = b.tracks[joint];
  const segAt = _poseSegAt(b, joint, curTick);
  for (let i = 0; i < tr.length - 1; i++) {
    const g = _poseSegGeom(b, tr, i, H);
    if (g.w <= 1) continue;
    const c = scKeyCurve(tr[i]);
    const P = (nx, ny) => [g.x0 + nx * g.w, g.yb - ny * g.H];
    const [ax, ay] = P(0, 0), [bx, by] = P(1, 1), [h1x, h1y] = P(c[0], c[1]), [h2x, h2y] = P(c[2], c[3]);
    svg.appendChild(_svg('rect', { x: g.x0, y: 2, width: g.w, height: H - 4, class: 'tlCurveSeg' + (i === segAt ? ' hot' : '') }));
    svg.appendChild(_svg('path', { d: `M${ax},${ay} C${h1x},${h1y} ${h2x},${h2y} ${bx},${by} L${bx},${ay} Z`, class: 'tlCurveFill pose' }));
    svg.appendChild(_svg('path', { d: `M${ax},${ay} C${h1x},${h1y} ${h2x},${h2y} ${bx},${by}`, class: 'tlCurveLine pose' }));
    const pid = scCurvePresetId(tr[i].curve);
    if (g.w > 74) {
      const t = _svg('text', { x: g.x0 + 5, y: 12, class: 'tlCurveLabel' });
      t.textContent = pid ? CURVE_PRESETS[pid].label : 'カスタム';
      svg.appendChild(t);
    }
    svg.appendChild(_svg('line', { x1: ax, y1: ay, x2: h1x, y2: h1y, class: 'tlCurveArm' }));
    svg.appendChild(_svg('line', { x1: bx, y1: by, x2: h2x, y2: h2y, class: 'tlCurveArm' }));
    for (const which of [0, 1]) {
      const [hx, hy] = which ? [h2x, h2y] : [h1x, h1y];
      const h = _svg('circle', { cx: hx, cy: hy, r: 5, class: 'tlCurveHandle' });
      h.addEventListener('mousedown', (e) => _posePointerCurve(e, svg, b, joint, i, which));
      svg.appendChild(h);
    }
  }
}

function _poseSegAt(b, joint, tick) {
  const tr = b.tracks[joint] || [];
  if (tr.length < 2) return -1;
  const s = poseLocalSec(b, tick);
  let i = 0;
  while (i < tr.length - 2 && s >= tr[i + 1].time) i++;
  return i;
}

function _posePointerCurve(e, svg, b, joint, seg, which) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  beginEdit();
  const H = parseFloat(svg.getAttribute('height'));
  const tr = b.tracks[joint];
  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const g = _poseSegGeom(b, tr, seg, H);
    const nx = Math.max(0, Math.min(1, (ev.clientX - rect.left - g.x0) / g.w));
    const ny = Math.max(0, Math.min(1, (rect.top + g.yb - ev.clientY) / g.H));
    const c = scKeyCurve(tr[seg]).slice();
    if (which === 0) { c[0] = nx; c[1] = ny; } else { c[2] = nx; c[3] = ny; }
    if (ev.shiftKey) { if (which === 0) { c[2] = 1 - nx; c[3] = 1 - ny; } else { c[0] = 1 - nx; c[1] = 1 - ny; } }
    tr[seg].curve = c;
    _poseDrawCurve(svg, b, joint);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    commitEdit();
    editorChanged();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// 選んでいるキーを消す(Delete)。消したら true
function poseDeleteSelectedKey() {
  const b = poseGetSelected();
  if (!b || !poseSelKeyExplicit || !poseSelKey) return false;
  if (poseSelKey.joint === '*') {
    for (const j in b.tracks) b.tracks[j] = b.tracks[j].filter(k => Math.abs(k.time - poseSelKey.time) >= 0.006);
  } else {
    const tr = b.tracks[poseSelKey.joint];
    if (!tr || !tr[poseSelKey.index]) return false;
    tr.splice(poseSelKey.index, 1);
  }
  poseSelKey = null; poseSelKeyExplicit = false;
  return true;
}


// ============================================================
// 右の編集パネル
// ============================================================

function renderPoseEditFields(title, body, b) {
  const type = entityRigType(b.target);
  title.innerText = '🕺 ' + b.name;
  const sec = (label) => body.appendChild(_el('div', 'panelSectionLabel', label));
  const row = (label) => { const r = _el('div', 'fieldRow'); r.appendChild(_el('label', null, label)); body.appendChild(r); return r; };

  const nameRow = row('名前');
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'panelInput'; nameInput.value = b.name;
  bindEditUndo(nameInput);
  nameInput.addEventListener('input', () => { b.name = nameInput.value; renderPoseTrackBlocks(); });
  nameRow.appendChild(nameInput);

  body.appendChild(_el('div', 'poseStatus noKey', `${poseEntityName(b.target)} · ${RIG_TYPES[type].label} · 関節${rigJointCount(type)}個`));

  // 関節
  sec('動かす関節(3Dでクリックしても選べます)');
  const group = _el('div', 'settingsRadioGroup');
  for (const j of rigJoints(type)) {
    const n = (b.tracks[j] || []).length;
    const pill = _el('button', 'settingsRadioPill small' + (j === poseSelJoint ? ' active' : ''), rigJointLabel(type, j) + (n ? ` ◆${n}` : ''));
    pill.type = 'button';
    pill.addEventListener('click', () => { poseSelJoint = j; editorChanged(); });
    group.appendChild(pill);
  }
  body.appendChild(group);

  // 速さのカーブ(選んでいる関節の、再生ヘッドがある区間)
  sec(`動きの速さ(${rigJointLabel(type, poseSelJoint)}のキーの間)`);
  const seg = _poseSegAt(b, poseSelJoint, curTick);
  if (seg < 0) {
    body.appendChild(_el('div', 'panelHint', 'この関節のキーが2つ以上になると、キーの間の進み方(ゆっくり始まる・なめらかに止まる等)を選べます。'));
  } else {
    const tr = b.tracks[poseSelJoint];
    const cur = scCurvePresetId(tr[seg].curve);
    body.appendChild(_el('div', 'curveSegLabel', `◆${seg + 1} → ◆${seg + 2} の区間(再生ヘッドの位置)`));
    const cg = _el('div', 'settingsRadioGroup');
    for (const [id, p] of Object.entries(CURVE_PRESETS)) {
      const pill = _el('button', 'settingsRadioPill curvePill' + (cur === id ? ' active' : ''));
      pill.type = 'button';
      pill.appendChild(_curveIcon(p.c));
      pill.appendChild(document.createTextNode(p.label));
      pill.addEventListener('click', () => { if (cur === id) return; pushUndo(); tr[seg].curve = p.c.slice(); editorChanged(); });
      cg.appendChild(pill);
    }
    body.appendChild(cg);
    const acts = _el('div', 'genActions');
    const allJ = _el('button', 'btn btn-ghost btn-sm', 'この関節の全区間に');
    allJ.addEventListener('click', () => { pushUndo(); const c = scKeyCurve(tr[seg]); tr.forEach(k => { k.curve = c.slice(); }); editorChanged(); });
    const allB = _el('button', 'btn btn-ghost btn-sm', '全部の関節に');
    allB.addEventListener('click', () => { pushUndo(); const c = scKeyCurve(tr[seg]); for (const t of Object.values(b.tracks)) t.forEach(k => { k.curve = c.slice(); }); editorChanged(); showToast('全部の関節のキーに同じカーブを使いました'); });
    acts.appendChild(allJ); acts.appendChild(allB);
    body.appendChild(acts);
  }

  const resetRow = _el('div', 'panelActions');
  const reset = _el('button', 'btn btn-ghost btn-sm', '↺ この関節を、再生ヘッドの時刻でまっすぐに戻す');
  reset.addEventListener('click', () => {
    if (curTick < b.startTick || curTick >= b.endTick) { showToast('再生ヘッドをこのブロックの上に合わせてください'); return; }
    pushUndo();
    const k = poseEditJointKey(b, poseSelJoint, curTick).key;
    k.r = [0, 0, 0]; k.p = [0, 0, 0];
    editorChanged();
  });
  resetRow.appendChild(reset);
  body.appendChild(resetRow);

  // くり返し・長さ
  sec('くり返しと長さ');
  const loopRow = _el('label', 'scriptCheck');
  const loop = document.createElement('input');
  loop.type = 'checkbox'; loop.checked = b.loopLen > 0;
  loop.addEventListener('change', () => {
    pushUndo();
    const last = Math.max(0, ...poseKeyTimes(b));
    b.loopLen = loop.checked ? Math.max(0.2, last || 1) : 0;
    editorChanged();
  });
  loopRow.appendChild(loop);
  loopRow.appendChild(document.createTextNode('くり返す'));
  body.appendChild(loopRow);
  if (b.loopLen > 0) {
    const lr = row('1回の長さ');
    const li = document.createElement('input');
    li.type = 'number'; li.step = '0.05'; li.min = '0.1'; li.className = 'panelInput small'; li.value = b.loopLen.toFixed(2);
    bindEditUndo(li);
    li.addEventListener('change', () => { const v = parseFloat(li.value); if (v > 0.05) { b.loopLen = v; editorChanged(); } });
    lr.appendChild(li); lr.appendChild(_el('span', 'fieldUnit', '秒'));
  }
  const durRow = row('ブロックの長さ');
  const dur = document.createElement('input');
  dur.type = 'number'; dur.step = '0.1'; dur.min = '0.1'; dur.className = 'panelInput small';
  dur.value = ((b.endTick - b.startTick) / scTps()).toFixed(1);
  bindEditUndo(dur);
  dur.addEventListener('change', () => {
    const v = parseFloat(dur.value);
    if (!(v > 0)) return;
    const maxTick = scMaxTick();
    b.endTick = Math.max(b.startTick + 1, Math.round(b.startTick + v * scTps()));
    if (maxTick > 0) b.endTick = Math.min(b.endTick, maxTick);
    editorChanged();
  });
  durRow.appendChild(dur);
  durRow.appendChild(_el('span', 'fieldUnit', '秒'));

  body.appendChild(_el('div', 'panelHint', '3Dで体をクリックすると、その関節にリング(赤=前後・緑=ひねり・青=横)と矢印(位置)が出ます。' +
    'ドラッグすると、その関節だけの◆キーが再生ヘッドの時刻にでき、キーは関節ごとの行に並びます(ブロックをダブルクリックで全部の行が開く)。' +
    (b.target.startsWith('puppet:') ? '人形は、全体を Shift+ドラッグで置き場所ごと動かせます。' : 'プレイヤーでは、ブロックの始めと終わりで元の姿勢となめらかにつながります。')));

  const actions = _el('div', 'panelActions');
  const save = _el('button', 'btn btn-ghost btn-sm', '⭐ このポーズの動きをカスタムに保存');
  save.addEventListener('click', () => savePoseAsCustom(b));
  actions.appendChild(save);
  const delBtn = _el('button', 'btn btn-ghost btn-sm dangerBtn', '🗑 このブロックを削除');
  delBtn.addEventListener('click', () => { selectPose(b.id); poseSelKeyExplicit = false; deleteSelection(); });
  actions.appendChild(delBtn);
  body.appendChild(actions);
}


// ============================================================
// 公式のポーズ・カスタム
// ============================================================

// 公式のポーズは「全身のポーズの並び」で書いて、関節ごとのキーに変える(0のままの関節はキーを作らない)
function _poseTracksFromFrames(frames) {
  const tracks = {};
  for (const j of rigJoints('humanoid')) {
    const used = frames.some(f => (f.pose[j] && f.pose[j].some(v => v)) || (j === 'root' && f.pose.rootPos && f.pose.rootPos.some(v => v)));
    if (!used) continue;
    tracks[j] = frames.map(f => ({
      time: f.time,
      r: (f.pose[j] || [0, 0, 0]).slice(),
      p: j === 'root' ? (f.pose.rootPos || [0, 0, 0]).slice() : [0, 0, 0],
      curve: CURVE_PRESETS.smooth.c.slice(),
    }));
  }
  return tracks;
}
function _preset(o) {
  const last = o.frames[o.frames.length - 1].time;
  return { id: o.id, icon: o.icon, label: o.label, desc: o.desc, puppet: !!o.puppet, seconds: o.seconds,
           loopLen: o.loop ? last : 0, tracks: _poseTracksFromFrames(o.frames) };
}

const OFFICIAL_POSES = [
  _preset({ id: 'puppet', icon: '🧸', label: '人形を出す', desc: 'まっすぐ立った人形', puppet: true, seconds: 3, frames: [{ time: 0, pose: {} }] }),
  _preset({ id: 'wave', icon: '👋', label: '手を振る', desc: '右手を上げて振る', loop: true, seconds: 3, frames: [
    { time: 0, pose: { armR: [10, 0, 140], elbowR: [35, 0, 0], head: [0, 0, 5] } },
    { time: 0.35, pose: { armR: [10, 0, 165], elbowR: [5, 0, 0], head: [0, 0, 5] } },
    { time: 0.7, pose: { armR: [10, 0, 140], elbowR: [35, 0, 0], head: [0, 0, 5] } },
  ] }),
  _preset({ id: 'walk', icon: '🚶', label: '歩く', desc: '手足を交互に振る', loop: true, seconds: 4, frames: [
    { time: 0, pose: { legR: [28, 0, 0], legL: [-28, 0, 0], kneeL: [25, 0, 0], armR: [-25, 0, 3], armL: [25, 0, 3], elbowR: [10, 0, 0], elbowL: [20, 0, 0] } },
    { time: 0.5, pose: { legR: [-28, 0, 0], legL: [28, 0, 0], kneeR: [25, 0, 0], armR: [25, 0, 3], armL: [-25, 0, 3], elbowR: [20, 0, 0], elbowL: [10, 0, 0] } },
    { time: 1, pose: { legR: [28, 0, 0], legL: [-28, 0, 0], kneeL: [25, 0, 0], armR: [-25, 0, 3], armL: [25, 0, 3], elbowR: [10, 0, 0], elbowL: [20, 0, 0] } },
  ] }),
  _preset({ id: 'run', icon: '🏃', label: '走る', desc: '前かがみで大きく振る', loop: true, seconds: 4, frames: [
    { time: 0, pose: { body: [14, 0, 0], head: [-10, 0, 0], legR: [55, 0, 0], kneeR: [30, 0, 0], legL: [-40, 0, 0], kneeL: [85, 0, 0], armR: [-50, 0, 5], armL: [55, 0, 5], elbowR: [70, 0, 0], elbowL: [90, 0, 0], rootPos: [0, 0.08, 0] } },
    { time: 0.3, pose: { body: [14, 0, 0], head: [-10, 0, 0], legR: [-40, 0, 0], kneeR: [85, 0, 0], legL: [55, 0, 0], kneeL: [30, 0, 0], armR: [55, 0, 5], armL: [-50, 0, 5], elbowR: [90, 0, 0], elbowL: [70, 0, 0], rootPos: [0, 0.08, 0] } },
    { time: 0.6, pose: { body: [14, 0, 0], head: [-10, 0, 0], legR: [55, 0, 0], kneeR: [30, 0, 0], legL: [-40, 0, 0], kneeL: [85, 0, 0], armR: [-50, 0, 5], armL: [55, 0, 5], elbowR: [70, 0, 0], elbowL: [90, 0, 0], rootPos: [0, 0.08, 0] } },
  ] }),
  _preset({ id: 'cheer', icon: '🙌', label: 'バンザイ', desc: '両手を上げて跳ねる', loop: true, seconds: 3, frames: [
    { time: 0, pose: { armR: [0, 0, 165], armL: [0, 0, 165], kneeR: [30, 0, 0], kneeL: [30, 0, 0], legR: [15, 0, 0], legL: [15, 0, 0], rootPos: [0, -0.06, 0] } },
    { time: 0.3, pose: { armR: [0, 0, 170], armL: [0, 0, 170], head: [-15, 0, 0], rootPos: [0, 0.45, 0] } },
    { time: 0.6, pose: { armR: [0, 0, 165], armL: [0, 0, 165], kneeR: [30, 0, 0], kneeL: [30, 0, 0], legR: [15, 0, 0], legL: [15, 0, 0], rootPos: [0, -0.06, 0] } },
  ] }),
  _preset({ id: 'dance', icon: '💃', label: 'ダンス', desc: '体をゆらして踊る', loop: true, seconds: 4, frames: [
    { time: 0, pose: { body: [0, 15, 10], head: [0, -10, -8], armR: [30, 0, 100], elbowR: [70, 0, 0], armL: [-10, 0, 30], elbowL: [90, 0, 0], kneeR: [25, 0, 0], legR: [12, 0, 0] } },
    { time: 0.5, pose: { body: [0, -15, -10], head: [0, 10, 8], armL: [30, 0, 100], elbowL: [70, 0, 0], armR: [-10, 0, 30], elbowR: [90, 0, 0], kneeL: [25, 0, 0], legL: [12, 0, 0] } },
    { time: 1, pose: { body: [0, 15, 10], head: [0, -10, -8], armR: [30, 0, 100], elbowR: [70, 0, 0], armL: [-10, 0, 30], elbowL: [90, 0, 0], kneeR: [25, 0, 0], legR: [12, 0, 0] } },
  ] }),
  _preset({ id: 'bow', icon: '🙇', label: 'おじぎ', desc: 'ゆっくり頭を下げる', seconds: 2, frames: [
    { time: 0, pose: {} },
    { time: 0.5, pose: { body: [45, 0, 0], head: [10, 0, 0], armR: [8, 0, 0], armL: [8, 0, 0] } },
    { time: 1.2, pose: { body: [45, 0, 0], head: [10, 0, 0], armR: [8, 0, 0], armL: [8, 0, 0] } },
    { time: 1.8, pose: {} },
  ] }),
  _preset({ id: 'point', icon: '👉', label: '指さす', desc: '右手で前を指す', seconds: 2, frames: [
    { time: 0, pose: { armR: [90, -10, 0], head: [0, -8, 0], body: [0, -8, 0] } }] }),
  _preset({ id: 'sit', icon: '🪑', label: '座る', desc: '地面に座る', seconds: 3, frames: [
    { time: 0, pose: { legR: [85, 0, 4], legL: [85, 0, 4], kneeR: [15, 0, 0], kneeL: [15, 0, 0], armR: [-25, 0, 8], armL: [-25, 0, 8], body: [-8, 0, 0], rootPos: [0, -0.52, 0] } }] }),
  _preset({ id: 'sleep', icon: '😴', label: '寝る', desc: 'あお向けに寝ころぶ', seconds: 3, frames: [
    { time: 0, pose: { root: [-90, 0, 0], armR: [0, 0, 25], armL: [0, 0, 25], rootPos: [0, -0.77, 0] } }] }),
];

const LS_CUSTOM_POSES = 'bloxdEditor.customPoses.v1';
let customPoses = (() => {
  let list;
  try { list = JSON.parse(localStorage.getItem(LS_CUSTOM_POSES) || '[]'); } catch (e) { list = []; }
  // ステップ13の形(全身のキーの並び keys)で保存された物は、関節ごとのキーに直す
  return list.map(c => {
    if (c.tracks || !c.keys) return c;
    const last = c.keys.length ? c.keys[c.keys.length - 1].time : 0;
    return { id: c.id, icon: c.icon || '⭐', label: c.label, desc: c.desc, seconds: c.seconds,
             loopLen: c.loop ? last : 0, tracks: _poseTracksFromFrames(c.keys) };
  });
})();
function _saveCustomPoses() { try { localStorage.setItem(LS_CUSTOM_POSES, JSON.stringify(customPoses)); } catch (e) { /* 保存できなくても続ける */ } }

function savePoseAsCustom(b) {
  // くり返さない時は、ブロックの先頭(offsetSec)を0にそろえて保存する
  const shift = b.loopLen > 0 ? 0 : b.offsetSec;
  const tracks = {};
  for (const [j, tr] of Object.entries(b.tracks)) {
    if (!tr.length) continue;
    tracks[j] = tr.map(k => {
      const o = { time: +(k.time - shift).toFixed(3), r: k.r.slice(), p: k.p.slice() };
      if (k.curve) o.curve = k.curve.slice();
      return o;
    });
  }
  const n = Object.values(tracks).reduce((a, t) => a + t.length, 0);
  customPoses.push({
    id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    label: b.name, icon: '⭐', loopLen: b.loopLen, seconds: +((b.endTick - b.startTick) / scTps()).toFixed(2), tracks,
    desc: `関節${Object.keys(tracks).length}つ・キー${n}個` + (b.loopLen > 0 ? '・くり返し' : ''),
  });
  _saveCustomPoses();
  activeAssetCategoryId = 'pose'; activeAssetSource = 'custom'; assetListCollapsed = false;
  renderAssetRail(); renderAssetList();
  showToast(`⭐ 「${b.name}」をカスタム素材に保存しました`);
}

function isPoseAssetKey(key) { return /^(pose|cpose):/.test(String(key)); }
function addPoseAsset(key, tick) {
  const [kind, id] = String(key).split(':');
  const preset = kind === 'pose' ? OFFICIAL_POSES.find(p => p.id === id) : customPoses.find(p => p.id === id);
  if (preset) addPoseAt(tick, preset);
}

function renderPoseAssets(list, source) {
  if (source === 'public') { _renderPublic(list, ASSET_CATEGORIES.find(c => c.id === 'pose')); return; }
  const grid = _div('assetGrid');
  const items = source === 'official' ? OFFICIAL_POSES : customPoses;
  if (!items.length) {
    const empty = _div('assetSoon');
    empty.innerHTML = '<b>まだカスタムのポーズはありません</b>';
    const p = document.createElement('p');
    p.innerText = 'ポーズのブロックをダブルクリックして「⭐ このポーズの動きをカスタムに保存」で作れます。';
    empty.appendChild(p);
    list.appendChild(empty);
    return;
  }
  for (const item of items) {
    const key = (source === 'official' ? 'pose:' : 'cpose:') + item.id;
    const card = _makeCard(key, 'pose', item.icon, item.label, item.desc || '', null);
    if (source === 'custom') {
      card.classList.add('custom');
      _cardButton(card, '✕', 'この素材を削除', () => {
        customPoses = customPoses.filter(x => x.id !== item.id);
        _saveCustomPoses();
        renderAssetList();
        showToast(`「${item.label}」を削除しました`);
      });
    }
    grid.appendChild(card);
  }
  list.appendChild(grid);
  list.appendChild(_div('assetHint', 'クリックすると、ポーズのタブで選んでいるエンティティ(選んでいなければ右下で選んでいるプレイヤー)に付きます。3D画面のプレイヤーの上にドラッグするとその人に、地面にドラッグするとそこに人形が出ます。'));
}
