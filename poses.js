// poses.js
// ============================================================
// 🕺ポーズ(人形の手足を曲げるアニメーション)。
//
// 人形の作り(関節):
//   全身(root) ─ 体(body) ─ 頭(head)
//                         ├ 右腕(armR) ─ 右ひじ(elbowR)
//                         └ 左腕(armL) ─ 左ひじ(elbowL)
//              ├ 右脚(legR) ─ 右ひざ(kneeR)
//              └ 左脚(legL) ─ 左ひざ(kneeL)
//   角度は「度」で [x, y, z]:
//     x = 前へ(腕・脚は前へ振る、頭・体は前へ倒す、ひじ・ひざは曲げる)
//     y = ひねり(頭・体は左を向く方が +)
//     z = 横へ(腕・脚は外へ開く、頭・体は左へ傾く方が +)
//   全身は、これに加えて rootPos(位置のずれ。人形から見た 右左/上下/前後 ではなく、
//   人形の向きを基準にした x,y,z)を持つ。
//
// ポーズのブロック(timelineの「🕺 ポーズ」の行):
//   { id, kind:'pose', name, startTick, endTick, offsetSec, loop,
//     target: 'player:<eid>' | 'puppet', base:{pos,yaw}(人形の時だけ),
//     keys:[{ time(秒), pose }] }
//   キーの間はなめらかにつなぐ。loop の時は、最初のキー〜最後のキーをくり返す。
//   プレイヤーに付けた時は、ブロックの端で少しずつ元の姿勢と混ぜる(急に変わらない)。
//   人形(puppet)は、ブロックの間だけ base の場所に出る。
// ============================================================

let poseBlocks = [];
let nextPoseBlockId = 1;
let selectedPoseId = null;
let poseSelJoint = 'armR';          // 3Dで回す関節
let poseSelKey = null;              // 選んでいるキー(タイムラインの◆)
let poseSelKeyExplicit = false;

const POSE_JOINTS = ['root', 'body', 'head', 'armR', 'elbowR', 'armL', 'elbowL', 'legR', 'kneeR', 'legL', 'kneeL'];
const POSE_JOINT_LABELS = {
  root: '全身', body: '体', head: '頭', armR: '右腕', elbowR: '右ひじ', armL: '左腕', elbowL: '左ひじ',
  legR: '右脚', kneeR: '右ひざ', legL: '左脚', kneeL: '左ひざ',
};
// 関節ごとの回し方: s=[x,y,z] の符号(ユーザーの角度→実際の回転)、bend=曲げるだけ(ひじ・ひざ)
const _POSE_SIGN = {
  root: [1, 1, -1], body: [1, 1, -1], head: [1, 1, -1],
  armR: [-1, -1, -1], armL: [-1, 1, 1], legR: [-1, -1, -1], legL: [-1, 1, 1],
  elbowR: [-1, 0, 0], elbowL: [-1, 0, 0], kneeR: [1, 0, 0], kneeL: [1, 0, 0],
};
const _POSE_BEND = { elbowR: 1, elbowL: 1, kneeR: 1, kneeL: 1 };

const POSE_KEY_SNAP = 0.1;
const POSE_BLEND_SEC = 0.2;
const POSE_DEFAULT_SECONDS = 3;

function poseZero() {
  const p = {};
  for (const j of POSE_JOINTS) p[j] = [0, 0, 0];
  p.rootPos = [0, 0, 0];
  return p;
}
function poseClone(p) {
  const o = {};
  for (const j of POSE_JOINTS) o[j] = (p && p[j] ? p[j] : [0, 0, 0]).slice();
  o.rootPos = (p && p.rootPos ? p.rootPos : [0, 0, 0]).slice();
  return o;
}
// 省略した関節は 0 のポーズを作る(公式のポーズを短く書くため)
function poseFrom(partial) { return poseClone(partial || {}); }

function _poseLerp(a, b, t) {
  const o = {};
  for (const j of POSE_JOINTS) o[j] = [0, 1, 2].map(i => a[j][i] + (b[j][i] - a[j][i]) * t);
  o.rootPos = [0, 1, 2].map(i => a.rootPos[i] + (b.rootPos[i] - a.rootPos[i]) * t);
  return o;
}
function _smooth(t) { return t * t * (3 - 2 * t); }


// ============================================================
// ブロック(データ)
// ============================================================

function poseGet(id) { return poseBlocks.find(b => b.id === id) || null; }
function poseGetSelected() { return selectedPoseId != null ? poseGet(selectedPoseId) : null; }

function poseAddBlock(tick, props) {
  const maxTick = scMaxTick();
  let start = Math.max(0, Math.round(tick));
  if (maxTick > 0) start = Math.min(start, Math.max(0, maxTick - 1));
  const seconds = props.seconds || POSE_DEFAULT_SECONDS;
  let end = start + Math.round(seconds * scTps());
  if (maxTick > 0) end = Math.min(end, maxTick);
  const id = nextPoseBlockId++;
  const b = {
    id, kind: 'pose', name: props.name || ('ポーズ' + id),
    startTick: start, endTick: Math.max(start + 1, end), offsetSec: 0,
    loop: !!props.loop, target: props.target || 'puppet',
    base: props.base ? { pos: props.base.pos.slice(), yaw: props.base.yaw } : null,
    keys: (props.keys && props.keys.length ? props.keys : [{ time: 0, pose: poseZero() }])
      .map(k => ({ time: k.time, pose: poseClone(k.pose) })),
  };
  poseBlocks.push(b);
  return b;
}

function poseDeleteBlock(id) { poseBlocks = poseBlocks.filter(b => b.id !== id); }

// 分割: 右側は同じ動きの続き(offsetSec をずらすだけ)
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

function poseTargetLabel(b) {
  if (b.target === 'puppet') return '人形';
  const eid = b.target.slice(7);
  const e = allTimelines && allTimelines.entities[eid];
  return e ? (e.name || eid) : eid;
}

