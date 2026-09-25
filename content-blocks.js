// content-blocks.js
// ============================================================
// 📝テキストブロック(🎵音楽ブロックは後続ステップで追加予定)。
//
// タイムライン上の操作(ドラッグ・伸縮・吸着・取り消し)は timeline.js の
// 共通処理(tlStartBlockDrag)を使う。テキストは層の意味を持たないので、
// 時間が重なったブロックは見やすいよう自動で段を分けて表示するだけ。
//
// 位置(x/y)は「書き出す映像の枠」に対する0〜1の割合。プレビュー(主画面、
// または右下の小窓)の、書き出しと同じ縦横比の枠の上でドラッグして決める。
// 文字の大きさも枠の高さに比例させる(fontSizeは「高さ720pxの時の大きさ」)
// ので、プレビューの大きさが変わっても、書き出した動画と同じ見え方になる。
// ============================================================

let textBlocks = [];
let nextTextBlockId = 1;
let selectedTextBlockId = null;

const DEFAULT_TEXT_BLOCK_SECONDS = 2;
const TEXT_REFERENCE_HEIGHT = 720;

function ctAddTextBlock() {
  const tps = scTps();
  const maxTick = scMaxTick();
  let start = Math.round(curTick);
  if (maxTick > 0) start = Math.min(start, Math.max(0, maxTick - 1));
  let end = start + Math.round(tps * DEFAULT_TEXT_BLOCK_SECONDS);
  if (maxTick > 0) end = Math.min(end, maxTick);
  const block = {
    id: nextTextBlockId++, kind: 'text',
    startTick: start, endTick: Math.max(end, start + 1),
    content: 'テキスト', fontSize: 48, color: '#ffffff', weight: 700, anim: 'fade',
    x: 0.5, y: 0.82,
  };
  textBlocks.push(block);
  return block;
}

function ctDeleteTextBlock(id) { textBlocks = textBlocks.filter(t => t.id !== id); }

function ctSplitTextBlock(block, tick) {
  if (tick <= block.startTick || tick >= block.endTick) return null;
  const right = { ...block, id: nextTextBlockId++, startTick: tick };
  block.endTick = tick;
  textBlocks.push(right);
  return right;
}

function ctDuplicateTextBlock(block) {
  const len = block.endTick - block.startTick;
  const maxTick = scMaxTick();
  let start = block.endTick;
  if (maxTick > 0 && start + len > maxTick) start = Math.max(0, maxTick - len);
  const dup = { ...block, id: nextTextBlockId++, startTick: start, endTick: start + len };
  textBlocks.push(dup);
  return dup;
}

function ctActiveTextBlocksAtTick(tick) {
  return textBlocks.filter(t => tick >= t.startTick && tick < t.endTick);
}

function actionAddText() {
  pushUndo();
  const block = ctAddTextBlock();
  selectText(block.id);
  openEditPanel(block);
  showToast('📝 テキストを追加しました。プレビュー上でドラッグして位置を決められます');
  // 位置を決めやすいよう、プレビューが見える状態にする
  if (typeof sceneCameras !== 'undefined' && sceneCameras.length && typeof previewIsMain !== 'undefined') {
    if (typeof pilot !== 'undefined' && pilot) exitPilot(true);
    previewIsMain = true;
  }
}


// ============================================================
// 初期化・タイムラインのテキスト行
// ============================================================

function contentBlocksInit() {
  document.getElementById('addTextBlockBtn').addEventListener('click', (e) => { e.stopPropagation(); actionAddText(); });
}

// 時間が重なるブロックを、見やすいよう段に分ける(表示だけの話)
function _ctAssignRows() {
  const sorted = textBlocks.slice().sort((a, b) => a.startTick - b.startTick);
  const rowEnds = [];
  const rows = new Map();
  for (const b of sorted) {
    let r = rowEnds.findIndex(end => end <= b.startTick);
    if (r < 0) { r = rowEnds.length; rowEnds.push(0); }
    rowEnds[r] = b.endTick;
    rows.set(b.id, r);
  }
  return { rows, count: Math.max(1, rowEnds.length) };
}

