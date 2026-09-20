// content-blocks.js
// ============================================================
// 📝テキストブロック・🎵音楽ブロックの中身(timeline.jsが用意した
// 「トラック+ブロック」の土台に乗る、具体的な機能)。
//
// テキスト: CapCut/Canvaを参考に、3Dビューの上に直接文字を乗せて
//   ドラッグで位置を決められるようにした(内容自体は編集パネルで入力)。
// 音楽: DAW(Premiere/Audition)を参考に、ブロックの中に波形を描画し、
//   四隅のハンドルでフェードイン/アウトを設定できるようにした。
//
// 書き出し(MediaRecorder)は今までWebGLのcanvasだけを録画していたが、
// それだとテキストが映像に焼き込まれない。書き出し中だけ、WebGLの
// 描画結果+テキストを2Dキャンバスに合成してから録画するよう
// freecam.js側を変更してある(drawActiveTextOverlaysToCanvas)。
// 音楽はWeb Audio APIのMediaStreamAudioDestinationNodeを使い、
// 動画の音声トラックとして合成している。
// ============================================================

const TEXT_ANIM_PRESETS = [
  { id: 'none',  label: 'なし' },
  { id: 'fade',  label: 'フェード' },
  { id: 'slide', label: 'スライドアップ' },
  { id: 'pop',   label: 'ポップ' },
];
const TEXT_COLOR_SWATCHES = ['#ECEAE3', '#E8A33D', '#3ECF8E', '#8B7FE8', '#5B8AC9', '#FF6B6B', '#000000'];
const TEXT_ANIM_DUR_SEC = 0.4;


// ============================================================
// テキストブロック: 追加・編集パネル
// ============================================================

function addTextBlockAndEdit() {
  pushUndo();
  const start = curTick;
  const end = Math.min(totalTimelineTicks() + DEFAULT_BLOCK_TICKS, start + DEFAULT_BLOCK_TICKS);
  const block = createBlock('text', start, Math.max(end, start + 5), 'overlay', {
    content: 'テキストを入力',
    x: 0.5, y: 0.8,
    fontSize: 48,
    color: '#ECEAE3',
    weight: 800,
    anim: 'fade',
  });
  selectedBlockId = block.id;
  renderTimeline();
  openEditPanel(block);
}

function buildTextEditFields(block, body) {
  const contentRow = document.createElement('div');
  contentRow.className = 'fieldRow';
  contentRow.innerHTML = '<label>テキスト内容</label>';
  const textarea = document.createElement('textarea');
  textarea.className = 'textInput';
  textarea.rows = 2;
  textarea.value = block.data.content;
  textarea.addEventListener('input', () => {
    block.data.content = textarea.value;
    renderBlocks();
    updateActiveTextOverlays();
  });
  contentRow.appendChild(textarea);
  body.appendChild(contentRow);

  const sizeRow = document.createElement('div');
  sizeRow.className = 'fieldRow';
  sizeRow.innerHTML = '<label>文字の大きさ: <span id="textSizeVal">' + block.data.fontSize + '</span>px</label>';
  const sizeSlider = document.createElement('input');
  sizeSlider.type = 'range'; sizeSlider.min = 16; sizeSlider.max = 140; sizeSlider.value = block.data.fontSize;
  sizeSlider.addEventListener('input', () => {
    block.data.fontSize = parseInt(sizeSlider.value);
    sizeRow.querySelector('#textSizeVal').innerText = block.data.fontSize;
    updateActiveTextOverlays();
  });
  sizeRow.appendChild(sizeSlider);
  body.appendChild(sizeRow);

  const weightRow = document.createElement('div');
  weightRow.className = 'fieldRow';
  weightRow.innerHTML = '<label>太さ</label>';
  const weightWrap = document.createElement('div');
  weightWrap.className = 'segmentedRow';
  for (const [label, val] of [['標準', 400], ['太字', 800]]) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'segBtn' + (block.data.weight === val ? ' active' : '');
    b.innerText = label;
    b.onclick = () => {
      block.data.weight = val;
      weightWrap.querySelectorAll('.segBtn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      updateActiveTextOverlays();
    };
    weightWrap.appendChild(b);
  }
  weightRow.appendChild(weightWrap);
  body.appendChild(weightRow);

  const colorRow = document.createElement('div');
  colorRow.className = 'fieldRow';
  colorRow.innerHTML = '<label>色</label>';
  const swatchWrap = document.createElement('div');
  swatchWrap.className = 'swatchRow';
  for (const c of TEXT_COLOR_SWATCHES) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch' + (block.data.color.toLowerCase() === c.toLowerCase() ? ' active' : '');
    sw.style.background = c;
    sw.onclick = () => {
      block.data.color = c;
      swatchWrap.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
      sw.classList.add('active');
      updateActiveTextOverlays();
    };
    swatchWrap.appendChild(sw);
  }
  colorRow.appendChild(swatchWrap);
  body.appendChild(colorRow);

  const animRow = document.createElement('div');
  animRow.className = 'fieldRow';
  animRow.innerHTML = '<label>出現アニメーション</label>';
  const animSelect = document.createElement('select');
  animSelect.className = 'panelSelect';
  for (const p of TEXT_ANIM_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id; opt.innerText = p.label;
    if (block.data.anim === p.id) opt.selected = true;
    animSelect.appendChild(opt);
  }
  animSelect.addEventListener('change', () => { block.data.anim = animSelect.value; });
  animRow.appendChild(animSelect);
  body.appendChild(animRow);

  const hint = document.createElement('div');
  hint.className = 'panelHint';
  hint.innerText = '💡 3Dビューに表示されてるテキストをドラッグすると、位置を調整できます';
  body.appendChild(hint);
}


