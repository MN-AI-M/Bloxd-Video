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
let playing = false, lastFrameTime = 0, animId = null;
let textureUrls = null;           // ファイル名(拡張子なし) -> Blob URL
let textureZipReadyPromise = null;
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
// textures.zip の読み込み・展開
// 個々のpngをリポジトリに大量コミットする代わりに、1つのzipにまとめて
// 置いておき、ブラウザ内(JSZip)で展開してBlob URLにする。
// freecam.js がこれを使ってテクスチャアトラス(実際の見た目)を作る。
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

// ページを開いたらすぐ裏でzipの展開も始めておく(Pyodideと並行)
ensureTexturesLoading().catch(() => {});


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
  lastDecodeError = null;
  startFreecamStream();

  let editorShown = false;

  try {
    statusEl.innerText = '準備しています...';
    await Promise.all([ensurePyodideLoading(), ensureTexturesLoading()]);

    statusEl.innerText = 'リプレイを解析中...';
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    await streamPyWorker('process_replay_streaming', { bytes }, [bytes.buffer], async (partial) => {
      handleStreamingPartial(partial);

      if (!editorShown && allTimelines && Object.keys(allTimelines.entities).length > 0) {
        // 最初にプレイヤーの情報が揃った時点で、すぐ再生できる画面に切り替える。
        // 続きの解析はこの後もバックグラウンドで続く。
        editorShown = true;
        document.getElementById('uploadScreen').classList.add('hidden');
        document.getElementById('editor').classList.add('active');
        document.getElementById('gotoBtn').onclick = () => fcGoToPlayer();
        document.getElementById('globalSettingBtn').onclick = () => {
          const on = toggleGlobalSetting();
          document.getElementById('globalSettingBtn').classList.toggle('active', on);
          document.getElementById('globalSettingBtn').innerText = on ? '🎥 通常表示に戻る' : '🎛 詳細編集';
          document.getElementById('gsHint').classList.toggle('show', on);
          document.getElementById('freecamHint').style.display = on ? 'none' : '';
          document.getElementById('freecamCrosshair').style.display = on ? 'none' : '';
          document.getElementById('gotoBtn').style.display = on ? 'none' : '';
        };
        setupEntitySelector();
        setupTimelineControls();
        initTimelineUI();
        setupFovControl();
        await initFreecamOnce();
      } else if (editorShown) {
        // 継ぎ足された分をそのまま反映する(自由カメラは毎フレーム自分で
        // 再描画してるので、ここで明示的な再描画は不要)
        renderTimeline();
      }

      if (partial.done) {
        streamingDone = true;
      }
    });

    if (!editorShown) {
      // 最後まで処理してもエンティティが1体も見つからなかった場合
      if (lastDecodeError) {
        statusEl.innerText = '⚠️ リプレイの解析中に問題が起きました: ' + lastDecodeError +
          '\n(途中までは読めています。プレイヤーの情報がその範囲に無かった可能性があります)';
      } else {
        statusEl.innerText = 'プレイヤーの情報が見つかりませんでした。別のファイルでお試しください。';
      }
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

let lastDecodeError = null;

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

  // 撤回(既に出した面のうち、後から不要と分かった分)を、新しい面を
  // 追加する前に適用する(この順番でないと、置き換え後の正しい面まで
  // 一緒に消してしまう)
  retractFreecamFaces(partial.retracted_positions, partial.retracted_faces);
  appendFreecamStreamFaces(partial.new_faces, partial.palette);

  if (partial.decode_error) {
    lastDecodeError = partial.decode_error;
    console.error('リプレイのデコードが途中で止まりました:', partial.decode_error);
  }

  const pct = partial.total_ticks ? Math.round(100 * partial.processed_tick / partial.total_ticks) : 100;
  const faceCountText = `面数: ${(fcMeshFaces ? fcMeshFaces.length : 0).toLocaleString()}`;
  if (partial.truncated) {
    setStatusText(`⚠️ データ量が多すぎたため、途中で打ち切りました(${pct}%まで処理・${faceCountText}）`);
  } else if (partial.done && partial.decode_error) {
    setStatusText(`⚠️ デコードが途中で止まりました(${pct}%まで・${faceCountText})。詳細はコンソールを確認してください。`);
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
    curTick = 0;
    renderTimeline();
  });
  setRendererTimeline(allTimelines.entities[sel.value]);
}


