// entities3d.js
// ============================================================
// シーンエディタ用の、地形以外の3Dオブジェクトとカメラのデータ:
//   - 人物モデル(灰色マネキン。プレイヤーテクスチャがあれば貼る)
//   - カメラ(🎥カメラトラックのブロック)のデータ。キーフレーム方式で、
//     キー1個=静的ショット、2個以上=動くショット(スプライン補間)
//   - カメラの描画(キーごとの箱・軌道・再生ヘッド時刻の視野枠)
//   - 移動ギズモ(XYZ矢印+XZ平面ハンドル)・回転ギズモ(左右/上下リング)
//     …選択中のキーにだけ表示。画面上で常に同じ大きさに見えるよう
//     距離に応じて拡大縮小し、マウスが乗った部分は光らせる。
// ============================================================

// 人物モデルのパーツ定義(ローカル座標。足元がy=0、yaw=0で+z方向を向く)。
const HUMANOID_PARTS = [
  { center: [0, 1.55, 0],   size: [0.5, 0.5, 0.5] },   // 頭
  { center: [0, 1.0, 0],    size: [0.5, 0.75, 0.28] }, // 胴
  { center: [-0.375, 1.0, 0], size: [0.25, 0.75, 0.25] }, // 右腕
  { center: [0.375, 1.0, 0],  size: [0.25, 0.75, 0.25] }, // 左腕
  { center: [-0.14, 0.325, 0], size: [0.25, 0.65, 0.25] }, // 右脚
  { center: [0.14, 0.325, 0],  size: [0.25, 0.65, 0.25] }, // 左脚
];

let humanoidVertexData = null;
let humanoidVertexCount = 0;
const ENT3D_CORNER_UV = [[0, 1], [1, 1], [1, 0], [0, 0]];

function buildHumanoidVertexData() {
  const verts = [];
  const order = [0, 1, 2, 0, 2, 3];
  for (const part of HUMANOID_PARTS) {
    const [cx, cy, cz] = part.center;
    const [sx, sy, sz] = part.size;
    for (let dirCode = 0; dirCode < 6; dirCode++) {
      const offsets = FACE_OFFSETS[dirCode];
      const brightness = DIR_FACTOR[dirCode];
      for (const oi of order) {
        const [ox, oy, oz] = offsets[oi];
        const lx = cx + (ox - 0.5) * sx;
        const ly = cy + (oy - 0.5) * sy;
        const lz = cz + (oz - 0.5) * sz;
        const [u, v] = ENT3D_CORNER_UV[oi];
        verts.push(lx, ly, lz, brightness, u, v);
      }
    }
  }
  humanoidVertexData = new Float32Array(verts);
  humanoidVertexCount = verts.length / 6;
}

// カメラギズモ本体(箱+レンズ)。yaw=0で+z方向(レンズが+z側)を向く。
const CAMERA_GIZMO_PARTS = [
  { center: [0, 0, 0],     size: [0.5, 0.4, 0.35] },
  { center: [0, 0, 0.32],  size: [0.22, 0.22, 0.3] },
];
let gizmoVertexData = null;
let gizmoVertexCount = 0;

function buildGizmoVertexData() {
  const verts = [];
  const order = [0, 1, 2, 0, 2, 3];
  for (const part of CAMERA_GIZMO_PARTS) {
    const [cx, cy, cz] = part.center;
    const [sx, sy, sz] = part.size;
    for (let dirCode = 0; dirCode < 6; dirCode++) {
      const offsets = FACE_OFFSETS[dirCode];
      const brightness = DIR_FACTOR[dirCode];
      for (const oi of order) {
        const [ox, oy, oz] = offsets[oi];
        const lx = cx + (ox - 0.5) * sx;
        const ly = cy + (oy - 0.5) * sy;
        const lz = cz + (oz - 0.5) * sz;
        verts.push(lx, ly, lz, brightness, 0, 0);
      }
    }
  }
  gizmoVertexData = new Float32Array(verts);
  gizmoVertexCount = verts.length / 6;
}


// ============================================================
// シェーダー
// ============================================================

const ENT3D_VERTEX_SRC = `
  attribute vec3 aPos;
  attribute float aBrightness;
  attribute vec2 aUV;
  uniform mat4 uView;
  uniform mat4 uProj;
  uniform mat4 uModel;
  varying float vBrightness;
  varying vec2 vUV;
  void main() {
    gl_Position = uProj * uView * uModel * vec4(aPos, 1.0);
    vBrightness = aBrightness;
    vUV = aUV;
  }
`;
const ENT3D_FRAGMENT_SRC = `
  precision mediump float;
  uniform vec3 uTint;
  uniform float uUseTexture;
  uniform sampler2D uTexture;
  varying float vBrightness;
  varying vec2 vUV;
  void main() {
    vec3 base = uUseTexture > 0.5 ? texture2D(uTexture, vUV).rgb : vec3(1.0);
    gl_FragColor = vec4(base * uTint * vBrightness, 1.0);
  }
`;
const ENT3D_LINE_VERTEX_SRC = `
  attribute vec3 aPos;
  uniform mat4 uView;
  uniform mat4 uProj;
  void main() { gl_Position = uProj * uView * vec4(aPos, 1.0); gl_PointSize = 6.0; }
`;
const ENT3D_LINE_FRAGMENT_SRC = `
  precision mediump float;
  uniform vec3 uTint;
  void main() { gl_FragColor = vec4(uTint, 0.95); }
`;
// 太さのある線(ギズモの矢印・リング)用。gl.lineWidth()は環境によって
// ほぼ無視される(多くのブラウザ/GPUで1pxに固定される)ため、線分ごとに
// 画面ピクセル空間で「常に一定の太さに見える板」を三角形2枚で組み立てて
// 描く方式にしてある(3D的な奥行きは持たず、そのまま画面に貼り付ける)。
const ENT3D_THICKLINE_VERTEX_SRC = `
  attribute vec2 aPos;
  void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;
const ENT3D_THICKLINE_FRAGMENT_SRC = `
  precision mediump float;
  uniform vec3 uTint;
  void main() { gl_FragColor = vec4(uTint, 0.95); }