// ============================================================
// テキストブロック: 3Dビュー上のライブ表示(ドラッグで位置調整)
// ============================================================

function updateActiveTextOverlays() {
  const layer = document.getElementById('textOverlayLayer');
  if (!layer) return;
  const textBlocks = timelineBlocks.filter(b => b.track === 'text');
  const activeIds = new Set();

  for (const block of textBlocks) {
    if (curTick < block.startTick || curTick > block.endTick) continue;
    activeIds.add(block.id);
    let el = layer.querySelector('[data-text-block="' + block.id + '"]');
    if (!el) {
      el = document.createElement('div');
      el.className = 'textOverlayItem';
      el.dataset.textBlock = block.id;
      el.addEventListener('mousedown', (e) => startTextDrag(e, block));
      layer.appendChild(el);
    }
    el.innerText = block.data.content;
    el.style.left = (block.data.x * 100) + '%';
    el.style.top = (block.data.y * 100) + '%';
    el.style.fontSize = block.data.fontSize + 'px';
    el.style.color = block.data.color;
    el.style.fontWeight = block.data.weight;

    const { opacity, offsetYPx, scale } = textAnimState(block, freecamAreaHeight());
    el.style.opacity = opacity;
    el.style.transform = 'translate(-50%, calc(-50% + ' + offsetYPx + 'px)) scale(' + scale + ')';
  }

  layer.querySelectorAll('.textOverlayItem').forEach(el => {
    if (!activeIds.has(parseInt(el.dataset.textBlock))) el.remove();
  });
}

function freecamAreaHeight() {
  const area = document.getElementById('freecamArea');
  return area ? area.clientHeight : 600;
}

// フェード/スライド/ポップの、今この瞬間の見た目(不透明度・縦オフセット・拡大率)を計算する。
// DOM表示(updateActiveTextOverlays)と書き出し用canvas描画(drawActiveTextOverlaysToCanvas)の
// 両方から同じ計算を使い、プレビューと書き出し結果がズレないようにしてある。
function textAnimState(block, heightPx) {
  const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
  const t = (curTick - block.startTick) / tps;
  const remain = (block.endTick - curTick) / tps;
  let opacity = 1, offsetYPx = 0, scale = 1;
  if (block.data.anim === 'fade') {
    opacity = Math.max(0, Math.min(1, t / TEXT_ANIM_DUR_SEC, remain / TEXT_ANIM_DUR_SEC));
  } else if (block.data.anim === 'slide') {
    const p = Math.min(1, t / TEXT_ANIM_DUR_SEC), pOut = Math.min(1, remain / TEXT_ANIM_DUR_SEC);
    opacity = Math.max(0, Math.min(p, pOut));
    offsetYPx = (1 - Math.min(p, 1)) * (heightPx * 0.03);
  } else if (block.data.anim === 'pop') {
    const p = Math.min(1, t / TEXT_ANIM_DUR_SEC), pOut = Math.min(1, remain / TEXT_ANIM_DUR_SEC);
    opacity = Math.max(0, Math.min(p, pOut));
    scale = 0.7 + 0.3 * Math.min(p, 1);
  }
  return { opacity, offsetYPx, scale };
}

