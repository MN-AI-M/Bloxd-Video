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
//
// v2: 操作感の見直し。
//  - 🎥トラックの「＋」は、ブロックを作るだけでなく即座に記録も始める
//    (今まで「＋→パネルを開く→記録ボタン」と3手かかっていたのを1手に)
//  - 撮影中/プレビュー中は3Dビューの中央上にも表示する(タイムラインを
//    見なくても分かるように)
//  - ブロックの移動・伸縮は、他のブロックの端や再生ヘッドにスナップする
//  - Ctrl/Cmd+Z で元に戻せる(ブロックの追加・削除・移動・伸縮を記録)
//  - Delete/Backspaceで選択中のブロックを削除、Escでパネルを閉じる、
//    Ctrl/Cmd+スクロールでズーム(これらは自由カメラを操作してない時だけ
//    有効にしてあり、WASD等とはぶつからない)
//  - 選択したブロックにミニツールバー(編集・複製・削除)を出す
// ============================================================

const TRACKS = [
  { id: 'camera', label: '🎥 カメラ',   color: '#3ECF8E', ink: '#04241A', enabled: true },
  { id: 'text',   label: '📝 テキスト', color: '#8B7FE8', ink: '#17123A', enabled: true },
  { id: 'music',  label: '🎵 音楽',    color: '#5B8AC9', ink: '#0E1E31', enabled: true },
  { id: 'pose',   label: '🕺 ポーズ',   color: '#E8A33D', ink: '#2A1B04', enabled: false },
];

let timelineBlocks = [];
let nextBlockId = 1;
let selectedBlockId = null;
let timelinePxPerTick = 3;
let activeRecordingBlockId = null;

const LABEL_WIDTH = 96;
const DEFAULT_BLOCK_TICKS = 90;   // 新規カメラブロックの初期の長さ(3秒ぶん、30fps換算)
const SNAP_PX = 8;                // この距離(画素)以内なら吸着する


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
    addBtn.title = track.enabled ? (track.label + 'の記録を、再生ヘッドの位置からすぐ始めます') : '近日公開';
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
    lane.addEventListener('mousedown', (e) => onLaneMouseDown(e));

    row.appendChild(label);
    row.appendChild(lane);
    tracksBody.appendChild(row);
  }

  document.getElementById('zoomInBtn').onclick = () => setTimelineZoom(timelinePxPerTick * 1.5);
  document.getElementById('zoomOutBtn').onclick = () => setTimelineZoom(timelinePxPerTick / 1.5);
  document.getElementById('undoBtn').onclick = performUndo;

  document.getElementById('rulerRow').addEventListener('mousedown', (e) => {
    if (e.target.id === 'rulerTicks') onLaneMouseDown(e);
  });

  document.getElementById('tracksScroll').addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // 普通のスクロールは邪魔しない。Ctrl/Cmd+スクロールだけズーム
    e.preventDefault();
    const rect = document.getElementById('tracksInner').getBoundingClientRect();
    const tickUnderCursor = pxToTick(e.clientX - rect.left - LABEL_WIDTH);
    setTimelineZoom(timelinePxPerTick * (e.deltaY < 0 ? 1.15 : 1 / 1.15), tickUnderCursor, e.clientX - rect.left);
  }, { passive: false });

  setupEditPanelResizer();
  document.getElementById('editPanelClose').onclick = closeEditPanel;
  setupTimelineKeyboardShortcuts();

  renderTimeline();
  updateUndoButton();
}

function totalTimelineTicks() {
  const fromFrames = (timeline && timeline.frames.length) ? timeline.frames.length - 1 : 0;
  const fromBlocks = timelineBlocks.reduce((m, b) => Math.max(m, b.endTick), 0);
  return Math.max(1, fromFrames, fromBlocks);
}

function tickToPx(tick) { return tick * timelinePxPerTick; }
function pxToTick(px) { return Math.max(0, Math.round(px / timelinePxPerTick)); }

