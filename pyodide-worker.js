// pyodide-worker.js
// ============================================================
// Pyodide(ブラウザ内Python)を、メインスレッドとは別のスレッド
// (Web Worker)で実行するためのファイル。
//
// 今までは全部メインスレッド(画面の描画やマウス操作を処理してるのと
// 同じスレッド)でPyodideを同期的に呼んでたので、重い処理の間は
// 画面が固まって見えていた。これをこのWorkerの中に移すことで、
// Pythonが計算してる間もメイン側の描画・操作は止まらなくなる。
//
// メインスレッド(ui.js/freecam.js)とはpostMessageでやり取りする。
// リクエストごとに一意のid(呼び出し側が振る)を付けて、対応する
// レスポンスを紐付ける。
// ============================================================

importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js');

const PYTHON_FILES = [
  'avro_reader.py',
  'bloxdreplay_decode_full.py',
  'build_2d_map.py',
  'build_all_timelines.py',
  'web_glue.py',
];
const CSV_FILES = ['block_id_to_root.csv', 'asset_master.csv'];

let pyodide = null;
const pyodideReadyPromise = initPyodide().catch((e) => {
  postMessage({ type: 'init_error', message: e.message });
  throw e; // pyodideReadyPromiseを待ってる個別リクエストのcatchにも伝える
});

async function initPyodide() {
  postMessage({ type: 'status', text: 'Python環境を準備中...(初回だけ少し時間がかかります)' });
  pyodide = await loadPyodide();

  postMessage({ type: 'status', text: 'numpyを読み込み中...(地形の計算を高速化するため)' });
  await pyodide.loadPackage('numpy');

  postMessage({ type: 'status', text: '解析用のPythonファイルを読み込み中...' });
  for (const f of PYTHON_FILES) {
    const res = await fetch('./python/' + f);
    if (!res.ok) throw new Error(`${f} の取得に失敗しました (HTTP ${res.status})`);
    pyodide.FS.writeFile(f, await res.text());
  }
  for (const f of CSV_FILES) {
    const res = await fetch('./' + f);
    if (!res.ok) throw new Error(`${f} の取得に失敗しました (HTTP ${res.status})`);
    pyodide.FS.writeFile(f, await res.text());
  }
  pyodide.runPython('import web_glue');

  postMessage({ type: 'status', text: '準備完了。ファイルを選んで「読み込む」を押してください。' });
  postMessage({ type: 'ready' });
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  try {
    await pyodideReadyPromise;

    if (type === 'process_replay_streaming') {
      await handleStreamingReplay(id, payload);
      return;
    }

    let resultJson;
    if (type === 'process_replay') {
      pyodide.globals.set('_input_bytes', payload.bytes);
      resultJson = pyodide.runPython(
        'import web_glue\n' +
        'web_glue.process_replay_bytes(bytes(_input_bytes))'
      );
    } else if (type === 'build_full_res_mesh') {
      resultJson = pyodide.runPython(
        'import web_glue\n' +
        'web_glue.build_full_res_mesh()'
      );
    } else {
      throw new Error('未知のリクエスト種別: ' + type);
    }

    postMessage({ id, type: 'result', result: JSON.parse(resultJson) });
  } catch (e) {
    postMessage({ id, type: 'error', message: e.message });
  }
};

// ============================================================
// ストリーミング処理(「できたところから見せる」方式)
// ============================================================
// 最初は小さいバッチ(体感すぐ再生できるように)、その後は大きいバッチ
// (往復の回数を減らすため)で少しずつ処理し、そのたびにpostMessageで
// 「今回新しく分かった分」だけをメインスレッドに送る。
// バッチとバッチの間に一瞬だけ制御を返す(setTimeout 0)ことで、
// 処理の合間に他のリクエスト(自由カメラ側の呼び出しなど)も
// 割り込んで処理できるようにしてある。
const STREAMING_FIRST_BATCH_TICKS = 100;   // 最初のバッチ(だいたい数秒ぶん)
const STREAMING_LATER_BATCH_TICKS = 1000;  // 2回目以降のバッチ

async function handleStreamingReplay(id, payload) {
  pyodide.globals.set('_input_bytes', payload.bytes);
  pyodide.runPython(
    'import web_glue\n' +
    'web_glue.start_streaming_replay(bytes(_input_bytes))'
  );

  let batchTicks = STREAMING_FIRST_BATCH_TICKS;
  while (true) {
    pyodide.globals.set('_batch_ticks', batchTicks);
    const resultJson = pyodide.runPython(
      'import web_glue\n' +
      'web_glue.process_next_streaming_batch(_batch_ticks)'
    );
    const result = JSON.parse(resultJson);
    postMessage({ id, type: 'partial', result });

    if (result.done) break;
    batchTicks = STREAMING_LATER_BATCH_TICKS;

    // 他のリクエストが割り込めるよう、一瞬だけ制御を返す
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