function renderTextTrackBlocks() {
  const lane = document.getElementById('timelineTextLane');
  if (!lane) return;
  lane.innerHTML = '';
  lane.style.width = tlTotalWidth() + 'px';
  const { rows, count } = _ctAssignRows();
  const h = count * TL_ROW_H;
  lane.style.height = h + 'px';
  lane.parentElement.style.height = h + 'px';
  for (const block of textBlocks) {
    lane.appendChild(ctBuildBlockElement(block, rows.get(block.id) || 0));
  }
  if (!textBlocks.length) {
    const empty = document.createElement('div');
    empty.className = 'tlEmpty';
    empty.innerText = '左の ＋ で、再生ヘッドの位置にテキストを追加できます';
    lane.appendChild(empty);
  }
}

function ctBuildBlockElement(block, row) {
  const ppt = tlPxPerTick();
  const el = document.createElement('div');
  el.className = 'tlBlock text' + (block.id === selectedTextBlockId ? ' selected' : '');
  el.style.left = (block.startTick * ppt) + 'px';
  el.style.width = Math.max(6, (block.endTick - block.startTick) * ppt) + 'px';
  el.style.top = (row * TL_ROW_H + 3) + 'px';

  const label = document.createElement('div');
  label.className = 'tlBlockLabel';
  label.innerText = '📝 ' + (block.content.replace(/\s+/g, ' ').slice(0, 24) || '(空)');
  el.appendChild(label);
  _addResizeHandles(el);

  el.addEventListener('mousedown', (e) => tlStartBlockDrag(e, 'text', block));
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    selectText(block.id);
    openEditPanel(block);
  });
  return el;
}


// ============================================================
// プレビュー上のテキスト表示・ドラッグ配置
// ============================================================
// #textOverlayLayer を、プレビュー(主画面 or 右下の小窓)の「書き出しと同じ
// 縦横比の枠」にぴったり重ねる。毎フレーム呼ばれるので、要素は作り直さず
// 使い回す(作り直すとドラッグやダブルクリックが途切れるため)。

let ctOverlayDrag = null;

function updateTextOverlayLayerRect() {
  const layer = document.getElementById('textOverlayLayer');
  if (!layer || typeof fcCanvas === 'undefined' || !fcCanvas) return;

  const hasCamera = (typeof sceneCameras !== 'undefined') && sceneCameras.length > 0;
  const showOnMain = (typeof previewIsMain !== 'undefined') && previewIsMain;
  if (!showOnMain && !hasCamera) { layer.classList.remove('show'); return; }

  const r = previewRectCSS(showOnMain);
  layer.style.left = r.left + 'px'; layer.style.top = r.top + 'px';
  layer.style.width = r.width + 'px'; layer.style.height = r.height + 'px';
  layer.classList.toggle('onInset', !showOnMain);

  const active = ctActiveTextBlocksAtTick(curTick);
  layer.classList.toggle('show', active.length > 0);
  _syncOverlayItems(layer, active, r.height);
}