// ブロックの中の時刻(秒)。ループの時は、最初〜最後のキーの間に折り返す
function _poseLocalSec(b, tick) {
  let s = b.offsetSec + (tick - b.startTick) / scTps();
  const ks = b.keys;
  if (b.loop && ks.length > 1) {
    const t0 = ks[0].time, len = ks[ks.length - 1].time - t0;
    if (len > 0.01) s = t0 + (((s - t0) % len) + len) % len;
  }
  return s;
}

// キーの間をなめらかにつないだポーズ
function poseEvalKeys(keys, s) {
  if (!keys.length) return poseZero();
  if (keys.length === 1 || s <= keys[0].time) return poseClone(keys[0].pose);
  const last = keys[keys.length - 1];
  if (s >= last.time) return poseClone(last.pose);
  let i = 0;
  while (i < keys.length - 2 && s > keys[i + 1].time) i++;
  const a = keys[i], c = keys[i + 1];
  const t = _smooth(Math.max(0, Math.min(1, (s - a.time) / ((c.time - a.time) || 1))));
  return _poseLerp(a.pose, c.pose, t);
}

// 指定したフレームの、ブロックのポーズと混ぜる強さ(0〜1)
function poseBlockAt(b, tick) {
  const pose = poseEvalKeys(b.keys, _poseLocalSec(b, tick));
  let w = 1;
  if (b.target !== 'puppet') {
    const tps = scTps();
    const fromStart = (tick - b.startTick) / tps, toEnd = (b.endTick - tick) / tps;
    w = Math.max(0, Math.min(1, fromStart / POSE_BLEND_SEC, toEnd / POSE_BLEND_SEC));
  }
  return { pose, w };
}

function poseActiveAt(tick) { return poseBlocks.filter(b => tick >= b.startTick && tick < b.endTick); }

// プレイヤーの今のポーズ(ポーズのブロックが無ければ null)。後から置いたブロックが優先
function posePlayerPose(eid, tick) {
  let hit = null;
  for (const b of poseBlocks) if (b.target === 'player:' + eid && tick >= b.startTick && tick < b.endTick) hit = b;
  if (!hit) return null;
  const { pose, w } = poseBlockAt(hit, tick);
  return w >= 1 ? pose : _poseLerp(poseZero(), pose, w);
}

// ブロックの対象の、足元の位置(ローカル座標)と向き
function poseTargetBase(b, tick) {
  if (b.target === 'puppet') return b.base ? { pos: b.base.pos, yaw: b.base.yaw } : null;
  const ent = allTimelines && allTimelines.entities[b.target.slice(7)];
  if (!ent) return null;
  const f = nearestFrameAtOrBefore(ent.frames, _poseTickVal(tick));
  if (!f || !f.position) return null;
  return {
    pos: [f.position[0] - worldOriginX, f.position[1] - worldOriginY, f.position[2] - worldOriginZ],
    yaw: (f.rotation && f.rotation.length > 1) ? f.rotation[1] : 0,
  };
}

function _poseTickVal(frameIndex) {
  if (timeline && timeline.frames && timeline.frames.length) {
    const f = timeline.frames[Math.max(0, Math.min(timeline.frames.length - 1, Math.round(frameIndex)))];
    if (f) return f.tick;
  }
  return frameIndex;
}

// 再生ヘッドの時刻のポーズを書き換える(その時刻にキーが無ければ作る)。戻り値: キーの番号
function poseEditKeyAt(b, tick) {
  const s = _poseLocalSec(b, tick);
  let i = b.keys.findIndex(k => Math.abs(k.time - s) <= POSE_KEY_SNAP);
  if (i >= 0) return { index: i, created: false, seconds: s };
  const key = { time: s, pose: poseEvalKeys(b.keys, s) };
  b.keys.push(key);
  b.keys.sort((a, c) => a.time - c.time);
  return { index: b.keys.indexOf(key), created: true, seconds: s };
}


// ============================================================
// 人形の組み立て(関節ごとの行列)
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
// 関節の回転 = Ry * Rz * Rx(順番を決めておくと、リングの軸が計算しやすい)
function _poseJointRot(joint, a) {
  const s = _POSE_SIGN[joint];
  return _m4Mul(mat4RotateY(s[1] * a[1] * _D2R), _m4Rz(s[2] * a[2] * _D2R), mat4RotateX(s[0] * a[0] * _D2R));
}

// 部品: 関節, 親の関節, 親から見た関節の位置, 関節から見た箱の中心, 箱の大きさ
const POSE_RIG = [
  { joint: 'body',   parent: 'root', at: [0, 0.65, 0],       box: [0, 0.35, 0],     size: [0.5, 0.75, 0.28] },
  { joint: 'head',   parent: 'body', at: [0, 0.65, 0],       box: [0, 0.25, 0],     size: [0.5, 0.5, 0.5] },
  { joint: 'armR',   parent: 'body', at: [-0.375, 0.65, 0],  box: [0, -0.1125, 0],  size: [0.25, 0.375, 0.25] },
  { joint: 'elbowR', parent: 'armR', at: [0, -0.3, 0],       box: [0, -0.1875, 0],  size: [0.25, 0.375, 0.25] },
  { joint: 'armL',   parent: 'body', at: [0.375, 0.65, 0],   box: [0, -0.1125, 0],  size: [0.25, 0.375, 0.25] },
  { joint: 'elbowL', parent: 'armL', at: [0, -0.3, 0],       box: [0, -0.1875, 0],  size: [0.25, 0.375, 0.25] },
  { joint: 'legR',   parent: 'root', at: [-0.14, 0.65, 0],   box: [0, -0.1625, 0],  size: [0.25, 0.325, 0.25] },
  { joint: 'kneeR',  parent: 'legR', at: [0, -0.325, 0],     box: [0, -0.1625, 0],  size: [0.25, 0.325, 0.25] },
  { joint: 'legL',   parent: 'root', at: [0.14, 0.65, 0],    box: [0, -0.1625, 0],  size: [0.25, 0.325, 0.25] },
  { joint: 'kneeL',  parent: 'legL', at: [0, -0.325, 0],     box: [0, -0.1625, 0],  size: [0.25, 0.325, 0.25] },
];
const POSE_ROOT_PIVOT = 0.9; // 全身を回す中心の高さ

