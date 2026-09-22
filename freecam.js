// freecam.js
// ============================================================
// 自由カメラ(プレイ画面のような一人称視点)+ シーンエディタ。
//
// 【作り直し・ステップ2(シーンエディタ)】
// 常時WASD一人称視点がベース。「＋カメラを配置」の代わりに、飛行中に
// Fキーを押すと今いる場所にカメラを固定できる(静的ショット。動く
// ショット[ウェイポイント]はステップ3で追加)。選択中のカメラには
// 移動ギズモ(XYZ矢印+XZ平面ハンドル)・回転ギズモ(yaw/pitchリング)が
// 表示され、ドラッグで位置・向きを調整できる(操作はマウスキャプチャを
// 解除している時のみ)。右下の小窓(PinP)に「今主画面になっていない方」
// (編集視点 or 選択中カメラのプレビュー)を表示し、クリックで入れ替わる。
//
// 操作: クリックでマウスキャプチャ開始、WASDで移動、Spaceで上昇、
//       Shiftで下降、マウスで視点回転、Fでカメラ固定、Escでマウス解放。
//       マウス解放中は、カメラのギズモをクリックで選択、ドラッグで移動/回転、
//       Delete/Backspaceで選択中のカメラを削除。
// ============================================================

let fcMeshFaces = [], fcMeshPalette = [];
let fcVertexData = []; // 全部たまってる頂点データ(浮動小数点の配列)

let fcCanvas, fcGl, fcProgram, fcVbo, fcTexture;
let fcAPosLoc, fcAUVLoc, fcABrightnessLoc, fcARevealTickLoc;
let fcUViewLoc, fcUProjLoc, fcUTextureLoc, fcUCurrentTickLoc;
let fcVertexCount = 0;
let fcUVRectsRaw = null;   // texName -> [u0,v0,u1,v1] (アトラス内の位置)
let fcAtlasCanvas = null;
let fcAtlasReadyPromise = null;
let fcActive = false;      // 初期化済みかどうか(1回きりの初期化フラグ)
let fcAnimId = null;
let fcLastFrameTime = 0;
let fcKeys = {};
let fcYaw = 0, fcPitch = 0;
let fcPos = [0, 20, 0]; // worldOriginX,Y,Zからの相対座標
let fcFovDeg = 70;

const FC_MOVE_SPEED = 25; // ブロック/秒
const FC_MOUSE_SENSITIVITY = 0.0025;


// ============================================================
// シェーダー
// ============================================================

const FC_VERTEX_SHADER_SRC = `
  attribute vec3 aPos;
  attribute vec2 aUV;
  attribute float aBrightness;
  attribute float aRevealTick;
  uniform mat4 uView;
  uniform mat4 uProj;
  uniform float uCurrentTick;
  varying vec2 vUV;
  varying float vBrightness;
  void main() {
    if (aRevealTick > uCurrentTick) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // クリップ範囲外に飛ばして非表示にする
    } else {
      gl_Position = uProj * uView * vec4(aPos, 1.0);
    }
    vUV = aUV;
    vBrightness = aBrightness;
  }
`;

const FC_FRAGMENT_SHADER_SRC = `
  precision mediump float;
  uniform sampler2D uTexture;
  varying vec2 vUV;
  varying float vBrightness;
  void main() {
    vec4 texColor = texture2D(uTexture, vUV);
    if (texColor.a < 0.1) discard;
    gl_FragColor = vec4(texColor.rgb * vBrightness, texColor.a);
  }
`;

function fcCompileShader(type, src) {
  const s = fcGl.createShader(type);
  fcGl.shaderSource(s, src);
  fcGl.compileShader(s);
  if (!fcGl.getShaderParameter(s, fcGl.COMPILE_STATUS)) {
    const info = fcGl.getShaderInfoLog(s);
    fcGl.deleteShader(s);
    throw new Error('シェーダーのコンパイルに失敗しました: ' + info);
  }
  return s;
}