// ============================================================
// タイムライン操作(再生・スクラブ)
// ============================================================
// 自由カメラは毎フレーム自分で再描画してる(freecamLoop)ので、ここでは
// curTick/timelineの状態を更新するだけで良い(明示的な再描画呼び出しは不要)。

// ============================================================
// 撮影(画角・全体プレビュー・書き出し)のUI配線
// ============================================================
// ブロックの記録・削除などは timeline.js の編集パネルが担当する。
// ここでは「タイムライン全体」に対する操作(プレビュー・書き出し)と
// 画角スライダーだけを扱う。

function setupFovControl() {
  const fovSlider = document.getElementById('fovSlider');
  const fovValue = document.getElementById('fovValue');
  fovSlider.oninput = () => {
    fcFovDeg = parseInt(fovSlider.value);
    fovValue.innerText = fcFovDeg + '°';
  };

  const previewBtn = document.getElementById('previewBtn');
  const exportBtn = document.getElementById('exportBtn');

  previewBtn.onclick = () => {
    if (!hasAnyRecordedCamera()) return;
    const turningOn = !fcPreviewMode;
    fcSetPreviewMode(turningOn);
    if (turningOn) {
      const range = overallCameraRange();
      if (range) { curTick = range.start; }
      if (!isPlayingTimeline()) startTimelinePlayback();
    }
    previewBtn.innerText = fcPreviewMode ? '👋 手動操作に戻る' : '🎬 プレビュー';
    previewBtn.classList.toggle('active', fcPreviewMode);
  };

  exportBtn.onclick = () => {
    const started = fcStartExport();
    if (started) {
      document.getElementById('exportStatus').innerText = '⏺ 書き出し中...(終わるまでこの画面を離れないでください)';
      previewBtn.disabled = true; exportBtn.disabled = true;
      previewBtn.innerText = '🎬 プレビュー'; previewBtn.classList.add('active');
    }
  };

  updateExportAvailability();
}

// カメラブロックの記録状況が変わるたび(timeline.jsから)呼ばれ、
// プレビュー/書き出しボタンの有効・無効を揃える。
function updateExportAvailability() {
  const hasPath = typeof hasAnyRecordedCamera === 'function' && hasAnyRecordedCamera();
  const previewBtn = document.getElementById('previewBtn');
  const exportBtn = document.getElementById('exportBtn');
  if (previewBtn) previewBtn.disabled = !hasPath;
  if (exportBtn) exportBtn.disabled = !hasPath;
}

// freecam.jsのMediaRecorder.onstopから呼ばれる(書き出し完了・ダウンロード開始後)
function onExportFinished() {
  document.getElementById('exportStatus').innerText = '✅ 書き出し完了(ダウンロードを確認してください)';
  setTimeout(() => { document.getElementById('exportStatus').innerText = ''; }, 5000);
  updateExportAvailability();
  document.getElementById('previewBtn').innerText = '🎬 プレビュー';
  document.getElementById('previewBtn').classList.remove('active');
}


function setupTimelineControls() {
  document.getElementById('playBtn').addEventListener('click', () => {
    if (playing) stopTimelinePlayback(); else startTimelinePlayback();
  });
}

// 他の機能(カメラ記録・書き出しなど)からも呼べるよう、再生の開始/停止を
// 独立した関数にしてある。
function isPlayingTimeline() { return playing; }

function startTimelinePlayback() {
  if (playing) return;
  playing = true;
  document.getElementById('playBtn').innerText = '⏸ 一時停止';
  lastFrameTime = performance.now();
  playTick();
}

function stopTimelinePlayback() {
  if (!playing) return;
  playing = false;
  document.getElementById('playBtn').innerText = '▶ 再生';
  if (animId) cancelAnimationFrame(animId);
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
    if (curTick >= maxAvailable) {
      if (streamingDone) {
        // 本当にここで終わり
        stopTimelinePlayback();
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
  document.getElementById('loadStatus').innerText = text;
}

function updateFrameInfo(f) {
  document.getElementById('frameInfo').innerText =
    `tick ${f.tick}/${timeline.frames.length-1} (${f.time}s)  ` +
    `pose=${f.pose}  held=${f.heldItemName || 'なし'}  jump=${f.jumping}  crouch=${f.crouching}`;
}
