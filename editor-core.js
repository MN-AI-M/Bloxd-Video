// editor-core.js
// ============================================================
// 編集操作の土台。どの画面・どのトラックからでも共通で使う仕組みをまとめる。
//
//   - 取り消し/やり直し(Undo/Redo)
//       ボタン1回で終わる操作は、変更の直前に pushUndo()。
//       ドラッグやスライダー、文字入力のように「続けて変わる」操作は、
//       始まる瞬間に beginEdit()、終わった瞬間に commitEdit()。
//       commitEdit() は実際に中身が変わっていなければ履歴を積まない
//       (触っただけで何も変えていない時に、空振りの履歴が残らないように)。
//   - 選択(カメラのブロック/キー、テキストのブロック)の切り替え
//   - 画面全体の更新(editorChanged)
//   - キーボードショートカット(文字入力中は反応しない)
//   - 画面上部の通知(トースト)・操作ヘルプ
// ============================================================

const HISTORY_LIMIT = 100;
let undoStack = [];
let redoStack = [];
let pendingEditJson = null;

function _editorStateSnapshot() {
  return {
    sceneCameras: sceneCameras,
    textBlocks: (typeof textBlocks !== 'undefined') ? textBlocks : [],
    nextSceneCameraId: nextSceneCameraId,
    nextTextBlockId: (typeof nextTextBlockId !== 'undefined') ? nextTextBlockId : 1,
  };
}
function _editorStateJson() { return JSON.stringify(_editorStateSnapshot()); }

function _restoreEditorState(json) {
  const s = JSON.parse(json);
  sceneCameras = s.sceneCameras;
  nextSceneCameraId = s.nextSceneCameraId;
  if (typeof textBlocks !== 'undefined') { textBlocks = s.textBlocks; nextTextBlockId = s.nextTextBlockId; }
  // 選択中の物が消えていたら選択を外す(残っていれば選択を保つ)
  const cam = scGetSelected();
  if (!cam) { selectedCameraId = null; selectedKeyIndex = null; selectedKeyExplicit = false; }
  else if (selectedKeyIndex != null && selectedKeyIndex >= cam.keys.length) selectedKeyIndex = cam.keys.length - 1;
  if (typeof selectedTextBlockId !== 'undefined' && selectedTextBlockId != null &&
      !textBlocks.some(t => t.id === selectedTextBlockId)) selectedTextBlockId = null;
  if (typeof pilot !== 'undefined' && pilot && !scGetCamera(pilot.camId)) exitPilot(true);
}

function _pushHistory(json) {
  undoStack.push(json);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}

// 1回で終わる操作の直前に呼ぶ
function pushUndo() {
  commitEdit(); // 続けて変わる操作の途中だったら、先にそちらを確定させる
  _pushHistory(_editorStateJson());
}

// 続けて変わる操作(ドラッグ・スライダー・文字入力)の開始時に呼ぶ
function beginEdit() {
  if (pendingEditJson == null) pendingEditJson = _editorStateJson();
}
// 続けて変わる操作の終了時に呼ぶ。実際に変わっていた時だけ履歴に積む。
function commitEdit() {
  if (pendingEditJson == null) return;
  const before = pendingEditJson;
  pendingEditJson = null;
  if (before !== _editorStateJson()) _pushHistory(before);
}

function undo() {
  commitEdit();
  if (!undoStack.length) { showToast('これ以上取り消せません'); return; }
  redoStack.push(_editorStateJson());
  _restoreEditorState(undoStack.pop());
  editorChanged();
  updateUndoButtons();
  showToast('↶ 取り消しました');
}

function redo() {
  commitEdit();
  if (!redoStack.length) { showToast('やり直せる操作がありません'); return; }
  undoStack.push(_editorStateJson());
  _restoreEditorState(redoStack.pop());
  editorChanged();
  updateUndoButtons();
  showToast('↷ やり直しました');
}

function updateUndoButtons() {
  const u = document.getElementById('undoBtn'), r = document.getElementById('redoBtn');
  if (u) u.disabled = undoStack.length === 0;
  if (r) r.disabled = redoStack.length === 0;
}


