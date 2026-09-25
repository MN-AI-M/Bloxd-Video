// timeline.js
// ============================================================
// タイムライン(🎥カメラトラック・📝テキストトラック共通の土台)と編集パネル。
//
// 操作は一般的な動画編集ソフトに合わせてある:
//   - ルーラー・空いている所をクリック/ドラッグ → 再生ヘッドを動かす(スクラブ)
//   - ブロックをドラッグ → 時間の移動(カメラは縦にずらすと層が変わる)
//   - ブロックの左右の端をドラッグ → 伸縮(左端はトリム。中身の時刻は保つ)
//   - カメラブロックの ◆ = キー(動くショットの各ポイント)。左右にドラッグで時刻を変える。
//     クリックするとそのキーを選んで、再生ヘッドがそこへ移動する
//   - ブロックの端・再生ヘッド・◆ に吸着する(Altを押している間は吸着しない)
//   - Ctrl/Cmd+ホイール(トラックパッドはピンチ)でズーム、「全体」で全体表示
//   - ダブルクリック → 右側の編集パネル
//   - パネル上端の帯をドラッグ → タイムラインの高さを変える
//
// 層(レイヤー): 明示的な「追加」操作は無く、カメラブロックを上の行へドラッグ
// すると自動的に行が増える(重ならない場所まで戻せば自動的に減る)。
// 上の行ほど手前で、同じ時刻にカメラが重なった時はPinPで合成される。
// ============================================================

const TL_HEADER_W = 136;   // 左側のトラック名の列の幅(CSSの --tl-header-w と揃える)
const TL_ROW_H = 34;
const TL_MIN_PPS = 4, TL_MAX_PPS = 320;
const TL_SNAP_PX = 8;

let tlPxPerSecond = 60;
let tlDrag = null;
let tlFitDone = false;

function tlPxPerTick() { return tlPxPerSecond / scTps(); }
function tlMaxTick() { return scMaxTick(); }

// 画面上のx座標 → tick(ルーラーのレーンを基準にする)
function tlTickFromClientX(clientX) {
  const lane = document.getElementById('timelineRulerLane');
  const rect = lane.getBoundingClientRect();
  return (clientX - rect.left) / tlPxPerTick();
}

function tlFormatTime(seconds, withFraction) {
  const neg = seconds < 0;
  seconds = Math.abs(seconds);
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const ss = withFraction ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return (neg ? '-' : '') + m + ':' + ss;
}


// ============================================================
// 初期化
// ============================================================

function timelineInit() {
  const scrollEl = document.getElementById('timelineScroll');

  // ルーラー・空いている所: 再生ヘッドを動かす(ドラッグでスクラブ)
  scrollEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tlBlock, .tlHeader, button')) return;
    const onLane = !!e.target.closest('.tlLane');
    if (!onLane) return;
    e.preventDefault();
    if (typeof stopPlayback === 'function') stopPlayback();
    // トラックの空いている所をクリックした時は選択も外す(ルーラーでは外さない)
    if (!e.target.closest('#timelineRulerLane') && getSelectedItem()) clearSelection();
    tlDrag = { type: 'scrub' };
    tlScrubTo(e);
  });

  // Ctrl/Cmd+ホイール(トラックパッドのピンチ)でズーム
  scrollEl.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0022);
    tlZoomAt(tlPxPerSecond * factor, e.clientX);
  }, { passive: false });

  document.addEventListener('mousemove', tlOnMouseMove);
  document.addEventListener('mouseup', tlOnMouseUp);

  document.getElementById('editPanelClose').addEventListener('click', closeEditPanel);
  document.getElementById('editPanel').addEventListener('pointerdown', () => { editPanelPointerDown = true; });
  document.addEventListener('pointerup', () => { editPanelPointerDown = false; });
  document.getElementById('zoomInBtn').addEventListener('click', () => tlZoomAt(tlPxPerSecond * 1.5, null));
  document.getElementById('zoomOutBtn').addEventListener('click', () => tlZoomAt(tlPxPerSecond / 1.5, null));
  document.getElementById('zoomFitBtn').addEventListener('click', tlZoomFit);
  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('redoBtn').addEventListener('click', redo);
  document.getElementById('splitBtn').addEventListener('click', splitSelectionAtPlayhead);
  document.getElementById('duplicateBtn').addEventListener('click', duplicateSelection);
  document.getElementById('deleteBtn').addEventListener('click', deleteSelection);
  document.getElementById('toStartBtn').addEventListener('click', () => { stopPlayback(); seekTo(0); });

  setupTimelineResizer();
  timelineRefresh();
}

