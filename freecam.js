// freecam.js
// ============================================================
// 自由カメラ(プレイ画面のような一人称視点)。
//
// v4: アイソメトリック表示(renderer.js)を廃止し、これが唯一の
//     描画パイプラインになった。両方とも「常にフル解像度」で中身が
//     同じになったので、二重に持つ意味が無くなったため。
//     ストリーミング(build_2d_map.StreamingMeshProcessor)から届く
//     面を、届くたびにそのままこちらのジオメトリに継ぎ足す
//     (startFreecamStream / appendFreecamStreamFaces)。
//     shared.js の FACE_OFFSETS・DIR_FACTOR・worldOriginX,Y,Z・
//     timeline・curTick を共有して使う。
//
// v5: カメラワーク撮影機能を追加(GTA Vのロックスターエディターの
//     ような体験を狙った)。「🔴 記録」中は、再生を進めながら自由に
//     飛び回るだけで、その動き(位置・向き)がtickごとに記録される。
//     記録が終わったら「🎬 プレビュー」でそのカメラワークを自動再生
//     して確認でき、「💾 書き出す」でcanvasをそのままMediaRecorderで
//     録画してwebm動画としてダウンロードできる。
//     UIのオーバーレイ(照準・ステータス表示など)はcanvasの外側に
//     HTML要素として重ねてあるだけなので、書き出した動画には映り込まない。
//
// 操作: クリックでマウスキャプチャ開始、WASDで移動、Spaceで上昇、
//       Shiftで下降、マウスで視点回転、Escでマウスキャプチャ終了。
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
let fcActive = false;      // 初期化済みかどうか(今はトグルではなく、1回きりの初期化フラグ)
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
// 操作(マウスキャプチャ・キーボード)
// ============================================================

function setupFreecamControls() {
  document.addEventListener('keydown', e => { if (fcActive) fcKeys[e.code] = true; });
  document.addEventListener('keyup', e => { if (fcActive) fcKeys[e.code] = false; });

  fcCanvas.addEventListener('click', () => {
    if (fcActive) fcCanvas.requestPointerLock();
  });

  document.addEventListener('mousemove', e => {
    if (document.pointerLockElement !== fcCanvas) return;
    fcYaw -= e.movementX * FC_MOUSE_SENSITIVITY;
    fcPitch -= e.movementY * FC_MOUSE_SENSITIVITY;
    const limit = Math.PI / 2 - 0.05;
    fcPitch = Math.max(-limit, Math.min(limit, fcPitch));
  });

  document.addEventListener('pointerlockchange', () => {
    const hint = document.getElementById('freecamHint');
    if (hint) hint.style.display = (document.pointerLockElement === fcCanvas) ? 'none' : 'block';
  });
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
  fcGl.viewport(0, 0, fcCanvas.width, fcCanvas.height);
  fcGl.clearColor(0.4, 0.63, 0.9, 1); // 空っぽい水色(単色描画より馴染むように)
  fcGl.clear(fcGl.COLOR_BUFFER_BIT | fcGl.DEPTH_BUFFER_BIT);

  const aspect = fcCanvas.width / Math.max(1, fcCanvas.height);
  const proj = fcMat4Perspective(fcFovDeg * Math.PI / 180, aspect, 0.1, 3000);
  const { forward } = fcGetCameraVectors(fcYaw, fcPitch);
  const center = [fcPos[0] + forward[0], fcPos[1] + forward[1], fcPos[2] + forward[2]];
  const view = fcMat4LookAt(fcPos, center, [0, 1, 0]);

  drawTerrainWithMatrices(view, proj, 0, 0, fcCanvas.width, fcCanvas.height);
}

