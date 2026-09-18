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