function startTextDrag(e, block) {
  e.preventDefault();
  e.stopPropagation();
  const area = document.getElementById('freecamArea');
  const move = (ev) => {
    const rect = area.getBoundingClientRect();
    block.data.x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    block.data.y = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
    updateActiveTextOverlays();
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

// 書き出し(MediaRecorder)専用: WebGLの描画結果を貼り付けた2DキャンバスにActiveなテキストを重ねて描く。
// DOM側(updateActiveTextOverlays)と見た目を揃えるため、textAnimState()を共用している。
function drawActiveTextOverlaysToCanvas(ctx, w, h) {
  const textBlocks = timelineBlocks.filter(b => b.track === 'text');
  for (const block of textBlocks) {
    if (curTick < block.startTick || curTick > block.endTick) continue;
    const { opacity, offsetYPx, scale } = textAnimState(block, h);
    if (opacity <= 0.001) continue;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(block.data.x * w, block.data.y * h + offsetYPx);
    ctx.scale(scale, scale);
    ctx.font = (block.data.weight >= 700 ? 'bold ' : '') + block.data.fontSize + 'px "Zen Kaku Gothic New", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = block.data.color;
    ctx.fillText(block.data.content, 0, 0);
    ctx.restore();
  }
}


// ============================================================
// 音楽ブロック: 音声の読み込み・波形の計算
// ============================================================

const audioBuffers = new Map();       // blockId -> AudioBuffer (undoの対象外。差し替え不要な生データなので)
const musicPlaybackState = new Map(); // blockId -> { sourceNode, gainNode, startedAtCtxTime, startedAtSourceOffset }

function ensureAudioContext() {
  if (!window._appAudioCtx) {
    window._appAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (window._appAudioCtx.state === 'suspended') window._appAudioCtx.resume();
  return window._appAudioCtx;
}

// 書き出し(MediaRecorder)に音声を流し込むための出口。プレビュー中の
// スピーカー出力とは別に、ここにも同じ音を流しておく。
function ensureAudioDestination() {
  const ctx = ensureAudioContext();
  if (!window._appAudioDest) {
    window._appAudioDest = ctx.createMediaStreamDestination();
  }
  return window._appAudioDest;
}

function addMusicBlockFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const ctx = ensureAudioContext();
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      pushUndo();
      const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
      const start = curTick;
      const durTicks = Math.max(5, Math.round(audioBuffer.duration * tps));
      const block = createBlock('music', start, start + durTicks, 'audioClip', {
        fileName: file.name,
        sourceOffset: 0,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
        peaks: computeWaveformPeaks(audioBuffer),
        sourceDuration: audioBuffer.duration,
      });
      audioBuffers.set(block.id, audioBuffer);
      selectedBlockId = block.id;
      renderTimeline();
      openEditPanel(block);
      updateExportAvailability();
    } catch (e) {
      alert('音声ファイルの読み込みに失敗しました: ' + e.message);
    }
  };
  input.click();
}

// 複製された音楽ブロックは、同じAudioBufferをそのまま共有して良い
// (Web Audio APIのAudioBufferは複数の再生に使い回せる、不変のデータ)
function onMusicBlockDuplicated(oldBlock, newBlock) {
  const buf = audioBuffers.get(oldBlock.id);
  if (buf) audioBuffers.set(newBlock.id, buf);
}

function computeWaveformPeaks(audioBuffer, numPeaks) {
  numPeaks = numPeaks || 120;
  const data = audioBuffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(data.length / numPeaks));
  const peaks = [];
  for (let i = 0; i < numPeaks; i++) {
    let max = 0;
    const start = i * blockSize;
    const end = Math.min(data.length, start + blockSize);
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  return peaks;
}


// ============================================================
// 音楽ブロック: タイムライン上の波形・フェードハンドルの描画
// ============================================================