// 人形1体ぶんの行列。戻り値: { pre:{joint:行列(関節の回転の手前)}, frame:{joint:行列}, parts:[{joint, model}] }
function poseBuildRig(base, pose) {
  const pre = {}, frame = {};
  const world = modelMatrixYaw(base.pos[0], base.pos[1], base.pos[2], base.yaw);
  pre.root = _m4Mul(world, mat4Translate(pose.rootPos[0], pose.rootPos[1] + POSE_ROOT_PIVOT, pose.rootPos[2]));
  frame.root = _m4Mul(pre.root, _poseJointRot('root', pose.root), mat4Translate(0, -POSE_ROOT_PIVOT, 0));
  const parts = [];
  for (const r of POSE_RIG) {
    pre[r.joint] = _m4Mul(frame[r.parent], mat4Translate(r.at[0], r.at[1], r.at[2]));
    frame[r.joint] = _m4Mul(pre[r.joint], _poseJointRot(r.joint, pose[r.joint]));
    parts.push({ joint: r.joint, model: _m4Mul(frame[r.joint], mat4Translate(r.box[0], r.box[1], r.box[2]), _m4S(r.size[0], r.size[1], r.size[2])) });
  }
  return { pre, frame, parts, world };
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

// 全員(リプレイのプレイヤー+人形)を描く
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
  const sel = poseGetSelected();
  const selActive = sel && frameIdx >= sel.startTick && frameIdx < sel.endTick;
  const draw = (base, pose, tint, isSel) => {
    const rig = poseBuildRig(base, pose);
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
      const ent = allTimelines.entities[eid];
      const f = nearestFrameAtOrBefore(ent.frames, tickVal);
      if (!f || !f.position) continue;
      const base = {
        pos: [f.position[0] - worldOriginX, f.position[1] - worldOriginY, f.position[2] - worldOriginZ],
        yaw: (f.rotation && f.rotation.length > 1) ? f.rotation[1] : 0,
      };
      const pose = posePlayerPose(eid, frameIdx) || poseZero();
      const isSel = selActive && sel.target === 'player:' + eid && _poseEditingOn();
      draw(base, pose, eid === allTimelines.localPlayerEntityId ? POSE_TINT_LOCAL : POSE_TINT_PLAYER, isSel);
    }
  }
  for (const b of poseBlocks) {
    if (b.target !== 'puppet' || !b.base || frameIdx < b.startTick || frameIdx >= b.endTick) continue;
    draw(b.base, poseBlockAt(b, frameIdx).pose, POSE_TINT_PUPPET, b === sel && _poseEditingOn());
  }
}

// ポーズを編集できる画面か(編集視点で、ブロックを選んでいる時だけ)
function _poseEditingOn() {
  return (typeof previewIsMain === 'undefined' || !previewIsMain) && (typeof pilot === 'undefined' || !pilot) && !_poseDrawingPreview;
}
let _poseDrawingPreview = false;


// ============================================================
// 3Dの操作: 手足をクリックして選び、リングで回す
// ============================================================

let poseDrag = null;
let poseHover = null;

// 選んでいるブロックの、今の人形の組み立て(編集できない時は null)
function _poseSelectedRig() {
  const b = poseGetSelected();
  if (!b || curTick < b.startTick || curTick >= b.endTick) return null;
  const base = poseTargetBase(b, curTick);
  if (!base) return null;
  const { pose } = poseBlockAt(b, curTick);
  return { b, base, pose, rig: poseBuildRig(base, pose) };
}

// リングの軸(ワールドの向き)。回転の順番 Ry*Rz*Rx に合わせる
function _poseAxes(r, joint) {
  const pre = r.rig.pre[joint];
  const a = r.pose[joint], s = _POSE_SIGN[joint];
  const ry = mat4RotateY(s[1] * a[1] * _D2R);
  const out = { x: _m4Dir(_m4Mul(pre, ry, _m4Rz(s[2] * a[2] * _D2R)), [1, 0, 0]) };
  if (!_POSE_BEND[joint]) {
    out.y = _m4Dir(pre, [0, 1, 0]);
    out.z = _m4Dir(_m4Mul(pre, ry), [0, 0, 1]);
  }
  return out;
}

function _poseRingRadius(c) { return 42 * worldUnitsPerPixelAt(c); }

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

// 今の関節のギズモ(リング。全身は矢印も)
function _poseGizmoParts(r) {
  const j = poseSelJoint;
  const c = _m4Point(r.rig.pre[j], [0, 0, 0]);
  const axes = _poseAxes(r, j);
  const rad = _poseRingRadius(c);
  const parts = [];
  for (const k of ['x', 'y', 'z']) {
    if (!axes[k]) continue;
    const ring = _poseRingPoints(c, axes[k], rad * (k === 'y' ? 1.15 : k === 'z' ? 1.0 : 0.85));
    parts.push({ kind: 'ring', comp: k, axis: axes[k], center: c, pts: ring.pts, u: ring.u, v: ring.v, color: POSE_RING_COLOR[k] });
  }
  if (j === 'root') {
    const s = gizmoScaleAt(c) * 0.8;
    for (const ax of ['x', 'y', 'z']) parts.push({ kind: 'axis', axis: ax, center: c, pts: gizmoAxisPoints(c, ax, s), color: GIZMO_AXIS_COLOR[ax] });
  }
  return parts;
}

// 関節の目印の点(小さな◆)
function renderPoseGizmos(gl, viewMatrix, projMatrix, W, H) {
  if (!_poseEditingOn()) return;
  const r = _poseSelectedRig();
  if (!r) return;
  for (const j of POSE_JOINTS) {
    const p = _m4Point(r.rig.pre[j], [0, 0, 0]);
    const hot = j === poseSelJoint;
    _drawLineSegments(gl, viewMatrix, projMatrix, _keyDiamondSegments(p, hot ? 6 : 4), hot ? [1, 0.86, 0.3] : [0.97, 0.95, 0.9], W, H, hot ? 2.6 : 1.8);
  }
  for (const part of _poseGizmoParts(r)) {
    const active = poseDrag ? (poseDrag.part.kind === part.kind && poseDrag.part.comp === part.comp && poseDrag.part.axis === part.axis)
      : (poseHover && poseHover.kind === part.kind && poseHover.comp === part.comp && poseHover.axis === part.axis);
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
  for (const j of POSE_JOINTS) {
    const sp = projectToScreen(_m4Point(r.rig.pre[j], [0, 0, 0]), view, proj, fcCanvas.width, fcCanvas.height);
    if (!sp) continue;
    const d = Math.hypot(sp.x - mx, sp.y - my);
    if (d < bestD) { bestD = d; best = { joint: j, d }; }
  }
  return best;
}

// 画面の点から伸ばした線が、どの部品(箱)に当たるか
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

function _poseRay(mx, my) { return scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg); }

