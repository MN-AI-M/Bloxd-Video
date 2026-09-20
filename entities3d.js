// entities3d.js
// ============================================================
// 「global-setting」画面(Mine-imator風のシーンエディタ)で使う、
// 地形以外の3Dオブジェクト:
//   - 人物モデル(最初はテクスチャ無しの灰色マネキン。ボックスの組み合わせ)
//   - カメラギズモ(カメラブロックの位置を表す小さいアイコン)
//   - パス線(フリー記録ブロックの、実際に動いた軌跡)
//
// 地形と同じ FACE_OFFSETS / DIR_FACTOR (shared.js) を再利用して、
// 見た目のトーンを揃えてある。地形とは別の、専用の小さいシェーダーで
// 描画する(色は頂点ごとのuniformではなく、ここでは単純にモデル行列で
// 位置だけ変えて使い回す)。
// ============================================================

// 人物モデルのパーツ定義(ローカル座標。足元がy=0、yaw=0で+z方向を向く)。
// Bloxdのプレイヤーは概ねMinecraftに近い比率と仮定した簡易モデル。
const HUMANOID_PARTS = [
  { center: [0, 1.55, 0],   size: [0.5, 0.5, 0.5] },   // 頭
  { center: [0, 1.0, 0],    size: [0.5, 0.75, 0.28] }, // 胴
  { center: [-0.375, 1.0, 0], size: [0.25, 0.75, 0.25] }, // 右腕(モデル座標で-x側)
  { center: [0.375, 1.0, 0],  size: [0.25, 0.75, 0.25] }, // 左腕
  { center: [-0.14, 0.325, 0], size: [0.25, 0.65, 0.25] }, // 右脚
  { center: [0.14, 0.325, 0],  size: [0.25, 0.65, 0.25] }, // 左脚
];

let humanoidVertexData = null; // [x,y,z,brightness, ...] (ローカル座標、1体ぶん)
let humanoidVertexCount = 0;

// 各面の4隅に対応する簡易UV(0〜1)。順序はFACE_OFFSETSの並びと合わせてある。
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
        // offsetsは0〜1の範囲(単位立方体)なので、-0.5〜0.5にずらしてから
        // パーツのサイズを掛け、パーツ中心へ平行移動する
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

// カメラギズモ: 本体(小さい箱)+レンズ(前に出っ張った小さい箱)。
// モデル座標系はhumanoidと同じ(yaw=0で+z方向を向く=レンズが+z側に出る)。
const CAMERA_GIZMO_PARTS = [
  { center: [0, 0, 0],     size: [0.5, 0.4, 0.35] },  // 本体
  { center: [0, 0, 0.32],  size: [0.22, 0.22, 0.3] }, // レンズ
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
        verts.push(lx, ly, lz, brightness, 0, 0); // ギズモはテクスチャを使わないのでUVはダミー
      }
    }
  }
  gizmoVertexData = new Float32Array(verts);
  gizmoVertexCount = verts.length / 6;
}


// ============================================================
// シェーダー(色は tint uniform 1個。brightnessで陰影だけ付ける。
// uUseTextureが立ってる時だけ、uTextureをサンプルして重ねる)
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
  void main() { gl_Position = uProj * uView * vec4(aPos, 1.0); }
`;
const ENT3D_LINE_FRAGMENT_SRC = `
  precision mediump float;
  uniform vec3 uTint;
  void main() { gl_FragColor = vec4(uTint, 0.85); }