function setTimelineZoom(newPxPerTick, anchorTick, anchorPx) {
  const old = timelinePxPerTick;
  timelinePxPerTick = Math.max(0.3, Math.min(20, newPxPerTick));
  renderTimeline();
  // アンカー(だいたいマウス位置)が画面上で動かないよう、スクロール位置を補正する
  if (anchorTick !== undefined && old !== timelinePxPerTick) {
    const scroller = document.getElementById('tracksScroll');
    const newPx = tickToPx(anchorTick);
    scroller.scrollLeft = Math.max(0, newPx - anchorPx + LABEL_WIDTH);
  }
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
  return m + ':' + String(s).padStart(2, '0');
}

function updateTimecode() {
  const el = document.getElementById('timecode');
  if (!el || !timeline || !allTimelines) return;
  const tps = allTimelines.ticksPerSecond || 30;
  const cur = (timeline.frames[curTick] ? timeline.frames[curTick].tick : curTick) / tps;
  const total = totalTimelineTicks() / tps;
  el.innerText = formatTime(cur) + ' / ' + formatTime(total);
}

function updatePlayheadPosition() {
  const ph = document.getElementById('playhead');
  if (!ph) return;
  ph.style.left = (LABEL_WIDTH + tickToPx(curTick)) + 'px';
  updateTimecode();
  updateViewportIndicator();
  if (typeof updateActiveTextOverlays === 'function') updateActiveTextOverlays();
  if (typeof syncMusicPlayback === 'function') syncMusicPlayback();
}

function renderBlocks() {
  for (const track of TRACKS) {
    const lane = document.querySelector('.track-lane[data-track="' + track.id + '"]');
    if (!lane) continue;
    lane.querySelectorAll('.tblock').forEach(el => el.remove());
    const blocks = timelineBlocks.filter(b => b.track === track.id);
    for (const block of blocks) {
      lane.appendChild(buildBlockElement(block, track));
    }
  }
}

function buildBlockElement(block, track) {
  const el = document.createElement('div');
  const isSelected = block.id === selectedBlockId;
  el.className = 'tblock' + (isSelected ? ' selected' : '') +
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
  el.addEventListener('mousedown', (e) => { if (e.target === el || e.target === label || e.target === sub || e.target.classList.contains('tblock-wave')) startBlockDrag(e, block, 'move'); });
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); openEditPanel(block); });

  if (block.track === 'music' && typeof renderMusicBlockVisual === 'function') renderMusicBlockVisual(el, block);

  if (isSelected) el.appendChild(buildBlockToolbar(block));

  return el;
}

// 選択中のブロックの上に出す、編集・複製・削除のミニツールバー。
// ダブルクリックを知らなくても、ここから同じ操作にすぐ辿り着けるようにする。
function buildBlockToolbar(block) {
  const bar = document.createElement('div');
  bar.className = 'tblock-toolbar';
  const mk = (icon, title, fn) => {
    const b = document.createElement('button');
    b.innerText = icon; b.title = title;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    b.onmousedown = (e) => e.stopPropagation();
    return b;
  };
  bar.appendChild(mk('✎', '編集パネルを開く', () => openEditPanel(block)));
  bar.appendChild(mk('⧉', '複製', () => duplicateBlock(block.id)));
  bar.appendChild(mk('🗑', '削除', () => { if (confirm('このブロックを削除しますか?')) deleteBlock(block.id); }));
  return bar;
}

function blockDisplayName(block) {
  if (block.track === 'camera') {
    if (block.id === activeRecordingBlockId) return '⏺ 記録中...';
    return block.data.cameraPath && block.data.cameraPath.size > 0 ? '🎥 カメラワーク' : '🎥 (未記録)';
  }
  if (block.track === 'text') {
    return block.data.content ? block.data.content : '📝 (空のテキスト)';
  }
  if (block.track === 'music') {
    return block.data.fileName ? '🎵 ' + block.data.fileName : '🎵 音楽';
  }
  return block.track;
}


// ============================================================
// ブロックの追加・複製・削除
// ============================================================

function createBlock(trackId, startTick, endTick, type, data) {
  const block = { id: nextBlockId++, track: trackId, startTick, endTick, type, data };
  timelineBlocks.push(block);
  return block;
}