// 人形(ポーズの付いた人)をクリックした時に、どのブロックの何の関節か
function _posePickAnyBlock(ray) {
  let best = null;
  for (const b of poseActiveAt(curTick)) {
    const base = poseTargetBase(b, curTick);
    if (!base) continue;
    const hit = _posePickPart(poseBuildRig(base, poseBlockAt(b, curTick).pose), ray);
    if (hit && (!best || hit.t < best.t)) best = { b, joint: hit.joint, t: hit.t };
  }
  return best;
}

// freecam.js の mousedown から呼ぶ。処理したら true
function poseMouseDown(e, mx, my) {
  if (!_poseEditingOn()) return false;
  const view = _fcEditViewProj().view, proj = _fcEditViewProj().proj;
  const r = _poseSelectedRig();
  if (r) {
    // 関節の◇印(リングより優先。全身の印もここで選べる)
    // 近い方を選ぶ(リングの上に別の関節の印が重なっている時もあるため)
    const mark = _posePickMarker(r, mx, my, view, proj);
    const part = _posePickGizmo(r, mx, my, view, proj);
    if (mark && mark.joint !== poseSelJoint && (!part || mark.d <= part.d)) { poseSelJoint = mark.joint; refreshPosePanel(); return true; }
    if (part) { _poseBeginDrag(r, part, mx, my, e.shiftKey); return true; }
  }
  const hit = _posePickAnyBlock(_poseRay(mx, my));
  if (hit) {
    if (selectedPoseId !== hit.b.id) selectPose(hit.b.id);
    // 体をクリックした時: もう体を選んでいれば全身に切り替える(体→全身→体…)
    let j = hit.joint;
    if (j === 'body' && poseSelJoint === 'body' && selectedPoseId === hit.b.id) j = 'root';
    poseSelJoint = j;
    if (e.detail >= 2) openEditPanel(hit.b);
    refreshPosePanel();
    return true;
  }
  return false;
}

function _poseBeginDrag(r, part, mx, my, shift) {
  beginEdit();
  const ray = _poseRay(mx, my);
  const d = { part, joint: poseSelJoint, blockId: r.b.id, shift: !!shift && r.b.target === 'puppet' && poseSelJoint === 'root', pending: true, startMouse: [mx, my] };
  if (part.kind === 'ring') {
    const hit = scRayPlaneIntersect(ray, part.center, part.axis);
    d.angle0 = hit ? _poseAngleOnRing(part, hit) : 0;
  } else {
    d.axisDir = _axisVec(part.axis);
    d.t0 = scClosestTOnLine(ray, part.center, d.axisDir);
  }
  poseDrag = d;
}

function _poseAngleOnRing(part, hit) {
  const h = [hit[0] - part.center[0], hit[1] - part.center[1], hit[2] - part.center[2]];
  return Math.atan2(fcVecDot(h, part.v), fcVecDot(h, part.u));
}

function poseDragMove(mx, my) {
  const d = poseDrag;
  if (!d) return;
  if (d.pending && Math.hypot(mx - d.startMouse[0], my - d.startMouse[1]) < 2) return;
  const b = poseGet(d.blockId);
  if (!b) { poseDrag = null; return; }
  if (d.pending) {
    d.pending = false;
    if (!d.shift) {
      const r = poseEditKeyAt(b, curTick);
      d.keyIndex = r.index;
      d.startPose = poseClone(b.keys[r.index].pose);
      poseSelKey = r.index; poseSelKeyExplicit = false;
      if (r.created) { renderPoseTrackBlocks(); showToast(`◆ ${r.seconds.toFixed(1)}秒にキーを自動で作りました`); }
    } else {
      d.startBase = { pos: b.base.pos.slice(), yaw: b.base.yaw };
    }
  }
  const ray = _poseRay(mx, my);
  const part = d.part;
  if (part.kind === 'ring') {
    const hit = scRayPlaneIntersect(ray, part.center, part.axis);
    if (!hit) return;
    let delta = _poseAngleOnRing(part, hit) - d.angle0;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)) / _D2R;
    if (d.shift) {
      if (part.comp === 'y') b.base.yaw = d.startBase.yaw + delta * _D2R;
      return;
    }
    const k = b.keys[d.keyIndex];
    const ci = { x: 0, y: 1, z: 2 }[part.comp];
    const sign = _POSE_SIGN[d.joint][ci];
    let v = d.startPose[d.joint][ci] + delta * sign;
    if (_POSE_BEND[d.joint]) v = Math.max(0, Math.min(160, v));
    else v = ((v + 180) % 360 + 360) % 360 - 180;
    k.pose[d.joint][ci] = Math.round(v * 10) / 10;
  } else {
    const t = scClosestTOnLine(ray, part.center, d.axisDir) - d.t0;
    const worldDelta = d.axisDir.map(x => x * t);
    if (d.shift) {
      b.base.pos = [0, 1, 2].map(i => d.startBase.pos[i] + worldDelta[i]);
      return;
    }
    // 全身の位置のずれは、人形の向きを基準にした値で持つ
    const base = poseTargetBase(b, curTick);
    const yaw = base ? base.yaw : 0;
    const c = Math.cos(-yaw), s = Math.sin(-yaw);
    const local = [worldDelta[0] * c + worldDelta[2] * s, worldDelta[1], -worldDelta[0] * s + worldDelta[2] * c];
    b.keys[d.keyIndex].pose.rootPos = [0, 1, 2].map(i => d.startPose.rootPos[i] + local[i]);
  }
}

