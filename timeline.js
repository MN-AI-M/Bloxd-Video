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
//   - ダブルクリック → 右側の編集パネル。カメラは、再生ヘッドの時刻の位置・角度を
//     数値で直せる(その時刻にキーが無ければ自動で作られる)。表示位置も決められる
//   - パネル上端の帯をドラッグ → タイムラインの高さを変える
//   - 素材の追加は、左の素材一覧(asset-library.js)から行う
//
// 層(レイヤー): 明示的な「追加」操作は無く、カメラブロックを上の行へドラッグ
// すると自動的に行が増える(重ならない場所まで戻せば自動的に減る)。
// 上の行ほど手前で、同じ時刻にカメラが重なった時はPinPで合成される。
// ============================================================

const TL_HEADER_W = 136;   // 左側のトラック名の列の幅(CSSの --tl-header-w と揃える)
const TL_ROW_H = 34;
const TL_MIN_PPS = 4, TL_MAX_PPS = 320;
const TL_SNAP_PX = 8;
const TL_EXPANDED_H = 124; // 編集パネルを開いているカメラの行の高さ(速さのカーブのグラフを出す)

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
    const lane = document.createElement('div');
    lane.className = 'tlLane';
    lane.style.width = width + 'px';
    const expId = tlExpandedCamId();
    for (const cam of sceneCameras) {
      if (cam.layer !== layer) continue;
      lane.appendChild(tlBuildCameraBlock(cam));
      if (cam.id === expId) { row.style.height = TL_EXPANDED_H + 'px'; row.classList.add('expanded'); }
    }
    if (sceneCameras.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tlEmpty';
      empty.innerText = '左の素材一覧の「🎥 カメラ」から追加できます(クリック、またはここへドラッグ)/ F キーで今の視点のカメラ';
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

  // 編集パネルを開いているカメラは、ブロックを縦に広げて速さのカーブのグラフを出す
  if (cam.id === tlExpandedCamId()) {
    el.classList.add('expanded');
    el.style.height = (TL_EXPANDED_H - 7) + 'px';
    el.appendChild(tlBuildCurveGraph(cam, widthPx, TL_EXPANDED_H - 7));
  }

  _addResizeHandles(el);

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    // ダブルクリック。1回目のクリックでブロックが描き直されて要素が入れ替わるため、
    // 'dblclick' イベントではなく2回目の mousedown(detail===2)で判定する
    if (e.detail >= 2) { tlOpenCameraFromTimeline(cam, e.clientX); return; }
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
  return el;
}

function tlOpenCameraFromTimeline(cam, clientX) {
  tlDrag = null;
  // 再生ヘッドがこのカメラの外にある時は、ダブルクリックした時刻へ動かす
  // (パネルの位置・角度は「再生ヘッドの時刻」の値を編集するため)
  if (curTick < cam.startTick || curTick >= cam.endTick) {
    if (typeof stopPlayback === 'function') stopPlayback();
    seekTo(Math.max(cam.startTick, Math.min(cam.endTick - 1, tlTickFromClientX(clientX))));
  }
  selectCamera(cam.id, null, false);
  openEditPanel(cam);
}

// ============================================================
// 速さのカーブのグラフ(広げたカメラブロックの中)
//   横 = 時間、縦 = 次のポイントまでの進み具合(下=前のポイント、上=次のポイント)。
//   区間ごとに S 字などの曲線を描き、○(ハンドル)をドラッグすると形が変わる。
//   傾きが急な所ほど速く動き、平らな所ほどゆっくり動く。
// ============================================================

const SVG_NS = 'http://www.w3.org/2000/svg';
const TL_GRAPH_TOP = 22, TL_GRAPH_BOTTOM = 20; // ラベルと◆のぶん上下を空ける

function tlExpandedCamId() {
  return (editPanelOpenFor && editPanelOpenFor.kind === 'camera') ? editPanelOpenFor.id : null;
}