function initFreecamGL() {
  fcCanvas = document.getElementById('freecamCanvas');
  fcGl = fcCanvas.getContext('webgl') || fcCanvas.getContext('experimental-webgl');
  if (!fcGl) {
    document.getElementById('freecamStatus').innerText = '⚠️ このブラウザ/端末ではWebGLが使えません。別のブラウザ(Chrome/Firefox等)でお試しください。';
    return false;
  }
  const vs = fcCompileShader(fcGl.VERTEX_SHADER, FC_VERTEX_SHADER_SRC);
  const fs = fcCompileShader(fcGl.FRAGMENT_SHADER, FC_FRAGMENT_SHADER_SRC);
  fcProgram = fcGl.createProgram();
  fcGl.attachShader(fcProgram, vs);
  fcGl.attachShader(fcProgram, fs);
  fcGl.linkProgram(fcProgram);
  if (!fcGl.getProgramParameter(fcProgram, fcGl.LINK_STATUS)) {
    throw new Error('シェーダープログラムのリンクに失敗しました: ' + fcGl.getProgramInfoLog(fcProgram));
  }
  fcAPosLoc = fcGl.getAttribLocation(fcProgram, 'aPos');
  fcAUVLoc = fcGl.getAttribLocation(fcProgram, 'aUV');
  fcABrightnessLoc = fcGl.getAttribLocation(fcProgram, 'aBrightness');
  fcARevealTickLoc = fcGl.getAttribLocation(fcProgram, 'aRevealTick');
  fcUViewLoc = fcGl.getUniformLocation(fcProgram, 'uView');
  fcUProjLoc = fcGl.getUniformLocation(fcProgram, 'uProj');
  fcUTextureLoc = fcGl.getUniformLocation(fcProgram, 'uTexture');
  fcUCurrentTickLoc = fcGl.getUniformLocation(fcProgram, 'uCurrentTick');

  fcVbo = fcGl.createBuffer();
  fcGl.enable(fcGl.DEPTH_TEST);
  fcGl.depthFunc(fcGl.LESS);

  setupFreecamControls();
  window.addEventListener('resize', () => { if (fcGl) resizeFreecamCanvas(); });
  return true;
}

function resizeFreecamCanvas() {
  const area = document.getElementById('freecamArea');
  fcCanvas.width = Math.max(1, area.clientWidth);
  fcCanvas.height = Math.max(1, area.clientHeight);
}


// ============================================================
// テクスチャアトラス(実際のpngをまとめて1枚のWebGLテクスチャにする)
// zip内の全テクスチャを対象にする(どのパレットにも依存しないので、
// ストリーミングでパレットが後から増えても作り直さなくて良い)。
// ============================================================

function ensureFreecamAtlasReady() {
  if (!fcAtlasReadyPromise) {
    fcAtlasReadyPromise = buildFreecamTextureAtlas();
  }
  return fcAtlasReadyPromise;
}

async function buildFreecamTextureAtlas() {
  await ensureTexturesLoading(); // ui.js: zipの展開(textureUrlsを埋める)
  const names = Array.from(textureUrls.keys());

  const cell = 64;
  const cols = Math.max(1, Math.ceil(Math.sqrt(names.length)));
  const rows = Math.max(1, Math.ceil(names.length / cols));
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = cols * cell;
  atlasCanvas.height = rows * cell;
  const actx = atlasCanvas.getContext('2d');
  actx.imageSmoothingEnabled = false;
  actx.fillStyle = '#888';
  actx.fillRect(0, 0, atlasCanvas.width, atlasCanvas.height); // 読み込めなかった分のフォールバック

  const uvRects = new Map();
  const promises = [];
  names.forEach((texName, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    // 隣のセルの色がにじみ出ない(bleeding)よう、少しだけ内側にパディングする
    const padU = 0.5 / atlasCanvas.width, padV = 0.5 / atlasCanvas.height;
    uvRects.set(texName, [
      col / cols + padU, row / rows + padV,
      (col + 1) / cols - padU, (row + 1) / rows - padV,
    ]);
    const url = textureUrls.get(texName);
    promises.push(new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { actx.drawImage(img, col * cell, row * cell, cell, cell); resolve(); };
      img.onerror = () => resolve();
      img.src = url;
    }));
  });
  await Promise.all(promises);

  fcUVRectsRaw = uvRects;
  fcAtlasCanvas = atlasCanvas;
}

