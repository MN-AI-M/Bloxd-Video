// ui.js
// ============================================================
// 「UI(操作)」だけを担当するファイル。アップロード処理、Pyodide(ブラウザ内
// Python)の起動・呼び出し、ボタン・タイムラインバーの操作など。
// 座標計算や描画そのものは renderer.js の方を見てください。
//
// サーバーには一切通信しない。解析(デコード・map生成)は全部
// Pyodideでブラウザの中だけで行う。テクスチャもこのサイトに同梱した
// 静的ファイルからそのまま読み込む。
// ============================================================

let allTimelines = null;
let textureColors = new Map();
let playing = false, lastFrameTime = 0, animId = null;
let textureUrls = null;           // ファイル名(拡張子なし) -> Blob URL
let textureZipReadyPromise = null;
let textureColorsReadyPromise = null;
let streamingDone = false;        // ストリーミング処理が最後まで終わったか

const PYTHON_FILES = [
  'avro_reader.py',
  'bloxdreplay_decode_full.py',
  'build_2d_map.py',
  'build_all_timelines.py',
  'web_glue.py',
];
const CSV_FILES = ['block_id_to_root.csv', 'asset_master.csv'];


// ============================================================
// textures.zip の読み込み・展開・色抽出
// 個々のpngをリポジトリに大量コミットする代わりに、1つのzipにまとめて
// 置いておき、ブラウザ内(JSZip)で展開してBlob URLにする。
// renderer.js からも window.getTextureUrl(name) で同じものを参照できる。
//
// v2: 地形の読み込みをストリーミング化したのに合わせて、テクスチャの
//     色も「実際に使われてる分だけ後から解決する」のではなく、
//     zipの中身を最初に全部サンプリングしておく方式にした
//     (どの見た目が新しく出てきても、すぐ色を引けるようにするため)。
// ============================================================

function ensureTexturesLoading() {
  if (!textureZipReadyPromise) {
    textureZipReadyPromise = loadTextureZip();
  }
  return textureZipReadyPromise;
}

async function loadTextureZip() {
  const res = await fetch('./textures.zip');
  if (!res.ok) throw new Error(`textures.zip の取得に失敗しました (HTTP ${res.status})`);
  const blob = await res.blob();
  const zip = await JSZip.loadAsync(blob);

  const map = new Map();
  const entries = Object.values(zip.files).filter(f => !f.dir);
  for (const entry of entries) {
    const fileBlob = await entry.async('blob');
    const url = URL.createObjectURL(fileBlob);
    // zip内にフォルダがあっても、ファイル名(拡張子抜き)だけをキーにする
    const base = entry.name.split('/').pop().replace(/\.png$/i, '');
    map.set(base, url);
  }
  textureUrls = map;
}

// renderer.js(3D一人称視点など)から同じテクスチャを参照するための入口
window.getTextureUrl = (name) => textureUrls ? textureUrls.get(name) : undefined;

function ensureTextureColorsReady() {
  if (!textureColorsReadyPromise) {
    textureColorsReadyPromise = preloadAllTextureColors();
  }
  return textureColorsReadyPromise;
}

async function preloadAllTextureColors() {
  await ensureTexturesLoading();

  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 1; sampleCanvas.height = 1;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  const promises = [];
  for (const [texName, blobUrl] of textureUrls) {
    promises.push(new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          sampleCtx.drawImage(img, 0, 0, 1, 1);
          const [r, g, b] = sampleCtx.getImageData(0, 0, 1, 1).data;
          textureColors.set(texName, `rgb(${r},${g},${b})`);
        } catch (e) {
          textureColors.set(texName, '#888');
        }
        resolve();
      };
      img.onerror = () => { textureColors.set(texName, '#a33'); resolve(); };
      img.src = blobUrl;
    }));
  }
  await Promise.all(promises);
}

// パレット配列(Python由来)を、解決済みの色文字列の配列に変換する。
// zipに無かった/まだ解決できてないテクスチャはフォールバック色になる。
function resolvePaletteColors(palette) {
  return palette.map(p =>
    textureColors.get(p.texture) || ((p.asset_type === '3d_model') ? '#7a4a2a' : '#444')
  );
}

