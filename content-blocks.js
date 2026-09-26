// content-blocks.js
// ============================================================
// 📝テキストブロック(🎵音楽ブロックは後続ステップで追加予定)。
// 追加は、左の素材一覧(asset-library.js)の「テキスト」から行う。
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

// 文字の見た目の標準値。大きさ・縁取り・余白などのpx値は「高さ720pxの時」の値で、
// プレビュー・書き出しの大きさに合わせて比例させる。
const TEXT_STYLE_DEFAULTS = {
  font: 'gothic', fontSize: 48, weight: 700, italic: false,
  color: '#ffffff', opacity: 100,
  align: 'center', letterSpacing: 0, lineHeight: 1.2,
  strokeWidth: 0, strokeColor: '#000000',
  shadow: 'soft', shadowColor: '#000000',
  bgOpacity: 0, bgColor: '#000000', bgPadding: 12, bgRadius: 6,
  rotation: 0,
  animIn: 'fade', animInSec: 0.4, animOut: 'fade', animOutSec: 0.3,
};
// スタイルとして保存・コピーする項目(内容・位置・時間以外)
const TEXT_STYLE_KEYS = Object.keys(TEXT_STYLE_DEFAULTS);

const TEXT_FONTS = {
  gothic:  { label: 'ゴシック',   css: "'Zen Kaku Gothic New', 'Hiragino Sans', sans-serif" },
  rounded: { label: '丸ゴシック', css: "'M PLUS Rounded 1c', 'Hiragino Maru Gothic ProN', sans-serif" },
  mincho:  { label: '明朝',       css: "'Noto Serif JP', 'Hiragino Mincho ProN', 'Yu Mincho', serif" },
  pixel:   { label: 'ドット',     css: "'DotGothic16', monospace" },
  display: { label: '英字(太め)', css: "'Bricolage Grotesque', 'Zen Kaku Gothic New', sans-serif" },
};

const TEXT_ANIMS_IN = [['なし', 'none'], ['フェード', 'fade'], ['下から', 'slideUp'], ['上から', 'slideDown'],
  ['左から', 'slideLeft'], ['右から', 'slideRight'], ['ポップ', 'pop'], ['ズーム', 'zoom'], ['タイプ', 'typewriter']];
const TEXT_ANIMS_OUT = [['なし', 'none'], ['フェード', 'fade'], ['上へ', 'slideUp'], ['下へ', 'slideDown'],
  ['左へ', 'slideLeft'], ['右へ', 'slideRight'], ['縮む', 'pop'], ['ズーム', 'zoom']];

// 古いデータ(anim だけを持つ)を新しい形に揃える
function ctNormalizeTextBlock(b) {
  if (b.anim && !b.animIn) b.animIn = b.anim;
  delete b.anim;
  for (const k of TEXT_STYLE_KEYS) if (b[k] === undefined) b[k] = TEXT_STYLE_DEFAULTS[k];
  return b;
}

// props: 見た目の初期値(content, x, y, seconds と TEXT_STYLE_DEFAULTS の項目)。省略した所は標準の値
function ctAddTextBlock(tick, props) {
  const tps = scTps();
  const maxTick = scMaxTick();
  props = { ...(props || {}) };
  const seconds = props.seconds || DEFAULT_TEXT_BLOCK_SECONDS;
  delete props.seconds;
  let start = Math.round(tick);
  if (maxTick > 0) start = Math.min(start, Math.max(0, maxTick - 1));
  let end = start + Math.round(tps * seconds);
  if (maxTick > 0) end = Math.min(end, maxTick);
  const block = ctNormalizeTextBlock({
    id: nextTextBlockId++, kind: 'text',
    startTick: start, endTick: Math.max(end, start + 1),
    content: 'テキスト', x: 0.5, y: 0.82,
    ...TEXT_STYLE_DEFAULTS,
    ...props,
  });
  textBlocks.push(block);
  return block;
}

