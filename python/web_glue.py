"""
web_glue.py
===========
Pyodide(ブラウザ内Python)から呼び出すための「つなぎ役」。
JS側は process_replay_bytes(バイト列) を1回呼ぶだけで、
{ map: {...}, timelines: {...} } のJSON文字列を受け取れる。

今まで作った build_2d_map.py / build_all_timelines.py の処理を、
ファイルへの書き込み無し(全部メモリ上)で呼べるようにまとめてある。
"""
import io
import json

from bloxdreplay_decode_full import make_decoder
from build_2d_map import build_map_from_decoded
from build_all_timelines import build_all_timelines_from_decoded

BLOCK_ID_TO_ROOT_PATH = "block_id_to_root.csv"
ASSET_MASTER_PATH = "asset_master.csv"


def process_replay_bytes(data: bytes) -> str:
    """.bloxdreplayの中身(バイト列)を受け取って、
    { map: {...}, timelines: {...} } のJSON文字列を返す。"""
    res = make_decoder_from_bytes(data)
    map_data = build_map_from_decoded(res, BLOCK_ID_TO_ROOT_PATH, ASSET_MASTER_PATH)
    timelines_data = build_all_timelines_from_decoded(res)
    return json.dumps({"map": map_data, "timelines": timelines_data}, ensure_ascii=False)


def make_decoder_from_bytes(data: bytes):
    """make_decoder() はファイルパスを受け取る作りなので、
    Pyodideの仮想ファイルシステム上に一時的に書き出してから呼ぶ。"""
    import os
    tmp_path = "/tmp/_input.bloxdreplay"
    os.makedirs("/tmp", exist_ok=True)
    with open(tmp_path, "wb") as f:
        f.write(bytes(data))
    return make_decoder(tmp_path)