// 「＋」を押した瞬間に始まる操作は、トラックの種類ごとに一番自然な
// ものにしてある(カメラ=即記録、テキスト=すぐ入力、音楽=すぐファイル選択)。
function addBlockOnTrack(trackId) {
  const track = TRACKS.find(t => t.id === trackId);
  if (!track || !track.enabled) return;
  if (trackId === 'camera') {
    pushUndo();
    const start = curTick;
    const end = Math.min(totalTimelineTicks() + DEFAULT_BLOCK_TICKS, start + DEFAULT_BLOCK_TICKS);
    const block = createBlock('camera', start, Math.max(end, start + 5), 'freeRecord', { cameraPath: new Map() });
    selectedBlockId = block.id;
    renderTimeline();
    startRecordingBlock(block.id);
  } else if (trackId === 'text' && typeof addTextBlockAndEdit === 'function') {
    addTextBlockAndEdit();
  } else if (trackId === 'music' && typeof addMusicBlockFromFile === 'function') {
    addMusicBlockFromFile();
  }
}

function duplicateBlock(id) {
  const block = timelineBlocks.find(b => b.id === id);
  if (!block) return;
  pushUndo();
  const len = block.endTick - block.startTick;
  let newData;
  if (block.track === 'camera') {
    // カメラだけ、記録データが絶対tickで保存されてるので、新しい位置ぶんずらして複製する
    const shifted = new Map();
    for (const [t, v] of block.data.cameraPath) shifted.set(t + len, v);
    newData = { cameraPath: shifted };
  } else {
    newData = structuredClone(block.data);
  }
  const newBlock = createBlock(block.track, block.endTick, block.endTick + len, block.type, newData);
  if (block.track === 'music' && typeof onMusicBlockDuplicated === 'function') onMusicBlockDuplicated(block, newBlock);
  selectedBlockId = newBlock.id;
  renderTimeline();
  updateExportAvailability();
}

function deleteBlock(id) {
  pushUndo();
  if (activeRecordingBlockId === id) stopRecordingBlock();
  timelineBlocks = timelineBlocks.filter(b => b.id !== id);
  if (selectedBlockId === id) selectedBlockId = null;
  closeEditPanel();
  renderTimeline();
  updateExportAvailability();
}

// 再生ヘッドの位置でブロックを2つに割る(カメラワークのMapもそこで分ける)
function splitBlockAtPlayhead(id) {
  const block = timelineBlocks.find(b => b.id === id);
  if (!block || curTick <= block.startTick || curTick >= block.endTick) return;
  pushUndo();
  const rightPath = new Map();
  const leftPath = new Map();
  for (const [t, v] of block.data.cameraPath) {
    if (t < curTick) leftPath.set(t, v); else rightPath.set(t, v);
  }
  const rightBlock = {
    id: nextBlockId++,
    track: block.track,
    startTick: curTick,
    endTick: block.endTick,
    type: block.type,
    data: { cameraPath: rightPath },
  };
  block.endTick = curTick;
  block.data.cameraPath = leftPath;
  timelineBlocks.push(rightBlock);
  renderTimeline();
  updateExportAvailability();
}


// ============================================================
// ドラッグ(移動・伸縮。他ブロックの端/再生ヘッドにスナップする)
// ============================================================

let dragState = null;

function startBlockDrag(e, block, mode) {
  e.preventDefault();
  selectedBlockId = block.id;
  renderBlocks();
  pushUndo();
  dragState = {
    mode, block,
    startX: e.clientX,
    origStart: block.startTick,
    origEnd: block.endTick,
    moved: false,
  };
  document.addEventListener('mousemove', onBlockDragMove);
  document.addEventListener('mouseup', onBlockDragEnd);
}

// ドラッグ中のブロック以外の、全ブロックの端+再生ヘッドを吸着候補にする
function snapCandidates(excludeId) {
  const points = [curTick];
  for (const b of timelineBlocks) {
    if (b.id === excludeId) continue;
    points.push(b.startTick, b.endTick);
  }
  return points;
}

