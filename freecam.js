// freecam.js
// ============================================================
// 自由カメラ(プレイ画面のような一人称視点)モード。
// renderer.js のアイソメトリック(平行投影)表示とは完全に別の、
// 独立したWebGL描画パイプライン(本物の透視投影カメラ+実テクスチャ)。
//
// renderer.js が作った meshFaces / meshPalette / isoMinX,Y,Z を初回の
// ジオメトリとして再利用する(座標の原点も同じものを使い、数値のズレが
// 出ないようにしてある)。tick同期の「まだ置かれてないブロックを隠す」
// 仕組みも同じ考え方(頂点シェーダーでクリップ範囲外に飛ばす)を踏襲。
//
// v2: カメラが動くと、カメラの現在位置を中心にLOD(近く=フル解像度/
//     遠く=間引き)を再計算するようにした(だいたい1チャンク動くごと)。
//     録画中のプレイヤー位置基準のLOD(renderer.js側、アイソメ表示用)とは
//     別物として、自前のfcMeshFaces/fcMeshPaletteで管理している。
//
// 操作: クリックでマウスキャプチャ開始、WASDで移動、Spaceで上昇、
//       Shiftで下降、マウスで視点回転、Escでマウスキャプチャ終了。
// ============================================================

// renderer.js が作った meshFaces / meshPalette / isoMinX,Y,Z を最初のジオメトリ
// として再利用するが、カメラが動くとカメラ位置中心でLODを再計算するため、
// 自由カメラは自前のfcMeshFaces/fcMeshPaletteを持つ(renderer.js側の
// アイソメトリック表示用データとは独立させてあり、混ざらないようにしてある)。
let fcMeshFaces = null, fcMeshPalette = null;
let fcLodCenter = null;      // 最後にLODを計算した中心(ワールド座標のx,z)
let fcLodRebuilding = false; // 再計算が既に進行中かどうか(多重実行防止)

const FC_LOD_REBUILD_DISTANCE = 32; // これだけ動いたらLODを再計算する(だいたい1チャンク分)

let fcCanvas, fcGl, fcProgram, fcVbo, fcTexture;
let fcAPosLoc, fcAUVLoc, fcABrightnessLoc, fcARevealTickLoc;
let fcUViewLoc, fcUProjLoc, fcUTextureLoc, fcUCurrentTickLoc;
let fcVertexCount = 0;
let fcUVRectsRaw = null;   // texName -> [u0,v0,u1,v1] (アトラス内の位置)
let fcAtlasCanvas = null;
let fcActive = false;
let fcAnimId = null;
let fcLastFrameTime = 0;
let fcKeys = {};
let fcYaw = 0, fcPitch = 0;
let fcPos = [0, 20, 0]; // isoMinX,Y,Zからの相対座標(renderer.jsのメッシュ座標系と揃えてある)

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
    throw new Error('自由視点シェーダーのコンパイルに失敗しました: ' + info);
  }
  return s;
}