// ページを開いたらすぐ裏でzipの展開・色抽出も始めておく(Pyodideと並行)
ensureTextureColorsReady().catch(() => {});


// ============================================================
// Pyodide(ブラウザ内Python)の初期化
// ============================================================
// v2: Pyodideの実行をWeb Worker(pyodide-worker.js)に移した。今までは
//     メインスレッド(画面描画やマウス操作を処理してるのと同じスレッド)で
//     Pythonを同期的に呼んでたので、重い処理の間は操作が固まって見えていた。
//     Worker内で実行することで、Pythonが計算してる間も画面やマウス操作が
//     止まらなくなる。やり取りはpostMessage経由(リクエストごとにidを
//     振って、対応するレスポンスを紐付ける)。
// ============================================================

let pyWorker = null;
let pyodideReadyPromise = null;
let pyodideReadyResolve = null;
const pendingWorkerRequests = new Map(); // id -> {resolve, reject}
let nextWorkerRequestId = 1;

function ensurePyodideLoading() {
  if (!pyodideReadyPromise) {
    pyodideReadyPromise = new Promise((resolve) => { pyodideReadyResolve = resolve; });
    startPyWorker();
  }
  return pyodideReadyPromise;
}

function startPyWorker() {
  const statusEl = document.getElementById('uploadStatus');
  const btn = document.getElementById('processBtn');

  pyWorker = new Worker('pyodide-worker.js');

  pyWorker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'status') {
      statusEl.innerText = msg.text;
    } else if (msg.type === 'ready') {
      btn.disabled = false;
      btn.innerText = '読み込む';
      pyodideReadyResolve();
    } else if (msg.type === 'init_error') {
      statusEl.innerText = 'Python環境の準備に失敗しました: ' + msg.message + '\nページを再読み込みしてやり直してください。';
      btn.disabled = true;
      btn.innerText = '準備に失敗しました';
    } else if (msg.type === 'result') {
      const p = pendingWorkerRequests.get(msg.id);
      if (p) { pendingWorkerRequests.delete(msg.id); p.resolve(msg.result); }
    } else if (msg.type === 'partial') {
      const p = pendingWorkerRequests.get(msg.id);
      if (p) {
        if (p.onPartial) p.onPartial(msg.result);
        if (msg.result.done) { pendingWorkerRequests.delete(msg.id); p.resolve(msg.result); }
      }
    } else if (msg.type === 'error') {
      const p = pendingWorkerRequests.get(msg.id);
      if (p) { pendingWorkerRequests.delete(msg.id); p.reject(new Error(msg.message)); }
    }
  };

  pyWorker.onerror = (e) => {
    statusEl.innerText = 'Python環境の準備に失敗しました: ' + e.message + '\nページを再読み込みしてやり直してください。';
    btn.disabled = true;
    btn.innerText = '準備に失敗しました';
  };
}

// Workerにリクエストを送り、対応するレスポンスが来るまで待つ共通ヘルパー。
// transferList を渡すと、その中身(例: バイト列のArrayBuffer)はコピー無しで
// Workerに「移動」する(大きいファイルを送る時に効く)。
function callPyWorker(type, payload, transferList) {
  return new Promise((resolve, reject) => {
    const id = nextWorkerRequestId++;
    pendingWorkerRequests.set(id, { resolve, reject });
    pyWorker.postMessage({ id, type, payload }, transferList || []);
  });
}

// process_replay_streamingのような、1回のリクエストに対して複数回
// レスポンス('partial')が返ってくるタイプの呼び出し用。届くたびに
// onPartial(result)が呼ばれ、result.doneがtrueになった回でPromiseも解決する。
function streamPyWorker(type, payload, transferList, onPartial) {
  return new Promise((resolve, reject) => {
    const id = nextWorkerRequestId++;
    pendingWorkerRequests.set(id, { resolve, reject, onPartial });
    pyWorker.postMessage({ id, type, payload }, transferList || []);
  });
}

