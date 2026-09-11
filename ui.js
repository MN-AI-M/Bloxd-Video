// ui.js
// ============================================================
// 「UI(操作)」だけを担当するファイル。アップロード処理、Pyodide(ブラウザ内
// Python)の起動・呼び出し、ボタン・タイムラインバーの操作など。
// 座標計算や描画そのものは renderer.js の方を見てください。
//
// サーバーには一切通信しない。解析(デコード・map生成)は全部
// Pyodideでブラウザの中だけで行う。テクスチャもこのサイトに同梱した
// 静的ファイルからそのまま読み込む。
// ============================================================

let allTimelines = null;
let textureColors = new Map();
let playing = false, lastFrameTime = 0, animId = null;
let pyodide = null;
let pyodideReadyPromise = null;
let textureUrls = null;           // ファイル名(拡張子なし) -> Blob URL
let textureZipReadyPromise = null;

const PYTHON_FILES = [
  'avro_reader.py',
  'bloxdreplay_decode_full.py',
  'build_2d_map.py',
  'build_all_timelines.py',
  'web_glue.py',
];
const CSV_FILES = ['block_id_to_root.csv', 'asset_master.csv'];


// ============================================================
// textures.zip の読み込み・展開
// 個々のpngをリポジトリに大量コミットする代わりに、1つのzipにまとめて
// 置いておき、ブラウザ内(JSZip)で展開してBlob URLにする。
// renderer.js からも window.getTextureUrl(name) で同じものを参照できる。
// ============================================================

function ensureTexturesLoading() {
  if (!textureZipReadyPromise) {
    textureZipReadyPromise = loadTextureZip();
  }
  return textureZipReadyPromise;
}

async function loadTextureZip() {
  const res = await fetch('./textures.zip');
  if (!res.ok) throw new Error(`textures.zip の取得に失敗しました (HTTP ${res.status})`);
  const blob = await res.blob();
  const zip = await JSZip.loadAsync(blob);

  const map = new Map();
  const entries = Object.values(zip.files).filter(f => !f.dir);
  for (const entry of entries) {
    const fileBlob = await entry.async('blob');
    const url = URL.createObjectURL(fileBlob);
    // zip内にフォルダがあっても、ファイル名(拡張子抜き)だけをキーにする
    const base = entry.name.split('/').pop().replace(/\.png$/i, '');
    map.set(base, url);
  }
  textureUrls = map;
}

// renderer.js(3D一人称視点など)から同じテクスチャを参照するための入口
window.getTextureUrl = (name) => textureUrls ? textureUrls.get(name) : undefined;

// ページを開いたらすぐ裏でzipの展開も始めておく(Pyodideと並行)
ensureTexturesLoading().catch(() => {});


// ============================================================
// Pyodide(ブラウザ内Python)の初期化
// ============================================================

function ensurePyodideLoading() {
  if (!pyodideReadyPromise) {
    pyodideReadyPromise = initPyodide();
  }
  return pyodideReadyPromise;
}

async function initPyodide() {
  const statusEl = document.getElementById('uploadStatus');
  const btn = document.getElementById('processBtn');

  try {
    statusEl.innerText = 'Python環境を準備中...(初回だけ少し時間がかかります)';
    pyodide = await loadPyodide();

    statusEl.innerText = '解析用のPythonファイルを読み込み中...';
    for (const f of PYTHON_FILES) {
      const res = await fetch('./python/' + f);
      if (!res.ok) throw new Error(`${f} の取得に失敗しました (HTTP ${res.status})`);
      pyodide.FS.writeFile(f, await res.text());
    }
    for (const f of CSV_FILES) {
      const res = await fetch('./' + f);
      if (!res.ok) throw new Error(`${f} の取得に失敗しました (HTTP ${res.status})`);
      pyodide.FS.writeFile(f, await res.text());
    }
    pyodide.runPython('import web_glue');

    statusEl.innerText = '準備完了。ファイルを選んで「読み込む」を押してください。';
    btn.disabled = false;
    btn.innerText = '読み込む';
  } catch (e) {
    statusEl.innerText = 'Python環境の準備に失敗しました: ' + e.message + '\nページを再読み込みしてやり直してください。';
    btn.disabled = true;
    btn.innerText = '準備に失敗しました';
    // このPromiseを失敗のまま握り続けないよう、次回呼び出しでもう一度試せるようにする
    pyodideReadyPromise = null;
    throw e;
  }
}

