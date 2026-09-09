// js/app.js
import { initUI } from './modules/ui.js';
import { initGallery } from './modules/gallery.js';
import { initParser } from './engine/parser.js';

window.addEventListener('DOMContentLoaded', async () => {
  // 最初はすべての画面を隠し、ローディング画面だけ出す
  document.getElementById('topNav')?.classList.add('hidden');
  document.getElementById('introScreen')?.classList.add('hidden');
  document.getElementById('editorScreen')?.classList.add('hidden');
  document.getElementById('galleryScreen')?.classList.add('hidden');
  document.getElementById('processingOverlay')?.classList.add('hidden');
  
  document.getElementById('loadingScreen')?.classList.remove('hidden');

  initUI();
  initGallery();

  const progress = document.getElementById('loadingProgress');
  const textNode = document.querySelector('#loadingScreen h2');

  try {
    // 完全に準備が完了するまでここでawaitし続ける
    await initParser((percent, message) => {
      if (progress) progress.style.width = percent + '%';
      if (textNode) textNode.innerText = message;
    });

    // 100%完了してから初めてファイル選択画面（introScreen）に移行する
    document.getElementById('loadingScreen').classList.add('hidden');
    document.getElementById('introScreen').classList.remove('hidden');
    document.getElementById('topNav')?.classList.remove('hidden');
    
    console.log("Pythonエンジンのロードが完全に完了しました。ファイル選択を受け付けます。");

  } catch (e) {
    console.error("初期化失敗:", e);
    if (textNode) textNode.innerText = "エンジンの起動に失敗しました。ページを再読み込みしてください。";
  }
});
