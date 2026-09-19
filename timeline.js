// timeline.js
// ============================================================
// マルチトラックのブロック型タイムライン。
//
// 動画編集ソフトと同じ考え方: トラック(カメラ・テキスト・音楽・ポーズ)が
// 縦に並び、それぞれの上に「区間を持つブロック」を置く。ブロックは
// ドラッグで移動、端をつまんで伸縮、ダブルクリックで編集パネルを開く。
//
// 今回実装するのは🎥カメラトラックのみ(ブロックの種類は「フリー記録」)。
// 📝テキスト・🎵音楽・🕺ポーズは、同じ仕組みに乗せられるよう最初から
// トラックとして用意しておくが、追加ボタンは無効(近日公開)にしてある。
//
// ブロックの共通の形:
//   { id, track: 'camera'|'text'|'music'|'pose', startTick, endTick,
//     type: 'freeRecord', data: {...typeごとの中身...} }
// カメラの場合、data.cameraPath は Map<tick, {pos:[x,y,z], yaw, pitch}>
// (tickは絶対値。worldOriginX,Y,Zからの相対座標で保存する)。
// ============================================================

const TRACKS = [
  { id: 'camera', label: '🎥 カメラ',   color: '#3ECF8E', ink: '#04241A', enabled: true },
  { id: 'text',   label: '📝 テキスト', color: '#8B7FE8', ink: '#17123A', enabled: false },
  { id: 'music',  label: '🎵 音楽',    color: '#5B8AC9', ink: '#0E1E31', enabled: false },
  { id: 'pose',   label: '🕺 ポーズ',   color: '#E8A33D', ink: '#2A1B04', enabled: false },
];

let timelineBlocks = [];
let nextBlockId = 1;
let selectedBlockId = null;
let timelinePxPerTick = 3;
let activeRecordingBlockId = null;

const TRACK_ROW_HEIGHT = 46;
const LABEL_WIDTH = 96;
const DEFAULT_BLOCK_TICKS = 90; // 新規カメラブロックの初期の長さ(3秒ぶん、30fps換算)


// ============================================================
// 初期化・座標変換
// ============================================================

function initTimelineUI() {
  const tracksBody = document.getElementById('tracksBody');
  tracksBody.innerHTML = '';
  for (const track of TRACKS) {
    const row = document.createElement('div');
    row.className = 'track-row' + (track.enabled ? '' : ' disabled-track');
    row.dataset.track = track.id;

    const label = document.createElement('div');
    label.className = 'track-label';
    const name = document.createElement('span');
    name.className = 'name';
    name.innerText = track.label;
    const addBtn = document.createElement('button');
    addBtn.className = 'addBtn';
    addBtn.innerText = '＋';
    addBtn.disabled = !track.enabled;
    addBtn.title = track.enabled ? `${track.label}ブロックを追加` : '近日公開';
    if (track.enabled) {
      addBtn.style.background = track.color;
      addBtn.style.color = track.ink;
      addBtn.onclick = () => addBlockOnTrack(track.id);
    }
    label.appendChild(name);
    label.appendChild(addBtn);

    const lane = document.createElement('div');
    lane.className = 'track-lane';
    lane.dataset.track = track.id;
    if (!track.enabled) {
      const soon = document.createElement('div');
      soon.className = 'track-soon';
      soon.innerText = '近日公開';
      lane.appendChild(soon);
    }
    lane.addEventListener('mousedown', (e) => onLaneMouseDown(e, track.id, lane));

    row.appendChild(label);
    row.appendChild(lane);
    tracksBody.appendChild(row);
  }

  document.getElementById('zoomInBtn').onclick = () => setTimelineZoom(timelinePxPerTick * 1.5);
  document.getElementById('zoomOutBtn').onclick = () => setTimelineZoom(timelinePxPerTick / 1.5);

  document.getElementById('rulerTicks').parentElement.addEventListener('mousedown', (e) => {
    if (e.target.id === 'rulerTicks') onLaneMouseDown(e, null, null, true);
  });

  setupEditPanelResizer();
  document.getElementById('editPanelClose').onclick = closeEditPanel;

  renderTimeline();
}