function _svg(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

function tlBuildCurveGraph(cam, widthPx, blockH) {
  const wrap = document.createElement('div');
  wrap.className = 'tlCurveGraph';
  wrap.style.top = TL_GRAPH_TOP + 'px';
  wrap.style.height = (blockH - TL_GRAPH_TOP - TL_GRAPH_BOTTOM) + 'px';
  if (scCamIsStatic(cam)) {
    wrap.appendChild(_el('div', 'tlCurveEmpty', '固定カメラ — ポイントが2つ以上になると、ここで動きの速さ(なめらかさ)を調整できます'));
    return wrap;
  }
  const svg = _svg('svg', { width: widthPx, height: blockH - TL_GRAPH_TOP - TL_GRAPH_BOTTOM });
  wrap.appendChild(svg);
  _drawCurveGraph(svg, cam);
  return wrap;
}

function _curveSegGeom(cam, i, H) {
  const pps = tlPxPerSecond;
  const a = cam.keys[i], b = cam.keys[i + 1];
  const x0 = a.time * pps, x1 = b.time * pps;
  return { x0, x1, w: x1 - x0, yb: H - 4, H: H - 8 }; // 上下4pxの余白
}

function _drawCurveGraph(svg, cam) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const H = parseFloat(svg.getAttribute('height'));
  const segAtHead = tlCurveSegmentAt(cam, curTick);
  // 目盛り(下=前のポイント、上=次のポイント)
  svg.appendChild(_svg('line', { x1: 0, x2: svg.getAttribute('width'), y1: 4, y2: 4, class: 'tlCurveGrid' }));
  svg.appendChild(_svg('line', { x1: 0, x2: svg.getAttribute('width'), y1: H - 4, y2: H - 4, class: 'tlCurveGrid' }));
  for (let i = 0; i < cam.keys.length - 1; i++) {
    const g = _curveSegGeom(cam, i, H);
    if (g.w <= 1) continue;
    const c = scKeyCurve(cam.keys[i]);
    const P = (nx, ny) => [g.x0 + nx * g.w, g.yb - ny * g.H];
    const [ax, ay] = P(0, 0), [bx, by] = P(1, 1), [h1x, h1y] = P(c[0], c[1]), [h2x, h2y] = P(c[2], c[3]);
    const hot = i === segAtHead;
    // 区間の背景(再生ヘッドがある区間は少し明るく)
    svg.appendChild(_svg('rect', { x: g.x0, y: 2, width: g.w, height: H - 4, class: 'tlCurveSeg' + (hot ? ' hot' : '') }));
    svg.appendChild(_svg('line', { x1: g.x0, x2: g.x0, y1: 2, y2: H - 2, class: 'tlCurveKeyLine' }));
    // 曲線と、その下の塗り
    svg.appendChild(_svg('path', { d: `M${ax},${ay} C${h1x},${h1y} ${h2x},${h2y} ${bx},${by} L${bx},${ay} Z`, class: 'tlCurveFill' }));
    svg.appendChild(_svg('path', { d: `M${ax},${ay} C${h1x},${h1y} ${h2x},${h2y} ${bx},${by}`, class: 'tlCurveLine' }));
    // 区間の名前(幅がある時だけ)
    const pid = scCurvePresetId(cam.keys[i].curve);
    if (g.w > 74) {
      const t = _svg('text', { x: g.x0 + 5, y: 14, class: 'tlCurveLabel' });
      t.textContent = pid ? CURVE_PRESETS[pid].label : 'カスタム';
      svg.appendChild(t);
    }
    // ハンドル(○)と、端点からの線
    svg.appendChild(_svg('line', { x1: ax, y1: ay, x2: h1x, y2: h1y, class: 'tlCurveArm' }));
    svg.appendChild(_svg('line', { x1: bx, y1: by, x2: h2x, y2: h2y, class: 'tlCurveArm' }));
    for (const which of [0, 1]) {
      const [hx, hy] = which ? [h2x, h2y] : [h1x, h1y];
      const h = _svg('circle', { cx: hx, cy: hy, r: 5.5, class: 'tlCurveHandle', 'data-seg': i, 'data-h': which });
      const title = _svg('title', {});
      title.textContent = which ? '次のポイントに着く時の速さ(ドラッグで調整)' : 'このポイントを出る時の速さ(ドラッグで調整)';
      h.appendChild(title);
      h.addEventListener('mousedown', (e) => _startCurveHandleDrag(e, svg, cam, i, which));
      svg.appendChild(h);
    }
  }
}

