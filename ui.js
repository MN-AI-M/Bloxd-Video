// ui.js
// ============================================================
// 「UI(操作)」だけを担当するファイル。アップロード処理、サーバーとの
// 通信、ボタン・タイムラインバーの操作など。座標計算や描画そのものは
// renderer.js の方を見てください。
// ============================================================

let API_URL = "";
let allTimelines = null; // サーバーから受け取った { entities: {...}, ticksPerSecond, ... }
let textureColors = new Map();
let playing = false, lastFrameTime = 0, animId = null;


// ============================================================
// アップロード〜サーバー通信
// ============================================================

document.getElementById('processBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('fileInput');
  const statusEl = document.getElementById('uploadStatus');
  if (!fileInput.files.length) { statusEl.innerText = 'ファイルを選んでください'; return; }

  API_URL = document.getElementById('apiUrlInput').value.trim().replace(/\/$/, '');
  if (!API_URL) { statusEl.innerText = '解析サーバーURLを入力してください'; return; }

  const file = fileInput.files[0];
  document.getElementById('processBtn').disabled = true;
  statusEl.innerText = 'アップロード中... (サーバーが寝てる場合、起動に数十秒かかることがあります)';

  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(API_URL + '/api/process', { method: 'POST', body: formData });
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`サーバーエラー (${res.status}): ${errBody}`);
    }
    statusEl.innerText = '解析データを受信、描画を準備中...';
    const data = await res.json();

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
// ============================================================

async function loadTexturesAndInit() {
  setStatusText(`タイル数: ${tiles.length} (読み込み中...)`);
  if (tiles.length === 0) return;

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
    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
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
      img.src = API_URL + '/assets/textures/' + encodeURIComponent(texName) + '.png';
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
    setStatusText(`⚠️ テクスチャの${failedCount}/${totalTextures}件が読み込めませんでした(サーバー側のtextures/フォルダを確認してください)`);
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