function poseDragEnd() {
  if (!poseDrag) return;
  poseDrag = null;
  commitEdit();
  editorChanged();
}

// マウスが乗っているリング(光らせる用)。乗っていれば true
function poseHoverAt(mx, my) {
  poseHover = null;
  if (!_poseEditingOn()) return false;
  const r = _poseSelectedRig();
  const { view, proj } = _fcEditViewProj();
  if (r) {
    const mark = _posePickMarker(r, mx, my, view, proj);
    poseHover = _posePickGizmo(r, mx, my, view, proj);
    if (mark && mark.joint !== poseSelJoint && (!poseHover || mark.d <= poseHover.d)) { poseHover = null; return 'pointer'; }
  }
  if (poseHover) return 'grab';
  return (poseBlocks.length && _posePickAnyBlock(_poseRay(mx, my))) ? 'pointer' : false;
}

function poseContextHint() {
  const b = poseGetSelected();
  if (!b) return null;
  if (curTick < b.startTick || curTick >= b.endTick) return 'ポーズを直すには、再生ヘッドをこのブロックの上に合わせてください';
  const jl = POSE_JOINT_LABELS[poseSelJoint];
  const extra = b.target === 'puppet' ? ' / Shift+矢印・緑のリング: 人形の置き場所ごと動かす' : '';
  return `手足か◇印をクリックして選ぶ(今: ${jl}。お腹の◇印で全身) / リングをドラッグで曲げる(再生ヘッドの時刻にキーが作られる)${extra}`;
}


// ============================================================
// 置く(素材一覧から)
// ============================================================

// 3D画面のある点の先に、プレイヤーがいるか(いればそのID)
function _posePlayerAtScreen(mx, my) {
  if (!allTimelines || !allTimelines.entities) return null;
  const ray = _poseRay(mx, my);
  let best = null;
  for (const eid in allTimelines.entities) {
    const f = nearestFrameAtOrBefore(allTimelines.entities[eid].frames, _poseTickVal(curTick));
    if (!f || !f.position) continue;
    const base = { pos: [f.position[0] - worldOriginX, f.position[1] - worldOriginY, f.position[2] - worldOriginZ], yaw: f.rotation ? f.rotation[1] : 0 };
    const hit = _posePickPart(poseBuildRig(base, posePlayerPose(eid, curTick) || poseZero()), ray);
    if (hit && (!best || hit.t < best.t)) best = { eid, t: hit.t };
  }
  return best ? best.eid : null;
}

function _poseDropPoint() {
  let mx = fcCanvas.width / 2, my = fcCanvas.height / 2;
  const p = (typeof pfDropClientPoint !== 'undefined') ? pfDropClientPoint : null;
  if (p) { const r = fcCanvas.getBoundingClientRect(); mx = p.x - r.left; my = p.y - r.top; }
  return { mx, my, dropped: !!p };
}

// 人形の置き場所: 画面の点の先の地面(無ければ少し先)。顔は今の視点の方へ
function _posePuppetPlace(mx, my) {
  const ray = _poseRay(mx, my);
  const hit = (typeof pfRaycastLocal === 'function') ? pfRaycastLocal(ray.origin, ray.dir, 80, _poseTickVal(curTick)) : null;
  const pos = hit ? hit.pos.slice() : [0, 1, 2].map(i => ray.origin[i] + ray.dir[i] * 6);
  // 真下の地面の上に立たせる(壁に当たった時や、空中を指した時も)
  const top = Math.floor(pos[1] + worldOriginY);
  for (let y = top; y > top - 40; y--) {
    if (pfIsSolidLocal([pos[0], y - worldOriginY - 0.5, pos[2]], _poseTickVal(curTick))) { pos[1] = y - worldOriginY; break; }
  }
  return { pos, yaw: Math.atan2(fcPos[0] - pos[0], fcPos[2] - pos[2]) };
}

// 表示中のプレイヤー(右下で選んでいる)
function _poseShownPlayerId() {
  const sel = document.getElementById('entitySelect');
  return (sel && sel.value) || (allTimelines && allTimelines.localPlayerEntityId) || null;
}

// preset: { label, keys, loop, seconds, puppet? }
function addPoseAt(tick, preset) {
  if (typeof pilot !== 'undefined' && pilot) exitPilot(true);
  if (typeof previewIsMain !== 'undefined') previewIsMain = false;
  const { mx, my, dropped } = _poseDropPoint();
  let target = null;
  if (!preset.puppet) {
    const onPlayer = dropped ? _posePlayerAtScreen(mx, my) : null;
    if (onPlayer) target = 'player:' + onPlayer;
    else if (!dropped) target = _poseShownPlayerId() ? 'player:' + _poseShownPlayerId() : null;
  }
  pushUndo();
  const props = { name: preset.label, keys: preset.keys, loop: preset.loop, seconds: preset.seconds };
  if (target) props.target = target;
  else { props.target = 'puppet'; props.base = _posePuppetPlace(mx, my); }
  const b = poseAddBlock(tick, props);
  if (curTick < b.startTick || curTick >= b.endTick) seekTo(b.startTick);
  poseSelJoint = 'armR';
  selectPose(b.id);
  openEditPanel(b);
  showToast(`🕺 ${preset.label}を${poseTargetLabel(b)}に付けました。手足をクリックしてリングで曲げられます`);
  return b;
}


// ============================================================
// タイムラインの行
// ============================================================