function fcUploadAtlasTexture() {
  fcTexture = fcGl.createTexture();
  fcGl.bindTexture(fcGl.TEXTURE_2D, fcTexture);
  fcGl.texImage2D(fcGl.TEXTURE_2D, 0, fcGl.RGBA, fcGl.RGBA, fcGl.UNSIGNED_BYTE, fcAtlasCanvas);
  fcGl.texParameteri(fcGl.TEXTURE_2D, fcGl.TEXTURE_MIN_FILTER, fcGl.LINEAR);
  fcGl.texParameteri(fcGl.TEXTURE_2D, fcGl.TEXTURE_MAG_FILTER, fcGl.NEAREST);
  fcGl.texParameteri(fcGl.TEXTURE_2D, fcGl.TEXTURE_WRAP_S, fcGl.CLAMP_TO_EDGE);
  fcGl.texParameteri(fcGl.TEXTURE_2D, fcGl.TEXTURE_WRAP_T, fcGl.CLAMP_TO_EDGE);
}


// ============================================================
// ジオメトリ(ストリーミングで届いた面を継ぎ足していく)
// ============================================================

function startFreecamStream() {
  fcMeshFaces = [];
  fcMeshPalette = [];
  fcVertexData = [];
  fcVertexCount = 0;
  resetWorldOrigin();
  if (fcGl) {
    fcGl.bindBuffer(fcGl.ARRAY_BUFFER, fcVbo);
    fcGl.bufferData(fcGl.ARRAY_BUFFER, new Float32Array(0), fcGl.DYNAMIC_DRAW);
  }
}

// facesの各要素([x,y,z,dirCode,paletteIdx,scale,revealTick])を頂点データに
// 変換して、targetArrayの末尾に積む(fcMeshPalette/fcUVRectsRawの「今の」
// 内容を使う)。appendFreecamStreamFaces と _rebuildFreecamVertexData の
// 両方から使う共通処理。
function _pushFaceVertices(faces, targetArray) {
  if (!faces.length) return;
  const paletteUVRects = fcMeshPalette.map(p => (fcUVRectsRaw && fcUVRectsRaw.get(p.texture)) || [0, 0, 1, 1]);
  // 面の向きごとの「正しい」貼り方までは追い込んでおらず、正方形をそのまま
  // 貼る簡易実装(石・土のような向きを気にしない見た目ならほぼ気にならない)。
  const cornerUV = [[0, 1], [1, 1], [1, 0], [0, 0]];
  const order = [0, 1, 2, 0, 2, 3];

  for (const f of faces) {
    const wx = f[0], wy = f[1], wz = f[2], dirCode = f[3], pIdx = f[4], scale = f[5] || 1, revealTick = f[6] || 0;
    const bx = wx - worldOriginX, by = wy - worldOriginY, bz = wz - worldOriginZ;
    const rect = paletteUVRects[pIdx] || [0, 0, 1, 1];
    const brightness = DIR_FACTOR[dirCode];
    const offsets = FACE_OFFSETS[dirCode];
    for (const oi of order) {
      const [ox, oy, oz] = offsets[oi];
      const [cu, cv] = cornerUV[oi];
      const u = rect[0] + cu * (rect[2] - rect[0]);
      const v = rect[1] + cv * (rect[3] - rect[1]);
      targetArray.push(bx + ox * scale, by + oy, bz + oz * scale, u, v, brightness, revealTick);
    }
  }
}

function _uploadFreecamVertexData() {
  fcVertexCount = fcVertexData.length / 7;
  if (fcGl) {
    fcGl.bindBuffer(fcGl.ARRAY_BUFFER, fcVbo);
    fcGl.bufferData(fcGl.ARRAY_BUFFER, new Float32Array(fcVertexData), fcGl.DYNAMIC_DRAW);
  }
}

// newFaces: 今回新しく分かった面([[x,y,z,dirCode,paletteIdx,scale,revealTick],...])
// newPalette: 現時点での完全なパレット配列(毎回全体を受け取る想定)
function appendFreecamStreamFaces(newFaces, newPalette) {
  fcMeshPalette = newPalette;
  if (!newFaces.length) return;

  if (!worldOriginSet) {
    setWorldOrigin(newFaces[0][0], newFaces[0][1], newFaces[0][2]);
  }

  for (const f of newFaces) fcMeshFaces.push(f);
  _pushFaceVertices(newFaces, fcVertexData);
  _uploadFreecamVertexData();
}