function trySnap(tick, candidates) {
  const thresholdTicks = SNAP_PX / timelinePxPerTick;
  let best = null, bestDist = thresholdTicks;
  for (const c of candidates) {
    const d = Math.abs(c - tick);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best !== null ? best : tick;
}

function onBlockDragMove(e) {
  if (!dragState) return;
  dragState.moved = true;
  const dTick = Math.round((e.clientX - dragState.startX) / timelinePxPerTick);
  const { block, mode, origStart, origEnd } = dragState;
  const minLen = 3;
  const candidates = snapCandidates(block.id);
  let snappedTick = null;

  if (mode === 'move') {
    let newStart = origStart + dTick;
    let newEnd = origEnd + dTick;
    const snappedStart = trySnap(newStart, candidates);
    const snappedEnd = trySnap(newEnd, candidates);
    if (snappedStart !== newStart) { newEnd += (snappedStart - newStart); newStart = snappedStart; snappedTick = newStart; }
    else if (snappedEnd !== newEnd) { newStart += (snappedEnd - newEnd); newEnd = snappedEnd; snappedTick = newEnd; }
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    block.startTick = newStart;
    block.endTick = newEnd;
  } else if (mode === 'resize-left') {
    let newStart = Math.max(0, Math.min(origEnd - minLen, origStart + dTick));
    newStart = trySnap(newStart, candidates);
    if (candidates.includes(newStart)) snappedTick = newStart;
    block.startTick = Math.min(origEnd - minLen, Math.max(0, newStart));
  } else if (mode === 'resize-right') {
    let newEnd = Math.max(origStart + minLen, origEnd + dTick);
    newEnd = trySnap(newEnd, candidates);
    if (candidates.includes(newEnd)) snappedTick = newEnd;
    block.endTick = Math.max(origStart + minLen, newEnd);
  }

  showSnapGuide(snappedTick);
  renderBlocks();
  if (document.getElementById('editPanel').classList.contains('open') && selectedBlockId === block.id) {
    refreshEditPanelFields(block);
  }
}

function showSnapGuide(tick) {
  let guide = document.getElementById('snapLineEl');
  if (tick === null) {
    if (guide) guide.remove();
    return;
  }
  if (!guide) {
    guide = document.createElement('div');
    guide.id = 'snapLineEl';
    guide.className = 'snapLine';
    document.getElementById('tracksInner').appendChild(guide);
  }
  guide.style.left = (LABEL_WIDTH + tickToPx(tick)) + 'px';
}

function onBlockDragEnd() {
  const wasNoOp = dragState && !dragState.moved;
  dragState = null;
  showSnapGuide(null);
  document.removeEventListener('mousemove', onBlockDragMove);
  document.removeEventListener('mouseup', onBlockDragEnd);
  if (wasNoOp) undoStack.pop(); // クリックしただけで動かしてない場合は、余分なundo履歴を残さない
  renderTimeline();
  updateExportAvailability();
}

// レーン/ルーラーの空いてる場所をクリック・ドラッグして再生ヘッドを動かす
function onLaneMouseDown(e) {
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
  rangeRow.innerHTML = '<label>区間</label><div class="value">' + formatTime(block.startTick/tps) + ' 〜 ' + formatTime(block.endTick/tps) + '(' + ((block.endTick-block.startTick)/tps).toFixed(1) + '秒)</div>';
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

    if (curTick > block.startTick && curTick < block.endTick) {
      const splitBtn = document.createElement('button');
      splitBtn.className = 'btn btn-ghost';
      splitBtn.innerText = '✂ 再生ヘッドの位置で分割';
      splitBtn.onclick = () => { splitBlockAtPlayhead(block.id); closeEditPanel(); };
      body.appendChild(splitBtn);
    }
  }

  if (block.track === 'text' && typeof buildTextEditFields === 'function') buildTextEditFields(block, body);
  if (block.track === 'music' && typeof buildMusicEditFields === 'function') buildMusicEditFields(block, body);

  const duplicateBtn = document.createElement('button');
  duplicateBtn.className = 'btn btn-ghost';
  duplicateBtn.innerText = '⧉ 複製';
  duplicateBtn.onclick = () => duplicateBlock(block.id);
  body.appendChild(duplicateBtn);

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
  updateViewportIndicator();
}

