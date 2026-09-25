// freecam.js
// ============================================================
// 3D画面(地形の描画・視点の操作・カメラの操作・プレビュー)。
//
// 視点操作(Unreal Engineと同じ方式):
//   右ドラッグ(またはAlt+左ドラッグ)で見回す。押している間はWASDで移動、
//   Q/E(またはSpace/Shift)で上下、ホイールで移動速度を変える。
//   右ボタンを押していない時も、WASD/QEで移動できる(文字入力中を除く)。
//   ホイールで前後、中ボタンドラッグで平行移動。
//   左クリックは選択とギズモ操作だけ(空振りしても飛行モードに入らない)。
//   従来の「マウスを捕まえて飛ぶ」操作は、✈ボタンの飛行モードとして残してある。
//
// カメラ操作(画面左のボタン、またはキー):
//   F 新しいカメラ / G 次のポイント / K キーを記録 / V カメラ視点 / Delete 削除
//   カメラはキーフレーム方式(entities3d.js)。「今見えている構図を、
//   再生ヘッドの時刻に記録する」が基本の考え方。
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
    setStatusText('⚠️ このブラウザ/端末ではWebGLが使えません。別のブラウザ(Chrome/Firefox等)でお試しください。');
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
  const w = Math.max(1, area.clientWidth), h = Math.max(1, area.clientHeight);
  // 実際にサイズが変わった時だけ書き換える(毎回代入するとWebGLの描画バッファが
  // 毎フレーム作り直しになってしまうため)
  if (fcCanvas.width !== w || fcCanvas.height !== h) {
    fcCanvas.width = w;
    fcCanvas.height = h;
  }
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
// シーンエディタ: 画面の状態
// ============================================================
// 主画面は「編集用の視点」か「タイムラインの今の位置のプレビュー」の
// どちらか。もう片方は右下の小窓(PinP)に出る(previewIsMainで切り替え)。
let previewIsMain = false;
let dragState = null;          // ギズモをドラッグ中の情報
const PINP_W = 220, PINP_H = 140, PINP_MARGIN = 14;

// 視点操作(Unreal Engine方式)
let navLook = false;           // 右ボタン(またはAlt+左)を押して見回している最中
let navPan = false;            // 中ボタンで平行移動している最中
let mouseOverViewport = false;
let fcMoveSpeed = 12;          // 移動速度(ブロック/秒)。右ドラッグ中のホイールで変える
const FC_MIN_SPEED = 1, FC_MAX_SPEED = 200;

// カメラ視点モード(選択したカメラの目線に入って構図を直す)
// { camId, saved:{pos,yaw,pitch,fov}, dirty }
//   dirty=false の間は、毎フレームそのカメラの(再生ヘッド時刻の)構図に追従する。
//   自分で動かすと dirty=true になり、Kで記録するまでその構図を保つ。
let pilot = null;

function isFlyMode() { return !!fcCanvas && document.pointerLockElement === fcCanvas; }
// Space/Shiftを「上昇/下降」として扱う状態か(それ以外ではSpace=再生)
function isFlightControlActive() { return navLook || isFlyMode(); }

function currentViewPose() { return { pos: fcPos.slice(), yaw: fcYaw, pitch: fcPitch }; }

// 現在のfcPos/fcYaw/fcPitch/fcFovDegから、編集視点のview/proj行列を作る
function _fcEditViewProj() {
  const aspect = fcCanvas.width / Math.max(1, fcCanvas.height);
  const proj = fcMat4Perspective(fcFovDeg * Math.PI / 180, aspect, 0.1, 3000);
  const { forward } = fcGetCameraVectors(fcYaw, fcPitch);
  const center = [fcPos[0] + forward[0], fcPos[1] + forward[1], fcPos[2] + forward[2]];
  return { view: fcMat4LookAt(fcPos, center, [0, 1, 0]), proj };
}

// 配置済みカメラの、指定tickにおける view/proj 行列
function _camViewProj(cam, aspect, tick) {
  const pose = scPoseAtTick(cam, tick);
  const proj = fcMat4Perspective(cam.fov * Math.PI / 180, aspect, 0.1, 3000);
  const { forward } = fcGetCameraVectors(pose.yaw, pose.pitch);
  const center = [pose.pos[0] + forward[0], pose.pos[1] + forward[1], pose.pos[2] + forward[2]];
  return { view: fcMat4LookAt(pose.pos, center, [0, 1, 0]), proj };
}