function renderPoseTrackBlocks() {
  const lane = document.getElementById('timelinePoseLane');
  if (!lane) return;
  lane.innerHTML = '';
  lane.style.width = tlTotalWidth() + 'px';
  const sorted = poseBlocks.slice().sort((a, c) => a.startTick - c.startTick);
  const rowEnds = [], rows = new Map();
  for (const b of sorted) {
    let r = rowEnds.findIndex(end => end <= b.startTick);
    if (r < 0) { r = rowEnds.length; rowEnds.push(0); }
    rowEnds[r] = b.endTick; rows.set(b.id, r);
  }
  const h = Math.max(1, rowEnds.length) * TL_ROW_H;
  lane.style.height = h + 'px';
  lane.parentElement.style.height = h + 'px';
  const ppt = tlPxPerTick(), tps = scTps();
  for (const b of poseBlocks) {
    const el = document.createElement('div');
    const isSel = b.id === selectedPoseId;
    el.className = 'tlBlock pose' + (isSel ? ' selected' : '');
    el.style.left = (b.startTick * ppt) + 'px';
    const wpx = Math.max(6, (b.endTick - b.startTick) * ppt);
    el.style.width = wpx + 'px';
    el.style.top = ((rows.get(b.id) || 0) * TL_ROW_H + 3) + 'px';
    const label = document.createElement('div');
    label.className = 'tlBlockLabel';
    label.innerText = `🕺 ${b.name} · ${poseTargetLabel(b)}` + (b.loop ? ' · くり返し' : '');
    el.appendChild(label);
    // ◆キー(ブロックの中に見えている所だけ)
    const lenSec = (b.endTick - b.startTick) / tps;
    b.keys.forEach((k, i) => {
      const x = (k.time - b.offsetSec) * tps * ppt;
      if (k.time - b.offsetSec < -1e-6 || k.time - b.offsetSec > lenSec + 1e-6) return;
      const d = document.createElement('div');
      d.className = 'tlKey pose' + (isSel && i === poseSelKey ? ' active' : '');
      d.style.left = x + 'px';
      d.title = `キー${i + 1}(${k.time.toFixed(2)}秒) — ドラッグで時刻を変更 / クリックでその時刻へ`;
      d.addEventListener('mousedown', (e) => _poseKeyMouseDown(e, b, i));
      el.appendChild(d);
    });
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
        openEditPanel(b);
        return;
      }
      tlStartBlockDrag(e, 'pose', b);
    });
    lane.appendChild(el);
  }
  if (!poseBlocks.length) {
    const empty = document.createElement('div');
    empty.className = 'tlEmpty';
    empty.innerText = '左の素材一覧の「🕺 ポーズ」から追加できます(プレイヤーに付ける・人形を出す)';
    lane.appendChild(empty);
  }
}

function _poseKeyMouseDown(e, b, i) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  beginEdit();
  const tps = scTps();
  const startX = e.clientX, orig = b.keys[i].time;
  let moved = false;
  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    const prev = b.keys[i - 1], next = b.keys[i + 1];
    let t = orig + dx / tlPxPerTick() / tps;
    const abs = b.startTick + (t - b.offsetSec) * tps;
    const sn = tlSnap(abs, tlSnapCandidates({ kind: 'pose', id: b.id }, false), ev);
    t = b.offsetSec + (sn.tick - b.startTick) / tps;
    t = Math.max(prev ? prev.time + 0.05 : -Infinity, Math.min(next ? next.time - 0.05 : Infinity, t));
    b.keys[i].time = t;
    seekTo(b.startTick + (t - b.offsetSec) * tps);
    renderPoseTrackBlocks();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!moved) {
      if (typeof stopPlayback === 'function') stopPlayback();
      seekTo(b.startTick + (b.keys[i].time - b.offsetSec) * tps);
    }
    selectPose(b.id);
    poseSelKey = i; poseSelKeyExplicit = true;
    commitEdit();
    editorChanged();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}


// ============================================================
// 右の編集パネル
// ============================================================

let _posePanelJointGroup = null;

