// project-settings.js
// ============================================================
// プロジェクト設定(3Dではない、普通のフォーム画面)。
// シーンエディタとは完全に別物で、「このリプレイ編集ファイル全体に関わる
// 設定」をここにまとめる。
//
// 左にカテゴリのナビ(#settingsNav)、右に選択中カテゴリの中身
// (#settingsModalBody)を出す「設定ページ」の形にしてある。今後、機能が
// 増えるたびに SETTINGS_SECTIONS へ1項目足すだけで済むように
// (1画面にフィールドを積み増していく形だと、項目が増えるほど縦に伸び
//  続けて破綻するため)。
//
// 今のところ入ってるカテゴリ:
//   🧍プレイヤー: 3Dシーン内の人物モデルに貼るテクスチャ画像
//   💾書き出し: 書き出す動画の画質(ビットレート)・解像度
//     (実際の書き出し処理=MediaRecorderまわりは後続ステップで実装する。
//      ここではその時に使う設定値を持っておくだけ)
// ============================================================

const SETTINGS_SECTIONS = [
  { id: 'player', label: 'プレイヤー', icon: '🧍', render: renderPlayerSection },
  { id: 'export', label: '書き出し', icon: '💾', render: renderExportSection },
  // 今後ここに追加していく想定。例:
  // { id: 'community', label: 'コミュニティ連携', icon: '🌐', render: renderCommunitySection },
];

let activeSettingsSectionId = SETTINGS_SECTIONS[0].id;
let currentPlayerTextureUrl = null; // プレビュー表示用(再描画のたびに読み直さなくていいよう保持)

// 書き出し設定(ステップ8の書き出し処理が参照する)
const EXPORT_QUALITY_PRESETS = {
  standard: { label: '標準', bitsPerSecond: 4_000_000 },
  high:     { label: '高画質', bitsPerSecond: 8_000_000 },
  highest:  { label: '最高画質', bitsPerSecond: 16_000_000 },
};
// プレビューは常に「書き出す動画と同じ縦横比の枠」で表示する(freecam.jsの
// previewRectGL)ので、解像度はここで決めた固定サイズのどれかにする。
const EXPORT_RESOLUTION_PRESETS = {
  hd720:  { label: '1280×720', size: [1280, 720] },
  hd1080: { label: '1920×1080', size: [1920, 1080] },
};
let exportQualityId = 'high';
let exportResolutionId = 'hd1080';

// 書き出す動画の縦横比(プレビュー枠・カメラ視点の枠・視野枠が使う)
function getOutputAspect() {
  const p = EXPORT_RESOLUTION_PRESETS[exportResolutionId] || EXPORT_RESOLUTION_PRESETS.hd1080;
  return p.size[0] / p.size[1];
}


// ============================================================
// モーダルの開閉・ナビ配線
// ============================================================

function setupProjectSettingsModal() {
  const modal = document.getElementById('settingsModal');
  const openBtn = document.getElementById('projectSettingsBtn');
  const closeBtn = document.getElementById('settingsModalClose');

  openBtn.onclick = () => {
    modal.classList.add('open');
    renderSettingsNav();
    renderSettingsBody();
  };
  closeBtn.onclick = () => modal.classList.remove('open');
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) modal.classList.remove('open'); });
}

function renderSettingsNav() {
  const nav = document.getElementById('settingsNav');
  nav.innerHTML = '';
  for (const section of SETTINGS_SECTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settingsNavItem' + (section.id === activeSettingsSectionId ? ' active' : '');
    btn.innerText = section.icon + ' ' + section.label;
    btn.onclick = () => {
      if (activeSettingsSectionId === section.id) return;
      activeSettingsSectionId = section.id;
      renderSettingsNav();
      renderSettingsBody();
    };
    nav.appendChild(btn);
  }
}

function renderSettingsBody() {
  const body = document.getElementById('settingsModalBody');
  body.innerHTML = '';
  const section = SETTINGS_SECTIONS.find(s => s.id === activeSettingsSectionId);
  if (!section) return;
  const title = document.createElement('h3');
  title.className = 'settingsSectionTitle';
  title.innerText = section.icon + ' ' + section.label;
  body.appendChild(title);
  section.render(body);
}