// ページを開いたらすぐ裏でPyodideの準備を始めておく(体感速度のため)
ensurePyodideLoading();


// ============================================================
// アップロード〜Pyodideでの解析
// ============================================================

document.getElementById('processBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('fileInput');
  const statusEl = document.getElementById('uploadStatus');
  if (!fileInput.files.length) { statusEl.innerText = 'ファイルを選んでください'; return; }

  const file = fileInput.files[0];
  document.getElementById('processBtn').disabled = true;

  allTimelines = null;
  streamingDone = false;
  startRendererStream();

  let editorShown = false;

  try {
    statusEl.innerText = '準備しています...';
    await Promise.all([ensurePyodideLoading(), ensureTextureColorsReady()]);

    statusEl.innerText = 'リプレイを解析中...';
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    await streamPyWorker('process_replay_streaming', { bytes }, [bytes.buffer], (partial) => {
      handleStreamingPartial(partial);

      if (!editorShown && allTimelines && Object.keys(allTimelines.entities).length > 0) {
        // 最初にプレイヤーの情報が揃った時点で、すぐ再生できる画面に切り替える。
        // 続きの解析はこの後もバックグラウンドで続く。
        editorShown = true;
        document.getElementById('uploadScreen').classList.add('hidden');
        document.getElementById('editor').classList.add('active');
        initCanvases();
        setupTopButtons();
        setupPanZoom();
        setupHover();
        setupTimelineControls();
        setupEntitySelector();
        fitToView();
        renderPlayerMarker();
      } else if (editorShown) {
        // 継ぎ足された分をそのまま反映する
        document.getElementById('scrub').max = timeline.frames.length - 1;
        drawIso();
        renderPlayerMarker();
      }

      if (partial.done) {
        streamingDone = true;
        if (editorShown) fitToView(); // 全部揃ったので、最後にもう一度全体表示に合わせる
      }
    });

    if (!editorShown) {
      // 最後まで処理してもエンティティが1体も見つからなかった場合
      statusEl.innerText = 'プレイヤーの情報が見つかりませんでした。別のファイルでお試しください。';
      document.getElementById('processBtn').disabled = false;
    }
  } catch (e) {
    statusEl.innerText = 'エラー: ' + e.message;
    document.getElementById('processBtn').disabled = false;
  }
});


// ============================================================
// ストリーミングで届いた1バッチぶんを反映する
// ============================================================

function handleStreamingPartial(partial) {
  if (!allTimelines) {
    allTimelines = {
      entities: {},
      ticksPerSecond: partial.ticks_per_second || 30,
      localPlayerEntityId: partial.local_player_entity_id,
    };
  }

  for (const [eid, frames] of Object.entries(partial.entity_frame_updates)) {
    if (!allTimelines.entities[eid]) {
      allTimelines.entities[eid] = { name: null, displayName: null, frames: [] };
    }
    allTimelines.entities[eid].frames.push(...frames);
  }
  for (const [eid, meta] of Object.entries(partial.entity_meta)) {
    if (allTimelines.entities[eid]) {
      allTimelines.entities[eid].name = meta.name;
      allTimelines.entities[eid].displayName = meta.displayName;
    }
  }

  const resolvedColors = resolvePaletteColors(partial.palette);
  appendRendererFaces(partial.new_faces, partial.palette, resolvedColors);

  const pct = partial.total_ticks ? Math.round(100 * partial.processed_tick / partial.total_ticks) : 100;
  const faceCountText = `面数: ${(meshFaces ? meshFaces.length : 0).toLocaleString()}`;
  if (partial.truncated) {
    setStatusText(`⚠️ データ量が多すぎたため、途中で打ち切りました(${pct}%まで処理・${faceCountText}）`);
  } else if (partial.done) {
    setStatusText(`${faceCountText} / 完了`);
  } else {
    setStatusText(`${faceCountText} / 解析中...(${pct}%、裏で続けています)`);
  }
}


// ============================================================
// エンティティ選択(自分・他のプレイヤー・モブ)
// ============================================================