// ============================================================
// 選択
// ============================================================

// keyIndex=null なら、再生ヘッドに一番近いキーを操作対象にする。
// explicit=true は「◆やギズモを直接クリックしてそのキーを選んだ」時。
function selectCamera(id, keyIndex, explicit) {
  const cam = scGetCamera(id);
  if (!cam) return;
  selectedCameraId = id;
  selectedKeyIndex = (keyIndex == null) ? scNearestKeyIndex(cam, curTick) : keyIndex;
  selectedKeyExplicit = !!explicit;
  if (typeof selectedTextBlockId !== 'undefined') selectedTextBlockId = null;
  editorChanged();
}

function selectText(id) {
  selectedCameraId = null; selectedKeyIndex = null; selectedKeyExplicit = false;
  selectedTextBlockId = id;
  editorChanged();
}

function clearSelection() {
  selectedCameraId = null; selectedKeyIndex = null; selectedKeyExplicit = false;
  if (typeof selectedTextBlockId !== 'undefined') selectedTextBlockId = null;
  editorChanged();
}

function getSelectedItem() {
  const cam = scGetSelected();
  if (cam) return cam;
  if (typeof selectedTextBlockId !== 'undefined' && selectedTextBlockId != null) {
    return textBlocks.find(t => t.id === selectedTextBlockId) || null;
  }
  return null;
}

// データが変わった後に呼ぶ、画面全体の更新
function editorChanged() {
  if (typeof timelineRefresh === 'function') timelineRefresh();
  if (typeof updatePinPVisibility === 'function') updatePinPVisibility();
}


// ============================================================
// 選択中の物に対する操作(削除・分割・複製)
// ============================================================

function deleteSelection() {
  const cam = scGetSelected();
  if (cam) {
    if (selectedKeyExplicit && cam.keys.length > 1 && selectedKeyIndex != null) {
      pushUndo();
      scDeleteKey(cam, selectedKeyIndex);
      selectedKeyIndex = Math.min(selectedKeyIndex, cam.keys.length - 1);
      selectedKeyExplicit = false;
      showToast(cam.keys.length === 1 ? '◆ キーを削除しました(静的ショットになりました)' : '◆ キーを削除しました');
      editorChanged();
      return;
    }
    pushUndo();
    if (typeof pilot !== 'undefined' && pilot && pilot.camId === cam.id) exitPilot(true);
    scDeleteCamera(cam.id);
    selectedCameraId = null; selectedKeyIndex = null; selectedKeyExplicit = false;
    if (typeof previewIsMain !== 'undefined' && sceneCameras.length === 0) previewIsMain = false;
    showToast('🗑 ' + scCamName(cam) + 'を削除しました');
    editorChanged();
    return;
  }
  const text = getSelectedItem();
  if (text && text.kind === 'text') {
    pushUndo();
    ctDeleteTextBlock(text.id);
    selectedTextBlockId = null;
    showToast('🗑 テキストを削除しました');
    editorChanged();
    return;
  }
  showToast('削除するものを選んでください');
}

function splitSelectionAtPlayhead() {
  const item = getSelectedItem();
  if (!item) { showToast('分割するブロックを選んでください'); return; }
  if (curTick <= item.startTick || curTick >= item.endTick) {
    showToast('再生ヘッドを、分割したいブロックの上に合わせてください');
    return;
  }
  pushUndo();
  if (item.kind === 'text') {
    const right = ctSplitTextBlock(item, curTick);
    if (right) selectText(right.id);
  } else {
    const right = scSplitCamera(item, curTick);
    if (right) selectCamera(right.id, 0, false);
  }
  showToast('✂ 分割しました');
}

function duplicateSelection() {
  const item = getSelectedItem();
  if (!item) { showToast('複製するブロックを選んでください'); return; }
  pushUndo();
  if (item.kind === 'text') {
    const dup = ctDuplicateTextBlock(item);
    selectText(dup.id);
  } else {
    const dup = scDuplicateCamera(item);
    selectCamera(dup.id, 0, false);
  }
  showToast('⧉ 複製しました');
}


// ============================================================
// 再生位置の移動
// ============================================================

