// entities3d.js
// ============================================================
// シーンエディタ用の、地形以外の3Dオブジェクト:
//   - 人物モデル(灰色マネキン。プレイヤーテクスチャがあれば貼る)
//   - カメラギズモ(配置済みカメラの位置を表す小さい箱+レンズ)
//   - 移動ギズモ(XYZ矢印+XZ平面ハンドル)・回転ギズモ(yaw/pitchリング)
//     …選択中のカメラにだけ表示され、ドラッグで位置・向きを調整する
//
// 【作り直し・ステップ2(シーンエディタ)】
// 移動・回転ギズモは、時間の都合上「線(LINE)」で描く簡易版にしてある
// (太い立体矢印ではなく、色付きの線でできた矢印・リング)。当たり判定も
// 画面上の座標に投影した上での「線分までの距離」で行っている。見た目の
// 情報量としては簡易だが、位置・向きの調整という役割は問題なく果たせる。
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

let ent3dProgram = null, ent3dVbo = null;
let ent3dAPosLoc, ent3dABrightnessLoc, ent3dAUVLoc, ent3dUViewLoc, ent3dUProjLoc, ent3dUModelLoc, ent3dUTintLoc, ent3dUUseTextureLoc, ent3dUTextureLoc;
let lineProgram = null, lineVbo = null;
let lineAPosLoc, lineUViewLoc, lineUProjLoc, lineUTintLoc;

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
// 配置済みカメラ(シーンエディタで置いたもの)
// ステップ4(複数カメラブロック)でタイムラインのブロックへ格上げされる
// までの、この時点でのシンプルな置き場所。
// ============================================================

let sceneCameras = [];   // { id, pos:[x,y,z](world), yaw, pitch, fov }
let selectedCameraId = null;
let nextSceneCameraId = 1;

function scAddCamera(pos, yaw, pitch, fov) {
  const cam = { id: nextSceneCameraId++, pos: pos.slice(), yaw, pitch, fov };
  sceneCameras.push(cam);
  selectedCameraId = cam.id;
  return cam;
}

function scGetSelected() {
  return sceneCameras.find(c => c.id === selectedCameraId) || null;
}

function scDeleteSelected() {
  if (selectedCameraId == null) return;
  sceneCameras = sceneCameras.filter(c => c.id !== selectedCameraId);
  selectedCameraId = null;
}


// ============================================================
// 描画: カメラギズモ(配置済みカメラの箱+レンズ)
// ============================================================