// ============================================================
// 「プレイヤー」カテゴリ: プレイヤーのテクスチャ
// ============================================================

function renderPlayerSection(body) {
  const fieldRow = document.createElement('div');
  fieldRow.className = 'fieldRow';

  const label = document.createElement('label');
  label.innerText = 'プレイヤーのテクスチャ';
  fieldRow.appendChild(label);

  const hint = document.createElement('div');
  hint.className = 'panelHint';
  hint.innerText = 'アップロードした画像を、3Dシーン内の人物モデルに貼り付けます。';
  fieldRow.appendChild(hint);

  const previewRow = document.createElement('div');
  previewRow.id = 'playerTexturePreviewRow';

  const preview = document.createElement('div');
  preview.id = 'playerTexturePreview';
  if (currentPlayerTextureUrl) {
    const thumb = document.createElement('img');
    thumb.src = currentPlayerTextureUrl;
    preview.appendChild(thumb);
  } else {
    preview.innerText = '未設定';
  }

  const actions = document.createElement('div');
  actions.id = 'playerTexturePreviewActions';
  actions.style.display = 'flex';
  actions.style.gap = '8px';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';

  const chooseBtn = document.createElement('button');
  chooseBtn.className = 'btn btn-ghost btn-sm';
  chooseBtn.innerText = '画像を選ぶ';
  chooseBtn.onclick = () => fileInput.click();

  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn btn-ghost btn-sm';
  clearBtn.disabled = !currentPlayerTextureUrl;
  clearBtn.innerText = 'クリア';
  clearBtn.onclick = () => {
    if (typeof setPlayerTexture === 'function' && fcGl) setPlayerTexture(fcGl, null);
    currentPlayerTextureUrl = null;
    if (activeSettingsSectionId === 'player') renderSettingsBody();
  };

  fileInput.onchange = () => {
    const file = fileInput.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (typeof setPlayerTexture === 'function' && fcGl) setPlayerTexture(fcGl, img);
      currentPlayerTextureUrl = url;
      if (activeSettingsSectionId === 'player') renderSettingsBody();
    };
    img.onerror = () => alert('この画像を読み込めませんでした。別の画像でお試しください。');
    img.src = url;
  };

  actions.appendChild(fileInput);
  actions.appendChild(chooseBtn);
  actions.appendChild(clearBtn);

  previewRow.appendChild(preview);
  previewRow.appendChild(actions);
  fieldRow.appendChild(previewRow);
  body.appendChild(fieldRow);
}


// ============================================================
// 「書き出し」カテゴリ: 画質(ビットレート)・解像度
// どちらもピル形のボタンで選ぶ(値そのものはexportQualityId/
// exportResolutionIdに保持し、後続ステップの書き出し処理から参照する)。
// ============================================================

function renderExportSection(body) {
  body.appendChild(_buildPillField(
    '画質', 'panelHint', 'ビットレートに反映されます。高いほどきれいですが、ファイルサイズも大きくなります。',
    EXPORT_QUALITY_PRESETS, exportQualityId, (id) => { exportQualityId = id; }
  ));
  body.appendChild(_buildPillField(
    '解像度', 'panelHint', '書き出す動画の出力サイズです。',
    EXPORT_RESOLUTION_PRESETS, exportResolutionId, (id) => { exportResolutionId = id; }
  ));
}

function _buildPillField(labelText, hintClass, hintText, presets, currentId, onSelect) {
  const fieldRow = document.createElement('div');
  fieldRow.className = 'fieldRow';

  const label = document.createElement('label');
  label.innerText = labelText;
  fieldRow.appendChild(label);

  const hint = document.createElement('div');
  hint.className = hintClass;
  hint.innerText = hintText;
  fieldRow.appendChild(hint);

  const group = document.createElement('div');
  group.className = 'settingsRadioGroup';
  group.style.marginTop = '8px';

  for (const [id, preset] of Object.entries(presets)) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'settingsRadioPill' + (id === currentId ? ' active' : '');
    pill.innerText = preset.label;
    pill.onclick = () => {
      onSelect(id);
      renderSettingsBody(); // active表示を揃えるため、セクション全体を再描画する
    };
    group.appendChild(pill);
  }
  fieldRow.appendChild(group);
  return fieldRow;
}