function ctTextStyleOf(block) {
  const out = {};
  for (const k of TEXT_STYLE_KEYS) out[k] = block[k];
  return out;
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

// 素材一覧から呼ばれる: 指定した時刻にテキストを追加して、編集パネルを開く
function addTextAt(tick, props, label) {
  pushUndo();
  const block = ctAddTextBlock(tick, props);
  if (curTick < block.startTick || curTick >= block.endTick) seekTo(block.startTick);
  selectText(block.id);
  openEditPanel(block);
  showToast(`📝 ${label || 'テキスト'}を追加しました。プレビュー上でドラッグして位置を決められます`);
  // 位置を決めやすいよう、プレビューが見える状態にする
  if (typeof sceneCameras !== 'undefined' && sceneCameras.length && typeof previewIsMain !== 'undefined') {
    if (typeof pilot !== 'undefined' && pilot) exitPilot(true);
    previewIsMain = true;
  }
  return block;
}


// ============================================================
// タイムラインのテキスト行
// ============================================================

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
    empty.innerText = '左の素材一覧の「📝 テキスト」から追加できます(クリック、またはここへドラッグ)';
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

  el.addEventListener('mousedown', (e) => {
    // ダブルクリック(2回目の mousedown)。描き直しで要素が入れ替わっても確実に拾える
    if (e.button === 0 && e.detail >= 2) {
      e.stopPropagation(); e.preventDefault();
      tlDrag = null;
      selectText(block.id);
      openEditPanel(block);
      return;
    }
    tlStartBlockDrag(e, 'text', block);
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
    ctApplyTextStyle(el, block, frameH, ctAnimState(block, curTick));
  }
}

// 再生ヘッドの時刻でのアニメーションの状態。
// 止めて選んでいる間は、位置を決めやすいよう動きを付けずに全部見せる。
function ctAnimState(block, tick) {
  const st = { opacity: 1, dx: 0, dy: 0, scale: 1, chars: Infinity };
  const isPlaying = (typeof playing !== 'undefined') && playing;
  if (!isPlaying && block.id === selectedTextBlockId) return st;
  const tps = scTps();
  const t = (tick - block.startTick) / tps;
  const left = (block.endTick - tick) / tps;
  const ease = (u) => 1 - Math.pow(1 - u, 3);
  const apply = (kind, u, dirSign) => {
    // u: 0=見えていない 1=完全に出ている
    if (u >= 1 || kind === 'none') return;
    const e = ease(Math.max(0, u));
    const off = (1 - e) * 0.12; // 枠の高さに対する割合
    switch (kind) {
      case 'fade': st.opacity *= e; break;
      case 'slideUp': st.opacity *= e; st.dy += off * dirSign; break;
      case 'slideDown': st.opacity *= e; st.dy -= off * dirSign; break;
      case 'slideLeft': st.opacity *= e; st.dx -= off * 1.6 * dirSign; break;
      case 'slideRight': st.opacity *= e; st.dx += off * 1.6 * dirSign; break;
      case 'pop': {
        st.opacity *= Math.min(1, u * 3);
        // 入りは少し大きくなってから戻る(バネっぽく)、出は縮む
        st.scale *= dirSign > 0 ? (u < 0.7 ? 0.4 + (u / 0.7) * 0.75 : 1.15 - ((u - 0.7) / 0.3) * 0.15) : 0.3 + 0.7 * e;
        break;
      }
      case 'zoom': st.opacity *= e; st.scale *= 1.6 - 0.6 * e; break;
      case 'typewriter': st.chars = Math.floor(Math.max(0, u) * Array.from(block.content).length); break;
    }
  };
  if (block.animInSec > 0) apply(block.animIn, t / block.animInSec, 1);
  // 出る方は、向きの名前が「どこへ行くか」なので符号を逆にする
  if (block.animOutSec > 0) apply(block.animOut, left / block.animOutSec, -1);
  return st;
}

function _hexToRgba(hex, a) {
  const h = String(hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// テキストの見た目をDOM要素に当てる(プレビュー用。書き出しでも同じ値を使う)
function ctApplyTextStyle(el, block, frameH, anim) {
  const k = frameH / TEXT_REFERENCE_HEIGHT;
  const font = TEXT_FONTS[block.font] || TEXT_FONTS.gothic;
  el.style.left = (block.x * 100) + '%';
  el.style.top = (block.y * 100) + '%';
  el.style.fontFamily = font.css;
  el.style.fontSize = Math.max(4, block.fontSize * k) + 'px';
  el.style.fontWeight = block.weight;
  el.style.fontStyle = block.italic ? 'italic' : 'normal';
  el.style.color = block.color;
  el.style.textAlign = block.align;
  el.style.letterSpacing = (block.letterSpacing / 100) + 'em';
  el.style.lineHeight = block.lineHeight;
  el.style.webkitTextStroke = block.strokeWidth > 0 ? `${block.strokeWidth * k * 2}px ${block.strokeColor}` : '0';
  el.style.paintOrder = 'stroke fill'; // 縁取りを文字の外側にだけ付ける
  const sc = block.shadowColor;
  el.style.textShadow = {
    none: 'none',
    soft: `0 ${2 * k}px ${6 * k}px ${_hexToRgba(sc, 0.65)}`,
    hard: `${3 * k}px ${3 * k}px 0 ${_hexToRgba(sc, 0.9)}`,
    glow: `0 0 ${8 * k}px ${_hexToRgba(sc, 0.95)}, 0 0 ${18 * k}px ${_hexToRgba(sc, 0.7)}`,
  }[block.shadow] || 'none';
  const bgA = block.bgOpacity / 100;
  el.style.background = bgA > 0 ? _hexToRgba(block.bgColor, bgA) : 'transparent';
  el.style.padding = bgA > 0 ? `${block.bgPadding * k * 0.6}px ${block.bgPadding * k}px` : `${2 * k}px ${4 * k}px`;
  el.style.borderRadius = (block.bgRadius * k) + 'px';
  el.style.opacity = (block.opacity / 100) * anim.opacity;
  el.style.transform = `translate(calc(-50% + ${anim.dx * frameH}px), calc(-50% + ${anim.dy * frameH}px)) rotate(${block.rotation}deg) scale(${anim.scale})`;
  const text = anim.chars === Infinity ? block.content : Array.from(block.content).slice(0, anim.chars).join('');
  if (el.textContent !== text) el.textContent = text;
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
  ctNormalizeTextBlock(block);
  const sec = (label) => body.appendChild(_el('div', 'panelSectionLabel', label));
  const row = (label) => { const r = _el('div', 'fieldRow'); r.appendChild(_el('label', null, label)); body.appendChild(r); return r; };
  const redraw = () => { if (typeof updateTextOverlayLayerRect === 'function') updateTextOverlayLayerRect(); };

  // スライダー+数値表示。fmtは表示の書式
  const slider = (label, key, min, max, step, fmt) => {
    const r = row(label);
    const input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = block[key];
    const v = _el('span', 'fieldValue', fmt ? fmt(block[key]) : String(block[key]));
    bindEditUndo(input);
    input.addEventListener('input', () => {
      block[key] = parseFloat(input.value);
      v.innerText = fmt ? fmt(block[key]) : String(block[key]);
      redraw();
    });
    r.appendChild(input); r.appendChild(v);
    return r;
  };
  const color = (r, key) => {
    const c = document.createElement('input');
    c.type = 'color'; c.className = 'colorInput'; c.value = block[key];
    bindEditUndo(c);
    c.addEventListener('input', () => { block[key] = c.value; redraw(); });
    r.appendChild(c);
    return c;
  };
  // ひな形ボタンの行(押すと即反映・取り消し1回ぶん)
  const pills = (label, options, key, onPick) => {
    const r = row(label);
    const group = _el('div', 'settingsRadioGroup');
    for (const [text, val] of options) {
      const pill = _el('button', 'settingsRadioPill' + (block[key] === val ? ' active' : ''), text);
      pill.type = 'button';
      pill.addEventListener('click', () => {
        if (block[key] === val) return; // 同じ値の選び直しは履歴を汚さない
        pushUndo();
        block[key] = val;
        if (onPick) onPick(val);
        openEditPanel(block);
      });
      group.appendChild(pill);
    }
    r.appendChild(group);
    return r;
  };

  // ---- 内容 ----
  const contentRow = _el('div', 'fieldRow column');
  contentRow.appendChild(_el('label', null, '内容'));
  const contentInput = document.createElement('textarea');
  contentInput.className = 'panelInput';
  contentInput.value = block.content;
  contentInput.rows = 3;
  bindEditUndo(contentInput);
  contentInput.addEventListener('input', () => { block.content = contentInput.value; renderTextTrackBlocks(); redraw(); });
  contentRow.appendChild(contentInput);
  body.appendChild(contentRow);

  // ---- 文字 ----
  sec('文字');
  const fontRow = row('フォント');
  const fontSel = document.createElement('select');
  fontSel.className = 'panelInput';
  for (const [id, f] of Object.entries(TEXT_FONTS)) {
    const o = document.createElement('option');
    o.value = id; o.innerText = f.label; o.style.fontFamily = f.css;
    fontSel.appendChild(o);
  }
  fontSel.value = block.font;
  fontSel.addEventListener('change', () => { pushUndo(); block.font = fontSel.value; redraw(); });
  fontRow.appendChild(fontSel);
  pills('太さ', [['普通', 400], ['太字', 700], ['極太', 900]], 'weight');
  const styleRow = row('スタイル');
  const styleGroup = _el('div', 'settingsRadioGroup');
  const italicBtn = _el('button', 'settingsRadioPill' + (block.italic ? ' active' : ''), '斜体');
  italicBtn.type = 'button';
  italicBtn.addEventListener('click', () => { pushUndo(); block.italic = !block.italic; openEditPanel(block); });
  styleGroup.appendChild(italicBtn);
  styleRow.appendChild(styleGroup);
  slider('大きさ', 'fontSize', 12, 180, 1);
  pills('揃え', [['左', 'left'], ['中央', 'center'], ['右', 'right']], 'align');
  slider('文字の間隔', 'letterSpacing', -10, 60, 1, (v) => (v / 100).toFixed(2) + 'em');
  slider('行の間隔', 'lineHeight', 0.8, 2.4, 0.05, (v) => v.toFixed(2));

  // ---- 色・縁取り・影・背景 ----
  sec('色と飾り');
  const colorRow = row('文字の色');
  color(colorRow, 'color');
  slider('不透明度', 'opacity', 0, 100, 1, (v) => v + '%');
  const strokeRow = slider('縁取り', 'strokeWidth', 0, 12, 0.5, (v) => v ? v + 'px' : 'なし');
  color(strokeRow, 'strokeColor');
  pills('影', [['なし', 'none'], ['ふんわり', 'soft'], ['くっきり', 'hard'], ['光る', 'glow']], 'shadow');
  const shadowColorRow = row('影の色');
  color(shadowColorRow, 'shadowColor');
  const bgRow = slider('背景の帯', 'bgOpacity', 0, 100, 1, (v) => v ? v + '%' : 'なし');
  color(bgRow, 'bgColor');
  if (block.bgOpacity > 0) {
    slider('帯の余白', 'bgPadding', 0, 40, 1, (v) => v + 'px');
    slider('帯の角の丸み', 'bgRadius', 0, 40, 1, (v) => v + 'px');
  }
  // 背景の帯のスライダーを0から動かした時に、余白・丸みの欄を出す
  bgRow.querySelector('input[type=range]').addEventListener('change', () => openEditPanel(block));

  // ---- 位置 ----
  sec('位置と向き');
  const posPills = [['上', 0.14], ['中央', 0.5], ['下', 0.82], ['字幕', 0.9]];
  const posRow = row('縦の位置');
  const posGroup = _el('div', 'settingsRadioGroup');
  for (const [text, y] of posPills) {
    const pill = _el('button', 'settingsRadioPill' + (Math.abs(block.y - y) < 0.005 && Math.abs(block.x - 0.5) < 0.005 ? ' active' : ''), text);
    pill.type = 'button';
    pill.addEventListener('click', () => { pushUndo(); block.x = 0.5; block.y = y; openEditPanel(block); });
    posGroup.appendChild(pill);
  }
  posRow.appendChild(posGroup);
  slider('横(%)', 'x', 0, 1, 0.005, (v) => Math.round(v * 100) + '%');
  slider('縦(%)', 'y', 0, 1, 0.005, (v) => Math.round(v * 100) + '%');
  slider('回転', 'rotation', -45, 45, 1, (v) => v + '°');

  // ---- 表示時間とアニメーション ----
  sec('表示時間と動き');
  const durRow = row('表示時間');
  const durInput = document.createElement('input');
  durInput.type = 'number'; durInput.step = '0.1'; durInput.min = '0.1'; durInput.className = 'panelInput small';
  durInput.value = ((block.endTick - block.startTick) / scTps()).toFixed(1);
  bindEditUndo(durInput);
  durInput.addEventListener('change', () => {
    const v = parseFloat(durInput.value);
    if (!(v > 0)) return;
    const maxTick = scMaxTick();
    block.endTick = Math.max(block.startTick + 1, Math.round(block.startTick + v * scTps()));
    if (maxTick > 0) block.endTick = Math.min(block.endTick, maxTick);
    editorChanged();
  });
  durRow.appendChild(durInput);
  durRow.appendChild(_el('span', 'fieldUnit', '秒'));
  const inRow = _el('div', 'fieldRow column');
  inRow.appendChild(_el('label', null, '出てくる時'));
  inRow.appendChild(_animPills(block, 'animIn', TEXT_ANIMS_IN));
  body.appendChild(inRow);
  if (block.animIn !== 'none') slider('長さ(出る)', 'animInSec', 0.1, 2, 0.05, (v) => v.toFixed(2) + '秒');
  const outRow = _el('div', 'fieldRow column');
  outRow.appendChild(_el('label', null, '消える時'));
  outRow.appendChild(_animPills(block, 'animOut', TEXT_ANIMS_OUT));
  body.appendChild(outRow);
  if (block.animOut !== 'none') slider('長さ(消える)', 'animOutSec', 0.1, 2, 0.05, (v) => v.toFixed(2) + '秒');
  body.appendChild(_el('div', 'panelHint', '止めて選んでいる間は、位置を決めやすいよう動き無しで表示します。スペースで再生すると動きが見えます。位置はプレビュー上の文字をドラッグしても決められます(中央と下1/3に吸着、Altで解除)。'));

  // ---- 素材として保存・削除 ----
  const actions = _el('div', 'panelActions');
  const saveBtn = _el('button', 'btn btn-ghost btn-sm', '⭐ この見た目をカスタム素材に保存');
  saveBtn.addEventListener('click', () => { if (typeof saveTextAsCustomAsset === 'function') saveTextAsCustomAsset(block); });
  actions.appendChild(saveBtn);
  const deleteBtn = _el('button', 'btn btn-ghost btn-sm dangerBtn', '🗑 このテキストを削除');
  deleteBtn.addEventListener('click', () => { selectText(block.id); deleteSelection(); });
  actions.appendChild(deleteBtn);
  body.appendChild(actions);
}

function _animPills(block, key, options) {
  const group = _el('div', 'settingsRadioGroup');
  for (const [text, val] of options) {
    const pill = _el('button', 'settingsRadioPill small' + (block[key] === val ? ' active' : ''), text);
    pill.type = 'button';
    pill.addEventListener('click', () => {
      if (block[key] === val) return;
      pushUndo(); block[key] = val; openEditPanel(block);
    });
    group.appendChild(pill);
  }
  return group;
}
