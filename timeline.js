// timeline.js
// ============================================================
// 🎥カメラトラックの、複数ブロック・複数層(レイヤー)対応タイムラインUI。
//
// 【作り直し・ステップ4(複数カメラブロック)】
// シーンエディタで「ここで固定」「完了」する度に増える sceneCameras の
// 各エントリ(startTick/endTick/layerを持つ)を、実際にドラッグで動かしたり
// 伸縮したりできるブロックとして描画する。
//
// レイヤーの扱い: 明示的な「レイヤー追加」操作は無く、ブロックをドラッグして
// 縦方向にずらすと、その位置に自動的に行ができる(重ならない場所まで戻せば
// 自動的に1行に戻る)。上の行ほど層番号が大きく、PinP合成時に手前に出る。
//
// ブロックの操作: シングルクリックで選択(シーンエディタ側にギズモが出る)、
// ダブルクリックで右側の編集パネル(画角・動くショットなら各ウェイポイントの
// 到達時刻)を開く。左右の端をドラッグすると開始/終了を個別に伸縮できる。
// ============================================================

const TL_PX_PER_SECOND = 60;
const TL_ROW_HEIGHT = 34;

function tlPxPerTick() {
  const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
  return TL_PX_PER_SECOND / tps;
}
function tlMaxTick() {
  return (timeline && timeline.frames.length) ? timeline.frames.length - 1 : 0;
}
function tlFormatTime(seconds) {
  const m = Math.floor(seconds / 60), s = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

let tlDragState = null; // { camId, mode, startClientX, startClientY, origStart, origEnd, origLayer }


// ============================================================
// 初期化(entity読み込み後に1回呼ぶ)
// ============================================================

function timelineInit() {
  const scrollEl = document.getElementById('timelineScroll');
  scrollEl.addEventListener('mousedown', (e) => {
    // ブロックやそのハンドル自身のmousedownはそちらで処理する(ここまで来ない)
    if (e.target.closest('.timelineBlock')) return;
    const tick = tlTickFromClientX(e.clientX);
    curTick = Math.max(0, Math.min(tlMaxTick(), tick));
    if (typeof stopPlayback === 'function') stopPlayback();
    timelineUpdatePlayhead();
  });

  document.addEventListener('mousemove', tlOnMouseMove);
  document.addEventListener('mouseup', tlOnMouseUp);

  document.getElementById('editPanelClose').addEventListener('click', closeEditPanel);

  timelineRefresh();
}

function tlTickFromClientX(clientX) {
  const scrollEl = document.getElementById('timelineScroll');
  const rect = scrollEl.getBoundingClientRect();
  const contentX = clientX - rect.left + scrollEl.scrollLeft;
  return Math.round(contentX / tlPxPerTick());
}


// ============================================================
// 再描画: ブロック一覧・編集パネル・再生ヘッド
// ============================================================

function timelineRefresh() {
  timelineRenderBlocks();
  timelineUpdatePlayhead();
  // 編集パネルが開いていれば、中身も選択状態に合わせて更新する
  const panel = document.getElementById('editPanel');
  if (panel.classList.contains('open')) {
    const sel = scGetSelected();
    if (sel) openEditPanel(sel); else closeEditPanel();
  }
}

function timelineRenderBlocks() {
  const track = document.getElementById('timelineCameraTrack');
  track.innerHTML = '';

  const maxLayer = sceneCameras.length ? Math.max(...sceneCameras.map(c => c.layer)) : 0;
  const totalWidth = Math.max(200, tlMaxTick() * tlPxPerTick());
  track.style.width = totalWidth + 'px';

  // 上の行ほど層番号が大きい(手前)。layer 0 が一番下の行。
  for (let layer = maxLayer; layer >= 0; layer--) {
    const row = document.createElement('div');
    row.className = 'timelineLayerRow';
    row.dataset.layer = String(layer);
    row.style.width = totalWidth + 'px';

    for (const cam of sceneCameras) {
      if (cam.layer !== layer) continue;
      row.appendChild(tlBuildBlockElement(cam));
    }
    track.appendChild(row);
  }

  document.getElementById('timelineRuler').style.width = totalWidth + 'px';
  tlRenderRuler(totalWidth);
}

function tlRenderRuler(totalWidth) {
  const ruler = document.getElementById('timelineRuler');
  ruler.innerHTML = '';
  const tps = (allTimelines && allTimelines.ticksPerSecond) || 30;
  const totalSeconds = tlMaxTick() / tps;
  for (let s = 0; s <= totalSeconds; s++) {
    const mark = document.createElement('div');
    mark.className = 'timelineRulerMark';
    mark.style.left = (s * TL_PX_PER_SECOND) + 'px';
    mark.innerText = s + 's';
    ruler.appendChild(mark);
  }
}

function timelineUpdatePlayhead() {
  const playhead = document.getElementById('timelinePlayhead');
  if (!playhead) return;
  playhead.style.left = (curTick * tlPxPerTick()) + 'px';
}


// ============================================================
// ブロックのDOM生成・選択・ドラッグ開始
// ============================================================

function tlBuildBlockElement(cam) {
  const el = document.createElement('div');
  el.className = 'timelineBlock' + (cam.id === selectedCameraId ? ' selected' : '');
  el.style.left = (cam.startTick * tlPxPerTick()) + 'px';
  el.style.width = Math.max(6, (cam.endTick - cam.startTick) * tlPxPerTick()) + 'px';
  el.dataset.camId = String(cam.id);

  const label = document.createElement('div');
  label.className = 'timelineBlockLabel';
  label.innerText = cam.mode === 'static' ? '🎥 静的' : `🎥 動く(${cam.waypoints.length}点)`;
  el.appendChild(label);

  const leftHandle = document.createElement('div');
  leftHandle.className = 'timelineBlockHandle left';
  const rightHandle = document.createElement('div');
  rightHandle.className = 'timelineBlockHandle right';
  el.appendChild(leftHandle);
  el.appendChild(rightHandle);

  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    const mode = e.target === leftHandle ? 'resize-left' : e.target === rightHandle ? 'resize-right' : 'move';
    tlDragState = {
      camId: cam.id, mode, moved: false,
      startClientX: e.clientX, startClientY: e.clientY,
      origStart: cam.startTick, origEnd: cam.endTick, origLayer: cam.layer,
    };
  });
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    selectedCameraId = cam.id;
    selectedWaypointIndex = cam.mode === 'waypoints' ? 0 : null;
    openEditPanel(cam);
    timelineRenderBlocks();
  });

  return el;
}