// 再生ヘッドがある区間の番号(静的ショットは -1)
function tlCurveSegmentAt(cam, tick) {
  if (cam.keys.length < 2) return -1;
  const s = scEditSeconds(cam, tick);
  let i = 0;
  while (i < cam.keys.length - 2 && s >= cam.keys[i + 1].time) i++;
  return i;
}

function _startCurveHandleDrag(e, svg, cam, seg, which) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  beginEdit();
  const H = parseFloat(svg.getAttribute('height'));
  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const g = _curveSegGeom(cam, seg, H);
    let nx = (ev.clientX - rect.left - g.x0) / g.w;
    let ny = (rect.top + g.yb - ev.clientY) / g.H;
    nx = Math.max(0, Math.min(1, nx));
    ny = Math.max(0, Math.min(1, ny));
    const c = scKeyCurve(cam.keys[seg]).slice();
    if (which === 0) { c[0] = nx; c[1] = ny; } else { c[2] = nx; c[3] = ny; }
    // Shiftを押している間は、反対側のハンドルも対称に動かす
    if (ev.shiftKey) { if (which === 0) { c[2] = 1 - nx; c[3] = 1 - ny; } else { c[0] = 1 - nx; c[1] = 1 - ny; } }
    cam.keys[seg].curve = c;
    _drawCurveGraph(svg, cam);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const k = cam.keys[seg];
    if (k && scCurvePresetId(k.curve) === 'linear') delete k.curve; // 等速に戻ったら持たない
    commitEdit();
    editorChanged();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// 区間のカーブを変える(パネルのボタンから)。seg<0 なら全区間
function tlSetSegmentCurve(cam, seg, curve) {
  const apply = (k) => { if (!curve || scCurvePresetId(curve) === 'linear') delete k.curve; else k.curve = curve.slice(); };
  if (seg < 0) cam.keys.slice(0, -1).forEach(apply);
  else if (cam.keys[seg]) apply(cam.keys[seg]);
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
  const prevExpanded = tlExpandedCamId();
  _openEditPanelInner(item);
  if (tlExpandedCamId() !== prevExpanded) timelineRenderBlocks();
}

function _openEditPanelInner(item) {
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

// カメラの表示位置のひな形(書き出す映像の中での、左上の位置と幅。0〜1の割合)
const DISPLAY_PRESETS = [
  ['自動', null],
  ['全画面', { x: 0, y: 0, w: 1 }],
  ['右上', { x: 0.65, y: 0.03, w: 0.32 }],
  ['左上', { x: 0.03, y: 0.03, w: 0.32 }],
  ['右下', { x: 0.65, y: 0.65, w: 0.32 }],
  ['左下', { x: 0.03, y: 0.65, w: 0.32 }],
];

// パネルの「再生ヘッドの時刻の位置・角度」欄。再生ヘッドが動くたびに
// 表示を追従させる(syncCameraPanelToPlayhead)ために、要素を覚えておく
let camPanel = null; // { camId, fields:{x,y,z,yaw,yawRange,pitch,pitchRange}, status }

const _rad2deg = (r) => r * 180 / Math.PI;
const _deg2rad = (d) => d * Math.PI / 180;
function _normDeg(d) { return ((d + 180) % 360 + 360) % 360 - 180; }

// パネルで編集する時刻(再生ヘッド。カメラの外にある時はカメラの端)
function _camPanelTick(cam) { return Math.max(cam.startTick, Math.min(cam.endTick, curTick)); }

function _el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.innerText = text;
  return e;
}

