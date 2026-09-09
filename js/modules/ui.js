import { parseReplayFile } from '../engine/parser.js';
import { setRendererData, setRendererTimeline, initCanvases, drawIso, fitToView } from '../engine/renderer.js';

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
    if (e.target.files.length) processFile(e.target.files[0]); // loadReplayFile から processFileに変更
  });

  dropZone.addEventListener('dragover', (e) => e.preventDefault());
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) processFile(e.dataTransfer.files[0]); // loadReplayFile から processFileに変更
  });
}



async function processFile(file) {
  if (!file.name.endsWith('.bloxdreplay')) {
    alert("エラー: .bloxdreplay ファイルを選択してください。");
    return;
  }

  const overlay = document.getElementById('processingOverlay');
  const overlayText = overlay.querySelector('h2') || overlay.querySelector('.processing-text');
  overlay.classList.remove('hidden');

  try {
    // 1. Pythonで解析実行
    const parsedData = await parseReplayFile(file, (percent, msg) => {
      if (overlayText) overlayText.innerText = msg;
    });

    // 2. Pythonから返ってきたMapデータをRenderer用に変換
    const mappedTiles = parsedData.map.tiles.map(t => {
      const pal = parsedData.map.palette[t.assetIdx];
      // ブロック名から簡易的なベースカラーを自動生成
      const hash = pal.root_name ? pal.root_name.charCodeAt(0) * 20 : 100;
      const r = (hash * 13) % 200 + 50, g = (hash * 17) % 200 + 50, b = (hash * 23) % 200 + 50;
      
      return {
         x: t.x, y: t.y, z: t.z,
         uncertain: t.uncertain,
         root_name: pal.root_name,
         _color: `rgb(${r},${g},${b})`, 
         layers: t.layers.map(l => ({ _color: `rgb(${Math.max(0,r-30)},${Math.max(0,g-30)},${Math.max(0,b-30)})` }))
      };
    });

    // 3. タイムラインの主要プレイヤー軌跡を取得
    const mainPlayerId = parsedData.timeline.localPlayerEntityId;
    const timelineData = parsedData.timeline.entities[mainPlayerId];

    // 4. レンダラーへ渡して描画
    setRendererData(mappedTiles);
    setRendererTimeline(timelineData);
    initCanvases();
    drawIso();
    fitToView();

    // 画面遷移
    document.getElementById('introScreen').classList.add('hidden');
    document.getElementById('editorScreen').classList.remove('hidden');

  } catch (err) {
    console.error(err);
    alert("解析エラーが発生しました:\n" + err.message);
  } finally {
    overlay.classList.add('hidden');
  }
}