// 撤回。retractedPositions: [[x,y,z],...](その位置の全方向を消す。eP編集用)
// retractedFaces: [[x,y,z,dirCode],...](その面だけを消す。チャンク境界の
// 暫定面の訂正用)。両方ともfcMeshFacesから対象を取り除き、頂点データを
// 作り直す(頻繁には起きない想定なので、全体作り直しで十分)。
function retractFreecamFaces(retractedPositions, retractedFaces) {
  const hasPositions = retractedPositions && retractedPositions.length;
  const hasFaces = retractedFaces && retractedFaces.length;
  if (!hasPositions && !hasFaces) return;

  const posSet = hasPositions ? new Set(retractedPositions.map(p => p[0] + ',' + p[1] + ',' + p[2])) : null;
  const faceSet = hasFaces ? new Set(retractedFaces.map(f => f[0] + ',' + f[1] + ',' + f[2] + ',' + f[3])) : null;

  const kept = fcMeshFaces.filter(f => {
    if (posSet && posSet.has(f[0] + ',' + f[1] + ',' + f[2])) return false;
    if (faceSet && faceSet.has(f[0] + ',' + f[1] + ',' + f[2] + ',' + f[3])) return false;
    return true;
  });
  if (kept.length === fcMeshFaces.length) return; // 消える面が無かった

  fcMeshFaces = kept;
  fcVertexData = [];
  _pushFaceVertices(fcMeshFaces, fcVertexData);
  _uploadFreecamVertexData();
}


// ============================================================
// カメラの数学(透視投影+視点行列。ライブラリを使わず自前で書いている)
// ============================================================

function fcVecSub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function fcVecCross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function fcVecDot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function fcVecNormalize(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; }

function fcMat4Perspective(fovyRad, aspect, near, far) {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function fcMat4LookAt(eye, center, upVec) {
  const zAxis = fcVecNormalize(fcVecSub(eye, center));
  const xAxis = fcVecNormalize(fcVecCross(upVec, zAxis));
  const yAxis = fcVecCross(zAxis, xAxis);
  return new Float32Array([
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    -fcVecDot(xAxis, eye), -fcVecDot(yAxis, eye), -fcVecDot(zAxis, eye), 1,
  ]);
}

// yaw/pitchから前方向・右方向・上方向を求める(Y-up、標準的なFPSカメラの式)
function fcGetCameraVectors(yaw, pitch) {
  const forward = fcVecNormalize([
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw),
  ]);
  const worldUp = [0, 1, 0];
  const right = fcVecNormalize(fcVecCross(forward, worldUp));
  const up = fcVecCross(right, forward);
  return { forward, right, up };
}


// ============================================================
// シーンエディタ: 画面状態(主画面⇔小窓)・ギズモのドラッグ状態
// ============================================================
// 「編集用のWASD視点」と「選択中カメラのプレビュー」のどちらかが主画面、
// もう片方が右下の小窓(PinP)になる。previewIsMainがどちらが主画面かを表す。
let previewIsMain = false;
let dragState = null; // ギズモをドラッグ中の情報。ドラッグ中でなければnull

const PINP_W = 220, PINP_H = 140, PINP_MARGIN = 14;

// 現在のfcPos/fcYaw/fcPitch/fcFovDegから、編集視点のview/proj行列を作る
function _fcEditViewProj() {
  const aspect = fcCanvas.width / Math.max(1, fcCanvas.height);
  const proj = fcMat4Perspective(fcFovDeg * Math.PI / 180, aspect, 0.1, 3000);
  const { forward } = fcGetCameraVectors(fcYaw, fcPitch);
  const center = [fcPos[0] + forward[0], fcPos[1] + forward[1], fcPos[2] + forward[2]];
  const view = fcMat4LookAt(fcPos, center, [0, 1, 0]);
  return { view, proj };
}

// 配置済みカメラ(sceneCameras の1つ)から見た、view/proj行列を作る
function _camViewProj(cam, aspect) {
  const proj = fcMat4Perspective(cam.fov * Math.PI / 180, aspect, 0.1, 3000);
  const { forward } = fcGetCameraVectors(cam.yaw, cam.pitch);
  const center = [cam.pos[0] + forward[0], cam.pos[1] + forward[1], cam.pos[2] + forward[2]];
  const view = fcMat4LookAt(cam.pos, center, [0, 1, 0]);
  return { view, proj };
}