function renderPoseEditFields(title, body, b) {
  title.innerText = '🕺 ' + b.name;
  const sec = (label) => body.appendChild(_el('div', 'panelSectionLabel', label));
  const row = (label) => { const r = _el('div', 'fieldRow'); r.appendChild(_el('label', null, label)); body.appendChild(r); return r; };

  const nameRow = row('名前');
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'panelInput'; nameInput.value = b.name;
  bindEditUndo(nameInput);
  nameInput.addEventListener('input', () => { b.name = nameInput.value; renderPoseTrackBlocks(); });
  nameRow.appendChild(nameInput);

  // 対象
  const tRow = row('付ける相手');
  const sel = document.createElement('select');
  sel.className = 'panelInput';
  const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.innerText = t; sel.appendChild(o); };
  if (allTimelines && allTimelines.entities) {
    for (const [eid, info] of Object.entries(allTimelines.entities)) opt('player:' + eid, '🧍 ' + (info.name || eid));
  }
  opt('puppet', '🧸 人形(新しく出す)');
  sel.value = b.target;
  sel.addEventListener('change', () => {
    pushUndo();
    const before = poseTargetBase(b, Math.max(b.startTick, Math.min(b.endTick - 1, curTick)));
    b.target = sel.value;
    // 人形にした時は、今までの相手の場所に出す
    if (b.target === 'puppet' && !b.base) b.base = before ? { pos: before.pos.slice(), yaw: before.yaw } : _posePuppetPlace(fcCanvas.width / 2, fcCanvas.height / 2);
    editorChanged();
    sel.blur();
  });
  tRow.appendChild(sel);

  // 関節
  sec('曲げる所(3Dの手足をクリックしても選べます)');
  const group = _el('div', 'settingsRadioGroup');
  for (const j of POSE_JOINTS) {
    const pill = _el('button', 'settingsRadioPill small' + (j === poseSelJoint ? ' active' : ''), POSE_JOINT_LABELS[j]);
    pill.type = 'button';
    pill.dataset.joint = j;
    pill.addEventListener('click', () => { poseSelJoint = j; refreshPosePanel(); });
    group.appendChild(pill);
  }
  body.appendChild(group);
  _posePanelJointGroup = group;
  const resetRow = _el('div', 'panelActions');
  const reset = _el('button', 'btn btn-ghost btn-sm', '↺ 選んでいる所を、再生ヘッドの時刻でまっすぐに戻す');
  reset.addEventListener('click', () => {
    if (curTick < b.startTick || curTick >= b.endTick) { showToast('再生ヘッドをこのブロックの上に合わせてください'); return; }
    pushUndo();
    const r = poseEditKeyAt(b, curTick);
    const k = b.keys[r.index];
    k.pose[poseSelJoint] = [0, 0, 0];
    if (poseSelJoint === 'root') k.pose.rootPos = [0, 0, 0];
    editorChanged();
  });
  resetRow.appendChild(reset);
  body.appendChild(resetRow);

  // 動き
  sec('動き');
  const loopRow = _el('label', 'scriptCheck');
  const loop = document.createElement('input');
  loop.type = 'checkbox'; loop.checked = !!b.loop;
  loop.addEventListener('change', () => { pushUndo(); b.loop = loop.checked; editorChanged(); });
  loopRow.appendChild(loop);
  loopRow.appendChild(document.createTextNode('くり返す(最初のキー〜最後のキーを何度も)'));
  body.appendChild(loopRow);

  const listEl = _el('div', 'keyList');
  b.keys.forEach((k, i) => {
    const r = _el('div', 'keyRow' + (b.id === selectedPoseId && i === poseSelKey ? ' active' : ''));
    r.appendChild(_el('span', 'keyRowLabel', `◆ キー${i + 1}`));
    const ti = document.createElement('input');
    ti.type = 'number'; ti.step = '0.1'; ti.className = 'panelInput small'; ti.value = k.time.toFixed(2);
    bindEditUndo(ti);
    ti.addEventListener('change', () => {
      let v = parseFloat(ti.value);
      if (isNaN(v)) return;
      const prev = b.keys[i - 1], next = b.keys[i + 1];
      k.time = Math.max(prev ? prev.time + 0.05 : -Infinity, Math.min(next ? next.time - 0.05 : Infinity, v));
      editorChanged();
    });
    r.appendChild(ti);
    r.appendChild(_el('span', 'fieldUnit', '秒'));
    if (b.keys.length > 1) {
      const del = _el('button', 'keyRowDel', '✕');
      del.title = 'このキーを削除';
      del.addEventListener('click', (e) => { e.stopPropagation(); pushUndo(); b.keys.splice(i, 1); poseSelKey = null; editorChanged(); });
      r.appendChild(del);
    }
    r.addEventListener('click', (e) => {
      if (e.target === ti) return;
      if (typeof stopPlayback === 'function') stopPlayback();
      seekTo(b.startTick + (k.time - b.offsetSec) * scTps());
      poseSelKey = i; poseSelKeyExplicit = true;
      editorChanged();
    });
    listEl.appendChild(r);
  });
  body.appendChild(listEl);

  const durRow = row('長さ');
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

  body.appendChild(_el('div', 'panelHint', 'リングをドラッグすると、再生ヘッドの時刻にキー(◆)が無ければ自動で作られます。' +
    '赤=前後、緑=ひねり、青=横。ひじ・ひざは曲げる向き(赤)だけです。全身を選ぶと、矢印で位置も動かせます(座る・寝るなど)。' +
    (b.target === 'puppet' ? '人形は Shift+矢印・Shift+緑のリングで、置き場所ごと動かせます。' : 'プレイヤーに付けた時は、ブロックの始めと終わりで元の姿勢となめらかにつながります。')));

  const actions = _el('div', 'panelActions');
  const save = _el('button', 'btn btn-ghost btn-sm', '⭐ このポーズの動きをカスタムに保存');
  save.addEventListener('click', () => savePoseAsCustom(b));
  actions.appendChild(save);
  const delBtn = _el('button', 'btn btn-ghost btn-sm dangerBtn', '🗑 このポーズを削除');
  delBtn.addEventListener('click', () => { selectPose(b.id); poseSelKeyExplicit = false; deleteSelection(); });
  actions.appendChild(delBtn);
  body.appendChild(actions);
}

// 関節の選択が変わった時に、パネルのボタンの見た目だけ直す
function refreshPosePanel() {
  if (!_posePanelJointGroup || !document.body.contains(_posePanelJointGroup)) return;
  for (const p of _posePanelJointGroup.children) p.classList.toggle('active', p.dataset.joint === poseSelJoint);
}


// ============================================================
// 公式のポーズ・カスタム
// ============================================================