function initFreecamGL() {
  fcCanvas = document.getElementById('freecamCanvas');
  fcGl = fcCanvas.getContext('webgl') || fcCanvas.getContext('experimental-webgl');
  if (!fcGl) {
    document.getElementById('freecamStatus').innerText = '⚠️ このブラウザ/端末ではWebGLが使えないため自由視点モードは使えません。';
    return false;
  }
  const vs = fcCompileShader(fcGl.VERTEX_SHADER, FC_VERTEX_SHADER_SRC);
  const fs = fcCompileShader(fcGl.FRAGMENT_SHADER, FC_FRAGMENT_SHADER_SRC);
  fcProgram = fcGl.createProgram();
  fcGl.attachShader(fcProgram, vs);
  fcGl.attachShader(fcProgram, fs);
  fcGl.linkProgram(fcProgram);
  if (!fcGl.getProgramParameter(fcProgram, fcGl.LINK_STATUS)) {
    throw new Error('自由視点シェーダープログラムのリンクに失敗しました: ' + fcGl.getProgramInfoLog(fcProgram));
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
  window.addEventListener('resize', () => { if (fcActive) resizeFreecamCanvas(); });
  return true;
}

function resizeFreecamCanvas() {
  const overlay = document.getElementById('freecamOverlay');
  fcCanvas.width = Math.max(1, overlay.clientWidth);
  fcCanvas.height = Math.max(1, overlay.clientHeight);
}


// ============================================================
// テクスチャアトラス(実際のpngをまとめて1枚のWebGLテクスチャにする)
// ============================================================

async function fcBuildTextureAtlas() {
  const neededTextures = new Set();
  for (const p of meshPalette) if (p.texture) neededTextures.add(p.texture);
  const names = Array.from(neededTextures);

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
    const url = (typeof getTextureUrl === 'function') ? getTextureUrl(texName) : undefined;
    if (!url) return;
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
// ジオメトリ(meshFaces + UVアトラスの位置から頂点バッファを作る)
// ============================================================

function fcBuildGeometry() {
  const paletteUVRects = fcMeshPalette.map(p => (fcUVRectsRaw && fcUVRectsRaw.get(p.texture)) || [0, 0, 1, 1]);
  // FACE_OFFSETS(renderer.js)の各面の4隅(0,1,2,3)に対応するUV。
  // 面の向きごとの「正しい」貼り方までは追い込んでおらず、正方形をそのまま
  // 貼る簡易実装(石・土のような向きを気にしない見た目ならほぼ気にならない)。
  const cornerUV = [[0, 1], [1, 1], [1, 0], [0, 0]];
  const order = [0, 1, 2, 0, 2, 3];
  const verts = [];

  for (const f of fcMeshFaces) {
    const wx = f[0], wy = f[1], wz = f[2], dirCode = f[3], pIdx = f[4], scale = f[5] || 1, revealTick = f[6] || 0;
    const bx = wx - isoMinX, by = wy - isoMinY, bz = wz - isoMinZ;
    const rect = paletteUVRects[pIdx] || [0, 0, 1, 1];
    const brightness = DIR_FACTOR[dirCode];
    const offsets = FACE_OFFSETS[dirCode];
    for (const oi of order) {
      const [ox, oy, oz] = offsets[oi];
      const [cu, cv] = cornerUV[oi];
      const u = rect[0] + cu * (rect[2] - rect[0]);
      const v = rect[1] + cv * (rect[3] - rect[1]);
      verts.push(bx + ox * scale, by + oy, bz + oz * scale, u, v, brightness, revealTick);
    }
  }

  fcVertexCount = verts.length / 7;
  fcGl.bindBuffer(fcGl.ARRAY_BUFFER, fcVbo);
  fcGl.bufferData(fcGl.ARRAY_BUFFER, new Float32Array(verts), fcGl.STATIC_DRAW);
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
  if (fcLodRebuilding) return; // 「再計算中...」の表示を座標表示で上書きしないように
  const statusEl = document.getElementById('freecamStatus');
  if (!statusEl) return;
  const wx = Math.round(fcPos[0] + isoMinX), wy = Math.round(fcPos[1] + isoMinY), wz = Math.round(fcPos[2] + isoMinZ);
  statusEl.innerText = `座標: (${wx}, ${wy}, ${wz})`;
}

function renderFreecam() {
  if (!fcGl) return;
  fcGl.viewport(0, 0, fcCanvas.width, fcCanvas.height);
  fcGl.clearColor(0.4, 0.63, 0.9, 1); // 空っぽい水色(単色描画より馴染むように)
  fcGl.clear(fcGl.COLOR_BUFFER_BIT | fcGl.DEPTH_BUFFER_BIT);
  if (fcVertexCount === 0) return;

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

  const aspect = fcCanvas.width / Math.max(1, fcCanvas.height);
  const proj = fcMat4Perspective(70 * Math.PI / 180, aspect, 0.1, 3000);
  const { forward } = fcGetCameraVectors(fcYaw, fcPitch);
  const center = [fcPos[0] + forward[0], fcPos[1] + forward[1], fcPos[2] + forward[2]];
  const view = fcMat4LookAt(fcPos, center, [0, 1, 0]);

  fcGl.uniformMatrix4fv(fcUProjLoc, false, proj);
  fcGl.uniformMatrix4fv(fcUViewLoc, false, view);

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

  const { forward, right } = fcGetCameraVectors(fcYaw, fcPitch);
  const d = FC_MOVE_SPEED * dt;
  const move = (v, s) => { fcPos[0] += v[0]*s; fcPos[1] += v[1]*s; fcPos[2] += v[2]*s; };
  if (fcKeys['KeyW']) move(forward, d);
  if (fcKeys['KeyS']) move(forward, -d);
  if (fcKeys['KeyD']) move(right, d);
  if (fcKeys['KeyA']) move(right, -d);
  if (fcKeys['Space']) move([0, 1, 0], d);
  if (fcKeys['ShiftLeft'] || fcKeys['ShiftRight']) move([0, 1, 0], -d);

  renderFreecam();
  fcUpdateStatus();
  fcMaybeRebuildLOD();
  fcAnimId = requestAnimationFrame(freecamLoop);
}


// ============================================================
// カメラ位置に追従するLOD再計算
// ============================================================
// 自由カメラは今のアイソメ表示(プレイヤーが録画中に通った場所を中心にした
// LOD)とは別に、カメラ自身の現在位置を中心にLODを再計算する。
// 重いAvro/RLEデコードはやり直さず(web_glue._cached_resを使い回す)、
// 面カリングだけをカメラ位置基準でやり直す軽い処理。
// カメラがだいたい1チャンク分動くごとに1回だけ再計算する。

function fcCameraWorldXZ() {
  return [fcPos[0] + isoMinX, fcPos[2] + isoMinZ];
}

function fcMaybeRebuildLOD() {
  if (fcLodRebuilding || typeof pyodide === 'undefined' || !pyodide) return;
  const [wx, wz] = fcCameraWorldXZ();
  if (fcLodCenter &&
      Math.abs(wx - fcLodCenter[0]) < FC_LOD_REBUILD_DISTANCE &&
      Math.abs(wz - fcLodCenter[1]) < FC_LOD_REBUILD_DISTANCE) {
    return; // まだ前回の計算地点から十分近い
  }

  fcLodRebuilding = true;
  const statusEl = document.getElementById('freecamStatus');
  if (statusEl) statusEl.innerText = '周辺の地形を再計算中...';

  // setTimeoutで1回ティックを空けて、上のステータス表示を画面に反映させてから
  // 重い(同期的にメインスレッドを止める)Pyodide呼び出しを行う。
  setTimeout(() => {
    try {
      pyodide.globals.set('_fc_cam_x', wx);
      pyodide.globals.set('_fc_cam_z', wz);
      const resultJson = pyodide.runPython(
        'import web_glue\n' +
        'web_glue.rebuild_mesh_near(_fc_cam_x, _fc_cam_z)'
      );
      const data = JSON.parse(resultJson);
      fcMeshFaces = data.mesh.faces;
      fcMeshPalette = data.mesh.palette;
      fcLodCenter = [wx, wz];
      fcBuildGeometry();
    } catch (e) {
      console.error('自由カメラ: LODの再計算に失敗しました', e);
    } finally {
      fcLodRebuilding = false;
    }
  }, 0);
}


// ============================================================
// 入口(ui.js から呼ぶ)
// ============================================================

async function enterFreecam() {
  const overlay = document.getElementById('freecamOverlay');
  const statusEl = document.getElementById('freecamStatus');
  overlay.classList.add('active');
  fcActive = true;
  fcKeys = {};

  if (!fcGl) {
    if (!initFreecamGL()) { fcActive = false; return; }
  }
  resizeFreecamCanvas();

  if (!fcTexture) {
    // 初回だけ: アイソメ表示側の初期メッシュ(プレイヤーが録画中に通った
    // 場所を中心にしたLOD)を、自由カメラの初期状態としてそのまま使う。
    // 以降はカメラ自身の位置を中心に再計算していく(fcMaybeRebuildLOD)。
    fcMeshFaces = meshFaces;
    fcMeshPalette = meshPalette;
    try {
      statusEl.innerText = 'テクスチャを準備中...';
      await fcBuildTextureAtlas();
      fcUploadAtlasTexture();
      fcBuildGeometry();
      statusEl.innerText = '';
    } catch (e) {
      statusEl.innerText = '⚠️ 自由視点の準備に失敗しました: ' + e.message;
      fcActive = false;
      overlay.classList.remove('active');
      return;
    }
  }

  // プレイヤーの現在位置あたりから開始する
  if (timeline && timeline.frames.length && timeline.frames[curTick]) {
    const f = timeline.frames[curTick];
    fcPos = [f.position[0] - isoMinX, f.position[1] - isoMinY + 2, f.position[2] - isoMinZ];
    // 初期メッシュは既にこのあたりを中心にLOD計算済みなので、無駄な
    // 再計算が即座に走らないよう「計算済み」地点として記録しておく
    if (!fcLodCenter) fcLodCenter = [f.position[0], f.position[2]];
  }

  fcLastFrameTime = 0;
  if (fcAnimId) cancelAnimationFrame(fcAnimId);
  fcAnimId = requestAnimationFrame(freecamLoop);
}

function exitFreecam() {
  fcActive = false;
  if (fcAnimId) cancelAnimationFrame(fcAnimId);
  if (document.pointerLockElement === fcCanvas) document.exitPointerLock();
  document.getElementById('freecamOverlay').classList.remove('active');
}

function isFreecamActive() {
  return fcActive;
}