function renderMusicBlockVisual(el, block) {
  const widthPx = Math.max(6, tickToPx(block.endTick - block.startTick));

  const canvas = document.createElement('canvas');
  canvas.className = 'tblock-wave';
  canvas.width = Math.max(1, Math.round(widthPx));
  canvas.height = 40;
  const ctx = canvas.getContext('2d');
  const peaks = block.data.peaks || [];
  if (peaks.length) {
    ctx.fillStyle = 'rgba(14,30,49,0.65)';
    const barW = canvas.width / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const h = Math.max(1, peaks[i] * canvas.height * 0.85);
      ctx.fillRect(i * barW, (canvas.height - h) / 2, Math.max(1, barW - 1), h);
    }
  }
  el.appendChild(canvas);

  // フェード範囲を薄い帯で見せる(左右それぞれ、フェード時間の割合ぶん)
  const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
  const durSec = (block.endTick - block.startTick) / tps;
  if (durSec > 0) {
    if (block.data.fadeIn > 0) {
      const w = Math.min(widthPx * 0.5, widthPx * (block.data.fadeIn / durSec));
      const fadeInEl = document.createElement('div');
      fadeInEl.className = 'tblock-fade';
      fadeInEl.style.left = '0'; fadeInEl.style.width = w + 'px';
      fadeInEl.style.background = 'linear-gradient(to right, rgba(0,0,0,0.55), rgba(0,0,0,0))';
      el.appendChild(fadeInEl);
    }
    if (block.data.fadeOut > 0) {
      const w = Math.min(widthPx * 0.5, widthPx * (block.data.fadeOut / durSec));
      const fadeOutEl = document.createElement('div');
      fadeOutEl.className = 'tblock-fade';
      fadeOutEl.style.right = '0'; fadeOutEl.style.width = w + 'px';
      fadeOutEl.style.background = 'linear-gradient(to left, rgba(0,0,0,0.55), rgba(0,0,0,0))';
      el.appendChild(fadeOutEl);
    }
  }

  const fadeInHandle = document.createElement('div');
  fadeInHandle.className = 'fadeHandle fadeInHandle';
  fadeInHandle.title = 'ドラッグしてフェードインの長さを調整';
  const fadeOutHandle = document.createElement('div');
  fadeOutHandle.className = 'fadeHandle fadeOutHandle';
  fadeOutHandle.title = 'ドラッグしてフェードアウトの長さを調整';
  el.appendChild(fadeInHandle);
  el.appendChild(fadeOutHandle);
  fadeInHandle.addEventListener('mousedown', (e) => startFadeDrag(e, block, 'in'));
  fadeOutHandle.addEventListener('mousedown', (e) => startFadeDrag(e, block, 'out'));
}