`;

let ent3dProgram = null, ent3dVbo = null;
let ent3dAPosLoc, ent3dABrightnessLoc, ent3dAUVLoc, ent3dUViewLoc, ent3dUProjLoc, ent3dUModelLoc, ent3dUTintLoc, ent3dUUseTextureLoc, ent3dUTextureLoc;
let lineProgram = null, lineVbo = null;
let lineAPosLoc, lineUViewLoc, lineUProjLoc, lineUTintLoc;
let thickLineProgram = null, thickLineVbo = null, thickLineAPosLoc, thickLineUTintLoc;

let humanoidTextureGL = null;

function ent3dCompileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('entities3dシェーダーのコンパイルに失敗しました: ' + info);
  }
  return s;
}

function initEntities3D(gl) {
  if (ent3dProgram) return;

  const vs = ent3dCompileShader(gl, gl.VERTEX_SHADER, ENT3D_VERTEX_SRC);
  const fs = ent3dCompileShader(gl, gl.FRAGMENT_SHADER, ENT3D_FRAGMENT_SRC);
  ent3dProgram = gl.createProgram();
  gl.attachShader(ent3dProgram, vs); gl.attachShader(ent3dProgram, fs);
  gl.linkProgram(ent3dProgram);
  if (!gl.getProgramParameter(ent3dProgram, gl.LINK_STATUS)) {
    throw new Error('entities3dプログラムのリンクに失敗しました: ' + gl.getProgramInfoLog(ent3dProgram));
  }
  ent3dAPosLoc = gl.getAttribLocation(ent3dProgram, 'aPos');
  ent3dABrightnessLoc = gl.getAttribLocation(ent3dProgram, 'aBrightness');
  ent3dAUVLoc = gl.getAttribLocation(ent3dProgram, 'aUV');
  ent3dUViewLoc = gl.getUniformLocation(ent3dProgram, 'uView');
  ent3dUProjLoc = gl.getUniformLocation(ent3dProgram, 'uProj');
  ent3dUModelLoc = gl.getUniformLocation(ent3dProgram, 'uModel');
  ent3dUTintLoc = gl.getUniformLocation(ent3dProgram, 'uTint');
  ent3dUUseTextureLoc = gl.getUniformLocation(ent3dProgram, 'uUseTexture');
  ent3dUTextureLoc = gl.getUniformLocation(ent3dProgram, 'uTexture');

  const lvs = ent3dCompileShader(gl, gl.VERTEX_SHADER, ENT3D_LINE_VERTEX_SRC);
  const lfs = ent3dCompileShader(gl, gl.FRAGMENT_SHADER, ENT3D_LINE_FRAGMENT_SRC);
  lineProgram = gl.createProgram();
  gl.attachShader(lineProgram, lvs); gl.attachShader(lineProgram, lfs);
  gl.linkProgram(lineProgram);
  lineAPosLoc = gl.getAttribLocation(lineProgram, 'aPos');
  lineUViewLoc = gl.getUniformLocation(lineProgram, 'uView');
  lineUProjLoc = gl.getUniformLocation(lineProgram, 'uProj');
  lineUTintLoc = gl.getUniformLocation(lineProgram, 'uTint');

  ent3dVbo = gl.createBuffer();
  lineVbo = gl.createBuffer();

  const tlvs = ent3dCompileShader(gl, gl.VERTEX_SHADER, ENT3D_THICKLINE_VERTEX_SRC);
  const tlfs = ent3dCompileShader(gl, gl.FRAGMENT_SHADER, ENT3D_THICKLINE_FRAGMENT_SRC);
  thickLineProgram = gl.createProgram();
  gl.attachShader(thickLineProgram, tlvs); gl.attachShader(thickLineProgram, tlfs);
  gl.linkProgram(thickLineProgram);
  thickLineAPosLoc = gl.getAttribLocation(thickLineProgram, 'aPos');
  thickLineUTintLoc = gl.getUniformLocation(thickLineProgram, 'uTint');
  thickLineVbo = gl.createBuffer();

  buildHumanoidVertexData();
  buildGizmoVertexData();
}

function setPlayerTexture(gl, image) {
  if (!image) {
    if (humanoidTextureGL) gl.deleteTexture(humanoidTextureGL);
    humanoidTextureGL = null;
    return;
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (humanoidTextureGL) gl.deleteTexture(humanoidTextureGL);
  humanoidTextureGL = tex;
}


// ============================================================
// 行列ユーティリティ(4x4、列優先。freecam.jsの視点行列と同じ流儀)
// ============================================================

function mat4Translate(x, y, z) { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]); }
function mat4RotateY(yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
}
function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k*4+row] * b[col*4+k];
      out[col*4+row] = sum;
    }
  }
  return out;
}
function modelMatrixYaw(x, y, z, yaw) { return mat4Multiply(mat4Translate(x, y, z), mat4RotateY(yaw)); }


// ============================================================
// 描画: 人物モデル
// ============================================================

function renderHumanoids(gl, viewMatrix, projMatrix, tick) {
  if (!ent3dProgram || !allTimelines || !allTimelines.entities) return;
  gl.useProgram(ent3dProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, ent3dVbo);
  gl.bufferData(gl.ARRAY_BUFFER, humanoidVertexData, gl.STATIC_DRAW);
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

  for (const eid in allTimelines.entities) {
    const ent = allTimelines.entities[eid];
    const frame = nearestFrameAtOrBefore(ent.frames, tick);
    if (!frame || !frame.position) continue;
    const x = frame.position[0] - worldOriginX;
    const y = frame.position[1] - worldOriginY;
    const z = frame.position[2] - worldOriginZ;
    const yaw = (frame.rotation && frame.rotation.length > 1) ? frame.rotation[1] : 0;

    const model = modelMatrixYaw(x, y, z, yaw);
    gl.uniformMatrix4fv(ent3dUModelLoc, false, model);
    if (humanoidTextureGL) {
      gl.uniform3f(ent3dUTintLoc, 1, 1, 1);
    } else {
      const isLocalPlayer = (eid === allTimelines.localPlayerEntityId);
      gl.uniform3f(ent3dUTintLoc, isLocalPlayer ? 0.85 : 0.6, isLocalPlayer ? 0.85 : 0.6, isLocalPlayer ? 0.9 : 0.62);
    }
    gl.drawArrays(gl.TRIANGLES, 0, humanoidVertexCount);
  }
}

function nearestFrameAtOrBefore(frames, tick) {
  if (!frames || frames.length === 0) return null;
  if (tick <= frames[0].tick) return frames[0];
  if (tick >= frames[frames.length - 1].tick) return frames[frames.length - 1];
  let lo = 0, hi = frames.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].tick <= tick) lo = mid; else hi = mid;
  }
  return frames[lo];
}


// ============================================================
// 配置済みカメラ = 🎥カメラトラックのブロック(キーフレーム方式)
//
// { id, kind:'camera', name, keys:[{time,pos,yaw,pitch}], fov, startTick, endTick, layer, display }
//   keys: 「ブロックの先頭(startTick)からの秒数」ごとのカメラ位置・向き。
//         1個なら静的ショット、2個以上なら動くショット(間をスプライン補間)。
//         常にtimeの昇順に並べておく。ブロック左端を詰めた(トリム)時に
//         負の時刻になることもある(評価時は端の値にクランプする)。
//   layer: 0が一番奥(背景)、大きいほど手前(PinP合成時に前面に出る)。
//   display: 書き出す映像の中での表示位置。null=自動(一番奥のカメラが全画面、
//            手前のカメラは右上に小窓)。{x,y,w} は枠の左上の位置と幅(0〜1の割合)。
//            小窓も書き出す映像と同じ縦横比なので、高さの割合は幅と同じ。
//
// ここはデータの操作だけを持つ。選択状態の切り替え・Undo・画面更新は
// editor-core.js が担当する(選択中のIDの変数だけは描画でも使うのでここに置く)。
// ============================================================

const DEFAULT_BLOCK_SECONDS = 3;   // 新しいカメラの長さ
const KEY_SNAP_SECONDS = 0.1;      // この差以内に既存キーがあれば、新規ではなく上書きにする

let sceneCameras = [];
let selectedCameraId = null;
let selectedKeyIndex = null;       // 選択中カメラのどのキーがギズモの操作対象か
let selectedKeyExplicit = false;   // ◆やギズモを直接クリックして選んだキーか(Deleteでキーだけ消すか判断に使う)
let nextSceneCameraId = 1;

function scTps() {
  return (typeof allTimelines !== 'undefined' && allTimelines && allTimelines.ticksPerSecond) || 30;
}
function scMaxTick() {
  return (timeline && timeline.frames && timeline.frames.length) ? timeline.frames.length - 1 : 0;
}

function _clonePose(p) { return { pos: p.pos.slice(), yaw: p.yaw, pitch: p.pitch }; }

function scCamIsStatic(cam) { return cam.keys.length <= 1; }
function scKeyAbsTick(cam, key) { return cam.startTick + key.time * scTps(); }
function scCamLocalSeconds(cam, tick) { return (tick - cam.startTick) / scTps(); }
function scCamName(cam) { return cam.name || ('カメラ' + cam.id); }

// lengthSeconds を省略すると DEFAULT_BLOCK_SECONDS
function scCreateCamera(pose, fov, startTick, lengthSeconds) {
  const tps = scTps();
  const maxTick = scMaxTick();
  let start = Math.max(0, Math.round(startTick));
  if (maxTick > 0) start = Math.min(start, Math.max(0, maxTick - 1));
  let end = start + Math.round(tps * (lengthSeconds || DEFAULT_BLOCK_SECONDS));
  if (maxTick > 0) end = Math.min(end, maxTick);
  const id = nextSceneCameraId++;
  const cam = {
    id, kind: 'camera', name: 'カメラ' + id,
    keys: [{ time: 0, ..._clonePose(pose) }],
    fov, startTick: start, endTick: Math.max(end, start + 1), layer: 0, display: null,
  };
  cam.layer = scFindFreeLayerFrom(0, cam.startTick, cam.endTick, cam.id);
  sceneCameras.push(cam);
  return cam;
}

function _cloneDisplay(d) { return d ? { x: d.x, y: d.y, w: d.w } : null; }

function scGetCamera(id) { return sceneCameras.find(c => c.id === id) || null; }
function scGetSelected() { return scGetCamera(selectedCameraId); }

// 今ギズモで動かす対象のキー(pos/yaw/pitchを持つオブジェクトそのもの)
function scGetActivePoint() {
  const cam = scGetSelected();
  if (!cam || !cam.keys.length) return null;
  const i = (selectedKeyIndex == null) ? 0 : Math.max(0, Math.min(cam.keys.length - 1, selectedKeyIndex));
  return cam.keys[i];
}

// 再生ヘッドに一番近いキーの番号
function scNearestKeyIndex(cam, tick) {
  const s = scCamLocalSeconds(cam, tick);
  let best = 0, bestD = Infinity;
  cam.keys.forEach((k, i) => { const d = Math.abs(k.time - s); if (d < bestD) { bestD = d; best = i; } });
  return best;
}

function scSortKeys(cam) { cam.keys.sort((a, b) => a.time - b.time); }

// ブロックの範囲に、指定した絶対tickが入るよう伸ばす(キーの絶対時刻は保つ)
function _extendCamToInclude(cam, absTick) {
  const maxTick = scMaxTick();
  const t = Math.max(0, maxTick > 0 ? Math.min(maxTick, absTick) : absTick);
  if (t < cam.startTick) {
    const shiftSec = (cam.startTick - t) / scTps();
    for (const k of cam.keys) k.time += shiftSec;
    cam.startTick = t;
  }
  if (t >= cam.endTick) cam.endTick = Math.min(maxTick > 0 ? maxTick : t + 1, t + 1);
}

// 指定した秒数(ブロック先頭からの)にキーを記録する。近くに既存キーがあれば上書き。
// 戻り値: { index, created }
function scSetKeyAt(cam, seconds, pose) {
  const existing = cam.keys.findIndex(k => Math.abs(k.time - seconds) <= KEY_SNAP_SECONDS);
  if (existing >= 0) {
    const k = cam.keys[existing];
    k.pos = pose.pos.slice(); k.yaw = pose.yaw; k.pitch = pose.pitch;
    return { index: existing, created: false };
  }
  const key = { time: seconds, ..._clonePose(pose) };
  cam.keys.push(key);
  scSortKeys(cam);
  _extendCamToInclude(cam, cam.startTick + seconds * scTps());
  return { index: cam.keys.indexOf(key), created: true };
}

// 指定tickに一番近い(KEY_SNAP_SECONDS以内の)キーの番号。無ければ -1
function scKeyIndexAtTick(cam, tick) {
  const s = scCamLocalSeconds(cam, tick);
  return cam.keys.findIndex(k => Math.abs(k.time - s) <= KEY_SNAP_SECONDS);
}

// 再生ヘッドの時刻の位置・向きを書き換える(右パネルの数値編集で使う)。
// その時刻にキーが無ければ、今の補間結果を元にキーを自動で作ってから書き換える。
// patch: { pos?, yaw?, pitch? }  戻り値: { index, created, seconds }
function scEditPoseAtTick(cam, tick, patch) {
  const lenSec = (cam.endTick - cam.startTick) / scTps();
  const s = Math.max(0, Math.min(lenSec, scCamLocalSeconds(cam, tick)));
  let index = cam.keys.findIndex(k => Math.abs(k.time - s) <= KEY_SNAP_SECONDS);
  let created = false;
  if (index < 0) {
    index = scSetKeyAt(cam, s, scEvalCamera(cam, s)).index;
    created = true;
  }
  const k = cam.keys[index];
  if (patch.pos) k.pos = patch.pos.slice();
  if (patch.yaw != null) k.yaw = patch.yaw;
  if (patch.pitch != null) k.pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, patch.pitch));
  return { index, created, seconds: s };
}

// 表示位置({x,y,w})を枠の中に収まるよう整える
function scClampDisplay(d) {
  const w = Math.max(0.1, Math.min(1, d.w));
  return { w, x: Math.max(0, Math.min(1 - w, d.x)), y: Math.max(0, Math.min(1 - w, d.y)) };
}

function scDeleteKey(cam, index) {
  if (cam.keys.length <= 1) return false;
  cam.keys.splice(index, 1);
  return true;
}

function scDeleteCamera(id) {
  sceneCameras = sceneCameras.filter(c => c.id !== id);
  scCompactLayers();
}

// 再生ヘッドの位置でブロックを2つに割る(切れ目では同じ構図が続くようにする)
function scSplitCamera(cam, tick) {
  if (tick <= cam.startTick || tick >= cam.endTick) return null;
  const s = scCamLocalSeconds(cam, tick);
  const pose = scEvalCamera(cam, s);
  const id = nextSceneCameraId++;
  let leftKeys, rightKeys;
  if (scCamIsStatic(cam)) {
    leftKeys = cam.keys.map(k => ({ ...k, pos: k.pos.slice() }));
    rightKeys = cam.keys.map(k => ({ ...k, time: 0, pos: k.pos.slice() }));
  } else {
    const eps = 0.02;
    leftKeys = cam.keys.filter(k => k.time < s - eps).map(k => ({ ...k, pos: k.pos.slice() }));
    leftKeys.push({ time: s, ..._clonePose(pose) });
    rightKeys = [{ time: 0, ..._clonePose(pose) }];
    for (const k of cam.keys) if (k.time > s + eps) rightKeys.push({ ...k, time: k.time - s, pos: k.pos.slice() });
  }
  const right = {
    id, kind: 'camera', name: 'カメラ' + id, keys: rightKeys, fov: cam.fov,
    startTick: tick, endTick: cam.endTick, layer: cam.layer, display: _cloneDisplay(cam.display),
  };
  cam.keys = leftKeys;
  cam.endTick = tick;
  sceneCameras.push(right);
  return right;
}

// すぐ後ろに複製を置く
function scDuplicateCamera(cam) {
  const len = cam.endTick - cam.startTick;
  const maxTick = scMaxTick();
  let start = cam.endTick;
  if (maxTick > 0 && start + len > maxTick) start = Math.max(0, maxTick - len);
  const id = nextSceneCameraId++;
  const dup = {
    id, kind: 'camera', name: 'カメラ' + id,
    keys: cam.keys.map(k => ({ ...k, pos: k.pos.slice() })),
    fov: cam.fov, startTick: start, endTick: start + len, layer: cam.layer, display: _cloneDisplay(cam.display),
  };
  dup.layer = scFindFreeLayerFrom(cam.layer, dup.startTick, dup.endTick, dup.id);
  sceneCameras.push(dup);
  return dup;
}


// ============================================================
// タイムライン: 開始/終了tickの重なり判定・層(レイヤー)の自動割り当て
// ============================================================

function scRangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// startLayerから昇順に、指定した時間範囲と重ならない最初の層を探す
function scFindFreeLayerFrom(startLayer, startTick, endTick, excludeId) {
  let layer = Math.max(0, startLayer);
  for (;;) {
    const conflict = sceneCameras.some(c =>
      c.id !== excludeId && c.layer === layer && scRangesOverlap(c.startTick, c.endTick, startTick, endTick));
    if (!conflict) return layer;
    layer++;
  }
}

// 使われている層番号を0からの連番に詰め直す(ドラッグでできた空の層を消す)
function scCompactLayers() {
  const used = [...new Set(sceneCameras.map(c => c.layer))].sort((a, b) => a - b);
  const remap = new Map(used.map((l, i) => [l, i]));
  for (const c of sceneCameras) c.layer = remap.get(c.layer);
}

// 指定tickの時点で表示されているべきカメラを、奥(layer小)→手前(layer大)の順で返す
function scActiveCamerasAtTick(tick) {
  return sceneCameras
    .filter(c => tick >= c.startTick && tick < c.endTick)
    .sort((a, b) => a.layer - b.layer);
}

// 全カメラのキーを、クリック選択用に平らなリストにする
function scAllPoints() {
  const out = [];
  for (const cam of sceneCameras) {
    cam.keys.forEach((k, i) => out.push({ camId: cam.id, keyIndex: i, pos: k.pos, yaw: k.yaw, pitch: k.pitch }));
  }
  return out;
}


// ============================================================
// スプライン補間(Catmull-Rom)。動くショットの、キー間のなめらかな軌道。
// ============================================================

function catmullRom1D(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2*p0 - 5*p1 + 4*p2 - p3) * t2 + (-p0 + 3*p1 - 3*p2 + p3) * t3);
}
function catmullRomPos(positions, i, t) {
  const p0 = positions[Math.max(0, i - 1)];
  const p1 = positions[i];
  const p2 = positions[i + 1];
  const p3 = positions[Math.min(positions.length - 1, i + 2)];
  return [0, 1, 2].map(k => catmullRom1D(p0[k], p1[k], p2[k], p3[k], t));
}

// 指定した秒数(ブロック先頭から)における位置・向き。範囲外は端のキーにクランプ。
function scEvalCamera(cam, time) {
  const ks = cam.keys;
  const first = ks[0], last = ks[ks.length - 1];
  if (ks.length === 1 || time <= first.time) return _clonePose(first);
  if (time >= last.time) return _clonePose(last);

  let i = 0;
  while (i < ks.length - 2 && time > ks[i + 1].time) i++;
  const a = ks[i], b = ks[i + 1];
  const span = (b.time - a.time) || 1;
  const t = Math.max(0, Math.min(1, (time - a.time) / span));

  const pos = catmullRomPos(ks.map(k => k.pos), i, t);
  const dyaw = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)); // 最短経路で回る
  return { pos, yaw: a.yaw + dyaw * t, pitch: a.pitch + (b.pitch - a.pitch) * t };
}

function scPoseAtTick(cam, tick) { return scEvalCamera(cam, scCamLocalSeconds(cam, tick)); }

// 軌道を描画用にサンプリングする(見た目のガイド線用)
function scSampleCameraCurve(cam, samplesPerSegment) {
  const ks = cam.keys;
  if (ks.length < 2) return [];
  const positions = ks.map(k => k.pos);
  const pts = [];
  for (let i = 0; i < ks.length - 1; i++) {
    for (let s = 0; s <= samplesPerSegment; s++) {
      if (i > 0 && s === 0) continue; // 継ぎ目の重複を避ける
      pts.push(catmullRomPos(positions, i, s / samplesPerSegment));
    }
  }
  return pts;
}


// ============================================================
// 画面上で一定の大きさに見せるための倍率
// (遠くのカメラでもギズモが小さくなりすぎず、近くでも画面を覆わない)
// ============================================================

function worldUnitsPerPixelAt(pos) {
  if (typeof fcCanvas === 'undefined' || !fcCanvas) return 0.02;
  const dx = pos[0] - fcPos[0], dy = pos[1] - fcPos[1], dz = pos[2] - fcPos[2];
  const dist = Math.max(0.5, Math.hypot(dx, dy, dz));
  return 2 * dist * Math.tan(fcFovDeg * Math.PI / 360) / Math.max(1, fcCanvas.height);
}

const GIZMO_TARGET_ARROW_PX = 110; // 矢印の長さの見た目(画面ピクセル)
function gizmoScaleAt(pos) { return GIZMO_TARGET_ARROW_PX * worldUnitsPerPixelAt(pos) / GIZMO_ARROW_LEN; }


// ============================================================
// 描画: カメラ(キーごとの箱+レンズ・軌道・再生ヘッド位置の視野枠)
// ============================================================

const GIZMO_PATH_COLOR = [0.92, 0.85, 0.3];
const CAM_COLOR_IDLE = [0.24, 0.81, 0.56];
const CAM_COLOR_SELECTED = [0.9, 0.62, 0.22];
const CAM_COLOR_ACTIVE_KEY = [1.0, 0.86, 0.3];
const FRUSTUM_COLOR = [0.95, 0.95, 0.95];

function mat4RotateX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
}
function mat4Scale(s) { return new Float32Array([s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]); }
function modelMatrixPose(pos, yaw, pitch, scale) {
  return mat4Multiply(mat4Multiply(mat4Translate(pos[0], pos[1], pos[2]), mat4RotateY(yaw)),
                      mat4Multiply(mat4RotateX(-pitch), mat4Scale(scale)));
}

function _bindGizmoMesh(gl, viewMatrix, projMatrix) {
  gl.useProgram(ent3dProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, ent3dVbo);
  gl.bufferData(gl.ARRAY_BUFFER, gizmoVertexData, gl.STATIC_DRAW);
  const stride = 24;
  gl.enableVertexAttribArray(ent3dAPosLoc);
  gl.vertexAttribPointer(ent3dAPosLoc, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(ent3dABrightnessLoc);
  gl.vertexAttribPointer(ent3dABrightnessLoc, 1, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(ent3dAUVLoc);
  gl.vertexAttribPointer(ent3dAUVLoc, 2, gl.FLOAT, false, stride, 16);
  gl.uniform1f(ent3dUUseTextureLoc, 0.0);
  gl.uniformMatrix4fv(ent3dUViewLoc, false, viewMatrix);
  gl.uniformMatrix4fv(ent3dUProjLoc, false, projMatrix);
}

// 箱が遠くで米粒にならないよう、画面上で最低18px程度に見える倍率にする
function _camBoxScale(pos) { return Math.max(1, 18 * worldUnitsPerPixelAt(pos) / 0.5); }

// 今の視点のすぐ近く(=自分の目の位置)にあるキーか。
// F/Kは「今いる場所」にカメラを置くので、置いた直後はカメラの箱やギズモの
// 中に自分が入ってしまい、画面が箱の色で埋まる。近すぎるものは描かない。
const NEAR_EYE_DIST = 1.6;
function isNearEye(pos) {
  if (typeof fcPos === 'undefined') return false;
  return Math.hypot(pos[0] - fcPos[0], pos[1] - fcPos[1], pos[2] - fcPos[2]) < NEAR_EYE_DIST;
}

// opts.hideCamId: カメラ視点モード中など、描かないカメラ
function renderCameraGizmos(gl, viewMatrix, projMatrix, canvasW, canvasH, opts) {
  if (!ent3dProgram || sceneCameras.length === 0) return;
  const hideId = opts && opts.hideCamId;

  _bindGizmoMesh(gl, viewMatrix, projMatrix);
  for (const cam of sceneCameras) {
    if (cam.id === hideId) continue;
    const isSel = cam.id === selectedCameraId;
    cam.keys.forEach((k, i) => {
      if (isNearEye(k.pos)) return;
      gl.uniformMatrix4fv(ent3dUModelLoc, false, modelMatrixPose(k.pos, k.yaw, k.pitch, _camBoxScale(k.pos)));
      const c = isSel ? (i === selectedKeyIndex ? CAM_COLOR_ACTIVE_KEY : CAM_COLOR_SELECTED) : CAM_COLOR_IDLE;
      gl.uniform3f(ent3dUTintLoc, c[0], c[1], c[2]);
      gl.drawArrays(gl.TRIANGLES, 0, gizmoVertexCount);
    });
  }

  // 動くショットは、キーを繋ぐ軌道もガイドとして描く
  for (const cam of sceneCameras) {
    if (cam.id === hideId || scCamIsStatic(cam)) continue;
    const curve = scSampleCameraCurve(cam, 12);
    const pairs = [];
    for (let i = 0; i < curve.length - 1; i++) pairs.push(curve[i], curve[i + 1]);
    const col = cam.id === selectedCameraId ? GIZMO_PATH_COLOR : [0.55, 0.6, 0.5];
    _drawLineSegments(gl, viewMatrix, projMatrix, pairs, col, canvasW, canvasH, 2.5);
  }

  // 選択中のカメラは、「再生ヘッドの時刻に実際どこから・どちらを向いて
  // 撮っているか」を視野枠(四角錐)で見せる
  const sel = scGetSelected();
  const selPose = sel ? scPoseAtTick(sel, curTick) : null;
  if (sel && sel.id !== hideId && !isNearEye(selPose.pos)) {
    const pose = selPose;
    _drawLineSegments(gl, viewMatrix, projMatrix, frustumSegments(pose, sel.fov), FRUSTUM_COLOR, canvasW, canvasH, 2);
  }
}

function frustumSegments(pose, fovDeg) {
  const { forward, right, up } = fcGetCameraVectors(pose.yaw, pose.pitch);
  const depth = 70 * worldUnitsPerPixelAt(pose.pos);
  const aspect = (typeof getOutputAspect === 'function') ? getOutputAspect() : 16 / 9;
  const h = depth * Math.tan(fovDeg * Math.PI / 360), w = h * aspect;
  const p = pose.pos;
  const corner = (sx, sy) => [0, 1, 2].map(i => p[i] + forward[i] * depth + right[i] * w * sx + up[i] * h * sy);
  const tl = corner(-1, 1), tr = corner(1, 1), br = corner(1, -1), bl = corner(-1, -1);
  const tip = [0, 1, 2].map(i => p[i] + forward[i] * depth + up[i] * h * 1.45); // 上向きの目印
  return [p, tl, p, tr, p, br, p, bl, tl, tr, tr, br, br, bl, bl, tl,
          [0,1,2].map(i => tl[i] * 0.7 + tr[i] * 0.3), tip, tip, [0,1,2].map(i => tl[i] * 0.3 + tr[i] * 0.7)];
}

// 画面クリックでのギズモ選択用: 3D位置をスクリーン座標に投影する。
function projectToScreen(pos, viewMatrix, projMatrix, canvasWidth, canvasHeight) {
  const vp = mat4Multiply(projMatrix, viewMatrix);
  const x = pos[0]*vp[0] + pos[1]*vp[4] + pos[2]*vp[8] + vp[12];
  const y = pos[0]*vp[1] + pos[1]*vp[5] + pos[2]*vp[9] + vp[13];
  const w = pos[0]*vp[3] + pos[1]*vp[7] + pos[2]*vp[11] + vp[15];
  if (w <= 0.001) return null; // カメラの後ろ
  const ndcX = x / w, ndcY = y / w;
  return {
    x: (ndcX * 0.5 + 0.5) * canvasWidth,
    y: (1.0 - (ndcY * 0.5 + 0.5)) * canvasHeight,
  };
}

// クリック位置に一番近いカメラのキー(無ければnull)。hideCamIdのカメラは対象外。
function pickCameraGizmo(clickX, clickY, viewMatrix, projMatrix, canvasWidth, canvasHeight, hideCamId) {
  let best = null, bestDist = 26;
  for (const p of scAllPoints()) {
    if (p.camId === hideCamId || isNearEye(p.pos)) continue;
    const screen = projectToScreen(p.pos, viewMatrix, projMatrix, canvasWidth, canvasHeight);
    if (!screen) continue;
    const d = Math.hypot(screen.x - clickX, screen.y - clickY);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best; // { camId, keyIndex, pos } | null
}


// ============================================================
// 移動ギズモ(XYZ矢印+XZ平面ハンドル)・回転ギズモ(左右/上下リング)
// 画面上で常に同じ大きさ(gizmoScaleAt)で描き、マウスが乗った部分は光らせる。
// ============================================================

const GIZMO_ARROW_LEN = 2.6;
const GIZMO_ARROW_START = 0.55;
const GIZMO_PLANE_OFFSET = 0.8;
const GIZMO_PLANE_SIZE = 0.55;
const GIZMO_RING_RADIUS = 2.2;
const GIZMO_RING_SEGMENTS = 48;
const GIZMO_LINE_WIDTH_PX = 3.5; // ギズモの線の太さ(画面ピクセル単位)

const GIZMO_AXIS_COLOR = { x: [0.92, 0.28, 0.28], y: [0.32, 0.85, 0.4], z: [0.32, 0.56, 0.95] };
const GIZMO_PLANE_COLOR = [0.92, 0.85, 0.3];
const GIZMO_RING_COLOR = { yaw: [0.91, 0.64, 0.24], pitch: [0.55, 0.5, 0.91] };

let gizmoHoverPart = null; // マウスが乗っているギズモの部分(freecam.jsが更新する)

function _axisVec(axis) { return axis === 'x' ? [1,0,0] : axis === 'y' ? [0,1,0] : [0,0,1]; }

// 軸1本ぶんの線分(本体+矢じり)。2点ごとに1本の線分、という並び。
function gizmoAxisPoints(center, axis, s) {
  const d = _axisVec(axis);
  const st = center.map((v, i) => v + d[i] * GIZMO_ARROW_START * s);
  const e = center.map((v, i) => v + d[i] * GIZMO_ARROW_LEN * s);
  const pts = [st, e];
  const perp1 = axis === 'x' ? [0,1,0] : [1,0,0];
  const perp2 = axis === 'z' ? [0,1,0] : [0,0,1];
  const back = e.map((v, i) => v - d[i] * 0.35 * s);
  const head = (perp) => back.map((v, i) => v + perp[i] * 0.16 * s);
  pts.push(e, head(perp1), e, head(perp1.map(v => -v)), e, head(perp2), e, head(perp2.map(v => -v)));
  return pts;
}

// XZ平面ハンドル(正方形の枠、4辺=4線分)
function gizmoPlaneHandlePoints(center, s) {
  const o = GIZMO_PLANE_OFFSET * s, w = GIZMO_PLANE_SIZE * s;
  const c = [
    [center[0]+o, center[1], center[2]+o],
    [center[0]+o+w, center[1], center[2]+o],
    [center[0]+o+w, center[1], center[2]+o+w],
    [center[0]+o, center[1], center[2]+o+w],
  ];
  return [c[0],c[1], c[1],c[2], c[2],c[3], c[3],c[0]];
}

// 左右の向き(yaw)リング: centerを通る水平円
function gizmoYawRingPoints(center, s) {
  const r = GIZMO_RING_RADIUS * s;
  const pts = [];
  let prev = null;
  for (let i = 0; i <= GIZMO_RING_SEGMENTS; i++) {
    const a = (i / GIZMO_RING_SEGMENTS) * Math.PI * 2;
    const p = [center[0] + Math.sin(a) * r, center[1], center[2] + Math.cos(a) * r];
    if (prev) pts.push(prev, p);
    prev = p;
  }
  return pts;
}

// 上下の向き(pitch)リング: centerを通り、カメラの向いている方向+真上に張られた垂直円
function gizmoPitchRingPoints(center, baseYaw, s) {
  const r = GIZMO_RING_RADIUS * s;
  const { forward } = fcGetCameraVectors(baseYaw, 0);
  const pts = [];
  let prev = null;
  for (let i = 0; i <= GIZMO_RING_SEGMENTS; i++) {
    const a = (i / GIZMO_RING_SEGMENTS) * Math.PI * 2;
    const p = [
      center[0] + forward[0] * Math.cos(a) * r,
      center[1] + Math.sin(a) * r,
      center[2] + forward[2] * Math.cos(a) * r,
    ];
    if (prev) pts.push(prev, p);
    prev = p;
  }
  return pts;
}

// 3Dの線分を、画面上で一定の太さの帯(三角形2枚)として描く。
// gl.lineWidth()は多くの環境で1pxに固定されてしまうため、この方式にしてある。
function _drawLineSegments(gl, viewMatrix, projMatrix, pointPairs, color, canvasW, canvasH, widthPx) {
  if (!pointPairs.length) return;
  const half = (widthPx || GIZMO_LINE_WIDTH_PX) / 2;
  const verts = [];
  for (let i = 0; i < pointPairs.length; i += 2) {
    const s0 = projectToScreen(pointPairs[i], viewMatrix, projMatrix, canvasW, canvasH);
    const s1 = projectToScreen(pointPairs[i+1], viewMatrix, projMatrix, canvasW, canvasH);
    if (!s0 || !s1) continue; // カメラの後ろ側などで投影できない線分は飛ばす
    let dx = s1.x - s0.x, dy = s1.y - s0.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const px = -dy * half, py = dx * half;
    const A = [s0.x+px, s0.y+py], B = [s0.x-px, s0.y-py], C = [s1.x+px, s1.y+py], D = [s1.x-px, s1.y-py];
    for (const p of [A, B, C, C, B, D]) {
      verts.push((p[0] / canvasW) * 2 - 1, 1 - (p[1] / canvasH) * 2); // ピクセル座標→NDC
    }
  }
  if (!verts.length) return;
  const depthWasOn = gl.isEnabled(gl.DEPTH_TEST);
  gl.disable(gl.DEPTH_TEST); // 画面に貼り付けるだけなので深度は使わない
  gl.useProgram(thickLineProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, thickLineVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(thickLineAPosLoc);
  gl.vertexAttribPointer(thickLineAPosLoc, 2, gl.FLOAT, false, 8, 0);
  gl.uniform3f(thickLineUTintLoc, color[0], color[1], color[2]);
  gl.drawArrays(gl.TRIANGLES, 0, verts.length / 2);
  if (depthWasOn) gl.enable(gl.DEPTH_TEST);
}

function _gizmoPartsFor(point) {
  const c = point.pos, s = gizmoScaleAt(c);
  return [
    { kind: 'axis', axis: 'x', pts: gizmoAxisPoints(c, 'x', s), color: GIZMO_AXIS_COLOR.x },
    { kind: 'axis', axis: 'y', pts: gizmoAxisPoints(c, 'y', s), color: GIZMO_AXIS_COLOR.y },
    { kind: 'axis', axis: 'z', pts: gizmoAxisPoints(c, 'z', s), color: GIZMO_AXIS_COLOR.z },
    { kind: 'plane', pts: gizmoPlaneHandlePoints(c, s), color: GIZMO_PLANE_COLOR },
    { kind: 'ring', ring: 'yaw', pts: gizmoYawRingPoints(c, s), color: GIZMO_RING_COLOR.yaw },
    { kind: 'ring', ring: 'pitch', pts: gizmoPitchRingPoints(c, point.yaw, s), color: GIZMO_RING_COLOR.pitch },
  ];
}

function gizmoPartsEqual(a, b) {
  return !!a && !!b && a.kind === b.kind && a.axis === b.axis && a.ring === b.ring;
}

function renderTransformGizmo(gl, viewMatrix, projMatrix, point, canvasW, canvasH, activePart) {
  if (!point || isNearEye(point.pos)) return;
  for (const part of _gizmoPartsFor(point)) {
    const hot = gizmoPartsEqual(part, activePart || gizmoHoverPart);
    const col = hot ? part.color.map(v => v + (1 - v) * 0.6) : part.color;
    _drawLineSegments(gl, viewMatrix, projMatrix, part.pts, col, canvasW, canvasH, hot ? 5.5 : GIZMO_LINE_WIDTH_PX);
  }
}


// ============================================================
// 移動・回転ギズモの当たり判定(画面上の距離で判定する)
// ============================================================

function _pointToSegmentDist2D(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx*dx + dy*dy;
  let t = lenSq > 0 ? ((px-ax)*dx + (py-ay)*dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t*dx, cy = ay + t*dy;
  return Math.hypot(px-cx, py-cy);
}

function _polylineScreenDist(points3D, mouseX, mouseY, viewMatrix, projMatrix, cw, ch) {
  let best = Infinity;
  for (let i = 0; i < points3D.length; i += 2) {
    const s1 = projectToScreen(points3D[i], viewMatrix, projMatrix, cw, ch);
    const s2 = projectToScreen(points3D[i+1], viewMatrix, projMatrix, cw, ch);
    if (!s1 || !s2) continue;
    const d = _pointToSegmentDist2D(mouseX, mouseY, s1.x, s1.y, s2.x, s2.y);
    if (d < best) best = d;
  }
  return best;
}

const GIZMO_PICK_THRESHOLD = 12;

// { kind:'axis', axis } | { kind:'plane' } | { kind:'ring', ring:'yaw'|'pitch' } | null
function pickTransformGizmoPart(point, mouseX, mouseY, viewMatrix, projMatrix, cw, ch) {
  if (!point || isNearEye(point.pos)) return null;
  let best = null, bestDist = GIZMO_PICK_THRESHOLD;
  for (const cand of _gizmoPartsFor(point)) {
    const d = _polylineScreenDist(cand.pts, mouseX, mouseY, viewMatrix, projMatrix, cw, ch);
    // 矢印・平面を、同じくらい近いリングより優先する(リングは大きく、つい当たりやすいため)
    const bias = cand.kind === 'ring' ? 3 : 0;
    if (d + bias < bestDist) { bestDist = d + bias; best = { kind: cand.kind, axis: cand.axis, ring: cand.ring }; }
  }
  return best;
}

// ============================================================
// ドラッグ数学: マウス位置(スクリーン)からワールドの直線/平面へ変換する
// ============================================================

function scRayFromScreen(mouseX, mouseY, canvasW, canvasH, eyePos, yaw, pitch, fovDeg) {
  const { forward, right, up } = fcGetCameraVectors(yaw, pitch);
  const aspect = canvasW / Math.max(1, canvasH);
  const halfH = Math.tan(fovDeg * Math.PI / 180 / 2);
  const halfW = halfH * aspect;
  const ndcX = (mouseX / canvasW) * 2 - 1;
  const ndcY = 1 - (mouseY / canvasH) * 2;
  const dir = [
    forward[0] + right[0]*ndcX*halfW + up[0]*ndcY*halfH,
    forward[1] + right[1]*ndcX*halfW + up[1]*ndcY*halfH,
    forward[2] + right[2]*ndcX*halfW + up[2]*ndcY*halfH,
  ];
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  return { origin: eyePos.slice(), dir: [dir[0]/len, dir[1]/len, dir[2]/len] };
}

// レイと直線(点+方向)の最近接点における、直線側のパラメータtを返す
// (直線上の点 = linePoint + lineDir * t)
function scClosestTOnLine(ray, linePoint, lineDir) {
  const w0 = [ray.origin[0]-linePoint[0], ray.origin[1]-linePoint[1], ray.origin[2]-linePoint[2]];
  const a = ray.dir[0]**2 + ray.dir[1]**2 + ray.dir[2]**2;
  const b = ray.dir[0]*lineDir[0] + ray.dir[1]*lineDir[1] + ray.dir[2]*lineDir[2];
  const c = lineDir[0]**2 + lineDir[1]**2 + lineDir[2]**2;
  const d = ray.dir[0]*w0[0] + ray.dir[1]*w0[1] + ray.dir[2]*w0[2];
  const e = lineDir[0]*w0[0] + lineDir[1]*w0[1] + lineDir[2]*w0[2];
  const denom = a*c - b*b;
  if (Math.abs(denom) < 1e-6) return 0; // ほぼ平行(まず起きない: 画面奥行き方向と軸が完全一致する場合のみ)
  return (a*e - b*d) / denom;
}

// レイと平面(点+法線)の交点(無ければnull)
function scRayPlaneIntersect(ray, planePoint, normal) {
  const denom = ray.dir[0]*normal[0] + ray.dir[1]*normal[1] + ray.dir[2]*normal[2];
  if (Math.abs(denom) < 1e-6) return null;
  const diff = [planePoint[0]-ray.origin[0], planePoint[1]-ray.origin[1], planePoint[2]-ray.origin[2]];
  const t = (diff[0]*normal[0] + diff[1]*normal[1] + diff[2]*normal[2]) / denom;
  if (t < 0) return null;
  return [ray.origin[0]+ray.dir[0]*t, ray.origin[1]+ray.dir[1]*t, ray.origin[2]+ray.dir[2]*t];
}
