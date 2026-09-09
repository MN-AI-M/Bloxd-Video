// ui.js
// ============================================================
// UIイベント・画面遷移・通信・タイムライン制御
// ============================================================

let API_URL = "";
let allTimelines = null;
let textureColors = new Map();
let playing = false, lastFrameTime = 0, animId = null;
let playbackSpeed = 1.0;

// --- 初期ロード処理 (ページ読み込み時) ---
window.addEventListener('DOMContentLoaded', () => {
  const loadingScreen = document.getElementById('loadingScreen');
  const introScreen = document.getElementById('introScreen');
  const progressBar = document.getElementById('loadingProgress');
  const tipEl = document.getElementById('loadingTip');

  const tips = [
    "リプレイファイルを読み込み中...",
    "カメラ位置を微調整できます...",
    "プレイヤー追従機能でかっこいいカットを作成！",
    "Bloxd.io リプレイスタジオへようこそ！"
  ];

  let progress = 0;
  const interval = setInterval(() => {
    progress += 25;
    progressBar.style.width = progress + '%';
    tipEl.innerText = tips[Math.floor(progress / 25) - 1] || "完了！";

    if (progress >= 100) {
      clearInterval(interval);
      setTimeout(() => {
        loadingScreen.classList.add('hidden');
        introScreen.classList.remove('hidden');
      }, 400);
    }
  }, 200);

  setupDropZone();
});

// --- ドラッグ＆ドロップ制御 ---
function setupDropZone() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const selectBtn = document.getElementById('selectFileBtn');

  selectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropZone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
}

// --- ファイル処理 ---
async function handleFile(file) {
  if (!file.name.endsWith('.bloxdreplay')) {
    alert('.bloxdreplay ファイルを選択してください。');
    return;
  }

  API_URL = document.getElementById('apiUrlInput').value.trim().replace(/\/$/, '');
  const processingOverlay = document.getElementById('processingOverlay');
  const statusEl = document.getElementById('uploadStatus');

  processingOverlay.classList.remove('hidden');
  document.getElementById('fileNameText').innerText = file.name;
  statusEl.innerText = 'サーバーにアップロード＆解析中...';

  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(API_URL + '/api/process', { method: 'POST', body: formData });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`サーバーエラー (${res.status}): ${errText}`);
    }

    statusEl.innerText = 'デコード完了。描画準備中...';
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

    await loadTexturesAndInit();

    processingOverlay.classList.add('hidden');
    document.getElementById('introScreen').classList.add('hidden');
    document.getElementById('editor').classList.remove('hidden');

  } catch (err) {
    alert('エラーが発生しました: ' + err.message);
    processingOverlay.classList.add('hidden');
  }
}

// --- テクスチャ抽出 ---
async function loadTexturesAndInit() {
  if (tiles.length === 0) return;

  const neededTextures = new Set();
  for (const t of tiles) {
    if (t.texture) neededTextures.add(t.texture);
    if (t.layers) for (const l of t.layers) if (l.texture) neededTextures.add(l.texture);
  }

  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 1; sampleCanvas.height = 1;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

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
        resolve();
      };
      img.onerror = () => {
        textureColors.set(texName, '#a33');
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

  initCanvases();
  setupTopButtons();
  drawIso();
  setupPanZoom();
  setupHover();
  setupTimelineControls();
  fitToView();
  renderPlayerMarker();
}

// --- エンティティ選択 ---
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

// --- 上部ボタン ---
function setupTopButtons() {
  document.getElementById('fitBtn').onclick = () => fitToView();
  document.getElementById('gotoBtn').onclick = () => goToPlayer();
  const fovBtn = document.getElementById('fovBtn');
  fovBtn.onclick = () => {
    viewMode = (viewMode === 'radius') ? 'fov' : 'radius';
    fovBtn.innerHTML = (viewMode === 'radius') ? '<i data-lucide="eye"></i> プレイヤー視点(軽量)' : '<i data-lucide="globe"></i> 全体表示';
    lucide.createIcons();
    drawIso();
    renderPlayerMarker();
  };
}

// --- タイムライン再生制御 ---
function setupTimelineControls() {
  const scrub = document.getElementById('scrub');
  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const speedSelect = document.getElementById('speedSelect');

  scrub.max = timeline.frames.length - 1;
  scrub.addEventListener('input', e => { curTick = parseInt(e.target.value); renderPlayerMarker(); });

  speedSelect.addEventListener('change', (e) => {
    playbackSpeed = parseFloat(e.target.value);
  });

  playBtn.addEventListener('click', () => {
    playing = !playing;
    playIcon.setAttribute('data-lucide', playing ? 'pause' : 'play');
    lucide.createIcons();
    if (playing) { lastFrameTime = performance.now(); playTick(); }
    else if (animId) cancelAnimationFrame(animId);
  });
}

function playTick() {
  if (!playing) return;
  const now = performance.now();
  const tps = allTimelines.ticksPerSecond * playbackSpeed;
  const elapsed = (now - lastFrameTime) / 1000;
  const ticksToAdvance = Math.floor(elapsed * tps);

  if (ticksToAdvance > 0) {
    curTick = Math.min(curTick + ticksToAdvance, timeline.frames.length - 1);
    lastFrameTime = now;
    document.getElementById('scrub').value = curTick;
    renderPlayerMarker();
    if (curTick >= timeline.frames.length - 1) {
      playing = false;
      document.getElementById('playIcon').setAttribute('data-lucide', 'play');
      lucide.createIcons();
      return;
    }
  }
  animId = requestAnimationFrame(playTick);
}

// --- UI状態更新 ---
function setStatusText(text) {
  document.getElementById('info').innerHTML = `<i data-lucide="info"></i> ${text}`;
  lucide.createIcons();
}

function updateFrameInfo(f) {
  const formatTime = (sec) => {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toFixed(1).padStart(4, '0');
    return `${m}:${s}`;
  };

  const totalTime = timeline.frames[timeline.frames.length - 1].time;
  document.getElementById('frameInfo').innerText = `${formatTime(f.time)} / ${formatTime(totalTime)}`;

  document.getElementById('frameTick').innerText = `${f.tick} / ${timeline.frames.length - 1}`;
  document.getElementById('frameTime').innerText = `${f.time}s`;
  document.getElementById('frameItem').innerText = f.heldItemName || 'なし';
  document.getElementById('framePose').innerText = f.pose !== undefined ? f.pose : '通常';
}