// ズーム(anchorClientX の位置にある時刻が、画面上で動かないようにする)
function tlZoomAt(newPps, anchorClientX) {
  const scrollEl = document.getElementById('timelineScroll');
  const rect = scrollEl.getBoundingClientRect();
  const x = (anchorClientX != null) ? (anchorClientX - rect.left)
    : Math.max(TL_HEADER_W, Math.min(rect.width - 20, TL_HEADER_W + curTick * tlPxPerTick() - scrollEl.scrollLeft));
  const tickAtAnchor = (scrollEl.scrollLeft + x - TL_HEADER_W) / tlPxPerTick();
  tlPxPerSecond = Math.max(TL_MIN_PPS, Math.min(TL_MAX_PPS, newPps));
  timelineRefresh();
  scrollEl.scrollLeft = Math.max(0, TL_HEADER_W + tickAtAnchor * tlPxPerTick() - x);
}

function tlZoomFit() {
  const scrollEl = document.getElementById('timelineScroll');
  const seconds = Math.max(1, tlMaxTick() / scTps());
  tlPxPerSecond = Math.max(TL_MIN_PPS, Math.min(TL_MAX_PPS, (scrollEl.clientWidth - TL_HEADER_W - 24) / seconds));
  timelineRefresh();
  scrollEl.scrollLeft = 0;
}

