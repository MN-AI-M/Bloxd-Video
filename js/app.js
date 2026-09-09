// js/app.js
import { initUI } from './modules/ui.js';
import { initGallery } from './modules/gallery.js';

window.addEventListener('DOMContentLoaded', () => {
  // 1. 起動時はローディング画面以外を確実に非表示にする
  document.getElementById('topNav')?.classList.add('hidden');
  document.getElementById('introScreen')?.classList.add('hidden');
  document.getElementById('editorScreen')?.classList.add('hidden');
  document.getElementById('galleryScreen')?.classList.add('hidden');
  document.getElementById('processingOverlay')?.classList.add('hidden');
  document.getElementById('loadingScreen')?.classList.remove('hidden');

  // 2. 機能の初期化
  initUI();
  initGallery();

  // 3. 起動ローディングのプログレス制御
  const progress = document.getElementById('loadingProgress');
  let p = 0;
  const timer = setInterval(() => {
    p += 25;
    if (progress) progress.style.width = p + '%';

    if (p >= 100) {
      clearInterval(timer);
      setTimeout(() => {
        // ローディングが終わったら説明・ファイル選択画面（introScreen）を表示
        document.getElementById('loadingScreen').classList.add('hidden');
        document.getElementById('introScreen').classList.remove('hidden');
      }, 300);
    }
  }, 150);
});