function totalTimelineTicks() {
  const fromFrames = (timeline && timeline.frames.length) ? timeline.frames.length - 1 : 0;
  const fromBlocks = timelineBlocks.reduce((m, b) => Math.max(m, b.endTick), 0);
  return Math.max(1, fromFrames, fromBlocks);
}

function tickToPx(tick) { return tick * timelinePxPerTick; }
function pxToTick(px) { return Math.max(0, Math.round(px / timelinePxPerTick)); }

function setTimelineZoom(newPxPerTick) {
  timelinePxPerTick = Math.max(0.3, Math.min(20, newPxPerTick));
  renderTimeline();
}


// ============================================================
// 描画
// ============================================================

function renderTimeline() {
  renderRuler();
  renderBlocks();
  updatePlayheadPosition();
  updateTimecode();
}

function renderRuler() {
  const totalTicks = totalTimelineTicks();
  const widthPx = tickToPx(totalTicks);
  document.getElementById('tracksInner').style.width = (LABEL_WIDTH + widthPx) + 'px';

  const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
  const totalSeconds = totalTicks / tps;
  // だいたい80px間隔になるよう、秒の目盛り間隔を選ぶ
  const candidateSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  const pxPerSecond = timelinePxPerTick * tps;
  let step = candidateSteps.find(s => s * pxPerSecond >= 80) || candidateSteps[candidateSteps.length - 1];

  const rulerTicks = document.getElementById('rulerTicks');
  rulerTicks.innerHTML = '';
  rulerTicks.style.width = widthPx + 'px';
  for (let s = 0; s <= totalSeconds; s += step) {
    const mark = document.createElement('div');
    mark.className = 'ruler-mark';
    mark.style.left = (s * pxPerSecond) + 'px';
    mark.innerText = formatTime(s);
    rulerTicks.appendChild(mark);
  }
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateTimecode() {
  const el = document.getElementById('timecode');
  if (!el || !timeline || !allTimelines) return;
  const tps = allTimelines.ticksPerSecond || 30;
  const cur = (timeline.frames[curTick] ? timeline.frames[curTick].tick : curTick) / tps;
  const total = totalTimelineTicks() / tps;
  el.innerText = `${formatTime(cur)} / ${formatTime(total)}`;
}

function updatePlayheadPosition() {
  const ph = document.getElementById('playhead');
  if (!ph) return;
  ph.style.left = (LABEL_WIDTH + tickToPx(curTick)) + 'px';
  updateTimecode();
}

function renderBlocks() {
  for (const track of TRACKS) {
    const lane = document.querySelector(`.track-lane[data-track="${track.id}"]`);
    if (!lane) continue;
    // 既存のブロック要素を全部消してから作り直す(ブロック数はごく少数の想定なので、
    // 差分更新の複雑さより単純な全再描画を優先した)
    lane.querySelectorAll('.tblock').forEach(el => el.remove());
    const blocks = timelineBlocks.filter(b => b.track === track.id);
    for (const block of blocks) {
      lane.appendChild(buildBlockElement(block, track));
    }
  }
}

function buildBlockElement(block, track) {
  const el = document.createElement('div');
  el.className = 'tblock' + (block.id === selectedBlockId ? ' selected' : '') +
                  (block.id === activeRecordingBlockId ? ' recording-live' : '');
  el.style.left = tickToPx(block.startTick) + 'px';
  el.style.width = Math.max(6, tickToPx(block.endTick - block.startTick)) + 'px';
  el.style.background = track.color;
  el.dataset.blockId = block.id;

  const label = document.createElement('div');
  label.className = 'tblock-label';
  label.style.color = track.ink;
  label.innerText = blockDisplayName(block);
  el.appendChild(label);

  const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
  const dur = (block.endTick - block.startTick) / tps;
  const sub = document.createElement('div');
  sub.className = 'tblock-sub';
  sub.style.color = track.ink;
  sub.style.opacity = 0.75;
  sub.innerText = dur.toFixed(1) + '秒';
  el.appendChild(sub);

  const leftHandle = document.createElement('div');
  leftHandle.className = 'handle left';
  const rightHandle = document.createElement('div');
  rightHandle.className = 'handle right';
  el.appendChild(leftHandle);
  el.appendChild(rightHandle);

  leftHandle.addEventListener('mousedown', (e) => { e.stopPropagation(); startBlockDrag(e, block, 'resize-left'); });
  rightHandle.addEventListener('mousedown', (e) => { e.stopPropagation(); startBlockDrag(e, block, 'resize-right'); });
  el.addEventListener('mousedown', (e) => { if (e.target === el || e.target === label || e.target === sub) startBlockDrag(e, block, 'move'); });
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); openEditPanel(block); });

  return el;
}