function _fcCurTickVal() {
  if (timeline && timeline.frames.length && timeline.frames[curTick]) return timeline.frames[curTick].tick;
  return 0;
}


// ============================================================
// カメラの配置(自由飛行で行って、その場でスナップして固定)
// ============================================================

function placeCameraHere() {
  scAddCamera(fcPos, fcYaw, fcPitch, fcFovDeg);
  updateSelectedCameraBox();
  updatePinPVisibility();
}


// ============================================================
// 移動・回転ギズモのドラッグ
// ============================================================

function beginGizmoDrag(part, cam, mx, my) {
  const ray = scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg);
  dragState = {
    part, camId: cam.id,
    startPos: cam.pos.slice(), startYaw: cam.yaw, startPitch: cam.pitch,
  };
  if (part.kind === 'axis') {
    dragState.axisDir = _axisVec(part.axis);
    dragState.startT = scClosestTOnLine(ray, cam.pos, dragState.axisDir);
  } else if (part.kind === 'plane') {
    dragState.planeHit0 = scRayPlaneIntersect(ray, cam.pos, [0, 1, 0]);
  } else if (part.kind === 'ring' && part.ring === 'yaw') {
    const hit = scRayPlaneIntersect(ray, cam.pos, [0, 1, 0]);
    dragState.angle0 = hit ? Math.atan2(hit[0] - cam.pos[0], hit[2] - cam.pos[2]) : 0;
  } else if (part.kind === 'ring' && part.ring === 'pitch') {
    const { forward, right } = fcGetCameraVectors(cam.yaw, 0);
    dragState.ringNormal = right;
    dragState.forwardAxis = forward;
    const hit = scRayPlaneIntersect(ray, cam.pos, right);
    if (hit) {
      const rel = [hit[0]-cam.pos[0], hit[1]-cam.pos[1], hit[2]-cam.pos[2]];
      dragState.angle0 = Math.atan2(rel[1], rel[0]*forward[0] + rel[2]*forward[2]);
    } else {
      dragState.angle0 = 0;
    }
  }
}

function applyGizmoDrag(mx, my) {
  if (!dragState) return;
  const cam = sceneCameras.find(c => c.id === dragState.camId);
  if (!cam) { dragState = null; return; }
  const ray = scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg);
  const part = dragState.part;

  if (part.kind === 'axis') {
    const t = scClosestTOnLine(ray, dragState.startPos, dragState.axisDir);
    const delta = t - dragState.startT;
    cam.pos = dragState.startPos.map((v, i) => v + dragState.axisDir[i] * delta);

  } else if (part.kind === 'plane') {
    const hit = scRayPlaneIntersect(ray, dragState.startPos, [0, 1, 0]);
    if (hit && dragState.planeHit0) {
      cam.pos = [
        dragState.startPos[0] + (hit[0] - dragState.planeHit0[0]),
        dragState.startPos[1],
        dragState.startPos[2] + (hit[2] - dragState.planeHit0[2]),
      ];
    }

  } else if (part.kind === 'ring' && part.ring === 'yaw') {
    const hit = scRayPlaneIntersect(ray, dragState.startPos, [0, 1, 0]);
    if (hit) {
      const angle1 = Math.atan2(hit[0] - dragState.startPos[0], hit[2] - dragState.startPos[2]);
      const delta = Math.atan2(Math.sin(angle1 - dragState.angle0), Math.cos(angle1 - dragState.angle0));
      cam.yaw = dragState.startYaw + delta;
    }

  } else if (part.kind === 'ring' && part.ring === 'pitch') {
    const hit = scRayPlaneIntersect(ray, dragState.startPos, dragState.ringNormal);
    if (hit) {
      const rel = [hit[0]-dragState.startPos[0], hit[1]-dragState.startPos[1], hit[2]-dragState.startPos[2]];
      const angle1 = Math.atan2(rel[1], rel[0]*dragState.forwardAxis[0] + rel[2]*dragState.forwardAxis[2]);
      const delta = Math.atan2(Math.sin(angle1 - dragState.angle0), Math.cos(angle1 - dragState.angle0));
      const limit = Math.PI / 2 - 0.05;
      cam.pitch = Math.max(-limit, Math.min(limit, dragState.startPitch + delta));
    }
  }
}