// パネル上端の帯をドラッグして、タイムラインの高さを変える
function setupTimelineResizer() {
  const bar = document.getElementById('timelineResizer');
  const panel = document.getElementById('timelinePanel');
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = panel.getBoundingClientRect().height;
    const move = (ev) => {
      const h = Math.max(120, Math.min(window.innerHeight * 0.75, startH - (ev.clientY - startY)));
      panel.style.height = h + 'px';
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}


// ============================================================
// 描画
// ============================================================

function tlTotalWidth() {
  return Math.max(240, tlMaxTick() * tlPxPerTick() + 40);
}

function timelineRefresh() {
  // 最初にデータが届いた時だけ、全体が見える倍率にしておく
  if (!tlFitDone && tlMaxTick() > 0) {
    const scrollEl = document.getElementById('timelineScroll');
    if (scrollEl && scrollEl.clientWidth > 0) {
      tlFitDone = true;
      const seconds = Math.max(1, tlMaxTick() / scTps());
      tlPxPerSecond = Math.max(TL_MIN_PPS, Math.min(TL_MAX_PPS, (scrollEl.clientWidth - TL_HEADER_W - 24) / seconds));
    }
  }
  const content = document.getElementById('timelineContent');
  if (!content) return;
  content.style.width = (TL_HEADER_W + tlTotalWidth()) + 'px';
  tlRenderRuler();
  timelineRenderBlocks();
  if (typeof renderTextTrackBlocks === 'function') renderTextTrackBlocks();
  timelineUpdatePlayhead();
  refreshEditPanelIfOpen();
  updateTimelineToolbar();
}

function tlRenderRuler() {
  const lane = document.getElementById('timelineRulerLane');
  lane.innerHTML = '';
  lane.style.width = tlTotalWidth() + 'px';
  const totalSeconds = tlMaxTick() / scTps();
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find(s => s * tlPxPerSecond >= 70) || 600;
  const minor = step / 5;
  const frag = document.createDocumentFragment();
  for (let i = 0; i * minor <= totalSeconds + 1e-6; i++) {
    const s = i * minor;
    const major = i % 5 === 0;
    const mark = document.createElement('div');
    mark.className = major ? 'tlRulerMark' : 'tlRulerMinor';
    mark.style.left = (s * tlPxPerSecond) + 'px';
    if (major) mark.innerText = tlFormatTime(s, step < 1);
    frag.appendChild(mark);
  }
  lane.appendChild(frag);
}

function timelineRenderBlocks() {
  const rowsEl = document.getElementById('timelineCameraRows');
  rowsEl.innerHTML = '';
  const width = tlTotalWidth();
  const maxLayer = sceneCameras.length ? Math.max(...sceneCameras.map(c => c.layer)) : 0;

  // 上の行ほど層番号が大きい(手前)。layer 0 が一番下の行。
  for (let layer = maxLayer; layer >= 0; layer--) {
    const row = document.createElement('div');
    row.className = 'tlRow';
    const header = document.createElement('div');
    header.className = 'tlHeader';
    const name = document.createElement('span');
    name.innerText = '🎥 カメラ';
    header.appendChild(name);
    if (maxLayer > 0) {
      const sub = document.createElement('span');
      sub.className = 'tlHeaderSub';
      sub.innerText = layer === maxLayer ? '手前' : (layer === 0 ? '奥' : `層${layer + 1}`);
      header.appendChild(sub);
    }
    if (layer === maxLayer) {
      const add = document.createElement('button');
      add.className = 'tlAddBtn';
      add.title = '今見えている構図で、再生ヘッドの位置にカメラを置く (F)';
      add.innerText = '＋';
      add.addEventListener('click', (e) => { e.stopPropagation(); actionNewCamera(); });
      header.appendChild(add);
    }
    const lane = document.createElement('div');
    lane.className = 'tlLane';
    lane.style.width = width + 'px';
    for (const cam of sceneCameras) {
      if (cam.layer === layer) lane.appendChild(tlBuildCameraBlock(cam));
    }
    if (sceneCameras.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tlEmpty';
      empty.innerText = 'F キー(または左の 📷 ボタン)で、今見えている構図のカメラをここに置けます';
      lane.appendChild(empty);
    }
    row.appendChild(header);
    row.appendChild(lane);
    rowsEl.appendChild(row);
  }
}

function timelineUpdatePlayhead() {
  const ph = document.getElementById('timelinePlayhead');
  if (!ph) return;
  const x = curTick * tlPxPerTick();
  ph.style.left = (TL_HEADER_W + x) + 'px';
  // 再生中は、再生ヘッドが画面の外へ出ないようにスクロールを追従させる
  if (typeof playing !== 'undefined' && playing) {
    const scrollEl = document.getElementById('timelineScroll');
    const visibleRight = scrollEl.scrollLeft + scrollEl.clientWidth;
    if (TL_HEADER_W + x > visibleRight - 30 || TL_HEADER_W + x < scrollEl.scrollLeft + TL_HEADER_W) {
      scrollEl.scrollLeft = Math.max(0, x - 40);
    }
  }
}

function updateTimelineToolbar() {
  const item = getSelectedItem();
  const inBlock = !!item && curTick > item.startTick && curTick < item.endTick;
  document.getElementById('splitBtn').disabled = !inBlock;
  document.getElementById('duplicateBtn').disabled = !item;
  document.getElementById('deleteBtn').disabled = !item;
}


// ============================================================
// カメラブロック
// ============================================================

function tlBuildCameraBlock(cam) {
  const tps = scTps();
  const ppt = tlPxPerTick();
  const el = document.createElement('div');
  const isSel = cam.id === selectedCameraId;
  el.className = 'tlBlock cam' + (isSel ? ' selected' : '');
  el.style.left = (cam.startTick * ppt) + 'px';
  const widthPx = Math.max(6, (cam.endTick - cam.startTick) * ppt);
  el.style.width = widthPx + 'px';

  const label = document.createElement('div');
  label.className = 'tlBlockLabel';
  label.innerText = `🎥 ${scCamName(cam)}` + (scCamIsStatic(cam) ? '' : ` · 動く(${cam.keys.length}点)`);
  el.appendChild(label);

  const dur = document.createElement('div');
  dur.className = 'tlBlockDur';
  dur.innerText = ((cam.endTick - cam.startTick) / tps).toFixed(1) + 's';
  el.appendChild(dur);

  // キー(◆)。静的ショットでも1個表示する(そこから時刻を動かせる)
  const lenSec = (cam.endTick - cam.startTick) / tps;
  cam.keys.forEach((k, i) => {
    if (k.time < -1e-6 || k.time > lenSec + 1e-6) return; // ブロックの外(トリムで隠れた)キーは出さない
    const d = document.createElement('div');
    d.className = 'tlKey' + (isSel && i === selectedKeyIndex ? ' active' : '');
    d.style.left = (k.time * tps * ppt) + 'px';
    d.title = `ポイント${i + 1}(${k.time.toFixed(2)}秒) — ドラッグで時刻を変更 / クリックで選択`;
    d.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      beginEdit();
      tlDrag = {
        type: 'key', camId: cam.id, keyIndex: i, startX: e.clientX, moved: false,
        origTime: k.time,
      };
    });
    el.appendChild(d);
  });

  _addResizeHandles(el);

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const mode = e.target.classList.contains('left') ? 'resize-left'
      : e.target.classList.contains('right') ? 'resize-right' : 'move';
    beginEdit();
    tlDrag = {
      type: 'block', kind: 'camera', id: cam.id, mode, moved: false,
      startX: e.clientX, startY: e.clientY,
      origStart: cam.startTick, origEnd: cam.endTick, origLayer: cam.layer,
      origKeyTimes: cam.keys.map(k => k.time),
    };
  });
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    selectCamera(cam.id, null, false);
    openEditPanel(cam);
  });
  return el;
}