function blockDisplayName(block) {
  if (block.track === 'camera') {
    if (block.id === activeRecordingBlockId) return '⏺ 記録中...';
    return block.data.cameraPath && block.data.cameraPath.size > 0 ? '🎥 カメラワーク' : '🎥 (未記録)';
  }
  return block.track;
}


// ============================================================
// ブロックの追加・削除
// ============================================================

function addBlockOnTrack(trackId) {
  const track = TRACKS.find(t => t.id === trackId);
  if (!track || !track.enabled) return;
  const start = curTick;
  const end = Math.min(totalTimelineTicks(), start + DEFAULT_BLOCK_TICKS);
  const block = {
    id: nextBlockId++,
    track: trackId,
    startTick: start,
    endTick: Math.max(end, start + 5),
    type: 'freeRecord',
    data: { cameraPath: new Map() },
  };
  timelineBlocks.push(block);
  renderTimeline();
  openEditPanel(block);
}

function deleteBlock(id) {
  if (activeRecordingBlockId === id) stopRecordingBlock();
  timelineBlocks = timelineBlocks.filter(b => b.id !== id);
  if (selectedBlockId === id) selectedBlockId = null;
  closeEditPanel();
  renderTimeline();
  if (typeof updateExportAvailability === 'function') updateExportAvailability();
}


// ============================================================
// ドラッグ(移動・伸縮)・再生ヘッドのシーク
// ============================================================

let dragState = null;

function startBlockDrag(e, block, mode) {
  e.preventDefault();
  selectedBlockId = block.id;
  renderBlocks();
  dragState = {
    mode, block,
    startX: e.clientX,
    origStart: block.startTick,
    origEnd: block.endTick,
  };
  document.addEventListener('mousemove', onBlockDragMove);
  document.addEventListener('mouseup', onBlockDragEnd);
}

function onBlockDragMove(e) {
  if (!dragState) return;
  const dTick = Math.round((e.clientX - dragState.startX) / timelinePxPerTick);
  const { block, mode, origStart, origEnd } = dragState;
  const minLen = 3;
  if (mode === 'move') {
    let newStart = origStart + dTick;
    let newEnd = origEnd + dTick;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    block.startTick = newStart;
    block.endTick = newEnd;
  } else if (mode === 'resize-left') {
    block.startTick = Math.max(0, Math.min(origEnd - minLen, origStart + dTick));
  } else if (mode === 'resize-right') {
    block.endTick = Math.max(origStart + minLen, origEnd + dTick);
  }
  renderBlocks();
  if (document.getElementById('editPanel').classList.contains('open') && selectedBlockId === block.id) {
    refreshEditPanelFields(block);
  }
}

function onBlockDragEnd() {
  dragState = null;
  document.removeEventListener('mousemove', onBlockDragMove);
  document.removeEventListener('mouseup', onBlockDragEnd);
  renderTimeline();
  if (typeof updateExportAvailability === 'function') updateExportAvailability();
}