function renderCameraEditFields(title, body, cam) {
  title.innerText = `🎥 ${scCamName(cam)}` + (scCamIsStatic(cam) ? '(固定)' : '(動く)');

  // 名前
  const nameRow = _el('div', 'fieldRow');
  nameRow.appendChild(_el('label', null, '名前'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'panelInput'; nameInput.value = scCamName(cam);
  bindEditUndo(nameInput);
  nameInput.addEventListener('input', () => { cam.name = nameInput.value; timelineRenderBlocks(); });
  nameRow.appendChild(nameInput);
  body.appendChild(nameRow);

  // カメラの移動に関わる操作
  const actions = _el('div', 'panelActions');
  const mk = (text, fn, primary) => {
    const b = _el('button', 'btn btn-sm ' + (primary ? 'btn-primary' : 'btn-ghost'), text);
    b.addEventListener('click', fn);
    actions.appendChild(b);
  };
  const inPilot = typeof pilot !== 'undefined' && pilot && pilot.camId === cam.id;
  mk(inPilot ? '🎥 カメラ視点を終わる (V)' : '🎥 カメラ視点に入って動かす (V)', () => togglePilot(), true);
  mk('◆ 今の視点を、再生ヘッドの時刻に記録 (K)', () => actionRecordKey());
  mk('👁 このカメラが見える所へ移動', () => lookAtCameraFromOutside(cam));
  mk('⭐ このカメラの動きをカスタム素材に保存', () => { if (typeof saveCameraAsCustomAsset === 'function') saveCameraAsCustomAsset(cam); });
  body.appendChild(actions);

  // ---- 再生ヘッドの時刻の位置・角度 ----
  body.appendChild(_el('div', 'panelSectionLabel', '位置と角度(再生ヘッドの時刻)'));
  const status = _el('div', 'poseStatus');
  body.appendChild(status);

  const fields = {};
  const numRow = (label, key, step, unit) => {
    const row = _el('div', 'fieldRow');
    row.appendChild(_el('label', null, label));
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = String(step); inp.className = 'panelInput small';
    bindEditUndo(inp);
    inp.addEventListener('input', () => onCameraPoseInput(cam, key, parseFloat(inp.value)));
    inp.addEventListener('change', () => editorChanged());
    row.appendChild(inp);
    if (unit) row.appendChild(_el('span', 'fieldUnit', unit));
    fields[key] = inp;
    return row;
  };
  const posRow = _el('div', 'poseGrid');
  posRow.appendChild(numRow('X', 'x', 0.5));
  posRow.appendChild(numRow('Y(高さ)', 'y', 0.5));
  posRow.appendChild(numRow('Z', 'z', 0.5));
  body.appendChild(posRow);

  const angleRow = (label, key, min, max) => {
    const row = _el('div', 'fieldRow');
    row.appendChild(_el('label', null, label));
    const range = document.createElement('input');
    range.type = 'range'; range.min = String(min); range.max = String(max); range.step = '1';
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '1'; inp.min = String(min); inp.max = String(max); inp.className = 'panelInput small';
    bindEditUndo(range); bindEditUndo(inp);
    range.addEventListener('input', () => { inp.value = range.value; onCameraPoseInput(cam, key, parseFloat(range.value)); });
    inp.addEventListener('input', () => { range.value = inp.value; onCameraPoseInput(cam, key, parseFloat(inp.value)); });
    range.addEventListener('change', () => editorChanged());
    inp.addEventListener('change', () => editorChanged());
    row.appendChild(range); row.appendChild(inp); row.appendChild(_el('span', 'fieldUnit', '°'));
    fields[key] = inp; fields[key + 'Range'] = range;
    return row;
  };
  body.appendChild(angleRow('左右の向き', 'yaw', -180, 180));
  body.appendChild(angleRow('上下の向き', 'pitch', -88, 88));

  // 画角(カメラ全体で共通。キーごとには変わらない)
  const fovRow = _el('div', 'fieldRow');
  fovRow.appendChild(_el('label', null, '画角'));
  const fovSlider = document.createElement('input');
  fovSlider.type = 'range'; fovSlider.min = '20'; fovSlider.max = '110'; fovSlider.value = cam.fov;
  const fovValue = _el('span', 'fieldValue', Math.round(cam.fov) + '°');
  bindEditUndo(fovSlider);
  fovSlider.addEventListener('input', () => {
    cam.fov = parseInt(fovSlider.value); fovValue.innerText = cam.fov + '°';
    if (inPilot) { fcFovDeg = cam.fov; syncFovSliderUI(); }
  });
  fovRow.appendChild(fovSlider); fovRow.appendChild(fovValue);
  body.appendChild(fovRow);
  body.appendChild(_el('div', 'panelHint', '位置・角度を変えると、再生ヘッドの時刻にキー(◆)が無ければ自動で作られます。画角はカメラ全体で共通です。'));

  // ---- 速さのカーブ(再生ヘッドがある区間) ----
  body.appendChild(_el('div', 'panelSectionLabel', '動きの速さ(ポイントの間の進み方)'));
  const curveSection = _el('div', 'curveSection');
  body.appendChild(curveSection);

  camPanel = { camId: cam.id, fields, status, curveSection, curveSeg: null };
  syncCameraPanelToPlayhead(true);

  // ---- ポイント(◆)の一覧 ----
  body.appendChild(_el('div', 'panelSectionLabel', 'ポイント(◆)— クリックでその時刻へ'));
  const listEl = _el('div', 'keyList');
  body.appendChild(listEl);
  cam.keys.forEach((k, i) => {
    const row = _el('div', 'keyRow' + (i === selectedKeyIndex && cam.id === selectedCameraId ? ' active' : ''));
    row.appendChild(_el('span', 'keyRowLabel', `◆ ポイント${i + 1}`));
    const timeInput = document.createElement('input');
    timeInput.type = 'number'; timeInput.step = '0.1'; timeInput.className = 'panelInput small';
    timeInput.value = k.time.toFixed(2);
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
    row.appendChild(timeInput);
    row.appendChild(_el('span', 'fieldUnit', '秒'));
    if (cam.keys.length > 1) {
      const del = _el('button', 'keyRowDel', '✕');
      del.title = 'このポイントを削除';
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

  // ---- 表示位置(書き出す映像の中のどこに、どの大きさで映すか) ----
  body.appendChild(_el('div', 'panelSectionLabel', '画面の中での表示位置'));
  const presetGroup = _el('div', 'settingsRadioGroup');
  const cur = cam.display;
  const sameDisplay = (a, b) => (!a && !b) || (a && b && Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3 && Math.abs(a.w - b.w) < 1e-3);
  for (const [label, d] of DISPLAY_PRESETS) {
    const pill = _el('button', 'settingsRadioPill' + (sameDisplay(cur, d) ? ' active' : ''), label);
    pill.type = 'button';
    pill.addEventListener('click', () => {
      if (sameDisplay(cam.display, d)) return;
      pushUndo();
      cam.display = d ? { ...d } : null;
      _showCameraInPreview(cam);
      editorChanged();
    });
    presetGroup.appendChild(pill);
  }
  body.appendChild(presetGroup);

  const disp = cam.display ? scClampDisplay(cam.display) : null;
  const dispSlider = (label, key, min, max) => {
    const row = _el('div', 'fieldRow');
    row.appendChild(_el('label', null, label));
    const r = document.createElement('input');
    r.type = 'range'; r.min = String(min); r.max = String(max); r.step = '1';
    r.value = disp ? Math.round(disp[key] * 100) : (key === 'w' ? 100 : 0);
    r.disabled = !disp;
    const v = _el('span', 'fieldValue', r.value + '%');
    bindEditUndo(r);
    r.addEventListener('input', () => {
      if (!cam.display) return;
      const d = { ...cam.display, [key]: parseInt(r.value) / 100 };
      cam.display = scClampDisplay(d);
      v.innerText = r.value + '%';
      _showCameraInPreview(cam);
    });
    r.addEventListener('change', () => editorChanged()); // 大きさを変えると動かせる範囲が変わるので作り直す
    row.appendChild(r); row.appendChild(v);
    body.appendChild(row);
  };
  dispSlider('大きさ', 'w', 10, 100);
  dispSlider('横の位置', 'x', 0, 90);
  dispSlider('縦の位置', 'y', 0, 90);
  body.appendChild(_el('div', 'panelHint', '自動: 一番奥のカメラが全画面、同じ時間に重なった手前のカメラは右上に小窓で出ます。位置を決めると、そのカメラはいつもその位置・大きさで映ります(映っていない所は黒)。'));

  const delBtn = _el('button', 'btn btn-ghost btn-sm dangerBtn', '🗑 このカメラを削除');
  delBtn.addEventListener('click', () => { selectCamera(cam.id, null, false); deleteSelection(); });
  body.appendChild(delBtn);
}

// 表示位置を変えた時、その結果が見えるようにプレビューを主画面にする
function _showCameraInPreview(cam) {
  if (curTick < cam.startTick || curTick >= cam.endTick) seekTo(cam.startTick);
  if (typeof pilot !== 'undefined' && pilot) exitPilot(true);
  if (typeof previewIsMain !== 'undefined') previewIsMain = true;
}

// 位置・角度の欄に入力された時: 再生ヘッドの時刻のキーを書き換える(無ければ作る)
function onCameraPoseInput(cam, key, value) {
  if (isNaN(value)) return; // 「-」だけ打った途中など
  const tick = _camPanelTick(cam);
  const pose = scPoseAtTick(cam, tick);
  const patch = {};
  if (key === 'x' || key === 'y' || key === 'z') {
    const origin = [worldOriginX, worldOriginY, worldOriginZ];
    const i = { x: 0, y: 1, z: 2 }[key];
    const pos = pose.pos.slice();
    pos[i] = value - origin[i];
    patch.pos = pos;
  } else if (key === 'yaw') {
    patch.yaw = _deg2rad(value);
  } else if (key === 'pitch') {
    patch.pitch = _deg2rad(Math.max(-88, Math.min(88, value)));
  }
  const r = scEditPoseAtTick(cam, tick, patch);
  selectedCameraId = cam.id; selectedKeyIndex = r.index; selectedKeyExplicit = true;
  if (r.created) {
    timelineRenderBlocks(); // 新しい◆をすぐタイムラインに出す
    showToast(`◆ ${r.seconds.toFixed(1)}秒にキーを自動で作りました`);
  }
}

// 毎フレーム呼ばれる(ui.jsのupdateScrubUIから)。再生ヘッドが動いたり、
// ギズモやKで値が変わったりした時に、パネルの数値を追従させる。
// 入力中・ドラッグ中の欄は書き換えない。
function syncCameraPanelToPlayhead(force) {
  if (!camPanel || !editPanelOpenFor || editPanelOpenFor.kind !== 'camera' || editPanelOpenFor.id !== camPanel.camId) return;
  const cam = scGetCamera(camPanel.camId);
  if (!cam) return;
  const tick = _camPanelTick(cam);
  const pose = scPoseAtTick(cam, tick);
  const vals = {
    x: (pose.pos[0] + worldOriginX).toFixed(1),
    y: (pose.pos[1] + worldOriginY).toFixed(1),
    z: (pose.pos[2] + worldOriginZ).toFixed(1),
    yaw: String(Math.round(_normDeg(_rad2deg(pose.yaw)))),
    pitch: String(Math.round(_rad2deg(pose.pitch))),
  };
  const active = document.activeElement;
  for (const k of Object.keys(vals)) {
    const inp = camPanel.fields[k];
    if (!inp || inp === active) continue;
    const range = camPanel.fields[k + 'Range'];
    if (range && (range === active && editPanelPointerDown)) continue;
    if (force || inp.value !== vals[k]) inp.value = vals[k];
    if (range && range !== active && range.value !== vals[k]) range.value = vals[k];
  }
  const seg = tlCurveSegmentAt(cam, tick);
  if (force || camPanel.curveSeg !== seg) {
    camPanel.curveSeg = seg;
    _renderCurveSection(camPanel.curveSection, cam, seg);
    const svg = document.querySelector('.tlBlock.cam.expanded .tlCurveGraph svg');
    if (svg) _drawCurveGraph(svg, cam); // 明るく見せる区間を追従させる
  }
  const idx = scKeyIndexAtTick(cam, tick);
  const sec = ((tick - cam.startTick) / scTps()).toFixed(1);
  const outside = curTick < cam.startTick || curTick > cam.endTick;
  let text, cls;
  if (outside) { text = `再生ヘッドがこのカメラの時間の外です。編集はカメラの端(${sec}秒)に対して行われます`; cls = 'warn'; }
  else if (idx >= 0) { text = `◆ ポイント${idx + 1}(${sec}秒)を編集しています`; cls = 'onKey'; }
  else { text = `${sec}秒にはキーがありません — 値を変えると、ここに自動でキーが作られます`; cls = 'noKey'; }
  if (camPanel.status.innerText !== text) camPanel.status.innerText = text;
  camPanel.status.className = 'poseStatus ' + cls;
}

// パネルの「動きの速さ」欄。再生ヘッドがある区間のカーブをひな形から選ぶ
function _renderCurveSection(box, cam, seg) {
  box.innerHTML = '';
  if (seg < 0) {
    box.appendChild(_el('div', 'panelHint', '固定カメラです。ポイントが2つ以上の動くカメラになると、ポイントの間の進み方(ゆっくり始まる・なめらかに止まる等)を選べます。'));
    return;
  }
  box.appendChild(_el('div', 'curveSegLabel', `◆${seg + 1} → ◆${seg + 2} の区間(再生ヘッドの位置)`));
  const cur = scCurvePresetId(cam.keys[seg].curve);
  const group = _el('div', 'settingsRadioGroup');
  for (const [id, p] of Object.entries(CURVE_PRESETS)) {
    const pill = _el('button', 'settingsRadioPill curvePill' + (cur === id ? ' active' : ''));
    pill.type = 'button';
    pill.appendChild(_curveIcon(p.c));
    pill.appendChild(document.createTextNode(p.label));
    pill.addEventListener('click', () => {
      if (cur === id) return;
      pushUndo();
      tlSetSegmentCurve(cam, seg, p.c);
      editorChanged();
    });
    group.appendChild(pill);
  }
  box.appendChild(group);
  if (!cur) box.appendChild(_el('div', 'panelHint', 'この区間は、グラフで調整したカスタムのカーブです。'));
  const allBtn = _el('button', 'btn btn-ghost btn-sm', 'すべての区間をこのカーブにする');
  allBtn.disabled = cam.keys.length < 3;
  allBtn.addEventListener('click', () => {
    pushUndo();
    tlSetSegmentCurve(cam, -1, scKeyCurve(cam.keys[seg]));
    showToast('すべての区間に同じカーブを使いました');
    editorChanged();
  });
  box.appendChild(allBtn);
  box.appendChild(_el('div', 'panelHint', 'タイムラインの広がったブロックの○をドラッグすると細かく調整できます(Shiftで左右対称)。グラフの傾きが急な所ほど速く、平らな所ほどゆっくり動きます。'));
}

function _curveIcon(c) {
  const svg = _svg('svg', { width: 18, height: 14, viewBox: '0 0 18 14', class: 'curveIcon' });
  svg.appendChild(_svg('path', { d: `M1,13 C${1 + c[0] * 16},${13 - c[1] * 12} ${1 + c[2] * 16},${13 - c[3] * 12} 17,1`, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 }));
  return svg;
}

function closeEditPanel() {
  const wasExpanded = tlExpandedCamId();
  camPanel = null;
  document.getElementById('editPanel').classList.remove('open');
  document.getElementById('editor').classList.remove('panelOpen');
  editPanelOpenFor = null;
  if (wasExpanded != null) timelineRenderBlocks();
}

// 編集パネルが開いている間は、選択を切り替えるとパネルの中身も追従させる
// (何も選んでいない状態になったら閉じる)
function refreshEditPanelIfOpen() {
  if (!editPanelOpenFor) return;
  const item = getSelectedItem();
  if (item) openEditPanel(item); else closeEditPanel();
}
