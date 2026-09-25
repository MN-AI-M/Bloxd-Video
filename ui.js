// ui.js
// ============================================================
// 「UI(操作)」だけを担当するファイル。アップロード処理、Pyodide(ブラウザ内
// Python)の起動・呼び出し、再生・スクラブなど。
// 座標計算や描画そのものは freecam.js の方を見てください。
//
// 【作り直し・ステップ1(コア)】
// シーンエディタ・カメラ記録・タイムラインのブロック編集・書き出し・
// プロジェクト設定はまだ含まれない(後続ステップでこのファイルに
// 追加していく)。ここでは「アップロードして見るだけ」に必要な配線のみ。
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
// Pyodideの実行はWeb Worker(pyodide-worker.js)の中で行う。メインスレッド
// (画面描画やマウス操作を処理してるのと同じスレッド)で同期的に呼ぶと、
// 重い処理の間は操作が固まって見えるため。やり取りはpostMessage経由
// (リクエストごとにidを振って、対応するレスポンスを紐付ける)。
// ============================================================

let pyWorker = null;
let pyodideReadyPromise = null;
let pyodideReadyResolve = null;
const pendingWorkerRequests = new Map(); // id -> {resolve, reject, onPartial}
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
        // 最初にプレイヤーの情報が揃った時点で、すぐ見られる画面に切り替える。
        // 続きの解析はこの後もバックグラウンドで続く。
        editorShown = true;
        document.getElementById('uploadScreen').classList.add('hidden');
        document.getElementById('editor').classList.add('active');
        document.getElementById('gotoBtn').onclick = () => fcGoToPlayer();
        setupEntitySelector();
        setupTransportControls();
        setupFovControl();
        await initFreecamOnce();
        editorCoreInit();    // 取り消し/やり直し・キーボードショートカット・操作ヘルプ
        timelineInit();      // タイムラインのUI配線(タイムラインのDOMが揃ってから)
        assetLibraryInit();  // 左の素材一覧(カメラ・テキストなどの追加)
        setupProjectSettingsModal(); // ⚙プロジェクト設定の配線
      } else if (editorShown) {
        // 継ぎ足された分をそのまま反映する(自由カメラは毎フレーム自分で
        // 再描画してるので、ここで明示的な再描画は不要)。
        // タイムラインの幅だけは、ストリーミングで総tick数が伸びるたびに広げる。
        if (typeof timelineRefresh === 'function') timelineRefresh();
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
    // 表示するプレイヤーを切り替えても、再生位置(=カメラ・テキストの時刻)は保つ
    const keep = curTick;
    setRendererTimeline(allTimelines.entities[sel.value]);
    if (typeof seekTo === 'function') seekTo(keep); else curTick = keep;
    if (typeof editorChanged === 'function') editorChanged();
    sel.blur(); // フォーカスが残るとSpace等のショートカットが効かないため
  });
  setRendererTimeline(allTimelines.entities[sel.value]);
}


// ============================================================
// 再生
// ============================================================
// 自由カメラは毎フレーム自分で再描画してる(freecamLoop)ので、ここでは
// curTick/timelineの状態を更新するだけで良い。
// 再生位置の変更(シーク)は、timeline.js(ルーラーのクリック/ドラッグ)と
// editor-core.js(矢印キー・Home/End)が担当する。

function setupTransportControls() {
  document.getElementById('playBtn').addEventListener('click', togglePlayback);
}

function togglePlayback() {
  if (playing) stopPlayback(); else startPlayback();
}

function startPlayback() {
  if (playing || !timeline) return;
  // 最後まで行っていたら、先頭から再生し直す
  if (streamingDone && curTick >= timeline.frames.length - 1) curTick = 0;
  playing = true;
  document.getElementById('playBtn').innerText = '⏸ 停止';
  // カメラがあれば、書き出される映像(プレビュー)を主画面にして再生する。
  // 視点を動かすと、自動で編集視点に戻る。カメラ視点モード中はそのまま。
  if (typeof sceneCameras !== 'undefined' && sceneCameras.length &&
      typeof pilot !== 'undefined' && !pilot && typeof previewIsMain !== 'undefined') {
    previewIsMain = true;
  }
  lastFrameTime = performance.now();
  playTick();
}

function stopPlayback() {
  if (!playing) return;
  playing = false;
  document.getElementById('playBtn').innerText = '▶ 再生';
  if (animId) cancelAnimationFrame(animId);
  if (typeof updateTimelineToolbar === 'function') updateTimelineToolbar();
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
    // 端数を捨てずに持ち越す(捨てると、再生が実際の時間より少しずつ遅れていく)。
    // ただし大きく遅れた時(タブが裏にあった等)や、末尾で待っている間は持ち越さない
    lastFrameTime += ticksToAdvance * 1000 / tps;
    if (now - lastFrameTime > 250 || curTick >= maxAvailable) lastFrameTime = now;
    if (curTick >= maxAvailable) {
      if (streamingDone) {
        stopPlayback(); // 本当にここで終わり
        return;
      }
      // まだ裏で解析が続いてるので、今ある最後のフレームで一旦待つ
      // (再生自体は止めず、続きが届き次第すぐ進む)
    }
  }
  animId = requestAnimationFrame(playTick);
}

// freecamLoopから毎フレーム呼ばれる。タイムラインの再生ヘッドと時刻表示を
// 今のcurTickに揃える(ブロック自体の再描画は、追加・移動・削除の時だけでいい)。
function updateScrubUI() {
  if (!timeline || !timeline.frames.length) return;
  const maxAvailable = timeline.frames.length - 1;
  const tps = allTimelines.ticksPerSecond || 30;
  const cur = curTick / tps, total = maxAvailable / tps;
  const text = formatSeconds(cur, true) + ' / ' + formatSeconds(total, false);
  const el = document.getElementById('timecode');
  if (el.innerText !== text) el.innerText = text;
  if (typeof timelineUpdatePlayhead === 'function') timelineUpdatePlayhead();
  if (typeof syncCameraPanelToPlayhead === 'function') syncCameraPanelToPlayhead(false);
}

function formatSeconds(seconds, withFraction) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m + ':' + (withFraction ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0'));
}


// ============================================================
// 画角(FOV)スライダー(今見ている視点の画角。カメラ視点モード中は、
// Kで記録した時にそのカメラの画角になる)
// ============================================================

function setupFovControl() {
  const fovSlider = document.getElementById('fovSlider');
  const fovValue = document.getElementById('fovValue');
  fovSlider.oninput = () => {
    fcFovDeg = parseInt(fovSlider.value);
    fovValue.innerText = fcFovDeg + '°';
    if (typeof pilot !== 'undefined' && pilot) pilot.dirty = true; // 未記録の変更として扱う
  };
}


// ============================================================
// 画面表示のちょっとした更新(freecam.js から呼ばれる)
// ============================================================

function setStatusText(text) {
  document.getElementById('loadStatus').innerText = text;
}

function updateFrameInfo(f) {
  document.getElementById('frameInfo').innerText =
    `tick ${f.tick}/${timeline.frames.length-1} (${f.time}s)  ` +
    `pose=${f.pose}  held=${f.heldItemName || 'なし'}  jump=${f.jumping}  crouch=${f.crouching}`;
}