function tlOnMouseMove(e) {
  if (!tlDragState) return;
  const cam = sceneCameras.find(c => c.id === tlDragState.camId);
  if (!cam) { tlDragState = null; return; }

  const deltaTicks = Math.round((e.clientX - tlDragState.startClientX) / tlPxPerTick());
  const deltaRows = Math.round((e.clientY - tlDragState.startClientY) / TL_ROW_HEIGHT);
  if (deltaTicks !== 0 || deltaRows !== 0) tlDragState.moved = true;

  const maxTick = tlMaxTick();
  if (tlDragState.mode === 'move') {
    const duration = tlDragState.origEnd - tlDragState.origStart;
    let newStart = tlDragState.origStart + deltaTicks;
    newStart = Math.max(0, Math.min(maxTick - duration, newStart));
    cam.startTick = newStart;
    cam.endTick = newStart + duration;
    // 縦方向のドラッグ量から、仮の層を求めて即座に見せる(確定はmouseupで行う)
    cam.layer = Math.max(0, tlDragState.origLayer - deltaRows);
  } else if (tlDragState.mode === 'resize-left') {
    let newStart = Math.max(0, Math.min(tlDragState.origEnd - 1, tlDragState.origStart + deltaTicks));
    cam.startTick = newStart;
  } else if (tlDragState.mode === 'resize-right') {
    let newEnd = Math.min(maxTick, Math.max(tlDragState.origStart + 1, tlDragState.origEnd + deltaTicks));
    cam.endTick = newEnd;
  }
  timelineRenderBlocks();
}