function _fcCurTickVal() {
  if (timeline && timeline.frames.length && timeline.frames[curTick]) return timeline.frames[curTick].tick;
  return 0;
}

function _outputAspect() { return (typeof getOutputAspect === 'function') ? getOutputAspect() : 16 / 9; }

// 矩形の中に、指定した縦横比の枠をいっぱいに収める(余白は上下 or 左右)
function fitAspectRect(x, y, w, h, aspect) {
  let fw = w, fh = w / aspect;
  if (fh > h) { fh = h; fw = h * aspect; }
  return [x + (w - fw) / 2, y + (h - fh) / 2, fw, fh];
}

// プレビューを描く枠(WebGL座標=左下原点)。書き出す動画と同じ縦横比にしてある
// ので、プレビューで見えている範囲がそのまま書き出される範囲になる。
function previewRectGL(isMain) {
  const W = fcCanvas.width, H = fcCanvas.height;
  const base = isMain ? [0, 0, W, H] : [W - PINP_W - PINP_MARGIN, PINP_MARGIN, PINP_W, PINP_H];
  return fitAspectRect(base[0], base[1], base[2], base[3], _outputAspect());
}
// 同じ枠をCSS座標(左上原点)で返す(テキストの配置レイヤーを重ねる時に使う)
function previewRectCSS(isMain) {
  const [x, y, w, h] = previewRectGL(isMain);
  return { left: x, top: fcCanvas.height - (y + h), width: w, height: h };
}

// 同じ時刻に複数のカメラがある時は、奥の層を全面、手前の層を小窓で重ねる
function computeSubRects(vx, vy, vw, vh, n) {
  if (n <= 1) return [[vx, vy, vw, vh]];
  const rects = [[vx, vy, vw, vh]];
  const insetCount = n - 1;
  const insetW = Math.max(24, Math.min(vw * 0.32, (vw - (insetCount + 1) * 6) / insetCount));
  const insetH = insetW * (vh / vw);
  for (let i = 0; i < insetCount; i++) {
    const ix = vx + vw - (insetCount - i) * (insetW + 6);
    const iy = vy + vh - insetH - 6;
    rects.push([ix, iy, insetW, insetH]);
  }
  return rects;
}

