// js/engine/parser.js

export let isEngineReady = false;

export async function initParser(onProgress) {
  try {
    onProgress(10, "Pythonエンジン(Pyodide)を起動中...");
    
    // index.html で読み込んだ loadPyodide を実行
    const pyodide = await window.loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/"
    });
    window.pyodide = pyodide;

    onProgress(30, "解析モジュールとマスターデータを取得中...");
    
    // ルートディレクトリにあるPython・CSVファイル群
    const files = [
      'avro_reader.py',
      'bloxdreplay_decode_full.py',
      'build_2d_map.py',
      'build_all_timelines.py',
      'block_id_to_root.csv',
      'asset_master.csv'
    ];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const res = await fetch(`./${file}`);
      if (!res.ok) throw new Error(`${file} が読み込めません`);
      
      const text = await res.text();
      // Pyodideの仮想ファイルシステムに書き込む
      pyodide.FS.writeFile(file, text);
      onProgress(30 + Math.floor(((i + 1) / files.length) * 60), `${file} を展開中...`);
    }

    onProgress(100, "準備完了");
    isEngineReady = true;
  } catch (e) {
    console.error("Pyodide Init Error:", e);
    alert("エンジンの起動に失敗しました。\n" + e.message);
  }
}

export async function parseReplayFile(file, onProgress) {
  if (!isEngineReady) throw new Error("エンジンが準備できていません");
  
  onProgress(10, "ファイルをメモリに展開中...");
  const buffer = await file.arrayBuffer();
  window.pyodide.FS.writeFile('temp.bloxdreplay', new Uint8Array(buffer));

  onProgress(40, "Pythonによるデコード・時系列構築を実行中...");
  
  // Python側に用意されている「from_decoded」関数を活用し、I/O無しで一気に処理
  const pyCode = `
import json
print("Python: デコード開始")
from bloxdreplay_decode_full import make_decoder
from build_2d_map import build_map_from_decoded
from build_all_timelines import build_all_timelines_from_decoded

res = make_decoder('temp.bloxdreplay')
print("Python: デコード完了、マップ構築中...")
map_data = build_map_from_decoded(res, 'block_id_to_root.csv', 'asset_master.csv')
print("Python: マップ構築完了、タイムライン構築中...")
timeline_data = build_all_timelines_from_decoded(res)
print("Python: すべての構築完了、JSON化します")

output = {
    'map': map_data,
    'timeline': timeline_data
}
json.dumps(output)
  `;

  onProgress(80, "JSONデータへ変換中...");
  const resultStr = await window.pyodide.runPythonAsync(pyCode);
  
  onProgress(100, "解析完了！");
  return JSON.parse(resultStr);
}