function _addResizeHandles(el) {
  const l = document.createElement('div'); l.className = 'tlHandle left'; l.title = 'ドラッグで開始位置を変更';
  const r = document.createElement('div'); r.className = 'tlHandle right'; r.title = 'ドラッグで終了位置を変更';
  el.appendChild(l); el.appendChild(r);
}


// ============================================================
// 吸着(スナップ)
// ============================================================

// 吸着先の候補(tick)。excludeは自分自身({kind,id})で、その端は候補にしない。
function tlSnapCandidates(exclude, includeOwnKeys) {
  const c = [0, curTick, tlMaxTick()];
  for (const cam of sceneCameras) {
    const self = exclude && exclude.kind === 'camera' && exclude.id === cam.id;
    if (!self) c.push(cam.startTick, cam.endTick);
    if (!self || includeOwnKeys) for (const k of cam.keys) c.push(scKeyAbsTick(cam, k));
  }
  if (typeof textBlocks !== 'undefined') {
    for (const t of textBlocks) {
      if (exclude && exclude.kind === 'text' && exclude.id === t.id) continue;
      c.push(t.startTick, t.endTick);
    }
  }
  return c;
}

// tickを近くの候補に吸着させる。{ tick, snapped:(吸着したtick or null) }
function tlSnap(tick, candidates, e) {
  if (e && e.altKey) return { tick, snapped: null, dist: Infinity };
  const threshold = TL_SNAP_PX / tlPxPerTick();
  let best = null, bestD = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - tick);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best == null ? { tick, snapped: null, dist: Infinity } : { tick: best, snapped: best, dist: bestD };
}

function tlShowSnapLine(tick) {
  const line = document.getElementById('timelineSnapLine');
  if (tick == null) { line.style.display = 'none'; return; }
  line.style.display = 'block';
  line.style.left = (TL_HEADER_W + tick * tlPxPerTick()) + 'px';
}


// ============================================================
// ドラッグ(スクラブ・ブロックの移動/伸縮・キーの移動)
// ============================================================

function tlScrubTo(e) {
  let tick = tlTickFromClientX(e.clientX);
  // 再生ヘッドも、ブロックの端や◆に吸着させる(Altで解除)
  const sn = tlSnap(tick, tlSnapCandidates(null, true).filter(t => t !== curTick), e);
  tlShowSnapLine(sn.snapped);
  seekTo(sn.tick);
}

function _tlFindItem(kind, id) {
  if (kind === 'camera') return scGetCamera(id);
  return (typeof textBlocks !== 'undefined') ? textBlocks.find(t => t.id === id) || null : null;
}

// テキストのブロックからも同じドラッグ処理を使う(content-blocks.jsから呼ばれる)
function tlStartBlockDrag(e, kind, item) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  const mode = e.target.classList.contains('left') ? 'resize-left'
    : e.target.classList.contains('right') ? 'resize-right' : 'move';
  beginEdit();
  tlDrag = {
    type: 'block', kind, id: item.id, mode, moved: false,
    startX: e.clientX, startY: e.clientY,
    origStart: item.startTick, origEnd: item.endTick, origLayer: item.layer || 0,
    origKeyTimes: item.keys ? item.keys.map(k => k.time) : null,
  };
}