// ページを開いたらすぐ裏でPyodideの準備を始めておく(体感速度のため)
// 失敗時はinitPyodide内でステータス表示を更新済みなので、ここでは
// コンソールへの未処理rejection警告を防ぐためだけにcatchしておく。
ensurePyodideLoading().catch(() => {});


// ============================================================
// アップロード〜Pyodideでの解析
// ============================================================

document.getElementById('processBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('fileInput');
  const statusEl = document.getElementById('uploadStatus');
  if (!fileInput.files.length) { statusEl.innerText = 'ファイルを選んでください'; return; }

  const file = fileInput.files[0];
  document.getElementById('processBtn').disabled = true;

  try {
    statusEl.innerText = 'Python環境の準備を待っています...';
    await ensurePyodideLoading();

    statusEl.innerText = 'リプレイを解析中...(ファイルが大きいと時間がかかります)';
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    pyodide.globals.set('_input_bytes', bytes);
    const resultJson = pyodide.runPython(
      'import web_glue\n' +
      'web_glue.process_replay_bytes(bytes(_input_bytes))'
    );
    const data = JSON.parse(resultJson);

    statusEl.innerText = '描画を準備中...';

    const palette = data.map.palette;
    const rawTiles = data.map.tiles;
    for (const t of rawTiles) {
      const p = palette[t.assetIdx] || {};
      t.root_name = p.root_name; t.texture = p.texture; t.model = p.model; t.asset_type = p.asset_type;
      if (t.layers) {
        t.layers = t.layers.map(([ly, lIdx]) => {
          const lp = palette[lIdx] || {};
          return { y: ly, root_name: lp.root_name, texture: lp.texture };
        });
      }
    }

    allTimelines = data.timelines;
    setRendererData(rawTiles);
    setupEntitySelector();

    document.getElementById('uploadScreen').classList.add('hidden');
    document.getElementById('editor').classList.add('active');
    await loadTexturesAndInit();
  } catch (e) {
    statusEl.innerText = 'エラー: ' + e.message;
    document.getElementById('processBtn').disabled = false;
  }
});


// ============================================================
// テクスチャの読み込み(色の抽出だけして、描画は塗りつぶしで軽量に行う)
// このサイトに同梱した静的ファイル(./textures/)からそのまま読む。
// ============================================================

async function loadTexturesAndInit() {
  setStatusText(`タイル数: ${tiles.length} (読み込み中...)`);
  if (tiles.length === 0) return;

  setStatusText(`タイル数: ${tiles.length} / textures.zip を展開中...`);
  try {
    await ensureTexturesLoading();
  } catch (e) {
    setStatusText(`⚠️ textures.zip の読み込みに失敗しました: ${e.message}(このサイトの./textures.zipを確認してください)`);
    textureUrls = new Map(); // 空のまま続行 → 全テクスチャがフォールバック色になる
  }

  setStatusText(`タイル数: ${tiles.length} / テクスチャ読み込み中...`);

  const neededTextures = new Set();
  for (const t of tiles) {
    if (t.texture) neededTextures.add(t.texture);
    if (t.layers) for (const l of t.layers) if (l.texture) neededTextures.add(l.texture);
  }
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 1; sampleCanvas.height = 1;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  let loaded = 0, failedCount = 0;
  const totalTextures = neededTextures.size;
  const promises = [];
  for (const texName of neededTextures) {
    const blobUrl = textureUrls.get(texName);
    const p = new Promise((resolve) => {
      if (!blobUrl) {
        // zip内にこのテクスチャが無かった(名前の不一致・未同梱など)
        textureColors.set(texName, '#a33');
        loaded++; failedCount++;
        resolve();
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          sampleCtx.drawImage(img, 0, 0, 1, 1);
          const [r, g, b] = sampleCtx.getImageData(0, 0, 1, 1).data;
          textureColors.set(texName, `rgb(${r},${g},${b})`);
        } catch (e) {
          textureColors.set(texName, '#888');
        }
        loaded++;
        setStatusText(`タイル数: ${tiles.length} / テクスチャ ${loaded}/${totalTextures}`);
        resolve();
      };
      img.onerror = () => {
        textureColors.set(texName, '#a33');
        loaded++; failedCount++;
        resolve();
      };
      img.src = blobUrl;
    });
    promises.push(p);
  }
  await Promise.all(promises);

  for (const t of tiles) {
    t._color = textureColors.get(t.texture) || ((t.asset_type === '3d_model') ? '#7a4a2a' : '#444');
    if (t.uncertain) t._color = muteColor(t._color);
    if (t.layers) for (const l of t.layers) l._color = textureColors.get(l.texture) || t._color;
  }

  if (failedCount > totalTextures * 0.3) {
    setStatusText(`⚠️ テクスチャの${failedCount}/${totalTextures}件が読み込めませんでした(textures.zipの中身を確認してください)`);
  } else {
    setStatusText(`タイル数: ${tiles.length} / 完了`);
  }

  initCanvases();
  setupTopButtons();
  drawIso();
  setupPanZoom();
  setupHover();
  setupTimelineControls();
  fitToView();
  renderPlayerMarker();
}