const _PZ = poseFrom;
const OFFICIAL_POSES = [
  { id: 'puppet', icon: '🧸', label: '人形を出す', desc: 'まっすぐ立った人形', puppet: true, seconds: 3,
    keys: [{ time: 0, pose: _PZ() }] },
  { id: 'wave', icon: '👋', label: '手を振る', desc: '右手を上げて振る', loop: true, seconds: 3,
    keys: [
      { time: 0, pose: _PZ({ armR: [10, 0, 140], elbowR: [35, 0, 0], head: [0, 0, 5] }) },
      { time: 0.35, pose: _PZ({ armR: [10, 0, 165], elbowR: [5, 0, 0], head: [0, 0, 5] }) },
      { time: 0.7, pose: _PZ({ armR: [10, 0, 140], elbowR: [35, 0, 0], head: [0, 0, 5] }) },
    ] },
  { id: 'walk', icon: '🚶', label: '歩く', desc: '手足を交互に振る', loop: true, seconds: 4,
    keys: [
      { time: 0, pose: _PZ({ legR: [28, 0, 0], legL: [-28, 0, 0], kneeL: [25, 0, 0], armR: [-25, 0, 3], armL: [25, 0, 3], elbowR: [10, 0, 0], elbowL: [20, 0, 0] }) },
      { time: 0.5, pose: _PZ({ legR: [-28, 0, 0], legL: [28, 0, 0], kneeR: [25, 0, 0], armR: [25, 0, 3], armL: [-25, 0, 3], elbowR: [20, 0, 0], elbowL: [10, 0, 0] }) },
      { time: 1, pose: _PZ({ legR: [28, 0, 0], legL: [-28, 0, 0], kneeL: [25, 0, 0], armR: [-25, 0, 3], armL: [25, 0, 3], elbowR: [10, 0, 0], elbowL: [20, 0, 0] }) },
    ] },
  { id: 'run', icon: '🏃', label: '走る', desc: '前かがみで大きく振る', loop: true, seconds: 4,
    keys: [
      { time: 0, pose: _PZ({ body: [14, 0, 0], head: [-10, 0, 0], legR: [55, 0, 0], kneeR: [30, 0, 0], legL: [-40, 0, 0], kneeL: [85, 0, 0], armR: [-50, 0, 5], armL: [55, 0, 5], elbowR: [70, 0, 0], elbowL: [90, 0, 0], rootPos: [0, 0.08, 0] }) },
      { time: 0.3, pose: _PZ({ body: [14, 0, 0], head: [-10, 0, 0], legR: [-40, 0, 0], kneeR: [85, 0, 0], legL: [55, 0, 0], kneeL: [30, 0, 0], armR: [55, 0, 5], armL: [-50, 0, 5], elbowR: [90, 0, 0], elbowL: [70, 0, 0], rootPos: [0, 0.08, 0] }) },
      { time: 0.6, pose: _PZ({ body: [14, 0, 0], head: [-10, 0, 0], legR: [55, 0, 0], kneeR: [30, 0, 0], legL: [-40, 0, 0], kneeL: [85, 0, 0], armR: [-50, 0, 5], armL: [55, 0, 5], elbowR: [70, 0, 0], elbowL: [90, 0, 0], rootPos: [0, 0.08, 0] }) },
    ] },
  { id: 'cheer', icon: '🙌', label: 'バンザイ', desc: '両手を上げて跳ねる', loop: true, seconds: 3,
    keys: [
      { time: 0, pose: _PZ({ armR: [0, 0, 165], armL: [0, 0, 165], kneeR: [30, 0, 0], kneeL: [30, 0, 0], legR: [15, 0, 0], legL: [15, 0, 0], rootPos: [0, -0.06, 0] }) },
      { time: 0.3, pose: _PZ({ armR: [0, 0, 170], armL: [0, 0, 170], head: [-15, 0, 0], rootPos: [0, 0.45, 0] }) },
      { time: 0.6, pose: _PZ({ armR: [0, 0, 165], armL: [0, 0, 165], kneeR: [30, 0, 0], kneeL: [30, 0, 0], legR: [15, 0, 0], legL: [15, 0, 0], rootPos: [0, -0.06, 0] }) },
    ] },
  { id: 'dance', icon: '💃', label: 'ダンス', desc: '体をゆらして踊る', loop: true, seconds: 4,
    keys: [
      { time: 0, pose: _PZ({ body: [0, 15, 10], head: [0, -10, -8], armR: [30, 0, 100], elbowR: [70, 0, 0], armL: [-10, 0, 30], elbowL: [90, 0, 0], kneeR: [25, 0, 0], legR: [12, 0, 0] }) },
      { time: 0.5, pose: _PZ({ body: [0, -15, -10], head: [0, 10, 8], armL: [30, 0, 100], elbowL: [70, 0, 0], armR: [-10, 0, 30], elbowR: [90, 0, 0], kneeL: [25, 0, 0], legL: [12, 0, 0] }) },
      { time: 1, pose: _PZ({ body: [0, 15, 10], head: [0, -10, -8], armR: [30, 0, 100], elbowR: [70, 0, 0], armL: [-10, 0, 30], elbowL: [90, 0, 0], kneeR: [25, 0, 0], legR: [12, 0, 0] }) },
    ] },
  { id: 'bow', icon: '🙇', label: 'おじぎ', desc: 'ゆっくり頭を下げる', loop: false, seconds: 2,
    keys: [
      { time: 0, pose: _PZ() },
      { time: 0.5, pose: _PZ({ body: [45, 0, 0], head: [10, 0, 0], armR: [8, 0, 0], armL: [8, 0, 0] }) },
      { time: 1.2, pose: _PZ({ body: [45, 0, 0], head: [10, 0, 0], armR: [8, 0, 0], armL: [8, 0, 0] }) },
      { time: 1.8, pose: _PZ() },
    ] },
  { id: 'point', icon: '👉', label: '指さす', desc: '右手で前を指す', loop: false, seconds: 2,
    keys: [{ time: 0, pose: _PZ({ armR: [90, -10, 0], head: [0, -8, 0], body: [0, -8, 0] }) }] },
  { id: 'sit', icon: '🪑', label: '座る', desc: '地面に座る', loop: false, seconds: 3,
    keys: [{ time: 0, pose: _PZ({ legR: [85, 0, 4], legL: [85, 0, 4], kneeR: [15, 0, 0], kneeL: [15, 0, 0], armR: [-25, 0, 8], armL: [-25, 0, 8], body: [-8, 0, 0], rootPos: [0, -0.52, 0] }) }] },
  { id: 'sleep', icon: '😴', label: '寝る', desc: 'あお向けに寝ころぶ', loop: false, seconds: 3,
    keys: [{ time: 0, pose: _PZ({ root: [-90, 0, 0], armR: [0, 0, 25], armL: [0, 0, 25], rootPos: [0, -0.77, 0] }) }] },
];

const LS_CUSTOM_POSES = 'bloxdEditor.customPoses.v1';
let customPoses = (() => { try { return JSON.parse(localStorage.getItem(LS_CUSTOM_POSES) || '[]'); } catch (e) { return []; } })();
function _saveCustomPoses() { try { localStorage.setItem(LS_CUSTOM_POSES, JSON.stringify(customPoses)); } catch (e) { /* 保存できなくても続ける */ } }

function savePoseAsCustom(b) {
  // キーの時刻は、最初のキーを0にそろえて保存する
  const t0 = b.keys[0].time;
  customPoses.push({
    id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    label: b.name, icon: '⭐', loop: !!b.loop, seconds: +((b.endTick - b.startTick) / scTps()).toFixed(2),
    keys: b.keys.map(k => ({ time: +(k.time - t0).toFixed(3), pose: poseClone(k.pose) })),
    desc: `キー${b.keys.length}個` + (b.loop ? '・くり返し' : ''),
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
  list.appendChild(_div('assetHint', 'クリックすると、表示中のプレイヤー(右下で選んでいる人)に付きます。3D画面のプレイヤーの上にドラッグするとその人に、地面にドラッグするとそこに人形が出ます。' +
    '付けた後は、手足をクリックしてリングで曲げられます。'));
}
