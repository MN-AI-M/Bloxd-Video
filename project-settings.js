// project-settings.js
// ============================================================
// プロジェクト設定(3Dではない、普通のフォーム画面)。
// シーンエディタ(オービット視点の3D画面)とは完全に別物で、
// 「このリプレイ編集ファイル全体に関わる設定」をここにまとめる。
//
// 左にカテゴリのナビ(#settingsNav)、右に選択中カテゴリの中身
// (#settingsModalBody)を出す「設定ページ」の形にしてある。
// 今後、機能が増えるたびに SETTINGS_SECTIONS へ1項目足すだけで済むように
// (以前のように#settingsModalBodyへ直接フィールドを積み増していく形だと、
//  項目が増えるほど1画面が縦に伸び続けて破綻するため)。
//
// 今のところ入ってるカテゴリ: プレイヤー(3Dシーン内の人物モデルに貼る
// テクスチャ画像)。将来的には、コミュニティサイトで公開されたテクスチャを
// ここからインポートできるようにする構想もある(今回はローカルの画像
// アップロードのみ)。
// ============================================================

const SETTINGS_SECTIONS = [
  { id: 'player', label: 'プレイヤー', icon: '🧍', render: renderPlayerSection },
  // 今後ここに追加していく想定。例:
  // { id: 'export',    label: '書き出し',       icon: '💾', render: renderExportSection },
  // { id: 'community', label: 'コミュニティ連携', icon: '🌐', render: renderCommunitySection },
];

let activeSettingsSectionId = SETTINGS_SECTIONS[0].id;
let currentPlayerTextureUrl = null; // プレビュー表示用(再描画のたびに読み直さなくていいよう保持)


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
    const icon = document.createElement('span');
    icon.className = 'navIcon';
    icon.innerText = section.icon;
    const label = document.createElement('span');
    label.innerText = section.label;
    btn.appendChild(icon);
    btn.appendChild(label);
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

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'playerTextureInput';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';

  const chooseBtn = document.createElement('button');
  chooseBtn.id = 'playerTextureChooseBtn';
  chooseBtn.className = 'btn btn-ghost btn-sm';
  chooseBtn.innerText = '画像を選ぶ';
  chooseBtn.onclick = () => fileInput.click();

  const clearBtn = document.createElement('button');
  clearBtn.id = 'playerTextureClearBtn';
  clearBtn.className = 'btn btn-ghost btn-sm';
  clearBtn.disabled = !currentPlayerTextureUrl;
  clearBtn.innerText = 'クリア';
  clearBtn.onclick = () => {
    if (typeof setPlayerTexture === 'function' && fcGl) {
      setPlayerTexture(fcGl, null);
    }
    currentPlayerTextureUrl = null;
    // 今表示中のカテゴリがまだ「プレイヤー」のままなら再描画して即反映する
    if (activeSettingsSectionId === 'player') renderSettingsBody();
  };

  fileInput.onchange = () => {
    const file = fileInput.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (typeof setPlayerTexture === 'function' && fcGl) {
        setPlayerTexture(fcGl, img);
      }
      currentPlayerTextureUrl = url;
      if (activeSettingsSectionId === 'player') renderSettingsBody();
    };
    img.onerror = () => {
      alert('この画像を読み込めませんでした。別の画像でお試しください。');
    };
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