// ============================================================
// 操作(マウスキャプチャ・キーボード・ギズモのクリック/ドラッグ)
// ============================================================

function setupFreecamControls() {
  document.addEventListener('keydown', e => {
    if (!fcActive) return;
    fcKeys[e.code] = true;

    // 飛行中(マウスキャプチャ中)にFキーで、今いる場所にカメラを固定する
    if (e.code === 'KeyF' && document.pointerLockElement === fcCanvas && !e.repeat) {
      placeCameraHere();
    }
    // 飛行中でない時、選択中のカメラをDelete/Backspaceで削除する
    if ((e.code === 'Delete' || e.code === 'Backspace') &&
        document.pointerLockElement !== fcCanvas && selectedCameraId != null && !e.repeat) {
      scDeleteSelected();
      updateSelectedCameraBox();
      updatePinPVisibility();
      previewIsMain = false; // 表示中だったプレビューが消えた場合に備えて編集視点に戻す
    }
  });
  document.addEventListener('keyup', e => { if (fcActive) fcKeys[e.code] = false; });

  fcCanvas.addEventListener('mousedown', (e) => {
    if (!fcActive) return;
    if (document.pointerLockElement === fcCanvas) return; // 飛行中はクリックに反応しない(視点操作のみ)
    if (previewIsMain) return; // プレビューが主画面の時は、固定カメラなので操作対象が無い

    const rect = fcCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const { view, proj } = _fcEditViewProj();

    const sel = scGetSelected();
    if (sel) {
      const part = pickTransformGizmoPart(sel, mx, my, view, proj, fcCanvas.width, fcCanvas.height);
      if (part) { beginGizmoDrag(part, sel, mx, my); return; }
    }
    const picked = pickCameraGizmo(mx, my, view, proj, fcCanvas.width, fcCanvas.height);
    if (picked) {
      selectedCameraId = picked.id;
      updateSelectedCameraBox();
      return;
    }
    // 何もヒットしなかった時は、これまで通りクリックで飛行を開始する
    fcCanvas.requestPointerLock();
  });

  document.addEventListener('mousemove', e => {
    if (dragState) {
      const rect = fcCanvas.getBoundingClientRect();
      applyGizmoDrag(e.clientX - rect.left, e.clientY - rect.top);
      return;
    }
    if (document.pointerLockElement !== fcCanvas) return;
    fcYaw -= e.movementX * FC_MOUSE_SENSITIVITY;
    fcPitch -= e.movementY * FC_MOUSE_SENSITIVITY;
    const limit = Math.PI / 2 - 0.05;
    fcPitch = Math.max(-limit, Math.min(limit, fcPitch));
  });

  document.addEventListener('mouseup', () => { dragState = null; });

  document.addEventListener('pointerlockchange', () => {
    const hint = document.getElementById('freecamHint');
    if (hint) hint.style.display = (document.pointerLockElement === fcCanvas) ? 'none' : 'block';
  });
}

// 右下の小窓(PinP)をクリックすると、主画面と入れ替わる
function setupPinPInset() {
  const inset = document.getElementById('pinpInset');
  inset.addEventListener('click', () => {
    if (sceneCameras.length === 0) return;
    previewIsMain = !previewIsMain;
  });
}

// カメラが1つも無い間は小窓自体を出さない(見せるものが無いため)
function updatePinPVisibility() {
  document.getElementById('pinpInset').classList.toggle('show', sceneCameras.length > 0);
}

// 選択中カメラの情報ボックス(画角スライダー+削除のヒント)の表示を更新する
function updateSelectedCameraBox() {
  const box = document.getElementById('selectedCameraBox');
  const sel = scGetSelected();
  if (!sel) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  const fovSlider = document.getElementById('selectedCamFov');
  fovSlider.value = sel.fov;
  document.getElementById('selectedCamFovValue').innerText = Math.round(sel.fov) + '°';
  fovSlider.oninput = () => {
    sel.fov = parseInt(fovSlider.value);
    document.getElementById('selectedCamFovValue').innerText = sel.fov + '°';
  };
}


// ============================================================
// 描画ループ
// ============================================================