function tlOnMouseUp() {
  if (!tlDragState) return;
  const cam = sceneCameras.find(c => c.id === tlDragState.camId);
  const wasClickOnly = !tlDragState.moved;
  tlDragState = null;
  if (!cam) return;

  if (wasClickOnly) {
    // 動かしていなければ、ただの選択クリックとして扱う
    selectedCameraId = cam.id;
    selectedWaypointIndex = cam.mode === 'waypoints' ? 0 : null;
    timelineRenderBlocks();
    return;
  }

  // 移動/伸縮の結果、同じ層の中で他のブロックと重なっていたら、
  // 重ならない最初の層に自動的に収める。その後、空いた層を詰める。
  cam.layer = scFindFreeLayerFrom(cam.layer, cam.startTick, cam.endTick, cam.id);
  scCompactLayers();
  timelineRenderBlocks();
  updatePinPVisibility();
}


// ============================================================
// 編集パネル(右側スライドパネル): 画角+動くショットならウェイポイント一覧
// ============================================================

function openEditPanel(cam) {
  const panel = document.getElementById('editPanel');
  const title = document.getElementById('editPanelTitle');
  const body = document.getElementById('editPanelBody');
  panel.classList.add('open');
  title.innerText = cam.mode === 'static' ? 'カメラを編集(静的ショット)' : 'カメラを編集(動くショット)';
  body.innerHTML = '';

  const fovRow = document.createElement('div');
  fovRow.className = 'fieldRow';
  const fovLabel = document.createElement('label');
  fovLabel.innerText = '画角(FOV)';
  const fovSlider = document.createElement('input');
  fovSlider.type = 'range'; fovSlider.min = '30'; fovSlider.max = '110'; fovSlider.value = cam.fov;
  const fovValue = document.createElement('span');
  fovValue.innerText = Math.round(cam.fov) + '°';
  fovSlider.oninput = () => { cam.fov = parseInt(fovSlider.value); fovValue.innerText = cam.fov + '°'; };
  fovRow.appendChild(fovLabel); fovRow.appendChild(fovSlider); fovRow.appendChild(fovValue);
  body.appendChild(fovRow);

  if (cam.mode !== 'waypoints') return;

  const listLabel = document.createElement('label');
  listLabel.innerText = 'ウェイポイントの到達時刻(ブロック先頭からの秒数)';
  listLabel.style.marginTop = '18px';
  body.appendChild(listLabel);

  const listEl = document.createElement('div');
  listEl.id = 'editPanelWaypointList';
  body.appendChild(listEl);

  cam.waypoints.forEach((wp, i) => {
    const row = document.createElement('div');
    row.className = 'waypointRow' + (i === selectedWaypointIndex ? ' active' : '');
    const label = document.createElement('span');
    label.innerText = `点${i + 1}`;
    const timeInput = document.createElement('input');
    timeInput.type = 'number';
    timeInput.step = '0.1';
    timeInput.min = i === 0 ? '0' : (cam.waypoints[i - 1].time + 0.1).toFixed(1);
    timeInput.value = wp.time.toFixed(1);
    const unit = document.createElement('span');
    unit.innerText = '秒';

    row.addEventListener('click', (e) => {
      if (e.target === timeInput) return;
      selectedCameraId = cam.id;
      selectedWaypointIndex = i;
      openEditPanel(cam);
      timelineRenderBlocks();
    });
    timeInput.addEventListener('change', () => {
      const prevTime = i > 0 ? cam.waypoints[i - 1].time : -Infinity;
      const nextTime = i < cam.waypoints.length - 1 ? cam.waypoints[i + 1].time : Infinity;
      let v = parseFloat(timeInput.value);
      if (isNaN(v)) v = wp.time;
      v = Math.max(prevTime + 0.05, Math.min(nextTime - 0.05, v));
      wp.time = v;
      timeInput.value = v.toFixed(1);
    });

    row.appendChild(label); row.appendChild(timeInput); row.appendChild(unit);
    listEl.appendChild(row);
  });
}

function closeEditPanel() {
  document.getElementById('editPanel').classList.remove('open');
}