function startFadeDrag(e, block, which) {
  e.preventDefault();
  e.stopPropagation();
  pushUndo();
  const blockEl = e.target.closest('.tblock');
  const move = (ev) => {
    const rect = blockEl.getBoundingClientRect();
    const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
    const durSec = (block.endTick - block.startTick) / tps;
    if (which === 'in') {
      const px = Math.max(0, Math.min(rect.width * 0.5, ev.clientX - rect.left));
      block.data.fadeIn = Math.max(0, (px / rect.width) * durSec);
    } else {
      const px = Math.max(0, Math.min(rect.width * 0.5, rect.right - ev.clientX));
      block.data.fadeOut = Math.max(0, (px / rect.width) * durSec);
    }
    renderBlocks();
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    if (document.getElementById('editPanel').classList.contains('open') && selectedBlockId === block.id) {
      refreshEditPanelFields(block);
    }
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}


// ============================================================
// 音楽ブロック: 編集パネル
// ============================================================

function buildMusicEditFields(block, body) {
  const fileRow = document.createElement('div');
  fileRow.className = 'fieldRow';
  fileRow.innerHTML = '<label>ファイル</label><div class="value" style="font-size:13px;">' + block.data.fileName + '</div>';
  body.appendChild(fileRow);

  const volRow = document.createElement('div');
  volRow.className = 'fieldRow';
  volRow.innerHTML = '<label>音量: <span id="musicVolVal">' + Math.round(block.data.volume * 100) + '</span>%</label>';
  const volSlider = document.createElement('input');
  volSlider.type = 'range'; volSlider.min = 0; volSlider.max = 150; volSlider.value = Math.round(block.data.volume * 100);
  volSlider.addEventListener('input', () => {
    block.data.volume = parseInt(volSlider.value) / 100;
    volRow.querySelector('#musicVolVal').innerText = volSlider.value;
  });
  volRow.appendChild(volSlider);
  body.appendChild(volRow);

  const fadeRow = document.createElement('div');
  fadeRow.className = 'fieldRow';
  fadeRow.innerHTML = '<label>フェードイン ' + block.data.fadeIn.toFixed(1) + '秒 / フェードアウト ' + block.data.fadeOut.toFixed(1) + '秒</label>';
  const fadeHint = document.createElement('div');
  fadeHint.className = 'panelHint';
  fadeHint.innerText = '💡 タイムライン上のブロックの左右上端にある丸いハンドルをドラッグすると調整できます';
  fadeRow.appendChild(fadeHint);
  body.appendChild(fadeRow);

  const offsetRow = document.createElement('div');
  offsetRow.className = 'fieldRow';
  offsetRow.innerHTML = '<label>再生開始位置(元の音声の何秒目から): ' + block.data.sourceOffset.toFixed(1) + '秒 / 全' + block.data.sourceDuration.toFixed(1) + '秒</label>';
  const offsetSlider = document.createElement('input');
  offsetSlider.type = 'range'; offsetSlider.min = 0; offsetSlider.max = Math.max(0, block.data.sourceDuration - 0.1); offsetSlider.step = 0.1;
  offsetSlider.value = block.data.sourceOffset;
  offsetSlider.addEventListener('input', () => {
    block.data.sourceOffset = parseFloat(offsetSlider.value);
    offsetRow.querySelector('label').innerText = '再生開始位置(元の音声の何秒目から): ' + block.data.sourceOffset.toFixed(1) + '秒 / 全' + block.data.sourceDuration.toFixed(1) + '秒';
  });
  offsetRow.appendChild(offsetSlider);
  body.appendChild(offsetRow);
}


// ============================================================
// 音楽ブロック: 再生ヘッドと連動した再生(プレビュー・書き出し共通)
// ============================================================
// timeline.jsのupdatePlayheadPosition()から毎フレーム呼ばれる。

function syncMusicPlayback() {
  const musicBlocks = timelineBlocks.filter(b => b.track === 'music' && audioBuffers.has(b.id));
  if (musicBlocks.length === 0 && musicPlaybackState.size === 0) return; // 音楽を一度も使ってなければAudioContext自体作らない
  const ctx = ensureAudioContext();
  const playing = (typeof isPlayingTimeline === 'function') && isPlayingTimeline();
  const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
  const activeIds = new Set();

  if (playing) {
    for (const block of musicBlocks) {
      if (curTick < block.startTick || curTick >= block.endTick) continue;
      activeIds.add(block.id);
      const blockElapsed = (curTick - block.startTick) / tps;
      const wantOffset = block.data.sourceOffset + blockElapsed;
      let state = musicPlaybackState.get(block.id);
      if (!state) {
        startMusicSource(block, wantOffset);
        state = musicPlaybackState.get(block.id);
      } else {
        const expectedOffset = state.startedAtSourceOffset + (ctx.currentTime - state.startedAtCtxTime);
        if (Math.abs(expectedOffset - wantOffset) > 0.25) {
          stopMusicSource(block.id);
          startMusicSource(block, wantOffset);
          state = musicPlaybackState.get(block.id);
        }
      }
      if (state) applyFadeGain(state.gainNode, block, blockElapsed);
    }
  }

  for (const id of Array.from(musicPlaybackState.keys())) {
    if (!activeIds.has(id)) stopMusicSource(id);
  }
}

function startMusicSource(block, sourceOffset) {
  const buf = audioBuffers.get(block.id);
  if (!buf) return;
  const ctx = ensureAudioContext();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  src.connect(gain);
  gain.connect(ctx.destination);           // プレビュー中、耳で聴けるように
  gain.connect(ensureAudioDestination());  // 書き出し用ストリームにも流す
  const clampedOffset = Math.max(0, Math.min(Math.max(0, buf.duration - 0.02), sourceOffset));
  try {
    src.start(0, clampedOffset);
  } catch (e) {
    console.warn('音楽の再生開始に失敗しました:', e);
    return;
  }
  musicPlaybackState.set(block.id, {
    sourceNode: src, gainNode: gain,
    startedAtCtxTime: ctx.currentTime, startedAtSourceOffset: sourceOffset,
  });
}

function stopMusicSource(id) {
  const state = musicPlaybackState.get(id);
  if (!state) return;
  try { state.sourceNode.stop(); } catch (e) { /* 既に止まってる場合は無視 */ }
  musicPlaybackState.delete(id);
}

function applyFadeGain(gainNode, block, blockElapsedSec) {
  const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
  const durSec = (block.endTick - block.startTick) / tps;
  let g = block.data.volume;
  if (block.data.fadeIn > 0 && blockElapsedSec < block.data.fadeIn) {
    g *= Math.max(0, blockElapsedSec / block.data.fadeIn);
  }
  const remain = durSec - blockElapsedSec;
  if (block.data.fadeOut > 0 && remain < block.data.fadeOut) {
    g *= Math.max(0, remain / block.data.fadeOut);
  }
  gainNode.gain.setValueAtTime(Math.max(0, g), ensureAudioContext().currentTime);
}

function hasAnyMusic() {
  return timelineBlocks.some(b => b.track === 'music' && audioBuffers.has(b.id));
}