function setupEntitySelector() {
  const sel = document.getElementById('entitySelect');
  sel.innerHTML = '';
  const entries = Object.entries(allTimelines.entities);
  entries.sort((a, b) => {
    if (a[0] === allTimelines.localPlayerEntityId) return -1;
    if (b[0] === allTimelines.localPlayerEntityId) return 1;
    return (a[1].name || '').localeCompare(b[1].name || '');
  });
  for (const [eid, info] of entries) {
    const opt = document.createElement('option');
    opt.value = eid;
    const label = info.displayName ? `${info.name} (${info.displayName})` : (info.name || eid);
    opt.innerText = (eid === allTimelines.localPlayerEntityId ? '★ ' : '') + label;
    sel.appendChild(opt);
  }
  sel.value = allTimelines.localPlayerEntityId;
  sel.addEventListener('change', () => {
    setRendererTimeline(allTimelines.entities[sel.value]);
    document.getElementById('scrub').max = timeline.frames.length - 1;
    document.getElementById('scrub').value = 0;
    drawIso();
    renderPlayerMarker();
  });
  setRendererTimeline(allTimelines.entities[sel.value]);
}


// ============================================================
// 画面上部のボタン(全体表示・プレイヤーへ移動・視点モード切替)
// ============================================================

function setupTopButtons() {
  document.getElementById('fitBtn').onclick = () => fitToView();
  document.getElementById('gotoBtn').onclick = () => goToPlayer();

  const freecamBtn = document.getElementById('freecamBtn');
  freecamBtn.onclick = async () => {
    if (isFreecamActive()) {
      exitFreecam();
      freecamBtn.innerText = '🎥 自由視点に切替';
    } else {
      freecamBtn.innerText = '🗺 アイソメ表示に戻る';
      await enterFreecam();
    }
  };
}


// ============================================================
// タイムライン操作(再生・スクラブ)
// ============================================================

function setupTimelineControls() {
  const scrub = document.getElementById('scrub');
  scrub.max = timeline.frames.length - 1;
  scrub.addEventListener('input', e => {
    curTick = parseInt(e.target.value);
    drawIso();          // このtickまでに置かれたブロックだけ表示されるよう再描画
    renderPlayerMarker();
  });

  document.getElementById('playBtn').addEventListener('click', () => {
    playing = !playing;
    document.getElementById('playBtn').innerText = playing ? '⏸ 一時停止' : '▶ 再生';
    if (playing) { lastFrameTime = performance.now(); playTick(); }
    else if (animId) cancelAnimationFrame(animId);
  });
}

function playTick() {
  if (!playing) return;
  const now = performance.now();
  const tps = allTimelines.ticksPerSecond;
  const elapsed = (now - lastFrameTime) / 1000;
  const ticksToAdvance = Math.floor(elapsed * tps);
  if (ticksToAdvance > 0) {
    const maxAvailable = timeline.frames.length - 1;
    const next = Math.min(curTick + ticksToAdvance, maxAvailable);
    curTick = next;
    lastFrameTime = now;
    document.getElementById('scrub').value = curTick;
    document.getElementById('scrub').max = maxAvailable;
    drawIso();          // このtickまでに置かれたブロックだけ表示されるよう再描画
    renderPlayerMarker();
    if (curTick >= maxAvailable) {
      if (streamingDone) {
        // 本当にここで終わり
        playing = false;
        document.getElementById('playBtn').innerText = '▶ 再生';
        return;
      }
      // まだ裏で解析が続いてるので、今ある最後のフレームで一旦待つ
      // (再生自体は止めず、続きが届き次第すぐ進む)
    }
  }
  animId = requestAnimationFrame(playTick);
}


// ============================================================
// 画面表示のちょっとした更新(renderer.js から呼ばれる)
// ============================================================

function setStatusText(text) {
  document.getElementById('info').innerText = text;
}

function updateFrameInfo(f) {
  document.getElementById('frameInfo').innerText =
    `tick ${f.tick}/${timeline.frames.length-1} (${f.time}s)  ` +
    `pose=${f.pose}  held=${f.heldItemName || 'なし'}  jump=${f.jumping}  crouch=${f.crouching}`;
}