function fcUpdateStatus() {
  const statusEl = document.getElementById('freecamStatus');
  if (!statusEl) return;
  const wx = Math.round(fcPos[0] + worldOriginX), wy = Math.round(fcPos[1] + worldOriginY), wz = Math.round(fcPos[2] + worldOriginZ);
  statusEl.innerText = `座標: (${wx}, ${wy}, ${wz})`;
}

function renderFreecam() {
  if (!fcGl) return;
  const sel = scGetSelected();
  const hasCamera = sceneCameras.length > 0;
  const editVP = _fcEditViewProj();

  // 主画面
  fcGl.viewport(0, 0, fcCanvas.width, fcCanvas.height);
  fcGl.clearColor(0.4, 0.63, 0.9, 1); // 空っぽい水色(単色描画より馴染むように)
  fcGl.clear(fcGl.COLOR_BUFFER_BIT | fcGl.DEPTH_BUFFER_BIT);

  if (previewIsMain && sel) {
    // 主画面=選択中カメラのプレビュー(固定カメラなので、ギズモは出さない)
    const { view, proj } = _camViewProj(sel, fcCanvas.width / fcCanvas.height);
    drawTerrainWithMatrices(view, proj, 0, 0, fcCanvas.width, fcCanvas.height);
    renderHumanoids(fcGl, view, proj, _fcCurTickVal());
  } else {
    // 主画面=編集用のWASD視点
    drawTerrainWithMatrices(editVP.view, editVP.proj, 0, 0, fcCanvas.width, fcCanvas.height);
    renderHumanoids(fcGl, editVP.view, editVP.proj, _fcCurTickVal());
    renderCameraGizmos(fcGl, editVP.view, editVP.proj);
    if (sel && document.pointerLockElement !== fcCanvas) {
      renderTransformGizmo(fcGl, editVP.view, editVP.proj, sel);
    }
  }

  // 右下の小窓(PinP): 主画面になっていない方を出す。見るだけで操作は不可
  if (hasCamera) {
    const vx = fcCanvas.width - PINP_W - PINP_MARGIN;
    const vy = PINP_MARGIN; // WebGLのビューポートのyは下端起点
    fcGl.enable(fcGl.SCISSOR_TEST);
    fcGl.scissor(vx, vy, PINP_W, PINP_H);
    fcGl.clearColor(0.4, 0.63, 0.9, 1);
    fcGl.clear(fcGl.COLOR_BUFFER_BIT | fcGl.DEPTH_BUFFER_BIT);
    if (previewIsMain) {
      drawTerrainWithMatrices(editVP.view, editVP.proj, vx, vy, PINP_W, PINP_H);
      renderHumanoids(fcGl, editVP.view, editVP.proj, _fcCurTickVal());
    } else if (sel) {
      const { view, proj } = _camViewProj(sel, PINP_W / PINP_H);
      drawTerrainWithMatrices(view, proj, vx, vy, PINP_W, PINP_H);
      renderHumanoids(fcGl, view, proj, _fcCurTickVal());
    }
    fcGl.disable(fcGl.SCISSOR_TEST);
  }
  fcGl.viewport(0, 0, fcCanvas.width, fcCanvas.height); // 次回のため元に戻しておく
}

// 地形の描画本体。view/proj行列とビューポート範囲を渡せば、通常の飛行画面
// 以外の別の視点(後続ステップで足すシーンエディタ・プレビュー等)からも
// 同じ呼び方で使い回せる(地形バッファ・テクスチャアトラスは1つだけ持っていて、
// 使い回している)。
function drawTerrainWithMatrices(viewMatrix, projMatrix, vx, vy, vw, vh) {
  fcGl.viewport(vx, vy, vw, vh);
  if (fcVertexCount === 0 || !fcTexture) return;

  fcGl.useProgram(fcProgram);
  fcGl.bindBuffer(fcGl.ARRAY_BUFFER, fcVbo);
  const stride = 7 * 4;
  fcGl.enableVertexAttribArray(fcAPosLoc);
  fcGl.vertexAttribPointer(fcAPosLoc, 3, fcGl.FLOAT, false, stride, 0);
  fcGl.enableVertexAttribArray(fcAUVLoc);
  fcGl.vertexAttribPointer(fcAUVLoc, 2, fcGl.FLOAT, false, stride, 12);
  fcGl.enableVertexAttribArray(fcABrightnessLoc);
  fcGl.vertexAttribPointer(fcABrightnessLoc, 1, fcGl.FLOAT, false, stride, 20);
  fcGl.enableVertexAttribArray(fcARevealTickLoc);
  fcGl.vertexAttribPointer(fcARevealTickLoc, 1, fcGl.FLOAT, false, stride, 24);

  fcGl.uniformMatrix4fv(fcUProjLoc, false, projMatrix);
  fcGl.uniformMatrix4fv(fcUViewLoc, false, viewMatrix);

  let curTickVal = Infinity;
  if (timeline && timeline.frames.length && timeline.frames[curTick]) {
    curTickVal = timeline.frames[curTick].tick;
  }
  fcGl.uniform1f(fcUCurrentTickLoc, curTickVal);

  fcGl.activeTexture(fcGl.TEXTURE0);
  fcGl.bindTexture(fcGl.TEXTURE_2D, fcTexture);
  fcGl.uniform1i(fcUTextureLoc, 0);

  fcGl.drawArrays(fcGl.TRIANGLES, 0, fcVertexCount);
}