function renderCameraGizmos(gl, viewMatrix, projMatrix) {
  if (!ent3dProgram || sceneCameras.length === 0) return;

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

  for (const cam of sceneCameras) {
    const model = modelMatrixYaw(cam.pos[0], cam.pos[1], cam.pos[2], cam.yaw);
    gl.uniformMatrix4fv(ent3dUModelLoc, false, model);
    const isSelected = cam.id === selectedCameraId;
    gl.uniform3f(ent3dUTintLoc, isSelected ? 1.0 : 0.24, isSelected ? 0.76 : 0.81, isSelected ? 0.24 : 0.56);
    gl.drawArrays(gl.TRIANGLES, 0, gizmoVertexCount);
  }
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

function pickCameraGizmo(clickX, clickY, viewMatrix, projMatrix, canvasWidth, canvasHeight) {
  let best = null, bestDist = 30;
  for (const cam of sceneCameras) {
    const screen = projectToScreen(cam.pos, viewMatrix, projMatrix, canvasWidth, canvasHeight);
    if (!screen) continue;
    const d = Math.hypot(screen.x - clickX, screen.y - clickY);
    if (d < bestDist) { bestDist = d; best = cam; }
  }
  return best;
}


// ============================================================
// 移動ギズモ(XYZ矢印+XZ平面ハンドル)・回転ギズモ(yaw/pitchリング)
// どちらも線で描く簡易版。選択中のカメラにだけ表示する。
// ============================================================

const GIZMO_ARROW_LEN = 2.6;
const GIZMO_ARROW_START = 0.55;
const GIZMO_PLANE_OFFSET = 0.8;
const GIZMO_PLANE_SIZE = 0.55;
const GIZMO_RING_RADIUS = 2.2;
const GIZMO_RING_SEGMENTS = 40;

const GIZMO_AXIS_COLOR = { x: [0.92, 0.28, 0.28], y: [0.32, 0.85, 0.4], z: [0.32, 0.56, 0.95] };
const GIZMO_PLANE_COLOR = [0.92, 0.85, 0.3];
const GIZMO_RING_COLOR = { yaw: [0.91, 0.64, 0.24], pitch: [0.55, 0.5, 0.91] };

function _axisVec(axis) { return axis === 'x' ? [1,0,0] : axis === 'y' ? [0,1,0] : [0,0,1]; }

// 軸1本ぶんの線分(本体+矢じり)を、centerからのワールド座標点の配列で返す
// (2点ごとに1本の線分、というgl.LINES向けのフラットな並び)
function gizmoAxisPoints(center, axis) {
  const d = _axisVec(axis);
  const s = center.map((v, i) => v + d[i] * GIZMO_ARROW_START);
  const e = center.map((v, i) => v + d[i] * GIZMO_ARROW_LEN);
  const pts = [s, e];
  // 矢じり(先端から少し戻ったところに、垂直な2方向へ短い線を足す)
  const perp1 = axis === 'x' ? [0,1,0] : axis === 'y' ? [1,0,0] : [1,0,0];
  const perp2 = axis === 'x' ? [0,0,1] : axis === 'y' ? [0,0,1] : [0,1,0];
  const back = e.map((v, i) => v - d[i] * 0.35);
  const head = (perp) => back.map((v, i) => v + perp[i] * 0.14);
  pts.push(e, head(perp1));
  pts.push(e, head(perp1.map(v => -v)));
  pts.push(e, head(perp2));
  pts.push(e, head(perp2.map(v => -v)));
  return pts;
}

// XZ平面ハンドル(正方形の枠、4辺=4線分)
function gizmoPlaneHandlePoints(center) {
  const o = GIZMO_PLANE_OFFSET, s = GIZMO_PLANE_SIZE;
  const corners = [
    [center[0]+o, center[1], center[2]+o],
    [center[0]+o+s, center[1], center[2]+o],
    [center[0]+o+s, center[1], center[2]+o+s],
    [center[0]+o, center[1], center[2]+o+s],
  ];
  return [corners[0],corners[1], corners[1],corners[2], corners[2],corners[3], corners[3],corners[0]];
}

// yawリング(centerを通る水平円)。1本のポリライン=N個の線分。
function gizmoYawRingPoints(center) {
  const pts = [];
  let prev = null;
  for (let i = 0; i <= GIZMO_RING_SEGMENTS; i++) {
    const a = (i / GIZMO_RING_SEGMENTS) * Math.PI * 2;
    const p = [center[0] + Math.sin(a) * GIZMO_RING_RADIUS, center[1], center[2] + Math.cos(a) * GIZMO_RING_RADIUS];
    if (prev) pts.push(prev, p);
    prev = p;
  }
  return pts;
}

// pitchリング(centerを通り、指定yaw方向+上方向に張られた垂直円)
function gizmoPitchRingPoints(center, baseYaw) {
  const { forward } = fcGetCameraVectors(baseYaw, 0);
  const up = [0, 1, 0];
  const pts = [];
  let prev = null;
  for (let i = 0; i <= GIZMO_RING_SEGMENTS; i++) {
    const a = (i / GIZMO_RING_SEGMENTS) * Math.PI * 2;
    const p = [
      center[0] + forward[0]*Math.cos(a)*GIZMO_RING_RADIUS + up[0]*Math.sin(a)*GIZMO_RING_RADIUS,
      center[1] + forward[1]*Math.cos(a)*GIZMO_RING_RADIUS + up[1]*Math.sin(a)*GIZMO_RING_RADIUS,
      center[2] + forward[2]*Math.cos(a)*GIZMO_RING_RADIUS + up[2]*Math.sin(a)*GIZMO_RING_RADIUS,
    ];
    if (prev) pts.push(prev, p);
    prev = p;
  }
  return pts;
}

function _drawLineSegments(gl, viewMatrix, projMatrix, pointPairs, color) {
  if (!pointPairs.length) return;
  const flat = [];
  for (const p of pointPairs) flat.push(p[0], p[1], p[2]);
  gl.useProgram(lineProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(flat), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(lineAPosLoc);
  gl.vertexAttribPointer(lineAPosLoc, 3, gl.FLOAT, false, 12, 0);
  gl.uniformMatrix4fv(lineUViewLoc, false, viewMatrix);
  gl.uniformMatrix4fv(lineUProjLoc, false, projMatrix);
  gl.uniform3f(lineUTintLoc, color[0], color[1], color[2]);
  gl.drawArrays(gl.LINES, 0, flat.length / 3);
}

function renderTransformGizmo(gl, viewMatrix, projMatrix, cam) {
  if (!cam) return;
  const c = cam.pos;
  gl.disable(gl.DEPTH_TEST); // ギズモは地形の裏に隠れず、常に見えるようにする
  _drawLineSegments(gl, viewMatrix, projMatrix, gizmoAxisPoints(c, 'x'), GIZMO_AXIS_COLOR.x);
  _drawLineSegments(gl, viewMatrix, projMatrix, gizmoAxisPoints(c, 'y'), GIZMO_AXIS_COLOR.y);
  _drawLineSegments(gl, viewMatrix, projMatrix, gizmoAxisPoints(c, 'z'), GIZMO_AXIS_COLOR.z);
  _drawLineSegments(gl, viewMatrix, projMatrix, gizmoPlaneHandlePoints(c), GIZMO_PLANE_COLOR);
  _drawLineSegments(gl, viewMatrix, projMatrix, gizmoYawRingPoints(c), GIZMO_RING_COLOR.yaw);
  _drawLineSegments(gl, viewMatrix, projMatrix, gizmoPitchRingPoints(c, cam.yaw), GIZMO_RING_COLOR.pitch);
  gl.enable(gl.DEPTH_TEST);
}


// ============================================================
// 移動・回転ギズモの当たり判定(画面上の距離で判定する簡易版)
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

const GIZMO_PICK_THRESHOLD = 10;

// 選択中カメラの移動/回転ギズモのうち、クリック位置に一番近い部分を返す。
// { kind:'axis', axis:'x'|'y'|'z' } | { kind:'plane' } | { kind:'ring', ring:'yaw'|'pitch' } | null
function pickTransformGizmoPart(cam, mouseX, mouseY, viewMatrix, projMatrix, cw, ch) {
  if (!cam) return null;
  const c = cam.pos;
  const candidates = [
    { kind: 'axis', axis: 'x', pts: gizmoAxisPoints(c, 'x') },
    { kind: 'axis', axis: 'y', pts: gizmoAxisPoints(c, 'y') },
    { kind: 'axis', axis: 'z', pts: gizmoAxisPoints(c, 'z') },
    { kind: 'plane', pts: gizmoPlaneHandlePoints(c) },
    { kind: 'ring', ring: 'yaw', pts: gizmoYawRingPoints(c) },
    { kind: 'ring', ring: 'pitch', pts: gizmoPitchRingPoints(c, cam.yaw) },
  ];
  let best = null, bestDist = GIZMO_PICK_THRESHOLD;
  for (const cand of candidates) {
    const d = _polylineScreenDist(cand.pts, mouseX, mouseY, viewMatrix, projMatrix, cw, ch);
    if (d < bestDist) { bestDist = d; best = cand; }
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