// ============================================================
// エンティティ選択(自分・他のプレイヤー・モブ)
// ============================================================

function setupEntitySelector() {
  const sel = document.getElementById('entitySelect');
  sel.innerHTML = '';
  const entries = Object.entries(allTimelines.entities);
  entries.sort((a, b) => {
    if (a[0] === allTimelines.localPlayerEntityId) return -1;
    if (b[0] === allTimelines.localPlayerEntityId) return 1;
    return (a[1].name || '').localeCompare(b[1].name || '');
  });
  for (const [eid, info] of entries) {
    const opt = document.createElement('option');
    opt.value = eid;
    const label = info.displayName ? `${info.name} (${info.displayName})` : (info.name || eid);
    opt.innerText = (eid === allTimelines.localPlayerEntityId ? '★ ' : '') + label;
    sel.appendChild(opt);
  }
  sel.value = allTimelines.localPlayerEntityId;
  sel.addEventListener('change', () => {
    setRendererTimeline(allTimelines.entities[sel.value]);
    document.getElementById('scrub').max = timeline.frames.length - 1;
    document.getElementById('scrub').value = 0;
    drawIso();
    renderPlayerMarker();
  });
  setRendererTimeline(allTimelines.entities[sel.value]);
}


// ============================================================
// 画面上部のボタン(全体表示・プレイヤーへ移動・視点モード切替)
// ============================================================

function setupTopButtons() {
  document.getElementById('fitBtn').onclick = () => fitToView();
  document.getElementById('gotoBtn').onclick = () => goToPlayer();
  const fovBtn = document.getElementById('fovBtn');
  fovBtn.onclick = () => {
    viewMode = (viewMode === 'radius') ? 'fov' : 'radius';
    fovBtn.innerText = (viewMode === 'radius') ? '👁 プレイヤー視点(軽量)に切替' : '🔄 周囲表示に戻す';
    drawIso();
    renderPlayerMarker();
  };
}


// ============================================================
// タイムライン操作(再生・スクラブ)
// ============================================================

function setupTimelineControls() {
  const scrub = document.getElementById('scrub');
  scrub.max = timeline.frames.length - 1;
  scrub.addEventListener('input', e => { curTick = parseInt(e.target.value); renderPlayerMarker(); });

  document.getElementById('playBtn').addEventListener('click', () => {
    playing = !playing;
    document.getElementById('playBtn').innerText = playing ? '⏸ 一時停止' : '▶ 再生';
    if (playing) { lastFrameTime = performance.now(); playTick(); }
    else if (animId) cancelAnimationFrame(animId);
  });
}

function playTick() {
  if (!playing) return;
  const now = performance.now();
  const tps = allTimelines.ticksPerSecond;
  const elapsed = (now - lastFrameTime) / 1000;
  const ticksToAdvance = Math.floor(elapsed * tps);
  if (ticksToAdvance > 0) {
    curTick = Math.min(curTick + ticksToAdvance, timeline.frames.length - 1);
    lastFrameTime = now;
    document.getElementById('scrub').value = curTick;
    renderPlayerMarker();
    if (curTick >= timeline.frames.length - 1) {
      playing = false;
      document.getElementById('playBtn').innerText = '▶ 再生';
      return;
    }
  }
  animId = requestAnimationFrame(playTick);
}


// ============================================================
// 画面表示のちょっとした更新(renderer.js から呼ばれる)
// ============================================================

function setStatusText(text) {
  document.getElementById('info').innerText = text;
}

function updateFrameInfo(f) {
  document.getElementById('frameInfo').innerText =
    `tick ${f.tick}/${timeline.frames.length-1} (${f.time}s)  ` +
    `pose=${f.pose}  held=${f.heldItemName || 'なし'}  jump=${f.jumping}  crouch=${f.crouching}`;
}