function tlOnMouseMove(e) {
  if (!tlDrag) return;
  if (tlDrag.type === 'scrub') { tlScrubTo(e); return; }

  const dxPx = e.clientX - tlDrag.startX;
  if (!tlDrag.moved && Math.abs(dxPx) < 3 && Math.abs(e.clientY - (tlDrag.startY ?? e.clientY)) < 3) return;
  tlDrag.moved = true;
  const dTicks = dxPx / tlPxPerTick();
  const maxTick = tlMaxTick();
  const tps = scTps();

  if (tlDrag.type === 'key') {
    const cam = scGetCamera(tlDrag.camId);
    if (!cam) { tlDrag = null; return; }
    const i = tlDrag.keyIndex;
    const lenSec = (cam.endTick - cam.startTick) / tps;
    const origAbs = cam.startTick + tlDrag.origTime * tps;
    const cands = tlSnapCandidates({ kind: 'camera', id: cam.id }, false)
      .concat(cam.keys.filter((_, j) => j !== i).map(k => scKeyAbsTick(cam, k)));
    const sn = tlSnap(origAbs + dTicks, cands, e);
    let time = (sn.tick - cam.startTick) / tps;
    const prev = cam.keys[i - 1], next = cam.keys[i + 1];
    const lo = prev ? prev.time + 0.05 : Math.min(0, tlDrag.origTime);
    const hi = next ? next.time - 0.05 : Math.max(lenSec, tlDrag.origTime);
    time = Math.max(lo, Math.min(hi, time));
    cam.keys[i].time = time;
    tlShowSnapLine(sn.snapped != null && Math.abs(cam.startTick + time * tps - sn.snapped) < 0.5 ? sn.snapped : null);
    seekTo(cam.startTick + time * tps); // 動かしている間、そのキーの時刻の画をプレビューで見せる
    timelineRenderBlocks();
    return;
  }

  const item = _tlFindItem(tlDrag.kind, tlDrag.id);
  if (!item) { tlDrag = null; return; }
  const cands = tlSnapCandidates({ kind: tlDrag.kind, id: item.id }, false);
  let snappedAt = null;

  if (tlDrag.mode === 'move') {
    const dur = tlDrag.origEnd - tlDrag.origStart;
    let start = tlDrag.origStart + dTicks;
    const a = tlSnap(start, cands, e), b = tlSnap(start + dur, cands, e);
    if (a.dist <= b.dist && a.snapped != null) { start = a.tick; snappedAt = a.snapped; }
    else if (b.snapped != null) { start = b.tick - dur; snappedAt = b.snapped; }
    start = Math.max(0, Math.min(Math.max(0, maxTick - dur), Math.round(start)));
    item.startTick = start;
    item.endTick = start + dur;
    if (tlDrag.kind === 'camera') {
      // 縦方向のドラッグで層を変える(上へ=手前)。確定時に重なりを解消する
      const dRows = Math.round((e.clientY - tlDrag.startY) / TL_ROW_H);
      item.layer = Math.max(0, tlDrag.origLayer - dRows);
    }
  } else if (tlDrag.mode === 'resize-left') {
    const sn = tlSnap(tlDrag.origStart + dTicks, cands, e);
    snappedAt = sn.snapped;
    const start = Math.max(0, Math.min(tlDrag.origEnd - 1, Math.round(sn.tick)));
    item.startTick = start;
    // カメラは中身(キー)の絶対時刻を保つ = 左端を詰めても、映像はずれない
    if (tlDrag.origKeyTimes) {
      const shift = (start - tlDrag.origStart) / tps;
      item.keys.forEach((k, j) => { k.time = tlDrag.origKeyTimes[j] - shift; });
    }
  } else if (tlDrag.mode === 'resize-right') {
    const sn = tlSnap(tlDrag.origEnd + dTicks, cands, e);
    snappedAt = sn.snapped;
    item.endTick = Math.min(maxTick, Math.max(tlDrag.origStart + 1, Math.round(sn.tick)));
  }
  tlShowSnapLine(snappedAt);
  timelineRenderBlocks();
  if (typeof renderTextTrackBlocks === 'function') renderTextTrackBlocks();
}

