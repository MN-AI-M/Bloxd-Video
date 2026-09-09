// js/app.js
import { initUI } from './modules/ui.js';
import { initGallery } from './modules/gallery.js';

window.addEventListener('DOMContentLoaded', () => {
  // 1. UIの初期化
  initUI();

  // 2. 共有ギャラリー機能の初期化
  initGallery();

  // 3. 起動ローディングの進行アニメーション
  const progress = document.getElementById('loadingProgress');
  let p = 0;
  const timer = setInterval(() => {
    p += 20;
    progress.style.width = p + '%';
    if (p >= 100) {
      clearInterval(timer);
      setTimeout(() => {
        document.getElementById('loadingScreen').classList.add('hidden');
        document.getElementById('introScreen').classList.remove('hidden');
      }, 300);
    }
  }, 150);
});