`;

let ent3dProgram = null, ent3dVbo = null;
let ent3dAPosLoc, ent3dABrightnessLoc, ent3dAUVLoc, ent3dUViewLoc, ent3dUProjLoc, ent3dUModelLoc, ent3dUTintLoc, ent3dUUseTextureLoc, ent3dUTextureLoc;
let lineProgram = null, lineVbo = null;
let lineAPosLoc, lineUViewLoc, lineUProjLoc, lineUTintLoc;

// プレイヤーのテクスチャ(project-settings.jsのsetPlayerTexture()から設定される)
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
  if (ent3dProgram) return; // 既に初期化済み

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


// project-settings.js から、プレイヤーテクスチャがアップロードされた時に呼ばれる。
// image: 読み込み済みのHTMLImageElement。nullを渡すとテクスチャ無し(灰色)に戻る。
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

function mat4Identity() {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
}
function mat4Translate(x, y, z) {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]);
}
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
// yaw(ラジアン)だけの、位置(x,y,z)へのモデル行列(拡大なし)
function modelMatrixYaw(x, y, z, yaw) {
  return mat4Multiply(mat4Translate(x, y, z), mat4RotateY(yaw));
}


// ============================================================
// 描画: 人物モデル
// ============================================================
// allTimelines.entities の全員(現在tick付近にフレームがある人)を、
// worldOrigin基準のローカル座標で描画する。呼び出し側で
// gl.useProgram等は済ませておく必要は無く、この関数の中で完結する。

function renderHumanoids(gl, viewMatrix, projMatrix, tick) {
  if (!ent3dProgram || !allTimelines || !allTimelines.entities) return;
  gl.useProgram(ent3dProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, ent3dVbo);
  gl.bufferData(gl.ARRAY_BUFFER, humanoidVertexData, gl.STATIC_DRAW);
  const stride = 24; // 6 floats: pos(3) + brightness(1) + uv(2)
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
      gl.uniform3f(ent3dUTintLoc, 1, 1, 1); // テクスチャありなら、色はテクスチャそのものを使う
    } else {
      const isLocalPlayer = (eid === allTimelines.localPlayerEntityId);
      gl.uniform3f(ent3dUTintLoc, isLocalPlayer ? 0.85 : 0.6, isLocalPlayer ? 0.85 : 0.6, isLocalPlayer ? 0.9 : 0.62);
    }
    gl.drawArrays(gl.TRIANGLES, 0, humanoidVertexCount);
  }
}

// ent.framesは「変化があったtickだけ」の疎な配列。指定tick以前で一番近い
// フレームを二分探索で探す(freecam.js/timeline.jsの同種の探索と同じ考え方)。
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
// 描画: カメラギズモ + パス線
// ============================================================

function renderCameraGizmos(gl, viewMatrix, projMatrix, selectedId) {
  if (!ent3dProgram || typeof timelineBlocks === 'undefined') return;
  const camBlocks = timelineBlocks.filter(b => b.track === 'camera');
  if (camBlocks.length === 0) return;

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
  gl.uniform1f(ent3dUUseTextureLoc, 0.0); // ギズモはテクスチャを使わない
  gl.uniformMatrix4fv(ent3dUViewLoc, false, viewMatrix);
  gl.uniformMatrix4fv(ent3dUProjLoc, false, projMatrix);

  for (const block of camBlocks) {
    const gp = gizmoRepresentativePoint(block);
    if (!gp) continue;
    const model = modelMatrixYaw(gp.pos[0], gp.pos[1], gp.pos[2], gp.yaw);
    gl.uniformMatrix4fv(ent3dUModelLoc, false, model);
    const isSelected = block.id === selectedId;
    gl.uniform3f(ent3dUTintLoc, isSelected ? 1.0 : 0.24, isSelected ? 0.76 : 0.81, isSelected ? 0.24 : 0.56);
    gl.drawArrays(gl.TRIANGLES, 0, gizmoVertexCount);
  }

  // フリー記録ブロックは、実際に動いた軌跡を線で見せる
  gl.useProgram(lineProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
  gl.enableVertexAttribArray(lineAPosLoc);
  gl.vertexAttribPointer(lineAPosLoc, 3, gl.FLOAT, false, 12, 0);
  gl.uniformMatrix4fv(lineUViewLoc, false, viewMatrix);
  gl.uniformMatrix4fv(lineUProjLoc, false, projMatrix);

  for (const block of camBlocks) {
    if (block.data.mode === 'static' || !block.data.cameraPath || block.data.cameraPath.size < 2) continue;
    const sortedTicks = Array.from(block.data.cameraPath.keys()).sort((a, b) => a - b);
    const verts = [];
    for (const t of sortedTicks) {
      const p = block.data.cameraPath.get(t).pos;
      verts.push(p[0], p[1], p[2]);
    }
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    const isSelected = block.id === selectedId;
    gl.uniform3f(lineUTintLoc, isSelected ? 1.0 : 0.24, isSelected ? 0.76 : 0.81, isSelected ? 0.24 : 0.56);
    gl.drawArrays(gl.LINE_STRIP, 0, sortedTicks.length);
  }
}

// ギズモを置く代表点(静止=その位置、フリー記録=記録開始時点の位置)
function gizmoRepresentativePoint(block) {
  if (block.data.mode === 'static' && block.data.staticState) {
    return { pos: block.data.staticState.pos, yaw: block.data.staticState.yaw };
  }
  if (block.data.cameraPath && block.data.cameraPath.size > 0) {
    const sortedTicks = Array.from(block.data.cameraPath.keys()).sort((a, b) => a - b);
    const first = block.data.cameraPath.get(sortedTicks[0]);
    return { pos: first.pos, yaw: first.yaw };
  }
  return null;
}

// 画面クリックでのギズモ選択用: 3D位置をスクリーン座標に投影する。
function projectToScreen(pos, viewMatrix, projMatrix, canvasWidth, canvasHeight) {
  const vp = mat4Multiply(projMatrix, viewMatrix);
  const x = pos[0]*vp[0] + pos[1]*vp[4] + pos[2]*vp[8] + vp[12];
  const y = pos[0]*vp[1] + pos[1]*vp[5] + pos[2]*vp[9] + vp[13];
  const w = pos[0]*vp[3] + pos[1]*vp[7] + pos[2]*vp[11] + vp[15];
  if (w <= 0) return null; // カメラの後ろ
  const ndcX = x / w, ndcY = y / w;
  return {
    x: (ndcX * 0.5 + 0.5) * canvasWidth,
    y: (1.0 - (ndcY * 0.5 + 0.5)) * canvasHeight,
  };
}

// クリック位置(canvas内座標)に一番近いカメラギズモを探す(無ければnull)
function pickCameraGizmo(clickX, clickY, viewMatrix, projMatrix, canvasWidth, canvasHeight) {
  if (typeof timelineBlocks === 'undefined') return null;
  const camBlocks = timelineBlocks.filter(b => b.track === 'camera');
  let best = null, bestDist = 28; // 画素単位の当たり判定しきい値
  for (const block of camBlocks) {
    const gp = gizmoRepresentativePoint(block);
    if (!gp) continue;
    const screen = projectToScreen(gp.pos, viewMatrix, projMatrix, canvasWidth, canvasHeight);
    if (!screen) continue;
    const d = Math.hypot(screen.x - clickX, screen.y - clickY);
    if (d < bestDist) { bestDist = d; best = block; }
  }
  return best;
}
