// js/modules/ui.js
export function initUI() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const selectFileBtn = document.getElementById('selectFileBtn');

  // タブ切替
  const tabEditor = document.getElementById('tabEditor');
  const tabGallery = document.getElementById('tabGallery');
  const editorScreen = document.getElementById('editorScreen');
  const galleryScreen = document.getElementById('galleryScreen');

  tabEditor.addEventListener('click', () => {
    tabEditor.classList.add('active');
    tabGallery.classList.remove('active');
    editorScreen.classList.remove('hidden');
    galleryScreen.classList.add('hidden');
  });

  tabGallery.addEventListener('click', () => {
    tabGallery.classList.add('active');
    tabEditor.classList.remove('active');
    galleryScreen.classList.remove('hidden');
    editorScreen.classList.add('hidden');
  });

  // ドラッグ＆ドロップイベント
  selectFileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) loadReplayFile(e.target.files[0]);
  });

  dropZone.addEventListener('dragover', (e) => e.preventDefault());
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) loadReplayFile(e.dataTransfer.files[0]);
  });
}

function loadReplayFile(file) {
  document.getElementById('introScreen').classList.add('hidden');
  document.getElementById('processingOverlay').classList.remove('hidden');

  // ダミーの読み込み（実際にはバックエンドAPIと通信）
  setTimeout(() => {
    document.getElementById('processingOverlay').classList.add('hidden');
    document.getElementById('topNav').classList.remove('hidden');
    document.getElementById('editorScreen').classList.remove('hidden');
  }, 1200);
}