// 地形の描画本体。view/proj行列とビューポート範囲を渡せば、通常の飛行画面
// からも、global-setting画面のシーンビュー/プレビュー小窓からも同じ
// 呼び方で使い回せる(地形バッファ・テクスチャアトラスは1つだけ持っていて、
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

  if (gsMode) {
    // global-setting画面(オービット視点のシーンエディタ)。
    // WASD/プレビュー自動操縦とは無関係な、独立した描画・操作系統。
    renderGlobalSettingFrame();
    if (typeof updatePlayheadPosition === 'function') updatePlayheadPosition();
    fcAnimId = requestAnimationFrame(freecamLoop);
    return;
  }

  if (fcPreviewMode) {
    // カメラはタイムラインの記録済みブロックに沿って自動で動く(手動操作は無視する)
    const camState = (typeof getCameraStateAtTick === 'function') ? getCameraStateAtTick(curTick) : null;
    if (camState) {
      fcPos = camState.pos;
      fcYaw = camState.yaw;
      fcPitch = camState.pitch;
    }
  } else {
    // マウスキャプチャ中(実際に飛んでる時)だけ移動キーを反映する。
    // これをしないと、タイムライン側でSpace等のショートカットを使った時に
    // カメラも一緒に動いてしまう。
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
    if (typeof timelineRecordFrame === 'function') timelineRecordFrame();
  }

  renderFreecam();
  fcUpdateStatus();
  if (timeline && timeline.frames.length && timeline.frames[curTick] && typeof updateFrameInfo === 'function') {
    updateFrameInfo(timeline.frames[curTick]);
  }
  if (typeof updatePlayheadPosition === 'function') updatePlayheadPosition();

  // 書き出し中だけ、WebGLの描画結果とテキストを2Dキャンバスに合成する
  // (MediaRecorderはこの合成キャンバスの方を録画してる。プレビュー中は
  // 普通にfcCanvasを直接表示してるだけで、この合成は走らない)
  if (fcExporting && fcExportComposite) {
    const { canvas, ctx } = fcExportComposite;
    if (canvas.width !== fcCanvas.width || canvas.height !== fcCanvas.height) {
      canvas.width = fcCanvas.width; canvas.height = fcCanvas.height;
    }
    ctx.drawImage(fcCanvas, 0, 0);
    if (typeof drawActiveTextOverlaysToCanvas === 'function') {
      drawActiveTextOverlaysToCanvas(ctx, canvas.width, canvas.height);
    }
  }

  if (fcExporting && curTick >= fcExportEndTick) {
    fcFinishExport();
  }

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

  if (typeof initEntities3D === 'function') initEntities3D(fcGl);
  if (typeof setupGlobalSettingControls === 'function') setupGlobalSettingControls();

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


// ============================================================
// プレビュー・書き出し
// ============================================================
// ブロック単位の記録・再生ヘッドのシーク・カメラ位置の検索(全ブロック
// 横断)は timeline.js 側が担当する(timelineRecordFrame /
// getCameraStateAtTick)。ここではプレビューモードの切り替えと、
// canvasをそのままMediaRecorderで録画する書き出し処理だけを持つ。
// UIのオーバーレイ(照準・ステータス等)はcanvasの外のHTML要素なので、
// 書き出したファイルには映り込まない。

let fcPreviewMode = false;
let fcExporting = false;
let fcExportEndTick = 0;
let fcMediaRecorder = null;
let fcRecordedBlobs = [];
let fcExportComposite = null; // { canvas, ctx } — 書き出し中だけ使う、テキストを焼き込むための2Dキャンバス

// timeline.js から呼ばれる、プレビューモードの唯一の入口。
function fcSetPreviewMode(on) {
  fcPreviewMode = on;
  if (on && document.pointerLockElement === fcCanvas) document.exitPointerLock();
}