function renderPreviewComposite(gl, isMain, tick) {
  const W = fcCanvas.width, H = fcCanvas.height;
  const base = isMain ? [0, 0, W, H] : [W - PINP_W - PINP_MARGIN, PINP_MARGIN, PINP_W, PINP_H];
  const [vx, vy, vw, vh] = previewRectGL(isMain);
  gl.enable(gl.SCISSOR_TEST);
  // 縦横比を合わせた余白(黒帯)
  gl.scissor(base[0], base[1], base[2], base[3]);
  gl.clearColor(0.02, 0.02, 0.03, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const active = scActiveCamerasAtTick(tick);
  if (active.length === 0) {
    // 表示するカメラが無い区間は、空であることが分かるように暗く塗っておく
    gl.scissor(vx, vy, vw, vh);
    gl.clearColor(0.07, 0.07, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    return;
  }
  const rects = computeSubRects(vx, vy, vw, vh, active.length);
  active.forEach((cam, i) => {
    const [rx, ry, rw, rh] = rects[i];
    const { view, proj } = _camViewProj(cam, rw / rh, tick);
    gl.scissor(rx, ry, rw, rh);
    gl.clearColor(0.4, 0.63, 0.9, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    drawTerrainWithMatrices(view, proj, rx, ry, rw, rh);
    renderHumanoids(gl, view, proj, _fcCurTickVal());
  });
  gl.disable(gl.SCISSOR_TEST);
}


// ============================================================
// カメラの操作(画面左のツールボタン/キーボードの両方から呼ばれる)
// ============================================================

function ensureEditView() { previewIsMain = false; }

// F: 今見えている構図で、再生ヘッドの位置に新しいカメラを置く
function actionNewCamera() {
  if (!fcActive) return;
  ensureEditView();
  if (pilot) exitPilot(false); // カメラ視点の構図のまま、新しいカメラにする
  pushUndo();
  const cam = scCreateCamera(currentViewPose(), fcFovDeg, curTick);
  selectCamera(cam.id, 0, false);
  showToast(`📷 ${scCamName(cam)}を置きました`);
}

// G: 選択中のカメラに、最後のキーの2秒後の地点として今の構図を継ぎ足す
// (飛ぶ→G→飛ぶ→G で動くショットができる)
function actionNextPoint() {
  const cam = scGetSelected();
  if (!cam) { actionNewCamera(); return; }
  ensureEditView();
  pushUndo();
  if (pilot && pilot.camId === cam.id) cam.fov = fcFovDeg;
  const idx = scAppendKey(cam, currentViewPose(), NEXT_POINT_GAP_SECONDS);
  const key = cam.keys[idx];
  seekTo(scKeyAbsTick(cam, key));
  if (pilot) pilot.dirty = false;
  selectCamera(cam.id, idx, true);
  showToast(`➕ ${scCamName(cam)}にポイント${idx + 1}を追加(${key.time.toFixed(1)}秒)`);
}

// Kを押した時に何が起きるか(ボタンのヒントと実際の動作で同じ判定を使う)
function planRecordKey(cam) {
  const s = scCamLocalSeconds(cam, curTick);
  // カメラ視点で静的ショットを直している時は、唯一のキーを更新する
  if (pilot && pilot.camId === cam.id && scCamIsStatic(cam)) return { mode: 'update', index: 0, s };
  const idx = cam.keys.findIndex(k => Math.abs(k.time - s) <= KEY_SNAP_SECONDS);
  if (idx >= 0) return { mode: 'update', index: idx, s };
  return { mode: 'add', s, convert: scCamIsStatic(cam) };
}

// K: 今見えている構図を、選択中カメラの「再生ヘッドの時刻」のキーとして記録する
function actionRecordKey() {
  const cam = scGetSelected();
  if (!cam) { actionNewCamera(); return; }
  ensureEditView();
  const plan = planRecordKey(cam);
  pushUndo();
  if (pilot && pilot.camId === cam.id) cam.fov = fcFovDeg;
  let index;
  if (plan.mode === 'update') {
    const k = cam.keys[plan.index];
    const p = currentViewPose();
    k.pos = p.pos; k.yaw = p.yaw; k.pitch = p.pitch;
    index = plan.index;
  } else {
    index = scSetKeyAt(cam, plan.s, currentViewPose()).index;
  }
  if (pilot) pilot.dirty = false;
  selectCamera(cam.id, index, true);
  if (plan.mode === 'update') showToast(`◆ ${scCamName(cam)}のポイント${index + 1}を今の構図に更新しました`);
  else if (plan.convert) showToast(`◆ ${plan.s.toFixed(1)}秒にキーを記録 — 動くショットになりました`);
  else showToast(`◆ ${plan.s.toFixed(1)}秒にキーを記録しました`);
}


// ============================================================
// カメラ視点モード(V)
// ============================================================

function togglePilot() { if (pilot) exitPilot(true); else enterPilot(); }

function enterPilot() {
  const cam = scGetSelected();
  if (!cam) { showToast('先にカメラを選んでください(画面の箱 or タイムラインのブロックをクリック)'); return; }
  if (isFlyMode()) document.exitPointerLock();
  previewIsMain = false;
  pilot = { camId: cam.id, saved: { pos: fcPos.slice(), yaw: fcYaw, pitch: fcPitch, fov: fcFovDeg }, dirty: false };
  syncPilotToCamera();
  editorChanged();
  showToast(`🎥 ${scCamName(cam)}の視点に入りました`);
}

function syncPilotToCamera() {
  const cam = scGetCamera(pilot.camId);
  if (!cam) { exitPilot(true); return; }
  const pose = scPoseAtTick(cam, curTick);
  fcPos = pose.pos.slice(); fcYaw = pose.yaw; fcPitch = pose.pitch;
  if (fcFovDeg !== cam.fov) { fcFovDeg = cam.fov; syncFovSliderUI(); }
}

function exitPilot(restoreView) {
  if (!pilot) return;
  const wasDirty = pilot.dirty;
  if (restoreView) {
    fcPos = pilot.saved.pos; fcYaw = pilot.saved.yaw; fcPitch = pilot.saved.pitch; fcFovDeg = pilot.saved.fov;
    syncFovSliderUI();
  }
  pilot = null;
  editorChanged();
  if (restoreView && wasDirty) showToast('記録していない構図の変更は破棄しました(Kで記録できます)');
}

// 視点を自分で動かした時に呼ぶ
function markViewMoved() {
  if (pilot) pilot.dirty = true;
  previewIsMain = false; // 動かしたら編集視点に戻す(プレビューは右下の小窓へ)
}

function syncFovSliderUI() {
  const s = document.getElementById('fovSlider'), v = document.getElementById('fovValue');
  if (s) s.value = Math.round(fcFovDeg);
  if (v) v.innerText = Math.round(fcFovDeg) + '°';
}


// ============================================================
// 移動・回転ギズモのドラッグ(キー1個ぶんの位置・向きを直接いじる)
// ============================================================

function beginGizmoDrag(part, point, mx, my) {
  const ray = scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg);
  dragState = {
    part, point,
    startPos: point.pos.slice(), startYaw: point.yaw, startPitch: point.pitch,
  };
  if (part.kind === 'axis') {
    dragState.axisDir = _axisVec(part.axis);
    dragState.startT = scClosestTOnLine(ray, point.pos, dragState.axisDir);
  } else if (part.kind === 'plane') {
    dragState.planeHit0 = scRayPlaneIntersect(ray, point.pos, [0, 1, 0]);
  } else if (part.kind === 'ring' && part.ring === 'yaw') {
    const hit = scRayPlaneIntersect(ray, point.pos, [0, 1, 0]);
    dragState.angle0 = hit ? Math.atan2(hit[0] - point.pos[0], hit[2] - point.pos[2]) : 0;
  } else if (part.kind === 'ring' && part.ring === 'pitch') {
    const { forward, right } = fcGetCameraVectors(point.yaw, 0);
    dragState.ringNormal = right;
    dragState.forwardAxis = forward;
    const hit = scRayPlaneIntersect(ray, point.pos, right);
    if (hit) {
      const rel = [hit[0]-point.pos[0], hit[1]-point.pos[1], hit[2]-point.pos[2]];
      dragState.angle0 = Math.atan2(rel[1], rel[0]*forward[0] + rel[2]*forward[2]);
    } else {
      dragState.angle0 = 0;
    }
  }
}

function applyGizmoDrag(mx, my) {
  if (!dragState) return;
  const point = dragState.point;
  const ray = scRayFromScreen(mx, my, fcCanvas.width, fcCanvas.height, fcPos, fcYaw, fcPitch, fcFovDeg);
  const part = dragState.part;

  if (part.kind === 'axis') {
    const t = scClosestTOnLine(ray, dragState.startPos, dragState.axisDir);
    const delta = t - dragState.startT;
    point.pos = dragState.startPos.map((v, i) => v + dragState.axisDir[i] * delta);
  } else if (part.kind === 'plane') {
    const hit = scRayPlaneIntersect(ray, dragState.startPos, [0, 1, 0]);
    if (hit && dragState.planeHit0) {
      point.pos = [
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
      point.yaw = dragState.startYaw + delta;
    }
  } else if (part.kind === 'ring' && part.ring === 'pitch') {
    const hit = scRayPlaneIntersect(ray, dragState.startPos, dragState.ringNormal);
    if (hit) {
      const rel = [hit[0]-dragState.startPos[0], hit[1]-dragState.startPos[1], hit[2]-dragState.startPos[2]];
      const angle1 = Math.atan2(rel[1], rel[0]*dragState.forwardAxis[0] + rel[2]*dragState.forwardAxis[2]);
      const delta = Math.atan2(Math.sin(angle1 - dragState.angle0), Math.cos(angle1 - dragState.angle0));
      const limit = Math.PI / 2 - 0.05;
      point.pitch = Math.max(-limit, Math.min(limit, dragState.startPitch + delta));
    }
  }
}


// ============================================================
// マウス操作
//   右ドラッグ(またはAlt+左ドラッグ): 見回す。押している間はWASD/QE/Space/Shiftで移動、
//                                      ホイールで移動速度を変える
//   ホイール: 前後に移動 / 中ドラッグ: 平行移動
//   左クリック: カメラの選択・ギズモのドラッグだけ(勝手に飛行モードに入らない)
// ============================================================

let suppressContextMenuUntil = 0; // 右ドラッグを画面の外で離した時に、右クリックメニューを出さない

function setupFreecamControls() {
  fcCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('contextmenu', (e) => {
    if (navLook || performance.now() < suppressContextMenuUntil) e.preventDefault();
  });
  // 3D画面の上に重なっているボタン類の上にいる時も「3D画面の上」として扱う
  const area = document.getElementById('freecamArea');
  area.addEventListener('mouseenter', () => { mouseOverViewport = true; });
  area.addEventListener('mouseleave', () => { mouseOverViewport = false; gizmoHoverPart = null; });
  fcCanvas.addEventListener('mousedown', onViewportMouseDown);
  document.addEventListener('mousemove', onDocMouseMove);
  document.addEventListener('mouseup', onDocMouseUp);
  fcCanvas.addEventListener('wheel', onViewportWheel, { passive: false });
  document.addEventListener('pointerlockchange', () => editorChanged());
}

function _canvasMouse(e) {
  const rect = fcCanvas.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

function onViewportMouseDown(e) {
  if (!fcActive) return;
  if (e.button === 2 || (e.button === 0 && e.altKey)) {
    e.preventDefault();
    navLook = true;
    fcCanvas.style.cursor = 'grabbing';
    return;
  }
  if (e.button === 1) { e.preventDefault(); navPan = true; fcCanvas.style.cursor = 'move'; return; }
  if (e.button !== 0) return;
  if (isFlyMode() || previewIsMain || pilot) return;

  const [mx, my] = _canvasMouse(e);
  const { view, proj } = _fcEditViewProj();
  try {
    const active = scGetActivePoint();
    if (active) {
      const part = pickTransformGizmoPart(active, mx, my, view, proj, fcCanvas.width, fcCanvas.height);
      if (part) { beginEdit(); beginGizmoDrag(part, active, mx, my); return; }
    }
    const picked = pickCameraGizmo(mx, my, view, proj, fcCanvas.width, fcCanvas.height, null);
    if (picked) {
      const cam = scGetCamera(picked.camId);
      if (cam && !scCamIsStatic(cam)) {
        if (typeof stopPlayback === 'function') stopPlayback();
        seekTo(scKeyAbsTick(cam, cam.keys[picked.keyIndex]));
      }
      selectCamera(picked.camId, picked.keyIndex, true);
      return;
    }
  } catch (err) {
    console.error('ギズモの選択処理でエラーが起きました:', err);
  }
  if (getSelectedItem()) clearSelection();
}

function onDocMouseMove(e) {
  if (dragState) {
    const [mx, my] = _canvasMouse(e);
    applyGizmoDrag(mx, my);
    return;
  }
  if (navLook || isFlyMode()) {
    if (e.movementX || e.movementY) {
      fcYaw -= e.movementX * FC_MOUSE_SENSITIVITY;
      fcPitch -= e.movementY * FC_MOUSE_SENSITIVITY;
      const limit = Math.PI / 2 - 0.05;
      fcPitch = Math.max(-limit, Math.min(limit, fcPitch));
      markViewMoved();
    }
    return;
  }
  if (navPan) {
    if (e.movementX || e.movementY) {
      const { right, up } = fcGetCameraVectors(fcYaw, fcPitch);
      const k = 2 * 10 * Math.tan(fcFovDeg * Math.PI / 360) / Math.max(1, fcCanvas.height); // 10ブロック先の1px
      for (let i = 0; i < 3; i++) fcPos[i] += -right[i] * e.movementX * k + up[i] * e.movementY * k;
      markViewMoved();
    }
    return;
  }
  // マウスが乗っているギズモの部分を光らせる
  if (mouseOverViewport && !pilot && !previewIsMain) {
    const active = scGetActivePoint();
    let hover = null, overCam = false;
    if (active) {
      const [mx, my] = _canvasMouse(e);
      const { view, proj } = _fcEditViewProj();
      hover = pickTransformGizmoPart(active, mx, my, view, proj, fcCanvas.width, fcCanvas.height);
      if (!hover) overCam = !!pickCameraGizmo(mx, my, view, proj, fcCanvas.width, fcCanvas.height, null);
    } else if (sceneCameras.length) {
      const [mx, my] = _canvasMouse(e);
      const { view, proj } = _fcEditViewProj();
      overCam = !!pickCameraGizmo(mx, my, view, proj, fcCanvas.width, fcCanvas.height, null);
    }
    gizmoHoverPart = hover;
    fcCanvas.style.cursor = hover ? 'grab' : (overCam ? 'pointer' : 'default');
  }
}

function onDocMouseUp(e) {
  if (e.button === 0 && dragState) {
    dragState = null;
    commitEdit();
    editorChanged();
  }
  if (navLook && (e.button === 2 || e.button === 0)) {
    navLook = false;
    suppressContextMenuUntil = performance.now() + 400;
  }
  if (e.button === 1) navPan = false;
  if (!navLook && !navPan && fcCanvas) fcCanvas.style.cursor = 'default';
}

function onViewportWheel(e) {
  e.preventDefault();
  if (navLook || isFlyMode()) {
    // 見回し中のホイール = 移動速度
    fcMoveSpeed = Math.max(FC_MIN_SPEED, Math.min(FC_MAX_SPEED, fcMoveSpeed * (e.deltaY < 0 ? 1.25 : 0.8)));
    showToast(`移動速度: ${fcMoveSpeed.toFixed(fcMoveSpeed < 10 ? 1 : 0)}`);
    return;
  }
  // 通常のホイール = 前後に移動(トラックパッドの細かいスクロールにも比例させる)
  const { forward } = fcGetCameraVectors(fcYaw, fcPitch);
  const amount = -(e.deltaY / 100) * Math.max(0.4, fcMoveSpeed * 0.15);
  for (let i = 0; i < 3; i++) fcPos[i] += forward[i] * amount;
  markViewMoved();
}

// 移動キーが押された時(editor-core.jsから呼ばれる)
function onMovementKeyPressed() { /* 実際の移動は毎フレームの freecamLoop で行う */ }

// ✈ 飛行モード(従来の「クリックでマウスを捕まえて飛ぶ」操作。トラックパッド向け)
function startFlyMode() {
  if (!fcCanvas) return;
  if (isFlyMode()) { document.exitPointerLock(); return; }
  previewIsMain = false;
  const p = fcCanvas.requestPointerLock();
  if (p && typeof p.catch === 'function') p.catch(() => showToast('飛行モードを開始できませんでした。画面をクリックしてから試してください'));
}


// ============================================================
// 画面左のツールボタン・右下の小窓・画面上の表示
// ============================================================

function setupToolPalette() {
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  bind('toolNewCamera', actionNewCamera);
  bind('toolNextPoint', actionNextPoint);
  bind('toolRecordKey', actionRecordKey);
  bind('toolPilot', togglePilot);
  bind('toolFly', startFlyMode);
  bind('toolDelete', deleteSelection);
  updateToolPalette();
}

function updateToolPalette() {
  const cam = scGetSelected();
  const set = (id, disabled, active) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !!disabled;
    el.classList.toggle('active', !!active);
  };
  set('toolNewCamera', false, false);
  set('toolNextPoint', false, false);
  set('toolRecordKey', false, false);
  set('toolPilot', !cam && !pilot, !!pilot);
  set('toolFly', false, isFlyMode());
  set('toolDelete', !getSelectedItem(), false);
  const sel = document.getElementById('toolSelection');
  if (sel) {
    if (cam) {
      sel.innerText = scCamIsStatic(cam) ? `選択中: ${scCamName(cam)}` :
        `選択中: ${scCamName(cam)} ◆${(selectedKeyIndex ?? 0) + 1}/${cam.keys.length}`;
    } else {
      const it = getSelectedItem();
      sel.innerText = it ? '選択中: テキスト' : '未選択';
    }
  }
}

// 右下の小窓(PinP)をクリックすると、主画面と入れ替わる
function setupPinPInset() {
  const inset = document.getElementById('pinpInset');
  inset.addEventListener('click', () => {
    if (sceneCameras.length === 0) return;
    if (pilot) exitPilot(true);
    previewIsMain = !previewIsMain;
  });
}

// カメラが1つも無い間は小窓自体を出さない(見せるものが無いため)
function updatePinPVisibility() {
  document.getElementById('pinpInset').classList.toggle('show', sceneCameras.length > 0);
}

function currentModeLabel() {
  if (pilot) { const c = scGetCamera(pilot.camId); return `🎥 ${c ? scCamName(c) : ''}の視点`; }
  if (previewIsMain) return '🎬 プレビュー表示中';
  if (isFlyMode()) return '✈ 飛行モード';
  return '自由視点';
}

// 状況に応じた、画面下の操作ヒント
function currentContextHint() {
  if (isFlyMode()) return 'WASD移動・Space上昇・Shift下降・マウスで視点 / F:カメラを置く G:次のポイント K:キー記録 / Escで終了';
  if (pilot) {
    const cam = scGetCamera(pilot.camId);
    let k = 'K: 記録';
    if (cam) {
      const p = planRecordKey(cam);
      k = p.mode === 'update' ? `K: ポイント${p.index + 1}をこの構図に更新` : `K: ${p.s.toFixed(1)}秒にキーを追加`;
    }
    return `右ドラッグ+WASDで構図を調整 → ${k} / V・Escで戻る`;
  }
  if (previewIsMain) return '書き出される映像のプレビュー / 右下の小窓クリック、または視点を動かすと編集視点に戻ります';
  const cam = scGetSelected();
  const active = scGetActivePoint();
  if (cam && active && isNearEye(active.pos)) {
    return `今いる場所が${scCamName(cam)}の位置です(自分の中にあるので見えません)。S で少し下がると、カメラとギズモが見えます / Kで記録・Gで次のポイント`;
  }
  if (cam) {
    const p = planRecordKey(cam);
    const k = p.mode === 'update' ? `K:ポイント${p.index + 1}を今の構図に更新`
      : (p.convert ? `K:${p.s.toFixed(1)}秒にキー(動くショットに)` : `K:${p.s.toFixed(1)}秒にキー`);
    return `矢印ドラッグ=移動・リング=向き / V:カメラ視点 / G:次のポイント / ${k} / Delete:削除`;
  }
  return '右ドラッグ: 見回す(押しながらWASDで移動・ホイールで速度) / ホイール: 前後 / 中ドラッグ: 平行移動 / F: ここにカメラを置く';
}

let _lastHint = '', _lastHud = '';
function updateViewportOverlays() {
  const hint = currentContextHint();
  if (hint !== _lastHint) { document.getElementById('contextHint').innerText = hint; _lastHint = hint; }

  const wx = Math.round(fcPos[0] + worldOriginX), wy = Math.round(fcPos[1] + worldOriginY), wz = Math.round(fcPos[2] + worldOriginZ);
  const hud = `${currentModeLabel()} · 速度 ${fcMoveSpeed.toFixed(fcMoveSpeed < 10 ? 1 : 0)} · (${wx}, ${wy}, ${wz})`;
  if (hud !== _lastHud) { document.getElementById('viewHud').innerText = hud; _lastHud = hud; }

  const ch = document.getElementById('freecamCrosshair');
  if (ch) ch.style.display = (navLook || isFlyMode() || pilot) ? 'block' : 'none';

  // カメラ視点モード: 書き出す縦横比の枠+三分割線
  const frame = document.getElementById('pilotFrame');
  if (frame) {
    if (pilot) {
      const [x, y, w, h] = fitAspectRect(0, 0, fcCanvas.width, fcCanvas.height, _outputAspect());
      frame.style.left = x + 'px'; frame.style.top = y + 'px';
      frame.style.width = w + 'px'; frame.style.height = h + 'px';
      frame.classList.add('show');
      const label = document.getElementById('pilotLabel');
      const text = currentModeLabel() + (pilot.dirty ? ' — 未記録の変更あり' : '');
      if (label.innerText !== text) label.innerText = text;
    } else {
      frame.classList.remove('show');
    }
  }
}


// ============================================================
// 描画ループ
// ============================================================

function renderFreecam() {
  if (!fcGl) return;
  const hasCamera = sceneCameras.length > 0;
  const editVP = _fcEditViewProj();
  const tick = curTick;
  const W = fcCanvas.width, H = fcCanvas.height;

  fcGl.viewport(0, 0, W, H);
  fcGl.clearColor(0.4, 0.63, 0.9, 1); // 空っぽい水色
  fcGl.clear(fcGl.COLOR_BUFFER_BIT | fcGl.DEPTH_BUFFER_BIT);

  if (previewIsMain) {
    renderPreviewComposite(fcGl, true, tick);
  } else {
    drawTerrainWithMatrices(editVP.view, editVP.proj, 0, 0, W, H);
    renderHumanoids(fcGl, editVP.view, editVP.proj, _fcCurTickVal());
    renderCameraGizmos(fcGl, editVP.view, editVP.proj, W, H, { hideCamId: pilot ? pilot.camId : null });
    const active = scGetActivePoint();
    if (active && !pilot && !isFlyMode() && !navLook) {
      renderTransformGizmo(fcGl, editVP.view, editVP.proj, active, W, H, dragState ? dragState.part : null);
    }
  }

  // 右下の小窓(PinP): 主画面になっていない方を出す。見るだけで操作は不可
  if (hasCamera) {
    if (previewIsMain) {
      const vx = W - PINP_W - PINP_MARGIN, vy = PINP_MARGIN;
      fcGl.enable(fcGl.SCISSOR_TEST);
      fcGl.scissor(vx, vy, PINP_W, PINP_H);
      fcGl.clearColor(0.4, 0.63, 0.9, 1);
      fcGl.clear(fcGl.COLOR_BUFFER_BIT | fcGl.DEPTH_BUFFER_BIT);
      const aspect = PINP_W / PINP_H;
      const proj = fcMat4Perspective(fcFovDeg * Math.PI / 180, aspect, 0.1, 3000);
      drawTerrainWithMatrices(editVP.view, proj, vx, vy, PINP_W, PINP_H);
      renderHumanoids(fcGl, editVP.view, proj, _fcCurTickVal());
      fcGl.disable(fcGl.SCISSOR_TEST);
    } else {
      renderPreviewComposite(fcGl, false, tick);
    }
  }
  fcGl.viewport(0, 0, W, H);
}

// 地形の描画本体。view/proj行列とビューポート範囲を渡せば、編集視点・
// プレビュー・小窓のどこからでも同じ呼び方で使い回せる。
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

// 押されている移動キーに応じて視点を動かす
function applyMovementKeys(dt) {
  if (isTypingTarget(document.activeElement) || dragState) return;
  const flight = isFlightControlActive();
  // マウスがタイムライン等の上にある時は動かさない(編集中にうっかり視点が動かないように)
  if (!flight && !mouseOverViewport) return;
  const { forward, right } = fcGetCameraVectors(fcYaw, fcPitch);
  const d = fcMoveSpeed * dt;
  let moved = false;
  const move = (v, s) => { fcPos[0] += v[0]*s; fcPos[1] += v[1]*s; fcPos[2] += v[2]*s; moved = true; };
  if (fcKeys['KeyW']) move(forward, d);
  if (fcKeys['KeyS']) move(forward, -d);
  if (fcKeys['KeyD']) move(right, d);
  if (fcKeys['KeyA']) move(right, -d);
  if (fcKeys['KeyE']) move([0, 1, 0], d);
  if (fcKeys['KeyQ']) move([0, 1, 0], -d);
  if (flight && fcKeys['Space']) move([0, 1, 0], d);
  if (flight && (fcKeys['ShiftLeft'] || fcKeys['ShiftRight'])) move([0, 1, 0], -d);
  if (moved) markViewMoved();
}

function freecamLoop(now) {
  if (!fcActive) return;
  const dt = fcLastFrameTime ? Math.min(0.1, (now - fcLastFrameTime) / 1000) : 0;
  fcLastFrameTime = now;

  // タイムラインの高さを変えた時なども、キャンバスを実際の大きさに追従させる
  resizeFreecamCanvas();
  applyMovementKeys(dt);
  // カメラ視点モードで、自分で動かしていない間はカメラの構図に追従する
  if (pilot && !pilot.dirty) syncPilotToCamera();

  try {
    renderFreecam();
  } catch (err) {
    console.error('描画中にエラーが起きました(このフレームだけスキップします):', err);
  }
  updateViewportOverlays();
  if (timeline && timeline.frames.length && timeline.frames[curTick] && typeof updateFrameInfo === 'function') {
    updateFrameInfo(timeline.frames[curTick]);
  }
  if (typeof updateScrubUI === 'function') updateScrubUI();
  if (typeof updateTextOverlayLayerRect === 'function') updateTextOverlayLayerRect();

  fcAnimId = requestAnimationFrame(freecamLoop);
}


// ============================================================
// 初期化・操作(ui.js から呼ぶ)
// ============================================================

// リプレイの読み込みが始まったタイミングで1回だけ呼ぶ
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
    // アトラスができる前に届いた面は、テクスチャの位置(UV)が決まらないまま
    // 頂点データになっている(=1マスにアトラス全体が貼られてしまう)ので、
    // アトラスができたこの時点で、今ある面を全部作り直す
    if (fcMeshFaces.length) {
      fcVertexData = [];
      _pushFaceVertices(fcMeshFaces, fcVertexData);
      _uploadFreecamVertexData();
    }
  } catch (e) {
    console.error('テクスチャアトラスの準備に失敗しました:', e);
    setStatusText('⚠️ テクスチャの準備に失敗しました: ' + e.message);
  }

  initEntities3D(fcGl);
  setupPinPInset();
  setupToolPalette();
  fcGoToPlayer();

  fcLastFrameTime = 0;
  if (fcAnimId) cancelAnimationFrame(fcAnimId);
  fcAnimId = requestAnimationFrame(freecamLoop);
}

// カメラをプレイヤーの現在位置あたりに移動する
function fcGoToPlayer() {
  if (timeline && timeline.frames.length && timeline.frames[curTick]) {
    const f = timeline.frames[curTick];
    if (pilot) exitPilot(false);
    fcPos = [f.position[0] - worldOriginX, f.position[1] - worldOriginY + 2, f.position[2] - worldOriginZ];
    markViewMoved();
  }
}
