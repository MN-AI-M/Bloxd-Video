// project-settings.js
// ============================================================
// プロジェクト設定(3Dではない、普通のフォーム画面)。
// シーンエディタ(オービット視点の3D画面)とは完全に別物で、
// 「このリプレイ編集ファイル全体に関わる設定」をここにまとめる。
// 今後、機能が増えるたびに項目が増えていく想定の置き場所。
//
// 今のところ入ってる項目: プレイヤーのテクスチャ(3Dシーン内の
// 人物モデルに貼る画像)。将来的には、コミュニティサイトで公開された
// テクスチャをここからインポートできるようにする構想もある
// (今回はローカルの画像アップロードのみ)。
// ============================================================

function setupProjectSettingsModal() {
  const modal = document.getElementById('settingsModal');
  const openBtn = document.getElementById('projectSettingsBtn');
  const closeBtn = document.getElementById('settingsModalClose');
  const fileInput = document.getElementById('playerTextureInput');
  const chooseBtn = document.getElementById('playerTextureChooseBtn');
  const clearBtn = document.getElementById('playerTextureClearBtn');
  const preview = document.getElementById('playerTexturePreview');

  openBtn.onclick = () => modal.classList.add('open');
  closeBtn.onclick = () => modal.classList.remove('open');
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) modal.classList.remove('open'); });

  chooseBtn.onclick = () => fileInput.click();

  fileInput.onchange = () => {
    const file = fileInput.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (typeof setPlayerTexture === 'function' && fcGl) {
        setPlayerTexture(fcGl, img);
      }
      preview.innerHTML = '';
      const thumb = document.createElement('img');
      thumb.src = url;
      preview.appendChild(thumb);
      clearBtn.disabled = false;
    };
    img.onerror = () => {
      alert('この画像を読み込めませんでした。別の画像でお試しください。');
    };
    img.src = url;
  };

  clearBtn.onclick = () => {
    if (typeof setPlayerTexture === 'function' && fcGl) {
      setPlayerTexture(fcGl, null);
    }
    preview.innerHTML = '未設定';
    clearBtn.disabled = true;
    fileInput.value = '';
  };
}