function freecamLoop(now) {
  if (!fcActive) return;
  const dt = fcLastFrameTime ? Math.min(0.1, (now - fcLastFrameTime) / 1000) : 0;
  fcLastFrameTime = now;

  // マウスキャプチャ中(実際に飛んでる時)だけ移動キーを反映する。
  if (document.pointerLockElement === fcCanvas) {
    const { forward, right } = fcGetCameraVectors(fcYaw, fcPitch);
    const d = FC_MOVE_SPEED * dt;
    const move = (v, s) => { fcPos[0] += v[0]*s; fcPos[1] += v[1]*s; fcPos[2] += v[2]*s; };
    if (fcKeys['KeyW']) move(forward, d);
    if (fcKeys['KeyS']) move(forward, -d);
    if (fcKeys['KeyD']) move(right, d);
    if (fcKeys['KeyA']) move(right, -d);
    if (fcKeys['Space']) move([0, 1, 0], d);
    if (fcKeys['ShiftLeft'] || fcKeys['ShiftRight']) move([0, 1, 0], -d);
  }

  renderFreecam();
  fcUpdateStatus();
  if (timeline && timeline.frames.length && timeline.frames[curTick] && typeof updateFrameInfo === 'function') {
    updateFrameInfo(timeline.frames[curTick]);
  }
  if (typeof updateScrubUI === 'function') updateScrubUI();

  fcAnimId = requestAnimationFrame(freecamLoop);
}


// ============================================================
// 初期化・操作(ui.js から呼ぶ)
// ============================================================

// リプレイの読み込みが始まったタイミングで1回だけ呼ぶ
// (WebGL・テクスチャアトラスの準備、ジオメトリのリセット)
async function initFreecamOnce() {
  if (fcActive) return; // 既に初期化済み(2つ目のファイルを読み込んだ場合など)
  if (!initFreecamGL()) return;
  fcActive = true;
  fcKeys = {};
  resizeFreecamCanvas();

  // 既にジオメトリが継ぎ足され始めてる場合、今ある分をすぐアップロードしておく
  if (fcVertexData.length > 0) {
    fcGl.bindBuffer(fcGl.ARRAY_BUFFER, fcVbo);
    fcGl.bufferData(fcGl.ARRAY_BUFFER, new Float32Array(fcVertexData), fcGl.DYNAMIC_DRAW);
  }

  try {
    await ensureFreecamAtlasReady();
    fcUploadAtlasTexture();
  } catch (e) {
    console.error('テクスチャアトラスの準備に失敗しました:', e);
    document.getElementById('freecamStatus').innerText = '⚠️ テクスチャの準備に失敗しました: ' + e.message;
  }

  initEntities3D(fcGl);
  setupPinPInset();
  fcGoToPlayer();

  fcLastFrameTime = 0;
  if (fcAnimId) cancelAnimationFrame(fcAnimId);
  fcAnimId = requestAnimationFrame(freecamLoop);
}

// カメラをプレイヤーの現在位置あたりに移動する
function fcGoToPlayer() {
  if (timeline && timeline.frames.length && timeline.frames[curTick]) {
    const f = timeline.frames[curTick];
    fcPos = [f.position[0] - worldOriginX, f.position[1] - worldOriginY + 2, f.position[2] - worldOriginZ];
  }
}