function tlOnMouseUp() {
  if (!tlDrag) return;
  const d = tlDrag;
  tlDrag = null;
  tlShowSnapLine(null);
  if (d.type === 'scrub') { editorChanged(); return; }

  if (d.type === 'key') {
    if (!d.moved) {
      // クリック: そのキーを選び、再生ヘッドをキーの時刻へ
      const cam = scGetCamera(d.camId);
      if (cam) {
        if (typeof stopPlayback === 'function') stopPlayback();
        seekTo(scKeyAbsTick(cam, cam.keys[d.keyIndex]));
      }
    }
    selectCamera(d.camId, d.keyIndex, true);
    commitEdit();
    return;
  }

  const item = _tlFindItem(d.kind, d.id);
  if (!item) { commitEdit(); return; }
  if (!d.moved) {
    if (d.kind === 'camera') selectCamera(item.id, null, false); else selectText(item.id);
    commitEdit();
    return;
  }
  if (d.kind === 'camera') {
    // 同じ層で他のブロックと重なっていたら、重ならない層に自動的に収める
    item.layer = scFindFreeLayerFrom(item.layer, item.startTick, item.endTick, item.id);
    scCompactLayers();
    selectCamera(item.id, selectedCameraId === item.id ? selectedKeyIndex : null, false);
  } else {
    selectText(item.id);
  }
  commitEdit();
}


// ============================================================
// 編集パネル(右側): ブロックのダブルクリックで開く
// カメラブロック・テキストブロックで共通のDOM(#editPanel)を使い回す。
// ============================================================

let editPanelOpenFor = null; // { kind:'camera'|'text', id } | null
let editPanelPointerDown = false; // パネルの中でマウスボタンを押している最中か

function openEditPanel(item) {
  const panel = document.getElementById('editPanel');
  const title = document.getElementById('editPanelTitle');
  const body = document.getElementById('editPanelBody');
  // 入力中の欄を作り直すとカーソルが飛ぶので、同じものを開き直す時は
  // 文字入力にフォーカスがあれば作り直さない
  const same = editPanelOpenFor && editPanelOpenFor.kind === (item.kind || 'camera') && editPanelOpenFor.id === item.id;
  if (same && panel.classList.contains('open')) {
    if (isTypingTarget(document.activeElement) && body.contains(document.activeElement)) return;
    if (editPanelPointerDown) return; // スライダーをドラッグしている最中に作り直すと、ドラッグが途切れる
  }
  panel.classList.add('open');
  document.getElementById('editor').classList.add('panelOpen');
  body.innerHTML = '';

  if (item.kind === 'text') {
    editPanelOpenFor = { kind: 'text', id: item.id };
    title.innerText = '📝 テキストを編集';
    if (typeof renderTextEditFields === 'function') renderTextEditFields(body, item);
    return;
  }
  editPanelOpenFor = { kind: 'camera', id: item.id };
  renderCameraEditFields(title, body, item);
}

// スライダー・数値欄・文字欄に、取り消し(Undo)用の開始/確定を付ける
// (確定は少し遅らせて呼ぶ。同じchangeイベントで値を書き換える処理より
//  先に確定してしまうと、変更が履歴に残らないため)
function bindEditUndo(el) {
  el.addEventListener('pointerdown', beginEdit);
  el.addEventListener('focus', beginEdit);
  el.addEventListener('change', () => setTimeout(commitEdit, 0));
  el.addEventListener('blur', () => setTimeout(commitEdit, 0));
}