function stopRecordingBlock() {
  if (activeRecordingBlockId === null) return;
  const block = timelineBlocks.find(b => b.id === activeRecordingBlockId);
  activeRecordingBlockId = null;
  stopTimelinePlayback();
  renderBlocks();
  updateExportAvailability();
  updateViewportIndicator();
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

function previewSingleBlock(block) {
  curTick = block.startTick;
  fcSetPreviewMode(true);
  if (!isPlayingTimeline()) startTimelinePlayback();
}


// ============================================================
// 3Dビュー上の記録中/プレビュー中インジケータ
// ============================================================
// 飛んでる最中はタイムラインを見てる余裕が無いので、今の状態を
// ビューの中央上にも常に出しておく。

function updateViewportIndicator() {
  const el = document.getElementById('vpIndicator');
  const textEl = document.getElementById('vpIndicatorText');
  if (!el || !textEl) return;

  if (activeRecordingBlockId !== null) {
    const block = timelineBlocks.find(b => b.id === activeRecordingBlockId);
    const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
    const elapsed = block ? Math.max(0, (curTick - block.startTick) / tps) : 0;
    el.className = 'show rec';
    textEl.innerText = 'REC ' + elapsed.toFixed(1) + '秒';
  } else if (fcPreviewMode) {
    el.className = 'show prev';
    textEl.innerText = 'プレビュー再生中';
  } else {
    el.className = '';
  }
}


// ============================================================
// 全ブロック横断のカメラ位置検索(プレビュー・書き出しで使う)
// ============================================================

function getCameraStateAtTick(tick) {
  const camBlocks = timelineBlocks
    .filter(b => b.track === 'camera' && b.data.cameraPath && b.data.cameraPath.size > 0)
    .sort((a, b) => a.startTick - b.startTick);
  if (camBlocks.length === 0) return null;

  let covering = camBlocks.find(b => tick >= b.startTick && tick <= b.endTick);
  let sourceBlock = covering;
  if (!sourceBlock) {
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


// ============================================================
// 元に戻す(Undo)
// ============================================================
// ブロックを動かす/伸縮する/追加する/消す、といった操作の直前に
// pushUndo()でスナップショットを1つ積んでおく。cameraPathはMapなので
// structuredCloneでまとめて複製する(モダンブラウザなら標準で使える)。

let undoStack = [];
const UNDO_LIMIT = 30;

function pushUndo() {
  try {
    undoStack.push(structuredClone(timelineBlocks));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  } catch (e) {
    // structuredCloneが使えない古い環境向けの保険。Undoだけ諦めて処理は続行する
    console.warn('元に戻す用のスナップショットを作れませんでした:', e);
  }
  updateUndoButton();
}

function performUndo() {
  if (undoStack.length === 0) return;
  if (activeRecordingBlockId !== null) stopRecordingBlock();
  timelineBlocks = undoStack.pop();
  const maxId = timelineBlocks.reduce((m, b) => Math.max(m, b.id), 0);
  nextBlockId = Math.max(nextBlockId, maxId + 1);
  selectedBlockId = null;
  closeEditPanel();
  renderTimeline();
  updateExportAvailability();
  updateUndoButton();
}

function updateUndoButton() {
  const btn = document.getElementById('undoBtn');
  if (btn) btn.disabled = undoStack.length === 0;
}


// ============================================================
// キーボードショートカット
// ============================================================
// マウスキャプチャ中(実際に自由カメラを操作してる間)は、WASD/Spaceと
// ぶつからないよう一切反応しない。

function setupTimelineKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (document.pointerLockElement === fcCanvas) return; // 飛んでる最中は無効
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      performUndo();
    } else if (e.code === 'Space') {
      e.preventDefault();
      if (isPlayingTimeline()) stopTimelinePlayback(); else startTimelinePlayback();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedBlockId !== null) {
        e.preventDefault();
        deleteBlock(selectedBlockId);
      }
    } else if (e.key === 'Escape') {
      if (document.getElementById('editPanel').classList.contains('open')) closeEditPanel();
    }
  });
}
