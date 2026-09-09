// js/modules/gallery.js

export function initGallery() {
  const modal = document.getElementById('uploadModal');
  const openBtn = document.getElementById('openUploadModalBtn');
  const closeBtn = document.getElementById('closeUploadModalBtn');
  const submitBtn = document.getElementById('submitAnimBtn');
  const grid = document.getElementById('galleryGrid');

  const sampleAnimations = [
    { title: "滑らかな180度旋回カメラ", desc: "キルシーンなどで使える綺麗な旋回カメラワークです。", author: "BloxdPro" },
    { title: "シネマティック追従スロー", desc: "速度0.25xに最適な臨場感あふれるカメラ演出です。", author: "CamMaster" }
  ];

  function renderGallery() {
    grid.innerHTML = sampleAnimations.map(anim => `
      <div class="anim-card">
        <div>
          <div class="anim-title">${anim.title}</div>
          <div class="anim-desc">${anim.desc}</div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <small style="color: var(--text-sub)">作成者: ${anim.author}</small>
          <button class="btn btn-secondary btn-sm"><i data-lucide="download"></i> 適用</button>
        </div>
      </div>
    `).join('');
    lucide.createIcons();
  }

  // active クラスの付け外しでモーダルを開閉
  openBtn.addEventListener('click', () => modal.classList.add('active'));
  closeBtn.addEventListener('click', () => modal.classList.remove('active'));

  submitBtn.addEventListener('click', () => {
    const title = document.getElementById('animTitleInput').value;
    const desc = document.getElementById('animDescInput').value;
    if (title) {
      sampleAnimations.unshift({ title, desc, author: "あなた" });
      renderGallery();
      modal.classList.remove('active');
    }
  });

  renderGallery();
}