function renderCameraEditFields(title, body, cam) {
  title.innerText = `🎥 ${scCamName(cam)}` + (scCamIsStatic(cam) ? '(静的ショット)' : '(動くショット)');

  // 名前
  const nameRow = document.createElement('div');
  nameRow.className = 'fieldRow';
  nameRow.innerHTML = '<label>名前</label>';
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'panelInput'; nameInput.value = scCamName(cam);
  bindEditUndo(nameInput);
  nameInput.addEventListener('input', () => { cam.name = nameInput.value; timelineRenderBlocks(); updateToolPalette(); });
  nameRow.appendChild(nameInput);
  body.appendChild(nameRow);

  // 画角
  const fovRow = document.createElement('div');
  fovRow.className = 'fieldRow';
  fovRow.innerHTML = '<label>画角</label>';
  const fovSlider = document.createElement('input');
  fovSlider.type = 'range'; fovSlider.min = '20'; fovSlider.max = '110'; fovSlider.value = cam.fov;
  const fovValue = document.createElement('span');
  fovValue.className = 'fieldValue';
  fovValue.innerText = Math.round(cam.fov) + '°';
  bindEditUndo(fovSlider);
  fovSlider.addEventListener('input', () => {
    cam.fov = parseInt(fovSlider.value); fovValue.innerText = cam.fov + '°';
    if (typeof pilot !== 'undefined' && pilot && pilot.camId === cam.id) { fcFovDeg = cam.fov; syncFovSliderUI(); }
  });
  fovRow.appendChild(fovSlider); fovRow.appendChild(fovValue);
  body.appendChild(fovRow);

  // 操作ボタン
  const actions = document.createElement('div');
  actions.className = 'panelActions';
  const mk = (text, fn, primary) => {
    const b = document.createElement('button');
    b.className = 'btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost');
    b.innerText = text; b.addEventListener('click', fn);
    actions.appendChild(b);
  };
  mk((typeof pilot !== 'undefined' && pilot && pilot.camId === cam.id) ? '🎥 カメラ視点を終わる (V)' : '🎥 カメラ視点に入る (V)', () => togglePilot(), true);
  mk('◆ 再生ヘッドにキーを記録 (K)', () => actionRecordKey());
  mk('➕ 次のポイントを追加 (G)', () => actionNextPoint());
  body.appendChild(actions);

  // キーの一覧
  const listLabel = document.createElement('div');
  listLabel.className = 'panelSectionLabel';
  listLabel.innerText = 'ポイント(◆)の時刻 — ブロック先頭からの秒数';
  body.appendChild(listLabel);

  const listEl = document.createElement('div');
  listEl.className = 'keyList';
  body.appendChild(listEl);

  cam.keys.forEach((k, i) => {
    const row = document.createElement('div');
    row.className = 'keyRow' + (i === selectedKeyIndex && cam.id === selectedCameraId ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'keyRowLabel';
    label.innerText = `◆ ポイント${i + 1}`;
    const timeInput = document.createElement('input');
    timeInput.type = 'number'; timeInput.step = '0.1'; timeInput.className = 'panelInput small';
    timeInput.value = k.time.toFixed(2);
    const unit = document.createElement('span'); unit.innerText = '秒';
    bindEditUndo(timeInput);
    timeInput.addEventListener('change', () => {
      const prev = cam.keys[i - 1], next = cam.keys[i + 1];
      let v = parseFloat(timeInput.value);
      if (isNaN(v)) v = k.time;
      v = Math.max(prev ? prev.time + 0.05 : -Infinity, Math.min(next ? next.time - 0.05 : Infinity, v));
      k.time = v;
      if (v * scTps() + cam.startTick >= cam.endTick) cam.endTick = Math.min(tlMaxTick(), Math.ceil(cam.startTick + v * scTps()) + 1);
      editorChanged();
    });
    row.appendChild(label); row.appendChild(timeInput); row.appendChild(unit);
    if (cam.keys.length > 1) {
      const del = document.createElement('button');
      del.className = 'keyRowDel'; del.title = 'このポイントを削除'; del.innerText = '✕';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndo();
        scDeleteKey(cam, i);
        selectCamera(cam.id, Math.min(i, cam.keys.length - 1), true);
      });
      row.appendChild(del);
    }
    row.addEventListener('click', (e) => {
      if (e.target === timeInput) return;
      if (typeof stopPlayback === 'function') stopPlayback();
      seekTo(scKeyAbsTick(cam, k));
      selectCamera(cam.id, i, true);
    });
    listEl.appendChild(row);
  });

  const hint = document.createElement('div');
  hint.className = 'panelHint';
  hint.innerText = '◆はタイムライン上で左右にドラッグしても時刻を変えられます。位置・向きは、3D画面のギズモ(矢印とリング)か、カメラ視点(V)で直してKで記録します。';
  body.appendChild(hint);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-ghost btn-sm dangerBtn';
  delBtn.innerText = '🗑 このカメラを削除';
  delBtn.addEventListener('click', () => { selectCamera(cam.id, null, false); deleteSelection(); });
  body.appendChild(delBtn);
}

function closeEditPanel() {
  document.getElementById('editPanel').classList.remove('open');
  document.getElementById('editor').classList.remove('panelOpen');
  editPanelOpenFor = null;
}

// 編集パネルが開いている間は、選択を切り替えるとパネルの中身も追従させる
// (何も選んでいない状態になったら閉じる)
function refreshEditPanelIfOpen() {
  if (!editPanelOpenFor) return;
  const item = getSelectedItem();
  if (item) openEditPanel(item); else closeEditPanel();
}