function _syncOverlayItems(layer, active, frameH) {
  const want = new Set(active.map(b => String(b.id)));
  for (const el of Array.from(layer.children)) {
    if (!want.has(el.dataset.id)) el.remove();
  }
  for (const block of active) {
    let el = layer.querySelector(`[data-id="${block.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'textOverlayItem';
      el.dataset.id = String(block.id);
      el.addEventListener('mousedown', (e) => _startOverlayDrag(e, block.id, layer));
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const b = textBlocks.find(t => t.id === block.id);
        if (b) { selectText(b.id); openEditPanel(b); }
      });
      layer.appendChild(el);
    }
    el.classList.toggle('selected', block.id === selectedTextBlockId);
    el.style.left = (block.x * 100) + '%';
    el.style.top = (block.y * 100) + '%';
    el.style.fontSize = Math.max(4, block.fontSize * frameH / TEXT_REFERENCE_HEIGHT) + 'px';
    el.style.color = block.color;
    el.style.fontWeight = block.weight;
    if (el.innerText !== block.content) el.innerText = block.content;
  }
}

function _startOverlayDrag(e, id, layer) {
  if (e.button !== 0) return;
  e.stopPropagation(); e.preventDefault();
  const block = textBlocks.find(t => t.id === id);
  if (!block) return;
  if (selectedTextBlockId !== id) selectText(id);
  beginEdit();
  const rect = layer.getBoundingClientRect();
  const offX = block.x - (e.clientX - rect.left) / rect.width;
  const offY = block.y - (e.clientY - rect.top) / rect.height;
  const onMove = (ev) => {
    let x = (ev.clientX - rect.left) / rect.width + offX;
    let y = (ev.clientY - rect.top) / rect.height + offY;
    // 横の中央・縦の中央/下1/3に吸着(Altで解除)
    if (!ev.altKey) {
      if (Math.abs(x - 0.5) < 0.02) x = 0.5;
      for (const g of [0.5, 0.82]) if (Math.abs(y - g) < 0.02) y = g;
    }
    block.x = Math.max(0, Math.min(1, x));
    block.y = Math.max(0, Math.min(1, y));
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    commitEdit();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}


// ============================================================
// 編集パネルの中身(timeline.jsのopenEditPanelから、kind:'text'の時に呼ばれる)
// ============================================================

function renderTextEditFields(body, block) {
  const contentRow = document.createElement('div');
  contentRow.className = 'fieldRow column';
  contentRow.innerHTML = '<label>内容</label>';
  const contentInput = document.createElement('textarea');
  contentInput.className = 'panelInput';
  contentInput.value = block.content;
  contentInput.rows = 3;
  bindEditUndo(contentInput);
  contentInput.addEventListener('input', () => {
    block.content = contentInput.value;
    renderTextTrackBlocks();
  });
  contentRow.appendChild(contentInput);
  body.appendChild(contentRow);

  const sizeRow = document.createElement('div');
  sizeRow.className = 'fieldRow';
  sizeRow.innerHTML = '<label>文字サイズ</label>';
  const sizeSlider = document.createElement('input');
  sizeSlider.type = 'range'; sizeSlider.min = '16'; sizeSlider.max = '140'; sizeSlider.value = block.fontSize;
  const sizeValue = document.createElement('span');
  sizeValue.className = 'fieldValue';
  sizeValue.innerText = block.fontSize;
  bindEditUndo(sizeSlider);
  sizeSlider.addEventListener('input', () => {
    block.fontSize = parseInt(sizeSlider.value);
    sizeValue.innerText = block.fontSize;
  });
  sizeRow.appendChild(sizeSlider); sizeRow.appendChild(sizeValue);
  body.appendChild(sizeRow);

  const colorRow = document.createElement('div');
  colorRow.className = 'fieldRow';
  colorRow.innerHTML = '<label>色</label>';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'colorInput';
  colorInput.value = block.color;
  bindEditUndo(colorInput);
  colorInput.addEventListener('input', () => { block.color = colorInput.value; });
  colorRow.appendChild(colorInput);
  body.appendChild(colorRow);

  const pillRow = (labelText, options, current, onPick) => {
    const row = document.createElement('div');
    row.className = 'fieldRow';
    row.innerHTML = `<label>${labelText}</label>`;
    const group = document.createElement('div');
    group.className = 'settingsRadioGroup';
    for (const [text, val] of options) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'settingsRadioPill' + (current === val ? ' active' : '');
      pill.innerText = text;
      pill.addEventListener('click', () => {
        if (current === val) return; // 同じ値の選び直しは履歴を汚さない
        pushUndo(); onPick(val); openEditPanel(block);
      });
      group.appendChild(pill);
    }
    row.appendChild(group);
    body.appendChild(row);
  };
  pillRow('太さ', [['普通', 400], ['太字', 700], ['極太', 900]], block.weight, (v) => { block.weight = v; });
  pillRow('出方', [['フェード', 'fade'], ['スライドアップ', 'slideUp'], ['ポップ', 'pop']], block.anim, (v) => { block.anim = v; });

  const hint = document.createElement('div');
  hint.className = 'panelHint';
  hint.innerText = '位置は、プレビュー(右下の小窓、または主画面のプレビュー)上の文字をドラッグして決めます。中央と下1/3に吸着します(Altで解除)。出方のアニメーションは書き出し時に反映されます。';
  body.appendChild(hint);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-ghost btn-sm dangerBtn';
  deleteBtn.innerText = '🗑 このテキストを削除';
  deleteBtn.addEventListener('click', () => { selectText(block.id); deleteSelection(); });
  body.appendChild(deleteBtn);
}