function fcStartExport() {
  if (typeof hasAnyRecordedCamera !== 'function' || !hasAnyRecordedCamera() || fcExporting) return false;
  if (typeof MediaRecorder === 'undefined' || !fcCanvas.captureStream) {
    alert('このブラウザは動画の書き出し(MediaRecorder / captureStream)に対応していないようです。最新のChrome/Firefox/Edgeでお試しください。');
    return false;
  }

  const range = overallCameraRange();
  if (!range) return false;
  fcExportEndTick = range.end;

  fcSetPreviewMode(true);
  curTick = range.start;

  // WebGLの描画結果(fcCanvas)をそのまま録画するのではなく、テキストを
  // 焼き込んだ合成キャンバスを作ってそちらを録画する(freecamLoop側で
  // 毎フレーム描き込む)。
  const compositeCanvas = document.createElement('canvas');
  compositeCanvas.width = fcCanvas.width;
  compositeCanvas.height = fcCanvas.height;
  fcExportComposite = { canvas: compositeCanvas, ctx: compositeCanvas.getContext('2d') };

  const videoStream = compositeCanvas.captureStream(30);
  const tracks = [...videoStream.getVideoTracks()];
  if (typeof ensureAudioDestination === 'function' && typeof hasAnyMusic === 'function' && hasAnyMusic()) {
    tracks.push(...ensureAudioDestination().stream.getAudioTracks());
  }
  const stream = new MediaStream(tracks);

  fcRecordedBlobs = [];
  const mimeCandidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mimeType = mimeCandidates.find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';

  try {
    fcMediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  } catch (e) {
    alert('動画の書き出し準備に失敗しました: ' + e.message);
    fcSetPreviewMode(false);
    fcExportComposite = null;
    return false;
  }
  fcMediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) fcRecordedBlobs.push(e.data); };
  fcMediaRecorder.onstop = () => {
    const blob = new Blob(fcRecordedBlobs, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bloxd-camerawork-${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    fcExportComposite = null;
    if (typeof onExportFinished === 'function') onExportFinished();
  };

  fcMediaRecorder.start();
  fcExporting = true;
  if (!isPlayingTimeline()) startTimelinePlayback();
  return true;
}

function fcFinishExport() {
  if (!fcExporting) return;
  fcExporting = false;
  fcSetPreviewMode(false);
  stopTimelinePlayback();
  if (fcMediaRecorder && fcMediaRecorder.state !== 'inactive') {
    fcMediaRecorder.stop();
  }
}


// ============================================================
// global-setting画面(Mine-imator風のシーンエディタ)
// ============================================================
// 通常の自由カメラ画面(WASDで飛ぶ、一人称視点)とは完全に別の画面。
// 左右に分割して:
//   左 = シーン編集ビュー(オービット操作。地形・人物モデル・
//        カメラギズモが見える。ここでカメラの配置を確認・選択する)
//   右 = プレビュー(選択中/現在有効なカメラが実際に見る映像。
//        「編集用の見た目」と「実際に撮れる映像」を分けて、
//        同時に見比べられるようにしてある)
// 分割位置は境界線をドラッグして調整できる。
//
// canvas・WebGLコンテキスト・地形バッファ・テクスチャアトラスは通常画面と
// 完全に共用している(2つ目のコンテキストを作ると地形データを丸ごと
// 複製することになりメモリを圧迫するため、ビューポートを分けて1フレームに
// 2回描画する方式にしてある)。

let gsMode = false;
let gsSplitRatio = 0.5; // 0〜1、シーン編集ビューが占める横幅の割合
let gsTarget = [0, 20, 0]; // オービットの注視点(worldOrigin基準のローカル座標)
let gsDistance = 60;
let gsYaw = 0, gsPitch = -0.5;
let gsDragging = false, gsLastX = 0, gsLastY = 0;
let gsDividerDragging = false;

function toggleGlobalSetting() {
  gsMode = !gsMode;
  if (gsMode) {
    if (document.pointerLockElement === fcCanvas) document.exitPointerLock();
    gsTarget = [fcPos[0], fcPos[1], fcPos[2]];
    if (typeof initEntities3D === 'function') initEntities3D(fcGl);
  }
  return gsMode;
}

function gsSceneWidth() { return Math.round(fcCanvas.width * gsSplitRatio); }

function gsGetEyePosition() {
  const cp = Math.cos(gsPitch), sp = Math.sin(gsPitch);
  const cy = Math.cos(gsYaw), sy = Math.sin(gsYaw);
  return [
    gsTarget[0] + gsDistance * cp * sy,
    gsTarget[1] + gsDistance * sp,
    gsTarget[2] + gsDistance * cp * cy,
  ];
}

// シーン編集ビュー(左側)の視点行列。ビューポート幅は分割後の左側の幅を使う
// (右側と横幅が違うので、アスペクト比もそれぞれ別々に計算する)。
function gsGetSceneMatrices() {
  const eye = gsGetEyePosition();
  const sceneW = gsSceneWidth();
  const aspect = sceneW / Math.max(1, fcCanvas.height);
  const proj = fcMat4Perspective(60 * Math.PI / 180, aspect, 0.1, 3000);
  const view = fcMat4LookAt(eye, gsTarget, [0, 1, 0]);
  return { view, proj, eye };
}

function setupGlobalSettingControls() {
  // 分割線のドラッグ(比率の調整)
  const divider = document.getElementById('gsSplitDivider');
  divider.addEventListener('mousedown', (e) => {
    if (!gsMode) return;
    e.preventDefault();
    gsDividerDragging = true;
    divider.classList.add('dragging');
  });
  document.addEventListener('mouseup', () => {
    gsDragging = false;
    if (gsDividerDragging) { gsDividerDragging = false; divider.classList.remove('dragging'); }
  });
  document.addEventListener('mousemove', (e) => {
    if (gsDividerDragging) {
      const rect = fcCanvas.getBoundingClientRect();
      gsSplitRatio = Math.max(0.15, Math.min(0.85, (e.clientX - rect.left) / rect.width));
      document.getElementById('freecamArea').style.setProperty('--gs-split', (gsSplitRatio * 100) + '%');
      return;
    }
    if (!gsMode || !gsDragging) return;
    const dx = e.clientX - gsLastX, dy = e.clientY - gsLastY;
    gsLastX = e.clientX; gsLastY = e.clientY;
    gsYaw -= dx * 0.006;
    gsPitch = Math.max(-1.5, Math.min(1.5, gsPitch - dy * 0.006));
  });

  // シーン編集ビュー(左側)だけでオービット操作を受け付ける
  fcCanvas.addEventListener('mousedown', (e) => {
    if (!gsMode || e.clientX - fcCanvas.getBoundingClientRect().left > gsSceneWidth()) return;
    gsDragging = true; gsLastX = e.clientX; gsLastY = e.clientY;
  });
  fcCanvas.addEventListener('wheel', (e) => {
    if (!gsMode) return;
    const rect = fcCanvas.getBoundingClientRect();
    if (e.clientX - rect.left > gsSceneWidth()) return; // プレビュー側はズーム対象外
    e.preventDefault();
    gsDistance = Math.max(3, Math.min(500, gsDistance * (e.deltaY < 0 ? 0.9 : 1.1)));
  }, { passive: false });

  fcCanvas.addEventListener('click', (e) => {
    if (!gsMode) return;
    const rect = fcCanvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    if (cx > gsSceneWidth()) return; // プレビュー側のクリックは無視
    const { view, proj } = gsGetSceneMatrices();
    const picked = (typeof pickCameraGizmo === 'function') ? pickCameraGizmo(cx, cy, view, proj, gsSceneWidth(), fcCanvas.height) : null;
    if (picked && typeof renderBlocks === 'function') {
      selectedBlockId = picked.id;
      renderBlocks();
    }
  });
  fcCanvas.addEventListener('dblclick', (e) => {
    if (!gsMode) return;
    const rect = fcCanvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    if (cx > gsSceneWidth()) return;
    const { view, proj } = gsGetSceneMatrices();
    const picked = (typeof pickCameraGizmo === 'function') ? pickCameraGizmo(cx, cy, view, proj, gsSceneWidth(), fcCanvas.height) : null;
    if (picked && typeof openEditPanel === 'function') openEditPanel(picked);
  });

  document.getElementById('freecamArea').style.setProperty('--gs-split', '50%');
}

function renderGlobalSettingFrame() {
  if (!fcGl) return;
  fcGl.disable(fcGl.SCISSOR_TEST);
  fcGl.viewport(0, 0, fcCanvas.width, fcCanvas.height);
  fcGl.clearColor(0.05, 0.06, 0.08, 1);
  fcGl.clear(fcGl.COLOR_BUFFER_BIT | fcGl.DEPTH_BUFFER_BIT);

  const sceneW = gsSceneWidth();
  const previewW = fcCanvas.width - sceneW;
  const h = fcCanvas.height;

  // --- 左: シーン編集ビュー(オービット) ---
  fcGl.enable(fcGl.SCISSOR_TEST);
  fcGl.scissor(0, 0, sceneW, h);
  const { view, proj } = gsGetSceneMatrices();
  drawTerrainWithMatrices(view, proj, 0, 0, sceneW, h);
  if (typeof renderHumanoids === 'function') renderHumanoids(fcGl, view, proj, curTick);
  if (typeof renderCameraGizmos === 'function') {
    renderCameraGizmos(fcGl, view, proj, typeof selectedBlockId !== 'undefined' ? selectedBlockId : null);
  }

  // --- 右: プレビュー(選択中/現在有効なカメラの実際の映像) ---
  if (previewW > 4) {
    fcGl.scissor(sceneW, 0, previewW, h);
    fcGl.clearColor(0.4, 0.63, 0.9, 1);
    fcGl.clear(fcGl.COLOR_BUFFER_BIT | fcGl.DEPTH_BUFFER_BIT);

    const camState = (typeof getCameraStateAtTick === 'function') ? getCameraStateAtTick(curTick) : null;
    if (camState) {
      const previewAspect = previewW / Math.max(1, h);
      const previewProj = fcMat4Perspective((camState.fov || 70) * Math.PI / 180, previewAspect, 0.1, 3000);
      const { forward } = fcGetCameraVectors(camState.yaw, camState.pitch);
      const previewCenter = [camState.pos[0] + forward[0], camState.pos[1] + forward[1], camState.pos[2] + forward[2]];
      const previewView = fcMat4LookAt(camState.pos, previewCenter, [0, 1, 0]);
      drawTerrainWithMatrices(previewView, previewProj, sceneW, 0, previewW, h);
    }
  }

  fcGl.disable(fcGl.SCISSOR_TEST);
}