// レーン/ルーラーの空いてる場所をクリック・ドラッグして再生ヘッドを動かす
function onLaneMouseDown(e, trackId, lane, isRuler) {
  if (e.target.closest('.tblock')) return; // ブロックの上ならブロック側の処理に任せる
  seekFromClientX(e.clientX);
  const move = (ev) => seekFromClientX(ev.clientX);
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function seekFromClientX(clientX) {
  const inner = document.getElementById('tracksInner');
  const rect = inner.getBoundingClientRect();
  const x = clientX - rect.left - LABEL_WIDTH;
  const tick = pxToTick(x);
  const maxTick = timeline ? timeline.frames.length - 1 : 0;
  curTick = Math.max(0, Math.min(maxTick, tick));
  updatePlayheadPosition();
}


// ============================================================
// ブロック編集パネル
// ============================================================

function openEditPanel(block) {
  selectedBlockId = block.id;
  renderBlocks();
  document.getElementById('editPanel').classList.add('open');
  refreshEditPanelFields(block);
}

function closeEditPanel() {
  if (activeRecordingBlockId !== null) stopRecordingBlock();
  document.getElementById('editPanel').classList.remove('open');
  selectedBlockId = null;
  renderBlocks();
}

function refreshEditPanelFields(block) {
  const track = TRACKS.find(t => t.id === block.track);
  document.getElementById('editPanelTitle').innerText = track.label + 'ブロック';

  const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
  const body = document.getElementById('editPanelBody');
  body.innerHTML = '';

  const rangeRow = document.createElement('div');
  rangeRow.className = 'fieldRow';
  rangeRow.innerHTML = `<label>区間</label><div class="value">${formatTime(block.startTick/tps)} 〜 ${formatTime(block.endTick/tps)}(${((block.endTick-block.startTick)/tps).toFixed(1)}秒)</div>`;
  body.appendChild(rangeRow);

  if (block.track === 'camera') {
    const hasPath = block.data.cameraPath && block.data.cameraPath.size > 0;
    const statusRow = document.createElement('div');
    statusRow.id = 'recordStatusLine';
    statusRow.innerText = activeRecordingBlockId === block.id
      ? '記録中... 再生ヘッドがブロックの終わりに来ると自動で止まります'
      : (hasPath ? '記録済みです。撮り直す場合はもう一度「記録」を押してください' : 'まだ記録されていません');
    body.appendChild(statusRow);

    const recordBtn = document.createElement('button');
    recordBtn.className = 'btn btn-primary';
    recordBtn.innerText = activeRecordingBlockId === block.id ? '⏹ 記録を止める' : '🔴 このブロックを記録';
    recordBtn.onclick = () => {
      if (activeRecordingBlockId === block.id) stopRecordingBlock();
      else startRecordingBlock(block.id);
      refreshEditPanelFields(block);
    };
    body.appendChild(recordBtn);

    if (hasPath) {
      const previewOneBtn = document.createElement('button');
      previewOneBtn.className = 'btn btn-ghost';
      previewOneBtn.innerText = '🎬 このブロックをプレビュー';
      previewOneBtn.onclick = () => previewSingleBlock(block);
      body.appendChild(previewOneBtn);
    }
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.id = 'deleteBlockBtn';
  deleteBtn.className = 'btn btn-ghost';
  deleteBtn.innerText = '🗑 このブロックを削除';
  deleteBtn.onclick = () => { if (confirm('このブロックを削除しますか?')) deleteBlock(block.id); };
  body.appendChild(deleteBtn);
}

function setupEditPanelResizer() {
  const resizer = document.getElementById('editPanelResizer');
  const panel = document.getElementById('editPanel');
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    resizer.classList.add('dragging');
    const startX = e.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const move = (ev) => {
      const newWidth = startWidth - (ev.clientX - startX);
      panel.style.width = Math.max(280, Math.min(720, newWidth)) + 'px';
    };
    const up = () => {
      resizer.classList.remove('dragging');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}


// ============================================================
// 記録(ブロック単位)
// ============================================================

function startRecordingBlock(blockId) {
  const block = timelineBlocks.find(b => b.id === blockId);
  if (!block || block.track !== 'camera') return;
  if (fcPreviewMode) fcSetPreviewMode(false);
  activeRecordingBlockId = blockId;
  block.data.cameraPath = new Map(); // 撮り直し(前回分は上書き)
  curTick = block.startTick;
  if (!isPlayingTimeline()) startTimelinePlayback();
  renderBlocks();
}

function stopRecordingBlock() {
  if (activeRecordingBlockId === null) return;
  const block = timelineBlocks.find(b => b.id === activeRecordingBlockId);
  activeRecordingBlockId = null;
  stopTimelinePlayback();
  renderBlocks();
  if (typeof updateExportAvailability === 'function') updateExportAvailability();
  return block;
}

// freecam.jsのfreecamLoopから、手動操作中に毎フレーム呼ばれる。
// 記録中のブロックがあれば、その区間内だけ位置を記録する。区間を超えたら
// 自動で記録を止める。
function timelineRecordFrame() {
  if (activeRecordingBlockId === null) return;
  const block = timelineBlocks.find(b => b.id === activeRecordingBlockId);
  if (!block) { activeRecordingBlockId = null; return; }
  if (curTick > block.endTick) {
    stopRecordingBlock();
    const panel = document.getElementById('editPanel');
    if (panel.classList.contains('open') && selectedBlockId === block.id) refreshEditPanelFields(block);
    return;
  }
  if (curTick < block.startTick) return;
  block.data.cameraPath.set(curTick, { pos: [fcPos[0], fcPos[1], fcPos[2]], yaw: fcYaw, pitch: fcPitch });
}


// ============================================================
// 全ブロック横断のカメラ位置検索(プレビュー・書き出しで使う)
// ============================================================

// 指定tickをカバーしてるカメラブロックを探し、その中で記録済みの
// 位置を補間して返す。無ければ、直前に有効だったブロックの最後の位置で
// 静止させる(何もカメラが無い空白区間を作らないため)。
function getCameraStateAtTick(tick) {
  const camBlocks = timelineBlocks
    .filter(b => b.track === 'camera' && b.data.cameraPath && b.data.cameraPath.size > 0)
    .sort((a, b) => a.startTick - b.startTick);
  if (camBlocks.length === 0) return null;

  let covering = camBlocks.find(b => tick >= b.startTick && tick <= b.endTick);
  let sourceBlock = covering;
  if (!sourceBlock) {
    // カバーしてるブロックが無ければ、直前に終わったブロックを使う(無ければ最初のブロック)
    const before = camBlocks.filter(b => b.endTick <= tick).sort((a, b) => b.endTick - a.endTick)[0];
    sourceBlock = before || camBlocks[0];
  }

  const sortedTicks = Array.from(sourceBlock.data.cameraPath.keys()).sort((a, b) => a - b);
  const clamped = Math.max(sortedTicks[0], Math.min(sortedTicks[sortedTicks.length - 1], tick));
  return interpolateCameraPath(sourceBlock.data.cameraPath, sortedTicks, clamped);
}

function interpolateCameraPath(pathMap, sortedTicks, tick) {
  if (pathMap.has(tick)) return pathMap.get(tick);
  if (tick <= sortedTicks[0]) return pathMap.get(sortedTicks[0]);
  const hiIdx0 = sortedTicks.length - 1;
  if (tick >= sortedTicks[hiIdx0]) return pathMap.get(sortedTicks[hiIdx0]);
  let lo = 0, hi = hiIdx0;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (sortedTicks[mid] <= tick) lo = mid; else hi = mid;
  }
  const a = pathMap.get(sortedTicks[lo]);
  const b = pathMap.get(sortedTicks[hi]);
  const span = sortedTicks[hi] - sortedTicks[lo];
  const t = span > 0 ? (tick - sortedTicks[lo]) / span : 0;
  return {
    pos: [a.pos[0]+(b.pos[0]-a.pos[0])*t, a.pos[1]+(b.pos[1]-a.pos[1])*t, a.pos[2]+(b.pos[2]-a.pos[2])*t],
    yaw: a.yaw + (b.yaw - a.yaw) * t,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
  };
}

function hasAnyRecordedCamera() {
  return timelineBlocks.some(b => b.track === 'camera' && b.data.cameraPath && b.data.cameraPath.size > 0);
}

function overallCameraRange() {
  const camBlocks = timelineBlocks.filter(b => b.track === 'camera' && b.data.cameraPath && b.data.cameraPath.size > 0);
  if (camBlocks.length === 0) return null;
  return {
    start: Math.min(...camBlocks.map(b => b.startTick)),
    end: Math.max(...camBlocks.map(b => b.endTick)),
  };
}

function previewSingleBlock(block) {
  curTick = block.startTick;
  fcSetPreviewMode(true);
  if (!isPlayingTimeline()) startTimelinePlayback();
}