function seekTo(tick) {
  const maxTick = scMaxTick();
  curTick = Math.max(0, Math.min(maxTick, Math.round(tick)));
  if (typeof timelineUpdatePlayhead === 'function') timelineUpdatePlayhead();
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const t = (el.type || '').toLowerCase();
    // スライダー・色・チェックボックスは文字入力ではないので、ショートカットを邪魔しない
    return !['range', 'color', 'checkbox', 'radio', 'button', 'file'].includes(t);
  }
  return !!el.isContentEditable;
}


// ============================================================
// キーボードショートカット(ここ1か所でまとめて受ける)
// ============================================================

function setupEditorShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('editor').classList.contains('active')) return;
    const typing = isTypingTarget(e.target);
    if (typing) {
      if (e.key === 'Escape') e.target.blur();
      return; // 文字を打っている最中は、Backspace等を一切横取りしない
    }
    if (document.getElementById('settingsModal').classList.contains('open')) return;

    const flying = (typeof isFlightControlActive === 'function') && isFlightControlActive();
    const mod = e.ctrlKey || e.metaKey;

    // --- Ctrl/Cmd との組み合わせ ---
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
      else if (k === 'd') { e.preventDefault(); duplicateSelection(); }
      return;
    }

    // --- 移動キー(押している間だけ動く。freecam.jsが毎フレーム読む) ---
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(e.code) ||
        (flying && (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight'))) {
      fcKeys[e.code] = true;
      if (e.code === 'Space') e.preventDefault();
      if (typeof onMovementKeyPressed === 'function') onMovementKeyPressed();
      return;
    }
    if (e.repeat && !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
        if (typeof togglePlayback === 'function') togglePlayback();
        return;
      case 'KeyF': e.preventDefault(); actionNewCamera(); return;
      case 'KeyK': e.preventDefault(); actionRecordKey(); return;
      case 'KeyV': e.preventDefault(); togglePilot(); return;
      case 'KeyB': e.preventDefault(); splitSelectionAtPlayhead(); return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault(); deleteSelection(); return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        if (typeof stopPlayback === 'function') stopPlayback();
        const step = e.shiftKey ? scTps() : 1;
        seekTo(curTick + (e.code === 'ArrowLeft' ? -step : step));
        return;
      }
      case 'Home': e.preventDefault(); seekTo(0); return;
      case 'End': e.preventDefault(); seekTo(scMaxTick()); return;
      case 'Escape':
        if (document.getElementById('helpOverlay').classList.contains('open')) { toggleHelp(false); return; }
        if (typeof pilot !== 'undefined' && pilot) { exitPilot(true); return; }
        if (document.getElementById('editPanel').classList.contains('open')) { closeEditPanel(); return; }
        clearSelection();
        return;
    }
    if (e.key === '?') { toggleHelp(); return; }
  });

  document.addEventListener('keyup', (e) => { fcKeys[e.code] = false; });
  // ウィンドウから離れた時にキーが押しっぱなし扱いになるのを防ぐ
  window.addEventListener('blur', () => { for (const k in fcKeys) fcKeys[k] = false; });

  // ボタンをクリックした後にフォーカスが残ると、Spaceでそのボタンがもう一度
  // 押されてしまうので、クリック後はフォーカスを外しておく
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (b) b.blur();
  });
}


// ============================================================
// 通知(トースト)
// ============================================================

let toastTimer = null;
function showToast(text) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.innerText = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}


// ============================================================
// 操作ヘルプ
// ============================================================

function toggleHelp(force) {
  const el = document.getElementById('helpOverlay');
  const open = (force === undefined) ? !el.classList.contains('open') : force;
  el.classList.toggle('open', open);
}

function setupHelpOverlay() {
  document.getElementById('helpBtn').addEventListener('click', () => toggleHelp());
  const overlay = document.getElementById('helpOverlay');
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) toggleHelp(false); });
  document.getElementById('helpClose').addEventListener('click', () => toggleHelp(false));
}

function editorCoreInit() {
  setupEditorShortcuts();
  setupHelpOverlay();
  updateUndoButtons();
}
